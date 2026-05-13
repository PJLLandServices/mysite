// Portal Messages inbox — admin side. Renders the cross-lead thread
// list, expands threads inline for read/reply, and auto-marks customer
// messages read once Patrick opens the thread.

const threadListEl = document.getElementById("threadList");
const emptyStateEl = document.getElementById("emptyState");
const threadTotalEl = document.getElementById("threadTotal");
const unreadTotalEl = document.getElementById("unreadTotal");

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" })
    + " " + d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}

async function loadInbox() {
  try {
    const r = await fetch("/api/admin/portal-messages", { cache: "no-store" });
    const data = await r.json();
    if (!data.ok) throw new Error((data.errors || ["Couldn't load inbox."]).join(" "));
    renderInbox(data.threads || [], data.totalUnread || 0);
  } catch (err) {
    threadListEl.innerHTML = "";
    emptyStateEl.hidden = false;
    emptyStateEl.textContent = err.message || "Couldn't load inbox.";
  }
}

function renderInbox(threads, totalUnread) {
  threadTotalEl.textContent = String(threads.length);
  unreadTotalEl.textContent = String(totalUnread);
  threadListEl.innerHTML = "";
  if (!threads.length) {
    emptyStateEl.hidden = false;
    return;
  }
  emptyStateEl.hidden = true;
  threads.forEach((thread) => {
    const li = document.createElement("li");
    li.className = "msg-thread" + (thread.unreadCount > 0 ? " is-unread" : "");
    li.dataset.leadId = thread.leadId;
    const previewFrom = thread.lastMessage.from === "customer" ? "Customer" : "You";
    li.innerHTML = `
      <button type="button" class="msg-thread-summary" data-thread-toggle>
        <span class="msg-thread-name">
          ${escapeHtml(thread.customerName || "(no name)")}
          ${thread.unreadCount > 0 ? `<span class="msg-unread-badge">${thread.unreadCount} new</span>` : ""}
          ${thread.customerPhone ? `<span class="msg-thread-phone"> · ${escapeHtml(thread.customerPhone)}</span>` : ""}
        </span>
        <span class="msg-thread-time">${escapeHtml(fmtTime(thread.lastMessage.ts))}</span>
        <span class="msg-thread-preview">
          <span class="preview-from">${previewFrom}:</span>${escapeHtml(thread.lastMessage.body || "")}
        </span>
      </button>
      <div class="msg-thread-body" data-thread-body hidden>
        <div class="msg-bubbles" data-bubbles></div>
        <form class="msg-reply-form" data-reply-form>
          <textarea data-reply-input placeholder="Type your reply..." maxlength="1500" required></textarea>
          <div class="msg-reply-actions">
            <span class="msg-reply-status" data-reply-status role="status"></span>
            <button type="submit" class="pjl-btn pjl-btn-primary" data-reply-submit>Send reply</button>
          </div>
          <p class="msg-reply-error" data-reply-error hidden role="alert"></p>
        </form>
      </div>
    `;
    threadListEl.appendChild(li);
  });
}

threadListEl.addEventListener("click", async (event) => {
  const toggle = event.target.closest("[data-thread-toggle]");
  if (!toggle) return;
  const threadEl = toggle.closest(".msg-thread");
  if (!threadEl) return;
  const leadId = threadEl.dataset.leadId;
  const wasOpen = threadEl.classList.contains("is-open");
  // Single-open accordion: collapse anything else.
  threadListEl.querySelectorAll(".msg-thread.is-open").forEach((el) => el.classList.remove("is-open"));
  if (wasOpen) return;
  threadEl.classList.add("is-open");
  await loadThread(threadEl, leadId);
});

async function loadThread(threadEl, leadId) {
  const bubblesEl = threadEl.querySelector("[data-bubbles]");
  bubblesEl.innerHTML = `<p class="msg-thread-loading">Loading…</p>`;
  try {
    const r = await fetch(`/api/admin/portal-messages/${encodeURIComponent(leadId)}`, { cache: "no-store" });
    const data = await r.json();
    if (!data.ok) throw new Error((data.errors || ["Couldn't load thread."]).join(" "));
    renderBubbles(bubblesEl, data.thread.messages || []);
    // Mark customer messages as read for this thread. Best-effort —
    // ignore failures (the inbox will re-fetch on next load anyway).
    fetch(`/api/admin/portal-messages/${encodeURIComponent(leadId)}/read`, { method: "POST" }).then(() => {
      // Refresh the badge + the inbox row's unread state without
      // re-fetching the whole inbox: drop the unread class + the badge.
      threadEl.classList.remove("is-unread");
      const badge = threadEl.querySelector(".msg-unread-badge");
      if (badge) badge.remove();
      refreshNavBadge();
      refreshUnreadTotal();
    }).catch(() => {});
  } catch (err) {
    bubblesEl.innerHTML = `<p class="msg-reply-error">${escapeHtml(err.message || "Couldn't load thread.")}</p>`;
  }
}

function renderBubbles(bubblesEl, messages) {
  bubblesEl.innerHTML = "";
  if (!messages.length) {
    bubblesEl.innerHTML = `<p style="color:#7A7A72;font-style:italic;">No messages yet.</p>`;
    return;
  }
  messages.forEach((m) => {
    const div = document.createElement("div");
    div.className = "msg-bubble from-" + (m.from === "admin" ? "admin" : "customer");
    div.innerHTML = `${escapeHtml(m.body || "")}<span class="msg-bubble-meta">${m.from === "admin" ? "You" : "Customer"} · ${escapeHtml(fmtTime(m.ts))}</span>`;
    bubblesEl.appendChild(div);
  });
  // Scroll to latest.
  bubblesEl.scrollTop = bubblesEl.scrollHeight;
}

threadListEl.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-reply-form]");
  if (!form) return;
  event.preventDefault();
  const threadEl = form.closest(".msg-thread");
  if (!threadEl) return;
  const leadId = threadEl.dataset.leadId;
  const input = form.querySelector("[data-reply-input]");
  const submit = form.querySelector("[data-reply-submit]");
  const status = form.querySelector("[data-reply-status]");
  const error = form.querySelector("[data-reply-error]");
  const body = input.value.trim();
  if (!body) { input.focus(); return; }
  submit.disabled = true;
  submit.textContent = "Sending…";
  status.textContent = "";
  error.hidden = true;
  try {
    const r = await fetch(`/api/admin/portal-messages/${encodeURIComponent(leadId)}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: body })
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't send reply."]).join(" "));
    input.value = "";
    status.textContent = "Sent. Customer notified by email.";
    // Re-load the thread so the new bubble appears + the preview row updates.
    await loadThread(threadEl, leadId);
    setTimeout(() => { status.textContent = ""; }, 4000);
  } catch (err) {
    error.hidden = false;
    error.textContent = err.message || "Couldn't send reply.";
  } finally {
    submit.disabled = false;
    submit.textContent = "Send reply";
  }
});

// Lightweight helpers to keep the badges in sync without a full reload.
async function refreshNavBadge() {
  try {
    const r = await fetch("/api/admin/portal-messages/unread-count", { cache: "no-store" });
    const data = await r.json();
    if (!data.ok) return;
    const badge = document.querySelector("[data-portal-msg-badge]");
    if (!badge) return;
    if (data.count > 0) {
      badge.textContent = String(data.count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch (_) { /* leave badge alone */ }
}
async function refreshUnreadTotal() {
  try {
    const r = await fetch("/api/admin/portal-messages/unread-count", { cache: "no-store" });
    const data = await r.json();
    if (data.ok) unreadTotalEl.textContent = String(data.count || 0);
  } catch (_) {}
}

loadInbox();
