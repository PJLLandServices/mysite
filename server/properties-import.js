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

// Customer-list import flow.
//
// 1. User picks a file → SheetJS parses in-browser
// 2. If multi-sheet, ask which sheet to import
// 3. Auto-map columns to property fields, let user override
// 4. Preview first 10 rows
// 5. Confirm → POST /api/admin/import-properties
//
// The file never leaves the browser until step 5. Privacy by default:
// the customer PII only hits the server when the admin clicks confirm.

const fileInput = document.getElementById("fileInput");
const dropzone = document.querySelector(".import-dropzone");
const step1 = document.getElementById("step1");
const step2 = document.getElementById("step2");
const step3 = document.getElementById("step3");
const step4 = document.getElementById("step4");
const step5 = document.getElementById("step5");
const sheetPicker = document.getElementById("sheetPicker");
const mappingGrid = document.getElementById("mappingGrid");
const previewTable = document.getElementById("previewTable");
const importSummary = document.getElementById("importSummary");
const confirmBtn = document.getElementById("confirmImport");
const resetBtn = document.getElementById("resetImport");
const resetBtn2 = document.getElementById("resetImport2");
const importStatus = document.getElementById("importStatus");
const resultTitle = document.getElementById("resultTitle");
const resultMessage = document.getElementById("resultMessage");
const errorList = document.getElementById("errorList");
const logoutButton = document.getElementById("logoutButton");

// Target property fields the import maps INTO. The "label" is shown in the
// mapping UI; the "key" is what the server expects. Order is preserved
// in the UI grid.
const TARGET_FIELDS = [
  { key: "customerName",        label: "Customer name",          required: true },
  { key: "customerEmail",       label: "Email",                  required: false },
  { key: "customerPhone",       label: "Phone",                  required: false },
  { key: "address_street",      label: "Street address",         required: false, group: "address" },
  { key: "address_city",        label: "Town / City",            required: false, group: "address" },
  { key: "address_postal",      label: "Postal code",            required: false, group: "address" },
  { key: "controllerLocation",  label: "Timer / Controller location", required: false, group: "system" },
  { key: "shutoffLocation",     label: "Water shut-off location",     required: false, group: "system" },
  { key: "blowoutLocation",     label: "Blow-out location",           required: false, group: "system" },
  { key: "valveCount",          label: "# of valves",                  required: false, group: "system" },
  { key: "valveLocation",       label: "Valve location(s)",            required: false, group: "system" },
  { key: "notes",               label: "Special notes",                required: false, group: "system" }
];

// Auto-mapping: match each target field to a header in the uploaded file.
// Patrick's xlsx uses headers like "Customer Name", "Contact Email Address",
// "Blow Out", "Valves #", "Valves Location" — note the gaps between words.
// `\W*` (zero or more non-word chars) tolerates spaces, dots, slashes, and
// punctuation between key words so "Valves #", "Valve#", "# of Valves",
// "Valve-Count" all map cleanly.
const AUTO_MAP_HINTS = {
  customerName:       /customer\W*name|^name$/i,
  customerEmail:      /email/i,
  customerPhone:      /phone|^tel/i,
  address_street:     /street\W*address|^address$/i,
  address_city:       /town|city/i,
  address_postal:     /postal|zip/i,
  controllerLocation: /timer|controller/i,
  shutoffLocation:    /water\W*shut|shut\W*off/i,
  blowoutLocation:    /blow\W*out|blowout/i,
  valveCount:         /valves?\W*#|#\W*valves?|valves?\W*count/i,
  valveLocation:      /valves?\W*loc/i,
  notes:              /notes|special/i
};

let parsedRows = [];          // Array of objects keyed by header
let parsedHeaders = [];        // Array of source header strings
let columnMapping = {};        // { targetKey: sourceHeader | "" }

// ---- Step 1: file picker -----------------------------------------------

fileInput.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) handleFile(file);
});
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-drag");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-drag"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-drag");
  const file = event.dataTransfer.files?.[0];
  if (file) handleFile(file);
});

function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array" });
      const sheets = wb.SheetNames;
      sheetPicker.innerHTML = "";
      sheets.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s;
        sheetPicker.append(opt);
      });
      step2.hidden = false;
      // Auto-pick the largest sheet (likely the customer list, not config tabs).
      let bestIdx = 0, bestRows = 0;
      sheets.forEach((s, i) => {
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[s]);
        if (rows.length > bestRows) { bestRows = rows.length; bestIdx = i; }
      });
      sheetPicker.value = sheets[bestIdx];
      window._wb = wb;
      loadSheet();
    } catch (err) {
      alert("Couldn't read the file: " + err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

sheetPicker.addEventListener("change", loadSheet);

function loadSheet() {
  const wb = window._wb;
  if (!wb) return;
  const sheet = wb.Sheets[sheetPicker.value];
  parsedRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  parsedHeaders = parsedRows.length ? Object.keys(parsedRows[0]) : [];
  // Auto-map columns
  columnMapping = {};
  TARGET_FIELDS.forEach((f) => {
    const hint = AUTO_MAP_HINTS[f.key];
    const match = hint ? parsedHeaders.find((h) => hint.test(h)) : null;
    columnMapping[f.key] = match || "";
  });
  renderMapping();
  step3.hidden = false;
  renderPreview();
  step4.hidden = false;
}

// ---- Step 3: column mapping --------------------------------------------

function renderMapping() {
  mappingGrid.innerHTML = "";
  TARGET_FIELDS.forEach((f) => {
    const row = document.createElement("div");
    row.className = "mapping-row";
    const opts = ['<option value="">— skip —</option>'];
    parsedHeaders.forEach((h) => {
      const sel = h === columnMapping[f.key] ? "selected" : "";
      opts.push(`<option value="${escapeHtml(h)}" ${sel}>${escapeHtml(h)}</option>`);
    });
    row.innerHTML = `
      <label>
        <span>${escapeHtml(f.label)}${f.required ? " *" : ""}</span>
        <select data-field="${f.key}">${opts.join("")}</select>
      </label>
    `;
    mappingGrid.append(row);
  });
}

mappingGrid.addEventListener("change", (event) => {
  const sel = event.target.closest("[data-field]");
  if (!sel) return;
  columnMapping[sel.dataset.field] = sel.value;
  renderPreview();
});

// ---- Build records (browser-side) -------------------------------------

function buildRecords() {
  return parsedRows.map((row) => {
    const get = (key) => {
      const src = columnMapping[key];
      if (!src) return "";
      const v = row[src];
      return v == null ? "" : String(v).trim();
    };
    const street = get("address_street");
    const city = get("address_city");
    const postal = get("address_postal");
    // Combine into a single formatted address. Patrick's xlsx splits these
    // into 3 columns; the property model stores them as one string for
    // consistency with bookings.
    const address = [street, city, postal].filter(Boolean).join(", ").trim();

    // Parse the valve count permissively: SheetJS may hand us a number
    // (5), a numeric string ("5"), a float string ("5.0" — happens when
    // the source column is float-typed, like Patrick's xlsx), or noise
    // like "5 valves" / "approx 7". parseInt grabs the leading integer
    // and ignores the rest. Anything that doesn't yield a positive
    // integer becomes null.
    const valveCountRaw = get("valveCount");
    const valveCountParsed = parseInt(valveCountRaw, 10);
    const valveCount = (Number.isFinite(valveCountParsed) && valveCountParsed > 0)
      ? valveCountParsed
      : null;
    const valveLoc = get("valveLocation");
    // Build a valve-box record whenever we have EITHER a count OR a
    // location. If we only have one, fill the other with a sensible default
    // so Patrick can see what was captured and edit later in the property
    // profile.
    const valveBoxes = (valveCount || valveLoc)
      ? [{
          location: valveLoc || "(location not recorded)",
          valveCount: valveCount || 1,
          notes: ""
        }]
      : [];

    return {
      customerName: get("customerName"),
      customerEmail: get("customerEmail"),
      customerPhone: get("customerPhone"),
      address,
      system: {
        controllerLocation: get("controllerLocation"),
        shutoffLocation: get("shutoffLocation"),
        blowoutLocation: get("blowoutLocation"),
        notes: get("notes"),
        valveBoxes,
        zones: []
      }
    };
  }).filter((r) => r.customerName || r.customerEmail || r.address);
}

// ---- Step 4: preview ---------------------------------------------------

function renderPreview() {
  const records = buildRecords();
  const previewRows = records.slice(0, 10);
  importSummary.textContent = `${records.length} customer record${records.length === 1 ? "" : "s"} ready to import.`;

  const cols = [
    ["Name", (r) => r.customerName],
    ["Email", (r) => r.customerEmail],
    ["Phone", (r) => r.customerPhone],
    ["Address", (r) => r.address],
    ["Timer", (r) => r.system.controllerLocation],
    ["Shut-off", (r) => r.system.shutoffLocation],
    ["Blow-out", (r) => r.system.blowoutLocation],
    ["Valves", (r) => r.system.valveBoxes.length ? `${r.system.valveBoxes[0].valveCount} @ ${r.system.valveBoxes[0].location}` : "—"]
  ];
  const headerRow = `<tr>${cols.map(([h]) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  const bodyRows = previewRows.map((r) =>
    `<tr>${cols.map(([, fn]) => `<td>${escapeHtml(fn(r) || "—")}</td>`).join("")}</tr>`
  ).join("");
  previewTable.innerHTML = `<thead>${headerRow}</thead><tbody>${bodyRows}</tbody>`;
}

// ---- Step 5: confirm ---------------------------------------------------

confirmBtn.addEventListener("click", async () => {
  const records = buildRecords();
  if (!records.length) { alert("No records to import."); return; }
  confirmBtn.disabled = true;
  importStatus.textContent = "Importing…";
  try {
    const response = await fetch("/api/admin/import-properties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ records })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Import failed."]).join(" "));
    showResult(data);
  } catch (err) {
    importStatus.textContent = err.message;
    confirmBtn.disabled = false;
  }
});

function showResult(data) {
  step1.hidden = true;
  step2.hidden = true;
  step3.hidden = true;
  step4.hidden = true;
  step5.hidden = false;
  resultTitle.textContent = `Imported ${data.total} customer${data.total === 1 ? "" : "s"}.`;
  const bits = [];
  if (data.created) bits.push(`${data.created} new propert${data.created === 1 ? "y" : "ies"} created`);
  if (data.updated) bits.push(`${data.updated} existing propert${data.updated === 1 ? "y" : "ies"} updated`);
  resultMessage.textContent = bits.join(" · ") + ".";
  if (Array.isArray(data.errors) && data.errors.length) {
    errorList.innerHTML = data.errors.map((e) => `<li>Row ${e.row + 1}: ${escapeHtml(e.message)}</li>`).join("");
    errorList.hidden = false;
  }
}

// ---- Reset --------------------------------------------------------------

function reset() {
  parsedRows = [];
  parsedHeaders = [];
  columnMapping = {};
  delete window._wb;
  fileInput.value = "";
  step1.hidden = false;
  step2.hidden = true;
  step3.hidden = true;
  step4.hidden = true;
  step5.hidden = true;
  importStatus.textContent = "";
  errorList.hidden = true;
  errorList.innerHTML = "";
  confirmBtn.disabled = false;
}
resetBtn.addEventListener("click", reset);
resetBtn2.addEventListener("click", reset);

// ---- Helpers -----------------------------------------------------------

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});
