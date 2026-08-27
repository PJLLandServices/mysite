// /admin/customer/:id — full customer profile with editable summary and
// tabbed views of linked properties, bookings, WOs, quotes, invoices,
// communication records, and history.
//
// Data source: GET /api/customer/:id returns the customer record
// decorated with arrays of linked entities. PATCH /api/customer/:id
// updates editable fields. POST /api/customer/:id/communication
// appends a manual communication record.

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

const idMatch = location.pathname.match(/^\/admin\/customer\/([^/]+)/);
const customerId = idMatch ? decodeURIComponent(idMatch[1]) : null;

const titleEl = document.getElementById("customerTitle");
const profileEl = document.getElementById("customerProfile");
const loadErrorEl = document.getElementById("loadError");
const summaryNameEl = document.getElementById("summaryName");
const summaryIdEl = document.getElementById("summaryId");
const summaryStatusEl = document.getElementById("summaryStatus");
const summarySourceEl = document.getElementById("summarySource");
const summarySinceEl = document.getElementById("summarySince");
const summaryQbEl = document.getElementById("summaryQb");
const saveBtn = document.getElementById("saveBtn");
const revertBtn = document.getElementById("revertBtn");
const saveErrorEl = document.getElementById("saveError");
const logoutButton = document.getElementById("logoutButton");

const editableFields = Array.from(document.querySelectorAll("[data-field]"));
const tabHeaders = Array.from(document.querySelectorAll(".customer-tab-header"));
const tabPanels = Array.from(document.querySelectorAll(".customer-tab-panel"));

let original = null;
let pendingPatch = {};

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-CA", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function applyToForm(customer) {
  original = customer;
  pendingPatch = {};

  titleEl.textContent = customer.name || customer.id;
  summaryNameEl.textContent = customer.name || "(unnamed)";
  summaryIdEl.textContent = customer.id;
  summaryStatusEl.textContent = customer.status || "lead";
  summaryStatusEl.className = `customer-status is-${customer.status || "lead"}`;
  summarySourceEl.textContent = customer.source || "—";
  summarySinceEl.textContent = formatDate(customer.customerSince);
  summaryQbEl.textContent = customer.quickbooksId || "(not linked)";

  for (const el of editableFields) {
    const field = el.dataset.field;
    const value = customer[field];
    if (el.dataset.fieldType === "boolean") {
      // Checkboxes: read the boolean. Defaults to false for missing /
      // legacy records.
      el.checked = value === true;
    } else if (el.tagName === "SELECT") {
      el.value = value || "lead";
    } else if (el.tagName === "TEXTAREA") {
      el.value = value || "";
    } else {
      el.value = value || "";
    }
  }

  saveBtn.disabled = true;
  revertBtn.disabled = true;
  saveErrorEl.hidden = true;
}

// Commercial account panel (management-company model). Lists who can approve
// quotes for this customer, and the managed sites with their own billing
// entity so the entity/c/o split is visible in one place. Hidden entirely on
// residential accounts, so their page is unchanged.
const COMMERCIAL_ROLE_LABELS = {
  site_contact: "Site contact",
  property_manager: "Property manager",
  accounts_payable: "Accounts payable",
  owner_board: "Owner / board member",
  other: "Other"
};

// (uses the file's existing esc() helper — it also escapes single quotes)

// One editable contact row. Everything here is editable in place; changes
// flow into pendingPatch via commercialChanged() so the normal Save changes /
// Revert buttons handle them like any other field.
function contactRowHtml(c) {
  const opts = Object.entries(COMMERCIAL_ROLE_LABELS)
    .map(([v, l]) => `<option value="${v}"${(c.role || "") === v ? " selected" : ""}>${l}</option>`).join("");
  // data-cid carries the contact's con_ id back to the server on save. A row
  // without one (the "+ Add contact" button) is a new contact and the server
  // mints an id for it. Dropping this attribute would re-mint every id on
  // every save and break anything referencing a contact.
  return `
  <div class="cc-row" data-cid="${esc(c.id || "")}" style="padding:10px;margin:0 0 10px;background:#fff;border:1px solid #dfe7df;border-radius:6px;">
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <label style="flex:2 1 160px;text-transform:none;font-weight:400;">
        <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6A6A60;">Name</span>
        <input type="text" class="cc-name" maxlength="200" value="${esc(c.name)}" style="width:100%;"></label>
      <label style="flex:1 1 140px;text-transform:none;font-weight:400;">
        <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6A6A60;">Role</span>
        <select class="cc-role" style="width:100%;"><option value="">Select…</option>${opts}</select></label>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
      <label style="flex:2 1 180px;text-transform:none;font-weight:400;">
        <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6A6A60;">Email</span>
        <input type="email" class="cc-email" maxlength="254" value="${esc(c.email)}" style="width:100%;"></label>
      <label style="flex:1 1 130px;text-transform:none;font-weight:400;">
        <span style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6A6A60;">Phone</span>
        <input type="tel" class="cc-phone" maxlength="40" value="${esc(c.phone)}" style="width:100%;"></label>
    </div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;align-items:center;">
      <label style="display:flex;flex-direction:row;align-items:center;gap:6px;text-transform:none;font-weight:400;cursor:pointer;">
        <input type="checkbox" class="cc-sig" style="width:16px;min-width:16px;flex:0 0 16px;height:16px;margin:0;"${c.isAuthorizedSignatory ? " checked" : ""}>
        <span style="text-transform:none;">✍️ Signs quotes</span></label>
      <label style="display:flex;flex-direction:row;align-items:center;gap:6px;text-transform:none;font-weight:400;cursor:pointer;">
        <input type="checkbox" class="cc-site" style="width:16px;min-width:16px;flex:0 0 16px;height:16px;margin:0;"${c.isSiteContact ? " checked" : ""}>
        <span style="text-transform:none;">📍 On-site contact</span></label>
      <button type="button" class="pjl-btn pjl-btn-outline cc-remove" style="padding:5px 10px;font-size:12px;margin-left:auto;">Remove</button>
    </div>
  </div>`;
}

// Read the editor back into the { poRequired, paymentTerms, careOf, contacts }
// shape the server normalizes. Empty rows are dropped by the lib.
function collectCommercial() {
  const list = document.getElementById("customerContactsList");
  const contacts = list ? Array.from(list.querySelectorAll(".cc-row")).map((row) => ({
    id: row.getAttribute("data-cid") || "",
    name: row.querySelector(".cc-name")?.value.trim() || "",
    role: row.querySelector(".cc-role")?.value || "",
    email: row.querySelector(".cc-email")?.value.trim() || "",
    phone: row.querySelector(".cc-phone")?.value.trim() || "",
    isSiteContact: !!row.querySelector(".cc-site")?.checked,
    isAuthorizedSignatory: !!row.querySelector(".cc-sig")?.checked
  })).filter((c) => c.name || c.email || c.phone) : [];
  const prior = (original && original.commercial) || {};
  return {
    careOf: document.getElementById("customerCareOf")?.value.trim() || "",
    poRequired: prior.poRequired === true,
    paymentTerms: prior.paymentTerms || "",
    contacts
  };
}

// Stage the panel's state into pendingPatch and enable Save/Revert. Called on
// every edit in the panel.
function commercialChanged() {
  if (!original) return;
  const isCommercial = !!document.getElementById("customerIsCommercial")?.checked;
  const fields = document.getElementById("customerCommercialFields");
  const badge = document.getElementById("customerCommercialBadge");
  if (fields) fields.hidden = !isCommercial;
  if (badge) badge.hidden = !isCommercial;

  pendingPatch.accountType = isCommercial ? "commercial" : "residential";
  pendingPatch.commercial = isCommercial ? collectCommercial() : null;

  // Drop the keys again when nothing actually differs from the loaded record,
  // so an untouched page doesn't look dirty.
  const sameType = (original.accountType || "residential") === pendingPatch.accountType;
  const sameBlock = JSON.stringify(original.commercial || null) === JSON.stringify(pendingPatch.commercial);
  if (sameType) delete pendingPatch.accountType;
  if (sameBlock) delete pendingPatch.commercial;

  const hasChanges = Object.keys(pendingPatch).length > 0;
  saveBtn.disabled = !hasChanges;
  revertBtn.disabled = !hasChanges;
  renderSignatoryHint();
}

// Inline guidance: who will be filled in as the acceptor when a quote is sent.
function renderSignatoryHint() {
  const empty = document.getElementById("customerContactsEmpty");
  const list = document.getElementById("customerContactsList");
  if (!list) return;
  const rows = list.querySelectorAll(".cc-row");
  if (empty) empty.hidden = rows.length > 0;
  const sigs = Array.from(rows)
    .filter((r) => r.querySelector(".cc-sig")?.checked)
    .map((r) => r.querySelector(".cc-name")?.value.trim())
    .filter(Boolean);
  let hint = document.getElementById("customerSigHint");
  if (!hint) {
    hint = document.createElement("p");
    hint.id = "customerSigHint";
    hint.style.cssText = "margin:6px 0 0;font-size:12px;";
    list.parentElement.insertBefore(hint, list.nextSibling);
  }
  if (sigs.length === 1) {
    hint.style.color = "#2c5c3a";
    hint.textContent = `Quotes will be addressed to ${sigs[0]} for approval.`;
  } else if (sigs.length > 1) {
    hint.style.color = "#8a5a00";
    hint.textContent = `${sigs.length} signatories — you'll be asked to pick one when sending a quote.`;
  } else if (rows.length) {
    hint.style.color = "#8a5a00";
    hint.textContent = "No one is marked “Signs quotes” — quotes will fall back to the company name.";
  } else {
    hint.textContent = "";
  }
}

function wireContactRow(row) {
  row.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener(el.type === "checkbox" ? "change" : "input", commercialChanged);
  });
  row.querySelector(".cc-remove")?.addEventListener("click", () => {
    row.remove();
    commercialChanged();
  });
}

// Managed sites are owned by the PROPERTY (each site's own legal payer), so
// they're shown here as read-only links through to the property page where
// they're edited — not duplicated into this form.
function renderManagedSites(customer) {
  const el = document.getElementById("customerManagedSites");
  if (!el) return;
  const props = Array.isArray(customer.properties) ? customer.properties : [];
  const managed = props.filter((p) => String(p.billingEntity || "").trim());
  if (!managed.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<h4 style="margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#3d4b3f;">Managed sites — billed c/o this customer</h4>`
    + managed.map((p) => `<div style="margin:0 0 8px;font-size:13px;">
        <strong>${esc(p.billingEntity)}</strong><br>
        <a href="/admin/property/${encodeURIComponent(p.id)}" style="color:#1B4D2E;">${esc(p.address || "(no address)")}</a>
        ${(Array.isArray(p.siteContacts) && p.siteContacts.length)
          ? `<br><span style="color:#4a5a4c;">📍 ${p.siteContacts.map((s) => esc(s.name)).filter(Boolean).join(", ")}</span>` : ""}
      </div>`).join("")
    + `<p style="margin:2px 0 0;font-size:12px;color:#6A6A60;">Billing entity and site contacts are edited on each property page.</p>`;
}

function renderCommercialPanel(customer) {
  const toggle = document.getElementById("customerIsCommercial");
  const fields = document.getElementById("customerCommercialFields");
  const badge = document.getElementById("customerCommercialBadge");
  const list = document.getElementById("customerContactsList");
  const careOf = document.getElementById("customerCareOf");
  if (!toggle || !fields || !list) return;

  const isCommercial = customer.accountType === "commercial";
  toggle.checked = isCommercial;
  fields.hidden = !isCommercial;
  if (badge) badge.hidden = !isCommercial;
  if (careOf) careOf.value = (customer.commercial && customer.commercial.careOf) || "";

  const contacts = (customer.commercial && Array.isArray(customer.commercial.contacts))
    ? customer.commercial.contacts : [];
  list.innerHTML = contacts.map(contactRowHtml).join("");
  list.querySelectorAll(".cc-row").forEach(wireContactRow);
  renderManagedSites(customer);
  renderSignatoryHint();
}

document.getElementById("customerIsCommercial")?.addEventListener("change", commercialChanged);
document.getElementById("customerCareOf")?.addEventListener("input", commercialChanged);
document.getElementById("customerAddContact")?.addEventListener("click", () => {
  const list = document.getElementById("customerContactsList");
  if (!list) return;
  list.insertAdjacentHTML("beforeend", contactRowHtml({ name: "", role: "", email: "", phone: "", isSiteContact: false, isAuthorizedSignatory: false }));
  const row = list.lastElementChild;
  wireContactRow(row);
  row.querySelector(".cc-name")?.focus();
  commercialChanged();
});

function applyLinked(customer) {
  renderCommercialPanel(customer);
  renderProperties(customer.properties || []);
  renderBookings(customer.bookings || []);
  renderWorkOrders(customer.workOrders || []);
  renderQuotes(customer.quotes || []);
  renderInvoices(customer.invoices || []);
  renderCommunications(customer.communicationRecords || []);
  renderDownloads(customer.vcfDownloads || []);
  renderHistory(customer.history || []);

  document.getElementById("countProperties").textContent = (customer.properties || []).length;
  document.getElementById("countBookings").textContent = (customer.bookings || []).length;
  document.getElementById("countWorkOrders").textContent = (customer.workOrders || []).length;
  document.getElementById("countQuotes").textContent = (customer.quotes || []).length;
  document.getElementById("countInvoices").textContent = (customer.invoices || []).length;
  document.getElementById("countCommunications").textContent = (customer.communicationRecords || []).length;
  document.getElementById("countDownloads").textContent = (customer.vcfDownloads || []).length;
  document.getElementById("countHistory").textContent = (customer.history || []).length;
}

function renderProperties(properties) {
  const el = document.getElementById("panelProperties");
  if (!properties.length) {
    el.innerHTML = `<p class="customer-tab-empty">No properties linked.</p>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>Code</th><th>Address</th><th style="text-align:right">Bookings</th></tr></thead>
      <tbody>
        ${properties.map((p) => `
          <tr>
            <td><a href="/admin/property/${esc(p.id)}"><strong>${esc(p.code || p.id)}</strong></a></td>
            <td>${p.address ? `<span data-map-address="${esc(p.address)}">${esc(p.address)}</span>` : ""}</td>
            <td style="text-align:right">${(p.leadIds || []).length}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderBookings(bookings) {
  const el = document.getElementById("panelBookings");
  if (!bookings.length) {
    el.innerHTML = `<p class="customer-tab-empty">No bookings.</p>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>ID</th><th>Service</th><th>Scheduled</th><th>Status</th></tr></thead>
      <tbody>
        ${bookings.map((b) => `
          <tr>
            <td><strong>${esc(b.id)}</strong></td>
            <td>${esc(b.serviceLabel || b.serviceKey)}</td>
            <td>${formatDateTime(b.scheduledFor)}</td>
            <td>${esc(b.status)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderWorkOrders(workOrders) {
  const el = document.getElementById("panelWorkOrders");
  if (!workOrders.length) {
    el.innerHTML = `<p class="customer-tab-empty">No work orders.</p>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>ID</th><th>Type</th><th>Status</th><th>Address</th><th>Scheduled</th></tr></thead>
      <tbody>
        ${workOrders.map((w) => `
          <tr>
            <td><a href="/admin/work-order/${esc(w.id)}"><strong>${esc(w.id)}</strong></a></td>
            <td>${esc(w.type)}</td>
            <td>${esc(w.status)}${w.locked ? " (locked)" : ""}</td>
            <td>${w.address ? `<span data-map-address="${esc(w.address)}">${esc(w.address)}</span>` : ""}</td>
            <td>${formatDateTime(w.scheduledFor)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderQuotes(quotes) {
  const el = document.getElementById("panelQuotes");
  if (!quotes.length) {
    el.innerHTML = `<p class="customer-tab-empty">No quotes.</p>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>ID</th><th>Status</th><th>Total</th><th>Created</th></tr></thead>
      <tbody>
        ${quotes.map((q) => `
          <tr>
            <td><strong>${esc(q.id)}</strong></td>
            <td>${esc(q.status)}</td>
            <td>${esc(Number(q.total || 0).toLocaleString("en-CA", { style: "currency", currency: "CAD" }))}</td>
            <td>${formatDate(q.createdAt)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderInvoices(invoices) {
  const el = document.getElementById("panelInvoices");
  if (!invoices.length) {
    el.innerHTML = `<p class="customer-tab-empty">No invoices.</p>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead><tr><th>ID</th><th>Status</th><th>Total</th><th>Created</th></tr></thead>
      <tbody>
        ${invoices.map((i) => `
          <tr>
            <td><a href="/admin/invoice/${esc(i.id)}"><strong>${esc(i.id)}</strong></a></td>
            <td>${esc(i.status)}</td>
            <td>${esc(Number(i.total || 0).toLocaleString("en-CA", { style: "currency", currency: "CAD" }))}</td>
            <td>${formatDate(i.createdAt)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderCommunications(records) {
  const el = document.getElementById("panelCommunications");
  if (!records.length) {
    el.innerHTML = `<p class="customer-tab-empty">No communication records yet.</p>`;
    return;
  }
  // Newest first
  const ordered = [...records].sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  el.innerHTML = ordered.map((r) => `
    <div class="customer-comm-row">
      <div class="customer-comm-ts">${formatDateTime(r.ts)}</div>
      <div class="customer-comm-body">
        <span class="customer-comm-source">${esc(r.source || "—")}</span>
        <div><strong>${esc(r.summary || "")}</strong></div>
        ${r.notes ? `<div style="margin-top: 4px; white-space: pre-wrap;">${esc(r.notes)}</div>` : ""}
      </div>
    </div>
  `).join("");
}

function renderHistory(history) {
  const el = document.getElementById("panelHistory");
  if (!history.length) {
    el.innerHTML = `<p class="customer-tab-empty">No history yet.</p>`;
    return;
  }
  const ordered = [...history].sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  el.innerHTML = ordered.map((h) => `
    <div class="customer-history-row">
      <span class="ts">${formatDateTime(h.ts)}</span>
      <span class="action">${esc(h.action)}</span>
      <span class="by">by ${esc(h.by || "system")}</span>
      ${h.note ? `<span>· ${esc(h.note)}</span>` : ""}
    </div>
  `).join("");
}

// vCard download history — every individual / bulk export of this
// customer's contact card. Useful for spotting accidental double-imports
// and for confirming "did Patrick already have this contact on his
// phone?" without guessing.
function renderDownloads(downloads) {
  const el = document.getElementById("panelDownloads");
  if (!downloads.length) {
    el.innerHTML = `<p class="customer-tab-empty">No vCard downloads yet. Tap "⬇ Download vCard" in the summary to import this customer into iPhone Contacts.</p>`;
    return;
  }
  const ordered = [...downloads].sort((a, b) => (b.downloadedAt || "").localeCompare(a.downloadedAt || ""));
  el.innerHTML = ordered.map((d) => `
    <div class="customer-vcf-row">
      <span class="ts">${formatDateTime(d.downloadedAt)}</span>
      <span><span class="method is-${esc(d.method || "individual")}">${esc(d.method || "individual")}</span></span>
      <span class="batch">${d.batchId ? esc(d.batchId) : ""}</span>
    </div>
  `).join("");
}

// ---- Tabs ---------------------------------------------------------

tabHeaders.forEach((header) => {
  header.addEventListener("click", () => {
    const target = header.dataset.tab;
    tabHeaders.forEach((h) => h.classList.toggle("is-active", h === header));
    tabPanels.forEach((p) => { p.hidden = p.dataset.tab !== target; });
  });
});

// ---- Editable fields ----------------------------------------------

editableFields.forEach((el) => {
  const isBoolean = el.dataset.fieldType === "boolean";
  // Booleans (checkboxes) fire "change", not "input". Listen for both
  // so the same handler covers strings AND checkboxes.
  const evt = isBoolean ? "change" : "input";
  el.addEventListener(evt, () => {
    if (!original) return;
    const field = el.dataset.field;
    const newValue = isBoolean ? el.checked : el.value;
    const oldValueRaw = original[field];
    const oldValue = isBoolean
      ? (oldValueRaw === true)
      : (oldValueRaw == null ? "" : oldValueRaw);
    if (newValue === oldValue) {
      delete pendingPatch[field];
    } else {
      pendingPatch[field] = newValue;
    }
    const hasChanges = Object.keys(pendingPatch).length > 0;
    saveBtn.disabled = !hasChanges;
    revertBtn.disabled = !hasChanges;
  });
});

revertBtn.addEventListener("click", () => {
  if (original) applyToForm(original);
});

saveBtn.addEventListener("click", async () => {
  saveErrorEl.hidden = true;
  saveBtn.disabled = true;
  try {
    const res = await fetch(`/api/customer/${encodeURIComponent(customerId)}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pendingPatch)
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      saveErrorEl.textContent = body?.errors?.[0] || body?.error || "Couldn't save.";
      saveErrorEl.hidden = false;
      saveBtn.disabled = false;
      return;
    }
    await load();
  } catch (err) {
    saveErrorEl.textContent = err?.message || "Network error.";
    saveErrorEl.hidden = false;
    saveBtn.disabled = false;
  }
});

// ---- Communications add ------------------------------------------

document.getElementById("commAdd").addEventListener("click", async () => {
  const source = document.getElementById("commSource").value;
  const summary = document.getElementById("commSummary").value.trim();
  const notes = document.getElementById("commNotes").value.trim();
  if (!summary) {
    alert("Add a short summary of the communication.");
    return;
  }
  try {
    const res = await fetch(`/api/customer/${encodeURIComponent(customerId)}/communication`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, summary, notes })
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      alert(body?.error || "Couldn't save the record.");
      return;
    }
    document.getElementById("commSummary").value = "";
    document.getElementById("commNotes").value = "";
    await load();
  } catch (err) {
    alert(err?.message || "Network error.");
  }
});

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    try { await fetch("/api/logout", { method: "POST" }); } catch {}
    location.href = "/login";
  });
}

// ---- vCard download ----------------------------------------------
//
// Fetch-and-blob path (not a plain <a download>) so the page can stay
// loaded and reload the customer afterward to surface the new entry in
// the Downloads tab without a manual refresh. Server side handles the
// audit-log append on the GET endpoint, so a single round-trip covers
// both download and recording.
const downloadVcardBtn = document.getElementById("downloadVcardBtn");
downloadVcardBtn?.addEventListener("click", async () => {
  if (!customerId) return;
  const originalText = downloadVcardBtn.textContent;
  downloadVcardBtn.disabled = true;
  downloadVcardBtn.textContent = "Preparing…";
  try {
    const res = await fetch(`/api/customer/${encodeURIComponent(customerId)}/vcard`, {
      credentials: "same-origin"
    });
    if (!res.ok) {
      let msg = `Download failed (HTTP ${res.status}).`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch {}
      alert(msg);
      return;
    }
    const cd = res.headers.get("Content-Disposition") || "";
    const fnMatch = cd.match(/filename="([^"]+)"/);
    const filename = fnMatch ? fnMatch[1] : `${customerId}.vcf`;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    // Refresh so the new vcfDownloads[] entry appears in the tab.
    await load();
  } catch (err) {
    alert(err?.message || "Network error.");
  } finally {
    downloadVcardBtn.disabled = false;
    downloadVcardBtn.textContent = originalText;
  }
});

// ---- Add property modal ------------------------------------------

const addPropertyBtn = document.getElementById("addPropertyBtn");
const newPropertyModal = document.getElementById("newPropertyModal");
const newPropertyForm = document.getElementById("newPropertyForm");
const newPropertyCancel = document.getElementById("newPropertyCancel");
const newPropertyError = document.getElementById("newPropertyError");

function openPropertyModal() {
  newPropertyForm.reset();
  newPropertyError.hidden = true;
  newPropertyModal.hidden = false;
  setTimeout(() => newPropertyForm.querySelector("input[name=address]")?.focus(), 0);
}

function closePropertyModal() { newPropertyModal.hidden = true; }

if (addPropertyBtn) {
  addPropertyBtn.addEventListener("click", openPropertyModal);
}
newPropertyCancel.addEventListener("click", closePropertyModal);
newPropertyModal.addEventListener("click", (e) => {
  if (e.target === newPropertyModal) closePropertyModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !newPropertyModal.hidden) closePropertyModal();
});

newPropertyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  newPropertyError.hidden = true;
  const formData = new FormData(newPropertyForm);
  const address = (formData.get("address") || "").toString().trim();
  if (!address) {
    newPropertyError.textContent = "Address is required.";
    newPropertyError.hidden = false;
    return;
  }
  try {
    const res = await fetch("/api/properties", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, address })
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      newPropertyError.textContent = body?.errors?.[0] || body?.error || "Couldn't create property.";
      newPropertyError.hidden = false;
      return;
    }
    closePropertyModal();
    await load();
    // Land the user on the Properties tab to show the freshly added record.
    tabHeaders.forEach((h) => h.classList.toggle("is-active", h.dataset.tab === "properties"));
    tabPanels.forEach((p) => { p.hidden = p.dataset.tab !== "properties"; });
  } catch (err) {
    newPropertyError.textContent = err?.message || "Network error.";
    newPropertyError.hidden = false;
  }
});

// ---- Merge modal --------------------------------------------------

const mergeBtn = document.getElementById("mergeBtn");
const mergeModal = document.getElementById("mergeModal");
const mergePrimaryName = document.getElementById("mergePrimaryName");
const mergeSearch = document.getElementById("mergeSearch");
const mergeResults = document.getElementById("mergeResults");
const mergeSelected = document.getElementById("mergeSelected");
const mergeSelectedLabel = document.getElementById("mergeSelectedLabel");
const mergeSelectedTarget = document.getElementById("mergeSelectedTarget");
const mergeSelectedClear = document.getElementById("mergeSelectedClear");
const mergeError = document.getElementById("mergeError");
const mergeCancel = document.getElementById("mergeCancel");
const mergeConfirm = document.getElementById("mergeConfirm");

let mergeAllCustomers = null;
let mergeChosen = null;

function escMerge(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function mergeSetChosen(c) {
  mergeChosen = c;
  if (c) {
    mergeSelectedLabel.textContent = `${c.name || "(unnamed)"} (${c.id})`;
    mergeSelected.hidden = false;
  } else {
    mergeSelected.hidden = true;
  }
  mergeConfirm.disabled = !c;
}

function mergeRenderResults(query) {
  const q = (query || "").trim().toLowerCase();
  const qDigits = q.replace(/\D/g, "");
  if (!q || !mergeAllCustomers) {
    mergeResults.innerHTML = "";
    mergeResults.style.display = "none";
    return;
  }
  const matches = mergeAllCustomers.filter((c) => {
    if (c.id === customerId) return false; // can't merge into self
    if (mergeChosen && c.id === mergeChosen.id) return false;
    const hay = [c.name, c.spouseName, c.email, c.spouseEmail].filter(Boolean).join(" ").toLowerCase();
    if (hay.includes(q)) return true;
    const pd = String(c.phone || "").replace(/\D/g, "");
    if (qDigits && pd.includes(qDigits)) return true;
    return false;
  }).slice(0, 8);

  if (!matches.length) {
    mergeResults.innerHTML = `<div style="padding: 10px; color: #888; font-size: 12px;">No customers match.</div>`;
    mergeResults.style.display = "block";
    return;
  }
  mergeResults.innerHTML = matches.map((c) => `
    <div class="merge-result" data-id="${escMerge(c.id)}" style="padding: 8px 12px; border-bottom: 1px solid #f0eee8; cursor: pointer;">
      <strong>${escMerge(c.name) || "(unnamed)"}</strong>
      <span style="color: #666; font-size: 12px; margin-left: 8px;">${escMerge(c.email) || c.phone || c.id}</span>
      <div style="color: #888; font-size: 11px;">${escMerge(c.id)} · ${c.propertyCount || 0} ${(c.propertyCount === 1 ? "property" : "properties")}</div>
    </div>
  `).join("");
  mergeResults.style.display = "block";

  mergeResults.querySelectorAll(".merge-result").forEach((row) => {
    row.addEventListener("click", () => {
      const id = row.dataset.id;
      const c = mergeAllCustomers.find((x) => x.id === id);
      if (!c) return;
      mergeSetChosen(c);
      mergeSearch.value = "";
      mergeResults.innerHTML = "";
      mergeResults.style.display = "none";
    });
  });
}

async function openMergeModal() {
  if (!original) return;
  mergeError.hidden = true;
  mergeSearch.value = "";
  mergeSetChosen(null);
  mergePrimaryName.textContent = original.name || original.id;
  mergeSelectedTarget.textContent = original.name || original.id;
  mergeResults.innerHTML = "";
  mergeResults.style.display = "none";
  mergeModal.hidden = false;
  setTimeout(() => mergeSearch.focus(), 0);
  if (!mergeAllCustomers) {
    try {
      const res = await fetch("/api/customers", { credentials: "same-origin" });
      const body = await res.json();
      mergeAllCustomers = Array.isArray(body.customers) ? body.customers : [];
    } catch (err) {
      mergeAllCustomers = [];
    }
  }
}

function closeMergeModal() { mergeModal.hidden = true; }

if (mergeBtn) mergeBtn.addEventListener("click", openMergeModal);
mergeCancel.addEventListener("click", closeMergeModal);
mergeModal.addEventListener("click", (e) => { if (e.target === mergeModal) closeMergeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !mergeModal.hidden) closeMergeModal(); });
mergeSearch.addEventListener("input", () => mergeRenderResults(mergeSearch.value));
mergeSelectedClear.addEventListener("click", () => mergeSetChosen(null));

mergeConfirm.addEventListener("click", async () => {
  if (!mergeChosen) return;
  mergeError.hidden = true;
  mergeConfirm.disabled = true;
  try {
    const res = await fetch(`/api/customer/${encodeURIComponent(customerId)}/merge`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secondaryId: mergeChosen.id, note: "Merged via /admin/customer page" })
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      mergeError.textContent = body?.errors?.[0] || "Merge failed.";
      mergeError.hidden = false;
      mergeConfirm.disabled = false;
      return;
    }
    closeMergeModal();
    // Refresh the page so the customer's now-larger set of properties /
    // bookings / etc. shows up.
    location.reload();
  } catch (err) {
    mergeError.textContent = err.message || "Network error.";
    mergeError.hidden = false;
    mergeConfirm.disabled = false;
  }
});

// ---- Delete ------------------------------------------------------
//
// Hard-delete the customer record. Server-side is the source of truth
// for whether deletion is allowed. Three answers come back:
//
//   200                  — gone; redirect to the index.
//   409 code "linked"    — LIVE records point at this customer (booking,
//                          WO, quote, invoice, property, lead, project).
//                          Patrick is told to Merge first.
//   409 code "trashed_only"
//                        — nothing live, but records sitting in the Trash
//                          still carry the customerId. Those are invisible
//                          from this page (every tab above is built from
//                          list endpoints that filter the Trash out), so
//                          the old refusal named links Patrick could not
//                          see. Now it's a second confirm that says what
//                          will be permanently deleted along with the
//                          customer, and re-issues the DELETE with
//                          ?purgeTrashed=1.

const deleteBtn = document.getElementById("deleteBtn");
const deleteErrorEl = document.getElementById("deleteError");

// Singular / plural per store, so a refusal reads "1 quote", not
// "1 quotes". Keys are the store names the API sends.
const LINK_LABELS = {
  leads: ["lead", "leads"],
  properties: ["property", "properties"],
  bookings: ["booking", "bookings"],
  "work-orders": ["work order", "work orders"],
  quotes: ["quote", "quotes"],
  invoices: ["invoice", "invoices"],
  projects: ["project", "projects"]
};

function describeLinks(map) {
  return Object.entries(map || {})
    .map(([kind, ids]) => {
      const n = Array.isArray(ids) ? ids.length : 0;
      const pair = LINK_LABELS[kind] || [kind, kind];
      return `${n} ${n === 1 ? pair[0] : pair[1]}`;
    })
    .join(", ");
}

async function requestDelete({ purgeTrashed = false } = {}) {
  const qs = purgeTrashed ? "?purgeTrashed=1" : "";
  const res = await fetch(`/api/customer/${encodeURIComponent(customerId)}${qs}`, {
    method: "DELETE",
    credentials: "same-origin"
  });
  const body = await res.json();
  return { res, body };
}

deleteBtn?.addEventListener("click", async () => {
  if (!original) return;
  const label = original.name || original.id;
  if (!confirm(`Delete ${label}?\n\nThis is permanent. Use Cancel if you're not sure — you can soft-delete by setting status to Inactive instead.`)) {
    return;
  }
  deleteErrorEl.hidden = true;
  deleteBtn.disabled = true;
  try {
    let { res, body } = await requestDelete();

    // Trash-only: ask once more, naming exactly what goes with the
    // customer, then retry carrying the confirmation.
    if (!res.ok && body?.code === "trashed_only") {
      const trashSummary = describeLinks(body.trashed);
      const proceed = confirm(
        `${label} has nothing live attached, but ${trashSummary} still in the Trash `
        + `point at this customer.\n\nDeleting the customer permanently deletes `
        + `${trashSummary} too — they can't be restored afterwards.\n\nGo ahead?`
      );
      if (!proceed) {
        deleteBtn.disabled = false;
        return;
      }
      ({ res, body } = await requestDelete({ purgeTrashed: true }));
    }

    if (!res.ok || !body.ok) {
      // The confirmed call coming back with the same refusal means the
      // confirmation didn't reach the server. Echoing the server's sentence
      // again would read as "nothing happened" — say what to do instead.
      if (body?.code === "trashed_only") {
        deleteErrorEl.textContent =
          "The confirmation didn't reach the server, so nothing was deleted. "
          + "Reload the page (Ctrl+Shift+R / Cmd+Shift+R) and try again.";
        deleteErrorEl.hidden = false;
        deleteBtn.disabled = false;
        return;
      }
      if (body.references) {
        const counts = describeLinks(body.references);
        let msg = `Can't delete — this customer is linked to ${counts}. Use Merge to combine them into another customer first.`;
        if (body.trashed) {
          msg += ` (${describeLinks(body.trashed)} in the Trash also point here; those go automatically once the live links are cleared.)`;
        }
        deleteErrorEl.textContent = msg;
      } else {
        deleteErrorEl.textContent = body?.error || "Couldn't delete.";
      }
      deleteErrorEl.hidden = false;
      deleteBtn.disabled = false;
      return;
    }
    // Successful delete — return to the customer index.
    location.href = "/admin/customers";
  } catch (err) {
    deleteErrorEl.textContent = err?.message || "Network error.";
    deleteErrorEl.hidden = false;
    deleteBtn.disabled = false;
  }
});

// ---- Initial load -------------------------------------------------

async function load() {
  if (!customerId) {
    loadErrorEl.textContent = "Couldn't read customer id from URL.";
    loadErrorEl.hidden = false;
    return;
  }
  try {
    const res = await fetch(`/api/customer/${encodeURIComponent(customerId)}`, { credentials: "same-origin" });
    if (res.status === 404) {
      loadErrorEl.textContent = `Customer ${customerId} not found.`;
      loadErrorEl.hidden = false;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok || !body.customer) throw new Error(body?.error || "Bad response.");
    profileEl.hidden = false;
    applyToForm(body.customer);
    applyLinked(body.customer);
  } catch (err) {
    loadErrorEl.textContent = err?.message || "Failed to load customer.";
    loadErrorEl.hidden = false;
  }
}

load();
