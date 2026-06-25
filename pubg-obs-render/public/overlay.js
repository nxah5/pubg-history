const overlay = document.querySelector("#overlay");
const mode = location.pathname.split("/").filter(Boolean).pop() || "normal";

render();
setInterval(render, 2500);

async function render() {
  try {
    const response = await fetch(`/api/overlay/${encodeURIComponent(mode)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "overlay error");
    overlay.innerHTML = data.players.map((player) => renderPlayer(player, data.mode)).join("");
    overlay.classList.toggle("empty", !data.players.length);
  } catch {
    overlay.innerHTML = "";
    overlay.classList.add("empty");
  }
}

function renderPlayer(player, outputMode) {
  const rank = player.rank || {};
  const rankTier = rank.tier || "-";
  const rankPoints = rank.points ? number(rank.points) : "-";
  const esports = player.esports || {};
  const rankedRow = outputMode === "ranked"
    ? `
      <div class="metric-row two">
        <div class="metric gold"><span>경쟁전 티어</span><strong>${escapeHtml(rankTier)}</strong></div>
        <div class="metric gold"><span>경쟁전 점수</span><strong>${escapeHtml(rankPoints)}</strong></div>
      </div>
    `
    : "";
  const customScoreRow = outputMode === "custom"
    ? `
      <div class="metric-row four">
        <div class="metric accent"><span>누적 킬</span><strong>${number(esports.cumulativeKills)}</strong></div>
        <div class="metric gold"><span>팀 생존점수</span><strong>${number(esports.survivalPoints)}</strong></div>
        <div class="metric gold"><span>팀 킬점수</span><strong>${number(esports.killPoints)}</strong></div>
        <div class="metric accent"><span>토탈점수</span><strong>${number(esports.totalPoints)}</strong></div>
      </div>
    `
    : "";

  return `
    <section class="player-card">
      <div class="player-name">${escapeHtml(player.displayName || player.name)}</div>
      <div class="metric-row three">
        <div class="metric accent"><span>평균킬뎃</span><strong>${formatKd(player.averages.kd)}</strong></div>
        <div class="metric"><span>평균딜량</span><strong>${number(player.averages.damage)}</strong></div>
        <div class="metric"><span>평균이동거리</span><strong>${formatDistance(player.averages.distance)}</strong></div>
      </div>
      ${rankedRow}
      ${customScoreRow}
      <div class="metric-row one">
        <div class="metric"><span>이전판 생존 시간</span><strong>${formatTime(player.lastSurvivalTime)}</strong></div>
      </div>
    </section>
  `;
}

function formatKd(value) {
  return Number(value || 0).toFixed(2);
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
  return Math.round(Number(value || 0)).toLocaleString("ko-KR");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
