// Suppliers admin — Phase 1.
// Card-based list of vendors PJL buys parts from. Inline new/edit form
// (no modal — keeps the page simple and accessible). Archive instead of
// hard-delete so PO records in Phase 3 can keep referencing the supplier.

const els = {
  list: document.getElementById("suppliersList"),
  empty: document.getElementById("suppliersEmpty"),
  newButton: document.getElementById("newSupplierButton"),
  includeArchived: document.getElementById("includeArchived"),
  form: document.getElementById("supplierForm"),
  formTitle: document.getElementById("supplierFormTitle"),
  formError: document.getElementById("supplierFormError"),
  formSave: document.getElementById("supplierFormSave"),
  formCancel: document.getElementById("supplierFormCancel"),
  fId: document.getElementById("supplierIdField"),
  fName: document.getElementById("supplierName"),
  fContactName: document.getElementById("supplierContactName"),
  fEmail: document.getElementById("supplierEmail"),
  fPhone: document.getElementById("supplierPhone"),
  fAddress: document.getElementById("supplierAddress"),
  fNotes: document.getElementById("supplierNotes")
};

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// Format a phone for tel: — strip everything except digits + leading +.
function telHref(phone) {
  const cleaned = String(phone || "").replace(/[^\d+]/g, "");
  return cleaned ? `tel:${cleaned}` : null;
}

let cachedSuppliers = [];

async function loadSuppliers() {
  const includeArchived = els.includeArchived.checked ? "?includeArchived=1" : "";
  const r = await fetch(`/api/suppliers${includeArchived}`, { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  cachedSuppliers = (data.ok && Array.isArray(data.suppliers)) ? data.suppliers : [];
  renderList();
}

function renderList() {
  if (!cachedSuppliers.length) {
    els.list.innerHTML = "";
    els.empty.hidden = false;
    return;
  }
  els.empty.hidden = true;
  els.list.innerHTML = cachedSuppliers.map((s) => {
    const tel = telHref(s.phone);
    const lines = [];
    if (s.contactName) lines.push(escapeHtml(s.contactName));
    if (s.email) {
      lines.push(`<a href="mailto:${escapeHtml(s.email)}">${escapeHtml(s.email)}</a>`);
    }
    if (s.phone) {
      lines.push(tel
        ? `<a href="${escapeHtml(tel)}">${escapeHtml(s.phone)}</a>`
        : escapeHtml(s.phone));
    }
    if (s.address) lines.push(escapeHtml(s.address));
    return `
      <li class="supplier-card${s.archived ? " is-archived" : ""}" data-supplier-id="${escapeHtml(s.id)}">
        <h3 class="supplier-card-name">
          ${escapeHtml(s.name)}
          <span class="supplier-card-id">${escapeHtml(s.id)}</span>
          ${s.archived ? `<span class="supplier-card-archived-badge">Archived</span>` : ""}
        </h3>
        <div class="supplier-card-actions">
          <button type="button" data-action="edit">Edit</button>
          <button type="button" data-action="archive" class="${s.archived ? "" : "is-danger"}">${s.archived ? "Restore" : "Archive"}</button>
        </div>
        <div class="supplier-card-meta">${lines.join(" &middot; ") || "<em>No contact details yet.</em>"}</div>
        ${s.notes ? `<p class="supplier-card-notes">${escapeHtml(s.notes)}</p>` : ""}
      </li>
    `;
  }).join("");
}

function openForm({ supplier = null } = {}) {
  els.formError.hidden = true;
  els.formError.textContent = "";
  if (supplier) {
    els.formTitle.textContent = `Edit ${supplier.name || supplier.id}`;
    els.fId.value = supplier.id;
    els.fName.value = supplier.name || "";
    els.fContactName.value = supplier.contactName || "";
    els.fEmail.value = supplier.email || "";
    els.fPhone.value = supplier.phone || "";
    els.fAddress.value = supplier.address || "";
    els.fNotes.value = supplier.notes || "";
  } else {
    els.formTitle.textContent = "New supplier";
    els.fId.value = "";
    els.form.reset();
  }
  els.form.hidden = false;
  // Scroll into view + focus the name field — important on mobile so the
  // user doesn't have to hunt for the form when they tap "+ New supplier".
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => els.fName.focus(), 200);
}

function closeForm() {
  els.form.hidden = true;
  els.form.reset();
  els.fId.value = "";
  els.formError.hidden = true;
}

async function saveForm(event) {
  event.preventDefault();
  els.formError.hidden = true;
  const payload = {
    name: els.fName.value,
    contactName: els.fContactName.value,
    email: els.fEmail.value,
    phone: els.fPhone.value,
    address: els.fAddress.value,
    notes: els.fNotes.value
  };
  if (!payload.name.trim()) {
    els.formError.textContent = "Name is required.";
    els.formError.hidden = false;
    els.fName.focus();
    return;
  }
  const id = els.fId.value;
  els.formSave.disabled = true;
  try {
    const url = id ? `/api/suppliers/${encodeURIComponent(id)}` : "/api/suppliers";
    const method = id ? "PATCH" : "POST";
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const err = (data.errors && data.errors[0]) || `HTTP ${r.status}`;
      els.formError.textContent = err;
      els.formError.hidden = false;
      return;
    }
    closeForm();
    await loadSuppliers();
  } catch (err) {
    els.formError.textContent = err.message || "Couldn't save supplier.";
    els.formError.hidden = false;
  } finally {
    els.formSave.disabled = false;
  }
}

async function toggleArchive(supplier) {
  const verb = supplier.archived ? "restore" : "archive";
  if (!confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${supplier.name}?`)) return;
  const r = await fetch(`/api/suppliers/${encodeURIComponent(supplier.id)}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: !supplier.archived })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    alert((data.errors && data.errors[0]) || `Couldn't ${verb} supplier.`);
    return;
  }
  await loadSuppliers();
}

// Event wiring
els.newButton.addEventListener("click", () => openForm());
els.formCancel.addEventListener("click", closeForm);
els.form.addEventListener("submit", saveForm);
els.includeArchived.addEventListener("change", loadSuppliers);

els.list.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = event.target.closest("[data-supplier-id]");
  if (!card) return;
  const supplier = cachedSuppliers.find((s) => s.id === card.dataset.supplierId);
  if (!supplier) return;
  if (button.dataset.action === "edit") openForm({ supplier });
  if (button.dataset.action === "archive") toggleArchive(supplier);
});

loadSuppliers();
