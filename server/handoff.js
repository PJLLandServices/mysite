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

// Manual booking handoff. Patrick fills in customer + diagnosis after a
// phone call, picks SMS/email/both, hits send. Server creates a booking
// session and fires the link to the customer the same way the AI agent
// will once that's wired up.
//
// The "What we'll be doing" section is a multi-item picker: each row is
// one service / line item from the FEATURES catalog with a quantity.
// The FIRST row drives the appointment slot duration (so it must be a
// bookable service). Additional rows are line items on the work order.

const form = document.getElementById("handoffForm");
const submitBtn = document.getElementById("submitBtn");
const resetBtn = document.getElementById("resetBtn");
const handoffItems = document.getElementById("handoffItems");
const addItemBtn = document.getElementById("addItemBtn");
const zoneCountSelect = document.getElementById("zoneCountSelect");
const handoffResult = document.getElementById("handoffResult");
const handoffResultTitle = document.getElementById("handoffResultTitle");
const handoffResultMsg = document.getElementById("handoffResultMsg");
const handoffLinkInput = document.getElementById("handoffLinkInput");
const handoffCopyBtn = document.getElementById("handoffCopyBtn");
const handoffOpenBtn = document.getElementById("handoffOpenBtn");
const handoffStatus = document.getElementById("handoffStatus");
const handoffDoneBtn = document.getElementById("handoffDoneBtn");
const logoutButton = document.getElementById("logoutButton");

// Catalogs loaded at boot. `features` is the granular FEATURES list (head
// replacement, valve, manifold rebuild, wire run, etc). `bookableKeys` is
// the subset that can drive a slot — only items in BOOKABLE_SERVICES qualify
// to be the FIRST row in the picker.
let features = {};
let bookableKeys = new Set();

// Pretty-print categories for <optgroup> labels.
const CATEGORY_LABELS = {
  service:    "Service call",
  repair:     "Repair line items",
  valve:      "Valves & manifolds",
  controller: "Smart controllers",
  wire:       "Wire diagnostics & runs",
  pipe:       "Pipe / mainline",
  seasonal:   "Seasonal openings & closings",
  install:    "New install / smart upgrades"
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 1..50 zones in the dropdown.
for (let n = 1; n <= 50; n++) {
  const opt = document.createElement("option");
  opt.value = String(n);
  opt.textContent = n === 1 ? "1 zone" : `${n} zones`;
  zoneCountSelect.append(opt);
}

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

// Bootstrap: load both catalogs in parallel, then render the first item row.
Promise.all([
  fetch("/api/admin/features", { cache: "no-store" }).then((r) => r.json()),
  fetch("/api/booking/services", { cache: "no-store" }).then((r) => r.json())
]).then(([featData, svcData]) => {
  features = (featData.ok ? featData.features : {}) || {};
  bookableKeys = new Set(Object.keys(svcData.ok ? svcData.services : {}));
  addItemRow();
}).catch(() => {
  handoffItems.innerHTML = `<p class="handoff-help" style="color:#a92e2e;">Couldn't load services. Refresh the page.</p>`;
});

// Group features by category and render an <option> tree once. Cached
// because every new row reuses the same markup.
let cachedOptionsHtml = null;
function renderOptionsHtml() {
  if (cachedOptionsHtml) return cachedOptionsHtml;
  const grouped = {};
  Object.entries(features).forEach(([key, def]) => {
    const cat = def.category || "other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push({ key, def });
  });

  const order = ["seasonal", "service", "repair", "valve", "controller", "wire", "pipe", "install"];
  const knownCats = new Set(order);
  const otherCats = Object.keys(grouped).filter((c) => !knownCats.has(c));

  let html = `<option value="" disabled selected>Choose service / item…</option>`;
  for (const cat of [...order, ...otherCats]) {
    if (!grouped[cat] || !grouped[cat].length) continue;
    html += `<optgroup label="${escapeHtml(CATEGORY_LABELS[cat] || cat)}">`;
    grouped[cat].forEach(({ key, def }) => {
      const priceLabel = def.quoteType === "custom"
        ? "(custom quote)"
        : `$${Number(def.price || 0).toFixed(2).replace(/\.00$/, "")}`;
      html += `<option value="${escapeHtml(key)}">${escapeHtml(def.label)} — ${priceLabel}</option>`;
    });
    html += `</optgroup>`;
  }
  cachedOptionsHtml = html;
  return html;
}

function addItemRow() {
  const row = document.createElement("div");
  row.className = "handoff-item-row";
  row.dataset.itemRow = "1";
  row.innerHTML = `
    <select class="item-key" required>${renderOptionsHtml()}</select>
    <input type="number" class="item-qty" value="1" min="1" max="99" aria-label="Quantity">
    <button type="button" class="item-remove" aria-label="Remove item">×</button>
  `;
  handoffItems.append(row);
  refreshRowState();
}

function refreshRowState() {
  // Hide remove button on the only row so the form always has at least one.
  const rows = handoffItems.querySelectorAll(".handoff-item-row");
  rows.forEach((row, idx) => {
    const removeBtn = row.querySelector(".item-remove");
    removeBtn.style.visibility = rows.length === 1 ? "hidden" : "visible";
    // Tag the first row so the user understands it drives the slot.
    row.classList.toggle("is-primary", idx === 0);
  });
}

addItemBtn.addEventListener("click", () => addItemRow());

handoffItems.addEventListener("click", (event) => {
  const removeBtn = event.target.closest(".item-remove");
  if (!removeBtn) return;
  const row = removeBtn.closest(".handoff-item-row");
  if (row) row.remove();
  refreshRowState();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  // Gather the line items. Validate the first row uses a bookable-service
  // key (since it determines the slot duration).
  const rows = Array.from(handoffItems.querySelectorAll(".handoff-item-row"));
  const lineItems = rows.map((row) => {
    const key = row.querySelector(".item-key").value;
    const qty = Math.max(1, Math.min(99, Number(row.querySelector(".item-qty").value) || 1));
    return key ? { key, qty } : null;
  }).filter(Boolean);

  if (!lineItems.length) {
    alert("Pick at least one service / item.");
    return;
  }
  const firstKey = lineItems[0].key;
  if (!bookableKeys.has(firstKey)) {
    alert(
      `The first item drives the appointment length. Pick a bookable service for the first row` +
      ` (spring opening, fall winterization, repair, hydrawise retrofit, or site visit). ` +
      `Add granular line items in additional rows.`
    );
    return;
  }

  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = "Sending…";

  const fd = new FormData(form);
  const zoneRaw = String(fd.get("zoneCount") || "").trim();
  let zoneCount = null;
  if (zoneRaw === "unsure") zoneCount = "unsure";
  else if (/^\d+$/.test(zoneRaw)) zoneCount = Number(zoneRaw);

  const payload = {
    diagnosis: String(fd.get("diagnosis") || "").trim(),
    diagnosisSummary: String(fd.get("diagnosisSummary") || "").trim(),
    suggestedService: firstKey, // first row drives the slot
    severity: String(fd.get("severity") || "normal").trim(),
    lineItems,
    customerHints: {
      firstName: String(fd.get("firstName") || "").trim(),
      lastName: String(fd.get("lastName") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      phone: String(fd.get("phone") || "").trim(),
      address: String(fd.get("address") || "").trim(),
      zoneCount,
      notes: String(fd.get("notes") || "").trim()
    },
    sendSms: Boolean(fd.get("sendSms")),
    sendEmail: Boolean(fd.get("sendEmail"))
  };

  try {
    const response = await fetch("/api/admin/send-booking-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error((data.errors || ["Couldn't send link."]).join(" "));
    }
    showResult(data, payload);
  } catch (err) {
    alert(err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

function showResult(data, payload) {
  handoffResultTitle.textContent = `Link ready for ${payload.customerHints.firstName || "customer"}.`;
  const sentBits = [];
  if (data.smsSent) sentBits.push(`SMS sent to ${payload.customerHints.phone}`);
  if (data.emailSent) sentBits.push(`Email sent to ${payload.customerHints.email}`);
  if (!sentBits.length) sentBits.push("Link generated — copy/paste it to the customer manually");
  handoffResultMsg.textContent = sentBits.join(" · ");

  handoffLinkInput.value = data.bookingUrl;
  handoffOpenBtn.href = data.bookingUrl;

  handoffStatus.innerHTML = "";
  if (payload.sendSms) {
    const li = document.createElement("li");
    li.className = data.smsSent ? "is-ok" : "is-err";
    li.textContent = data.smsSent
      ? `SMS sent to ${payload.customerHints.phone}`
      : `SMS failed: ${data.smsError || "Twilio not configured on this server"}`;
    handoffStatus.append(li);
  }
  if (payload.sendEmail) {
    const li = document.createElement("li");
    li.className = data.emailSent ? "is-ok" : "is-err";
    li.textContent = data.emailSent
      ? `Email sent to ${payload.customerHints.email}`
      : `Email failed: ${data.emailError || "Gmail not configured on this server"}`;
    handoffStatus.append(li);
  }
  const expiresAt = new Date(data.expiresAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
  const expLi = document.createElement("li");
  expLi.className = "is-info";
  expLi.textContent = `Link expires at ${expiresAt} (1 hour from now)`;
  handoffStatus.append(expLi);

  const itemsLi = document.createElement("li");
  itemsLi.className = "is-info";
  itemsLi.textContent = `Work order will include ${payload.lineItems.length} line item${payload.lineItems.length === 1 ? "" : "s"}`;
  handoffStatus.append(itemsLi);

  form.hidden = true;
  handoffResult.hidden = false;
  submitBtn.disabled = false;
  submitBtn.textContent = "Generate & Send Link";
}

handoffCopyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(handoffLinkInput.value);
    handoffCopyBtn.textContent = "Copied!";
    setTimeout(() => { handoffCopyBtn.textContent = "Copy"; }, 1500);
  } catch {
    handoffLinkInput.select();
    document.execCommand("copy");
    handoffCopyBtn.textContent = "Copied!";
    setTimeout(() => { handoffCopyBtn.textContent = "Copy"; }, 1500);
  }
});

handoffDoneBtn.addEventListener("click", () => {
  form.reset();
  handoffItems.innerHTML = "";
  addItemRow();
  handoffResult.hidden = true;
  form.hidden = false;
  document.querySelector('[name="firstName"]').focus();
});

// ---- Existing-customer search (Brief 4) ---------------------------
//
// As the user types in the search box, fetch /api/customers once,
// filter client-side, render up to 8 matches. Clicking a match fills
// firstName / lastName / phone / email / address from the customer
// record (address pulled from their primary property if available).
// Doesn't touch service-line / diagnosis / context fields — those are
// always per-call.

(function setupCustomerSearch() {
  const searchEl = document.getElementById("handoffCustomerSearch");
  const resultsEl = document.getElementById("handoffCustomerResults");
  const selectedEl = document.getElementById("handoffCustomerSelected");
  const selectedName = document.getElementById("handoffCustomerSelectedName");
  const selectedClear = document.getElementById("handoffCustomerSelectedClear");
  if (!searchEl || !resultsEl) return;

  let allCustomers = null;
  let loading = null;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  async function ensureLoaded() {
    if (allCustomers) return allCustomers;
    if (!loading) {
      loading = fetch("/api/customers", { credentials: "same-origin" })
        .then((r) => r.json())
        .then((body) => { allCustomers = Array.isArray(body.customers) ? body.customers : []; return allCustomers; })
        .catch(() => { allCustomers = []; return allCustomers; });
    }
    return loading;
  }

  function render(query) {
    const q = (query || "").trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    if (!q || !allCustomers) {
      resultsEl.innerHTML = "";
      resultsEl.style.display = "none";
      return;
    }
    const matches = allCustomers.filter((c) => {
      const hay = [c.name, c.spouseName, c.email, c.spouseEmail].filter(Boolean).join(" ").toLowerCase();
      if (hay.includes(q)) return true;
      const pd = String(c.phone || "").replace(/\D/g, "");
      if (qDigits && pd.includes(qDigits)) return true;
      return false;
    }).slice(0, 8);

    if (!matches.length) {
      resultsEl.innerHTML = `<div style="padding: 10px 14px; color: #888; font-size: 12px;">No customers match. Fill the form below to create a new one.</div>`;
      resultsEl.style.display = "block";
      return;
    }

    resultsEl.innerHTML = matches.map((c) => `
      <div class="handoff-customer-result" data-id="${esc(c.id)}" style="padding: 8px 12px; border-bottom: 1px solid #f0eee8; cursor: pointer; font-size: 13px;">
        <strong>${esc(c.name) || "(unnamed)"}</strong>
        <span style="color: #666; margin-left: 6px; font-size: 12px;">${esc(c.email) || c.phone || ""}</span>
        <div style="color: #888; font-size: 11px; margin-top: 1px;">${esc(c.id)} · ${c.propertyCount || 0} ${(c.propertyCount === 1 ? "property" : "properties")}</div>
      </div>
    `).join("");
    resultsEl.style.display = "block";

    resultsEl.querySelectorAll(".handoff-customer-result").forEach((row) => {
      row.addEventListener("click", () => {
        const id = row.dataset.id;
        const customer = allCustomers.find((c) => c.id === id);
        if (!customer) return;
        applyCustomer(customer);
      });
    });
  }

  async function applyCustomer(customer) {
    // Split name into first/last for the form's fields.
    const parts = String(customer.name || "").trim().split(/\s+/);
    const first = parts.shift() || "";
    const last = parts.join(" ");
    form.elements.firstName.value = first;
    form.elements.lastName.value = last;
    form.elements.phone.value = customer.phone || "";
    form.elements.email.value = customer.email || "";

    // Fill address from the customer's first property if available.
    try {
      const res = await fetch(`/api/customer/${encodeURIComponent(customer.id)}`, { credentials: "same-origin" });
      const body = await res.json();
      const firstProp = body?.customer?.properties?.[0];
      if (firstProp?.address) form.elements.address.value = firstProp.address;
    } catch { /* address fill is best-effort */ }

    selectedName.textContent = customer.name + (customer.email ? ` <${customer.email}>` : "");
    selectedEl.hidden = false;
    searchEl.value = "";
    resultsEl.innerHTML = "";
    resultsEl.style.display = "none";
  }

  searchEl.addEventListener("focus", () => { ensureLoaded(); });
  searchEl.addEventListener("input", async () => {
    await ensureLoaded();
    render(searchEl.value);
  });
  document.addEventListener("click", (e) => {
    if (!resultsEl.contains(e.target) && e.target !== searchEl) {
      resultsEl.style.display = "none";
    }
  });

  selectedClear.addEventListener("click", () => {
    selectedEl.hidden = true;
    form.elements.firstName.value = "";
    form.elements.lastName.value = "";
    form.elements.phone.value = "";
    form.elements.email.value = "";
    form.elements.address.value = "";
  });
})();
