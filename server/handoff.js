// Manual booking handoff. Patrick fills in customer + diagnosis after a
// phone call, picks SMS/email/both, hits send. Server creates a booking
// session and fires the link to the customer the same way the AI agent
// will once that's wired up.

const form = document.getElementById("handoffForm");
const submitBtn = document.getElementById("submitBtn");
const resetBtn = document.getElementById("resetBtn");
const suggestedService = document.getElementById("suggestedService");
const zoneCountSelect = document.getElementById("zoneCountSelect");
const handoffResult = document.getElementById("handoffResult");
const handoffResultTitle = document.getElementById("handoffResultTitle");
const handoffResultMsg = document.getElementById("handoffResultMsg");
const handoffLinkInput = document.getElementById("handoffLinkInput");
const handoffCopyBtn = document.getElementById("handoffCopyBtn");
const handoffOpenBtn = document.getElementById("handoffOpenBtn");
const handoffStatus = document.getElementById("handoffStatus");
const handoffDoneBtn = document.getElementById("handoffDoneBtn");
const logoutButton = document.getElementById("logoutButton");

// Populate the zone-count dropdown 1..24.
for (let n = 1; n <= 24; n++) {
  const opt = document.createElement("option");
  opt.value = String(n);
  opt.textContent = n === 1 ? "1 zone" : `${n} zones`;
  zoneCountSelect.append(opt);
}

// Populate the suggested-service dropdown from the live catalog so it
// stays in sync when new services are added.
fetch("/api/booking/services", { cache: "no-store" })
  .then((r) => r.json())
  .then((data) => {
    if (!data.ok || !data.services) return;
    Object.entries(data.services).forEach(([key, meta]) => {
      if (!meta.bookable) return;
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = meta.label;
      suggestedService.append(opt);
    });
  })
  .catch(() => {});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.assign("/login");
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  const originalText = submitBtn.textContent;
  submitBtn.textContent = "Sending…";

  const fd = new FormData(form);
  const zoneRaw = String(fd.get("zoneCount") || "").trim();
  let zoneCount = null;
  if (zoneRaw === "unsure") zoneCount = "unsure";
  else if (/^\d+$/.test(zoneRaw)) zoneCount = Number(zoneRaw);

  const payload = {
    diagnosis: String(fd.get("diagnosis") || "").trim(),
    diagnosisSummary: String(fd.get("diagnosisSummary") || "").trim(),
    suggestedService: String(fd.get("suggestedService") || "").trim(),
    severity: String(fd.get("severity") || "normal").trim(),
    customerHints: {
      firstName: String(fd.get("firstName") || "").trim(),
      lastName: String(fd.get("lastName") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      phone: String(fd.get("phone") || "").trim(),
      address: String(fd.get("address") || "").trim(),
      zoneCount,
      notes: String(fd.get("notes") || "").trim()
    },
    sendSms: Boolean(fd.get("sendSms")),
    sendEmail: Boolean(fd.get("sendEmail"))
  };

  try {
    const response = await fetch("/api/admin/send-booking-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error((data.errors || ["Couldn't send link."]).join(" "));
    }
    showResult(data, payload);
  } catch (err) {
    alert(err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
});

function showResult(data, payload) {
  handoffResultTitle.textContent = `Link ready for ${payload.customerHints.firstName || "customer"}.`;
  const sentBits = [];
  if (data.smsSent) sentBits.push(`SMS sent to ${payload.customerHints.phone}`);
  if (data.emailSent) sentBits.push(`Email sent to ${payload.customerHints.email}`);
  if (!sentBits.length) sentBits.push("Link generated — copy/paste it to the customer manually");
  handoffResultMsg.textContent = sentBits.join(" · ");

  handoffLinkInput.value = data.bookingUrl;
  handoffOpenBtn.href = data.bookingUrl;

  // Detail status — show success per channel + any errors.
  handoffStatus.innerHTML = "";
  if (payload.sendSms) {
    const li = document.createElement("li");
    li.className = data.smsSent ? "is-ok" : "is-err";
    li.textContent = data.smsSent
      ? `SMS sent to ${payload.customerHints.phone}`
      : `SMS failed: ${data.smsError || "Twilio not configured on this server"}`;
    handoffStatus.append(li);
  }
  if (payload.sendEmail) {
    const li = document.createElement("li");
    li.className = data.emailSent ? "is-ok" : "is-err";
    li.textContent = data.emailSent
      ? `Email sent to ${payload.customerHints.email}`
      : `Email failed: ${data.emailError || "Gmail not configured on this server"}`;
    handoffStatus.append(li);
  }
  const expiresAt = new Date(data.expiresAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
  const expLi = document.createElement("li");
  expLi.className = "is-info";
  expLi.textContent = `Link expires at ${expiresAt} (1 hour from now)`;
  handoffStatus.append(expLi);

  form.hidden = true;
  handoffResult.hidden = false;
  submitBtn.disabled = false;
  submitBtn.textContent = "Generate & Send Link";
}

handoffCopyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(handoffLinkInput.value);
    handoffCopyBtn.textContent = "Copied!";
    setTimeout(() => { handoffCopyBtn.textContent = "Copy"; }, 1500);
  } catch {
    handoffLinkInput.select();
    document.execCommand("copy");
    handoffCopyBtn.textContent = "Copied!";
    setTimeout(() => { handoffCopyBtn.textContent = "Copy"; }, 1500);
  }
});

handoffDoneBtn.addEventListener("click", () => {
  form.reset();
  handoffResult.hidden = true;
  form.hidden = false;
  document.querySelector('[name="firstName"]').focus();
});
