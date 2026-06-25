const $ = (selector) => document.querySelector(selector);

const dom = {
  healthBadge: $("#healthBadge"),
  overlayLinks: $("#overlayLinks"),
  apiForm: $("#apiForm"),
  apiKey: $("#apiKey"),
  useMock: $("#useMock"),
  apiStatus: $("#apiStatus"),
  searchForm: $("#searchForm"),
  platform: $("#platform"),
  playerName: $("#playerName"),
  statusBox: $("#statusBox"),
  selectedPlayers: $("#selectedPlayers"),
  selectedCount: $("#selectedCount"),
  sessionSummary: $("#sessionSummary"),
  matchesList: $("#matchesList"),
  searchMeta: $("#searchMeta"),
  matchMeta: $("#matchMeta"),
  matchDetail: $("#matchDetail"),
  modeTabs: $("#modeTabs"),
  startSession: $("#startSession"),
  refreshSession: $("#refreshSession"),
  resetSession: $("#resetSession")
};

let appState = null;
let lastSearch = null;
let currentMatch = null;
let selectedMode = "normal";

dom.apiForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveApiSettings();
});

dom.searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await searchPlayer();
});

dom.modeTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  selectedMode = button.dataset.mode;
  renderModeTabs();
});

dom.startSession.addEventListener("click", async () => {
  if (!currentMatch) {
    setStatus("기록을 시작할 매치를 먼저 선택해주세요.", "error");
    return;
  }
  try {
    setBusy(dom.startSession, true);
    const payload = {
      platform: dom.platform.value,
      mode: selectedMode,
      matchId: currentMatch.matchId,
      anchorPlayerId: lastSearch?.player?.accountId || ""
    };
    const result = await api("/api/session/start", { method: "POST", body: payload });
    renderState(result.state);
    setStatus("기록을 시작했습니다.", "good");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(dom.startSession, false);
  }
});

dom.refreshSession.addEventListener("click", async () => {
  try {
    setBusy(dom.refreshSession, true);
    const result = await api("/api/session/refresh", { method: "POST" });
    renderState(result.state);
    setStatus(`새 매치 ${result.added}개를 반영했습니다.`, "good");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(dom.refreshSession, false);
  }
});

dom.resetSession.addEventListener("click", async () => {
  try {
    const state = await api("/api/session/reset", { method: "POST" });
    renderState(state);
    setStatus("기록 세션을 초기화했습니다.", "good");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

boot();

async function boot() {
  try {
    const [health, state] = await Promise.all([
      api("/api/health"),
      api("/api/state")
    ]);
    renderState(state);
    renderSettings(state.settings || health);
    renderOverlayLinks(state.overlayLinks);
    renderModeTabs();
  } catch (error) {
    dom.healthBadge.textContent = "서버 오류";
    setStatus(error.message, "error");
  }
}

async function saveApiSettings() {
  const apiKey = dom.apiKey.value.trim();
  try {
    setBusy(dom.apiForm.querySelector("button[type='submit']"), true);
    const body = { useMock: dom.useMock.checked };
    if (apiKey) body.apiKey = apiKey;
    const result = await api("/api/settings", { method: "POST", body });
    dom.apiKey.value = "";
    renderState(result.state);
    renderSettings(result.settings);
    setApiStatus(result.settings);
    setStatus(result.settings.mode === "live" ? "실 API 모드로 저장했습니다." : "샘플 데이터 모드로 저장했습니다.", "good");
  } catch (error) {
    setApiStatus(null, error.message, "error");
  } finally {
    setBusy(dom.apiForm.querySelector("button[type='submit']"), false);
  }
}

async function searchPlayer() {
  const platform = dom.platform.value;
  const name = dom.playerName.value.trim();
  if (!name) {
    setStatus("닉네임을 입력해주세요.", "error");
    return;
  }

  try {
    setStatus("최근 매치를 불러오는 중입니다.");
    const result = await api(`/api/search?platform=${encodeURIComponent(platform)}&name=${encodeURIComponent(name)}`);
    lastSearch = result;
    currentMatch = null;
    dom.searchMeta.textContent = `${result.player.name} · ${result.matches.length}개`;
    renderMatches(result.matches);
    setStatus("검색 완료", "good");
    if (result.matches[0]) await loadMatch(result.matches[0].matchId);
  } catch (error) {
    setStatus(error.message, "error");
    dom.matchesList.innerHTML = "";
    dom.searchMeta.textContent = "검색 실패";
  }
}

async function loadMatch(matchId) {
  if (!lastSearch) return;
  try {
    setStatus("매치 상세를 불러오는 중입니다.");
    const url = `/api/matches/${encodeURIComponent(matchId)}?platform=${encodeURIComponent(dom.platform.value)}&focusPlayerId=${encodeURIComponent(lastSearch.player.accountId)}`;
    currentMatch = await api(url);
    renderMatches(lastSearch.matches);
    renderMatchDetail(currentMatch);
    setStatus("매치 상세 로드 완료", "good");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function renderState(state) {
  appState = state;
  renderSelectedPlayers();
  renderSessionSummary();
  if (state?.settings) renderSettings(state.settings);
}

function renderSettings(settings) {
  if (!settings) return;
  dom.useMock.checked = Boolean(settings.useMock);
  dom.apiKey.placeholder = settings.hasApiKey ? "저장된 API 키 사용 중" : "PUBG API 키";
  dom.healthBadge.textContent = settings.mode === "mock"
    ? "서버 mock"
    : settings.mode === "live"
      ? "서버 live"
      : "API 키 미설정";
  dom.playerName.placeholder = settings.mode === "mock" ? "SampleOne" : "플레이어 닉네임";
  setApiStatus(settings);
}

function setApiStatus(settings, message = "", tone = "") {
  dom.apiStatus.className = `notice ${tone}`.trim();
  if (message) {
    dom.apiStatus.textContent = message;
    return;
  }
  if (!settings) {
    dom.apiStatus.textContent = "";
    return;
  }
  if (settings.mode === "mock") {
    dom.apiStatus.textContent = "현재 샘플 데이터 모드입니다.";
    return;
  }
  if (settings.hasApiKey) {
    const source = settings.apiKeySource === "browser" ? "화면 저장" : ".env";
    dom.apiStatus.textContent = `실 API 사용 중 · 키 출처 ${source}`;
    return;
  }
  dom.apiStatus.textContent = "API 키를 저장하면 실데이터 검색이 됩니다.";
}

function renderSelectedPlayers() {
  const players = appState?.selectedPlayers || [];
  dom.selectedCount.textContent = `${players.length} / ${appState?.maxSelectedPlayers || 12}`;
  if (!players.length) {
    dom.selectedPlayers.innerHTML = `<div class="empty-state">선택된 플레이어가 없습니다.</div>`;
    return;
  }

  dom.selectedPlayers.innerHTML = players.map((player) => `
    <div class="selected-player" data-account-id="${escapeAttr(player.accountId)}">
      <div>
        <strong title="${escapeAttr(player.name)}">${escapeHtml(player.displayName || player.name)}</strong>
        <div class="meta">${escapeHtml(player.name)} · ${escapeHtml(player.platform)}</div>
      </div>
      <button class="remove-player" type="button" aria-label="삭제">×</button>
      <input value="${escapeAttr(player.displayName || player.name)}" maxlength="32" aria-label="출력명">
    </div>
  `).join("");

  dom.selectedPlayers.querySelectorAll(".selected-player").forEach((node) => {
    const accountId = node.dataset.accountId;
    node.querySelector("input").addEventListener("change", async (event) => {
      await updateDisplayName(accountId, event.target.value);
    });
    node.querySelector(".remove-player").addEventListener("click", async () => {
      await removeSelectedPlayer(accountId);
    });
  });
}

function renderSessionSummary() {
  const session = appState?.activeSession;
  if (!session) {
    dom.sessionSummary.textContent = "기록 세션 없음";
    return;
  }
  selectedMode = session.mode || selectedMode;
  renderModeTabs();
  dom.sessionSummary.textContent = `${formatMode(session.mode)} · 시작 매치 ${session.startMatchId} · 기록 ${session.matchIds.length}판 · 기준 ${session.anchorName}`;
}

function renderOverlayLinks(links) {
  const origin = window.location.origin;
  dom.overlayLinks.innerHTML = Object.entries(links || {}).map(([mode, href]) => {
    const url = `${origin}${href}`;
    return `
      <div class="overlay-link">
        <strong>${formatMode(mode)}</strong>
        <code>${escapeHtml(url)}</code>
        <button type="button" data-copy="${escapeAttr(url)}">복사</button>
        <a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">열기</a>
      </div>
    `;
  }).join("");

  dom.overlayLinks.querySelectorAll("button[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "완료";
      setTimeout(() => { button.textContent = "복사"; }, 1000);
    });
  });
}

function renderModeTabs() {
  dom.modeTabs.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === selectedMode);
  });
}

function renderMatches(matches) {
  if (!matches?.length) {
    dom.matchesList.innerHTML = `<div class="empty-state">검색 결과가 없습니다.</div>`;
    return;
  }

  dom.matchesList.innerHTML = matches.map((match) => {
    const focus = match.focusStats || {};
    const active = currentMatch?.matchId === match.matchId ? " active" : "";
    return `
      <button class="match-card${active}" type="button" data-match-id="${escapeAttr(match.matchId)}">
        <div class="match-title">
          <span>${escapeHtml(match.summary?.title || formatMode(match.category))}</span>
          <span class="badge">팀 #${escapeHtml(match.team?.teamId ?? "-")} · ${escapeHtml(match.team?.rank ?? "-")}위</span>
        </div>
        <div class="meta">${formatDate(match.createdAt)} · ${escapeHtml(match.mapName || "Map")}</div>
        <div class="match-stats">
          <div class="stat-chip"><span>킬</span><strong>${number(focus.kills)}</strong></div>
          <div class="stat-chip"><span>딜량</span><strong>${number(focus.damage)}</strong></div>
          <div class="stat-chip"><span>생존</span><strong>${formatTime(focus.timeSurvived)}</strong></div>
        </div>
      </button>
    `;
  }).join("");

  dom.matchesList.querySelectorAll(".match-card").forEach((button) => {
    button.addEventListener("click", () => loadMatch(button.dataset.matchId));
  });
}

function renderMatchDetail(match) {
  const team = match.team;
  if (!team) {
    dom.matchDetail.className = "match-detail empty-state";
    dom.matchDetail.textContent = "팀 정보를 찾을 수 없습니다.";
    return;
  }

  dom.matchMeta.textContent = `${formatDate(match.createdAt)} · ${formatMode(match.category)} · ${match.matchId}`;
  dom.matchDetail.className = "match-detail";
  dom.matchDetail.innerHTML = `
    <div class="team-banner">
      <div><span>팀번호</span><strong>${escapeHtml(team.teamId)}</strong></div>
      <div><span>순위</span><strong>${escapeHtml(team.rank)}위</strong></div>
      <div><span>맵</span><strong>${escapeHtml(match.mapName || "-")}</strong></div>
      <div><span>게임모드</span><strong>${escapeHtml(match.gameMode || "-")}</strong></div>
    </div>
    <div class="members-table">
      <div class="member-row header">
        <div>플레이어</div>
        <div>킬</div>
        <div>딜량</div>
        <div>이동</div>
        <div class="optional">생존</div>
        <div class="optional">순위</div>
        <div>경쟁전</div>
        <div>선택</div>
      </div>
      ${team.members.map(renderMemberRow).join("")}
    </div>
  `;

  dom.matchDetail.querySelectorAll(".select-member").forEach((button) => {
    button.addEventListener("click", async () => {
      const member = team.members.find((item) => item.playerId === button.dataset.playerId);
      if (member) await selectMember(member);
    });
  });
}

function renderMemberRow(member) {
  const selected = Boolean(appState?.selectedPlayers?.some((player) => player.accountId === member.playerId));
  const rank = member.rank ? `${member.rank.tier || "-"} · ${number(member.rank.points)}점` : "-";
  return `
    <div class="member-row">
      <div class="member-name">
        <strong title="${escapeAttr(member.name)}">${escapeHtml(member.name)}</strong>
        <span>${escapeHtml(member.playerId)}</span>
      </div>
      <div>${number(member.kills)}</div>
      <div>${number(member.damage)}</div>
      <div>${formatDistance(member.distance)}</div>
      <div class="optional">${formatTime(member.timeSurvived)}</div>
      <div class="optional">${escapeHtml(member.winPlace || "-")}</div>
      <div>${escapeHtml(rank)}</div>
      <div>
        <button class="select-member" type="button" data-player-id="${escapeAttr(member.playerId)}" ${selected ? "disabled" : ""}>${selected ? "선택됨" : "선택"}</button>
      </div>
    </div>
  `;
}

async function selectMember(member) {
  try {
    const result = await api("/api/players/select", {
      method: "POST",
      body: {
        player: {
          accountId: member.playerId,
          name: member.name,
          displayName: member.name,
          platform: dom.platform.value,
          rank: member.rank || null
        }
      }
    });
    renderState(result);
    renderMatchDetail(currentMatch);
    setStatus(`${member.name} 플레이어를 추가했습니다.`, "good");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function updateDisplayName(accountId, displayName) {
  try {
    const result = await api(`/api/players/${encodeURIComponent(accountId)}`, {
      method: "PATCH",
      body: { displayName }
    });
    renderState(result);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function removeSelectedPlayer(accountId) {
  try {
    const result = await api(`/api/players/${encodeURIComponent(accountId)}`, { method: "DELETE" });
    renderState(result);
    if (currentMatch) renderMatchDetail(currentMatch);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "요청 실패");
  return data;
}

function setBusy(button, busy) {
  button.disabled = busy;
}

function setStatus(message, tone = "") {
  dom.statusBox.className = `notice ${tone}`.trim();
  dom.statusBox.textContent = message || "";
}

function formatMode(mode) {
  return {
    normal: "일반전",
    ranked: "경쟁전",
    custom: "사용자지정"
  }[mode] || mode;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const minutes = Math.floor(total / 60);
  const rest = String(total % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
}

function formatDistance(value) {
  const meters = Number(value || 0);
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${Math.round(meters)}m`;
}

function number(value) {
  const n = Number(value || 0);
  return Math.round(n).toLocaleString("ko-KR");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#039;");
}
