// Shared contact-affordance primitive (feature-clickable-contact-actions v2).
// Drop-in, mirrors the voice-input.js convention: any element opts in by
// carrying a data attribute. Two channels:
//
//   data-map-address="<full address>"  → "Open in…" maps chooser
//                                         (Apple Maps / Google Maps / Cancel)
//   data-tel="<phone number>"          → device dialer via a tel: link
//
// One document-level delegated listener handles every tagged element, so it
// survives the client-side re-renders every CRM list does. A light decorate
// pass (role/tabindex) runs on load and on DOM mutation so dynamically
// rendered rows stay keyboard-accessible; the click/keydown path itself is
// fully delegated and needs no per-element wiring.
//
// The listener runs in the CAPTURE phase. That's deliberate: the brief's
// card-conflict rule ("an address inside a tap-navigable card opens maps,
// not the card") needs stopPropagation to actually short-circuit ancestor
// handlers — and several cards attach real click listeners (bulk-select
// rows, in-page select mode) rather than relying on a native <a>. A
// bubble-phase document listener runs AFTER those ancestor listeners have
// already fired, so it can't stop them. Capturing at document runs FIRST,
// so preventDefault + stopPropagation cancel both native anchor navigation
// and any ancestor click handler before they act.
//
// Optional address attributes (used by the Today hub to preserve its
// turn-by-turn navigate capability after its navigate button was folded
// onto this primitive):
//   data-map-mode="directions"           → build driving-directions URLs
//                                           instead of the default "search /
//                                           show this place" URLs
//   data-map-dest="<lat,lng | precise>"  → overrides the string handed to the
//                                           maps app while data-map-address
//                                           stays the human-readable label
//
// tel: dials from the line in the device placing the call — it does NOT set
// the outbound caller ID. Uniform business caller-ID regardless of device is
// a separate Twilio Voice feature (brief §6), intentionally out of scope.
// This ships the tel: version; the data-tel hook is forward-compatible.

(function setupCrmContact() {
  // Idempotent init guard — double-loading the script (a page pulling it in
  // twice, or a bf-cache restore) must not double-bind the document listener
  // or we'd fire two choosers per tap.
  if (window.__pjlCrmContactInit) return;
  window.__pjlCrmContactInit = true;

  var SELECTOR = "[data-map-address], [data-tel]";

  // ---- Phone normalization (brief §3B) ----------------------------------
  // Returns a normalized E.164-ish string safe for a tel: URL, or null when
  // the number is too short to be a real dialable number (never dial garbage).
  function normalizePhone(raw) {
    if (raw == null) return null;
    var str = String(raw);
    // Extensions (x123 / ext. 4) are out of scope this pass — strip the
    // extension and dial the base number. Cut at the first ext marker.
    var extMatch = str.match(/(?:\s|^)(?:x|ext\.?|extension)\s*\d+\s*$/i);
    if (extMatch) str = str.slice(0, extMatch.index);
    var hadPlus = str.trim().charAt(0) === "+";
    var digits = str.replace(/\D/g, "");
    if (hadPlus) {
      // Already international — trust it as long as it has enough digits.
      if (digits.length < 10) return null;
      return "+" + digits;
    }
    if (digits.length === 10) return "+1" + digits;           // NANP, no CC
    if (digits.length === 11 && digits.charAt(0) === "1") return "+" + digits;
    if (digits.length < 10) return null;                       // too short
    // 12+ digits, no leading + — assume a country code is already baked in.
    return "+" + digits;
  }

  // ---- Maps URL construction (brief §3A) --------------------------------
  // Documented Maps URL schemes. Default = "search / show this place";
  // directions variant preserves the Today hub's turn-by-turn navigate.
  function mapsUrls(el) {
    var address = el.getAttribute("data-map-address") || "";
    var dest = el.getAttribute("data-map-dest") || address;
    var directions = el.getAttribute("data-map-mode") === "directions";
    var qDest = encodeURIComponent(dest);
    if (directions) {
      return {
        apple: "https://maps.apple.com/?daddr=" + qDest + "&dirflg=d",
        google: "https://www.google.com/maps/dir/?api=1&destination=" + qDest + "&travelmode=driving"
      };
    }
    return {
      apple: "https://maps.apple.com/?q=" + qDest,
      google: "https://www.google.com/maps/search/?api=1&query=" + qDest
    };
  }

  // ---- Launch helper ----------------------------------------------------
  // Hand off to the OS/app via a transient <a> clicked programmatically.
  // Maps opens target=_blank rel=noopener so the standalone PWA stays in
  // place; tel:/sms open in the same tab (the OS intercepts, the page never
  // actually navigates). The anchor is appended to the DOM before the click —
  // some engines (notably iOS Safari) ignore a fully detached anchor's
  // synthetic click — then removed. A thrown error falls back to
  // location.href. (If on-device testing shows the anchor still doesn't hand
  // off inside the Add-to-Home-Screen standalone app, switch maps to the
  // location.href path too — verify on-device.)
  function launch(url, sameTab) {
    try {
      var a = document.createElement("a");
      a.href = url;
      if (!sameTab) {
        a.target = "_blank";
        a.rel = "noopener";
      }
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (err) {
      try { window.location.href = url; } catch (e) {}
    }
  }

  // ---- Chooser (bottom sheet mobile / centered popover desktop) ---------
  var activeChooser = null;

  function closeChooser() {
    if (!activeChooser) return;
    var node = activeChooser.node;
    var opener = activeChooser.opener;
    document.removeEventListener("keydown", activeChooser.onKeydown, true);
    if (node && node.parentNode) node.parentNode.removeChild(node);
    activeChooser = null;
    // Return focus to the address element that opened the sheet.
    if (opener && typeof opener.focus === "function") {
      try { opener.focus(); } catch (e) {}
    }
  }

  function openChooser(el) {
    if (activeChooser) closeChooser();

    var urls = mapsUrls(el);
    var label = (el.getAttribute("data-map-address") || "").trim();
    var directions = el.getAttribute("data-map-mode") === "directions";

    var backdrop = document.createElement("div");
    backdrop.className = "pjl-contact-chooser";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", (directions ? "Directions to " : "Open in maps: ") + (label || "address"));

    var sheet = document.createElement("div");
    sheet.className = "pjl-contact-sheet";

    var title = document.createElement("p");
    title.className = "pjl-contact-sheet-title";
    title.textContent = directions ? "Directions to" : "Open in Maps";
    sheet.appendChild(title);

    if (label) {
      var addr = document.createElement("p");
      addr.className = "pjl-contact-sheet-address";
      addr.textContent = label;
      sheet.appendChild(addr);
    }

    var actions = document.createElement("div");
    actions.className = "pjl-contact-sheet-actions";

    var appleBtn = document.createElement("button");
    appleBtn.type = "button";
    appleBtn.className = "pjl-contact-btn pjl-contact-btn-apple";
    appleBtn.textContent = "Apple Maps";

    var googleBtn = document.createElement("button");
    googleBtn.type = "button";
    googleBtn.className = "pjl-contact-btn pjl-contact-btn-google";
    googleBtn.textContent = "Google Maps";

    var cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "pjl-contact-btn pjl-contact-btn-cancel";
    cancelBtn.textContent = "Cancel";

    // Apple first — primary device is an iPhone — but both always shown,
    // never hidden by platform. The prompt is the point.
    actions.appendChild(appleBtn);
    actions.appendChild(googleBtn);
    actions.appendChild(cancelBtn);
    sheet.appendChild(actions);
    backdrop.appendChild(sheet);

    appleBtn.addEventListener("click", function () { launch(urls.apple); closeChooser(); });
    googleBtn.addEventListener("click", function () { launch(urls.google); closeChooser(); });
    cancelBtn.addEventListener("click", function () { closeChooser(); });

    // Tap-outside / backdrop tap dismissal.
    backdrop.addEventListener("click", function (event) {
      if (event.target === backdrop) closeChooser();
    });

    // Esc closes; Tab is trapped within the sheet. Captured at document so it
    // works wherever focus lands.
    var focusables = [appleBtn, googleBtn, cancelBtn];
    function onKeydown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeChooser();
        return;
      }
      if (event.key === "Tab") {
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKeydown, true);

    document.body.appendChild(backdrop);
    activeChooser = { node: backdrop, opener: el, onKeydown: onKeydown };

    // Move focus into the sheet (first action) on open. rAF so the element is
    // laid out before we focus it (iOS Safari focus-on-insert quirk).
    requestAnimationFrame(function () { try { appleBtn.focus(); } catch (e) {} });
  }

  // ---- Activation (shared by click + keyboard) --------------------------
  // Validity is checked BEFORE preventDefault: if a value was tagged but is
  // blank/invalid, we do NOT hijack the event, so a parent card still
  // navigates normally (no dead taps). We only cancel the event when we're
  // actually going to act.
  function handleActivate(el, event) {
    if (el.hasAttribute("data-map-address")) {
      var addr = (el.getAttribute("data-map-address") || "").trim();
      if (!addr) return;                     // blank/partial → let card act
      event.preventDefault();
      event.stopPropagation();
      openChooser(el);
      return;
    }
    if (el.hasAttribute("data-tel")) {
      var tel = normalizePhone(el.getAttribute("data-tel"));
      if (!tel) return;                      // invalid/short → let card act
      event.preventDefault();
      event.stopPropagation();
      // No custom confirm — iOS shows its own native "Call <number>?" prompt.
      launch("tel:" + tel, true);
      return;
    }
  }

  document.addEventListener("click", function (event) {
    var t = event.target;
    var el = t && t.closest ? t.closest(SELECTOR) : null;
    if (!el) return;
    handleActivate(el, event);
  }, true); // capture — see header comment

  // Enter / Space activation for keyboard users, only when focus is directly
  // on the tagged element (so we never swallow keys meant for a nested
  // control). Space is prevented from scrolling.
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    var t = event.target;
    var el = t && t.closest ? t.closest(SELECTOR) : null;
    if (!el || t !== el) return;
    handleActivate(el, event);
  }, true);

  // ---- Decoration: role/tabindex for keyboard access --------------------
  // Lightest approach that keeps dynamically-rendered rows accessible: mark
  // each tagged element as a button and make it focusable — but only if it
  // isn't already a natively-interactive element (an <a>/<button> that opted
  // in directly), so we never clobber existing semantics. We only decorate
  // elements whose value is actually actionable, so invalid values get no
  // affordance (and, via the CSS attribute selectors, no pointer/glyph).
  function isActionable(el) {
    if (el.hasAttribute("data-map-address")) {
      return !!(el.getAttribute("data-map-address") || "").trim();
    }
    if (el.hasAttribute("data-tel")) {
      return !!normalizePhone(el.getAttribute("data-tel"));
    }
    return false;
  }

  function decorate(el) {
    if (!el || el.nodeType !== 1) return;
    var hasMap = el.hasAttribute("data-map-address");
    var hasTel = el.hasAttribute("data-tel");
    if (!hasMap && !hasTel) return;
    if (!isActionable(el)) {
      // A tagged-but-invalid value (blank address / sub-10-digit phone) must
      // render NO tappable affordance (brief §3B). Strip the dead hook so the
      // CSS glyph/cursor drop away, nothing intercepts the click, and a parent
      // card behaves normally.
      if (hasMap && !(el.getAttribute("data-map-address") || "").trim()) el.removeAttribute("data-map-address");
      if (hasTel && !normalizePhone(el.getAttribute("data-tel"))) el.removeAttribute("data-tel");
      return;
    }
    if (el.dataset.contactWired === "1") return;
    el.dataset.contactWired = "1";
    var tag = el.tagName;
    if (tag !== "A" && tag !== "BUTTON") {
      if (!el.hasAttribute("role")) el.setAttribute("role", "button");
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    }
  }

  function decorateAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(SELECTOR).forEach(decorate);
  }

  function init() { decorateAll(document); }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Watch for tagged elements that appear or change. Two cases:
  //   • rows added by a list re-render (childList) — new nodes carrying the
  //     attribute in their markup;
  //   • an existing static element that a page tags later via setAttribute
  //     (e.g. #propertyAddress, #techAddress) — caught by attribute mutations.
  // Decoration only — the click/keydown path is already delegated.
  function startObserver() {
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === "attributes") {
          decorate(m.target);
          continue;
        }
        var added = m.addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches(SELECTOR)) decorate(node);
          if (node.querySelectorAll) node.querySelectorAll(SELECTOR).forEach(decorate);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-map-address", "data-tel"]
    });
  }

  if (document.body) {
    startObserver();
  } else {
    document.addEventListener("DOMContentLoaded", startObserver);
  }
})();
