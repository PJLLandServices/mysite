// Properties index — list every property in the CRM with quick-filter
// search. Click a card to open the property profile editor.
//
// Select mode: toggling "Select" turns each card into a checkbox row so
// Patrick can multi-select and bulk-delete (or, with the typed-confirmation
// "Delete ALL", nuke the whole portfolio after a bad import).

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

const grid = document.getElementById("propertiesGrid");
const empty = document.getElementById("propertiesEmpty");
const search = document.getElementById("propertySearch");
const countEl = document.getElementById("propertiesCount");
const logoutButton = document.getElementById("logoutButton");

const selectToggle = document.getElementById("selectToggle");
const bulkbar = document.getElementById("propertiesBulkbar");
const bulkCount = document.getElementById("bulkCount");
const bulkClear = document.getElementById("bulkClear");
const bulkDelete = document.getElementById("bulkDelete");
const bulkDeleteAll = document.getElementById("bulkDeleteAll");
const bulkSelectAll = document.getElementById("bulkSelectAll");

const confirmModal = document.getElementById("confirmModal");
const confirmTitle = document.getElementById("confirmTitle");
const confirmBody = document.getElementById("confirmBody");
const confirmTypedRow = document.getElementById("confirmTypedRow");
const confirmExpected = document.getElementById("confirmExpected");
const confirmInput = document.getElementById("confirmInput");
const confirmError = document.getElementById("confirmError");
const confirmCancel = document.getElementById("confirmCancel");
const confirmAccept = document.getElementById("confirmAccept");

let properties = [];
let selecting = false;
const selected = new Set();

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function searchableProperty(p) {
  return [
    p.customerName,
    p.customerEmail,
    p.customerPhone,
    p.address,
    p.system?.controllerLocation,
    p.system?.controllerBrand
  ].join(" ").toLowerCase();
}

function visibleProperties() {
  const query = search.value.trim().toLowerCase();
  return query
    ? properties.filter((p) => searchableProperty(p).includes(query))
    : properties;
}

function render() {
  const filtered = visibleProperties();

  countEl.textContent = filtered.length === properties.length
    ? `${properties.length} ${properties.length === 1 ? "property" : "properties"}`
    : `${filtered.length} of ${properties.length}`;

  grid.classList.toggle("is-selecting", selecting);
  grid.innerHTML = "";
  if (!filtered.length) {
    empty.hidden = false;
    updateBulkBar(filtered);
    return;
  }
  empty.hidden = true;

  filtered.forEach((p) => {
    const zoneCount = (p.system?.zones || []).length;
    const valveBoxCount = (p.system?.valveBoxes || []).length;
    const bookingCount = (p.leadIds || []).length;
    const inner = `
      <strong>${escapeHtml(p.customerName) || "Unnamed customer"}</strong>
      <span class="property-card-address">${escapeHtml(p.address) || "(no address on file)"}</span>
      <span class="property-card-email">${escapeHtml(p.customerEmail) || "—"}</span>
      <div class="property-card-stats">
        <span><strong>${zoneCount}</strong> zone${zoneCount === 1 ? "" : "s"}</span>
        <span><strong>${valveBoxCount}</strong> valve box${valveBoxCount === 1 ? "" : "es"}</span>
        <span><strong>${bookingCount}</strong> booking${bookingCount === 1 ? "" : "s"}</span>
      </div>
    `;

    if (selecting) {
      // Render a div + checkbox so clicking the card toggles selection
      // instead of navigating away.
      const card = document.createElement("div");
      card.className = "property-card";
      card.dataset.id = p.id;
      if (selected.has(p.id)) card.classList.add("is-selected");
      card.innerHTML = `
        <input type="checkbox" class="property-card-check" aria-label="Select ${escapeHtml(p.customerName) || "property"}" ${selected.has(p.id) ? "checked" : ""}>
        ${inner}
      `;
      const checkbox = card.querySelector(".property-card-check");
      const toggle = (event) => {
        // Avoid double-toggle when click bubbles up from the checkbox itself.
        if (event && event.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        applyToggle(p.id, checkbox.checked);
        card.classList.toggle("is-selected", checkbox.checked);
      };
      card.addEventListener("click", toggle);
      checkbox.addEventListener("change", () => {
        applyToggle(p.id, checkbox.checked);
        card.classList.toggle("is-selected", checkbox.checked);
      });
      grid.appendChild(card);
    } else {
      const link = document.createElement("a");
      link.href = `/admin/property/${encodeURIComponent(p.id)}`;
      link.className = "property-card";
      link.innerHTML = inner;
      grid.appendChild(link);
    }
  });

  updateBulkBar(filtered);
}

function applyToggle(id, isSelected) {
  if (isSelected) selected.add(id);
  else selected.delete(id);
  updateBulkBar();
}

function updateBulkBar(filtered) {
  if (!selecting) {
    bulkbar.hidden = true;
    selectToggle.setAttribute("aria-pressed", "false");
    selectToggle.textContent = "Select";
    return;
  }
  bulkbar.hidden = false;
  selectToggle.setAttribute("aria-pressed", "true");
  selectToggle.textContent = "Cancel";
  bulkCount.textContent = String(selected.size);
  bulkDelete.disabled = selected.size === 0;

  // Sync the "Select all" header checkbox with the actually-visible set.
  if (filtered) {
    const allVisibleSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));
    bulkSelectAll.checked = allVisibleSelected;
    bulkSelectAll.indeterminate = !allVisibleSelected && filtered.some((p) => selected.has(p.id));
  }
}

function setSelecting(next) {
  selecting = next;
  if (!selecting) selected.clear();
  render();
}

selectToggle.addEventListener("click", () => setSelecting(!selecting));
bulkClear.addEventListener("click", () => {
  selected.clear();
  render();
});
bulkSelectAll.addEventListener("change", () => {
  const filtered = visibleProperties();
  if (bulkSelectAll.checked) {
    filtered.forEach((p) => selected.add(p.id));
  } else {
    filtered.forEach((p) => selected.delete(p.id));
  }
  render();
});

search.addEventListener("input", render);

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

// ---- Confirm modal ---------------------------------------------------

let confirmResolver = null;

function openConfirm({ title, body, expected, danger = true }) {
  confirmTitle.textContent = title;
  confirmBody.innerHTML = body;
  confirmError.hidden = true;
  confirmError.textContent = "";

  if (expected) {
    confirmTypedRow.hidden = false;
    confirmExpected.textContent = expected;
    confirmInput.value = "";
    confirmInput.dataset.expected = expected;
    confirmAccept.disabled = true;
  } else {
    confirmTypedRow.hidden = true;
    confirmInput.dataset.expected = "";
    confirmAccept.disabled = false;
  }
  confirmAccept.textContent = danger ? "Delete" : "Confirm";
  confirmModal.hidden = false;
  setTimeout(() => {
    if (expected) confirmInput.focus();
    else confirmAccept.focus();
  }, 0);

  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function closeConfirm(result) {
  confirmModal.hidden = true;
  confirmInput.value = "";
  confirmAccept.disabled = false;
  if (confirmResolver) {
    const r = confirmResolver;
    confirmResolver = null;
    r(result);
  }
}

confirmCancel.addEventListener("click", () => closeConfirm(false));
confirmAccept.addEventListener("click", () => {
  const expected = confirmInput.dataset.expected;
  if (expected && confirmInput.value.trim() !== expected) {
    confirmError.hidden = false;
    confirmError.textContent = `Type ${expected} exactly to confirm.`;
    return;
  }
  closeConfirm(true);
});
confirmInput.addEventListener("input", () => {
  const expected = confirmInput.dataset.expected;
  confirmAccept.disabled = !expected || confirmInput.value.trim() !== expected;
  if (!confirmError.hidden) confirmError.hidden = true;
});
confirmModal.addEventListener("click", (event) => {
  if (event.target === confirmModal) closeConfirm(false);
});
window.addEventListener("keydown", (event) => {
  if (!confirmModal.hidden && event.key === "Escape") closeConfirm(false);
});

// ---- Delete actions --------------------------------------------------

async function callBulkDelete(payload) {
  const response = await fetch("/api/properties/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const msg = (data.errors && data.errors[0]) || `Delete failed (HTTP ${response.status}).`;
    throw new Error(msg);
  }
  return data;
}

bulkDelete.addEventListener("click", async () => {
  if (!selected.size) return;
  const ids = Array.from(selected);
  const noun = ids.length === 1 ? "1 customer" : `${ids.length} customers`;
  // Step 1 confirms intent. Step 2 (typed token) confirms identity of
  // the click — if Patrick fat-fingered the toolbar we won't fire the
  // request just because he hit Enter.
  const ok = await openConfirm({
    title: `Delete ${noun}?`,
    body: `This permanently removes ${noun} and unlinks every booking pointed at ${ids.length === 1 ? "it" : "them"}. Bookings stay in the CRM. <strong>This cannot be undone.</strong>`,
    expected: "DELETE"
  });
  if (!ok) return;
  try {
    const result = await callBulkDelete({ ids, confirm: "DELETE" });
    setSelecting(false);
    await reload();
    flashSuccess(`Deleted ${result.deletedCount} customer${result.deletedCount === 1 ? "" : "s"}.`);
  } catch (err) {
    alert(err.message);
  }
});

bulkDeleteAll.addEventListener("click", async () => {
  if (!properties.length) {
    alert("No customers to delete.");
    return;
  }
  const ok = await openConfirm({
    title: "Delete EVERY customer?",
    body: `This wipes <strong>all ${properties.length}</strong> customer profiles, including system info, valve boxes, and zone lists. Bookings stay but lose their property link. <strong>There is no undo.</strong>`,
    expected: "DELETE ALL"
  });
  if (!ok) return;
  try {
    const result = await callBulkDelete({ all: true, confirm: "DELETE ALL" });
    setSelecting(false);
    await reload();
    flashSuccess(`Deleted ${result.deletedCount} customer${result.deletedCount === 1 ? "" : "s"}.`);
  } catch (err) {
    alert(err.message);
  }
});

function flashSuccess(message) {
  // Lightweight transient banner — reuses the empty-state slot when grid
  // is empty, otherwise just a console + count update is enough since
  // the grid re-renders to reflect the deletion.
  countEl.textContent = `${message} · ${properties.length} ${properties.length === 1 ? "property" : "properties"}`;
  setTimeout(() => render(), 2200);
}

// ---- Initial load + reload -------------------------------------------

async function reload() {
  try {
    const response = await fetch("/api/properties", { cache: "no-store" });
    const data = await response.json();
    properties = (data.ok ? data.properties : []) || [];
    properties.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    // Drop any selections that point at properties that no longer exist.
    const live = new Set(properties.map((p) => p.id));
    Array.from(selected).forEach((id) => { if (!live.has(id)) selected.delete(id); });
    render();
  } catch {
    grid.innerHTML = `<p style="color:#a92e2e;">Couldn't load properties. Refresh the page.</p>`;
  }
}

reload();
