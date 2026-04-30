const leadList = document.getElementById("leadList");
const kanbanBoard = document.getElementById("kanbanBoard");
const crmMain = document.getElementById("crmMain");
const crmWorkspace = document.getElementById("crmWorkspace");
const selectToggle = document.getElementById("selectToggle");
const detailClose = document.getElementById("detailClose");
const detailBackdrop = document.getElementById("detailBackdrop");
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
const customerNotes = document.getElementById("customerNotes");
const activityList = document.getElementById("activityList");
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
  renderContactPreview(lead);
  activityList.innerHTML = "";
  (lead.crm?.activity || []).slice(0, 12).forEach((activity) => {
    const item = document.createElement("li");
    item.innerHTML = `<strong>${escapeHtml(formatDateTime(activity.at))}</strong><span>${escapeHtml(activity.text)}</span>`;
    activityList.append(item);
  });
}

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
  // In Kanban mode the workspace switches to a 2-column grid (sidebar + board)
  // and the lead-detail panel becomes a slide-in drawer over the right edge.
  // List mode keeps the original 3-column inline layout.
  crmWorkspace.classList.toggle("is-kanban", viewMode === "kanban");
  // The drawer should be open only when (a) we're in kanban view AND (b) a
  // lead is actually selected. Switching to kanban with nothing selected
  // closes the drawer; switching back to list dismisses the overlay state.
  const drawerOpen = viewMode === "kanban" && Boolean(activeLeadId);
  crmWorkspace.classList.toggle("drawer-open", drawerOpen);
  detailBackdrop.hidden = !drawerOpen;
  document.body.classList.toggle("crm-drawer-locked", drawerOpen);
}

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
