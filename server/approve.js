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

  // Preview banner — tech-only flag from the server payload. Surfaces
  // a sticky "PREVIEW MODE" banner inside the card. The submit
  // interceptor (below) catches accept attempts and shows an inline
  // toast instead of POSTing. Server-side `/sign` also refuses
  // draft_preview quotes (defense in depth), so even a scripted POST
  // can't slip past.
  const previewBanner = document.getElementById("approvePreviewBanner");
  if (q.isPreview) {
    if (previewBanner) previewBanner.hidden = false;
    card.classList.add("is-preview");
  } else {
    if (previewBanner) previewBanner.hidden = true;
    card.classList.remove("is-preview");
  }

  const isProposal = q.type === "project_proposal";
  // Narrative ai_repair_quotes (smart-controller upgrades) ship
  // server-synthesized sections + header copy from the content block —
  // rendered with the same section renderer proposals use, so the
  // e-sign page matches the rich PDF. E-sign stays the only acceptance
  // method for these (no PDF-return path exists for ai_repair_quote).
  const hasNarrative = !isProposal && !!q.narrativeKey && (q.proposalSections || []).length > 0;

  // Header copy — proposals + narrative quotes get tailored wording.
  if (isProposal) {
    document.getElementById("approveEyebrow").textContent = "Project proposal — your acceptance needed";
    document.getElementById("approveHeadline").textContent = "Your detailed proposal is ready for review.";
    document.getElementById("approveIntro").textContent =
      "Review the full scope below. You can accept this proposal either by signing online (Option A) or by printing the PDF, signing by hand, and emailing or uploading the signed copy back (Option B). Both are binding.";
    document.getElementById("approveMethodToggle").hidden = false;
  } else if (hasNarrative) {
    const nh = q.narrativeHeader || {};
    document.getElementById("approveEyebrow").textContent = "Smart controller upgrade — your approval needed";
    document.getElementById("approveHeadline").textContent = nh.headline || "Your upgrade quote is ready.";
    document.getElementById("approveIntro").textContent =
      (nh.intro || "Review the details below.") + " Sign at the bottom and we'll reach out to schedule your install.";
  }
  if (isProposal || hasNarrative) {
    // Render the narrative sections.
    const propEl = document.getElementById("approveProposal");
    propEl.hidden = false;
    propEl.innerHTML = "";
    const sections = (q.proposalSections || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    for (const s of sections) {
      if (s.kind === "line_items" || s.kind === "acceptance_block") continue;
      if (!s.body && !(s.attachmentIds && s.attachmentIds.length)) continue;
      const sectionEl = document.createElement("section");
      sectionEl.className = "approve-section";
      const title = document.createElement("h3");
      title.textContent = s.title || s.kind;
      sectionEl.appendChild(title);
      if (s.body) {
        const paragraphs = String(s.body)
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/g, " ")
          .split(/\n\n+/);
        for (const p of paragraphs) {
          if (!p.trim()) continue;
          const pe = document.createElement("p");
          pe.textContent = p.trim();
          sectionEl.appendChild(pe);
        }
      }
      // Anchored attachments — render images inline (PDFs surface as a link).
      if (Array.isArray(s.attachmentIds) && s.attachmentIds.length) {
        for (const attId of s.attachmentIds) {
          const att = (q.attachments || []).find((a) => a.id === attId);
          if (!att) continue;
          const isImage = att.mimeType === "image/png" || att.mimeType === "image/jpeg";
          if (isImage) {
            const fig = document.createElement("figure");
            fig.className = "approve-figure";
            const img = document.createElement("img");
            img.src = `/api/approve/${encodeURIComponent(quoteId)}/${encodeURIComponent(token)}/attachments/${encodeURIComponent(attId)}`;
            img.alt = att.caption || att.filename || "";
            fig.appendChild(img);
            if (att.caption) {
              const cap = document.createElement("figcaption");
              cap.textContent = att.caption;
              fig.appendChild(cap);
            }
            sectionEl.appendChild(fig);
          } else {
            const note = document.createElement("p");
            note.className = "approve-attach-note";
            note.textContent = `See attachment: ${att.caption || att.filename || attId}`;
            sectionEl.appendChild(note);
          }
        }
      }
      propEl.appendChild(sectionEl);
    }
  }
  if (isProposal) {
    // Wire the method toggle (proposal-only — narrative quotes are
    // e-sign only, the default non-proposal state).
    document.querySelectorAll(".approve-method-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".approve-method-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
        const method = btn.dataset.method;
        signBlock.hidden = method !== "esign";
        document.getElementById("approvePdfReturnBlock").hidden = method !== "pdf";
      });
    });
    // PDF-return panel meta.
    document.getElementById("approveReturnId").textContent = q.id;
  }

  // Strip the admin-only "[inherited from WO-XXX]" / "[from WO-XXX]"
  // breadcrumb from line.note before showing to the customer. New
  // follow-ups (post 2026-06-02 fix) store the breadcrumb in
  // source.inheritedFromWoId instead, so line.note is clean. This
  // regex covers the legacy polluted records that were written
  // before the fix.
  function customerNote(raw) {
    return String(raw || "").replace(/^\[(?:inherited from|from)\s+WO-[A-Z0-9-]+\]\s*/i, "").trim();
  }
  // Line items.
  linesEl.innerHTML = "";
  for (const l of q.lineItems || []) {
    const row = document.createElement("div");
    row.className = "approve-line";
    const price = (l.overridePrice != null && Number.isFinite(Number(l.overridePrice))) ? Number(l.overridePrice) : Number(l.price || l.originalPrice || 0);
    const lineTotal = Number.isFinite(Number(l.lineTotal)) ? Number(l.lineTotal) : price * (Number(l.qty) || 1);
    const cleanNote = customerNote(l.note);
    row.innerHTML = `
      <div class="approve-line-desc">
        <strong>${escapeHtml(l.label || l.key || "Line")}</strong>
        ${cleanNote ? `<p class="approve-line-note">${escapeHtml(cleanNote)}</p>` : ""}
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

  // If already signed OR awaiting attestation, show success state instead of pad.
  if (q.signedAt || q.status === "pending_admin_attestation" || q.status === "accepted") {
    signBlock.hidden = true;
    document.getElementById("approveMethodToggle").hidden = true;
    document.getElementById("approvePdfReturnBlock").hidden = true;
    successBlock.hidden = false;
    if (q.status === "pending_admin_attestation") {
      document.getElementById("approveSuccessHeadline").textContent = "✓ Received.";
      document.getElementById("approveSuccessBody").innerHTML =
        "Thanks — we've received your signed PDF. PJL is reviewing it now and will confirm acceptance shortly.";
    } else {
      document.getElementById("approveSuccessName").textContent = q.signedBy || "(customer)";
      document.getElementById("approveSuccessMeta").textContent = q.signedAt
        ? `Signed ${new Date(q.signedAt).toLocaleString()}`
        : `Accepted`;
    }
    return;
  }

  // Otherwise wire up the pad.
  pad = createSignaturePad(canvas, updateSubmit);
  updateSubmit();
  wirePdfReturn();
}

// PDF-return submit handler — base64 file upload to the tokenized
// /pdf-return endpoint.
function wirePdfReturn() {
  const fileInput = document.getElementById("approvePdfInput");
  const submitBtn = document.getElementById("approvePdfSubmit");
  const errMsg = document.getElementById("approvePdfErrorMsg");
  const senderEmailInput = document.getElementById("approveSenderEmail");
  if (!fileInput || !submitBtn) return;
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    submitBtn.disabled = !f;
  });
  submitBtn.addEventListener("click", async () => {
    errMsg.hidden = true;
    const f = fileInput.files?.[0];
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) {
      errMsg.textContent = "File too large — 25 MB max.";
      errMsg.hidden = false;
      return;
    }
    submitBtn.disabled = true;
    const orig = submitBtn.textContent;
    submitBtn.textContent = "Uploading…";
    try {
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = () => rej(new Error("Could not read file."));
        fr.readAsDataURL(f);
      });
      const base64 = String(dataUrl).split(",")[1] || "";
      const r = await fetch(`/api/approve/${encodeURIComponent(quoteId)}/${encodeURIComponent(token)}/pdf-return`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: f.name,
          data: base64,
          senderEmail: senderEmailInput.value.trim()
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.errors?.[0] || "Upload failed.");
      // Show success — pending admin attest.
      signBlock.hidden = true;
      document.getElementById("approveMethodToggle").hidden = true;
      document.getElementById("approvePdfReturnBlock").hidden = true;
      successBlock.hidden = false;
      document.getElementById("approveSuccessHeadline").textContent = "✓ Received.";
      document.getElementById("approveSuccessBody").innerHTML =
        "Thanks — we've received your signed PDF. PJL is reviewing it now and will confirm acceptance within one business day.";
      document.getElementById("approveSuccessMeta").textContent = "Uploaded " + new Date().toLocaleString();
    } catch (err) {
      errMsg.textContent = err.message || "Upload failed.";
      errMsg.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = orig;
    }
  });
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
  // Preview-mode short-circuit. If this URL was generated by the WO's
  // "Preview as customer" button, refuse to fire — and surface a clear
  // "preview only" message instead of the silent disabled-button feel.
  // Server-side /sign also refuses; this is the friendly client guard.
  if (currentQuote && currentQuote.isPreview) {
    errMsg.textContent = "Preview only — no acceptance recorded. Close this tab and use 'Send for customer approval' to send the real link.";
    errMsg.hidden = false;
    return;
  }
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
