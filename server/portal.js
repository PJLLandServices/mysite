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
const systemCard = document.getElementById("systemCard");
const systemGrid = document.getElementById("systemGrid");
const systemZones = document.getElementById("systemZones");
const systemZoneList = document.getElementById("systemZoneList");

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

// "Your System" card. Renders the customer's property profile (zones,
// controller location, valve boxes, blowout point) — exactly the data
// the technician will see on-site. Read-only here; if anything's wrong
// the customer can use the message form to send a correction.
function renderSystem(property) {
  if (!systemCard) return;
  if (!property || !property.system) {
    systemCard.hidden = true;
    return;
  }
  const sys = property.system;
  const rows = [];
  if (sys.controllerLocation || sys.controllerBrand) {
    const value = [sys.controllerBrand, sys.controllerLocation].filter(Boolean).join(" — ");
    rows.push(["Controller", value]);
  }
  if (sys.shutoffLocation) rows.push(["Main shut-off", sys.shutoffLocation]);
  if (sys.blowoutLocation) rows.push(["Blow-out point", sys.blowoutLocation]);
  if (Array.isArray(sys.valveBoxes) && sys.valveBoxes.length) {
    const vbDescription = sys.valveBoxes
      .map((b) => `${b.location || "?"} (${b.valveCount || 0} valve${b.valveCount === 1 ? "" : "s"})`)
      .join("; ");
    rows.push(["Valve boxes", vbDescription]);
  }

  if (!rows.length && !(sys.zones || []).length) {
    // Property exists but no profile data filled in yet — keep card hidden
    // so the portal doesn't show a half-empty section.
    systemCard.hidden = true;
    return;
  }

  systemGrid.innerHTML = "";
  rows.forEach(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    systemGrid.appendChild(dt);
    systemGrid.appendChild(dd);
  });

  const zones = Array.isArray(sys.zones) ? sys.zones : [];
  if (zones.length) {
    // Lookup tables for the structured pill values stored on each zone.
    // Kept inline rather than imported from the admin module so the portal
    // bundle stays self-contained.
    const SPRINKLER_LABELS = { rotors: "Rotors", popups: "Pop-ups", drip: "Drip", flower_pots: "Flower Pots" };
    const COVERAGE_LABELS  = { plants: "Plants", grass: "Grass", trees: "Trees" };
    const labelFor = (lookup, value) => lookup[value] || value;

    systemZoneList.innerHTML = "";
    zones
      .slice()
      .sort((a, b) => (a.number || 0) - (b.number || 0))
      .forEach((z) => {
        const li = document.createElement("li");
        const num = z.number ? `Zone ${z.number}` : "Zone";
        const location = z.location || z.label || "";
        const head = location ? `${num} — ${location}` : num;

        const sprinklerLabels = (z.sprinklerTypes || []).map((v) => labelFor(SPRINKLER_LABELS, v));
        const coverageLabels  = (z.coverage       || []).map((v) => labelFor(COVERAGE_LABELS, v));
        const meta = [];
        if (sprinklerLabels.length) meta.push(sprinklerLabels.join(", "));
        if (coverageLabels.length)  meta.push(coverageLabels.join(", "));

        li.textContent = head;
        if (meta.length) {
          const small = document.createElement("span");
          small.className = "portal-system-zone-meta";
          small.textContent = ` · ${meta.join(" · ")}`;
          li.appendChild(small);
        }
        systemZoneList.appendChild(li);
      });
    systemZones.hidden = false;
  } else {
    systemZones.hidden = true;
  }

  systemCard.hidden = false;
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
  renderSystem(data.property);
  renderWorkOrder(data);
  // Open recommendations card — fetches deferred items the customer can
  // pre-authorize. Async; reveals the card when ready, hidden until then.
  loadRecommendations().catch((err) => console.warn("[recommendations]", err?.message));

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

// ---- Open recommendations (deferred items, spec §5/§6) ----------------

const RECOMMENDATION_TYPE_LABELS = {
  broken_head: "Broken sprinkler head",
  leak: "Leak",
  valve: "Valve",
  wire: "Wire issue",
  pipe: "Pipe break",
  other: "Other"
};

const recommendationsCard = document.getElementById("recommendationsCard");
const recommendationsList = document.getElementById("recommendationsList");

async function loadRecommendations() {
  const token = tokenFromLocation();
  if (!token || !recommendationsCard || !recommendationsList) return;
  let items = [];
  try {
    const r = await fetch(`/api/portal/${encodeURIComponent(token)}/deferred`, { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (data.ok && Array.isArray(data.deferred)) items = data.deferred;
  } catch {
    return;
  }
  if (!items.length) {
    recommendationsCard.hidden = true;
    return;
  }
  recommendationsCard.hidden = false;
  recommendationsList.innerHTML = "";
  for (const item of items) recommendationsList.appendChild(buildRecommendationCard(item));
}

function buildRecommendationCard(item) {
  const card = document.createElement("article");
  card.className = "portal-recommendation";
  card.dataset.deferredId = item.id;
  const typeLabel = RECOMMENDATION_TYPE_LABELS[item.type] || item.type || "Recommendation";
  const zoneTag = Number.isFinite(Number(item.fromZone)) ? `Zone ${item.fromZone}` : "Your system";
  const snap = item.suggestedPriceSnapshot;
  const totalText = (snap && Number.isFinite(Number(snap.total)))
    ? `$${Number(snap.total).toFixed(2)} incl. HST`
    : "Quote on next visit";
  const lineItems = (snap && Array.isArray(snap.lineItems))
    ? snap.lineItems.map((l) => `<li>${escapeHtmlPortal(l.label || l.key || "Repair line")} <span class="portal-rec-line-qty">× ${escapeHtmlPortal(String(l.qty || 1))}</span></li>`).join("")
    : "";
  const photoStrip = (Array.isArray(item.photoIds) && item.photoIds.length && item.fromWoId)
    ? `<div class="portal-rec-photos">${item.photoIds.slice(0, 4).map((n) =>
        `<a class="portal-rec-photo" href="/api/portal/${encodeURIComponent(tokenFromLocation())}/wo-photo/${encodeURIComponent(item.fromWoId)}/${n}" target="_blank" rel="noopener" style="background-image:url('/api/portal/${encodeURIComponent(tokenFromLocation())}/wo-photo/${encodeURIComponent(item.fromWoId)}/${n}')" aria-label="Photo from prior visit"></a>`
      ).join("")}</div>`
    : "";
  card.innerHTML = `
    <header class="portal-rec-head">
      <div>
        <span class="portal-rec-zone">${escapeHtmlPortal(zoneTag)}</span>
        <strong class="portal-rec-type">${escapeHtmlPortal(typeLabel)}</strong>
      </div>
      <span class="portal-rec-total">${escapeHtmlPortal(totalText)}</span>
    </header>
    ${item.notes ? `<p class="portal-rec-notes">${escapeHtmlPortal(item.notes)}</p>` : ""}
    ${photoStrip}
    ${lineItems ? `<ul class="portal-rec-lines">${lineItems}</ul>` : ""}
    <button type="button" class="portal-btn portal-btn-primary portal-rec-action" data-preauth-id="${escapeHtmlPortal(item.id)}" data-preauth-summary="${escapeHtmlPortal(`${typeLabel} — ${zoneTag} — ${totalText}`)}">Pre-authorize this repair</button>
  `;
  return card;
}

function escapeHtmlPortal(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Delegated click — opens the pre-auth modal for the chosen item.
recommendationsList?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-preauth-id]");
  if (!btn) return;
  openPreauthModal({
    deferredId: btn.dataset.preauthId,
    summary: btn.dataset.preauthSummary || ""
  });
});

// ---- Pre-auth signature modal (mirrors the tech-side createSignaturePad
//      pattern, slimmed for portal use). Captures the customer's signature
//      and POSTs to /api/portal/<token>/deferred/<id>/pre-authorize. -------

let preauthContext = null;
let preauthPad = null;

function openPreauthModal(ctx) {
  preauthContext = ctx;
  const modal = document.getElementById("preauthModal");
  const summary = document.getElementById("preauthSummary");
  const nameInput = document.getElementById("preauthName");
  const errEl = document.getElementById("preauthError");
  const submit = document.getElementById("preauthSubmit");
  if (!modal) return;
  if (summary) summary.textContent = ctx.summary || "";
  if (nameInput) nameInput.value = customerFirstName || "";
  if (errEl) errEl.hidden = true;
  if (submit) { submit.disabled = true; submit.textContent = "Pre-authorize"; }
  modal.hidden = false;
  document.body.classList.add("portal-modal-open");
  const canvas = document.getElementById("preauthCanvas");
  if (canvas) preauthPad = createPortalSignaturePad(canvas, updatePreauthSubmitState);
  updatePreauthSubmitState();
}

function closePreauthModal() {
  const modal = document.getElementById("preauthModal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("portal-modal-open");
  preauthContext = null;
  preauthPad = null;
}

function updatePreauthSubmitState() {
  const submit = document.getElementById("preauthSubmit");
  const name = document.getElementById("preauthName")?.value.trim();
  const drawn = !!(preauthPad && preauthPad.isDirty && preauthPad.isDirty());
  if (submit) submit.disabled = !(name && drawn);
}

document.getElementById("preauthClose")?.addEventListener("click", closePreauthModal);
document.getElementById("preauthClear")?.addEventListener("click", () => {
  if (preauthPad && preauthPad.clear) preauthPad.clear();
  updatePreauthSubmitState();
});
document.getElementById("preauthName")?.addEventListener("input", updatePreauthSubmitState);
// Backdrop click + Esc — escape hatches so the modal can never trap the user.
document.getElementById("preauthModal")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closePreauthModal();
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const modal = document.getElementById("preauthModal");
  if (modal && !modal.hidden) closePreauthModal();
});

document.getElementById("preauthSubmit")?.addEventListener("click", async () => {
  if (!preauthContext) return;
  const submit = document.getElementById("preauthSubmit");
  const errEl = document.getElementById("preauthError");
  if (errEl) errEl.hidden = true;
  if (submit) { submit.disabled = true; submit.textContent = "Sending…"; }
  try {
    const token = tokenFromLocation();
    const customerName = document.getElementById("preauthName")?.value.trim();
    const imageData = preauthPad?.toDataURL ? preauthPad.toDataURL() : "";
    if (!customerName || !imageData) throw new Error("Name and signature required.");
    const r = await fetch(
      `/api/portal/${encodeURIComponent(token)}/deferred/${encodeURIComponent(preauthContext.deferredId)}/pre-authorize`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerName, imageData })
      }
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't pre-authorize.");
    closePreauthModal();
    // Re-fetch — the pre-authorized item drops off the customer-facing list.
    await loadRecommendations();
  } catch (err) {
    if (errEl) { errEl.textContent = err.message || "Failed."; errEl.hidden = false; }
    if (submit) { submit.disabled = false; submit.textContent = "Pre-authorize"; }
  }
});

// Self-contained signature pad — kept separate from the tech-side helper
// because this file doesn't import that one and we don't want a shared
// global. Same drawing API: { isDirty, clear, toDataURL }.
function createPortalSignaturePad(canvas, onChange) {
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let dirty = false;
  function fitCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    const snapshot = canvas.width ? canvas.toDataURL() : null;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0F1F14";
    ctx.lineWidth = 2.2 * dpr;
    if (snapshot && dirty) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = snapshot;
    }
  }
  fitCanvas();
  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height)
    };
  }
  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!dirty) { dirty = true; if (onChange) onChange(); }
    e.preventDefault();
  });
  const endStroke = (e) => {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  canvas.addEventListener("pointerup", endStroke);
  canvas.addEventListener("pointercancel", endStroke);
  return {
    isDirty() { return dirty; },
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      dirty = false;
      if (onChange) onChange();
    },
    toDataURL() { return canvas.toDataURL("image/png"); }
  };
}

loadPortal();
