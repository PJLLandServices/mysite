// =============================================================
// PJL CRM — AI Chat Transcripts dashboard
// =============================================================

// Mobile nav hamburger toggle (shared pattern across all admin pages).
(function setupNavToggle() {
  const toggle = document.getElementById("navToggle");
  const nav = document.querySelector(".pjl-admin-nav");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  nav.querySelectorAll(".pjl-nav-links a").forEach((a) => {
    a.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
})();

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
// Rows Patrick has expanded. render() runs again on every 60s poll, which
// used to rebuild the list and snap every open transcript shut mid-read.
const openChats = new Set();
// transcript text keyed by `${id}:${lastUpdatedAt}` — a chat that has since
// grown misses the cache and refetches, a finished one never refetches.
const transcriptCache = new Map();
// Signature of the list as last drawn; identical data skips the redraw
// entirely so a poll can't reflow the page under you while you read.
let lastSignature = "";

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

function listSignature() {
  return JSON.stringify(
    allChats.map((c) => [c.id, c.status, c.messageCount, c.lastUpdatedAt, c.bookedLeadId])
  ) + `|${activeStatus}`;
}

function render() {
  lastSignature = listSignature();
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
    const previewText = window.PJLTranscript
      ? window.PJLTranscript.buildPreview(chat.preview || "")
      : (chat.preview || "");
    summary.querySelector(".chat-preview").textContent =
      previewText.replace(/\s+/g, " ").slice(0, 200) || "(no messages yet)";
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
      <div class="chat-transcript is-loading" data-detail-body>Loading transcript…</div>
    `;
    row.appendChild(detail);

    summary.addEventListener("click", () => {
      const wasOpen = row.classList.contains("is-open");
      row.classList.toggle("is-open", !wasOpen);
      if (wasOpen) {
        openChats.delete(chat.id);
      } else {
        openChats.add(chat.id);
        loadTranscript(chat, detail);
      }
    });

    if (openChats.has(chat.id)) {
      row.classList.add("is-open");
      loadTranscript(chat, detail);
    }

    chatList.appendChild(row);
  }
}

// Fetch (or reuse) a transcript and lay it out as a conversation.
// The raw string stays available behind the "Plain text" toggle — if the
// turn parsing ever meets a transcript it can't split, nothing is hidden.
async function loadTranscript(chat, detail) {
  const body = detail.querySelector("[data-detail-body]");
  if (!body || body.dataset.state === "loading" || body.dataset.state === "ready") return;

  const cacheKey = `${chat.id}:${chat.lastUpdatedAt}`;
  if (transcriptCache.has(cacheKey)) {
    paintTranscript(body, transcriptCache.get(cacheKey));
    return;
  }

  body.dataset.state = "loading";
  try {
    const r = await fetch(`/api/chat-transcripts/${encodeURIComponent(chat.id)}`, { credentials: "include" });
    const data = await r.json();
    if (data.ok && data.chat) {
      const text = data.chat.transcript || "";
      transcriptCache.set(cacheKey, text);
      paintTranscript(body, text);
    } else {
      body.dataset.state = "";
      body.className = "chat-transcript is-error";
      body.textContent = "Couldn't load transcript.";
    }
  } catch (e) {
    body.dataset.state = "";
    body.className = "chat-transcript is-error";
    body.textContent = "Error loading transcript.";
  }
}

function paintTranscript(body, text) {
  body.dataset.state = "ready";
  body.className = "chat-transcript";
  body.textContent = "";

  if (!window.PJLTranscript) {
    body.className = "chat-transcript";
    const raw = document.createElement("div");
    raw.className = "pjl-convo-plain";
    raw.textContent = text || "(empty)";
    body.appendChild(raw);
    return;
  }

  const parsed = window.PJLTranscript.parse(text);
  const conversation = window.PJLTranscript.render(text);

  const plain = document.createElement("div");
  plain.className = "pjl-convo";
  const plainInner = document.createElement("div");
  plainInner.className = "pjl-convo-plain";
  plainInner.textContent = text || "(empty)";
  plain.appendChild(plainInner);
  plain.hidden = true;

  body.appendChild(buildToolbar(parsed, text, conversation, plain));
  body.appendChild(conversation);
  body.appendChild(plain);
}

function buildToolbar(parsed, rawText, conversation, plain) {
  const bar = document.createElement("div");
  bar.className = "pjl-convo-toolbar";

  const tally = document.createElement("span");
  tally.className = "pjl-convo-tally";
  tally.textContent = parsed.recognized
    ? `${parsed.counts.total} turn${parsed.counts.total === 1 ? "" : "s"} · ${parsed.counts.customer} from the customer`
    : "Unlabelled transcript";
  bar.appendChild(tally);

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  bar.appendChild(spacer);

  const views = [
    { key: "convo", label: "Conversation", node: conversation },
    { key: "plain", label: "Plain text", node: plain }
  ];
  const buttons = views.map((view) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pjl-convo-btn" + (view.key === "convo" ? " is-active" : "");
    btn.textContent = view.label;
    btn.addEventListener("click", () => {
      views.forEach((v) => { v.node.hidden = v.key !== view.key; });
      buttons.forEach((b, i) => b.classList.toggle("is-active", views[i].key === view.key));
    });
    bar.appendChild(btn);
    return btn;
  });

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "pjl-convo-btn";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(rawText);
      copy.textContent = "Copied";
    } catch (e) {
      copy.textContent = "Copy failed";
    }
    setTimeout(() => { copy.textContent = "Copy"; }, 1600);
  });
  bar.appendChild(copy);

  return bar;
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
    if (listSignature() === lastSignature && chatList.childElementCount) return;
    render();
  } catch (e) {
    console.error(e);
    chatList.innerHTML = `<div class="chats-empty"><h3>Couldn't load</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

load();
// Refresh every 60s so Patrick sees new chats roll in.
setInterval(load, 60000);
