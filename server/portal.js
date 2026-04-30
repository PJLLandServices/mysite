const portalTitle = document.getElementById("portalTitle");
const portalIntro = document.getElementById("portalIntro");
const portalContent = document.getElementById("portalContent");
const portalError = document.getElementById("portalError");
const portalTimeline = document.getElementById("portalTimeline");
const projectStatus = document.getElementById("projectStatus");
const followUpText = document.getElementById("followUpText");
const serviceList = document.getElementById("serviceList");
const projectTotal = document.getElementById("projectTotal");
const customerPhone = document.getElementById("customerPhone");
const customerEmail = document.getElementById("customerEmail");
const customerAddress = document.getElementById("customerAddress");
const workOrderCard = document.getElementById("workOrderCard");
const workOrderId = document.getElementById("workOrderId");
const workOrderStatus = document.getElementById("workOrderStatus");
const workOrderService = document.getElementById("workOrderService");
const workOrderWhen = document.getElementById("workOrderWhen");
const workOrderDuration = document.getElementById("workOrderDuration");
const workOrderPrice = document.getElementById("workOrderPrice");
const workOrderNote = document.getElementById("workOrderNote");
const workOrderDocStatus = document.getElementById("workOrderDocStatus");
const acceptCard = document.getElementById("acceptCard");
const acceptButton = document.getElementById("acceptButton");
const acceptStatus = document.getElementById("acceptStatus");
const messageForm = document.getElementById("messageForm");
const messageBody = document.getElementById("messageBody");
const messageStatus = document.getElementById("messageStatus");
const activityCard = document.getElementById("activityCard");
const activityList = document.getElementById("activityList");

const statusLabels = {
  new: "Request received",
  contacted: "Reviewed by PJL",
  site_visit: "Site visit pending",
  quoted: "Quote ready to review",
  won: "Booked — on the schedule",
  lost: "Closed"
};

// Maps a CRM status to the timeline step it corresponds to. The timeline has
// 5 steps: received -> reviewed -> site_visit -> quoted -> booked. Each CRM
// status fills the timeline up to and including that step.
const statusToStep = {
  new: 0,
  contacted: 1,
  site_visit: 2,
  quoted: 3,
  won: 4,
  lost: -1
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

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function renderTimeline(status) {
  const completedThrough = statusToStep[status] ?? 0;
  const items = portalTimeline.querySelectorAll("li[data-step]");
  items.forEach((item, index) => {
    item.classList.remove("is-complete", "is-current", "is-pending");
    if (status === "lost") {
      item.classList.add("is-pending");
      return;
    }
    if (index < completedThrough) item.classList.add("is-complete");
    else if (index === completedThrough) item.classList.add("is-current");
    else item.classList.add("is-pending");
  });
  portalTimeline.hidden = false;
}

function renderActivity(activity) {
  if (!Array.isArray(activity) || !activity.length) {
    activityCard.hidden = true;
    return;
  }
  activityList.innerHTML = "";
  activity.forEach((entry) => {
    const li = document.createElement("li");
    const friendly = entry.text || "Update";
    li.innerHTML = `<strong>${escapeHtml(formatDateTime(entry.at))}</strong><span>${escapeHtml(friendly)}</span>`;
    activityList.append(li);
  });
  activityCard.hidden = false;
}

function renderWorkOrder(data) {
  // Surface the work-order envelope when the lead came in via the booking
  // flow. Older leads (Formspree-era contact requests) don't have one and
  // the card stays hidden.
  const wo = data.workOrder;
  const booking = data.booking;
  if (!wo || !booking) {
    workOrderCard.hidden = true;
    return;
  }
  workOrderId.textContent = wo.id || "WO-—";
  workOrderStatus.textContent = (wo.status || "scheduled").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  workOrderService.textContent = booking.serviceLabel || "—";
  workOrderPrice.textContent = wo.priceLabel || (wo.total ? `$${wo.total}` : "Custom quote");
  workOrderDuration.textContent = booking.durationMinutes ? `${booking.durationMinutes} min` : "—";

  if (booking.start) {
    const start = new Date(booking.start);
    workOrderWhen.textContent = start.toLocaleString("en-CA", {
      weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
    });
  } else {
    workOrderWhen.textContent = "—";
  }

  if (wo.priceNote) {
    workOrderNote.textContent = wo.priceNote;
    workOrderNote.hidden = false;
  } else {
    workOrderNote.hidden = true;
  }

  // Document state — placeholder messaging until we attach a real doc.
  if (wo.documentReady && wo.documentUrl) {
    workOrderDocStatus.innerHTML = `<a href="${wo.documentUrl}" target="_blank" rel="noopener">Open work order document →</a>`;
  } else {
    workOrderDocStatus.textContent = "Your detailed work order will be available here closer to your appointment.";
  }

  workOrderCard.hidden = false;
}

function renderPortal(data) {
  const customer = data.customer || {};
  const project = data.project || {};
  const services = Array.isArray(project.services) ? project.services : [];

  portalTitle.textContent = customer.firstName
    ? `Hi ${customer.firstName}, your PJL request is open.`
    : "Your PJL request is open.";
  portalIntro.textContent = "Track your project below. Anything you need to share, drop us a message and we'll get back to you.";
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
      const priceText = service.quoteType === "custom"
        ? "Custom quote"
        : money.format(Number(service.price || 0)).replace("CA", "").trim();
      item.innerHTML = `<span>${escapeHtml(service.label)}</span><strong>${escapeHtml(priceText)}</strong>`;
      serviceList.append(item);
    });
  } else {
    const item = document.createElement("li");
    item.innerHTML = "<span>Project details pending</span><strong>Review</strong>";
    serviceList.append(item);
  }

  acceptCard.hidden = !project.canAccept;
  if (project.status === "won") {
    acceptCard.hidden = false;
    acceptCard.classList.add("is-accepted");
    acceptCard.querySelector("h2").textContent = "Quote accepted — thank you";
    const p = acceptCard.querySelector("p");
    if (p) p.textContent = "Your project is booked. Patrick will confirm the exact arrival window with you directly.";
    acceptButton.hidden = true;
  }

  renderTimeline(project.status);
  renderActivity(project.activity);
  renderWorkOrder(data);

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

acceptButton.addEventListener("click", async () => {
  const token = tokenFromLocation();
  if (!token) return;
  acceptButton.disabled = true;
  acceptStatus.textContent = "Accepting your quote...";
  try {
    const response = await fetch(`/api/portal/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Unable to accept right now."]).join(" "));
    acceptStatus.textContent = "Quote accepted — PJL has been notified.";
    setTimeout(loadPortal, 600);
  } catch (error) {
    acceptStatus.textContent = error.message || "Unable to accept right now. Please call PJL.";
    acceptButton.disabled = false;
  }
});

messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenFromLocation();
  if (!token) return;
  const message = messageBody.value.trim();
  if (!message) return;
  const submit = messageForm.querySelector("button[type='submit']");
  submit.disabled = true;
  messageStatus.textContent = "Sending...";
  try {
    const response = await fetch(`/api/portal/${encodeURIComponent(token)}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error((data.errors || ["Unable to send message."]).join(" "));
    messageStatus.textContent = "Sent — Patrick will get back to you.";
    messageBody.value = "";
    setTimeout(loadPortal, 600);
  } catch (error) {
    messageStatus.textContent = error.message || "Unable to send message right now. Please call PJL.";
  } finally {
    submit.disabled = false;
  }
});

loadPortal();
