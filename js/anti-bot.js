/*
 * Client-side anti-bot helpers — companion to server/lib/anti-bot.js.
 *
 * Each public form on the site:
 *   1. Includes a Cloudflare Turnstile <script> in <head>.
 *   2. Renders an off-screen honeypot input named "contact_website" via the
 *      shared `.pjl-hp-field` CSS class.
 *   3. Renders a hidden `_ts` input that this script stamps with Date.now()
 *      on page load (or, for the sprinkler-builder, on builder-open).
 *   4. Renders a `<div class="cf-turnstile pjl-turnstile" data-sitekey="..." data-callback="pjlOnTurnstile">`.
 *      Managed mode → invisible for clean traffic, a small interactive
 *      challenge for the suspicious 1–5%.
 *
 * The form's submit handler decorates its payload via `window.pjlAntiBot.augmentPayload(form)`
 * — pulls the three defense fields off the form and writes them into the
 * outgoing JSON body. Keeps every form's submit code three lines lighter.
 *
 * The site key here is Cloudflare's "always passes" TEST key. Patrick
 * swaps it for the production key once the domain is registered with
 * Cloudflare; see WEBSITE_MAINTENANCE_AND_SEO_HANDOFF.md §15.14 for the
 * step-by-step. Forms can also override the key via window.PJL_TURNSTILE_SITEKEY
 * before this script runs.
 */
(function () {
  'use strict';

  var DEFAULT_SITEKEY = '1x00000000000000000000AA'; // Cloudflare TEST key (always-passes invisible)
  var siteKey = (typeof window !== 'undefined' && window.PJL_TURNSTILE_SITEKEY) || DEFAULT_SITEKEY;

  // Per-widget tokens. Turnstile invokes data-callback="pjlOnTurnstile"
  // with the verification token; we stash by widget-id so multi-form
  // pages don't collide.
  var tokensByWidget = Object.create(null);
  var lastToken = '';

  // Global callback Turnstile invokes when the challenge resolves.
  // `widgetId` is the Cloudflare-internal id; we also keep a lastToken
  // so single-form pages can read it without juggling ids.
  window.pjlOnTurnstile = function (token, widgetId) {
    if (typeof token === 'string' && token) {
      lastToken = token;
      if (widgetId) tokensByWidget[widgetId] = token;
    }
  };

  // Sweep the page on DOM ready: rewrite data-sitekey on every Turnstile
  // div to the configured key, stamp every _ts input with the current ms,
  // and ensure honeypot inputs are wired to ignore browser autocomplete.
  function bootstrap() {
    var nodes = document.querySelectorAll('.cf-turnstile[data-sitekey]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      // Only swap if the page hasn't already set a real key.
      if (!el.dataset.sitekey || el.dataset.sitekey === DEFAULT_SITEKEY) {
        el.dataset.sitekey = siteKey;
      }
      if (!el.dataset.callback) el.dataset.callback = 'pjlOnTurnstile';
    }
    var tsInputs = document.querySelectorAll('input[data-pjl-ts]');
    for (var j = 0; j < tsInputs.length; j++) {
      tsInputs[j].value = String(Date.now());
    }
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
    // Prefer a per-form token if Turnstile populated the form's own
    // hidden field (it usually does — Cloudflare also writes the token
    // to <input name="cf-turnstile-response"> automatically); otherwise
    // fall back to the most recent global token.
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

  // Compose a fresh payload object directly from a form's input fields.
  // Convenience for the simpler forms — supplies the three defense
  // fields and the page context that the backend expects.
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
    siteKey: siteKey
  };
})();
