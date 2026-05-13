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
    if (el.tagName === "SELECT") {
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

function applyLinked(customer) {
  renderProperties(customer.properties || []);
  renderBookings(customer.bookings || []);
  renderWorkOrders(customer.workOrders || []);
  renderQuotes(customer.quotes || []);
  renderInvoices(customer.invoices || []);
  renderCommunications(customer.communicationRecords || []);
  renderHistory(customer.history || []);

  document.getElementById("countProperties").textContent = (customer.properties || []).length;
  document.getElementById("countBookings").textContent = (customer.bookings || []).length;
  document.getElementById("countWorkOrders").textContent = (customer.workOrders || []).length;
  document.getElementById("countQuotes").textContent = (customer.quotes || []).length;
  document.getElementById("countInvoices").textContent = (customer.invoices || []).length;
  document.getElementById("countCommunications").textContent = (customer.communicationRecords || []).length;
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
            <td>${esc(p.address)}</td>
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
            <td>${esc(w.address)}</td>
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
  el.addEventListener("input", () => {
    if (!original) return;
    const field = el.dataset.field;
    const newValue = el.value;
    const oldValue = original[field] == null ? "" : original[field];
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
// for whether deletion is allowed — if anything references this
// customer (booking, WO, quote, invoice, property, lead, project), the
// API returns 409 with a `references` map and Patrick is told to Merge
// first. Otherwise the record is removed and the page redirects back
// to the customers index.

const deleteBtn = document.getElementById("deleteBtn");
const deleteErrorEl = document.getElementById("deleteError");

deleteBtn?.addEventListener("click", async () => {
  if (!original) return;
  const label = original.name || original.id;
  if (!confirm(`Delete ${label}?\n\nThis is permanent. Use Cancel if you're not sure — you can soft-delete by setting status to Inactive instead.`)) {
    return;
  }
  deleteErrorEl.hidden = true;
  deleteBtn.disabled = true;
  try {
    const res = await fetch(`/api/customer/${encodeURIComponent(customerId)}`, {
      method: "DELETE",
      credentials: "same-origin"
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      if (body.references) {
        const counts = Object.entries(body.references)
          .map(([kind, ids]) => `${ids.length} ${kind}`)
          .join(", ");
        deleteErrorEl.textContent = `Can't delete — this customer is linked to ${counts}. Use Merge to combine them into another customer first.`;
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
