const portalTitle = document.getElementById("portalTitle");
const portalIntro = document.getElementById("portalIntro");
const portalContent = document.getElementById("portalContent");
const portalError = document.getElementById("portalError");
const projectStatus = document.getElementById("projectStatus");
const followUpText = document.getElementById("followUpText");
const serviceList = document.getElementById("serviceList");
const projectTotal = document.getElementById("projectTotal");
const customerPhone = document.getElementById("customerPhone");
const customerEmail = document.getElementById("customerEmail");
const customerAddress = document.getElementById("customerAddress");

const statusLabels = {
  new: "Request received",
  contacted: "Contacted",
  site_visit: "Site visit pending",
  quoted: "Quote sent",
  won: "Booked",
  lost: "Closed"
};

const money = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0
});

function tokenFromLocation() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts[0] === "portal" && parts[1]) return parts[1];
  return new URLSearchParams(window.location.search).get("token") || "";
}

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

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "long" }).format(new Date(`${value}T12:00:00`));
}

function renderPortal(data) {
  const customer = data.customer || {};
  const project = data.project || {};
  const services = Array.isArray(project.services) ? project.services : [];

  portalTitle.textContent = customer.firstName
    ? `Hi ${customer.firstName}, your PJL request is open.`
    : "Your PJL request is open.";
  portalIntro.textContent = "Your project details and contact information are below.";
  projectStatus.textContent = statusLabels[project.status] || "Request received";
  followUpText.textContent = project.nextFollowUp
    ? `Next follow-up: ${formatDate(project.nextFollowUp)}`
    : "PJL will follow up as soon as your request is reviewed.";
  projectTotal.textContent = money.format(Number(project.total || 0)).replace("CA", "").trim();
  customerPhone.textContent = text(customer.phone) || "Not provided";
  customerEmail.textContent = text(customer.email) || "Not provided";
  customerAddress.innerHTML = escapeHtml(customer.address).replace(/\n/g, "<br>") || "Not provided";

  serviceList.innerHTML = "";
  if (services.length) {
    services.forEach((service) => {
      const item = document.createElement("li");
      item.innerHTML = `<span>${escapeHtml(service.label)}</span><strong>${money.format(Number(service.price || 0)).replace("CA", "").trim()}</strong>`;
      serviceList.append(item);
    });
  } else {
    const item = document.createElement("li");
    item.innerHTML = "<span>Project details pending</span><strong>Review</strong>";
    serviceList.append(item);
  }

  portalContent.hidden = false;
}

async function loadPortal() {
  const token = tokenFromLocation();
  if (!token) {
    portalError.hidden = false;
    return;
  }

  try {
    const response = await fetch(`/api/portal/${encodeURIComponent(token)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error("Portal not found.");
    renderPortal(data.portal);
  } catch {
    portalError.hidden = false;
    portalTitle.textContent = "Portal unavailable";
    portalIntro.textContent = "Please contact PJL Land Services directly.";
  }
}

loadPortal();
