// Mobile nav hamburger toggle — slides the link panel down on tap.
// CSS handles all visual states (the .is-open class drives both the
// hamburger icon morph and the panel transform).
(function setupNavToggle() {
  const toggle = document.getElementById("navToggle");
  const nav = document.querySelector(".pjl-admin-nav");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  // Close the menu when any link inside it is tapped — otherwise it stays
  // open over the next page on browsers that bf-cache the previous DOM.
  nav.querySelectorAll(".pjl-nav-links a").forEach((a) => {
    a.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
})();

const leadList = document.getElementById("leadList");
const kanbanBoard = document.getElementById("kanbanBoard");
const crmMain = document.getElementById("crmMain");
const crmWorkspace = document.getElementById("crmWorkspace");
const selectToggle = document.getElementById("selectToggle");
const detailClose = document.getElementById("detailClose");
const detailBackdrop = document.getElementById("detailBackdrop");
const filtersToggle = document.getElementById("filtersToggle");
const crmSidebar = document.getElementById("crmSidebar");
const emptyState = document.getElementById("emptyState");
const openCount = document.getElementById("openCount");
const pipelineValue = document.getElementById("pipelineValue");
const dueCount = document.getElementById("dueCount");
const wonValue = document.getElementById("wonValue");
const leadSearch = document.getElementById("leadSearch");
const refreshLeads = document.getElementById("refreshLeads");
const logoutButton = document.getElementById("logoutButton");
const statusFilter = document.getElementById("statusFilter");
const priorityFilter = document.getElementById("priorityFilter");
const sourceFilter = document.getElementById("sourceFilter");
const showArchived = document.getElementById("showArchived");
const archivedCount = document.getElementById("archivedCount");
const pipelineTabs = document.getElementById("pipelineTabs");
const viewListBtn = document.getElementById("viewList");
const viewKanbanBtn = document.getElementById("viewKanban");
const bulkToolbar = document.getElementById("bulkToolbar");
const bulkCount = document.getElementById("bulkCount");
const bulkStatus = document.getElementById("bulkStatus");
const bulkPriority = document.getElementById("bulkPriority");
const bulkArchive = document.getElementById("bulkArchive");
const bulkClear = document.getElementById("bulkClear");
const bulkDelete = document.getElementById("bulkDelete");
const deleteLeadButton = document.getElementById("deleteLeadButton");
const leadConfirmModal = document.getElementById("leadConfirmModal");
const leadConfirmTitle = document.getElementById("leadConfirmTitle");
const leadConfirmBody = document.getElementById("leadConfirmBody");
const leadConfirmInput = document.getElementById("leadConfirmInput");
const leadConfirmError = document.getElementById("leadConfirmError");
const leadConfirmCancel = document.getElementById("leadConfirmCancel");
const leadConfirmAccept = document.getElementById("leadConfirmAccept");
const detailEmpty = document.getElementById("detailEmpty");
const leadEditor = document.getElementById("leadEditor");
const detailStage = document.getElementById("detailStage");
const detailName = document.getElementById("detailName");
const detailAddress = document.getElementById("detailAddress");
const detailSource = document.getElementById("detailSource");
const detailValue = document.getElementById("detailValue");
const callLink = document.getElementById("callLink");
const emailLink = document.getElementById("emailLink");
const vcardLink = document.getElementById("vcardLink");
const portalLink = document.getElementById("portalLink");
const contactPreview = document.getElementById("contactPreview");
const detailFeatures = document.getElementById("detailFeatures");
const detailQuoteSection = document.getElementById("detailQuoteSection");
const detailQuoteId = document.getElementById("detailQuoteId");
const detailQuoteStatus = document.getElementById("detailQuoteStatus");
const detailQuoteTotal = document.getElementById("detailQuoteTotal");
const detailQuoteSubtotal = document.getElementById("detailQuoteSubtotal");
const detailQuoteScope = document.getElementById("detailQuoteScope");
const detailQuoteIntake = document.getElementById("detailQuoteIntake");
const detailQuoteItems = document.getElementById("detailQuoteItems");
const detailQuoteDates = document.getElementById("detailQuoteDates");
const detailQuoteSendWrap = document.getElementById("detailQuoteSendWrap");
const detailQuoteSendBtn = document.getElementById("detailQuoteSendBtn");
const detailQuotePreviewBtn = document.getElementById("detailQuotePreviewBtn");
const detailQuoteSendStatus = document.getElementById("detailQuoteSendStatus");
const detailPropertySection = document.getElementById("detailPropertySection");
const detailPropertyMeta = document.getElementById("detailPropertyMeta");
const detailPropertyOpen = document.getElementById("detailPropertyOpen");
const detailPropertyLinkBtn = document.getElementById("detailPropertyLinkBtn");
const detailPropertySuggest = document.getElementById("detailPropertySuggest");
const detailPropertySuggestList = document.getElementById("detailPropertySuggestList");
const detailPropertyDismissBtn = document.getElementById("detailPropertyDismissBtn");
const detailPropertyEmpty = document.getElementById("detailPropertyEmpty");
const detailPropertyFilled = document.getElementById("detailPropertyFilled");
const detailPropertyAttachBtn = document.getElementById("detailPropertyAttachBtn");
const detailPropertyLinkBtnEmpty = document.getElementById("detailPropertyLinkBtnEmpty");
const detailPropertyEmptyHelp = document.getElementById("detailPropertyEmptyHelp");
const propertyPickerDialog = document.getElementById("propertyPickerDialog");
const propertyPickerSearch = document.getElementById("propertyPickerSearch");
const propertyPickerResults = document.getElementById("propertyPickerResults");
const propertyPickerCancel = document.getElementById("propertyPickerCancel");
const detailWorkOrderSection = document.getElementById("detailWorkOrderSection");
const detailWorkOrderId = document.getElementById("detailWorkOrderId");
const detailWorkOrderStatus = document.getElementById("detailWorkOrderStatus");
const detailWorkOrderWhen = document.getElementById("detailWorkOrderWhen");
const detailWorkOrderService = document.getElementById("detailWorkOrderService");
const detailWorkOrderZones = document.getElementById("detailWorkOrderZones");
const detailWorkOrderPrice = document.getElementById("detailWorkOrderPrice");
const detailWorkOrderNote = document.getElementById("detailWorkOrderNote");
const detailWorkOrderDiagnosis = document.getElementById("detailWorkOrderDiagnosis");
const detailWorkOrderDiagnosisSummary = document.getElementById("detailWorkOrderDiagnosisSummary");
const detailWorkOrderDiagnosisText = document.getElementById("detailWorkOrderDiagnosisText");
const detailFieldWoSection = document.getElementById("detailFieldWoSection");
const detailFieldWoList = document.getElementById("detailFieldWoList");
const detailFieldWoNolink = document.getElementById("detailFieldWoNolink");
const createWoSpring = document.getElementById("createWoSpring");
const createWoFall = document.getElementById("createWoFall");
const createWoVisit = document.getElementById("createWoVisit");
const woWaiveFee = document.getElementById("woWaiveFee");
const woWaiveDetail = document.getElementById("woWaiveDetail");
const woWaiveReason = document.getElementById("woWaiveReason");
const woWaiveNotes = document.getElementById("woWaiveNotes");
const woWaiveNotesHint = document.getElementById("woWaiveNotesHint");
const woWaiveErr = document.getElementById("woWaiveErr");
const woWaiveFeeAmount = document.getElementById("woWaiveFeeAmount");
const customerNotes = document.getElementById("customerNotes");
const detailBillingSection = document.getElementById("detailBillingSection");
const detailBilling = document.getElementById("detailBilling");
const detailCommercialSection = document.getElementById("detailCommercialSection");
const detailCommercial = document.getElementById("detailCommercial");
const activityList = document.getElementById("activityList");
const detailPhotosSection = document.getElementById("detailPhotosSection");
const detailPhotoGrid = document.getElementById("detailPhotoGrid");
const detailTranscriptSection = document.getElementById("detailTranscriptSection");
const detailTranscript = document.getElementById("detailTranscript");
const saveMessage = document.getElementById("saveMessage");
const archiveButton = document.getElementById("archiveButton");

const STAGES = [
  ["all", "All"],
  ["new", "New"],
  ["contacted", "Contacted"],
  ["site_visit", "Site visit"],
  ["quoted", "Quoted"],
  ["won", "Won"],
  ["lost", "Lost"]
];

// Stages shown as Kanban columns. "all" is excluded — board is one column per
// real stage. "lost" is included so dragging there is one motion.
const KANBAN_STAGES = STAGES.slice(1);

let leads = [];
let activeLeadId = "";
let viewMode = "list"; // "list" | "kanban"
let selectMode = false; // user has clicked the Select toggle
let selectedIds = new Set();
let sources = {};

const money = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0
});

function text(value) {
  return String(value || "");
}

function escapeHtml(value) {
  return text(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Commercial intake — machine key → human label. Store the key, render the
// label. Unknown keys fall back to the raw key so nothing renders blank.
const COMMERCIAL_ROLE_LABELS = {
  site_contact: "Site contact",
  property_manager: "Property manager",
  accounts_payable: "Accounts payable",
  owner_board: "Owner / board member",
  other: "Other"
};
const PAYMENT_TERMS_LABELS = {
  due_on_receipt: "Due on receipt",
  net_15: "Net 15",
  net_30: "Net 30",
  net_60: "Net 60",
  other: "Other"
};
function roleLabel(key) {
  return COMMERCIAL_ROLE_LABELS[key] || (key ? text(key) : "");
}
function paymentTermsLabel(key) {
  return PAYMENT_TERMS_LABELS[key] || (key ? text(key) : "");
}

function moneyText(value) {
  return money.format(Number(value || 0)).replace("CA", "").trim();
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatDate(value) {
  if (!value) return "No follow-up";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium" }).format(new Date(`${value}T12:00:00`));
}

function statusText(value) {
  return value ? "Contact ready" : "Needs cleanup";
}

function stageLabel(status) {
  return STAGES.find(([key]) => key === status)?.[1] || "New";
}

// Days since the lead's CRM record was last updated. Used to color-code aging
// leads — fresh = green, getting stale = amber, ignored = red. Closed leads
// (won/lost) and archived leads never show as aging.
function daysSinceUpdate(lead) {
  const lastUpdated = lead.crm?.lastUpdated || lead.createdAt;
  if (!lastUpdated) return 0;
  const ms = Date.now() - new Date(lastUpdated).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function ageClass(lead) {
  const status = lead.crm?.status || lead.status;
  if (status === "won" || status === "lost" || lead.archived) return "";
  const days = daysSinceUpdate(lead);
  if (days >= 7) return "age-stale";
  if (days >= 3) return "age-warm";
  return "age-fresh";
}

function searchableLead(lead) {
  return [
    lead.contact?.name,
    lead.contact?.phone,
    lead.contact?.email,
    lead.contact?.address,
    lead.contact?.notes,
    lead.crm?.owner,
    lead.crm?.internalNotes,
    lead.sourceLabel,
    lead.features?.map((item) => item.label).join(" ")
  ].join(" ").toLowerCase();
}

function renderSourceFilterOptions() {
  const current = sourceFilter.value;
  while (sourceFilter.options.length > 1) sourceFilter.remove(1);
  Object.entries(sources).forEach(([key, meta]) => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = meta.label;
    sourceFilter.append(option);
  });
  if (Array.from(sourceFilter.options).some((o) => o.value === current)) {
    sourceFilter.value = current;
  }
}

function isOpen(lead) {
  return !["won", "lost"].includes(lead.crm?.status || lead.status);
}

function isDue(lead) {
  const value = lead.crm?.nextFollowUp;
  if (!value || !isOpen(lead)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${value}T00:00:00`) <= today;
}

function filteredLeads() {
  const query = leadSearch.value.trim().toLowerCase();
  const status = statusFilter.value;
  const priority = priorityFilter.value;
  const source = sourceFilter.value;
  return leads.filter((lead) => {
    const leadStatus = lead.crm?.status || lead.status || "new";
    const leadPriority = lead.crm?.priority || "normal";
    const leadSource = lead.source || "general_lead";
    if (status !== "all" && leadStatus !== status) return false;
    if (priority !== "all" && leadPriority !== priority) return false;
    if (source !== "all" && leadSource !== source) return false;
    if (query && !searchableLead(lead).includes(query)) return false;
    return true;
  });
}

function renderTabs() {
  pipelineTabs.innerHTML = "";
  STAGES.forEach(([key, label]) => {
    const count = key === "all"
      ? leads.length
      : leads.filter((lead) => (lead.crm?.status || lead.status) === key).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = key === statusFilter.value ? "is-active" : "";
    button.dataset.stage = key;
    button.innerHTML = `${escapeHtml(label)} <span>${count}</span>`;
    pipelineTabs.append(button);
  });
}

function renderStats() {
  const openLeads = leads.filter(isOpen);
  const openValue = openLeads.reduce((sum, lead) => sum + Number(lead.totals?.expectedTotal || 0), 0);
  const closedWon = leads.filter((lead) => (lead.crm?.status || lead.status) === "won");
  const closedWonValue = closedWon.reduce((sum, lead) => sum + Number(lead.totals?.expectedTotal || 0), 0);

  openCount.textContent = openLeads.length;
  pipelineValue.textContent = moneyText(openValue);
  dueCount.textContent = leads.filter(isDue).length;
  wonValue.textContent = moneyText(closedWonValue);
}

function leadCardMarkup(lead, { withCheckbox = false } = {}) {
  const status = lead.crm?.status || lead.status || "new";
  const sourceLabel = lead.sourceLabel || sources[lead.source]?.label || "General Lead";
  const sourceCategory = lead.sourceCategory || sources[lead.source]?.category || "inquiry";
  const ageBadge = ageClass(lead);
  const archivedBadge = lead.archived ? `<span class="archive-pill">Archived</span>` : "";
  // Commercial-account badge (commercial intake). Driven off accountType so
  // it doesn't double-encode a distinction the source pill already carries.
  const commercialBadge = lead.accountType === "commercial" ? `<span class="account-pill account-commercial">Commercial</span>` : "";
  const checkbox = withCheckbox
    ? `<label class="card-check" onclick="event.stopPropagation()"><input type="checkbox" data-bulk-id="${escapeHtml(lead.id)}" ${selectedIds.has(lead.id) ? "checked" : ""}><span></span></label>`
    : "";
  return `
    ${checkbox}
    <span class="card-topline">
      <span class="stage-pill">${escapeHtml(stageLabel(status))}</span>
      <span class="priority-pill priority-${escapeHtml(lead.crm?.priority || "normal")}">${escapeHtml(lead.crm?.priority || "normal")}</span>
      <span class="source-pill source-${escapeHtml(sourceCategory)}">${escapeHtml(sourceLabel)}</span>
      ${commercialBadge}
      ${archivedBadge}
    </span>
    <strong>${escapeHtml(lead.contact?.name)}</strong>
    <span>${escapeHtml(lead.contact?.address) || "No address provided"}</span>
    <span class="card-meta">
      <span>${moneyText(lead.totals?.expectedTotal)}</span>
      <span>${escapeHtml(formatDate(lead.crm?.nextFollowUp))}</span>
    </span>
    ${ageBadge ? `<span class="age-bar ${ageBadge}" aria-hidden="true"></span>` : ""}
  `;
}

function renderLeadCards() {
  const shown = filteredLeads();
  leadList.innerHTML = "";
  emptyState.hidden = shown.length > 0;

  shown.forEach((lead) => {
    const status = lead.crm?.status || lead.status || "new";
    const card = document.createElement("div");
    const ageBadge = ageClass(lead);
    card.className = `crm-card ${activeLeadId === lead.id ? "is-active" : ""} ${ageBadge} ${lead.archived ? "is-archived" : ""}`;
    card.dataset.leadId = lead.id;
    card.dataset.stage = status;
    card.draggable = false;
    // Checkbox is only rendered when the user has explicitly entered Select
    // mode via the Select toggle. Otherwise the card stays clean.
    card.innerHTML = leadCardMarkup(lead, { withCheckbox: selectMode });
    leadList.append(card);
  });
}

function renderKanban() {
  const shown = filteredLeads();
  kanbanBoard.innerHTML = "";
  KANBAN_STAGES.forEach(([key, label]) => {
    const column = document.createElement("div");
    column.className = "kanban-column";
    column.dataset.stage = key;
    const stageLeads = shown.filter((lead) => (lead.crm?.status || lead.status) === key);
    const stageValue = stageLeads.reduce((sum, l) => sum + Number(l.totals?.expectedTotal || 0), 0);
    column.innerHTML = `
      <header class="kanban-head">
        <strong>${escapeHtml(label)}</strong>
        <span>${stageLeads.length} · ${moneyText(stageValue)}</span>
      </header>
      <div class="kanban-cards" data-drop-stage="${escapeHtml(key)}"></div>
    `;
    const list = column.querySelector(".kanban-cards");
    stageLeads.forEach((lead) => {
      const card = document.createElement("div");
      const ageBadge = ageClass(lead);
      card.className = `crm-card kanban-card ${activeLeadId === lead.id ? "is-active" : ""} ${ageBadge}`;
      card.dataset.leadId = lead.id;
      card.dataset.stage = key;
      card.draggable = true;
      card.innerHTML = leadCardMarkup(lead);
      list.append(card);
    });
    kanbanBoard.append(column);
  });
}

function renderDetail() {
  const lead = leads.find((item) => item.id === activeLeadId);
  detailEmpty.hidden = Boolean(lead);
  leadEditor.hidden = !lead;
  saveMessage.textContent = "";
  if (!lead) return;

  const status = lead.crm?.status || lead.status || "new";
  detailStage.textContent = stageLabel(status) + (lead.archived ? " · Archived" : "");
  detailName.textContent = text(lead.contact?.name);
  detailAddress.textContent = text(lead.contact?.address) || "No address provided";
  const sourceLabel = lead.sourceLabel || sources[lead.source]?.label || "General Lead";
  detailSource.textContent = `Source: ${sourceLabel} · ${daysSinceUpdate(lead)}d since update`;
  detailValue.textContent = moneyText(lead.totals?.expectedTotal);
  callLink.href = `tel:${text(lead.contact?.phone).replace(/[^\d+]/g, "")}`;
  emailLink.href = `mailto:${text(lead.contact?.email)}`;
  vcardLink.href = `/api/quotes/${encodeURIComponent(lead.id)}/contact.vcf`;
  portalLink.href = lead.portalUrl || lead.contactExport?.portalUrl || "#";

  leadEditor.elements.status.value = status;
  leadEditor.elements.priority.value = lead.crm?.priority || "normal";
  leadEditor.elements.owner.value = lead.crm?.owner || "";
  leadEditor.elements.nextFollowUp.value = lead.crm?.nextFollowUp || "";
  leadEditor.elements.internalNotes.value = lead.crm?.internalNotes || "";
  leadEditor.elements.activityNote.value = "";

  archiveButton.textContent = lead.archived ? "Restore from archive" : "Archive";

  const exportContact = lead.contactExport || {};
  const exportAddress = exportContact.address || {};
  leadEditor.elements.firstName.value = exportContact.firstName || lead.contact?.firstName || "";
  leadEditor.elements.lastName.value = exportContact.lastName || lead.contact?.lastName || "";
  leadEditor.elements.phone.value = exportContact.telephone || lead.contact?.phone || "";
  leadEditor.elements.email.value = exportContact.email || lead.contact?.email || "";
  leadEditor.elements.streetNumber.value = exportAddress.streetNumber || lead.contact?.streetNumber || "";
  leadEditor.elements.streetName.value = exportAddress.streetName || lead.contact?.streetName || "";
  leadEditor.elements.town.value = exportAddress.town || lead.contact?.town || "";
  leadEditor.elements.postalCode.value = exportAddress.postalCode || lead.contact?.postalCode || "";

  detailFeatures.innerHTML = "";
  (lead.features || []).forEach((feature) => {
    const item = document.createElement("li");
    const priceText = feature.quoteType === "custom" ? "Custom" : moneyText(feature.price);
    item.innerHTML = `<span>${escapeHtml(feature.label)}</span><strong>${priceText}</strong>`;
    detailFeatures.append(item);
  });

  // Separate billing party — mirrors the "Bill to" block in the lead
  // alert email. Only rendered for billTo === "other"; self-billing
  // leads keep the section hidden entirely. careOf (commercial intake)
  // renders as a "c/o …" line directly under the entity name.
  const billing = lead.billing && lead.billing.billTo === "other" ? lead.billing : null;
  detailBillingSection.hidden = !billing;
  if (billing) {
    detailBilling.innerHTML = [
      `<strong>${escapeHtml(billing.name)}</strong>`,
      billing.careOf ? `c/o ${escapeHtml(billing.careOf)}` : "",
      escapeHtml(billing.address),
      billing.email ? `<a href="mailto:${escapeHtml(billing.email)}">${escapeHtml(billing.email)}</a>` : "",
      billing.phone ? `<a href="tel:${escapeHtml(billing.phone)}">${escapeHtml(billing.phone)}</a>` : ""
    ].filter(Boolean).join("<br>");
  } else {
    detailBilling.innerHTML = "";
  }

  renderCommercialDetail(lead);

  customerNotes.textContent = lead.contact?.notes || "No customer notes.";
  renderPropertyDetail(lead);
  renderPhotosDetail(lead);
  renderTranscriptDetail(lead);
  renderQuoteDetail(lead);
  renderBookAction(lead);
  renderWorkOrderDetail(lead);
  renderFieldWoDetail(lead);
  renderContactPreview(lead);
  activityList.innerHTML = "";
  (lead.crm?.activity || []).slice(0, 12).forEach((activity) => {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${escapeHtml(formatDateTime(activity.at))}</strong><span>${escapeHtml(activity.text)}</span>`;
    activityList.append(item);
  });
}

// Commercial / billing panel (commercial intake). Read-only. Hidden for
// residential leads. The billing entity, c/o, and billing address already
// render in the "Bill to" panel above; this panel carries the commercial
// account fields: PO flag, payment terms, submitter role, and the
// role-tagged additional contacts, all with human-readable labels.
function commercialRow(label, value) {
  return `<div class="detail-commercial__row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}
function renderCommercialDetail(lead) {
  const isCommercial = Boolean(lead && lead.accountType === "commercial");
  detailCommercialSection.hidden = !isCommercial;
  if (!isCommercial) {
    detailCommercial.innerHTML = "";
    return;
  }
  const c = lead.commercial && typeof lead.commercial === "object" ? lead.commercial : {};
  const rows = [commercialRow("Account type", "Commercial")];
  if (c.submitterRole) rows.push(commercialRow("Submitted by", roleLabel(c.submitterRole)));
  rows.push(commercialRow("PO required", c.poRequired ? "Yes" : "No"));
  if (c.paymentTerms) rows.push(commercialRow("Payment terms", paymentTermsLabel(c.paymentTerms)));

  const contacts = Array.isArray(c.additionalContacts) ? c.additionalContacts : [];
  let contactsHtml = "";
  if (contacts.length) {
    contactsHtml = `<div class="detail-commercial__contacts"><h4>Additional contacts</h4>${contacts.map((ct) => {
      const head = [
        ct.name ? `<strong>${escapeHtml(ct.name)}</strong>` : "",
        ct.role ? `<span class="detail-commercial__role">${escapeHtml(roleLabel(ct.role))}</span>` : ""
      ].filter(Boolean).join(" ");
      const methods = [
        ct.email ? `<a href="mailto:${escapeHtml(ct.email)}">${escapeHtml(ct.email)}</a>` : "",
        ct.phone ? `<a href="tel:${escapeHtml(ct.phone)}">${escapeHtml(ct.phone)}</a>` : ""
      ].filter(Boolean).join(" · ");
      return `<div class="detail-commercial__contact">${head || "<em>Unnamed contact</em>"}${methods ? `<br>${methods}` : ""}</div>`;
    }).join("")}</div>`;
  }
  detailCommercial.innerHTML = `<dl class="detail-commercial__grid">${rows.join("")}</dl>${contactsHtml}`;
}

// Linked property — fetched lazily because the lead-list endpoint doesn't
// include property data, and we don't want to refetch all properties on
// every render. Cache by leadId so re-opening the same lead is instant.
const propertyCache = new Map();
async function renderPropertyDetail(lead) {
  if (!lead) {
    detailPropertySection.hidden = true;
    return;
  }
  detailPropertySection.hidden = false;

  // No property linked yet — show the empty state with create/link buttons.
  // The Field Work Orders section uses propertyId to enable Spring/Fall
  // templates, so this is the doorway to unlock those buttons.
  if (!lead.propertyId) {
    detailPropertyEmpty.hidden = false;
    detailPropertyFilled.hidden = true;
    detailPropertySuggest.hidden = true;
    // If no email, the auto-create path won't work — surface that up front
    // so Patrick doesn't click and bounce off a 422.
    const hasEmail = Boolean(lead.contact?.email);
    detailPropertyAttachBtn.disabled = !hasEmail;
    if (!hasEmail) {
      detailPropertyEmptyHelp.textContent = "Add an email to this lead to enable auto-create, or pick an existing property manually.";
      detailPropertyEmptyHelp.hidden = false;
    } else {
      detailPropertyEmptyHelp.hidden = true;
    }
    return;
  }

  detailPropertyEmpty.hidden = true;
  detailPropertyFilled.hidden = false;
  detailPropertyMeta.textContent = "Loading property…";
  detailPropertyOpen.href = `/admin/property/${encodeURIComponent(lead.propertyId)}`;

  let property = propertyCache.get(lead.propertyId);
  if (!property) {
    try {
      const response = await fetch(`/api/properties/${encodeURIComponent(lead.propertyId)}`, { cache: "no-store" });
      const data = await response.json();
      if (response.ok && data.ok) {
        property = data.property;
        propertyCache.set(lead.propertyId, property);
      }
    } catch { /* placeholder text stays */ }
  }
  if (activeLeadId !== lead.id) return;
  if (!property) {
    detailPropertyMeta.textContent = "Property profile not available.";
    return;
  }
  const zones = property.system?.zones?.length || 0;
  const valveBoxes = property.system?.valveBoxes?.length || 0;
  const bookings = (property.leadIds || []).length;
  // Property code (P-YYYY-NNNN) renders as a small badge above the
  // address — visible on every lead detail when a property is linked.
  const codeBadge = property.code
    ? `<span class="detail-property-code">${escapeHtml(property.code)}</span>`
    : "";
  detailPropertyMeta.innerHTML = `
    ${codeBadge}<strong>${escapeHtml(property.address || "(no address)")}</strong><br>
    ${zones} zone${zones === 1 ? "" : "s"} · ${valveBoxes} valve box${valveBoxes === 1 ? "" : "es"} · ${bookings} booking${bookings === 1 ? "" : "s"}
  `;

  // Suggested-link banner — appears when the auto-link logic detected a
  // possible duplicate (same customer email, different address). Patrick
  // either links to one of the suggestions or dismisses the banner.
  const suggestions = lead.propertyLinkSuggestions || [];
  if (lead.propertyLinkStatus === "suggested" && suggestions.length) {
    detailPropertySuggestList.innerHTML = "";
    suggestions.forEach((s) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <strong>${escapeHtml(s.address || "(no address)")}</strong>
          <span>${s.bookingCount} booking${s.bookingCount === 1 ? "" : "s"}</span>
        </div>
        <button type="button" class="pjl-btn pjl-btn-outline" data-suggest-link="${escapeHtml(s.id)}">Link this booking here →</button>
      `;
      detailPropertySuggestList.append(li);
    });
    detailPropertySuggest.hidden = false;
  } else {
    detailPropertySuggest.hidden = true;
  }
}

// Confirm a suggested link OR a manual-search pick. Both routes hit the
// same endpoint — the only difference is where the targetPropertyId came from.
async function linkLeadToProperty(targetPropertyId) {
  if (!activeLeadId || !targetPropertyId) return;
  try {
    const response = await fetch(`/api/leads/${encodeURIComponent(activeLeadId)}/link-property`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ propertyId: targetPropertyId })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't link."]).join(" "));
    leads = leads.map((l) => l.id === data.lead.id ? data.lead : l);
    propertyCache.delete(targetPropertyId); // refetch the now-updated property
    render();
  } catch (err) {
    saveMessage.textContent = err.message;
  }
}

// Suggested-link clicks (event delegation on the section).
detailPropertySuggest?.addEventListener("click", (event) => {
  const linkBtn = event.target.closest("[data-suggest-link]");
  if (linkBtn) linkLeadToProperty(linkBtn.dataset.suggestLink);
});

// Dismiss the suggestion banner (this booking really IS a different property).
detailPropertyDismissBtn?.addEventListener("click", async () => {
  if (!activeLeadId) return;
  try {
    const response = await fetch(`/api/leads/${encodeURIComponent(activeLeadId)}/dismiss-property-suggestion`, { method: "POST" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't dismiss."]).join(" "));
    leads = leads.map((l) => l.id === data.lead.id ? data.lead : l);
    render();
  } catch (err) {
    saveMessage.textContent = err.message;
  }
});

// Manual-link picker — opens a search dialog. Patrick types, the dialog
// shows results from /api/properties/search, click one to link.
function openPropertyPicker() {
  if (!propertyPickerDialog) return;
  propertyPickerSearch.value = "";
  propertyPickerResults.innerHTML = "";
  if (typeof propertyPickerDialog.showModal === "function") propertyPickerDialog.showModal();
  else propertyPickerDialog.setAttribute("open", "");
  loadPropertyPickerResults("");
  propertyPickerSearch.focus();
}
detailPropertyLinkBtn?.addEventListener("click", openPropertyPicker);
detailPropertyLinkBtnEmpty?.addEventListener("click", openPropertyPicker);

// "Create property from this lead" — runs the same auto-link logic that
// fires on lead intake (find existing match by email+address, fall back
// to creating a new property under the customer). Used to backfill leads
// that came in before the auto-link feature shipped.
detailPropertyAttachBtn?.addEventListener("click", async () => {
  if (!activeLeadId) return;
  detailPropertyAttachBtn.disabled = true;
  detailPropertyAttachBtn.textContent = "Creating…";
  try {
    const response = await fetch(`/api/leads/${encodeURIComponent(activeLeadId)}/attach-property`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't attach."]).join(" "));
    leads = leads.map((l) => l.id === data.lead.id ? data.lead : l);
    if (data.property) propertyCache.set(data.property.id, data.property);
    render();
  } catch (err) {
    saveMessage.textContent = err.message;
    detailPropertyAttachBtn.disabled = false;
    detailPropertyAttachBtn.textContent = "+ Create property from this lead";
  }
});
propertyPickerCancel?.addEventListener("click", () => propertyPickerDialog.close());

let pickerSearchTimer = null;
propertyPickerSearch?.addEventListener("input", () => {
  clearTimeout(pickerSearchTimer);
  pickerSearchTimer = setTimeout(() => loadPropertyPickerResults(propertyPickerSearch.value), 200);
});

async function loadPropertyPickerResults(query) {
  try {
    const url = `/api/properties/search?q=${encodeURIComponent(query || "")}`;
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!data.ok) return;
    propertyPickerResults.innerHTML = "";
    if (!data.results.length) {
      propertyPickerResults.innerHTML = `<li class="picker-empty">No matches yet.</li>`;
      return;
    }
    data.results.forEach((p) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <button type="button" data-picker-link="${escapeHtml(p.id)}">
          <strong>${escapeHtml(p.customerName || p.customerEmail || "(no name)")}</strong>
          <span>${escapeHtml(p.address || "(no address)")}</span>
          <span class="picker-meta">${escapeHtml(p.customerEmail || "")} · ${p.bookingCount} booking${p.bookingCount === 1 ? "" : "s"}</span>
        </button>
      `;
      propertyPickerResults.append(li);
    });
  } catch { /* ignore */ }
}

propertyPickerResults?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-picker-link]");
  if (!btn) return;
  propertyPickerDialog.close();
  linkLeadToProperty(btn.dataset.pickerLink);
});

function renderPhotosDetail(lead) {
  if (!detailPhotosSection || !detailPhotoGrid) return;
  const photos = Array.isArray(lead.photos) ? lead.photos : [];
  if (!photos.length) {
    detailPhotosSection.hidden = true;
    return;
  }
  detailPhotoGrid.innerHTML = "";
  photos.forEach((photo, idx) => {
    const link = document.createElement("a");
    link.href = photo.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "detail-photo-link";
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = `Customer photo ${idx + 1}`;
    img.loading = "lazy";
    link.appendChild(img);
    detailPhotoGrid.appendChild(link);
  });
  detailPhotosSection.hidden = false;
}

function renderTranscriptDetail(lead) {
  if (!detailTranscriptSection || !detailTranscript) return;
  const transcript = lead.context?.transcript || "";
  if (!transcript) {
    detailTranscriptSection.hidden = true;
    return;
  }
  detailTranscript.textContent = transcript;
  detailTranscriptSection.hidden = false;
}

// AI Repair Quote card — surfaces the discrete Quote artifact behind an
// AI-chat lead. Hidden when no quote is linked (legacy bookings, contact
// form, self-fix captures all land here without a quote). The data comes
// from server.js hydrateLeadQuote, which attaches lead.quote to every
// CRM response when lead.quoteId is set.
function renderQuoteDetail(lead) {
  if (!detailQuoteSection) return;
  const q = lead?.quote;
  if (!q) {
    detailQuoteSection.hidden = true;
    return;
  }
  detailQuoteSection.hidden = false;

  detailQuoteId.textContent = q.id || "Q-—";
  detailQuoteStatus.textContent = (q.status || "draft").replace(/_/g, " ");
  detailQuoteStatus.dataset.status = q.status || "draft";

  detailQuoteTotal.textContent = moneyText(q.total);
  detailQuoteSubtotal.textContent = `${moneyText(q.subtotal)} + ${moneyText(q.hst)} HST`;

  detailQuoteScope.textContent = q.scope || "(no scope recorded)";

  if (q.intakeGuarantee && q.intakeGuarantee.applies) {
    detailQuoteIntake.hidden = false;
  } else {
    detailQuoteIntake.hidden = true;
  }

  detailQuoteItems.innerHTML = "";
  (q.lineItems || []).forEach((item) => {
    const li = document.createElement("li");
    const qtyTag = item.qty > 1 ? ` <span class="detail-quote__qty">× ${escapeHtml(String(item.qty))}</span>` : "";
    li.innerHTML = `<span>${escapeHtml(item.label || item.key)}${qtyTag}</span><strong>${moneyText(item.lineTotal)}</strong>`;
    detailQuoteItems.append(li);
  });

  // Date footer — shows whichever lifecycle marks are present. The Quote
  // record's own audit history has the full timeline; this is the summary.
  const parts = [];
  const dateFormat = (iso) => {
    try { return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" }); }
    catch { return ""; }
  };
  if (q.sentAt)     parts.push(`Sent ${dateFormat(q.sentAt)}`);
  if (q.acceptedAt) parts.push(`Accepted ${dateFormat(q.acceptedAt)}`);
  if (q.declinedAt) parts.push(`Declined ${dateFormat(q.declinedAt)}`);
  if (q.expiredAt)  parts.push(`Expired ${dateFormat(q.expiredAt)}`);
  if (q.validUntil && !q.acceptedAt && !q.declinedAt && !q.expiredAt) {
    parts.push(`Valid until ${dateFormat(q.validUntil)}`);
  }
  if (Array.isArray(q.workOrderIds) && q.workOrderIds.length) {
    parts.push(`WOs: ${q.workOrderIds.join(", ")}`);
  }
  detailQuoteDates.textContent = parts.join(" · ");

  // Draft send control — only AI repair quotes still in draft (the
  // smart-controller upgrade flow). Sent/accepted quotes hide it; the
  // dates line above already tells that part of the story.
  if (detailQuoteSendWrap) {
    const sendable = q.type === "ai_repair_quote" && q.status === "draft";
    detailQuoteSendWrap.hidden = !sendable;
    if (sendable && detailQuoteSendBtn) {
      detailQuoteSendBtn.dataset.quoteId = q.id || "";
      detailQuoteSendBtn.disabled = false;
    }
    if (sendable && detailQuotePreviewBtn) {
      detailQuotePreviewBtn.dataset.quoteId = q.id || "";
    }
    if (detailQuoteSendStatus) detailQuoteSendStatus.textContent = "";
  }
}

// View as customer — opens the exact e-sign page the customer will get
// (PREVIEW banner, signing disabled; the link dies when the real send
// rotates the token). Tab opened synchronously so iOS Safari's popup
// blocker doesn't eat it.
if (detailQuotePreviewBtn) {
  detailQuotePreviewBtn.addEventListener("click", async () => {
    const quoteId = detailQuotePreviewBtn.dataset.quoteId;
    if (!quoteId) return;
    const tab = window.open("about:blank", "_blank");
    try {
      const response = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok || !data.previewUrl) {
        if (tab) tab.close();
        if (detailQuoteSendStatus) detailQuoteSendStatus.textContent = (data.errors && data.errors[0]) || `Couldn't open the preview (${response.status})`;
        return;
      }
      if (tab) tab.location = data.previewUrl;
      else window.location.href = data.previewUrl; // popup blocked — same-tab fallback
    } catch (err) {
      if (tab) tab.close();
      if (detailQuoteSendStatus) detailQuoteSendStatus.textContent = err.message || "Couldn't open the preview.";
    }
  });
}

// Tap Send on a draft quote → POST /api/quotes/:id/send-for-approval
// (email w/ PDF + SMS + the portal Accept button activates), then
// refresh so the card flips to "sent". Per-channel delivery failures
// are surfaced — a sent quote with a failed email needs a retry, not
// silence.
if (detailQuoteSendBtn) {
  detailQuoteSendBtn.addEventListener("click", async () => {
    const quoteId = detailQuoteSendBtn.dataset.quoteId;
    if (!quoteId) return;
    const lead = leads.find((item) => item.id === activeLeadId);
    const who = lead?.contact?.email || "the customer";
    if (!confirm(`Send ${quoteId} to ${who}?\n\nThey get an email with the quote PDF plus an SMS, and can accept it in their portal.`)) return;
    detailQuoteSendBtn.disabled = true;
    if (detailQuoteSendStatus) detailQuoteSendStatus.textContent = "Sending…";
    try {
      const response = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/send-for-approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error((data.errors && data.errors[0]) || `Couldn't send (${response.status})`);
      }
      // Success feedback is the status chip flipping draft → sent on the
      // refresh below (the send wrap hides itself once the quote isn't a
      // draft, so a message inside it wouldn't survive the re-render).
      // Per-channel delivery failures DO get an alert — the quote is
      // marked sent either way and Patrick needs to know to retry.
      const problems = [];
      if (data.emailError) problems.push(`Email failed: ${data.emailError}`);
      if (data.smsError) problems.push(`SMS failed: ${data.smsError}`);
      if (problems.length) {
        alert(`${quoteId} marked sent, but:\n${problems.join("\n")}\n\nUse Re-send in the Quote folder to retry delivery.`);
      }
      await loadLeads();
    } catch (err) {
      if (detailQuoteSendStatus) detailQuoteSendStatus.textContent = err.message || "Couldn't send quote.";
      detailQuoteSendBtn.disabled = false;
    }
  });
}

function renderWorkOrderDetail(lead) {
  const booking = lead.booking;
  const wo = booking?.workOrder;
  if (!booking || !wo) {
    detailWorkOrderSection.hidden = true;
    return;
  }
  detailWorkOrderSection.hidden = false;
  detailWorkOrderId.textContent = wo.id || "WO-—";
  detailWorkOrderStatus.textContent = (wo.status || "scheduled").replace(/_/g, " ");
  detailWorkOrderService.textContent = booking.serviceLabel || "—";
  detailWorkOrderPrice.textContent = wo.priceLabel || (wo.total ? moneyText(wo.total) : "Custom");

  if (booking.start) {
    const d = new Date(booking.start);
    detailWorkOrderWhen.textContent = d.toLocaleString("en-CA", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
  } else {
    detailWorkOrderWhen.textContent = "—";
  }

  if (booking.zoneCount === "unsure") {
    detailWorkOrderZones.textContent = "Customer unsure";
  } else if (typeof booking.zoneCount === "number") {
    detailWorkOrderZones.textContent = `${booking.zoneCount} zone${booking.zoneCount === 1 ? "" : "s"}`;
  } else {
    detailWorkOrderZones.textContent = "Not collected";
  }

  if (wo.priceNote) {
    detailWorkOrderNote.textContent = wo.priceNote;
    detailWorkOrderNote.hidden = false;
  } else {
    detailWorkOrderNote.hidden = true;
  }

  // Diagnosis block — surfaces AI-chat handoff data for Patrick. Hidden when
  // the booking came in cold (no pre-booking session attached).
  const diagnosis = wo.diagnosis;
  if (diagnosis && (diagnosis.summary || diagnosis.text)) {
    detailWorkOrderDiagnosisSummary.textContent = diagnosis.summary || "";
    detailWorkOrderDiagnosisSummary.hidden = !diagnosis.summary;
    detailWorkOrderDiagnosisText.textContent = diagnosis.text || "";
    detailWorkOrderDiagnosisText.hidden = !diagnosis.text;
    detailWorkOrderDiagnosis.hidden = false;
  } else {
    detailWorkOrderDiagnosis.hidden = true;
  }

  renderWoChangeType(lead);
}

// Field Work Orders — the tech-side per-visit document. Lists the WOs
// already created for this lead, plus buttons to mint new ones from
// Spring / Fall / Service-Visit templates. Clicking a row opens the
// editor page; clicking a template button creates the record and
// jumps straight into the editor.
let fieldWoLeadContext = null;  // captures the lead the section is bound to

async function renderFieldWoDetail(lead) {
  fieldWoLeadContext = lead || null;
  if (!lead) {
    detailFieldWoSection.hidden = true;
    return;
  }
  detailFieldWoSection.hidden = false;

  // Spring/fall need a property to scaffold zones from. Service visits
  // don't, so they're always enabled.
  const hasProperty = Boolean(lead.propertyId);
  createWoSpring.disabled = !hasProperty;
  createWoFall.disabled = !hasProperty;
  detailFieldWoNolink.hidden = hasProperty;

  detailFieldWoList.innerHTML = "<li class=\"detail-field-wo__loading\">Loading…</li>";
  try {
    const response = await fetch(`/api/work-orders?leadId=${encodeURIComponent(lead.id)}`, { cache: "no-store" });
    const data = await response.json();
    const wos = (data.ok ? data.workOrders : []) || [];
    detailFieldWoList.innerHTML = "";
    if (!wos.length) {
      const li = document.createElement("li");
      li.className = "detail-field-wo__empty";
      li.textContent = "No field work orders yet.";
      detailFieldWoList.appendChild(li);
      return;
    }
    const TYPE_LABELS = {
      spring_opening: "Spring Opening",
      fall_closing: "Fall Closing",
      service_visit: "Service Visit"
    };
    wos.forEach((wo) => {
      const li = document.createElement("li");
      li.className = "detail-field-wo__item";
      const a = document.createElement("a");
      a.href = `/admin/work-order/${encodeURIComponent(wo.id)}`;
      a.innerHTML = `
        <strong>${escapeHtml(wo.id)}</strong>
        <span class="detail-field-wo__type">${escapeHtml(TYPE_LABELS[wo.type] || wo.type)}</span>
        <span class="detail-field-wo__status">${escapeHtml((wo.status || "scheduled").replace(/_/g, " "))}</span>
        <span class="detail-field-wo__when">${escapeHtml(formatDateTime(wo.updatedAt))}</span>
      `;
      li.appendChild(a);
      detailFieldWoList.appendChild(li);
    });
  } catch {
    detailFieldWoList.innerHTML = "<li class=\"detail-field-wo__empty\">Couldn't load.</li>";
  }
}

// ---- Service-call fee waiver (Service Visit WOs only) ------------------
// Mirrors the property-page waiver control. The $95 fee only applies to
// service_visit WOs; Spring/Fall are flat-rate with no separate trip charge.
(async function hydrateWaiverFeeAmount() {
  if (!woWaiveFeeAmount) return;
  try {
    const res = await fetch("/api/pricing", { cache: "no-store" });
    const data = await res.json();
    const price = data?.items?.service_call?.price;
    if (Number.isFinite(Number(price))) woWaiveFeeAmount.textContent = "$" + Number(price);
  } catch { /* keep the static fallback */ }
})();

function clearWaiverError() {
  if (woWaiveErr) { woWaiveErr.hidden = true; woWaiveErr.textContent = ""; }
}
function syncWaiverUi() {
  const on = !!(woWaiveFee && woWaiveFee.checked);
  if (woWaiveDetail) woWaiveDetail.hidden = !on;
  if (woWaiveNotesHint) {
    woWaiveNotesHint.textContent = woWaiveReason?.value === "other" ? "(required)" : "(optional)";
  }
  if (!on) clearWaiverError();
}
woWaiveFee?.addEventListener("change", syncWaiverUi);
woWaiveReason?.addEventListener("change", () => { syncWaiverUi(); clearWaiverError(); });
woWaiveNotes?.addEventListener("input", clearWaiverError);

function readServiceFeeWaiver() {
  if (!woWaiveFee || !woWaiveFee.checked) return { skip: true };
  const reason = woWaiveReason?.value || "";
  if (!reason) return { error: "Select a waiver reason." };
  const notes = (woWaiveNotes?.value || "").trim();
  if (reason === "other" && !notes) return { error: "Add a note explaining the waiver when the reason is 'Other'." };
  return { waiver: { waived: true, reason, notes } };
}

async function createFieldWoFromButton(type) {
  const lead = fieldWoLeadContext;
  if (!lead) return;
  if ((type === "spring_opening" || type === "fall_closing") && !lead.propertyId) {
    alert("Spring & Fall WOs need a linked property to scaffold zones from. Link a property first.");
    return;
  }
  const button = document.querySelector(`[data-create-wo="${type}"]`);

  const body = { type, leadId: lead.id, propertyId: lead.propertyId || undefined };
  if (type === "service_visit") {
    const w = readServiceFeeWaiver();
    if (w.error) {
      if (woWaiveErr) { woWaiveErr.textContent = w.error; woWaiveErr.hidden = false; }
      return;
    }
    if (w.waiver) body.serviceFeeWaiver = w.waiver;
  }

  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/work-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error((data.errors && data.errors[0]) || `Create failed (HTTP ${response.status}).`);
    }
    // Jump to the editor — that's where the tech does the work.
    window.location.assign(`/admin/work-order/${encodeURIComponent(data.workOrder.id)}`);
  } catch (err) {
    alert(err.message);
    if (button) button.disabled = false;
  }
}

createWoSpring.addEventListener("click", () => createFieldWoFromButton("spring_opening"));
createWoFall.addEventListener("click",   () => createFieldWoFromButton("fall_closing"));
createWoVisit.addEventListener("click",  () => createFieldWoFromButton("service_visit"));

function renderContactPreview(lead) {
  const contact = lead.contactExport || {};
  const address = contact.address || {};
  const errors = Array.isArray(contact.errors) ? contact.errors : [];
  const statusClass = contact.ready ? "is-ready" : "needs-cleanup";
  const errorList = errors.length
    ? `<ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`
    : "";

  contactPreview.className = `contact-preview ${statusClass}`;
  contactPreview.innerHTML = `
    <div class="contact-preview__head">
      <strong>${escapeHtml(statusText(contact.ready))}</strong>
      <span>NOTE: ${escapeHtml(contact.note || "PJL_New2026")}</span>
    </div>
    <dl>
      <div><dt>Name</dt><dd>${escapeHtml(contact.firstName)} ${escapeHtml(contact.lastName)}</dd></div>
      <div><dt>Telephone</dt><dd>${escapeHtml(contact.telephone)}</dd></div>
      <div><dt>Email</dt><dd>${escapeHtml(contact.email)}</dd></div>
      <div><dt>Home address</dt><dd>${escapeHtml(address.line1)}<br>${escapeHtml(address.town)} ${escapeHtml(address.province || "ON")} ${escapeHtml(address.postalCode)}<br>${escapeHtml(address.country || "Canada")}</dd></div>
      <div><dt>Portal</dt><dd><a href="${escapeHtml(contact.portalUrl || "#")}" target="_blank" rel="noopener">${escapeHtml(contact.portalUrl || "Portal unavailable")}</a></dd></div>
    </dl>
    ${errorList}
  `;
  vcardLink.classList.toggle("is-disabled", !contact.ready);
  vcardLink.setAttribute("aria-disabled", String(!contact.ready));
}

function renderBulkToolbar() {
  // Toolbar is only relevant in select mode AND in list view.
  // Without items selected we still keep it visible so the user has a hint
  // that select mode is active and a quick way to exit.
  const shouldShow = selectMode && viewMode === "list";
  bulkToolbar.hidden = !shouldShow;
  bulkCount.textContent = String(selectedIds.size);
  // Delete is disabled until something's actually selected — guards against
  // a tap that would no-op into a confusing typed-confirm modal.
  if (bulkDelete) bulkDelete.disabled = selectedIds.size === 0;
}

function applyView() {
  viewListBtn.classList.toggle("is-active", viewMode === "list");
  viewKanbanBtn.classList.toggle("is-active", viewMode === "kanban");
  leadList.hidden = viewMode !== "list";
  kanbanBoard.hidden = viewMode !== "kanban";
  // Bulk select only works in list view (kanban uses drag).
  if (viewMode !== "list") {
    selectedIds.clear();
    selectMode = false;
  }
  crmMain.classList.toggle("is-selecting", selectMode && viewMode === "list");
  selectToggle.classList.toggle("is-active", selectMode);
  selectToggle.setAttribute("aria-pressed", String(selectMode));
  // In Kanban mode (any width) OR on tablet/mobile widths (any view), the
  // lead-detail panel becomes a slide-in drawer instead of an inline column.
  // Desktop list view keeps the original 3-column inline layout.
  const isNarrow = window.matchMedia("(max-width: 1180px)").matches;
  const useDrawer = viewMode === "kanban" || isNarrow;
  crmWorkspace.classList.toggle("is-kanban", viewMode === "kanban");
  crmWorkspace.classList.toggle("use-drawer", useDrawer);
  const drawerOpen = useDrawer && Boolean(activeLeadId);
  crmWorkspace.classList.toggle("drawer-open", drawerOpen);
  detailBackdrop.hidden = !drawerOpen;
  document.body.classList.toggle("crm-drawer-locked", drawerOpen);
}

// Re-apply view when the viewport crosses the drawer threshold so the layout
// doesn't get stuck mid-state on rotate / resize.
window.addEventListener("resize", () => {
  applyView();
});

function closeDetailDrawer() {
  activeLeadId = "";
  render();
}

function render() {
  applyView();
  renderStats();
  renderTabs();
  if (viewMode === "list") renderLeadCards();
  else renderKanban();
  renderDetail();
  renderBulkToolbar();
}

async function loadLeads() {
  refreshLeads.disabled = true;
  try {
    const include = showArchived.checked ? "archived" : "";
    const url = `/api/quotes${include ? `?include=${include}` : ""}`;
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    leads = Array.isArray(data.leads) ? data.leads : [];
    if (data.sources && typeof data.sources === "object") {
      sources = data.sources;
      renderSourceFilterOptions();
    }
    if (data.counts) archivedCount.textContent = data.counts.archived || 0;
    if (activeLeadId && !leads.some((lead) => lead.id === activeLeadId)) activeLeadId = "";
    selectedIds = new Set([...selectedIds].filter((id) => leads.some((l) => l.id === id)));
    render();
  } finally {
    refreshLeads.disabled = false;
  }
}

async function patchLead(id, payload) {
  const response = await fetch(`/api/quotes/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error((data.errors || ["Unable to save."]).join(" "));
  return data.lead;
}

async function saveLead(event) {
  event.preventDefault();
  const lead = leads.find((item) => item.id === activeLeadId);
  if (!lead) return;
  const submitButton = leadEditor.querySelector("button[type='submit']");
  submitButton.disabled = true;
  saveMessage.textContent = "Saving...";

  const formData = new FormData(leadEditor);
  const payload = {
    contact: {
      firstName: formData.get("firstName"),
      lastName: formData.get("lastName"),
      phone: formData.get("phone"),
      email: formData.get("email"),
      streetNumber: formData.get("streetNumber"),
      streetName: formData.get("streetName"),
      town: formData.get("town"),
      postalCode: formData.get("postalCode")
    },
    status: formData.get("status"),
    priority: formData.get("priority"),
    owner: formData.get("owner"),
    nextFollowUp: formData.get("nextFollowUp"),
    internalNotes: formData.get("internalNotes"),
    activityNote: formData.get("activityNote")
  };

  try {
    const updated = await patchLead(activeLeadId, payload);
    leads = leads.map((item) => item.id === updated.id ? updated : item);
    saveMessage.textContent = "Saved";
    render();
  } catch (error) {
    saveMessage.textContent = error.message || "Unable to save lead.";
  } finally {
    submitButton.disabled = false;
  }
}

async function bulkUpdate(patch) {
  if (!selectedIds.size) return;
  const ids = Array.from(selectedIds);
  bulkArchive.disabled = true;
  try {
    const response = await fetch("/api/quotes/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, patch })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Bulk update failed."]).join(" "));
    selectedIds.clear();
    await loadLeads();
  } catch (error) {
    saveMessage.textContent = error.message;
  } finally {
    bulkArchive.disabled = false;
  }
}

leadSearch.addEventListener("input", render);
statusFilter.addEventListener("change", render);
priorityFilter.addEventListener("change", render);
sourceFilter.addEventListener("change", render);
showArchived.addEventListener("change", loadLeads);
refreshLeads.addEventListener("click", loadLeads);
leadEditor.addEventListener("submit", saveLead);

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

pipelineTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-stage]");
  if (!button) return;
  statusFilter.value = button.dataset.stage;
  render();
});

viewListBtn.addEventListener("click", () => { viewMode = "list"; render(); });
viewKanbanBtn.addEventListener("click", () => { viewMode = "kanban"; render(); });

detailClose.addEventListener("click", closeDetailDrawer);
detailBackdrop.addEventListener("click", closeDetailDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && crmWorkspace.classList.contains("drawer-open")) {
    closeDetailDrawer();
  }
});

// Mobile filters panel: toggles a collapsible filters drawer below the
// toolbar. Only rendered ≤1180px (CSS hides the toggle button above that).
filtersToggle.addEventListener("click", () => {
  const open = !crmSidebar.classList.contains("is-open");
  crmSidebar.classList.toggle("is-open", open);
  filtersToggle.setAttribute("aria-expanded", String(open));
});

selectToggle.addEventListener("click", () => {
  selectMode = !selectMode;
  if (!selectMode) selectedIds.clear();
  // Forcing list view on, since kanban uses drag-drop and doesn't support selection.
  if (selectMode) viewMode = "list";
  render();
});

leadList.addEventListener("click", (event) => {
  const checkbox = event.target.closest("input[data-bulk-id]");
  if (checkbox) {
    if (checkbox.checked) selectedIds.add(checkbox.dataset.bulkId);
    else selectedIds.delete(checkbox.dataset.bulkId);
    renderBulkToolbar();
    return;
  }
  const card = event.target.closest("[data-lead-id]");
  if (!card) return;
  activeLeadId = card.dataset.leadId;
  render();
});

kanbanBoard.addEventListener("click", (event) => {
  const card = event.target.closest("[data-lead-id]");
  if (!card) return;
  activeLeadId = card.dataset.leadId;
  render();
});

// Drag-and-drop between Kanban columns. On drop, PATCH the lead's status which
// fires the customer notification automatically (server.js handles the
// transition detection).
kanbanBoard.addEventListener("dragstart", (event) => {
  const card = event.target.closest(".kanban-card");
  if (!card) return;
  event.dataTransfer.setData("text/plain", card.dataset.leadId);
  event.dataTransfer.effectAllowed = "move";
  card.classList.add("is-dragging");
});
kanbanBoard.addEventListener("dragend", (event) => {
  const card = event.target.closest(".kanban-card");
  if (card) card.classList.remove("is-dragging");
});
kanbanBoard.addEventListener("dragover", (event) => {
  const dropZone = event.target.closest("[data-drop-stage]");
  if (!dropZone) return;
  event.preventDefault();
  dropZone.classList.add("is-drop-target");
});
kanbanBoard.addEventListener("dragleave", (event) => {
  const dropZone = event.target.closest("[data-drop-stage]");
  if (dropZone) dropZone.classList.remove("is-drop-target");
});
kanbanBoard.addEventListener("drop", async (event) => {
  const dropZone = event.target.closest("[data-drop-stage]");
  if (!dropZone) return;
  event.preventDefault();
  dropZone.classList.remove("is-drop-target");
  const leadId = event.dataTransfer.getData("text/plain");
  const newStage = dropZone.dataset.dropStage;
  const lead = leads.find((l) => l.id === leadId);
  if (!lead || !newStage) return;
  const currentStage = lead.crm?.status || lead.status;
  if (currentStage === newStage) return;
  try {
    const updated = await patchLead(leadId, { status: newStage });
    leads = leads.map((l) => l.id === updated.id ? updated : l);
    render();
  } catch (error) {
    saveMessage.textContent = error.message;
  }
});

bulkStatus.addEventListener("change", () => {
  if (!bulkStatus.value) return;
  bulkUpdate({ status: bulkStatus.value }).then(() => { bulkStatus.value = ""; });
});
bulkPriority.addEventListener("change", () => {
  if (!bulkPriority.value) return;
  bulkUpdate({ priority: bulkPriority.value }).then(() => { bulkPriority.value = ""; });
});
bulkArchive.addEventListener("click", () => bulkUpdate({ archived: true }));
bulkClear.addEventListener("click", () => {
  selectedIds.clear();
  selectMode = false;
  render();
});

archiveButton.addEventListener("click", async () => {
  const lead = leads.find((item) => item.id === activeLeadId);
  if (!lead) return;
  archiveButton.disabled = true;
  try {
    const updated = await patchLead(activeLeadId, { archived: !lead.archived });
    leads = leads.map((item) => item.id === updated.id ? updated : item);
    saveMessage.textContent = updated.archived ? "Archived" : "Restored";
    render();
  } catch (error) {
    saveMessage.textContent = error.message;
  } finally {
    archiveButton.disabled = false;
  }
});

// ---- Delete-lead confirmation modal -----------------------------
// Same typed-DELETE 2FA pattern as the property bulk-delete on
// /admin/properties. Server re-validates the confirm token, so a
// stray fetch can't wipe leads even with the modal bypassed.

let leadConfirmResolver = null;

function openLeadConfirm({ title, body }) {
  leadConfirmTitle.textContent = title;
  leadConfirmBody.innerHTML = body;
  leadConfirmInput.value = "";
  leadConfirmError.hidden = true;
  leadConfirmError.textContent = "";
  leadConfirmAccept.disabled = true;
  leadConfirmModal.hidden = false;
  setTimeout(() => leadConfirmInput.focus(), 0);
  return new Promise((resolve) => { leadConfirmResolver = resolve; });
}

function closeLeadConfirm(result) {
  leadConfirmModal.hidden = true;
  leadConfirmInput.value = "";
  leadConfirmAccept.disabled = true;
  if (leadConfirmResolver) {
    const r = leadConfirmResolver;
    leadConfirmResolver = null;
    r(result);
  }
}

leadConfirmInput.addEventListener("input", () => {
  leadConfirmAccept.disabled = leadConfirmInput.value.trim() !== "DELETE";
  if (!leadConfirmError.hidden) leadConfirmError.hidden = true;
});
leadConfirmAccept.addEventListener("click", () => {
  if (leadConfirmInput.value.trim() !== "DELETE") {
    leadConfirmError.hidden = false;
    leadConfirmError.textContent = "Type DELETE exactly to confirm.";
    return;
  }
  closeLeadConfirm(true);
});
leadConfirmCancel.addEventListener("click", () => closeLeadConfirm(false));
leadConfirmModal.addEventListener("click", (event) => {
  if (event.target === leadConfirmModal) closeLeadConfirm(false);
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !leadConfirmModal.hidden) closeLeadConfirm(false);
});

// Single-lead delete (lead detail panel button)
deleteLeadButton.addEventListener("click", async () => {
  const lead = leads.find((item) => item.id === activeLeadId);
  if (!lead) return;
  const who = lead.contact?.name || lead.contact?.email || lead.id;
  const ok = await openLeadConfirm({
    title: "Delete this lead?",
    body: `This permanently removes <strong>${escapeHtml(who)}</strong> from the CRM. Linked work orders stay (their leadId is cleared). <strong>This cannot be undone.</strong> Use Archive instead if you just want to hide it.`
  });
  if (!ok) return;
  deleteLeadButton.disabled = true;
  try {
    const response = await fetch(`/api/quotes/${encodeURIComponent(activeLeadId)}`, { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || `Delete failed (HTTP ${response.status}).`);
    leads = leads.filter((l) => l.id !== activeLeadId);
    activeLeadId = "";
    selectedIds.delete(data.deletedId);
    saveMessage.textContent = "Lead deleted.";
    render();
  } catch (err) {
    saveMessage.textContent = err.message;
  } finally {
    deleteLeadButton.disabled = false;
  }
});

// Bulk delete (toolbar button)
bulkDelete.addEventListener("click", async () => {
  if (!selectedIds.size) return;
  const ids = Array.from(selectedIds);
  const noun = ids.length === 1 ? "1 lead" : `${ids.length} leads`;
  const ok = await openLeadConfirm({
    title: `Delete ${noun}?`,
    body: `This permanently removes ${noun} from the CRM. Linked work orders stay (their leadId is cleared). <strong>This cannot be undone.</strong> Use Archive instead if you just want to hide them.`
  });
  if (!ok) return;
  bulkDelete.disabled = true;
  try {
    const response = await fetch("/api/quotes/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, confirm: "DELETE" })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || `Delete failed (HTTP ${response.status}).`);
    const idSet = new Set(ids);
    leads = leads.filter((l) => !idSet.has(l.id));
    selectedIds.clear();
    selectMode = false;
    if (idSet.has(activeLeadId)) activeLeadId = "";
    saveMessage.textContent = `Deleted ${data.deletedCount} lead${data.deletedCount === 1 ? "" : "s"}.`;
    render();
  } catch (err) {
    alert(err.message);
  } finally {
    bulkDelete.disabled = false;
  }
});

vcardLink.addEventListener("click", (event) => {
  if (vcardLink.classList.contains("is-disabled")) {
    event.preventDefault();
    saveMessage.textContent = "Clean up the contact fields before exporting a VCF.";
  }
});

loadLeads();

// ---- Property-ownership conflict banner ---------------------------
//
// Surfaces leads whose intake matched an existing property under a
// different customer email (spec §3.1 "do NOT auto-merge"). Two
// actions per row:
//   - "Resolve on property →" navigates to /admin/property/<id> where
//     Patrick uses the Change owner modal to transfer ownership.
//   - "Dismiss" clears the propertyLinkConflicts flag on the lead
//     for cases where the matched property is a different property
//     at the same address (duplex, multi-unit).

(function setupConflictBanner() {
  const banner = document.getElementById("conflictBanner");
  const list = document.getElementById("conflictList");
  const count = document.getElementById("conflictCount");
  if (!banner || !list || !count) return;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  async function load() {
    try {
      const res = await fetch("/api/admin/property-link-conflicts", { credentials: "same-origin" });
      if (!res.ok) return;
      const body = await res.json();
      const conflicts = Array.isArray(body.conflicts) ? body.conflicts : [];
      if (!conflicts.length) {
        banner.hidden = true;
        return;
      }
      // Flatten: one row per (lead × conflicting property) pair so
      // multi-conflict leads render all options.
      const rows = [];
      for (const c of conflicts) {
        for (const conflictProp of c.conflicts) {
          rows.push({
            leadId: c.leadId,
            leadName: c.leadName,
            leadEmail: c.leadEmail,
            leadAddress: c.leadAddress,
            propertyId: conflictProp.id,
            propertyAddress: conflictProp.address,
            previousCustomerName: conflictProp.previousCustomerName,
            previousCustomerEmail: conflictProp.previousCustomerEmail,
            // Server marks each conflict with whether its property is
            // still in properties.json. Default true for back-compat
            // with older server responses.
            propertyExists: conflictProp.propertyExists !== false
          });
        }
      }
      count.textContent = String(rows.length);
      list.innerHTML = rows.map((r) => {
        // When the property has been deleted/renamed since the conflict
        // was recorded, "Resolve on property →" dead-ends on the
        // property page's "couldn't be loaded" error. In that case hide
        // the Resolve button, promote Dismiss to the primary visual,
        // and surface a one-line explanation.
        const resolveAction = r.propertyExists
          ? `<a class="pjl-btn pjl-btn-primary" style="padding: 5px 10px; font-size: 12px;" href="/admin/property/${encodeURIComponent(r.propertyId)}">Resolve on property →</a>`
          : "";
        const dismissClass = r.propertyExists ? "pjl-btn pjl-btn-outline" : "pjl-btn pjl-btn-primary";
        const orphanNote = r.propertyExists
          ? ""
          : `<div style="color: #9b6500; margin-top: 4px; font-size: 11px;">Target property <span style="font-family: ui-monospace, Menlo, Consolas, monospace;">${esc(r.propertyId)}</span> no longer exists in properties.json — Dismiss is the only action available.</div>`;
        return `
        <div style="background: #fff; border: 1px solid #d6a800; border-radius: 6px; padding: 10px 14px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;">
          <div style="flex: 1 1 320px; font-size: 13px;">
            <strong>${esc(r.leadName) || "(unnamed lead)"}</strong>
            <span style="color: #666;"> &lt;${esc(r.leadEmail)}&gt;</span>
            <div style="color: #666; margin-top: 2px;">
              landed at <strong>${esc(r.leadAddress)}</strong>
            </div>
            <div style="color: #666; margin-top: 2px;">
              ↔ property <strong>${esc(r.propertyAddress)}</strong>
              previously owned by <strong>${esc(r.previousCustomerName) || "(unnamed)"}</strong>
              &lt;${esc(r.previousCustomerEmail)}&gt;
            </div>
            ${orphanNote}
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            ${resolveAction}
            <button type="button" class="${dismissClass}" style="padding: 5px 10px; font-size: 12px;" data-dismiss-lead="${esc(r.leadId)}">Dismiss</button>
          </div>
        </div>
        `;
      }).join("");

      list.querySelectorAll("[data-dismiss-lead]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const leadId = btn.getAttribute("data-dismiss-lead");
          btn.disabled = true;
          try {
            await fetch(`/api/admin/property-link-conflicts/${encodeURIComponent(leadId)}/dismiss`, {
              method: "POST",
              credentials: "same-origin"
            });
            await load();
          } catch (err) {
            btn.disabled = false;
            console.warn("Dismiss failed:", err);
          }
        });
      });

      banner.hidden = false;
    } catch (err) {
      console.warn("Failed to load property-link conflicts:", err);
    }
  }

  load();
})();

// ===================================================================
// Book appointment — book an existing lead directly from its card.
// (Book-from-lead brief.) Reuses the shared month-calendar picker in
// admin custom-time mode (same construction as crm-reschedule.js) and
// posts to /api/booking/reserve with a `leadId` binding so the booking
// attaches to THIS lead (+ its source quote) instead of spawning a
// duplicate. No new picker, no new endpoint.
// ===================================================================
const detailBookSection  = document.getElementById("detailBookSection");
const detailBookBtn       = document.getElementById("detailBookBtn");
const detailBookHint      = document.getElementById("detailBookHint");
const detailBookExisting  = document.getElementById("detailBookExisting");
const bookLeadDialog      = document.getElementById("bookLeadDialog");
const bookLeadClose       = document.getElementById("bookLeadClose");
const bookLeadCancel      = document.getElementById("bookLeadCancel");
const bookLeadSubmit      = document.getElementById("bookLeadSubmit");
const bookLeadFor         = document.getElementById("bookLeadFor");
const bookLeadService     = document.getElementById("bookLeadService");
const bookLeadZonesWrap   = document.getElementById("bookLeadZonesWrap");
const bookLeadZones       = document.getElementById("bookLeadZones");
const bookLeadQuoteChoice = document.getElementById("bookLeadQuoteChoice");
const bookLeadQuoteLegend = document.getElementById("bookLeadQuoteLegend");
const bookLeadQuoteAcceptLabel = document.getElementById("bookLeadQuoteAcceptLabel");
const bookLeadPicker      = document.getElementById("bookLeadPicker");
const bookLeadPickHelp    = document.getElementById("bookLeadPickHelp");
const bookLeadSlotStart   = document.getElementById("bookLeadSlotStart");
const bookLeadSlotSource  = document.getElementById("bookLeadSlotSource");
const bookLeadError       = document.getElementById("bookLeadError");
const bookLeadStatus      = document.getElementById("bookLeadStatus");

let bookLeadServicesCatalog = {};
let bookLeadPickerDestroy = null;
let bookLeadContextLead = null;

function bookLeadAddressOf(lead) {
  return (lead && lead.contact && lead.contact.address)
    || (lead && lead.contactExport && lead.contactExport.address && lead.contactExport.address.full)
    || "";
}

function bookServiceIsSeasonal(key) {
  const svc = bookLeadServicesCatalog[key];
  return Boolean(svc && (svc.family === "spring_opening" || svc.family === "fall_closing"));
}

// Show / hide the "Book appointment" section on the lead card. Always
// visible for a real lead; when the lead already has a booking we keep
// the button but warn (§2E) so a deliberate second visit is possible
// without silently duplicating.
function renderBookAction(lead) {
  if (!detailBookSection) return;
  if (!lead) { detailBookSection.hidden = true; return; }
  detailBookSection.hidden = false;

  const hasBooking = Boolean(lead.booking && lead.booking.start);
  if (hasBooking && detailBookExisting) {
    let when = "";
    try {
      when = new Date(lead.booking.start).toLocaleString("en-CA", {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      });
    } catch { when = ""; }
    detailBookExisting.textContent = `Heads up: this lead already has a booking${when ? ` on ${when}` : ""}. Booking again creates a second visit.`;
    detailBookExisting.hidden = false;
    if (detailBookBtn) detailBookBtn.textContent = "📅 Book another appointment";
  } else {
    if (detailBookExisting) detailBookExisting.hidden = true;
    if (detailBookBtn) detailBookBtn.textContent = "📅 Book appointment";
  }
}

// Fetch the bookable-services catalog once and cache it. Shared by the
// book-from-lead modal and the Work-Order "change appointment type" control.
let __svcCatalogPromise = null;
async function getServiceCatalog() {
  if (Object.keys(bookLeadServicesCatalog).length) return bookLeadServicesCatalog;
  if (!__svcCatalogPromise) {
    __svcCatalogPromise = (async () => {
      try {
        const r = await fetch("/api/booking/services", { cache: "no-store" });
        const data = await r.json();
        bookLeadServicesCatalog = (data.ok && data.services) || {};
      } catch { /* leave empty — callers handle */ }
      return bookLeadServicesCatalog;
    })();
  }
  return __svcCatalogPromise;
}

function buildServiceGroups(catalog) {
  const entries = Object.entries(catalog).filter(([, s]) => s.bookable);
  return {
    "Spring opening (residential)":     entries.filter(([k, s]) => s.family === "spring_opening" && !k.includes("commercial")),
    "Spring opening (commercial)":      entries.filter(([k, s]) => s.family === "spring_opening" && k.includes("commercial")),
    "Fall winterization (residential)": entries.filter(([k, s]) => s.family === "fall_closing" && !k.includes("commercial")),
    "Fall winterization (commercial)":  entries.filter(([k, s]) => s.family === "fall_closing" && k.includes("commercial")),
    "Other": entries.filter(([, s]) => !["spring_opening", "fall_closing"].includes(s.family))
  };
}

// Fill a <select> with grouped bookable-service options. When `placeholder`
// is passed it's prepended as a value="" option so nothing is pre-selected.
function fillServiceSelect(selectEl, catalog, { placeholder } = {}) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  if (placeholder) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = placeholder;
    selectEl.appendChild(o);
  }
  const groups = buildServiceGroups(catalog);
  for (const [groupLabel, items] of Object.entries(groups)) {
    if (!items.length) continue;
    const og = document.createElement("optgroup");
    og.label = groupLabel;
    items.forEach(([key, svc]) => {
      const o = document.createElement("option");
      o.value = key;
      o.textContent = svc.label || key;
      og.appendChild(o);
    });
    selectEl.appendChild(og);
  }
}

async function ensureBookServicesLoaded() {
  if (bookLeadService && bookLeadService.options.length > 0) return;
  const catalog = await getServiceCatalog();
  // Placeholder first so nothing is pre-selected unless we can confidently
  // infer the service (seedBookService). Without this, an unseeded lead
  // silently lands on the first real option (spring_open_4z) and books a
  // 1-4 zone spring opening no one chose.
  fillServiceSelect(bookLeadService, catalog, { placeholder: "— Choose appointment type… —" });
}

// Resolve the canonical BK- id for a lead's active booking (mirrors
// crm-reschedule.js). Prefers an exact scheduledFor match, else the most
// recent non-terminal record.
async function resolveBookingIdForLead(leadId, start) {
  try {
    const r = await fetch(`/api/bookings?leadId=${encodeURIComponent(leadId)}`, { cache: "no-store" });
    const data = await r.json();
    if (data.ok && Array.isArray(data.bookings) && data.bookings.length) {
      const active = data.bookings.filter((b) => b.status !== "cancelled" && b.status !== "completed" && b.status !== "no_show");
      if (start) {
        const exact = active.find((b) => b.scheduledFor === start);
        if (exact) return exact.id;
      }
      const sorted = active.slice().sort((a, b) => new Date(b.scheduledFor || 0) - new Date(a.scheduledFor || 0));
      return (sorted[0] && sorted[0].id) || data.bookings[0].id;
    }
  } catch { /* fall through */ }
  return null;
}

// Seed the service dropdown from the lead. A repair lead's booked
// service defaults to sprinkler_repair; if the lead's first feature is
// itself a bookable service key (e.g. a seasonal self-serve lead) we use
// that. Otherwise leave the picker on its first option.
function seedBookService(lead) {
  if (!bookLeadService) return;
  const keys = new Set(Object.keys(bookLeadServicesCatalog));
  let chosen = "";
  const firstFeatureKey = lead && Array.isArray(lead.features) && lead.features[0] && lead.features[0].key;
  if (firstFeatureKey && keys.has(firstFeatureKey)) {
    chosen = firstFeatureKey;
  } else if (lead && lead.quote && lead.quote.type === "ai_repair_quote" && keys.has("sprinkler_repair")) {
    chosen = "sprinkler_repair";
  }
  // Always set — an empty `chosen` selects the "— Choose appointment type… —"
  // placeholder, forcing Patrick to pick rather than defaulting silently.
  // (self-serve / new-customer leads carry no features + no quote, so they
  // land here on the placeholder.)
  bookLeadService.value = chosen;
  syncBookZonesVisibility();
}

function syncBookZonesVisibility() {
  if (!bookLeadZonesWrap || !bookLeadService) return;
  bookLeadZonesWrap.hidden = !bookServiceIsSeasonal(bookLeadService.value);
}

function renderBookQuoteChoice(lead) {
  if (!bookLeadQuoteChoice) return;
  const q = lead && lead.quote;
  const show = Boolean(q && q.type === "ai_repair_quote" && q.status !== "accepted");
  bookLeadQuoteChoice.hidden = !show;
  if (!show) return;
  if (bookLeadQuoteLegend) bookLeadQuoteLegend.textContent = `This lead has quote ${q.id || "Q-—"}`;
  if (bookLeadQuoteAcceptLabel) bookLeadQuoteAcceptLabel.textContent = `Mark quote ${q.id || ""} accepted (customer agreed on the phone)`.replace(/\s+/g, " ").trim();
  // Default to "leave open" — never flip a quote's status silently.
  const openRadio = bookLeadQuoteChoice.querySelector('input[value="open"]');
  if (openRadio) openRadio.checked = true;
}

function destroyBookPicker() {
  if (typeof bookLeadPickerDestroy === "function") {
    try { bookLeadPickerDestroy(); } catch (_) {}
  }
  bookLeadPickerDestroy = null;
}

function mountBookPicker() {
  if (!bookLeadPicker) return;
  destroyBookPicker();
  bookLeadSlotStart.value = "";
  bookLeadSlotSource.value = "slot";
  if (bookLeadSubmit) bookLeadSubmit.disabled = true;

  const serviceKey = bookLeadService ? bookLeadService.value : "";
  const address = bookLeadAddressOf(bookLeadContextLead);
  if (!serviceKey || !address) {
    bookLeadPicker.innerHTML = "";
    if (bookLeadPickHelp) {
      bookLeadPickHelp.hidden = false;
      bookLeadPickHelp.textContent = !serviceKey
        ? "Pick a service to load available times."
        : "This lead has no address — add one on the lead before booking.";
    }
    return;
  }
  if (typeof window.mountTimePicker !== "function") {
    if (bookLeadPickHelp) {
      bookLeadPickHelp.hidden = false;
      bookLeadPickHelp.textContent = "Time picker failed to load. Refresh the page and try again.";
    }
    return;
  }
  if (bookLeadPickHelp) bookLeadPickHelp.hidden = true;

  bookLeadPickerDestroy = window.mountTimePicker(bookLeadPicker, {
    mode: "admin",
    allowCustomTime: true,
    loadAvailability: async ({ from, to }) => {
      const url = `/api/booking/availability`
        + `?service=${encodeURIComponent(serviceKey)}`
        + `&address=${encodeURIComponent(address)}`
        + `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const r = await fetch(url, { cache: "no-store" });
      const data = await r.json();
      if (!data.ok) throw new Error((data.errors || ["Couldn't load times."]).join(" "));
      return { days: data.days || [] };
    },
    onSelect: (iso, slotMeta) => {
      bookLeadSlotStart.value = iso;
      bookLeadSlotSource.value = (slotMeta && slotMeta.source === "admin_custom") ? "admin_custom" : "slot";
      if (bookLeadSubmit) bookLeadSubmit.disabled = false;
      if (bookLeadError) bookLeadError.hidden = true;
    }
  });
}

function openBookDialog() {
  const lead = leads.find((item) => item.id === activeLeadId);
  if (!lead || !bookLeadDialog) return;
  bookLeadContextLead = lead;

  if (bookLeadError) { bookLeadError.hidden = true; bookLeadError.textContent = ""; }
  if (bookLeadStatus) bookLeadStatus.textContent = "";
  if (bookLeadSubmit) { bookLeadSubmit.disabled = true; bookLeadSubmit.textContent = "Confirm booking"; }
  if (bookLeadZones) bookLeadZones.value = "";

  const name = (lead.contact && lead.contact.name) || "this lead";
  const addr = bookLeadAddressOf(lead);
  if (bookLeadFor) bookLeadFor.textContent = addr ? `${name} · ${addr}` : name;

  ensureBookServicesLoaded().then(() => {
    seedBookService(lead);
    renderBookQuoteChoice(lead);
    mountBookPicker();
  });

  if (typeof bookLeadDialog.showModal === "function") bookLeadDialog.showModal();
  else bookLeadDialog.setAttribute("open", "");
}

function closeBookDialog() {
  destroyBookPicker();
  if (!bookLeadDialog) return;
  if (typeof bookLeadDialog.close === "function" && bookLeadDialog.open) bookLeadDialog.close();
  else bookLeadDialog.removeAttribute("open");
}

async function submitBookLead() {
  const lead = bookLeadContextLead;
  if (!lead || !bookLeadSubmit) return;
  const serviceKey = bookLeadService ? bookLeadService.value : "";
  const slotStart = bookLeadSlotStart ? bookLeadSlotStart.value : "";
  if (bookLeadError) bookLeadError.hidden = true;

  if (!serviceKey) { showBookError("Pick a service first."); return; }
  if (!slotStart) { showBookError("Pick a time slot first."); return; }
  const address = bookLeadAddressOf(lead);
  if (!address) { showBookError("This lead has no address — add one before booking."); return; }

  // Quote choice — only meaningful when the accept/leave-open control is shown.
  let markQuoteAccepted = false;
  if (bookLeadQuoteChoice && !bookLeadQuoteChoice.hidden) {
    const picked = bookLeadQuoteChoice.querySelector('input[name="bookLeadQuote"]:checked');
    markQuoteAccepted = Boolean(picked && picked.value === "accept");
  }

  const c = lead.contact || {};
  const payload = {
    leadId: lead.id,
    serviceKey,
    slotStart,
    source: bookLeadSlotSource ? bookLeadSlotSource.value : "slot",
    contact: {
      name: c.name || "",
      firstName: c.firstName || "",
      lastName: c.lastName || "",
      phone: c.phone || "",
      email: c.email || "",
      address,
      notes: c.notes || ""
    },
    zoneCount: (bookLeadZones && bookLeadZones.value.trim()) || null,
    markQuoteAccepted,
    pageUrl: location.href,
    userAgent: navigator.userAgent
  };

  bookLeadSubmit.disabled = true;
  bookLeadSubmit.textContent = "Booking…";
  if (bookLeadStatus) bookLeadStatus.textContent = "Creating booking…";
  try {
    const r = await fetch("/api/booking/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const err = new Error(data.message || (data.errors || ["Booking failed."]).join(" "));
      err.code = data.code || "";
      throw err;
    }
    if (bookLeadStatus) {
      bookLeadStatus.textContent = data.quoteAccepted
        ? `Booked ${data.bookingId || ""} · quote marked accepted.`.trim()
        : `Booked ${data.bookingId || ""}.`.trim();
    }
    closeBookDialog();
    await loadLeads();
  } catch (err) {
    const codeStr = err.code ? ` (${err.code})` : "";
    showBookError((err.message || "Booking failed.") + codeStr);
    bookLeadSubmit.disabled = false;
    bookLeadSubmit.textContent = "Confirm booking";
    if (bookLeadStatus) bookLeadStatus.textContent = "";
  }
}

function showBookError(msg) {
  if (!bookLeadError) return;
  bookLeadError.textContent = msg;
  bookLeadError.hidden = false;
}

if (detailBookBtn) detailBookBtn.addEventListener("click", openBookDialog);
if (bookLeadClose) bookLeadClose.addEventListener("click", closeBookDialog);
if (bookLeadCancel) bookLeadCancel.addEventListener("click", closeBookDialog);
if (bookLeadSubmit) bookLeadSubmit.addEventListener("click", submitBookLead);
if (bookLeadService) bookLeadService.addEventListener("change", () => { syncBookZonesVisibility(); mountBookPicker(); });
// Native <dialog> "cancel" (Esc) — clean up the picker too.
if (bookLeadDialog) bookLeadDialog.addEventListener("cancel", () => { destroyBookPicker(); });
if (bookLeadDialog) bookLeadDialog.addEventListener("close", () => { destroyBookPicker(); });

// ---- Change appointment type on an existing booking (admin CRM) ---------
const detailWorkOrderChangeType = document.getElementById("detailWorkOrderChangeType");
const detailWoServiceSelect     = document.getElementById("detailWoServiceSelect");
const detailWoServiceSaveBtn    = document.getElementById("detailWoServiceSaveBtn");
const detailWoServiceStatus     = document.getElementById("detailWoServiceStatus");
let woChangeTypeLead = null;

async function renderWoChangeType(lead) {
  if (!detailWorkOrderChangeType) return;
  woChangeTypeLead = lead || null;
  const booking = lead && lead.booking;
  if (!booking || !booking.serviceKey) { detailWorkOrderChangeType.hidden = true; return; }
  detailWorkOrderChangeType.hidden = false;
  if (detailWoServiceStatus) detailWoServiceStatus.textContent = "";
  const catalog = await getServiceCatalog();
  // Guard against a lead switch mid-fetch — only fill if this lead is still open.
  if (woChangeTypeLead !== lead) return;
  fillServiceSelect(detailWoServiceSelect, catalog, {});
  if (detailWoServiceSelect) detailWoServiceSelect.value = booking.serviceKey;
}

async function saveWoServiceType() {
  const lead = woChangeTypeLead;
  if (!lead || !detailWoServiceSelect) return;
  const serviceKey = detailWoServiceSelect.value;
  if (!serviceKey) return;
  if (lead.booking && serviceKey === lead.booking.serviceKey) {
    if (detailWoServiceStatus) detailWoServiceStatus.textContent = "That's already the appointment type.";
    return;
  }
  if (detailWoServiceSaveBtn) detailWoServiceSaveBtn.disabled = true;
  if (detailWoServiceStatus) detailWoServiceStatus.textContent = "Updating…";
  try {
    const bid = await resolveBookingIdForLead(lead.id, lead.booking && lead.booking.start);
    if (!bid) throw new Error("No booking record found for this lead.");
    const r = await fetch(`/api/bookings/${encodeURIComponent(bid)}/service-type`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ serviceKey })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || `Update failed (${r.status}).`);
    if (detailWoServiceStatus) detailWoServiceStatus.textContent = `Changed to ${data.serviceLabel || serviceKey}.`;
    await loadLeads();
  } catch (err) {
    if (detailWoServiceStatus) detailWoServiceStatus.textContent = err.message || "Couldn't change type.";
  } finally {
    if (detailWoServiceSaveBtn) detailWoServiceSaveBtn.disabled = false;
  }
}

if (detailWoServiceSaveBtn) detailWoServiceSaveBtn.addEventListener("click", saveWoServiceType);
