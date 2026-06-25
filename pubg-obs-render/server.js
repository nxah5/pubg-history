import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const API_BASE = "https://api.pubg.com/shards";
const DEFAULT_PORT = 3000;
const MAX_SELECTED_PLAYERS = 12;
const SEARCH_MATCH_LIMIT = 10;

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || DEFAULT_PORT);
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const ENV_USE_MOCK = process.env.PUBG_USE_MOCK === "1";
const ENV_API_KEY = process.env.PUBG_API_KEY || "";
const cache = new Map();
let state = await loadState();
let settings = await loadSettings();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/overlay/")) {
      await serveFile(res, path.join(PUBLIC_DIR, "overlay.html"), "text/html; charset=utf-8");
      return;
    }

    const filePath = url.pathname === "/"
      ? path.join(PUBLIC_DIR, "index.html")
      : path.normalize(path.join(PUBLIC_DIR, url.pathname));

    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    await serveFile(res, filePath, mimeFor(filePath));
  } catch (error) {
    console.error(error);
    sendJson(res, error.status || 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  const mode = currentMode();
  console.log(`PUBG OBS Tracker running at http://${HOST}:${PORT} (${mode})`);
});

async function handleApi(req, res, url) {
  const method = req.method || "GET";

  if (method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      ...publicSettings(),
      selectedPlayers: state.selectedPlayers.length,
      sessionActive: Boolean(state.activeSession)
    });
    return;
  }

  if (method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, publicSettings());
    return;
  }

  if (method === "POST" && url.pathname === "/api/settings") {
    const body = await parseBody(req);
    updateSettings(body);
    cache.clear();
    await saveSettings();
    sendJson(res, 200, { settings: publicSettings(), state: publicState() });
    return;
  }

  if (method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, publicState());
    return;
  }

  if (method === "GET" && url.pathname === "/api/search") {
    const platform = cleanPlatform(url.searchParams.get("platform"));
    const name = cleanName(url.searchParams.get("name"));
    const result = await searchPlayerWithMatches(platform, name);
    sendJson(res, 200, result);
    return;
  }

  const matchDetail = url.pathname.match(/^\/api\/matches\/([^/]+)$/);
  if (method === "GET" && matchDetail) {
    const platform = cleanPlatform(url.searchParams.get("platform"));
    const focusPlayerId = url.searchParams.get("focusPlayerId") || "";
    const match = await getMatch(platform, decodeURIComponent(matchDetail[1]));
    const detail = await buildMatchDetail(platform, match, focusPlayerId, { includeRank: true });
    sendJson(res, 200, detail);
    return;
  }

  if (method === "POST" && url.pathname === "/api/players/select") {
    const body = await parseBody(req);
    const player = normalizeSelectedPlayer(body.player || body);
    upsertSelectedPlayer(player);
    await saveState();
    sendJson(res, 200, publicState());
    return;
  }

  const playerPatch = url.pathname.match(/^\/api\/players\/([^/]+)$/);
  if (method === "PATCH" && playerPatch) {
    const body = await parseBody(req);
    const accountId = decodeURIComponent(playerPatch[1]);
    const player = state.selectedPlayers.find((item) => item.accountId === accountId);
    if (!player) throw httpError(404, "선택된 플레이어를 찾을 수 없습니다.");
    player.displayName = String(body.displayName || player.name).trim().slice(0, 32) || player.name;
    await saveState();
    sendJson(res, 200, publicState());
    return;
  }

  if (method === "DELETE" && playerPatch) {
    const accountId = decodeURIComponent(playerPatch[1]);
    state.selectedPlayers = state.selectedPlayers.filter((item) => item.accountId !== accountId);
    if (state.activeSession?.statsByPlayer?.[accountId]) {
      delete state.activeSession.statsByPlayer[accountId];
    }
    if (state.activeSession?.teamScoreByPlayer?.[accountId]) {
      delete state.activeSession.teamScoreByPlayer[accountId];
    }
    await saveState();
    sendJson(res, 200, publicState());
    return;
  }

  if (method === "POST" && url.pathname === "/api/session/start") {
    const body = await parseBody(req);
    const session = await startSession({
      platform: cleanPlatform(body.platform),
      mode: cleanMode(body.mode),
      matchId: String(body.matchId || ""),
      anchorPlayerId: String(body.anchorPlayerId || "")
    });
    sendJson(res, 200, { session, state: publicState() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/session/refresh") {
    const result = await refreshSession();
    sendJson(res, 200, { ...result, state: publicState() });
    return;
  }

  if (method === "POST" && url.pathname === "/api/session/reset") {
    state.activeSession = null;
    await saveState();
    sendJson(res, 200, publicState());
    return;
  }

  const overlayMatch = url.pathname.match(/^\/api\/overlay\/(normal|ranked|custom)$/);
  if (method === "GET" && overlayMatch) {
    sendJson(res, 200, buildOverlayPayload(overlayMatch[1]));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function searchPlayerWithMatches(platform, name) {
  if (isMockMode()) return mockSearch(platform, name);

  const playerDoc = await cached(`player-name:${platform}:${name.toLowerCase()}`, 30_000, async () => {
    const url = new URL(`${API_BASE}/${platform}/players`);
    url.searchParams.set("filter[playerNames]", name);
    return pubgFetch(url);
  });

  const player = Array.isArray(playerDoc.data) ? playerDoc.data[0] : null;
  if (!player) throw httpError(404, "플레이어를 찾을 수 없습니다.");

  const matchIds = (player.relationships?.matches?.data || [])
    .slice(0, SEARCH_MATCH_LIMIT)
    .map((match) => match.id);

  const matches = await Promise.all(
    matchIds.map(async (matchId) => {
      const match = await getMatch(platform, matchId);
      return buildMatchDetail(platform, match, player.id, { includeRank: false });
    })
  );

  return {
    player: {
      accountId: player.id,
      name: player.attributes?.name || name,
      platform
    },
    matches
  };
}

async function getPlayerById(platform, accountId) {
  if (isMockMode()) return mockPlayerById(platform, accountId);
  return cached(`player-id:${platform}:${accountId}`, 30_000, async () => {
    const url = new URL(`${API_BASE}/${platform}/players/${accountId}`);
    return pubgFetch(url);
  });
}

async function getMatch(platform, matchId) {
  if (!matchId) throw httpError(400, "matchId가 필요합니다.");
  if (isMockMode()) return mockMatch(matchId);
  return cached(`match:${platform}:${matchId}`, 10 * 60_000, async () => {
    const url = new URL(`${API_BASE}/${platform}/matches/${matchId}`);
    return pubgFetch(url);
  });
}

async function buildMatchDetail(platform, matchDoc, focusPlayerId, options = {}) {
  const parsed = parseMatch(matchDoc);
  const roster = parsed.rosters.find((item) =>
    item.participants.some((participant) => participant.playerId === focusPlayerId)
  ) || parsed.rosters[0];

  const teamMembers = roster ? roster.participants : [];

  if (options.includeRank && teamMembers.length) {
    for (const member of teamMembers) {
      member.rank = await getRankForPlayer(platform, member.playerId, parsed.gameMode);
    }
  }

  const focus = teamMembers.find((member) => member.playerId === focusPlayerId) || teamMembers[0] || null;

  return {
    matchId: parsed.matchId,
    createdAt: parsed.createdAt,
    duration: parsed.duration,
    gameMode: parsed.gameMode,
    matchType: parsed.matchType,
    category: categorizeMatch(parsed),
    mapName: parsed.mapName,
    team: roster ? {
      teamId: roster.teamId,
      rank: roster.rank,
      members: teamMembers
    } : null,
    focusStats: focus,
    summary: {
      title: `${formatGameMode(parsed.gameMode)} · ${formatCategory(categorizeMatch(parsed))}`,
      createdAt: parsed.createdAt,
      teamRank: roster?.rank || null,
      teamId: roster?.teamId || null
    }
  };
}

async function startSession({ platform, mode, matchId, anchorPlayerId }) {
  if (!state.selectedPlayers.length) {
    throw httpError(400, "출력할 플레이어를 먼저 선택해주세요.");
  }

  const anchor = state.selectedPlayers.find((player) => player.accountId === anchorPlayerId)
    || state.selectedPlayers[0];
  const match = await getMatch(platform, matchId);
  const parsed = parseMatch(match);
  const matchMode = categorizeMatch(parsed);
  if (matchMode !== mode) {
    throw httpError(400, `${formatCategory(mode)} 기록은 ${formatCategory(matchMode)} 매치로 시작할 수 없습니다.`);
  }

  state.activeSession = {
    id: `session-${Date.now()}`,
    platform,
    mode,
    anchorPlayerId: anchor.accountId,
    anchorName: anchor.name,
    startMatchId: matchId,
    startCreatedAt: parsed.createdAt,
    matchIds: [],
    matches: [],
    statsByPlayer: {},
    teamScoreByPlayer: {},
    updatedAt: new Date().toISOString()
  };

  addMatchToSession(parsed);
  await saveState();
  return state.activeSession;
}

async function refreshSession() {
  if (!state.activeSession) throw httpError(400, "시작된 기록 세션이 없습니다.");

  const session = state.activeSession;
  const playerDoc = await getPlayerById(session.platform, session.anchorPlayerId);
  const matchIds = (playerDoc.data?.relationships?.matches?.data || [])
    .map((match) => match.id)
    .filter((matchId) => !session.matchIds.includes(matchId));

  const candidates = [];
  for (const matchId of matchIds) {
    const match = await getMatch(session.platform, matchId);
    const parsed = parseMatch(match);
    if (new Date(parsed.createdAt) >= new Date(session.startCreatedAt)
      && categorizeMatch(parsed) === session.mode) {
      candidates.push(parsed);
    }
  }

  candidates.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  let added = 0;
  for (const parsed of candidates) {
    if (addMatchToSession(parsed)) added += 1;
  }

  session.updatedAt = new Date().toISOString();
  await saveState();

  return {
    added,
    scanned: matchIds.length,
    matchCount: session.matchIds.length
  };
}

function addMatchToSession(parsed) {
  const session = state.activeSession;
  if (!session || session.matchIds.includes(parsed.matchId)) return false;

  const selectedIds = new Set(state.selectedPlayers.map((player) => player.accountId));
  const rosterByPlayerId = new Map();
  for (const roster of parsed.rosters) {
    for (const participant of roster.participants) {
      rosterByPlayerId.set(participant.playerId, roster);
    }
  }
  let hadSelectedPlayer = false;

  for (const participant of parsed.participants) {
    if (!selectedIds.has(participant.playerId)) continue;
    hadSelectedPlayer = true;
    const current = session.statsByPlayer[participant.playerId] || emptyPlayerStats();
    const gameStats = statFromParticipant(participant);
    current.games += 1;
    current.totalKd += gameStats.kd;
    current.totalDamage += gameStats.damage;
    current.totalDistance += gameStats.distance;
    current.totalKills += gameStats.kills;
    current.totalDeaths += gameStats.deaths;
    current.lastSurvivalTime = gameStats.survivalTime;
    current.lastMatchId = parsed.matchId;
    current.lastUpdatedAt = parsed.createdAt;
    session.statsByPlayer[participant.playerId] = current;

    if (session.mode === "custom") {
      const roster = rosterByPlayerId.get(participant.playerId);
      const teamScore = session.teamScoreByPlayer?.[participant.playerId] || emptyTeamScore();
      const teamKills = roster
        ? roster.participants.reduce((sum, member) => sum + Number(member.kills || 0), 0)
        : gameStats.kills;
      teamScore.matches += 1;
      teamScore.cumulativeKills += teamKills;
      teamScore.survivalPoints += survivalPointsForRank(roster?.rank || participant.winPlace);
      teamScore.killPoints += teamKills;
      teamScore.totalPoints = teamScore.survivalPoints + teamScore.killPoints;
      teamScore.lastRank = roster?.rank || participant.winPlace || null;
      teamScore.lastTeamKills = teamKills;
      session.teamScoreByPlayer = session.teamScoreByPlayer || {};
      session.teamScoreByPlayer[participant.playerId] = teamScore;
    }
  }

  if (!hadSelectedPlayer) return false;

  session.matchIds.push(parsed.matchId);
  session.matches.push({
    matchId: parsed.matchId,
    createdAt: parsed.createdAt,
    gameMode: parsed.gameMode,
    matchType: parsed.matchType,
    category: categorizeMatch(parsed),
    mapName: parsed.mapName
  });
  session.updatedAt = new Date().toISOString();
  return true;
}

function buildOverlayPayload(mode) {
  const session = state.activeSession;
  if (!session || session.mode !== mode) {
    return {
      mode,
      sessionMode: session?.mode || null,
      active: false,
      updatedAt: session?.updatedAt || null,
      matchCount: 0,
      players: []
    };
  }

  return {
    mode,
    sessionMode: session.mode,
    active: true,
    updatedAt: session.updatedAt || null,
    matchCount: session.matchIds?.length || 0,
    players: state.selectedPlayers.map((player) => {
      const raw = session.statsByPlayer?.[player.accountId] || emptyPlayerStats();
      const games = raw.games || 0;
      return {
        accountId: player.accountId,
        name: player.name,
        displayName: player.displayName || player.name,
        rank: player.rank || null,
        games,
        averages: {
          kd: games ? raw.totalKd / games : 0,
          damage: games ? raw.totalDamage / games : 0,
          distance: games ? raw.totalDistance / games : 0
        },
        lastSurvivalTime: raw.lastSurvivalTime || 0,
        lastMatchId: raw.lastMatchId || null,
        esports: session.teamScoreByPlayer?.[player.accountId] || emptyTeamScore()
      };
    })
  };
}

function parseMatch(matchDoc) {
  const attributes = matchDoc.data?.attributes || {};
  const participants = new Map();

  for (const item of matchDoc.included || []) {
    if (item.type !== "participant") continue;
    const stats = item.attributes?.stats || {};
    participants.set(item.id, normalizeParticipant(stats));
  }

  const rosters = [];
  for (const item of matchDoc.included || []) {
    if (item.type !== "roster") continue;
    const stats = item.attributes?.stats || {};
    const participantRefs = item.relationships?.participants?.data || [];
    rosters.push({
      id: item.id,
      rank: Number(stats.rank || 0),
      teamId: Number(stats.teamId || 0),
      participants: participantRefs
        .map((ref) => participants.get(ref.id))
        .filter(Boolean)
    });
  }

  return {
    matchId: matchDoc.data?.id,
    createdAt: attributes.createdAt,
    duration: Number(attributes.duration || 0),
    gameMode: attributes.gameMode || "",
    matchType: attributes.matchType || "",
    mapName: attributes.mapName || "",
    rosters,
    participants: Array.from(participants.values())
  };
}

function normalizeParticipant(stats) {
  const rideDistance = Number(stats.rideDistance || 0);
  const walkDistance = Number(stats.walkDistance || 0);
  const swimDistance = Number(stats.swimDistance || 0);
  const kills = Number(stats.kills || 0);
  const deathType = stats.deathType || "";
  const deaths = deathType && deathType !== "alive" ? 1 : 0;

  return {
    playerId: stats.playerId,
    name: stats.name || "Unknown",
    kills,
    deaths,
    damage: Number(stats.damageDealt || 0),
    distance: rideDistance + walkDistance + swimDistance,
    timeSurvived: Number(stats.timeSurvived || 0),
    winPlace: Number(stats.winPlace || 0),
    deathType,
    assists: Number(stats.assists || 0),
    dbnos: Number(stats.DBNOs || 0),
    rank: null
  };
}

function statFromParticipant(participant) {
  const deaths = participant.deaths || 0;
  return {
    kills: participant.kills || 0,
    deaths,
    kd: deaths > 0 ? (participant.kills || 0) / deaths : (participant.kills || 0),
    damage: participant.damage || 0,
    distance: participant.distance || 0,
    survivalTime: participant.timeSurvived || 0
  };
}

async function getRankForPlayer(platform, accountId, preferredGameMode) {
  if (isMockMode()) return mockRank(accountId);
  return cached(`rank:${platform}:${accountId}`, 15 * 60_000, async () => {
    try {
      const seasonId = await getCurrentSeasonId(platform);
      if (!seasonId) return null;
      const url = new URL(`${API_BASE}/${platform}/players/${accountId}/seasons/${seasonId}/ranked`);
      const doc = await pubgFetch(url);
      return pickRankedStats(doc.data?.attributes?.rankedGameModeStats || {}, preferredGameMode);
    } catch (error) {
      console.warn(`Rank lookup failed for ${accountId}: ${error.message}`);
      return null;
    }
  });
}

async function getCurrentSeasonId(platform) {
  return cached(`current-season:${platform}`, 60 * 60_000, async () => {
    const url = new URL(`${API_BASE}/${platform}/seasons`);
    const doc = await pubgFetch(url);
    const seasons = Array.isArray(doc.data) ? doc.data : [];
    const current = seasons.find((season) => season.attributes?.isCurrentSeason)
      || seasons.find((season) => !season.attributes?.isOffseason)
      || seasons[seasons.length - 1];
    return current?.id || null;
  });
}

function pickRankedStats(statsByMode, preferredGameMode) {
  const preferred = statsByMode[preferredGameMode];
  const fallback = Object.values(statsByMode).find((stats) =>
    Number(stats?.roundsPlayed || 0) > 0 || Number(stats?.currentRankPoint || 0) > 0
  ) || preferred || Object.values(statsByMode)[0];

  if (!fallback) return null;

  return {
    tier: [fallback.currentTier?.tier, fallback.currentTier?.subTier].filter(Boolean).join(" "),
    points: Number(fallback.currentRankPoint || 0),
    roundsPlayed: Number(fallback.roundsPlayed || 0)
  };
}

async function pubgFetch(url) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw httpError(400, "PUBG API 키가 없습니다. 관리자 화면에서 API 키를 저장하거나 .env 파일에 PUBG_API_KEY를 넣어주세요.");
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
      "Accept-Encoding": "gzip"
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data.errors?.[0]?.detail || data.errors?.[0]?.title || response.statusText;
    const error = httpError(response.status, message);
    error.rateLimit = {
      limit: response.headers.get("x-ratelimit-limit"),
      remaining: response.headers.get("x-ratelimit-remaining"),
      reset: response.headers.get("x-ratelimit-reset")
    };
    throw error;
  }
  return data;
}

function publicState() {
  return {
    selectedPlayers: state.selectedPlayers,
    activeSession: state.activeSession ? {
      ...state.activeSession,
      statsByPlayer: undefined
    } : null,
    overlayLinks: {
      normal: "/overlay/normal",
      ranked: "/overlay/ranked",
      custom: "/overlay/custom"
    },
    maxSelectedPlayers: MAX_SELECTED_PLAYERS,
    settings: publicSettings()
  };
}

function updateSettings(body) {
  if (Object.hasOwn(body, "apiKey")) {
    const apiKey = String(body.apiKey || "").trim();
    if (apiKey) {
      settings.apiKey = apiKey;
      settings.useMock = false;
    }
  }

  if (Object.hasOwn(body, "clearApiKey") && body.clearApiKey) {
    delete settings.apiKey;
  }

  if (Object.hasOwn(body, "useMock")) {
    settings.useMock = Boolean(body.useMock);
  }

  settings.updatedAt = new Date().toISOString();
}

function publicSettings() {
  return {
    mode: currentMode(),
    useMock: isMockMode(),
    hasApiKey: Boolean(getApiKey()),
    apiKeySource: settings.apiKey ? "browser" : ENV_API_KEY ? "env" : null
  };
}

function currentMode() {
  if (isMockMode()) return "mock";
  return getApiKey() ? "live" : "missing-key";
}

function isMockMode() {
  if (typeof settings.useMock === "boolean") return settings.useMock;
  if (settings.apiKey) return false;
  return ENV_USE_MOCK;
}

function getApiKey() {
  return settings.apiKey || ENV_API_KEY;
}

function upsertSelectedPlayer(player) {
  const existing = state.selectedPlayers.find((item) => item.accountId === player.accountId);
  if (existing) {
    Object.assign(existing, {
      name: player.name || existing.name,
      displayName: player.displayName || existing.displayName || existing.name,
      platform: player.platform || existing.platform,
      rank: player.rank || existing.rank || null
    });
    return;
  }

  if (state.selectedPlayers.length >= MAX_SELECTED_PLAYERS) {
    throw httpError(400, `출력 플레이어는 최대 ${MAX_SELECTED_PLAYERS}명까지 등록할 수 있습니다.`);
  }

  state.selectedPlayers.push({
    ...player,
    addedAt: new Date().toISOString()
  });
}

function normalizeSelectedPlayer(player) {
  const accountId = String(player.accountId || player.playerId || "").trim();
  const name = String(player.name || "").trim();
  if (!accountId || !name) throw httpError(400, "플레이어 accountId와 name이 필요합니다.");
  return {
    accountId,
    name,
    displayName: String(player.displayName || name).trim().slice(0, 32) || name,
    platform: cleanPlatform(player.platform || "steam"),
    rank: player.rank || null
  };
}

function emptyPlayerStats() {
  return {
    games: 0,
    totalKd: 0,
    totalDamage: 0,
    totalDistance: 0,
    totalKills: 0,
    totalDeaths: 0,
    lastSurvivalTime: 0,
    lastMatchId: null,
    lastUpdatedAt: null
  };
}

function emptyTeamScore() {
  return {
    matches: 0,
    cumulativeKills: 0,
    survivalPoints: 0,
    killPoints: 0,
    totalPoints: 0,
    lastRank: null,
    lastTeamKills: 0
  };
}

function survivalPointsForRank(rank) {
  const place = Number(rank || 0);
  if (place === 1) return 10;
  if (place === 2) return 6;
  if (place === 3) return 5;
  if (place === 4) return 4;
  if (place === 5) return 3;
  if (place === 6) return 2;
  if (place === 7 || place === 8) return 1;
  return 0;
}

function categorizeMatch(match) {
  const matchType = String(match.matchType || "").toLowerCase();
  const gameMode = String(match.gameMode || "").toLowerCase();
  if (matchType === "competitive" || gameMode.includes("ranked")) return "ranked";
  if (matchType === "custom") return "custom";
  return "normal";
}

function formatCategory(category) {
  return {
    normal: "일반전",
    ranked: "경쟁전",
    custom: "사용자지정"
  }[category] || category;
}

function formatGameMode(gameMode) {
  return String(gameMode || "").replace("-fpp", " FPP").toUpperCase() || "MATCH";
}

function cleanPlatform(value) {
  const platform = String(value || "steam").trim().toLowerCase();
  const allowed = new Set(["steam", "kakao", "psn", "xbox", "console", "tournament"]);
  if (!allowed.has(platform)) throw httpError(400, "지원하지 않는 서버/shard입니다.");
  return platform;
}

function cleanMode(value) {
  const mode = String(value || "normal").trim().toLowerCase();
  if (!["normal", "ranked", "custom"].includes(mode)) throw httpError(400, "지원하지 않는 출력 모드입니다.");
  return mode;
}

function cleanName(value) {
  const name = String(value || "").trim();
  if (!name) throw httpError(400, "닉네임을 입력해주세요.");
  return name;
}

async function cached(key, ttlMs, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.createdAt < ttlMs) return hit.value;
  const value = await loader();
  cache.set(key, { value, createdAt: Date.now() });
  return value;
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const value = raw.replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) {
    return { selectedPlayers: [], activeSession: null };
  }
  const content = await readFile(STATE_FILE, "utf8");
  return {
    selectedPlayers: [],
    activeSession: null,
    ...JSON.parse(content)
  };
}

async function saveState() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadSettings() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(SETTINGS_FILE)) {
    return {};
  }
  const content = await readFile(SETTINGS_FILE, "utf8");
  return JSON.parse(content);
}

async function saveSettings() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

async function serveFile(res, filePath, contentType) {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "File not found" });
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  }[ext] || "application/octet-stream";
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function mockSearch(platform, name) {
  const player = mockPlayers.find((item) => item.name.toLowerCase() === name.toLowerCase()) || mockPlayers[0];
  return {
    player: { accountId: player.accountId, name: player.name, platform },
    matches: mockMatches.map((match) => buildMockMatchDetail(match, player.accountId))
  };
}

function mockPlayerById(platform, accountId) {
  return {
    data: {
      id: accountId,
      type: "player",
      attributes: { name: mockPlayers.find((player) => player.accountId === accountId)?.name || "MockPlayer" },
      relationships: {
        matches: {
          data: mockMatches.map((match) => ({ type: "match", id: match.matchId }))
        }
      }
    }
  };
}

function mockMatch(matchId) {
  const mock = mockMatches.find((match) => match.matchId === matchId) || mockMatches[0];
  const participants = mock.members.map((member, index) => ({
    type: "participant",
    id: `participant-${mock.matchId}-${index}`,
    attributes: {
      stats: {
        playerId: member.accountId,
        name: member.name,
        kills: member.kills,
        damageDealt: member.damage,
        rideDistance: member.distance * 0.6,
        walkDistance: member.distance * 0.38,
        swimDistance: member.distance * 0.02,
        timeSurvived: member.survival,
        deathType: member.deathType,
        winPlace: mock.rank,
        assists: member.assists || 0,
        DBNOs: member.dbnos || 0
      }
    }
  }));

  return {
    data: {
      id: mock.matchId,
      type: "match",
      attributes: {
        createdAt: mock.createdAt,
        duration: mock.duration,
        gameMode: mock.gameMode,
        matchType: mock.matchType,
        mapName: mock.mapName
      }
    },
    included: [
      ...participants,
      {
        type: "roster",
        id: `roster-${mock.matchId}`,
        attributes: { stats: { rank: mock.rank, teamId: mock.teamId } },
        relationships: {
          participants: {
            data: participants.map((participant) => ({ type: "participant", id: participant.id }))
          }
        }
      }
    ]
  };
}

function buildMockMatchDetail(match, focusPlayerId) {
  const members = match.members.map((member) => ({
    playerId: member.accountId,
    accountId: member.accountId,
    name: member.name,
    kills: member.kills,
    deaths: member.deathType === "alive" ? 0 : 1,
    damage: member.damage,
    distance: member.distance,
    timeSurvived: member.survival,
    winPlace: match.rank,
    deathType: member.deathType,
    rank: mockRank(member.accountId)
  }));

  return {
    matchId: match.matchId,
    createdAt: match.createdAt,
    duration: match.duration,
    gameMode: match.gameMode,
    matchType: match.matchType,
    category: categorizeMatch(match),
    mapName: match.mapName,
    team: {
      teamId: match.teamId,
      rank: match.rank,
      members
    },
    focusStats: members.find((member) => member.accountId === focusPlayerId) || members[0],
    summary: {
      title: `${formatGameMode(match.gameMode)} · ${formatCategory(categorizeMatch(match))}`,
      createdAt: match.createdAt,
      teamRank: match.rank,
      teamId: match.teamId
    }
  };
}

function mockRank(accountId) {
  const index = mockPlayers.findIndex((player) => player.accountId === accountId);
  const tiers = ["Gold II", "Platinum V", "Diamond IV", "Gold I"];
  return {
    tier: tiers[Math.max(index, 0) % tiers.length],
    points: 2450 + Math.max(index, 0) * 180,
    roundsPlayed: 132
  };
}

const mockPlayers = [
  { accountId: "account.mock-001", name: "SampleOne" },
  { accountId: "account.mock-002", name: "BlueEntry" },
  { accountId: "account.mock-003", name: "SmokePlan" },
  { accountId: "account.mock-004", name: "LastCircle" }
];

const now = Date.now();
const mockMatches = [
  {
    matchId: "mock-match-004",
    createdAt: new Date(now - 8 * 60_000).toISOString(),
    duration: 1840,
    gameMode: "squad-fpp",
    matchType: "custom",
    mapName: "Desert_Main",
    teamId: 17,
    rank: 1,
    members: [
      { ...mockPlayers[0], kills: 5, damage: 710, distance: 5350, survival: 1840, deathType: "alive", assists: 1, dbnos: 3 },
      { ...mockPlayers[1], kills: 4, damage: 505, distance: 5220, survival: 1840, deathType: "alive", assists: 2, dbnos: 2 },
      { ...mockPlayers[2], kills: 2, damage: 260, distance: 5170, survival: 1840, deathType: "alive", assists: 2, dbnos: 1 },
      { ...mockPlayers[3], kills: 3, damage: 430, distance: 5480, survival: 1840, deathType: "alive", assists: 1, dbnos: 2 }
    ]
  },
  {
    matchId: "mock-match-003",
    createdAt: new Date(now - 20 * 60_000).toISOString(),
    duration: 1880,
    gameMode: "squad-fpp",
    matchType: "official",
    mapName: "Erangel_Main",
    teamId: 17,
    rank: 2,
    members: [
      { ...mockPlayers[0], kills: 4, damage: 612, distance: 5100, survival: 1812, deathType: "byplayer", assists: 1, dbnos: 2 },
      { ...mockPlayers[1], kills: 2, damage: 348, distance: 4920, survival: 1812, deathType: "byplayer", assists: 2, dbnos: 1 },
      { ...mockPlayers[2], kills: 1, damage: 187, distance: 4750, survival: 1764, deathType: "byplayer", assists: 1, dbnos: 0 },
      { ...mockPlayers[3], kills: 6, damage: 820, distance: 5230, survival: 1880, deathType: "alive", assists: 0, dbnos: 4 }
    ]
  },
  {
    matchId: "mock-match-002",
    createdAt: new Date(now - 95 * 60_000).toISOString(),
    duration: 1720,
    gameMode: "squad-fpp",
    matchType: "official",
    mapName: "Baltic_Main",
    teamId: 17,
    rank: 5,
    members: [
      { ...mockPlayers[0], kills: 1, damage: 244, distance: 4020, survival: 1502, deathType: "byplayer" },
      { ...mockPlayers[1], kills: 3, damage: 455, distance: 4180, survival: 1502, deathType: "byplayer" },
      { ...mockPlayers[2], kills: 0, damage: 92, distance: 3990, survival: 1330, deathType: "byplayer" },
      { ...mockPlayers[3], kills: 2, damage: 310, distance: 4410, survival: 1502, deathType: "byplayer" }
    ]
  },
  {
    matchId: "mock-match-001",
    createdAt: new Date(now - 170 * 60_000).toISOString(),
    duration: 1620,
    gameMode: "squad-fpp",
    matchType: "competitive",
    mapName: "Tiger_Main",
    teamId: 17,
    rank: 8,
    members: [
      { ...mockPlayers[0], kills: 2, damage: 331, distance: 3780, survival: 1201, deathType: "byplayer" },
      { ...mockPlayers[1], kills: 1, damage: 225, distance: 3810, survival: 1210, deathType: "byplayer" },
      { ...mockPlayers[2], kills: 3, damage: 492, distance: 3700, survival: 1210, deathType: "byplayer" },
      { ...mockPlayers[3], kills: 0, damage: 118, distance: 3600, survival: 1188, deathType: "byplayer" }
    ]
  }
];
