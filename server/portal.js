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
const workOrderDiagnosis = document.getElementById("workOrderDiagnosis");
const workOrderDiagnosisSource = document.getElementById("workOrderDiagnosisSource");
const workOrderDiagnosisSummary = document.getElementById("workOrderDiagnosisSummary");
const workOrderDiagnosisDetail = document.getElementById("workOrderDiagnosisDetail");
const messageHeading = document.getElementById("messageHeading");
const helpHeading = document.getElementById("helpHeading");

// Customer first name captured from the portal payload — used to personalize
// every customer-facing copy block on the page (greetings, confirmation
// messages, "need to update something?" headings, etc.).
let customerFirstName = "";
const acceptCard = document.getElementById("acceptCard");
const acceptButton = document.getElementById("acceptButton");
const acceptStatus = document.getElementById("acceptStatus");
const messageForm = document.getElementById("messageForm");
const messageBody = document.getElementById("messageBody");
const messageStatus = document.getElementById("messageStatus");
const activityCard = document.getElementById("activityCard");
const activityList = document.getElementById("activityList");
const photosCard = document.getElementById("photosCard");
const photoGrid = document.getElementById("photoGrid");

// Status copy depends on whether the lead came in as a request (contact form)
// or a confirmed service booking (book.html with a slot reserved). The
// portal payload's `booking` field is non-null only when there's a real
// scheduled service.
const STATUS_LABELS_REQUEST = {
  new: "Request received",
  contacted: "Reviewed by PJL",
  site_visit: "Site visit pending",
  quoted: "Quote ready to review",
  won: "Booked — on the schedule",
  lost: "Closed"
};
const STATUS_LABELS_SERVICE = {
  new: "Service booked",
  contacted: "Confirmed by PJL",
  site_visit: "Site visit scheduled",
  quoted: "Quote ready to review",
  won: "Service confirmed",
  lost: "Cancelled"
};
function statusLabelFor(status, hasBooking) {
  return (hasBooking ? STATUS_LABELS_SERVICE : STATUS_LABELS_REQUEST)[status] || "Status unknown";
}

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

function renderPhotos(photos) {
  if (!photosCard || !photoGrid) return;
  if (!Array.isArray(photos) || !photos.length) {
    photosCard.hidden = true;
    return;
  }
  photoGrid.innerHTML = "";
  photos.forEach((photo, idx) => {
    const link = document.createElement("a");
    link.href = photo.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "portal-photo-link";
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = `Photo ${idx + 1} you sent us`;
    img.loading = "lazy";
    link.appendChild(img);
    photoGrid.appendChild(link);
  });
  photosCard.hidden = false;
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

  // Diagnosis block — present when this booking came from an AI-chat
  // handoff or other pre-booking diagnostic flow. Hidden otherwise.
  const diagnosis = wo.diagnosis;
  if (diagnosis && (diagnosis.summary || diagnosis.text)) {
    const sourceLabel = (diagnosis.source || "ai_chat")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    workOrderDiagnosisSource.textContent = `Captured by ${sourceLabel}`;
    workOrderDiagnosisSummary.textContent = diagnosis.summary || "";
    workOrderDiagnosisSummary.hidden = !diagnosis.summary;
    // Long-form text — preserve line breaks so multi-paragraph diagnoses
    // read naturally without us needing a markdown parser.
    workOrderDiagnosisDetail.innerHTML = diagnosis.text
      ? escapeHtml(diagnosis.text).replace(/\n/g, "<br>")
      : "";
    workOrderDiagnosis.hidden = false;
  } else {
    workOrderDiagnosis.hidden = true;
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

  const hasBooking = Boolean(data.booking);
  customerFirstName = customer.firstName || "";

  portalTitle.textContent = customerFirstName
    ? (hasBooking
        ? `Hi ${customerFirstName}, your service is scheduled.`
        : `Hi ${customerFirstName}, your PJL request is open.`)
    : (hasBooking ? "Your service is scheduled." : "Your PJL request is open.");
  portalIntro.textContent = hasBooking
    ? "Your appointment details are below. Anything you need to share before we arrive, drop us a message."
    : "Track your project below. Anything you need to share, drop us a message and we'll get back to you.";
  projectStatus.textContent = statusLabelFor(project.status, hasBooking);

  // Personalize the secondary card headings when we know who they are.
  // The "Send PJL a message" + "Need to update something?" cards both work
  // generically, but reading the customer's name in the heading makes the
  // page feel addressed to them rather than templated.
  if (messageHeading) {
    messageHeading.textContent = customerFirstName
      ? `Send PJL a message, ${customerFirstName}`
      : "Send PJL a message";
  }
  if (helpHeading) {
    helpHeading.textContent = customerFirstName
      ? `Need to update something, ${customerFirstName}?`
      : "Need to update something?";
  }
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
    acceptCard.querySelector("h2").textContent = customerFirstName
      ? `Thank you, ${customerFirstName} — quote accepted.`
      : "Quote accepted — thank you";
    const p = acceptCard.querySelector("p");
    if (p) p.textContent = "Your project is booked. Patrick will confirm the exact arrival window with you directly.";
    acceptButton.hidden = true;
  }

  renderTimeline(project.status);
  renderPhotos(project.photos);
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
    acceptStatus.textContent = customerFirstName
      ? `Thank you, ${customerFirstName} — PJL has been notified.`
      : "Quote accepted — PJL has been notified.";
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
    messageStatus.textContent = customerFirstName
      ? `Thanks, ${customerFirstName} — Patrick will get back to you.`
      : "Sent — Patrick will get back to you.";
    messageBody.value = "";
    setTimeout(loadPortal, 600);
  } catch (error) {
    messageStatus.textContent = error.message || "Unable to send message right now. Please call PJL.";
  } finally {
    submit.disabled = false;
  }
});

loadPortal();
