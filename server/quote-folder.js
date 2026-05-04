const tableBody = document.getElementById("quotesBody");
const tableEl = document.getElementById("quotesTable");
const emptyEl = document.getElementById("quotesEmpty");
const filterBtns = document.querySelectorAll("[data-status-filter]");

const TYPE_LABELS = {
  ai_repair_quote: "AI repair",
  on_site_quote: "On-site",
  formal_quote: "Formal"
};

let currentFilter = "";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmt(n) { return "$" + (Number(n) || 0).toFixed(2); }
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

// Phase 2 — fetched alongside quotes so each row can render a chip
// showing "X lists" attached and surface "Convert to project" /
// "Open project" depending on whether a project already exists for the
// quote.
let mlCountByQuote = new Map();    // quoteId -> count of attached lists
let projectByQuote = new Map();    // quoteId -> project record (if exists)

async function load() {
  const url = currentFilter ? `/api/admin/quote-folder?status=${encodeURIComponent(currentFilter)}` : "/api/admin/quote-folder";
  const [quotesRes, mlRes, projRes] = await Promise.all([
    fetch(url, { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    fetch("/api/material-lists?includeArchived=1", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    fetch("/api/projects?includeArchived=1", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}))
  ]);
  const items = (quotesRes.ok && Array.isArray(quotesRes.quotes)) ? quotesRes.quotes : [];
  // Build the per-quote indices.
  mlCountByQuote = new Map();
  for (const ml of (mlRes.lists || [])) {
    if (ml.parentType === "quote" && ml.parentId) {
      mlCountByQuote.set(ml.parentId, (mlCountByQuote.get(ml.parentId) || 0) + 1);
    }
  }
  projectByQuote = new Map();
  for (const p of (projRes.projects || [])) {
    if (p.sourceQuoteId) projectByQuote.set(p.sourceQuoteId, p);
  }

  if (!items.length) {
    tableEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  tableEl.hidden = false;
  tableBody.innerHTML = items.map((q) => {
    // Lead deep-link if we have a leadId — quotes don't have their own
    // detail page yet, so the lead detail (which embeds the Quote card)
    // is the closest thing to a "quote view."
    const customer = q.customerEmail || "(no email)";
    const leadLink = q.leadId
      ? `<a href="/admin#lead-${encodeURIComponent(q.leadId)}">Open in CRM</a>`
      : "—";
    const mlCount = mlCountByQuote.get(q.id) || 0;
    const proj = projectByQuote.get(q.id);
    const mlChip = mlCount
      ? `<a class="invoices-row-sub" href="/admin/material-lists" data-quote-id="${escapeHtml(q.id)}" data-action="filter-materials">📋 ${mlCount} list${mlCount === 1 ? "" : "s"}</a>`
      : `<span class="invoices-row-sub" style="color:#7A7A72">no materials</span>`;
    const projAction = proj
      ? `<a class="invoices-row-sub" href="/admin/project/${encodeURIComponent(proj.id)}">↗ ${escapeHtml(proj.id)}</a>`
      : `<button type="button" class="invoices-row-sub" data-quote-id="${escapeHtml(q.id)}" data-action="convert" style="background:none;border:none;color:#1B4D2E;cursor:pointer;text-decoration:underline;padding:0;font:inherit">Convert to project</button>`;
    return `
      <tr>
        <td>
          <strong>${escapeHtml(q.id)}</strong>${q.version > 1 ? ` <span class="invoices-row-sub">v${q.version}</span>` : ""}
          <br><a class="invoices-row-sub" href="/api/admin/quote-folder/${encodeURIComponent(q.id)}/pdf" target="_blank" rel="noopener">📄 PDF</a>
        </td>
        <td>${escapeHtml(TYPE_LABELS[q.type] || q.type)}</td>
        <td>${escapeHtml(customer)}<br><span class="invoices-row-sub">${leadLink}</span></td>
        <td class="invoices-amount">${fmt(q.total)}</td>
        <td><span class="invoices-status invoices-status--${escapeHtml(q.status)}">${escapeHtml(q.status)}</span></td>
        <td>${escapeHtml(fmtDate(q.createdAt))}${q.validUntil ? `<br><span class="invoices-row-sub">expires ${escapeHtml(fmtDate(q.validUntil))}</span>` : ""}</td>
        <td>${mlChip}<br>${projAction}</td>
      </tr>
    `;
  }).join("");
}

async function convertToProject(quoteId) {
  if (!confirm(`Spin up a new project from ${quoteId}? Any material lists attached to this quote will move to the new project.`)) return;
  try {
    const r = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/convert-to-project`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      alert((data.errors && data.errors[0]) || `Couldn't convert (${r.status})`);
      return;
    }
    if (data.alreadyExisted) {
      // Already-converted — go to the existing project rather than create a duplicate.
      alert(`A project for ${quoteId} already exists (${data.project.id}). Opening it.`);
    }
    location.href = `/admin/project/${encodeURIComponent(data.project.id)}`;
  } catch (err) {
    alert(err.message || "Couldn't convert quote to project.");
  }
}

// Delegated click handler for both the convert button and the materials
// filter link (the latter just navigates — the materials index then
// filters client-side via its own search box).
tableBody.addEventListener("click", (event) => {
  const convertBtn = event.target.closest("[data-action='convert']");
  if (convertBtn) {
    event.preventDefault();
    convertToProject(convertBtn.dataset.quoteId);
    return;
  }
});

filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.statusFilter || "";
    filterBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
    load();
  });
});

load();
