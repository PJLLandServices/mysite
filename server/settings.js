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
  document.getElementById("icalCard").hidden = false;
  renderGrid();
  renderAudit();
  renderIcalFeed();
}

// iPhone Calendar Sync card — toggles between the before-generate state
// (single "Generate calendar URL" button) and the after-generate state
// (URL + copy/regen/disable buttons) based on currentSettings.icalFeed.
function renderIcalFeed() {
  const feed = (currentSettings && currentSettings.icalFeed) || { enabled: false, token: null };
  const before = document.getElementById("icalBefore");
  const after = document.getElementById("icalAfter");
  const urlInput = document.getElementById("icalUrl");
  const stamp = document.getElementById("icalRegeneratedAt");
  if (feed.enabled && feed.token) {
    before.hidden = true;
    after.hidden = false;
    const origin = window.location.origin.replace(/\/+$/, "");
    urlInput.value = `${origin}/calendar/${feed.token}.ics`;
    if (feed.regeneratedAt) {
      stamp.textContent = `Generated ${new Date(feed.regeneratedAt).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}`;
    } else {
      stamp.textContent = "";
    }
  } else {
    before.hidden = false;
    after.hidden = true;
    urlInput.value = "";
    stamp.textContent = "";
  }
}

async function postIcal(action) {
  const r = await fetch(`/api/settings/ical-feed/${action}`, { method: "POST" });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    throw new Error((data.errors || ["Couldn't update feed."]).join(" "));
  }
  currentSettings = data.settings;
  renderIcalFeed();
  // Audit grid reflects the new entry too.
  renderAudit();
  return data;
}

document.getElementById("icalGenerateBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("icalGenerateBtn");
  const status = document.getElementById("icalStatus");
  btn.disabled = true;
  status.textContent = "Generating…";
  try {
    await postIcal("generate");
    status.textContent = "";
  } catch (err) {
    status.textContent = err.message || "Couldn't generate.";
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("icalRegenerateBtn")?.addEventListener("click", async () => {
  if (!confirm("Regenerate the calendar URL?\n\nThe current URL on your iPhone will stop working — you'll need to add the new one. Use this if the URL leaked.")) return;
  const status = document.getElementById("icalStatusAfter");
  status.textContent = "Regenerating…";
  try {
    await postIcal("regenerate");
    status.textContent = "New URL ready. Re-add it to your iPhone Calendar.";
    setTimeout(() => { status.textContent = ""; }, 6000);
  } catch (err) {
    status.textContent = err.message || "Couldn't regenerate.";
  }
});

document.getElementById("icalDisableBtn")?.addEventListener("click", async () => {
  if (!confirm("Disable the calendar feed?\n\nYour iPhone subscription will stop receiving updates and existing events may disappear.")) return;
  const status = document.getElementById("icalStatusAfter");
  status.textContent = "Disabling…";
  try {
    await postIcal("disable");
    status.textContent = "";
  } catch (err) {
    status.textContent = err.message || "Couldn't disable.";
  }
});

document.getElementById("icalCopyBtn")?.addEventListener("click", async () => {
  const url = document.getElementById("icalUrl").value;
  const status = document.getElementById("icalStatusAfter");
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = "Copied!";
    setTimeout(() => { status.textContent = ""; }, 2500);
  } catch (_) {
    // Older Safari might not have async clipboard — fall back to selecting.
    const input = document.getElementById("icalUrl");
    input.focus();
    input.select();
    status.textContent = "Copied (manual: ⌘C to confirm)";
    setTimeout(() => { status.textContent = ""; }, 4000);
  }
});

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

// ---- QuickBooks connect + config block ---------------------------------
let qbSettings = null;       // settings.quickbooks namespace cache
let qbConnected = false;     // gates dropdown loads + items-sync button
let qbDirty = false;         // tracks unsaved mapping changes

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
    const configBlock = document.getElementById("qbConfigBlock");
    if (!data.configured) {
      status.textContent = "⚠ Not configured. Set QB_CLIENT_ID + QB_CLIENT_SECRET on Render, then refresh this page.";
      status.dataset.kind = "warn";
      connect.style.display = "none";
      if (configBlock) configBlock.hidden = true;
      qbConnected = false;
      return;
    }
    if (data.connected) {
      status.textContent = `✓ Connected (${data.environment} environment).`;
      status.dataset.kind = "ok";
      connect.style.display = "none";
      disconnect.hidden = false;
      if (configBlock) configBlock.hidden = false;
      qbConnected = true;
      // Now load settings + populate dropdowns + render errors panel.
      await loadQbConfig();
    } else {
      status.textContent = `Configured (${data.environment} environment) — not yet authorized. Click below to grant access.`;
      status.dataset.kind = "info";
      connect.style.display = "";
      disconnect.hidden = true;
      if (configBlock) configBlock.hidden = true;
      qbConnected = false;
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

// Pull the live settings + the QB tax-code and income-account lists, then
// populate the dropdowns + restore the saved selections + render the
// auto-push toggles + the recent-errors list.
async function loadQbConfig() {
  // Settings first — we need the saved IDs before we can highlight them
  // in the dropdowns.
  try {
    const r = await fetch("/api/settings", { cache: "no-store" });
    const data = await r.json();
    qbSettings = data?.settings?.quickbooks || null;
  } catch (e) {
    qbSettings = null;
  }

  // Restore toggles immediately (they don't need a network round-trip).
  const estToggle = document.getElementById("qbEstAutoToggle");
  const invToggle = document.getElementById("qbInvAutoToggle");
  if (estToggle) estToggle.checked = !!qbSettings?.estimateAutoPushOnAccept;
  if (invToggle) invToggle.checked = !!qbSettings?.invoiceAutoPushOnCascade;

  // Tax codes + income accounts in parallel — both are QB Query calls and
  // independent.
  const [taxCodesRes, accountsRes] = await Promise.all([
    fetch("/api/admin/quickbooks/tax-codes", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    fetch("/api/admin/quickbooks/income-accounts", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}))
  ]);

  populateDropdown(
    document.getElementById("qbTaxCodeSelect"),
    taxCodesRes?.taxCodes || [],
    qbSettings?.hstTaxCodeId || "",
    (c) => `${c.name}${c.description ? ` — ${c.description}` : ""}`
  );
  populateDropdown(
    document.getElementById("qbIncomeAccountSelect"),
    accountsRes?.accounts || [],
    qbSettings?.defaultIncomeAccountId || "",
    (a) => a.fullyQualifiedName || a.name
  );

  // Items sync button enabled only when income account is set.
  const syncBtn = document.getElementById("qbSyncItemsBtn");
  if (syncBtn) syncBtn.disabled = !qbSettings?.defaultIncomeAccountId;

  // Render errors list.
  renderQbErrors();

  // Save button starts disabled; flips on when user changes a dropdown
  // or toggle.
  qbDirty = false;
  const saveBtn = document.getElementById("qbSaveBtn");
  if (saveBtn) saveBtn.disabled = true;
}

function populateDropdown(select, items, currentValue, labelFn) {
  if (!select) return;
  if (!items.length) {
    select.innerHTML = `<option value="">— None available in QB —</option>`;
    return;
  }
  const opts = [`<option value="">— Pick one —</option>`];
  for (const it of items) {
    const sel = String(it.id) === String(currentValue) ? " selected" : "";
    opts.push(`<option value="${escapeHtml(it.id)}"${sel}>${escapeHtml(labelFn(it))}</option>`);
  }
  select.innerHTML = opts.join("");
}

function renderQbErrors() {
  const list = document.getElementById("qbErrorList");
  if (!list) return;
  const errors = qbSettings?.lastSyncErrors || [];
  if (!errors.length) {
    list.innerHTML = `<li class="settings-audit-empty">No recent sync errors.</li>`;
    return;
  }
  list.innerHTML = errors.map((e) => {
    const ts = new Date(e.ts).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" });
    return `<li>
      <span class="settings-audit-ts">${escapeHtml(ts)}</span> ·
      <strong>${escapeHtml(e.entityType)}</strong> ${escapeHtml(e.entityId || "")} —
      ${escapeHtml(e.error)}
    </li>`;
  }).join("");
}

// Wire the dropdown + toggle change handlers.
["qbTaxCodeSelect", "qbIncomeAccountSelect", "qbEstAutoToggle", "qbInvAutoToggle"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", () => {
    qbDirty = true;
    const saveBtn = document.getElementById("qbSaveBtn");
    if (saveBtn) saveBtn.disabled = false;
    const status = document.getElementById("qbSaveStatus");
    if (status) status.textContent = "";
  });
});

document.getElementById("qbSaveBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("qbSaveBtn");
  const status = document.getElementById("qbSaveStatus");
  btn.disabled = true;
  status.textContent = "Saving…";

  // Pull display names from the selected option text so the audit log
  // and any future "what tax code is this?" UI doesn't have to re-query
  // QB just to render a friendly name.
  const taxSel = document.getElementById("qbTaxCodeSelect");
  const acctSel = document.getElementById("qbIncomeAccountSelect");
  const taxOpt = taxSel.options[taxSel.selectedIndex];
  const acctOpt = acctSel.options[acctSel.selectedIndex];

  const patch = {
    hstTaxCodeId: taxSel.value || null,
    hstTaxCodeName: taxSel.value ? taxOpt.textContent.trim() : null,
    defaultIncomeAccountId: acctSel.value || null,
    defaultIncomeAccountName: acctSel.value ? acctOpt.textContent.trim() : null,
    estimateAutoPushOnAccept: document.getElementById("qbEstAutoToggle").checked,
    invoiceAutoPushOnCascade: document.getElementById("qbInvAutoToggle").checked
  };

  try {
    const r = await fetch("/api/admin/quickbooks/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch)
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Save failed.");
    qbSettings = data.quickbooks;
    qbDirty = false;
    status.textContent = "Saved.";
    // Re-evaluate items-sync button (income account may have changed).
    const syncBtn = document.getElementById("qbSyncItemsBtn");
    if (syncBtn) syncBtn.disabled = !qbSettings?.defaultIncomeAccountId;
  } catch (err) {
    status.textContent = err.message || "Save failed.";
    btn.disabled = false;
  }
});

document.getElementById("qbSyncItemsBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("qbSyncItemsBtn");
  const status = document.getElementById("qbItemsStatus");
  const summaryEl = document.getElementById("qbItemsSummary");
  btn.disabled = true;
  status.textContent = "Syncing… (~30s for ~180 items)";
  summaryEl.hidden = true;
  try {
    const r = await fetch("/api/admin/quickbooks/items/sync", { method: "POST" });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Sync failed.");
    const s = data.summary;
    const lines = [
      `Services: ${s.servicesCreated} created · ${s.servicesUpdated} updated · ${s.servicesSkipped} skipped`,
      `Parts:    ${s.partsCreated} created · ${s.partsUpdated} updated · ${s.partsSkipped} skipped`
    ];
    if (s.errors?.length) {
      lines.push("");
      lines.push(`Errors (${s.errors.length}):`);
      for (const e of s.errors.slice(0, 10)) lines.push(`  · ${e.kind}/${e.key}: ${e.error}`);
      if (s.errors.length > 10) lines.push(`  · …and ${s.errors.length - 10} more (see Recent sync errors below).`);
    }
    summaryEl.textContent = lines.join("\n");
    summaryEl.hidden = false;
    status.textContent = `Sync complete — ${new Date().toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" })}.`;
    // Refresh errors list — sync errors got appended.
    await loadQbConfig();
  } catch (err) {
    status.textContent = err.message || "Sync failed.";
    btn.disabled = false;
  }
});

document.getElementById("qbClearErrorsBtn")?.addEventListener("click", async () => {
  if (!confirm("Clear the recent-errors list? Errors are dropped, not the underlying records.")) return;
  try {
    const r = await fetch("/api/admin/quickbooks/clear-sync-errors", { method: "POST" });
    const data = await r.json();
    if (data.ok) {
      qbSettings = data.quickbooks;
      renderQbErrors();
    }
  } catch (e) { /* swallow — UI still re-renders */ }
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
