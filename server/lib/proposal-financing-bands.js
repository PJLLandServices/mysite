// Financing bands on the customer proposal page (PJL-35 TRD §3/§4).
// Pure HTML-string functions, deliberately separate from server.js so
// they're directly testable (server.js can't safely be require()'d in a
// unit test — it boots the whole app). server.js's injectProposalAcceptFooter
// calls financingHeroBandHtml/financingFooterContentHtml and splices the
// result into the serve-time HTML; this module owns no I/O and no routing.
//
// Only ever rendered when q.financing?.enabled === true — a plain
// proposal (financing never enabled, per PJL-34's draft-only gate on
// enableFinancingForQuote) carries neither band, matching the PRD's
// "there's no plain-proposal-that-might-upgrade case" finding.
//
// Badge: the real file Patrick supplied, at server/klarna-badge.png.
// Served at /crm/klarna-badge.png — SERVER_DIR (server/) is only reachable
// over HTTP through the /crm/ prefix (server.js's resolveStaticTarget
// strips just that prefix); anything without it falls through to SITE_DIR
// (the repo root) instead and 404s. Sized at a fixed 78px tall everywhere
// per the PRD's minimum-size math (badge sets the row's scale, never the
// other way around) — computed against this exact file: the wordmark
// occupies 54.3% of the 641x372 canvas, so 78px tall clears the 70px-wide
// minimum for the wordmark itself. One asset for both bands: it's a
// self-contained pink pill (its own background, not a transparent
// wordmark needing a light/dark pair), the same asset used in every
// mockup Patrick approved against both the light hero band and the dark
// footer band.

const quotes = require("./quotes");

const KLARNA_BADGE = "/crm/klarna-badge.png";

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// The band's BACKGROUND (cream + orange top border) stretches edge to
// edge, matching how the rest of the page's own bands work — but the
// CONTENT inside has to stay in the same max-width:1180px column
// everything else on the page uses (.wrap, in sprinkler-theme.css),
// or it drifts to the literal left/right edges of the browser window
// on a wide monitor. Missing that the first time is exactly what
// produced the huge, unbalanced-looking gap Patrick flagged from a
// screenshot on his own (wide) screen — it never showed up in this
// session's own mockup renders because those were always cropped to a
// narrow 1280px frame, which happens to be close to the 1180px cap.
function heroBandWrap(inner) {
  return `
<div id="pjl-fin-hero-band" style="background:#FAFAF5;border-top:4px solid #E07B24;">
  <style>
    #pjl-fin-hero-band-in{max-width:1180px;margin:0 auto;padding:36px clamp(20px,5vw,64px);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:18px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
    #pjl-fin-hero-band .pjl-fin-head{font-weight:800;text-transform:uppercase;color:#1B4D2E;font-size:clamp(28px,3.8vw,44px);line-height:1.08;margin:0;}
    #pjl-fin-hero-band .pjl-fin-head em{font-style:normal;color:#E07B24;}
    #pjl-fin-hero-band .pjl-fin-by{display:flex;align-items:center;gap:16px;}
    #pjl-fin-hero-band .pjl-fin-by span{font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#5F6F63;white-space:nowrap;}
    #pjl-fin-hero-band .pjl-fin-badge{height:78px;width:auto;display:block;}
    #pjl-fin-hero-band .pjl-fin-status{font-weight:700;font-size:26px;color:#1B4D2E;margin:0;}
  </style>
  <div id="pjl-fin-hero-band-in">
  ${inner}
  </div>
</div>`;
}

function financingHeroBandHtml(q) {
  if (!q?.financing || q.financing.enabled !== true) return "";
  if (quotes.isAccepted(q)) return ""; // signed — hero band's done its job
  const stage = q.financing.stage || "not_offered";
  const pitch = q.financing.pairedWithDeposit
    ? { head: "Fund the remaining balance fast.<br><em>Flexible financing.</em>", sub: "Backed securely by" }
    : { head: "Fund your project fast.<br><em>Flexible financing.</em>", sub: "Backed securely by" };

  if (stage === "authorized") {
    return heroBandWrap(`<p class="pjl-fin-status">You're approved for financing.</p>`);
  }
  if (stage === "declined") {
    return heroBandWrap(`<p class="pjl-fin-status">Financing wasn't available this time.</p>`);
  }
  // not_offered or link_sent — same pitch line either way; they've
  // already seen it once and it shouldn't disappear mid-wait.
  return heroBandWrap(`
    <h2 class="pjl-fin-head">${pitch.head}</h2>
    <div class="pjl-fin-by"><span>${pitch.sub}</span><img src="${KLARNA_BADGE}" alt="Klarna" class="pjl-fin-badge"></div>`);
}

// Financing content prepended INSIDE the existing #pjl-accept-footer div
// (same #0F1F14 background regardless of state) rather than a separate
// section — this is what avoids the seam problem several earlier design
// rounds hit (TRD §4(b)). Returns "" once signed: at that point the
// existing accepted-branch copy already covers it, no financing framing
// needed on top.
function financingFooterContentHtml(q, { signHref, token } = {}) {
  if (!q?.financing || q.financing.enabled !== true) return "";
  if (quotes.isAccepted(q)) return "";
  const stage = q.financing.stage || "not_offered";
  const pitch = q.financing.pairedWithDeposit
    ? "Fund the remaining balance fast.<br>Flexible financing."
    : "Fund your project fast.<br>Flexible financing.";
  const eyebrowBadge = `
    <p style="margin:0 0 18px;color:#F59B4A;font-size:12px;font-weight:600;letter-spacing:.3em;text-transform:uppercase;">Financing available on this project</p>
    <h2 style="margin:0 0 26px;color:#FAFAF5;font-weight:800;text-transform:uppercase;font-size:clamp(32px,5vw,54px);line-height:1.03;">${pitch}</h2>
    <div style="display:flex;align-items:center;justify-content:center;gap:18px;margin:0 0 40px;">
      <span style="color:rgba(250,250,245,.74);font-size:18px;font-weight:600;">Backed securely by</span>
      <img src="${KLARNA_BADGE}" alt="Klarna" style="height:78px;width:auto;display:block;">
    </div>`;

  if (stage === "authorized") {
    return `
${eyebrowBadge}
  <p style="margin:0 0 8px;color:#EAF3DE;font-size:20px;font-weight:700;">You're approved for financing — now let's get this signed to move ahead.</p>
  <p style="margin:0 auto 22px;max-width:44ch;color:#9FB3A6;font-size:14px;line-height:1.55;">Review the scope &amp; pricing summary and sign online — it takes about a minute on any device.</p>
  <a href="${signHref}" style="display:inline-block;padding:16px 32px;background:#E07B24;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">Accept &amp; sign online</a>`;
  }
  if (stage === "declined") {
    return `
${eyebrowBadge}
  <p style="margin:0 0 18px;max-width:46ch;margin-left:auto;margin-right:auto;color:#9FB3A6;font-size:14px;line-height:1.55;">Klarna wasn't able to approve financing this time — see the email we sent you for other options.</p>
  <a href="${signHref}" style="display:inline-block;padding:16px 32px;background:#E07B24;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;">Accept &amp; sign online</a>`;
  }
  if (stage === "link_sent") {
    return `
${eyebrowBadge}
  <p style="margin:0;color:#EAF3DE;font-size:20px;font-weight:700;">Check your email — your Klarna application link is waiting.</p>
  <p style="margin:10px 0 0;color:#9FB3A6;font-size:14px;">Nothing to sign yet.</p>`;
  }
  // not_offered — the apply-financing button. Vanilla JS: no framework
  // on this page, and this is the only interactive element it needs.
  const safeToken = escapeHtml(token || "");
  const safeQuoteId = escapeHtml(q.id || "");
  return `
${eyebrowBadge}
  <p style="margin:0 0 8px;color:#EAF3DE;font-size:20px;font-weight:700;">Ready to fund this project?</p>
  <p style="margin:0 auto 22px;max-width:46ch;color:#9FB3A6;font-size:14px;line-height:1.55;">Apply for Klarna financing — most decisions come back in seconds. You'll sign once you're approved.</p>
  <button type="button" id="pjl-apply-financing-btn" data-token="${safeToken}" data-quote-id="${safeQuoteId}" style="display:inline-block;padding:16px 32px;background:#E07B24;color:#fff;border:0;text-decoration:none;border-radius:8px;font-weight:700;font-size:16px;cursor:pointer;">Apply for financing</button>
  <p id="pjl-apply-financing-error" style="display:none;margin:16px 0 0;color:#F2B8B8;font-size:13px;"></p>
  <script>
  (function () {
    var btn = document.getElementById('pjl-apply-financing-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var errEl = document.getElementById('pjl-apply-financing-error');
      btn.disabled = true;
      btn.textContent = 'Applying…';
      fetch('/api/approve/' + encodeURIComponent(btn.dataset.quoteId) + '/' + encodeURIComponent(btn.dataset.token) + '/apply-financing', { method: 'POST' })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (res) {
          if (res.ok && res.data && res.data.paymentLinkUrl) { window.location.href = res.data.paymentLinkUrl; return; }
          if (res.data && res.data.alreadyRan) { window.location.reload(); return; }
          throw new Error((res.data && res.data.warning) || 'Something went wrong.');
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = 'Apply for financing';
          if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Something went wrong — please call us at (905) 960-0181.'; }
        });
    });
  })();
  </script>`;
}

module.exports = { KLARNA_BADGE, financingHeroBandHtml, financingFooterContentHtml };
