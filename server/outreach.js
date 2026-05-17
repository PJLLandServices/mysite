// /admin/outreach — seasonal bulk-nudge UI.
// Pairs with server/outreach.html, server/lib/outreach.js, and the
// /api/outreach/* routes in server/server.js.
//
// Page flow:
//   1. Boot — pick default season (spring before Aug, fall after) +
//      current year + default filter "not_booked" + load templates.
//   2. Fetch /api/outreach/candidates → render stats + list.
//   3. Operator interacts: filter, select, edit template, compose &
//      send. Each action either re-fetches (filter / season / year)
//      or talks to a side-effect endpoint (send, opt-out, template).
//   4. After a send, refetch so booked / contacted state moves in
//      step with the touch records that just landed.
//
// All API failures bubble up as a single inline toast — the page
// stays usable and the operator can retry. Optimistic UI updates
// are deliberately NOT used here: the underlying writes have audit
// implications (touch records), and a misleading optimistic flip
// would confuse the operator about what actually went out.

(function () {
  "use strict";

  // ---- DOM lookups ---------------------------------------------------

  const $ = (sel) => document.querySelector(sel);
  const seasonSelect = $("#seasonSelect");
  const yearSelect = $("#yearSelect");
  const editTemplateBtn = $("#editTemplateBtn");
  const filterSelect = $("#filterSelect");
  const candidateList = $("#candidateList");
  const emptyState = $("#emptyState");
  const loadingHint = $("#loadingHint");
  const selectAll = $("#selectAll");
  const selectAllLabel = $("#selectAllLabel");
  const actionBar = $("#actionBar");
  const actionCount = $("#actionCount");
  const skipSeasonBtn = $("#skipSeasonBtn");
  const composeBtn = $("#composeBtn");
  const composeModal = $("#composeModal");
  const composeForm = $("#composeForm");
  const composeSubject = $("#composeSubject");
  const composeSmsBody = $("#composeSmsBody");
  const composeEmailBody = $("#composeEmailBody");
  const smsCharCount = $("#smsCharCount");
  const composeSendCount = $("#composeSendCount");
  const composeSendBtn = $("#composeSendBtn");
  const composeCloseBtn = $("#composeCloseBtn");
  const composeCancelBtn = $("#composeCancelBtn");
  const previewRecipient = $("#previewRecipient");
  const previewSms = $("#previewSms");
  const previewSubject = $("#previewSubject");
  const previewEmail = $("#previewEmail");
  const skipSummary = $("#skipSummary");
  const skipSummaryList = $("#skipSummaryList");
  const templateModal = $("#templateModal");
  const templateForm = $("#templateForm");
  const templateSubject = $("#templateSubject");
  const templateSmsBody = $("#templateSmsBody");
  const templateEmailBody = $("#templateEmailBody");
  const templateSeasonLabel = $("#templateSeasonLabel");
  const templateCloseBtn = $("#templateCloseBtn");
  const templateCancelBtn = $("#templateCancelBtn");
  const missingNameBanner = $("#missingNameBanner");
  const missingNameCount = $("#missingNameCount");
  const missingNameLink = $("#missingNameLink");
  const resultToast = $("#resultToast");
  const toastTitle = $("#toastTitle");
  const toastBody = $("#toastBody");
  const toastClose = $("#toastClose");

  // Channel checkboxes inside the compose modal — queried fresh
  // each time the modal renders because the form is dialog-scoped.
  function selectedChannels() {
    return Array.from(composeForm.querySelectorAll('input[name="channel"]:checked'))
      .map((el) => el.value);
  }

  // ---- State ---------------------------------------------------------

  // The single in-memory source of truth: the last candidates payload
  // plus a Set of selected property ids. All renders read from these.
  const state = {
    season: defaultSeason(),
    year: new Date().getFullYear(),
    filter: "not_booked",
    candidates: [],
    totals: { eligible: 0, contacted: 0, booked: 0, awaiting: 0, optedOut: 0, missingName: 0 },
    selected: new Set(),
    // Templates for both seasons, fetched once on boot and cached so
    // switching season in the compose modal doesn't roundtrip.
    templates: {
      spring: { subject: "", smsBody: "", emailBody: "" },
      fall: { subject: "", smsBody: "", emailBody: "" }
    },
    // Per-session lock — prevents a fast double-tap on the Send
    // button from firing two batches at once (the server enforces
    // this too via the module-level lock, but client-side guarding
    // keeps the UX clean).
    sending: false
  };

  // Default season pivot: before August → spring (outreach happens
  // in March / April for spring openings); August and later → fall.
  // Operator can switch via the dropdown either way.
  function defaultSeason() {
    return new Date().getMonth() < 7 ? "spring" : "fall";
  }

  // ---- Year dropdown population --------------------------------------

  function populateYearSelect() {
    const thisYear = new Date().getFullYear();
    const years = [thisYear - 1, thisYear, thisYear + 1];
    yearSelect.innerHTML = years.map((y) =>
      `<option value="${y}"${y === thisYear ? " selected" : ""}>${y}</option>`
    ).join("");
  }

  // ---- Network helpers -----------------------------------------------

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: "same-origin" };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let payload = null;
    try { payload = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || (payload && payload.ok === false)) {
      const msg = (payload && (payload.errors?.[0] || payload.error)) || `${method} ${url} failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload || {};
  }

  // ---- Toast ---------------------------------------------------------

  let toastDismissTimer = null;
  function showToast(title, body, { variant } = {}) {
    toastTitle.textContent = title;
    toastBody.textContent = body || "";
    resultToast.dataset.variant = variant || "info";
    resultToast.hidden = false;
    if (toastDismissTimer) clearTimeout(toastDismissTimer);
    toastDismissTimer = setTimeout(() => { resultToast.hidden = true; }, 8000);
  }
  toastClose.addEventListener("click", () => { resultToast.hidden = true; });

  // ---- Loaders -------------------------------------------------------

  async function loadCandidates() {
    loadingHint.hidden = false;
    candidateList.setAttribute("aria-busy", "true");
    try {
      const url = `/api/outreach/candidates?season=${encodeURIComponent(state.season)}&year=${encodeURIComponent(state.year)}&filter=${encodeURIComponent(state.filter)}`;
      const result = await api("GET", url);
      state.candidates = result.candidates || [];
      state.totals = result.totals || state.totals;
      // Drop any stale selections (rows that disappeared after a
      // filter switch or a send). Keep the rest so a partial-select
      // survives a refresh.
      const visibleIds = new Set(state.candidates.map((c) => c.propertyId));
      for (const id of Array.from(state.selected)) {
        if (!visibleIds.has(id)) state.selected.delete(id);
      }
      renderStats();
      renderList();
      renderActionBar();
    } catch (err) {
      candidateList.innerHTML = "";
      emptyState.hidden = false;
      emptyState.textContent = `Couldn't load candidates: ${err.message}`;
    } finally {
      loadingHint.hidden = true;
      candidateList.setAttribute("aria-busy", "false");
    }
  }

  async function loadTemplates() {
    try {
      const result = await api("GET", "/api/outreach/templates");
      if (result.spring) state.templates.spring = result.spring;
      if (result.fall) state.templates.fall = result.fall;
    } catch (_) {
      // Non-fatal — templates default to empty.
    }
  }

  async function loadAuditMissingNames() {
    try {
      const result = await api("GET", "/api/outreach/audit-missing-names");
      const count = Number(result.count || 0);
      if (count > 0) {
        missingNameCount.textContent = String(count);
        missingNameBanner.hidden = false;
        missingNameLink.dataset.properties = JSON.stringify(result.properties || []);
      } else {
        missingNameBanner.hidden = true;
      }
    } catch (_) {
      // Non-fatal.
    }
  }

  // ---- Rendering -----------------------------------------------------

  function renderStats() {
    $("#statEligible").textContent = state.totals.eligible;
    $("#statContacted").textContent = state.totals.contacted;
    $("#statBooked").textContent = state.totals.booked;
    $("#statAwaiting").textContent = state.totals.awaiting;
    $("#statOptedOut").textContent = state.totals.optedOut;
  }

  // Last-touch date label — "Texted Mar 15" / "Emailed Mar 15" / "—".
  // The brief's mock uses "Texted Mar 15" so match that style. Multi-
  // channel sends collapse to "Sent Mar 15".
  function lastTouchLabel(row) {
    if (!row.lastTouchTs) return "—";
    const ts = new Date(row.lastTouchTs);
    const dateStr = ts.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
    return `Last contact ${dateStr}`;
  }

  function statusBadge(row) {
    if (row.bookingState?.hasBooking) {
      return `<span class="outreach-badge outreach-badge-booked">Booked ${escapeHtml(row.bookingState.bookingId || "")}</span>`;
    }
    if (row.optedOutSeason) {
      return `<span class="outreach-badge outreach-badge-warn">Skip this season</span>`;
    }
    if (row.optedOutAll) {
      return `<span class="outreach-badge outreach-badge-warn">Opted out</span>`;
    }
    if (!row.commPrefs.seasonalRemindersSMS && !row.commPrefs.seasonalRemindersEmail) {
      return `<span class="outreach-badge outreach-badge-warn">Opted out</span>`;
    }
    if (row.missingName) {
      return `<span class="outreach-badge outreach-badge-warn">Missing name</span>`;
    }
    return `<span class="outreach-badge outreach-badge-pending">Not booked</span>`;
  }

  function rowDisabledReason(row) {
    if (row.bookingState?.hasBooking) return `Booked — ${row.bookingState.bookingId}`;
    if (row.missingName) return "Add a customer name on the property page before sending.";
    if (row.optedOutSeason) return "Skipped for this season.";
    if (row.optedOutAll || (!row.commPrefs.seasonalRemindersSMS && !row.commPrefs.seasonalRemindersEmail)) {
      return "Opted out of seasonal reminders.";
    }
    if (!row.portalToken) return "No portal token on file — needs at least one prior lead.";
    return null;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderList() {
    if (!state.candidates.length) {
      candidateList.innerHTML = "";
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;
    candidateList.innerHTML = state.candidates.map((row) => {
      const disabledReason = rowDisabledReason(row);
      const isSelected = state.selected.has(row.propertyId);
      const checkboxAttrs = [
        `data-property-id="${escapeHtml(row.propertyId)}"`,
        isSelected ? "checked" : "",
        disabledReason ? "disabled" : "",
        `aria-label="Select ${escapeHtml(row.customerName || row.streetAddress || row.propertyId)}"`
      ].filter(Boolean).join(" ");
      return `
        <li class="outreach-row${disabledReason ? " is-disabled" : ""}${isSelected ? " is-selected" : ""}"
            data-property-id="${escapeHtml(row.propertyId)}"
            ${disabledReason ? `title="${escapeHtml(disabledReason)}"` : ""}>
          <label class="outreach-row-check">
            <input type="checkbox" ${checkboxAttrs}>
          </label>
          <div class="outreach-row-main">
            <div class="outreach-row-name">
              <strong>${escapeHtml(row.customerName || "(no name)")}</strong>
              <span class="outreach-row-address">${escapeHtml(row.streetAddress || row.address || "(no address)")}</span>
            </div>
            <div class="outreach-row-meta">
              <span class="outreach-row-touch">${escapeHtml(lastTouchLabel(row))}</span>
              ${statusBadge(row)}
            </div>
          </div>
        </li>
      `;
    }).join("");

    // Wire the per-row checkboxes after the innerHTML rewrite.
    candidateList.querySelectorAll('input[type="checkbox"][data-property-id]').forEach((el) => {
      el.addEventListener("change", onRowToggle);
    });
    updateSelectAllState();
  }

  function renderActionBar() {
    const n = state.selected.size;
    if (n === 0) {
      actionBar.hidden = true;
      return;
    }
    actionBar.hidden = false;
    actionCount.textContent = `${n} selected`;
  }

  function updateSelectAllState() {
    const selectableRows = state.candidates.filter((r) => !rowDisabledReason(r));
    if (!selectableRows.length) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
      selectAllLabel.textContent = "Select all visible";
      return;
    }
    const selectedSelectable = selectableRows.filter((r) => state.selected.has(r.propertyId)).length;
    if (selectedSelectable === 0) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
    } else if (selectedSelectable === selectableRows.length) {
      selectAll.checked = true;
      selectAll.indeterminate = false;
    } else {
      selectAll.checked = false;
      selectAll.indeterminate = true;
    }
    selectAllLabel.textContent = `Select all visible (${selectableRows.length})`;
  }

  // ---- Selection -----------------------------------------------------

  function onRowToggle(event) {
    const id = event.target.dataset.propertyId;
    if (event.target.checked) state.selected.add(id);
    else state.selected.delete(id);
    const row = candidateList.querySelector(`.outreach-row[data-property-id="${CSS.escape(id)}"]`);
    if (row) row.classList.toggle("is-selected", event.target.checked);
    renderActionBar();
    updateSelectAllState();
  }

  selectAll.addEventListener("change", () => {
    const selectable = state.candidates.filter((r) => !rowDisabledReason(r));
    if (selectAll.checked) {
      for (const r of selectable) state.selected.add(r.propertyId);
    } else {
      for (const r of selectable) state.selected.delete(r.propertyId);
    }
    renderList();
    renderActionBar();
  });

  // ---- Filter dropdown -----------------------------------------------

  filterSelect.addEventListener("change", () => {
    const next = filterSelect.value;
    if (!next || next === state.filter) return;
    state.filter = next;
    loadCandidates();
  });

  // ---- Season + year change -----------------------------------------

  seasonSelect.addEventListener("change", () => {
    state.season = seasonSelect.value;
    state.selected.clear();
    loadCandidates();
  });

  yearSelect.addEventListener("change", () => {
    state.year = Number(yearSelect.value);
    state.selected.clear();
    loadCandidates();
  });

  // ---- Missing-name banner click ------------------------------------

  missingNameLink.addEventListener("click", (event) => {
    event.preventDefault();
    const properties = JSON.parse(missingNameLink.dataset.properties || "[]");
    if (!properties.length) return;
    // Surface as a toast listing the first few; the operator can
    // navigate to each property page from the regular Properties UI.
    const head = properties.slice(0, 5).map((p) => `${p.code || p.id} — ${p.address || "(no address)"}`).join("\n");
    const moreNote = properties.length > 5 ? `\n…and ${properties.length - 5} more.` : "";
    showToast(`${properties.length} properties missing a name`, `${head}${moreNote}`, { variant: "warn" });
  });

  // ---- Skip-this-season ---------------------------------------------

  skipSeasonBtn.addEventListener("click", async () => {
    const ids = Array.from(state.selected);
    if (!ids.length) return;
    if (!window.confirm(`Mark ${ids.length} ${ids.length === 1 ? "property" : "properties"} as "skip this season"? They won't appear in the Not-booked filter going forward.`)) return;
    let ok = 0;
    let failed = 0;
    for (const propertyId of ids) {
      try {
        await api("POST", "/api/outreach/opt-out-season", {
          propertyId, season: state.season, year: state.year, optOut: true
        });
        ok += 1;
      } catch (_) {
        failed += 1;
      }
    }
    state.selected.clear();
    await loadCandidates();
    showToast(
      "Marked as skip-this-season",
      `${ok} updated${failed ? ` · ${failed} failed` : ""}.`,
      { variant: failed ? "warn" : "info" }
    );
  });

  // ---- Compose modal -------------------------------------------------

  function openModal(modal) {
    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", ""); // Safari fallback
  }
  function closeModal(modal) {
    if (typeof modal.close === "function") modal.close();
    else modal.removeAttribute("open");
  }

  composeBtn.addEventListener("click", () => {
    if (state.selected.size === 0) return;
    const tpl = state.templates[state.season] || { subject: "", smsBody: "", emailBody: "" };
    composeSubject.value = tpl.subject || `Time to book your ${state.season === "spring" ? "Spring Opening" : "Fall Closing"}`;
    composeSmsBody.value = tpl.smsBody || "";
    composeEmailBody.value = tpl.emailBody || "";
    updateComposePreview();
    updateSkipSummary();
    composeSendCount.textContent = String(state.selected.size);
    openModal(composeModal);
  });

  composeCloseBtn.addEventListener("click", () => closeModal(composeModal));
  composeCancelBtn.addEventListener("click", () => closeModal(composeModal));

  // Tap outside the modal card → close. Native <dialog> handles ESC
  // for us already.
  composeModal.addEventListener("click", (event) => {
    if (event.target === composeModal) closeModal(composeModal);
  });

  composeForm.addEventListener("input", () => {
    updateComposePreview();
    updateSmsCharCount();
  });

  function updateSmsCharCount() {
    const len = composeSmsBody.value.length;
    smsCharCount.textContent = `${len} / 160`;
    smsCharCount.classList.toggle("is-over", len > 160);
  }

  function substituteTags(template, vars) {
    if (!template) return "";
    return String(template).replace(/\{\{\s*(firstName|propertyAddress|seasonName|portalLink)\s*\}\}/g, (_m, key) => {
      const value = vars[key];
      return value == null ? "" : String(value);
    });
  }

  function firstSelectedRow() {
    for (const row of state.candidates) {
      if (state.selected.has(row.propertyId)) return row;
    }
    return null;
  }

  function updateComposePreview() {
    const row = firstSelectedRow();
    if (!row) {
      previewRecipient.textContent = "—";
      previewSms.textContent = previewSubject.textContent = previewEmail.textContent = "—";
      return;
    }
    const seasonName = state.season === "spring" ? "Spring Opening" : "Fall Closing";
    const portalLink = row.portalToken
      ? `${window.location.origin}/portal/${row.portalToken}?season=${state.season}`
      : "(no portal token)";
    const vars = {
      firstName: row.firstName || "there",
      propertyAddress: row.streetAddress || row.address || "",
      seasonName,
      portalLink
    };
    previewRecipient.textContent = `${row.customerName} — ${row.streetAddress || row.address || ""}`;
    previewSms.textContent = substituteTags(composeSmsBody.value, vars) || "—";
    previewSubject.textContent = substituteTags(composeSubject.value, vars) || "—";
    previewEmail.textContent = substituteTags(composeEmailBody.value, vars) || "—";
  }

  // Pre-flight per-recipient skip summary. Reuses the same rules as
  // the server's sendBulk so the operator sees the same outcome
  // before they fire the batch.
  function updateSkipSummary() {
    const channels = selectedChannels();
    if (!channels.length) {
      skipSummary.hidden = true;
      return;
    }
    const wantSms = channels.includes("sms");
    const wantEmail = channels.includes("email");
    const reasons = {
      missing_name: 0,
      season_opt_out: 0,
      no_portal_token: 0,
      no_phone: 0,
      no_email: 0,
      opted_out_sms: 0,
      opted_out_email: 0,
      no_contact: 0
    };
    let willSend = 0;
    for (const id of state.selected) {
      const row = state.candidates.find((r) => r.propertyId === id);
      if (!row) continue;
      if (row.missingName) { reasons.missing_name += 1; continue; }
      if (row.optedOutSeason) { reasons.season_opt_out += 1; continue; }
      if (!row.portalToken) { reasons.no_portal_token += 1; continue; }
      const smsOk = wantSms && row.phone && row.commPrefs.seasonalRemindersSMS;
      const emailOk = wantEmail && row.email && row.commPrefs.seasonalRemindersEmail;
      if (!smsOk && !emailOk) {
        // Pick the most specific reason for the headline. The
        // server reports the same way.
        if (wantSms && !row.phone) reasons.no_phone += 1;
        else if (wantEmail && !row.email) reasons.no_email += 1;
        else if (wantSms && !row.commPrefs.seasonalRemindersSMS) reasons.opted_out_sms += 1;
        else if (wantEmail && !row.commPrefs.seasonalRemindersEmail) reasons.opted_out_email += 1;
        else reasons.no_contact += 1;
        continue;
      }
      willSend += 1;
    }
    const labels = {
      missing_name: "missing name",
      season_opt_out: "marked skip-this-season",
      no_portal_token: "no portal token",
      no_phone: "no phone on file",
      no_email: "no email on file",
      opted_out_sms: "opted out of SMS",
      opted_out_email: "opted out of email",
      no_contact: "no contact channel"
    };
    const items = Object.entries(reasons)
      .filter(([_, n]) => n > 0)
      .map(([key, n]) => `<li>${n} — ${labels[key]}</li>`);
    if (!items.length) {
      skipSummary.hidden = true;
    } else {
      skipSummaryList.innerHTML = items.join("");
      skipSummary.hidden = false;
    }
    composeSendCount.textContent = String(willSend);
  }

  // Re-render the skip summary whenever a channel checkbox flips —
  // the form-level `input` listener catches text fields but
  // checkbox state changes flow through `change` too. Hook both.
  composeForm.addEventListener("change", () => {
    updateSkipSummary();
    updateComposePreview();
  });

  composeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.sending) return;
    const channels = selectedChannels();
    if (!channels.length) {
      showToast("Pick a channel", "Select at least one of SMS or Email.", { variant: "warn" });
      return;
    }
    const ids = Array.from(state.selected);
    if (!ids.length) return;

    state.sending = true;
    composeSendBtn.disabled = true;
    composeSendBtn.classList.add("is-loading");
    try {
      const result = await api("POST", "/api/outreach/send", {
        propertyIds: ids,
        season: state.season,
        year: state.year,
        channels,
        subject: composeSubject.value,
        smsBody: composeSmsBody.value,
        emailBody: composeEmailBody.value
      });
      closeModal(composeModal);
      state.selected.clear();
      const sent = result.sent || 0;
      const skipped = Array.isArray(result.skipped) ? result.skipped.length : 0;
      const errors = Array.isArray(result.errors) ? result.errors.length : 0;
      showToast(
        sent ? "Outreach batch sent." : "No messages went out.",
        `${sent} sent · ${skipped} skipped · ${errors} errors · batch ${result.batchId || ""}`,
        { variant: errors ? "warn" : "info" }
      );
      await loadCandidates();
    } catch (err) {
      if (err.status === 429) {
        showToast("Another send is in progress", "Wait a moment and try again.", { variant: "warn" });
      } else {
        showToast("Send failed", err.message || "Unknown error.", { variant: "warn" });
      }
    } finally {
      state.sending = false;
      composeSendBtn.disabled = false;
      composeSendBtn.classList.remove("is-loading");
    }
  });

  // ---- Template modal -----------------------------------------------

  editTemplateBtn.addEventListener("click", () => {
    const tpl = state.templates[state.season] || { subject: "", smsBody: "", emailBody: "" };
    templateSeasonLabel.textContent = state.season === "spring" ? "Spring" : "Fall";
    templateSubject.value = tpl.subject || "";
    templateSmsBody.value = tpl.smsBody || "";
    templateEmailBody.value = tpl.emailBody || "";
    openModal(templateModal);
  });

  templateCloseBtn.addEventListener("click", () => closeModal(templateModal));
  templateCancelBtn.addEventListener("click", () => closeModal(templateModal));
  templateModal.addEventListener("click", (event) => {
    if (event.target === templateModal) closeModal(templateModal);
  });

  templateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("PATCH", "/api/outreach/templates", {
        season: state.season,
        subject: templateSubject.value,
        smsBody: templateSmsBody.value,
        emailBody: templateEmailBody.value
      });
      if (result.templates) state.templates = result.templates;
      closeModal(templateModal);
      showToast("Template saved", `${state.season === "spring" ? "Spring" : "Fall"} template updated.`);
    } catch (err) {
      showToast("Save failed", err.message || "Unknown error.", { variant: "warn" });
    }
  });

  // ---- Mobile nav toggle (shared sidebar UX) ------------------------

  const navToggle = document.getElementById("navToggle");
  const navMenu = document.getElementById("navMenu");
  if (navToggle && navMenu) {
    navToggle.addEventListener("click", () => {
      const open = navMenu.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
  }

  // Logout — shared button identical to other admin pages.
  const logoutButton = document.getElementById("logoutButton");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      try {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      } catch (_) { /* best effort */ }
      window.location.href = "/login";
    });
  }

  // ---- Boot ----------------------------------------------------------

  function boot() {
    populateYearSelect();
    seasonSelect.value = state.season;
    filterSelect.value = state.filter;
    Promise.allSettled([
      loadCandidates(),
      loadTemplates(),
      loadAuditMissingNames()
    ]);
    updateSmsCharCount();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
