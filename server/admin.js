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
const customerNotes = document.getElementById("customerNotes");
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
  const checkbox = withCheckbox
    ? `<label class="card-check" onclick="event.stopPropagation()"><input type="checkbox" data-bulk-id="${escapeHtml(lead.id)}" ${selectedIds.has(lead.id) ? "checked" : ""}><span></span></label>`
    : "";
  return `
    ${checkbox}
    <span class="card-topline">
      <span class="stage-pill">${escapeHtml(stageLabel(status))}</span>
      <span class="priority-pill priority-${escapeHtml(lead.crm?.priority || "normal")}">${escapeHtml(lead.crm?.priority || "normal")}</span>
      <span class="source-pill source-${escapeHtml(sourceCategory)}">${escapeHtml(sourceLabel)}</span>
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

  customerNotes.textContent = lead.contact?.notes || "No customer notes.";
  renderPropertyDetail(lead);
  renderPhotosDetail(lead);
  renderTranscriptDetail(lead);
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
  detailPropertyMeta.innerHTML = `
    <strong>${escapeHtml(property.address || "(no address)")}</strong><br>
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

async function createFieldWoFromButton(type) {
  const lead = fieldWoLeadContext;
  if (!lead) return;
  if ((type === "spring_opening" || type === "fall_closing") && !lead.propertyId) {
    alert("Spring & Fall WOs need a linked property to scaffold zones from. Link a property first.");
    return;
  }
  const button = document.querySelector(`[data-create-wo="${type}"]`);
  if (button) button.disabled = true;
  try {
    const response = await fetch("/api/work-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, leadId: lead.id, propertyId: lead.propertyId || undefined })
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

vcardLink.addEventListener("click", (event) => {
  if (vcardLink.classList.contains("is-disabled")) {
    event.preventDefault();
    saveMessage.textContent = "Clean up the contact fields before exporting a VCF.";
  }
});

loadLeads();
