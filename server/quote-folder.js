const containerEl = document.getElementById("quotesContainer");
const emptyEl = document.getElementById("quotesEmpty");
const filterBtns = document.querySelectorAll("[data-status-filter]");
const typeFilterBtns = document.querySelectorAll("[data-type-filter]");
const newProposalBtn = document.getElementById("newProposalBtn");

const TYPE_LABELS = {
  ai_repair_quote: "AI repair quote",
  on_site_quote: "On-site quote",
  formal_quote: "Formal quote",
  project_proposal: "Project proposal"
};

const BRANCH_LABELS = {
  gc_subcontract: "GC Subcontract",
  direct_residential: "Residential",
  lighting_design: "Lighting Design",
  renovation_coordination: "Renovation",
  change_order: "Change Order"
};

const ACCEPTANCE_LABELS = {
  portal_esign: "E-signed",
  pdf_return: "PDF return",
  pending: ""
};

let currentFilter = "";
let currentTypeFilter = "";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

// Phase 2 — fetched alongside quotes so each card can render a chip
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
  let items = (quotesRes.ok && Array.isArray(quotesRes.quotes)) ? quotesRes.quotes : [];
  // Type filter — applied client-side so a single fetch covers both filters.
  if (currentTypeFilter) {
    items = items.filter((q) => q.type === currentTypeFilter);
  }
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
    containerEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  containerEl.hidden = false;
  containerEl.innerHTML = items.map((q) => {
    // Lead deep-link if we have a leadId — quotes don't have their own
    // detail page yet, so the lead detail (which embeds the Quote card)
    // is the closest thing to a "quote view." The card itself opens this
    // URL on tap (see the delegated click handler below); "Open in CRM"
    // is also kept as an explicit action link for desktop affordance.
    const customer = q.customerEmail || "(no email)";
    const leadHref = q.leadId ? `/admin#lead-${encodeURIComponent(q.leadId)}` : "";
    const mlCount = mlCountByQuote.get(q.id) || 0;
    const proj = projectByQuote.get(q.id);

    // Material status — preserve the existing derivation (chip with count
    // when there are attached lists, "no materials" otherwise).
    const materialsLine = mlCount
      ? `<a href="/admin/material-lists" data-quote-id="${escapeHtml(q.id)}" data-action="filter-materials">📋 ${mlCount} list${mlCount === 1 ? "" : "s"}</a>`
      : `no materials`;

    // Proposal-aware actions: project_proposal quotes get an "Edit
    // proposal" link to the builder; other types keep the existing
    // "Open in CRM" lead deep-link.
    const isProposal = q.type === "project_proposal";
    const proposalHref = `/admin/quote/${encodeURIComponent(q.id)}/proposal`;

    const actions = [];
    if (isProposal) {
      actions.push(`<a href="${proposalHref}">Edit proposal</a>`);
    } else if (leadHref) {
      actions.push(`<a href="${leadHref}">Open in CRM</a>`);
    }
    actions.push(`<a href="/api/admin/quote-folder/${encodeURIComponent(q.id)}/pdf" target="_blank" rel="noopener">PDF</a>`);
    if (proj) {
      actions.push(`<a href="/admin/project/${encodeURIComponent(proj.id)}">↗ ${escapeHtml(proj.id)}</a>`);
    } else if (q.status === "accepted") {
      actions.push(`<button type="button" data-quote-id="${escapeHtml(q.id)}" data-action="convert">Convert to project</button>`);
    }
    const actionsHtml = actions.join(`<span class="qf-card__sep" aria-hidden="true">·</span>`);

    const versionTag = q.version > 1 ? `<span class="qf-card__id-version">v${escapeHtml(q.version)}</span>` : "";
    const typeLabel = TYPE_LABELS[q.type] || q.type || "Quote";
    const branchTag = isProposal && q.branch && BRANCH_LABELS[q.branch]
      ? `<span class="qf-card__branch">${escapeHtml(BRANCH_LABELS[q.branch])}</span>`
      : "";
    const acceptanceTag = isProposal && q.acceptanceMethod && ACCEPTANCE_LABELS[q.acceptanceMethod]
      ? `<span class="qf-card__accept" data-method="${escapeHtml(q.acceptanceMethod)}">${escapeHtml(ACCEPTANCE_LABELS[q.acceptanceMethod])}</span>`
      : "";
    const supersededTag = q.supersededBy
      ? `<span class="qf-card__superseded" title="Superseded by ${escapeHtml(q.supersededBy)}">superseded by ${escapeHtml(q.supersededBy)}</span>`
      : "";
    const datesLine = q.validUntil
      ? `${escapeHtml(fmtDate(q.createdAt))} <span class="qf-card__sep" aria-hidden="true">·</span> expires ${escapeHtml(fmtDate(q.validUntil))}`
      : escapeHtml(fmtDate(q.createdAt));

    // For proposals, the card itself opens the builder (not the lead).
    const cardHref = isProposal ? proposalHref : leadHref;

    return `
      <article class="qf-card" data-quote-id="${escapeHtml(q.id)}"${cardHref ? ` data-href="${cardHref}"` : ""}>
        <header class="qf-card__head">
          <span class="qf-card__id">${escapeHtml(q.id)}${versionTag}</span>
          <span class="qf-card__status invoices-status invoices-status--${escapeHtml(q.status)}">${escapeHtml(q.status)}</span>
          ${acceptanceTag}
        </header>
        <p class="qf-card__type">${escapeHtml(typeLabel)}${branchTag ? " " + branchTag : ""}</p>
        <p class="qf-card__customer">${escapeHtml(customer)}</p>
        <p class="qf-card__dates">${datesLine}</p>
        ${supersededTag ? `<p class="qf-card__lineage">${supersededTag}</p>` : ""}
        <p class="qf-card__materials">${materialsLine}</p>
        <nav class="qf-card__actions">${actionsHtml}</nav>
      </article>
    `;
  }).join("");
  // Wire bulk-selection toolbar (Session 2 brief). Re-runs on each render.
  if (window.pjlBulkWiring) {
    window.pjlBulkWiring.attach("quotes", {
      onActionComplete: () => { try { load(); } catch {} }
    });
  }
  // bulk-selection.js injects the checkbox-wrap as the first child of each
  // <article>. We want it visually inline with the Q-ID in the header row
  // (not in its own indent column), so relocate it into <header> after the
  // injection. Idempotent: if the wrap is already inside the header (re-
  // render path), the querySelector(':scope > .pjl-bulk-checkbox-wrap')
  // won't match and the move is skipped.
  containerEl.querySelectorAll(".qf-card").forEach((card) => {
    const wrap = card.querySelector(":scope > .pjl-bulk-checkbox-wrap");
    const head = card.querySelector(":scope > .qf-card__head");
    if (wrap && head) head.insertBefore(wrap, head.firstChild);
  });
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

// Delegated click handler for both the convert button + materials link,
// and for card-level navigation. The card root is the tap target for
// "open the quote in CRM"; inner anchors, buttons, and the bulk-select
// checkbox short-circuit that so they execute their own actions instead
// of also navigating away.
containerEl.addEventListener("click", (event) => {
  const convertBtn = event.target.closest("[data-action='convert']");
  if (convertBtn) {
    event.preventDefault();
    convertToProject(convertBtn.dataset.quoteId);
    return;
  }
  // Inner anchors, buttons, or the bulk-select checkbox: let them handle
  // themselves — don't fire the card-level navigation.
  if (event.target.closest("a, button, .pjl-bulk-checkbox-wrap, input[type='checkbox']")) return;

  const card = event.target.closest(".qf-card");
  if (card && card.dataset.href) {
    location.href = card.dataset.href;
  }
});

filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.statusFilter || "";
    filterBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
    load();
  });
});

typeFilterBtns.forEach((btn) => {
  btn.addEventListener("click", (e) => {
    if (btn.id === "newProposalBtn") return; // skip — the anchor isn't a filter
    e.preventDefault();
    currentTypeFilter = btn.dataset.typeFilter || "";
    typeFilterBtns.forEach((b) => {
      if (b.id !== "newProposalBtn") b.classList.toggle("is-active", b === btn);
    });
    load();
  });
});

// New project proposal — admin path. Creates a draft via POST and
// redirects into the builder.
if (newProposalBtn) {
  newProposalBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    const email = prompt("Customer email for the new proposal (can be edited in the builder):");
    if (email === null) return; // cancelled
    try {
      const r = await fetch("/api/quotes/proposal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerEmail: (email || "").trim(),
          billingMode: "fixed_price"
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        alert(data.errors?.[0] || `Couldn't create proposal (${r.status})`);
        return;
      }
      location.href = `/admin/quote/${encodeURIComponent(data.quote.id)}/proposal`;
    } catch (err) {
      alert(err.message || "Couldn't create proposal.");
    }
  });
}

load();
