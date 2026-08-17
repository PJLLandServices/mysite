const containerEl = document.getElementById("quotesContainer");
const emptyEl = document.getElementById("quotesEmpty");
const filterBtns = document.querySelectorAll("[data-status-filter]");
const typeFilterBtns = document.querySelectorAll("[data-type-filter]");
const newProposalBtn = document.getElementById("newProposalBtn");
const showDeletedToggle = document.getElementById("showDeletedToggle");
const showDeletedCount = document.getElementById("showDeletedToggleCount");

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
  change_order: "Change Order",
  residential_repair: "Residential Repair",
  lighting_repair: "Landscape Lighting Repairs"
};

const ACCEPTANCE_LABELS = {
  portal_esign: "E-signed",
  pdf_return: "PDF return",
  pending: ""
};

let currentFilter = "";
let currentTypeFilter = "";
// Delete-Quotes brief: when this is on, the index re-fetches with
// ?includeDeleted=1 and renders deleted rows with subdued styling +
// a Restore action.
let showDeleted = false;

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
  // Compose query string from the status filter + the show-deleted toggle.
  const qs = [];
  if (currentFilter) qs.push(`status=${encodeURIComponent(currentFilter)}`);
  if (showDeleted) qs.push("includeDeleted=1");
  const url = qs.length ? `/api/admin/quote-folder?${qs.join("&")}` : "/api/admin/quote-folder";
  const [quotesRes, mlRes, projRes] = await Promise.all([
    fetch(url, { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    fetch("/api/material-lists?includeArchived=1", { cache: "no-store" }).then((r) => r.json()).catch(() => ({})),
    fetch("/api/projects?includeArchived=1", { cache: "no-store" }).then((r) => r.json()).catch(() => ({}))
  ]);
  let items = (quotesRes.ok && Array.isArray(quotesRes.quotes)) ? quotesRes.quotes : [];
  // Track how many of the returned items are soft-deleted so we can show
  // a count next to the toggle.
  const deletedCount = items.filter((q) => q.deletedAt).length;
  if (showDeletedCount) {
    if (showDeleted) {
      showDeletedCount.hidden = false;
      showDeletedCount.textContent = `(${deletedCount} hidden)`;
    } else {
      showDeletedCount.hidden = true;
    }
  }
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

  // Cache items so the delete-confirmation modal can read customer /
  // status / descendants without re-fetching.
  lastLoadedQuotes = items;

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
    // A combined ("two projects, one property") proposal has no line-item
    // builder — it's merged from two child quotes. Its card opens the
    // generated preview instead of the empty builder.
    const isCombined = isProposal && !!q.combined;
    // Smart-controller upgrade: an ai_repair_quote that gets the designed HCC
    // selling page (generate → phone-gated send), not the plain e-sign flow.
    const isSmartController = q.type === "ai_repair_quote" && q.narrativeKey === "smart-controller";
    const proposalHref = `/admin/quote/${encodeURIComponent(q.id)}/proposal`;
    const combinedPreviewHref = `/approve/${encodeURIComponent(q.id)}`;

    const isDeleted = !!q.deletedAt;
    const actions = [];
    if (isCombined) {
      actions.push(`<a href="${combinedPreviewHref}" target="_blank" rel="noopener">Preview combined</a>`);
      if (!isDeleted) {
        const sendLabel = (q.status === "draft" || q.status === "draft_preview") ? "Send to customer" : "Re-send";
        actions.push(`<button type="button" class="qf-card__send" data-quote-id="${escapeHtml(q.id)}" data-action="send-combined">${sendLabel}</button>`);
      }
    } else if (isSmartController) {
      if (!isDeleted) {
        actions.push(`<button type="button" data-quote-id="${escapeHtml(q.id)}" data-action="generate-sc">Generate page</button>`);
        actions.push(`<a href="/approve/${encodeURIComponent(q.id)}" target="_blank" rel="noopener">Preview</a>`);
        const sendLabel = (q.status === "draft" || q.status === "draft_preview") ? "Send to customer" : "Re-send";
        actions.push(`<button type="button" class="qf-card__send" data-quote-id="${escapeHtml(q.id)}" data-action="send-designed">${sendLabel}</button>`);
        actions.push(`<a href="/admin/smart-controller-photos" target="_blank" rel="noopener">Photos</a>`);
      }
    } else if (isProposal) {
      actions.push(`<a href="${proposalHref}">Edit proposal</a>`);
    } else if (leadHref) {
      actions.push(`<a href="${leadHref}">Open in CRM</a>`);
    }
    // Draft AI quotes (smart-controller upgrades) get the "tap Send"
    // action — fires /api/quotes/:id/send-for-approval (email + SMS +
    // portal + PDF). Already-sent ones keep a "Re-send" so a failed
    // email/SMS delivery has a retry surface. Proposals and on-site
    // quotes have their own send flows; deleted rows restore first.
    if (!isDeleted && q.type === "ai_repair_quote" && !isSmartController && (q.status === "draft" || q.status === "sent")) {
      // "View as customer" opens the exact e-sign page the customer
      // gets — drafts get a banner'd, non-signable preview link (dies
      // when the real send rotates the token); sent quotes open the
      // live link as-is.
      const previewLabel = q.status === "draft" ? "View as customer" : "Customer link";
      actions.push(`<button type="button" data-quote-id="${escapeHtml(q.id)}" data-action="preview">${previewLabel}</button>`);
      const sendLabel = q.status === "draft" ? "Send to customer" : "Re-send";
      actions.push(`<button type="button" class="qf-card__send" data-quote-id="${escapeHtml(q.id)}" data-action="send">${sendLabel}</button>`);
    }
    // PDF download stays available on deleted rows (underlying record is
    // still on disk; per brief §4 edge cases). Combined proposals are
    // HTML-only (no PDF of their own — the children have PDFs), so skip it.
    if (!isCombined) {
      actions.push(`<a href="/api/admin/quote-folder/${encodeURIComponent(q.id)}/pdf" target="_blank" rel="noopener">PDF</a>`);
    }
    if (proj) {
      actions.push(`<a href="/admin/project/${encodeURIComponent(proj.id)}">↗ ${escapeHtml(proj.id)}</a>`);
    } else if (q.status === "accepted" && !isDeleted) {
      // Convert-to-project disabled on deleted rows — restore first.
      actions.push(`<button type="button" data-quote-id="${escapeHtml(q.id)}" data-action="convert">Convert to project</button>`);
    } else if (q.status === "accepted" && isDeleted) {
      actions.push(`<button type="button" class="is-disabled" disabled title="Restore the quote before converting">Convert to project</button>`);
    }
    // Delete-Quotes brief §3.6: per-row Delete on every row regardless
    // of status. Replaced with Restore on already-deleted rows.
    if (isDeleted) {
      actions.push(`<button type="button" class="qf-card__restore" data-quote-id="${escapeHtml(q.id)}" data-action="restore">Restore</button>`);
    } else {
      actions.push(`<button type="button" class="qf-card__delete" data-quote-id="${escapeHtml(q.id)}" data-action="delete">Delete</button>`);
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
    // Deleted rows do NOT open on tap (no card-level navigation) — Patrick
    // has to Restore first; the inner action buttons still work.
    const cardHref = (!isDeleted && (isCombined ? combinedPreviewHref : isProposal ? proposalHref : leadHref)) || "";
    const cardClass = `qf-card${isDeleted ? " qf-card--deleted" : ""}`;
    const deletedTag = isDeleted
      ? `<span class="qf-card__deleted-tag" title="Deleted ${escapeHtml(fmtDate(q.deletedAt))}${q.deletedBy ? " by " + escapeHtml(q.deletedBy) : ""}">deleted</span>`
      : "";

    return `
      <article class="${cardClass}" data-quote-id="${escapeHtml(q.id)}"${cardHref ? ` data-href="${cardHref}"` : ""}>
        <header class="qf-card__head">
          <span class="qf-card__id">${escapeHtml(q.id)}${versionTag}${deletedTag}</span>
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

// Compose the descendant-warning string for the delete confirmation
// modal. Returns "" when the quote has no descendants — the modal
// renders no warning paragraph in that case. The /api/admin/quote-folder
// endpoint enriches every quote with this `descendants` block.
function describeDescendants(q) {
  const d = q && q.descendants;
  if (!d) return "";
  const parts = [];
  if (Array.isArray(d.bookingIds) && d.bookingIds.length) {
    parts.push(`${d.bookingIds.length} booking${d.bookingIds.length === 1 ? "" : "s"}`);
  }
  if (Array.isArray(d.projectIds) && d.projectIds.length) {
    parts.push(`${d.projectIds.length} project${d.projectIds.length === 1 ? "" : "s"} (${d.projectIds.join(", ")})`);
  }
  if (Array.isArray(d.workOrderIds) && d.workOrderIds.length) {
    parts.push(`${d.workOrderIds.length} work order${d.workOrderIds.length === 1 ? "" : "s"} (${d.workOrderIds.join(", ")})`);
  }
  if (Array.isArray(d.invoiceIds) && d.invoiceIds.length) {
    parts.push(`${d.invoiceIds.length} invoice${d.invoiceIds.length === 1 ? "" : "s"} (${d.invoiceIds.join(", ")})`);
  }
  if (Array.isArray(d.materialListIds) && d.materialListIds.length) {
    parts.push(`${d.materialListIds.length} material list${d.materialListIds.length === 1 ? "" : "s"}`);
  }
  if (!parts.length) return "";
  return `⚠ This quote is linked to: ${parts.join("; ")}. Those records will remain intact, but the source quote will no longer appear in the index.`;
}

async function deleteQuote(quoteId) {
  // Find the cached quote record so we can show customer / status in the
  // modal and surface the descendant warning. The card payload includes
  // descendants{} from /api/admin/quote-folder.
  const card = containerEl.querySelector(`.qf-card[data-quote-id="${CSS.escape(quoteId)}"]`);
  const cached = lastLoadedQuotes.find((q) => q.id === quoteId);
  const status = cached ? cached.status : "";
  const customer = (cached && cached.customerEmail) || "(no email)";
  const warning = cached ? describeDescendants(cached) : "";

  const confirmed = window.pjlBulkModal
    ? await window.pjlBulkModal.confirm({
        title: "Delete this quote?",
        body: `${quoteId} — ${customer}${status ? " — " + status : ""}\n\nThe quote will be removed from this list. It can be restored later from the "Show deleted" view. Linked bookings, projects, and invoices are not affected.`,
        warning,
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        destructive: true
      })
    : window.confirm(`Delete ${quoteId}? (Restore later via "Show deleted".)`);

  if (!confirmed) return;

  try {
    const r = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}`, { method: "DELETE" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      alert((data.errors && data.errors[0]) || `Couldn't delete (${r.status})`);
      return;
    }
    // Optimistic remove if not in show-deleted mode; otherwise re-fetch
    // so the row gets the deleted styling + Restore button.
    if (!showDeleted && card) {
      card.remove();
    } else {
      load();
    }
  } catch (err) {
    alert(err.message || "Couldn't delete quote.");
  }
}

// Patrick's "tap Send" on a draft AI quote. Confirms, fires the send
// endpoint (email w/ PDF + SMS + portal unlock), and surfaces per-channel
// failures — a markSent quote with a failed email needs a re-send, not
// silence.
async function sendQuote(quoteId) {
  const cached = lastLoadedQuotes.find((q) => q.id === quoteId);
  const customer = (cached && cached.customerEmail) || "(no email)";
  const total = cached && Number.isFinite(Number(cached.total))
    ? ` — $${Number(cached.total).toFixed(2)} incl. HST`
    : "";
  if (!confirm(`Send ${quoteId} to ${customer}${total}?\n\nThe customer gets an email with the quote PDF plus an SMS, and can accept it in their portal.`)) return;
  try {
    const r = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/send-for-approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      alert((data.errors && data.errors[0]) || `Couldn't send (${r.status})`);
      return;
    }
    const problems = [];
    if (data.emailError) problems.push(`Email failed: ${data.emailError}`);
    if (data.smsError) problems.push(`SMS failed: ${data.smsError}`);
    if (problems.length) {
      alert(`${quoteId} marked sent, but:\n${problems.join("\n")}\n\nUse Re-send to retry delivery.`);
    }
    load();
  } catch (err) {
    alert(err.message || "Couldn't send quote.");
  }
}

// Send a combined ("two projects") proposal to the customer. It's HTML-only
// behind the phone gate, so the customer gets a link (no PDF attachment) and
// verifies their phone to open it. Pre-fills the on-file email; editable.
async function sendCombined(quoteId) {
  const cached = lastLoadedQuotes.find((q) => q.id === quoteId);
  const onFile = (cached && cached.customerEmail) || "";
  const total = cached && Number.isFinite(Number(cached.total))
    ? ` — $${Number(cached.total).toFixed(2)} incl. HST`
    : "";
  const to = prompt(`Send the combined proposal ${quoteId}${total} to the customer.\n\nThey'll get a link and verify their phone to open it.\n\nEmail address:`, onFile);
  if (to == null) return; // cancelled
  const email = String(to).trim();
  if (!email) { alert("An email address is required to send."); return; }
  try {
    const r = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/send-proposal-for-approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sendEmail: true, email })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      alert((data.errors && data.errors[0]) || `Couldn't send (${r.status})`);
      return;
    }
    if (data.emailError) alert(`${quoteId} marked sent, but email failed: ${data.emailError}\n\nUse Re-send to retry.`);
    else alert(`Sent to ${email}. The customer gets a link to the combined proposal.`);
    load();
  } catch (err) {
    alert(err.message || "Couldn't send the combined proposal.");
  }
}

// Generate the designed smart-controller page (writes the phone-gated doc,
// embedding the current design photos). Offers to open the preview after.
async function generateSmartControllerPage(quoteId) {
  try {
    const r = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/generate-proposal-page`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({})
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) { alert((data.errors && data.errors[0]) || `Couldn't generate (${r.status})`); return; }
    if (confirm(`Page generated for ${quoteId}. Open the preview?`)) {
      window.open(`/approve/${encodeURIComponent(quoteId)}`, "_blank");
    }
    load();
  } catch (err) { alert(err.message || "Couldn't generate the page."); }
}

// Send a designed, phone-gated proposal (smart-controller upgrade) to the
// customer — the customer gets a link and verifies their phone to open it.
async function sendSmartController(quoteId) {
  const cached = lastLoadedQuotes.find((q) => q.id === quoteId);
  if (cached && !cached.proposalDocument) {
    if (!confirm(`Heads up: the page for ${quoteId} hasn't been generated yet — the customer would get the plain quote, not the designed page.\n\nGenerate it first (click "Generate page"), or OK to send anyway.`)) return;
  }
  const onFile = (cached && cached.customerEmail) || "";
  const total = cached && Number.isFinite(Number(cached.total))
    ? ` — $${Number(cached.total).toFixed(2)} incl. HST` : "";
  const to = prompt(`Send the smart-controller upgrade ${quoteId}${total} to the customer.\n\nThey'll get a link and verify their phone to open it.\n\nEmail address:`, onFile);
  if (to == null) return;
  const email = String(to).trim();
  if (!email) { alert("An email address is required to send."); return; }
  try {
    const r = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/send-proposal-for-approval`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sendEmail: true, email })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) { alert((data.errors && data.errors[0]) || `Couldn't send (${r.status})`); return; }
    if (data.emailError) alert(`${quoteId} marked sent, but email failed: ${data.emailError}\n\nUse Re-send to retry.`);
    else alert(`Sent to ${email}. The customer gets a link to the upgrade proposal.`);
    load();
  } catch (err) { alert(err.message || "Couldn't send the upgrade proposal."); }
}

// "View as customer" — opens the customer's exact e-sign page. The tab
// is opened SYNCHRONOUSLY (before the fetch) so iOS Safari's popup
// blocker doesn't eat it; the URL lands once the server answers.
async function previewQuote(quoteId) {
  const tab = window.open("about:blank", "_blank");
  try {
    const r = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok || !data.previewUrl) {
      if (tab) tab.close();
      alert((data.errors && data.errors[0]) || `Couldn't open the preview (${r.status})`);
      return;
    }
    if (tab) tab.location = data.previewUrl;
    else window.location.href = data.previewUrl; // popup blocked — same-tab fallback
  } catch (err) {
    if (tab) tab.close();
    alert(err.message || "Couldn't open the preview.");
  }
}

async function restoreQuote(quoteId) {
  // No modal needed for restore — single-step action per brief §3.6.
  try {
    const r = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/restore`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      alert((data.errors && data.errors[0]) || `Couldn't restore (${r.status})`);
      return;
    }
    load();
  } catch (err) {
    alert(err.message || "Couldn't restore quote.");
  }
}

// The last response from /api/admin/quote-folder, cached so the delete
// modal can read customer/status/descendants without an extra fetch.
let lastLoadedQuotes = [];

// Delegated click handler for both the convert button + materials link,
// and for card-level navigation. The card root is the tap target for
// "open the quote in CRM"; inner anchors, buttons, and the bulk-select
// checkbox short-circuit that so they execute their own actions instead
// of also navigating away.
containerEl.addEventListener("click", (event) => {
  const convertBtn = event.target.closest("[data-action='convert']");
  if (convertBtn && !convertBtn.disabled) {
    event.preventDefault();
    convertToProject(convertBtn.dataset.quoteId);
    return;
  }
  const deleteBtn = event.target.closest("[data-action='delete']");
  if (deleteBtn) {
    event.preventDefault();
    deleteQuote(deleteBtn.dataset.quoteId);
    return;
  }
  const sendBtn = event.target.closest("[data-action='send']");
  if (sendBtn) {
    event.preventDefault();
    sendQuote(sendBtn.dataset.quoteId);
    return;
  }
  const sendCombinedBtn = event.target.closest("[data-action='send-combined']");
  if (sendCombinedBtn) {
    event.preventDefault();
    sendCombined(sendCombinedBtn.dataset.quoteId);
    return;
  }
  const genScBtn = event.target.closest("[data-action='generate-sc']");
  if (genScBtn) {
    event.preventDefault();
    generateSmartControllerPage(genScBtn.dataset.quoteId);
    return;
  }
  const sendDesignedBtn = event.target.closest("[data-action='send-designed']");
  if (sendDesignedBtn) {
    event.preventDefault();
    sendSmartController(sendDesignedBtn.dataset.quoteId);
    return;
  }
  const previewBtn = event.target.closest("[data-action='preview']");
  if (previewBtn) {
    event.preventDefault();
    previewQuote(previewBtn.dataset.quoteId);
    return;
  }
  const restoreBtn = event.target.closest("[data-action='restore']");
  if (restoreBtn) {
    event.preventDefault();
    restoreQuote(restoreBtn.dataset.quoteId);
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

// Show-deleted toggle — re-fetches with ?includeDeleted=1 when on and
// renders deleted rows with subdued styling + Restore action. Delete-
// Quotes brief §3.6.
if (showDeletedToggle) {
  showDeletedToggle.addEventListener("change", () => {
    showDeleted = !!showDeletedToggle.checked;
    load();
  });
}

// ---- +New Smart Controller Quote (brief 2026-06-12) -------------------
// Selections only: customer (always), property (only when the customer
// has several), zone count (only when none is on file — the pick saves
// back to the property). The server auto-populates everything else and
// answers with 422 codes (property_required / zone_count_required) that
// progressively reveal the extra selectors.
const scq = {
  backdrop: document.getElementById("scqBackdrop"),
  openBtn: document.getElementById("newControllerQuoteBtn"),
  customer: document.getElementById("scqCustomer"),
  propertyField: document.getElementById("scqPropertyField"),
  property: document.getElementById("scqProperty"),
  zonesField: document.getElementById("scqZonesField"),
  zones: document.getElementById("scqZones"),
  zonesNote: document.getElementById("scqZonesNote"),
  serviceCall: document.getElementById("scqServiceCall"),
  status: document.getElementById("scqStatus"),
  cancel: document.getElementById("scqCancel"),
  create: document.getElementById("scqCreate"),
  customersLoaded: false
};

function scqReset() {
  scq.propertyField.hidden = true;
  scq.property.innerHTML = "";
  scq.zonesField.hidden = true;
  scq.zones.value = "";
  scq.zonesNote.textContent = "";
  scq.serviceCall.value = ""; // per-quote decision — always re-ask
  scq.status.textContent = "";
  scq.create.disabled = false;
}

async function scqLoadCustomers() {
  if (scq.customersLoaded) return;
  try {
    const r = await fetch("/api/customers", { cache: "no-store" });
    const data = await r.json();
    const customers = (data.customers || []).slice().sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""))
    );
    scq.customer.innerHTML = `<option value="">Pick a customer…</option>` + customers.map((c) =>
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name || "(no name)")} — ${escapeHtml(c.email || "no email")}</option>`
    ).join("");
    scq.customersLoaded = true;
  } catch (err) {
    scq.customer.innerHTML = `<option value="">Couldn't load customers</option>`;
  }
}

if (scq.openBtn) {
  // Zone options 1–16 (priced tiers) + 17+ (custom branch, lead only).
  scq.zones.innerHTML = `<option value="">Pick zone count…</option>` +
    Array.from({ length: 16 }, (_, i) => `<option value="${i + 1}">${i + 1} zone${i ? "s" : ""}</option>`).join("") +
    `<option value="17">17+ zones (custom — captures a lead, no priced quote)</option>`;

  scq.openBtn.addEventListener("click", (e) => {
    e.preventDefault();
    scqReset();
    scq.backdrop.hidden = false;
    scqLoadCustomers();
  });
  scq.cancel.addEventListener("click", () => { scq.backdrop.hidden = true; });
  scq.backdrop.addEventListener("click", (e) => {
    if (e.target === scq.backdrop) scq.backdrop.hidden = true;
  });
  scq.customer.addEventListener("change", scqReset);

  scq.create.addEventListener("click", async () => {
    const customerId = scq.customer.value;
    if (!customerId) { scq.status.textContent = "Pick a customer first."; return; }
    // Service call is Patrick's explicit per-quote call — no default.
    // (Ignored server-side for the 17+ custom branch, but asking up
    // front keeps the modal a single pass.)
    if (!scq.serviceCall.value) { scq.status.textContent = "Charge or waive the service call?"; return; }
    const body = { customerId, serviceCall: scq.serviceCall.value };
    if (!scq.propertyField.hidden && scq.property.value) body.propertyId = scq.property.value;
    if (!scq.zonesField.hidden && scq.zones.value) body.zoneCount = Number(scq.zones.value);
    scq.create.disabled = true;
    scq.status.textContent = "Creating…";
    try {
      const r = await fetch("/api/admin/smart-controller-quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await r.json().catch(() => ({}));
      scq.create.disabled = false;
      if (r.status === 422 && data.code === "property_required") {
        scq.property.innerHTML = `<option value="">Pick a property…</option>` + (data.properties || []).map((p) =>
          `<option value="${escapeHtml(p.id)}">${escapeHtml(p.address)}</option>`
        ).join("");
        scq.propertyField.hidden = false;
        scq.status.textContent = "This customer has multiple properties — pick the one getting the controller.";
        return;
      }
      if (r.status === 422 && data.code === "zone_count_required") {
        scq.zonesField.hidden = false;
        scq.zonesNote.textContent = "(saves back to the property for next time)";
        scq.status.textContent = "No zone count on file — pick one.";
        return;
      }
      if (!r.ok || !data.ok) {
        scq.status.textContent = (data.errors && data.errors[0]) || `Couldn't create (${r.status})`;
        return;
      }
      if (data.existing) {
        scq.backdrop.hidden = true;
        alert(`A smart-controller draft already exists for this property — ${data.quote.id}. Opening the folder so you can review and send it.`);
        load();
        return;
      }
      if (data.custom) {
        scq.backdrop.hidden = true;
        alert(`${data.zones}+ zones is a custom quote — captured as a CRM lead instead (no priced quote). You'll find it in the CRM.`);
        load();
        return;
      }
      scq.backdrop.hidden = true;
      alert(`Draft ${data.quote.id} created — review the PDF, then tap "Send to customer".`);
      load();
    } catch (err) {
      scq.create.disabled = false;
      scq.status.textContent = err.message || "Couldn't create the quote.";
    }
  });
}

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
