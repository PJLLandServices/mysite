/*
 * Client-side anti-bot helpers — companion to server/lib/anti-bot.js.
 *
 * Each public form on the site:
 *   1. Loads `/api/public-config.js` SYNCHRONOUSLY in <head> — sets
 *      window.PJL_TURNSTILE_SITEKEY from the server-side env var.
 *   2. Loads Cloudflare's api.js with `?render=explicit&onload=onloadTurnstileCallback`
 *      so it doesn't auto-render on page load. We render programmatically
 *      below — eliminates the race where Cloudflare scans the DOM and
 *      renders widgets with the hardcoded TEST sitekey before our client
 *      JS gets a chance to swap in the real key.
 *   3. Renders an off-screen honeypot input named "contact_website" via
 *      the shared `.pjl-hp-field` CSS class.
 *   4. Renders a hidden `_ts` input that this script stamps with Date.now()
 *      on page load (or, for the sprinkler-builder, on builder-open).
 *   5. Renders `<div class="cf-turnstile pjl-turnstile">` placeholders that
 *      we hydrate via turnstile.render() once Cloudflare's api.js is ready.
 *
 * The form's submit handler decorates its payload via
 * `window.pjlAntiBot.augmentPayload(payload, form)` — pulls the three
 * defense fields off the form and merges them into the outgoing JSON.
 */
(function () {
  'use strict';

  // Cloudflare TEST key — always-passes invisible widget. Used as a
  // fallback when window.PJL_TURNSTILE_SITEKEY is empty (local dev,
  // pre-Turnstile rollout). When the real key arrives via the
  // /api/public-config.js endpoint, it takes priority.
  var DEFAULT_SITEKEY = '1x00000000000000000000AA';
  var lastToken = '';

  function currentSitekey() {
    return (typeof window !== 'undefined' && window.PJL_TURNSTILE_SITEKEY)
      ? String(window.PJL_TURNSTILE_SITEKEY)
      : DEFAULT_SITEKEY;
  }

  // Explicit-render path. We loaded Cloudflare's api.js with
  // `?render=explicit&onload=onloadTurnstileCallback` — when it finishes
  // loading, it calls this global. We then walk every .cf-turnstile div
  // on the page and render it with the right sitekey. Idempotent — the
  // data-pjl-rendered guard means a second invocation (e.g. from our
  // local bootstrap fallback below) skips already-mounted widgets.
  function renderAllWidgets() {
    if (typeof window === 'undefined' || !window.turnstile || typeof window.turnstile.render !== 'function') return;
    var key = currentSitekey();
    var nodes = document.querySelectorAll('.cf-turnstile');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.dataset.pjlRendered === '1') continue;
      el.dataset.pjlRendered = '1';
      try {
        window.turnstile.render(el, {
          sitekey: key,
          callback: function (token) { if (typeof token === 'string') lastToken = token; },
          'error-callback': function () { /* let the server gate handle missing-token; user-facing copy lives there */ },
          theme: el.dataset.theme || 'light'
        });
      } catch (err) {
        // Don't take the page down if Turnstile fails to render. Server
        // will reject submissions without a token — same UX as a network
        // failure on the api.js download.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[anti-bot] turnstile.render failed:', err && err.message);
        }
      }
    }
  }

  // Cloudflare invokes this when api.js finishes loading. Global name
  // must match the `onload=` query param on the script src.
  window.onloadTurnstileCallback = function () { renderAllWidgets(); };

  // Back-compat shim: legacy data-callback="pjlOnTurnstile" from earlier
  // auto-render builds still routes the token into our global. Harmless
  // for the explicit-render path (the callback set inside render() takes
  // priority and writes the same global).
  window.pjlOnTurnstile = function (token) { if (typeof token === 'string' && token) lastToken = token; };

  function bootstrap() {
    var tsInputs = document.querySelectorAll('input[data-pjl-ts]');
    for (var j = 0; j < tsInputs.length; j++) tsInputs[j].value = String(Date.now());
    // If Cloudflare's onload already fired (it can, depending on cache /
    // ordering), the widgets are mounted. If api.js is still in flight,
    // this no-ops and the onload callback above will fire it later.
    renderAllWidgets();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }

  // Decorator: takes a JS object that will be POSTed, and adds the three
  // defense fields pulled from a given form (or document). Returns the
  // same object so callers can chain. Safe when the form is null or
  // missing some of the fields — defaults are sensible.
  function augmentPayload(payload, form) {
    if (!payload || typeof payload !== 'object') return payload;
    var root = form || document;
    var hp = root.querySelector('input[name="contact_website"]');
    var ts = root.querySelector('input[name="_ts"]');
    payload.contact_website = hp ? String(hp.value || '') : '';
    payload._ts = ts ? Number(ts.value) || 0 : 0;
    // Turnstile injects <input name="cf-turnstile-response"> inside the
    // widget container with the verification token. Prefer the per-form
    // value; fall back to the last-seen global token if the form has
    // no widget (chat-widget capture forms, etc.).
    var widgetField = root.querySelector('input[name="cf-turnstile-response"]');
    var widgetVal = widgetField ? String(widgetField.value || '') : '';
    payload.cfTurnstileResponse = widgetVal || lastToken || '';
    return payload;
  }

  // Manual stamp for the rare case a form's _ts needs anchoring later
  // than DOM-ready (e.g. sprinkler-builder, where Step 1 click counts
  // as "form open" even though the input has been in the DOM since
  // page load). Call as: window.pjlAntiBot.anchorTs(formEl).
  function anchorTs(form) {
    if (!form) return;
    var input = form.querySelector('input[name="_ts"]');
    if (!input) return;
    input.value = String(Date.now());
  }

  function basePayload(form) {
    var payload = {
      pageUrl: typeof location !== 'undefined' ? location.href : '',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : ''
    };
    return augmentPayload(payload, form);
  }

  window.pjlAntiBot = {
    augmentPayload: augmentPayload,
    anchorTs: anchorTs,
    basePayload: basePayload,
    getToken: function () { return lastToken; },
    siteKey: currentSitekey
  };
})();
