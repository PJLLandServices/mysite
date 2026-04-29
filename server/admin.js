const leadList = document.getElementById("leadList");
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
const pipelineTabs = document.getElementById("pipelineTabs");
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

const STAGES = [
  ["all", "All"],
  ["new", "New"],
  ["contacted", "Contacted"],
  ["site_visit", "Site visit"],
  ["quoted", "Quoted"],
  ["won", "Won"],
  ["lost", "Lost"]
];

let leads = [];
let activeLeadId = "";
// Source catalog from /api/quotes (key -> { label, category }). Populated on load
// so the filter dropdown stays in sync with server.js without hardcoded duplication.
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
  // Preserve current selection across re-renders.
  const current = sourceFilter.value;
  // Wipe everything except the "All sources" first option.
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

function renderLeadCards() {
  const shown = filteredLeads();
  leadList.innerHTML = "";
  emptyState.hidden = shown.length > 0;

  shown.forEach((lead) => {
    const status = lead.crm?.status || lead.status || "new";
    const card = document.createElement("button");
    card.type = "button";
    card.className = `crm-card ${activeLeadId === lead.id ? "is-active" : ""}`;
    card.dataset.leadId = lead.id;
    const sourceLabel = lead.sourceLabel || sources[lead.source]?.label || "General Lead";
    const sourceCategory = lead.sourceCategory || sources[lead.source]?.category || "inquiry";
    card.innerHTML = `
      <span class="card-topline">
        <span class="stage-pill">${escapeHtml(stageLabel(status))}</span>
        <span class="priority-pill priority-${escapeHtml(lead.crm?.priority || "normal")}">${escapeHtml(lead.crm?.priority || "normal")}</span>
        <span class="source-pill source-${escapeHtml(sourceCategory)}">${escapeHtml(sourceLabel)}</span>
      </span>
      <strong>${escapeHtml(lead.contact?.name)}</strong>
      <span>${escapeHtml(lead.contact?.address) || "No address provided"}</span>
      <span class="card-meta">
        <span>${moneyText(lead.totals?.expectedTotal)}</span>
        <span>${escapeHtml(formatDate(lead.crm?.nextFollowUp))}</span>
      </span>
    `;
    leadList.append(card);
  });
}

function renderDetail() {
  const lead = leads.find((item) => item.id === activeLeadId);
  detailEmpty.hidden = Boolean(lead);
  leadEditor.hidden = !lead;
  saveMessage.textContent = "";
  if (!lead) return;

  const status = lead.crm?.status || lead.status || "new";
  detailStage.textContent = stageLabel(status);
  detailName.textContent = text(lead.contact?.name);
  detailAddress.textContent = text(lead.contact?.address) || "No address provided";
  const sourceLabel = lead.sourceLabel || sources[lead.source]?.label || "General Lead";
  detailSource.textContent = `Source: ${sourceLabel}`;
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
    item.innerHTML = `<span>${escapeHtml(feature.label)}</span><strong>${moneyText(feature.price)}</strong>`;
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

function render() {
  renderStats();
  renderTabs();
  renderLeadCards();
  renderDetail();
}

async function loadLeads() {
  refreshLeads.disabled = true;
  try {
    const response = await fetch("/api/quotes", { cache: "no-store" });
    const data = await response.json();
    leads = Array.isArray(data.leads) ? data.leads : [];
    if (data.sources && typeof data.sources === "object") {
      sources = data.sources;
      renderSourceFilterOptions();
    }
    if (activeLeadId && !leads.some((lead) => lead.id === activeLeadId)) activeLeadId = "";
    render();
  } finally {
    refreshLeads.disabled = false;
  }
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
    const response = await fetch(`/api/quotes/${encodeURIComponent(activeLeadId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Unable to save lead."]).join(" "));
    leads = leads.map((item) => item.id === data.lead.id ? data.lead : item);
    saveMessage.textContent = "Saved";
    render();
  } catch (error) {
    saveMessage.textContent = error.message || "Unable to save lead.";
  } finally {
    submitButton.disabled = false;
  }
}

leadSearch.addEventListener("input", render);
statusFilter.addEventListener("change", render);
priorityFilter.addEventListener("change", render);
sourceFilter.addEventListener("change", render);
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

leadList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-lead-id]");
  if (!card) return;
  activeLeadId = card.dataset.leadId;
  render();
});

vcardLink.addEventListener("click", (event) => {
  if (vcardLink.classList.contains("is-disabled")) {
    event.preventDefault();
    saveMessage.textContent = "Clean up the contact fields before exporting a VCF.";
  }
});

loadLeads();
