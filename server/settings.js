const EVENT_LABELS = {
  newLead: { label: "New lead intake", help: "When the contact form / AI chat creates a fresh lead." },
  quoteAccepted: { label: "Quote accepted", help: "When a customer accepts a quote from the portal." },
  woCompleted: { label: "Work order completed", help: "When a tech marks a WO as completed (cascade fires)." },
  portalMessage: { label: "Portal message", help: "When a customer sends a message via the portal." },
  emergencyOverride: { label: "Emergency override", help: "When a tech promotes a fall-closing issue to emergency. Recommended: never silence." },
  portalPreAuth: { label: "Portal pre-authorization", help: "When a customer pre-authorizes a deferred recommendation." }
};

const MODE_LABELS = {
  email_sms: "Email + SMS",
  email: "Email only",
  sms: "SMS only",
  silent: "Silent"
};

let currentSettings = null;
let dirty = false;

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

async function load() {
  const r = await fetch("/api/settings", { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) {
    document.getElementById("settingsLoading").textContent = "Couldn't load settings.";
    return;
  }
  currentSettings = data.settings;
  document.getElementById("settingsLoading").hidden = true;
  document.getElementById("adminDefaultsCard").hidden = false;
  document.getElementById("auditCard").hidden = false;
  renderGrid();
  renderAudit();
}

function renderGrid() {
  const grid = document.getElementById("adminDefaultsGrid");
  grid.innerHTML = "";
  for (const [key, info] of Object.entries(EVENT_LABELS)) {
    const current = currentSettings.adminDefaults[key] || "silent";
    const row = document.createElement("div");
    row.className = "settings-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(info.label)}</strong>
        <p class="settings-row-help">${escapeHtml(info.help)}</p>
      </div>
      <select data-event="${escapeHtml(key)}" class="settings-select">
        ${Object.entries(MODE_LABELS).map(([m, l]) =>
          `<option value="${escapeHtml(m)}" ${m === current ? "selected" : ""}>${escapeHtml(l)}</option>`
        ).join("")}
      </select>
    `;
    grid.appendChild(row);
  }
  grid.querySelectorAll("select").forEach((sel) => {
    sel.addEventListener("change", () => {
      dirty = true;
      document.getElementById("adminDefaultsSave").disabled = false;
      document.getElementById("adminDefaultsStatus").textContent = "";
    });
  });
}

function renderAudit() {
  const list = document.getElementById("auditList");
  const audit = currentSettings.audit || [];
  if (!audit.length) {
    list.innerHTML = `<li class="settings-audit-empty">No changes yet.</li>`;
    return;
  }
  list.innerHTML = audit.slice(0, 50).map((entry) => {
    const ts = new Date(entry.ts).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" });
    const diff = Object.keys(entry.after || {})
      .filter((k) => entry.before?.[k] !== entry.after[k])
      .map((k) => `${k}: ${entry.before?.[k] || "—"} → ${entry.after[k]}`)
      .join("; ");
    return `<li><span class="settings-audit-ts">${escapeHtml(ts)}</span> · ${escapeHtml(entry.who || "—")} · ${escapeHtml(diff || "(no change)")}</li>`;
  }).join("");
}

document.getElementById("adminDefaultsSave")?.addEventListener("click", async () => {
  const grid = document.getElementById("adminDefaultsGrid");
  const patch = {};
  grid.querySelectorAll("select[data-event]").forEach((sel) => {
    patch[sel.dataset.event] = sel.value;
  });
  const btn = document.getElementById("adminDefaultsSave");
  const status = document.getElementById("adminDefaultsStatus");
  btn.disabled = true;
  status.textContent = "Saving…";
  try {
    const r = await fetch("/api/settings/admin-defaults", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't save.");
    currentSettings = data.settings;
    renderAudit();
    dirty = false;
    status.textContent = "Saved.";
  } catch (err) {
    status.textContent = err.message || "Failed.";
    btn.disabled = false;
  }
});

// ---- QuickBooks connect block ------------------------------------------
async function loadQbStatus() {
  // Populate the redirect URI hint with the current origin so Patrick can
  // copy/paste it into the QB Developer app dashboard.
  const redirectEl = document.getElementById("qbRedirectUri");
  if (redirectEl) redirectEl.textContent = `${location.origin}/api/admin/quickbooks/callback`;

  try {
    const r = await fetch("/api/admin/quickbooks/status", { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!data.ok) throw new Error("Couldn't reach the QuickBooks status endpoint.");
    const status = document.getElementById("qbStatus");
    const connect = document.getElementById("qbConnectBtn");
    const disconnect = document.getElementById("qbDisconnectBtn");
    if (!data.configured) {
      status.textContent = "⚠ Not configured. Set QB_CLIENT_ID + QB_CLIENT_SECRET on Render, then refresh this page.";
      status.dataset.kind = "warn";
      connect.style.display = "none";
      return;
    }
    if (data.connected) {
      status.textContent = `✓ Connected (${data.environment} environment).`;
      status.dataset.kind = "ok";
      connect.style.display = "none";
      disconnect.hidden = false;
    } else {
      status.textContent = `Configured (${data.environment} environment) — not yet authorized. Click below to grant access.`;
      status.dataset.kind = "info";
      connect.style.display = "";
      disconnect.hidden = true;
    }
  } catch (err) {
    const status = document.getElementById("qbStatus");
    status.textContent = "Couldn't load QuickBooks status: " + err.message;
    status.dataset.kind = "error";
  }
}

document.getElementById("qbDisconnectBtn")?.addEventListener("click", async () => {
  if (!confirm("Disconnect from QuickBooks? You'll need to re-authorize before pushing invoices again.")) return;
  await fetch("/api/admin/quickbooks/disconnect", { method: "POST" });
  loadQbStatus();
});

// Surface query-string hints from the OAuth callback redirect so Patrick
// gets immediate feedback after authorizing (Intuit bounces back to
// /admin/settings?qb=connected | denied | error).
(function showQbCallbackToast() {
  const qb = new URLSearchParams(location.search).get("qb");
  if (!qb) return;
  const status = document.getElementById("qbStatus");
  if (qb === "connected") setTimeout(() => alert("QuickBooks connected. You can now push invoices."), 200);
  if (qb === "denied")    setTimeout(() => alert("QuickBooks authorization was denied."), 200);
  if (qb === "error")     setTimeout(() => alert("QuickBooks connection failed. Check the server logs."), 200);
  // Clean the URL so refreshes don't repeat the alert.
  history.replaceState(null, "", "/admin/settings");
})();

load();
loadQbStatus();
