// =============================================================
// PJL CRM — AI Chat Transcripts dashboard
// =============================================================
const tabs = document.getElementById("tabs");
const chatList = document.getElementById("chatList");
const emptyState = document.getElementById("emptyState");
const summary = {
  total: document.querySelector('[data-summary="total"]'),
  booked: document.querySelector('[data-summary="booked"]'),
  abandoned: document.querySelector('[data-summary="abandoned"]'),
  conversion: document.querySelector('[data-summary="conversion"]')
};
const counts = {
  all: document.querySelector('[data-count="all"]'),
  booked: document.querySelector('[data-count="booked"]'),
  abandoned: document.querySelector('[data-count="abandoned"]'),
  active: document.querySelector('[data-count="active"]')
};

let activeStatus = "all";
let allChats = [];

document.getElementById("logoutButton").addEventListener("click", async () => {
  try { await fetch("/api/logout", { method: "POST", credentials: "include" }); }
  catch (e) {}
  window.location.href = "/login";
});

tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".chats-tab");
  if (!btn) return;
  activeStatus = btn.dataset.status;
  for (const t of tabs.querySelectorAll(".chats-tab")) t.classList.toggle("is-active", t === btn);
  render();
});

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

function render() {
  const filtered = activeStatus === "all"
    ? allChats
    : allChats.filter((c) => c.status === activeStatus);
  chatList.innerHTML = "";
  if (!filtered.length) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  for (const chat of filtered) {
    const row = document.createElement("div");
    row.className = "chat-row";

    const summary = document.createElement("div");
    summary.className = "chat-row-summary";
    summary.innerHTML = `
      <span class="chat-status-pill ${chat.status}">${chat.status}</span>
      <span class="chat-preview"></span>
      <span class="chat-meta">${chat.messageCount || 0} msgs</span>
      <span class="chat-meta">${escapeHtml(fmtRelative(chat.lastUpdatedAt))}</span>
      <span class="chat-row-toggle">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </span>
    `;
    summary.querySelector(".chat-preview").textContent = (chat.preview || "").replace(/\s+/g, " ").slice(0, 200) || "(no messages yet)";
    row.appendChild(summary);

    const detail = document.createElement("div");
    detail.className = "chat-row-detail";
    detail.innerHTML = `
      <div class="chat-detail-meta">
        <div>First seen<strong>${escapeHtml(new Date(chat.firstSeenAt).toLocaleString("en-CA"))}</strong></div>
        <div>Last update<strong>${escapeHtml(new Date(chat.lastUpdatedAt).toLocaleString("en-CA"))}</strong></div>
        <div>Status<strong>${escapeHtml(chat.status)}</strong></div>
        ${chat.bookedLeadId ? `<div>Booked lead<strong><a href="/admin#${escapeHtml(chat.bookedLeadId)}">View lead →</a></strong></div>` : ""}
      </div>
      <div class="chat-transcript" data-detail-body>Loading transcript...</div>
    `;
    row.appendChild(detail);

    summary.addEventListener("click", async () => {
      const wasOpen = row.classList.contains("is-open");
      row.classList.toggle("is-open");
      if (!wasOpen && detail.querySelector("[data-detail-body]").textContent === "Loading transcript...") {
        try {
          const r = await fetch(`/api/chat-transcripts/${encodeURIComponent(chat.id)}`, { credentials: "include" });
          const data = await r.json();
          if (data.ok && data.chat) {
            detail.querySelector("[data-detail-body]").textContent = data.chat.transcript || "(empty)";
          } else {
            detail.querySelector("[data-detail-body]").textContent = "Couldn't load transcript.";
          }
        } catch (e) {
          detail.querySelector("[data-detail-body]").textContent = "Error loading transcript.";
        }
      }
    });

    chatList.appendChild(row);
  }
}

function renderSummary(c) {
  summary.total.textContent = c.all || 0;
  summary.booked.textContent = c.booked || 0;
  summary.abandoned.textContent = c.abandoned || 0;
  const closed = (c.booked || 0) + (c.abandoned || 0);
  summary.conversion.textContent = closed > 0
    ? `${Math.round((c.booked / closed) * 100)}%`
    : "—";

  counts.all.textContent = c.all || 0;
  counts.booked.textContent = c.booked || 0;
  counts.abandoned.textContent = c.abandoned || 0;
  counts.active.textContent = c.active || 0;
}

async function load() {
  try {
    const r = await fetch("/api/chat-transcripts", { credentials: "include" });
    if (r.status === 401) { window.location.href = "/login?next=/admin/chats"; return; }
    const data = await r.json();
    if (!data.ok) throw new Error("Couldn't load chats");
    allChats = data.chats || [];
    renderSummary(data.counts || {});
    render();
  } catch (e) {
    console.error(e);
    chatList.innerHTML = `<div class="chats-empty"><h3>Couldn't load</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

load();
// Refresh every 60s so Patrick sees new chats roll in.
setInterval(load, 60000);
