// Customer-facing remote-approval page. Reads quote id + token from
// the URL (/approve/<id>?t=<token>), fetches a slim quote payload,
// renders scope + total + signature pad. On submit POSTs the signature
// to the public sign endpoint and shows the success state.

const params = new URLSearchParams(location.search);
const idMatch = location.pathname.match(/^\/approve\/([^/]+)\/?$/);
const quoteId = idMatch ? decodeURIComponent(idMatch[1]) : null;
const token = params.get("t") || "";

const loading = document.getElementById("approveLoading");
const card = document.getElementById("approveCard");
const errBlock = document.getElementById("approveError");
const linesEl = document.getElementById("approveLines");
const signBlock = document.getElementById("approveSignBlock");
const successBlock = document.getElementById("approveSuccess");
const submitBtn = document.getElementById("approveSubmit");
const errMsg = document.getElementById("approveErrorMsg");
const nameInput = document.getElementById("approveName");
const canvas = document.getElementById("approveCanvas");

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmt(n) { return "$" + (Number(n) || 0).toFixed(2); }

let pad = null;
let currentQuote = null;

async function load() {
  if (!quoteId || !token) {
    loading.hidden = true;
    errBlock.hidden = false;
    return;
  }
  try {
    const r = await fetch(`/api/approve/${encodeURIComponent(quoteId)}/${encodeURIComponent(token)}`, { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      loading.hidden = true;
      errBlock.hidden = false;
      return;
    }
    currentQuote = data.quote;
    render(data.quote);
  } catch {
    loading.hidden = true;
    errBlock.hidden = false;
  }
}

function render(q) {
  loading.hidden = true;
  card.hidden = false;
  linesEl.innerHTML = "";
  for (const l of q.lineItems || []) {
    const row = document.createElement("div");
    row.className = "approve-line";
    const price = (l.overridePrice != null && Number.isFinite(Number(l.overridePrice))) ? Number(l.overridePrice) : Number(l.price || l.originalPrice || 0);
    const lineTotal = Number.isFinite(Number(l.lineTotal)) ? Number(l.lineTotal) : price * (Number(l.qty) || 1);
    row.innerHTML = `
      <div class="approve-line-desc">
        <strong>${escapeHtml(l.label || l.key || "Line")}</strong>
        ${l.note ? `<p class="approve-line-note">${escapeHtml(l.note)}</p>` : ""}
      </div>
      <div class="approve-line-qty">× ${escapeHtml(String(l.qty || 1))}</div>
      <div class="approve-line-amount">${fmt(lineTotal)}</div>
    `;
    linesEl.appendChild(row);
  }
  // PDF download link — same quote rendered as a one-page document the
  // customer can save / print. Token in the URL gates access.
  const pdfLink = document.getElementById("approvePdfLink");
  if (pdfLink && quoteId && token) {
    pdfLink.href = `/api/approve/${encodeURIComponent(quoteId)}/${encodeURIComponent(token)}/pdf`;
  }

  document.getElementById("approveSubtotal").textContent = fmt(q.subtotal);
  document.getElementById("approveHst").textContent = fmt(q.hst);
  document.getElementById("approveTotal").textContent = fmt(q.total);

  // If already signed, show success state instead of pad.
  if (q.signedAt) {
    signBlock.hidden = true;
    successBlock.hidden = false;
    document.getElementById("approveSuccessName").textContent = q.signedBy || "(customer)";
    document.getElementById("approveSuccessMeta").textContent = `Signed ${new Date(q.signedAt).toLocaleString()}`;
    return;
  }

  // Otherwise wire up the pad.
  pad = createSignaturePad(canvas, updateSubmit);
  updateSubmit();
}

function updateSubmit() {
  const name = nameInput.value.trim();
  const drawn = !!(pad && pad.isDirty && pad.isDirty());
  submitBtn.disabled = !(name && drawn);
}

nameInput.addEventListener("input", updateSubmit);
document.getElementById("approveClear").addEventListener("click", () => {
  if (pad) pad.clear();
  updateSubmit();
});

submitBtn.addEventListener("click", async () => {
  errMsg.hidden = true;
  submitBtn.disabled = true;
  const original = submitBtn.textContent;
  submitBtn.textContent = "Sending…";
  try {
    const customerName = nameInput.value.trim();
    const imageData = pad?.toDataURL ? pad.toDataURL() : "";
    if (!customerName || !imageData) throw new Error("Name and signature required.");
    const r = await fetch(`/api/approve/${encodeURIComponent(quoteId)}/${encodeURIComponent(token)}/sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerName, imageData })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors && data.errors[0]) || "Couldn't process signature.");
    signBlock.hidden = true;
    successBlock.hidden = false;
    document.getElementById("approveSuccessName").textContent = customerName;
    document.getElementById("approveSuccessMeta").textContent = data.alreadySigned
      ? "(this quote was already signed earlier)"
      : "Signed " + new Date().toLocaleString();
  } catch (err) {
    errMsg.textContent = err.message || "Failed.";
    errMsg.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = original;
  }
});

// Self-contained signature pad — same behaviour as the portal/tech pads,
// inlined so this page has no extra script dependencies.
function createSignaturePad(canvas, onChange) {
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
  const end = (e) => {
    if (!drawing) return;
    drawing = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  return {
    isDirty() { return dirty; },
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; if (onChange) onChange(); },
    toDataURL() { return canvas.toDataURL("image/png"); }
  };
}

load();
