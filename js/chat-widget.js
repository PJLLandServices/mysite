/* =============================================================
   PJL CHAT WIDGET — site-wide AI sprinkler diagnostic chat
   Loads on every page. Triggers via [data-pjl-chat] buttons or
   window.pjlChat.open(). State persists across page navigation
   in localStorage; photo bytes persist in IndexedDB.

   Public API:
     window.pjlChat.open()            — show panel
     window.pjlChat.close()           — hide panel + launcher (clears state)
     window.pjlChat.minimize()        — hide panel, show launcher
     window.pjlChat.isActive()        — true if conversation has messages

   Buttons can opt in via:
     <button data-pjl-chat>Chat with Patrick</button>
     <a href="diagnose.html" data-pjl-chat>...</a>     (preventDefault auto)
   ============================================================= */
(function () {
  "use strict";
  if (window.pjlChat) return; // already initialized on this page

  // -------- Configuration --------
  const WORKER_URL = "https://jolly-meadow-6c29.patrick-812.workers.dev/";
  const LEAD_ENDPOINT = "https://pjl-land-services-onrender-com.onrender.com/api/quotes";
  const TRANSCRIPT_ENDPOINT = "https://pjl-land-services-onrender-com.onrender.com/api/chat-transcripts";
  const FORM_TRIGGER = "[SHOW_BOOKING_FORM]";
  const CAPTURE_TRIGGER = "[SHOW_CONTACT_CAPTURE]";
  // [QUOTE_JSON:{...}] travels alongside [SHOW_BOOKING_FORM] for repair quotes.
  // Extracted via a brace-counting parser (see findQuoteToken) so multi-line
  // JSON — which Claude often emits when the items array is long — strips
  // cleanly. A naive regex like /\{[^\n]*?\}/ matched only the first half
  // of a wrapped token, leaking the second half (",scope":"...","intake_
  // guarantee":true}]) into the customer-facing chat bubble.
  const STORAGE_KEY = "pjl_chat_state_v1";
  // Google Maps key (HTTP-referrer restricted on Google Cloud — same key the
  // public site already exposes for coverage-checker autocomplete).
  const GOOGLE_MAPS_KEY = "AIzaSyBrORBeXbpNTJvoi2PDhDDs6Iy-BGSU30M";
  const PHOTO_DB_NAME = "pjl_chat_photos_v1";
  const PHOTO_STORE = "photos";
  const MAX_PHOTOS = 5;
  const MAX_PHOTO_DIMENSION = 1280;
  const PHOTO_JPEG_QUALITY = 0.82;

  // -------- State --------
  // Persisted to localStorage on every change. Photo bytes are kept separately
  // (in memory + IndexedDB) so localStorage doesn't bloat past its 5MB cap.
  let state = {
    messages: [],         // [{ role, content }] — content is a string OR multimodal array
    photoIds: [],         // photo ids that have been sent with previous messages
    pendingPhotoIds: [],  // photos staged in the rail, sent on next user message
    bookingShown: false,
    bookingComplete: false,
    captureShown: false,    // [SHOW_CONTACT_CAPTURE] form rendered (self-fix success path)
    captureComplete: false, // contact-capture form submitted
    pendingQuote: null,     // most recent [QUOTE_JSON] payload from the AI; sent with booking form on submit
    panelOpen: false,
    awaiting: false,      // reset to false on rehydrate (in-flight requests don't survive nav)
    chatSessionId: null   // generated lazily; identifies the chat for transcript upserts
  };

  function genSessionId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 12);
  }

  // Photos in memory: { id => { dataUrl, base64, mediaType, bytes } }
  // Hydrated from IndexedDB on widget init.
  const photoCache = new Map();

  // -------- IndexedDB helpers (for photo bytes) --------
  function openPhotoDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(PHOTO_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          db.createObjectStore(PHOTO_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbPutPhoto(photo) {
    try {
      const db = await openPhotoDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.objectStore(PHOTO_STORE).put(photo);
      });
      db.close();
    } catch (e) { console.warn("[pjl-chat] photo persist failed:", e); }
  }
  async function dbDeletePhoto(id) {
    try {
      const db = await openPhotoDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.objectStore(PHOTO_STORE).delete(id);
      });
      db.close();
    } catch (e) {}
  }
  async function dbClearPhotos() {
    try {
      const db = await openPhotoDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readwrite");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.objectStore(PHOTO_STORE).clear();
      });
      db.close();
    } catch (e) {}
  }
  async function dbAllPhotos() {
    try {
      const db = await openPhotoDB();
      const result = await new Promise((resolve, reject) => {
        const tx = db.transaction(PHOTO_STORE, "readonly");
        const req = tx.objectStore(PHOTO_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return result;
    } catch (e) { return []; }
  }

  // -------- State persistence --------
  function saveState() {
    try {
      const persisted = {
        messages: state.messages,
        photoIds: state.photoIds,
        pendingPhotoIds: state.pendingPhotoIds,
        bookingShown: state.bookingShown,
        bookingComplete: state.bookingComplete,
        captureShown: state.captureShown,
        captureComplete: state.captureComplete,
        pendingQuote: state.pendingQuote,
        panelOpen: state.panelOpen,
        chatSessionId: state.chatSessionId
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch (e) { console.warn("[pjl-chat] state save failed:", e); }
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      Object.assign(state, parsed, { awaiting: false });
      return true;
    } catch (e) { return false; }
  }
  async function clearAllState() {
    state = {
      messages: [], photoIds: [], pendingPhotoIds: [],
      bookingShown: false, bookingComplete: false,
      captureShown: false, captureComplete: false,
      pendingQuote: null,
      panelOpen: false, awaiting: false,
      chatSessionId: null
    };
    photoCache.clear();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    await dbClearPhotos();
  }

  // -------- DOM building --------
  let panelEl, launcherEl, messagesEl, composerInput, sendBtn, attachBtn, photoInput, photoRailEl, tyOverlay;

  function buildLauncher() {
    const btn = document.createElement("button");
    btn.className = "pjl-chat-launcher";
    btn.type = "button";
    btn.setAttribute("aria-label", "Chat with Patrick");
    btn.innerHTML = `
      <span class="pjl-chat-launcher-icon">P</span>
      <span class="pjl-chat-launcher-label">Chat with Patrick</span>
      <span class="pjl-chat-launcher-dot"></span>
    `;
    btn.addEventListener("click", () => api.open());
    return btn;
  }

  function buildPanel() {
    const panel = document.createElement("div");
    panel.className = "pjl-chat-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Chat with Patrick from PJL Land Services");
    panel.innerHTML = `
      <div class="pjl-chat-topbar"></div>
      <header class="pjl-chat-header">
        <div class="pjl-chat-header-brand">
          <div class="pjl-chat-avatar">P</div>
          <div class="pjl-chat-brand-text">
            <div class="pjl-chat-brand">PJL Land Services</div>
            <div class="pjl-chat-brand-status"><span class="pjl-chat-status-dot"></span> Online — typically replies instantly</div>
          </div>
        </div>
        <div class="pjl-chat-header-actions">
          <button class="pjl-chat-icon-btn" data-action="minimize" title="Minimize" aria-label="Minimize chat">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </button>
          <button class="pjl-chat-icon-btn" data-action="end" title="End chat" aria-label="End chat">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </header>
      <div class="pjl-chat-messages" data-pjl-messages></div>
      <div class="pjl-chat-photo-rail" data-pjl-photo-rail></div>
      <div class="pjl-chat-composer">
        <div class="pjl-chat-composer-inner">
          <button class="pjl-chat-attach-btn" data-action="attach" type="button" aria-label="Attach a photo">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57a4 4 0 015.66 5.66l-8.58 8.57a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
          </button>
          <input type="file" data-pjl-photo-input accept="image/*" multiple style="display:none">
          <textarea data-pjl-input class="pjl-chat-textarea" rows="1" placeholder="What's going on with your system?"></textarea>
          <button class="pjl-chat-send-btn" data-action="send" type="button" aria-label="Send message">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          </button>
        </div>
        <div class="pjl-chat-composer-meta">
          <span>Free • No obligation</span>
          <button data-action="restart" type="button">Start Over</button>
        </div>
      </div>
      <div class="pjl-chat-ty" data-pjl-ty>
        <div class="pjl-chat-ty-card">
          <div class="pjl-chat-ty-icon">✓</div>
          <h2 data-pjl-ty-heading>You're now a PJL customer.</h2>
          <p data-pjl-ty-body>We'll reach out within 24 hours to confirm your visit. Check your email for the booking confirmation.</p>
          <div class="pjl-chat-ty-portal" data-pjl-ty-portal hidden>
            <strong>Your customer portal:</strong>
            <a href="" target="_blank" rel="noopener" data-pjl-ty-portal-link></a>
            <p class="pjl-chat-ty-portal-note">Bookmark this — you can check status, message Patrick, and accept future quotes from here.</p>
          </div>
          <button data-action="restart-ty" type="button">Start a New Diagnosis</button>
        </div>
      </div>
    `;
    return panel;
  }

  function attachPanelHandlers() {
    panelEl.addEventListener("click", (e) => {
      const target = e.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      if (action === "minimize") api.minimize();
      else if (action === "end") api.close();
      else if (action === "attach") photoInput.click();
      else if (action === "send") sendCurrentMessage();
      else if (action === "restart" || action === "restart-ty") api.restart();
    });

    composerInput.addEventListener("input", autoResize);
    composerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendCurrentMessage();
      }
    });

    photoInput.addEventListener("change", (e) => {
      handlePhotoFiles(e.target.files);
      e.target.value = "";
    });
  }

  function autoResize() {
    composerInput.style.height = "auto";
    composerInput.style.height = Math.min(composerInput.scrollHeight, 120) + "px";
  }

  // Mobile gets a shorter placeholder so it never wraps in the cramped composer.
  function mobilePlaceholder() {
    return window.matchMedia("(max-width: 767px)").matches
      ? "Describe your issue..."
      : "What's going on with your system?";
  }

  // -------- Rendering --------
  function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  // Allow only safe link targets: relative paths to other pages (e.g. "sprinkler-repair.html"
  // or "sprinkler-service-richmond-hill.html#section"), tel:, mailto:. Anything else falls
  // through and renders as plain text — we never want the AI injecting external URLs.
  function safeHref(rawUrl) {
    const url = rawUrl.trim();
    if (/^(tel:|mailto:)/i.test(url)) return url;
    // Relative URLs only: must not start with /, //, or a scheme.
    if (/^[a-z][\w+.-]*:/i.test(url)) return null;
    if (url.startsWith("//") || url.startsWith("/")) return null;
    // Reasonable filename pattern: letters, digits, dashes, dots, slashes, anchors, query.
    if (!/^[\w./?=&%#-]+$/i.test(url)) return null;
    return url;
  }
  function formatBubbleText(text) {
    let out = escapeHtml(text);
    // [text](url) → safe anchor (relative URLs only)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
      const href = safeHref(url);
      if (!href) return label; // unsafe URL → render as plain text
      return `<a href="${href}" class="pjl-chat-link">${label}</a>`;
    });
    // **bold** → strong
    out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    return out;
  }

  function renderMessages() {
    messagesEl.innerHTML = "";
    state.messages.forEach((msg) => renderMessageRow(msg));
    scrollToBottom();
  }

  function renderMessageRow(msg) {
    const row = document.createElement("div");
    row.className = "pjl-chat-msg-row " + (msg.role === "user" ? "user" : "pjl");

    if (msg.role === "user") {
      // User messages may have inline photo attachments (multimodal content).
      const photos = [];
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        msg.content.forEach((b) => {
          if (b.type === "image" && b._photoId) {
            const photo = photoCache.get(b._photoId);
            if (photo) photos.push(photo.dataUrl);
          } else if (b.type === "text") {
            text = b.text;
          }
        });
      }
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:78%;";
      if (photos.length) {
        const grid = document.createElement("div");
        grid.className = "pjl-chat-photo-attachments";
        photos.forEach((u) => {
          const img = document.createElement("img");
          img.src = u;
          grid.appendChild(img);
        });
        wrap.appendChild(grid);
      }
      if (text) {
        const bubble = document.createElement("div");
        bubble.className = "pjl-chat-msg-bubble";
        bubble.textContent = text;
        wrap.appendChild(bubble);
      }
      row.appendChild(wrap);
    } else {
      const av = document.createElement("div");
      av.className = "pjl-chat-msg-avatar";
      av.textContent = "P";
      row.appendChild(av);
      const bubble = document.createElement("div");
      bubble.className = "pjl-chat-msg-bubble";
      const text = stripTokens(typeof msg.content === "string" ? msg.content : "");
      bubble.innerHTML = formatBubbleText(text);
      row.appendChild(bubble);
    }
    messagesEl.appendChild(row);
  }

  // Strip every system token (FORM_TRIGGER, CAPTURE_TRIGGER, QUOTE_JSON) from
  // a raw AI reply so the customer-facing render never leaks the wire format.
  // Used by message rendering and transcript building.
  function stripTokens(raw) {
    let text = String(raw || "");
    // Strip QUOTE_JSON via the brace-aware finder — handles multi-line JSON
    // emission (Claude wraps long items arrays across lines, and a naive
    // regex would only catch the first half).
    const found = findQuoteToken(text);
    if (found) text = text.slice(0, found.start) + text.slice(found.end);
    return text
      .replace(FORM_TRIGGER, "")
      .replace(CAPTURE_TRIGGER, "")
      .trim();
  }

  // Locate the [QUOTE_JSON:{...}] token in a raw AI reply by walking the
  // JSON body with a brace counter. Tolerates whitespace and newlines
  // anywhere inside the JSON, ignores braces that appear inside string
  // literals, and bails on a malformed payload without blocking the chat.
  // Returns { payload, start, end } where [start, end) covers the entire
  // [QUOTE_JSON:...] token (so callers can splice it out cleanly), or null.
  function findQuoteToken(raw) {
    const text = String(raw || "");
    const tag = "[QUOTE_JSON:";
    const startIdx = text.indexOf(tag);
    if (startIdx === -1) return null;

    let i = startIdx + tag.length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== "{") return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    let braceEnd = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escape) { escape = false; continue; }
      if (c === "\\" && inString) { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { braceEnd = j; break; }
      }
    }
    if (braceEnd === -1) return null;

    let k = braceEnd + 1;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (text[k] !== "]") return null;

    const jsonStr = text.slice(i, braceEnd + 1);
    try {
      const obj = JSON.parse(jsonStr);
      if (obj && Array.isArray(obj.items) && obj.items.length) {
        return { payload: obj, start: startIdx, end: k + 1 };
      }
    } catch (e) {
      console.warn("[pjl-chat] QUOTE_JSON parse failed:", e?.message);
    }
    return null;
  }

  // Convenience for the send-flow: returns just the parsed payload.
  function extractQuotePayload(raw) {
    const found = findQuoteToken(raw);
    return found ? found.payload : null;
  }

  // -------- Address autocomplete (Google Places) --------
  // Mirrors the form-fill autocomplete in coverage-checker.js so chat-form
  // addresses arrive cleanly formatted (matching the rest of the public site).
  // Maps loads once per page on first form render — most public pages already
  // load Places via coverage-checker, so this typically just reuses the
  // existing global. Pages without a Maps script tag get one injected with
  // a unique callback name to avoid colliding with initCoverageCheck.
  let mapsPlacesPromise = null;

  function ensureGoogleMapsPlaces() {
    if (mapsPlacesPromise) return mapsPlacesPromise;
    if (window.google && window.google.maps && window.google.maps.places) {
      mapsPlacesPromise = Promise.resolve();
      return mapsPlacesPromise;
    }
    mapsPlacesPromise = new Promise((resolve, reject) => {
      // If a Maps script tag already exists (e.g. coverage-checker pages),
      // poll until Places is available rather than loading a second copy.
      const existing = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
      if (existing) {
        const start = Date.now();
        const tick = () => {
          if (window.google && window.google.maps && window.google.maps.places) return resolve();
          if (Date.now() - start > 8000) return reject(new Error("Maps load timeout"));
          setTimeout(tick, 120);
        };
        tick();
        return;
      }
      const cbName = "__pjlChatMapsReady_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      window[cbName] = () => { try { delete window[cbName]; } catch (e) {} resolve(); };
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_KEY}&libraries=places&callback=${cbName}&loading=async`;
      script.async = true;
      script.defer = true;
      script.onerror = () => reject(new Error("Maps load failed"));
      document.head.appendChild(script);
    });
    return mapsPlacesPromise;
  }

  // Bind Google Places Autocomplete to a chat-form address input. Same
  // bias and restrictions coverage-checker uses (Canada-only, Southern
  // Ontario bounds with strictBounds=false so out-of-region addresses
  // still resolve), and the same place_changed handler that writes back
  // the formatted_address. Failure modes (key issue, offline, blocked)
  // degrade silently — the input keeps working as a plain text field.
  function bindAddressAutocomplete(inputEl) {
    if (!inputEl) return;
    ensureGoogleMapsPlaces().then(() => {
      const places = window.google && window.google.maps && window.google.maps.places;
      if (!places || !places.Autocomplete) return;
      const sw = new google.maps.LatLng(43.0, -80.7);
      const ne = new google.maps.LatLng(44.7, -78.5);
      const ac = new places.Autocomplete(inputEl, {
        componentRestrictions: { country: "ca" },
        fields: ["formatted_address"],
        types: ["address"],
        bounds: new google.maps.LatLngBounds(sw, ne),
        strictBounds: false
      });
      ac.addListener("place_changed", () => {
        const p = ac.getPlace();
        if (p && p.formatted_address) inputEl.value = p.formatted_address;
      });
      // Override the browser's autofill so it doesn't hide the dropdown.
      inputEl.setAttribute("autocomplete", "new-password");
    }).catch((err) => {
      console.warn("[pjl-chat] address autocomplete unavailable:", err?.message || err);
    });
  }

  function appendUserMessageDOM(text, photoUrls) {
    const row = document.createElement("div");
    row.className = "pjl-chat-msg-row user";
    if (photoUrls && photoUrls.length) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:78%;";
      const grid = document.createElement("div");
      grid.className = "pjl-chat-photo-attachments";
      photoUrls.forEach((u) => {
        const img = document.createElement("img");
        img.src = u;
        grid.appendChild(img);
      });
      wrap.appendChild(grid);
      if (text) {
        const bubble = document.createElement("div");
        bubble.className = "pjl-chat-msg-bubble";
        bubble.textContent = text;
        wrap.appendChild(bubble);
      }
      row.appendChild(wrap);
    } else {
      const bubble = document.createElement("div");
      bubble.className = "pjl-chat-msg-bubble";
      bubble.textContent = text;
      row.appendChild(bubble);
    }
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  function appendPJLMessageDOM(text) {
    const row = document.createElement("div");
    row.className = "pjl-chat-msg-row pjl";
    const av = document.createElement("div");
    av.className = "pjl-chat-msg-avatar";
    av.textContent = "P";
    row.appendChild(av);
    const bubble = document.createElement("div");
    bubble.className = "pjl-chat-msg-bubble";
    bubble.innerHTML = formatBubbleText(text);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();
  }

  function showTyping() {
    if (messagesEl.querySelector("[data-typing]")) return;
    const row = document.createElement("div");
    row.className = "pjl-chat-typing-row";
    row.setAttribute("data-typing", "true");
    const av = document.createElement("div");
    av.className = "pjl-chat-msg-avatar";
    av.textContent = "P";
    row.appendChild(av);
    const bubble = document.createElement("div");
    bubble.className = "pjl-chat-typing-bubble";
    bubble.innerHTML = '<div class="pjl-chat-typing-dot"></div><div class="pjl-chat-typing-dot"></div><div class="pjl-chat-typing-dot"></div>';
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();
  }
  function hideTyping() {
    const t = messagesEl.querySelector("[data-typing]");
    if (t) t.remove();
  }
  function scrollToBottom() {
    setTimeout(() => { messagesEl.scrollTop = messagesEl.scrollHeight; }, 20);
  }

  function showToast(msg) {
    const existing = panelEl.querySelector(".pjl-chat-toast");
    if (existing) existing.remove();
    const t = document.createElement("div");
    t.className = "pjl-chat-toast";
    t.textContent = msg;
    panelEl.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }

  // -------- Photos --------
  function makePhotoId() {
    return "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }
  async function resizeImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Couldn't decode that image."));
        img.onload = () => {
          const longest = Math.max(img.width, img.height);
          const scale = longest > MAX_PHOTO_DIMENSION ? MAX_PHOTO_DIMENSION / longest : 1;
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL("image/jpeg", PHOTO_JPEG_QUALITY);
          const base64 = dataUrl.split(",", 2)[1] || "";
          const bytes = Math.floor(base64.length * 3 / 4);
          resolve({ id: makePhotoId(), dataUrl, base64, mediaType: "image/jpeg", bytes });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderPhotoRail() {
    photoRailEl.innerHTML = "";
    state.pendingPhotoIds.forEach((id, idx) => {
      const photo = photoCache.get(id);
      if (!photo) return;
      const chip = document.createElement("div");
      chip.className = "pjl-chat-photo-chip";
      const img = document.createElement("img");
      img.src = photo.dataUrl;
      chip.appendChild(img);
      const x = document.createElement("button");
      x.type = "button";
      x.className = "pjl-chat-photo-chip-x";
      x.title = "Remove";
      x.textContent = "×";
      x.addEventListener("click", () => {
        state.pendingPhotoIds.splice(idx, 1);
        photoCache.delete(id);
        dbDeletePhoto(id);
        saveState();
        renderPhotoRail();
      });
      chip.appendChild(x);
      photoRailEl.appendChild(chip);
    });
  }

  async function handlePhotoFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const usedSlots = state.pendingPhotoIds.length + state.photoIds.length;
    const slotsLeft = MAX_PHOTOS - usedSlots;
    if (slotsLeft <= 0) {
      showToast(`You can only attach ${MAX_PHOTOS} photos per booking.`);
      return;
    }
    const toProcess = files.slice(0, slotsLeft);
    if (files.length > slotsLeft) {
      showToast(`Only added the first ${slotsLeft} — limit is ${MAX_PHOTOS} photos.`);
    }
    for (const file of toProcess) {
      if (!file.type.startsWith("image/")) {
        showToast(`Skipped "${file.name}" — only images are supported.`);
        continue;
      }
      try {
        const photo = await resizeImageFile(file);
        photoCache.set(photo.id, photo);
        state.pendingPhotoIds.push(photo.id);
        await dbPutPhoto(photo);
      } catch (err) {
        console.error(err);
        showToast(`Couldn't process "${file.name}".`);
      }
    }
    saveState();
    renderPhotoRail();
  }

  // -------- AI call --------
  async function callPJL(userText, photoIdsForThisMessage) {
    const photos = photoIdsForThisMessage.map((id) => photoCache.get(id)).filter(Boolean);
    let content;
    if (photos.length) {
      content = photos.map((p) => ({
        type: "image",
        source: { type: "base64", media_type: p.mediaType, data: p.base64 },
        _photoId: p.id // not sent to the API; stripped before fetch
      }));
      content.push({ type: "text", text: userText || "Here's a photo of the issue." });
    } else {
      content = userText;
    }

    state.messages.push({ role: "user", content });
    saveState();

    // Strip our internal _photoId markers before sending to the Worker.
    const apiMessages = state.messages.map((m) => {
      if (typeof m.content === "string") return m;
      return { role: m.role, content: m.content.map((b) => {
        if (b.type === "image") return { type: b.type, source: b.source };
        return b;
      }) };
    });

    try {
      const response = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages })
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || `Service returned ${response.status}`);
      }
      const data = await response.json();
      const reply = data.reply || "Sorry — I'm having trouble responding right now.";
      state.messages.push({ role: "assistant", content: reply });

      // Pull the structured quote payload (if any) and stash for the booking
      // form submission. The token is stripped from cleanReply before render
      // so the customer never sees the wire format.
      const quotePayload = extractQuotePayload(reply);
      if (quotePayload) state.pendingQuote = quotePayload;

      saveState();
      const cleanReply = stripTokens(reply);
      const showForm = reply.includes(FORM_TRIGGER);
      const showCapture = reply.includes(CAPTURE_TRIGGER);
      return { reply: cleanReply, showForm, showCapture };
    } catch (err) {
      // Roll back the user message so they can retry without losing the photos
      // (photos stay in pendingPhotoIds via state below).
      state.messages.pop();
      saveState();
      throw err;
    }
  }

  // -------- Send flow --------
  async function sendCurrentMessage() {
    if (state.awaiting || state.bookingComplete || state.captureComplete) return;
    const text = (composerInput.value || "").trim();
    const photoIds = state.pendingPhotoIds.slice();
    if (!text && !photoIds.length) return;

    state.awaiting = true;
    if (!state.chatSessionId) state.chatSessionId = genSessionId();
    sendBtn.disabled = true;
    attachBtn.disabled = true;

    // Render the user message immediately
    const photoUrls = photoIds.map((id) => photoCache.get(id)?.dataUrl).filter(Boolean);
    appendUserMessageDOM(text, photoUrls);

    // Move pending photos into "sent" so the rail clears + booking carries them later
    state.pendingPhotoIds = [];
    state.photoIds.push(...photoIds);
    saveState();
    renderPhotoRail();

    composerInput.value = "";
    autoResize();

    setTimeout(showTyping, 200);

    try {
      const { reply, showForm, showCapture } = await callPJL(text, photoIds);
      hideTyping();
      if (reply) appendPJLMessageDOM(reply);
      // Booking trumps capture — if both fire (shouldn't happen, but defensively),
      // booking wins because it's a higher-intent action.
      if (showForm) {
        state.bookingShown = true;
        saveState();
        setTimeout(showBookingFormBubble, 400);
      } else if (showCapture && !state.captureShown && !state.bookingShown) {
        state.captureShown = true;
        saveState();
        setTimeout(showContactCaptureBubble, 400);
      }
      // If chat is minimized when reply lands, mark unread on launcher
      if (!state.panelOpen) launcherEl.classList.add("has-unread");
      // Snapshot transcript to the CRM after every successful AI reply.
      pushTranscript();
    } catch (err) {
      hideTyping();
      const errMsg = err.message && err.message.length < 200
        ? err.message
        : "Couldn't reach our server. Please try again or give us a call.";
      showToast(errMsg);
      appendPJLMessageDOM("Sorry — I'm having a bit of trouble connecting. Try sending your message again, or give us a call directly and we'll help you out.");
    } finally {
      state.awaiting = false;
      sendBtn.disabled = false;
      attachBtn.disabled = false;
      saveState();
      if (state.panelOpen) composerInput.focus();
    }
  }

  // -------- Booking form --------
  function showBookingFormBubble() {
    if (messagesEl.querySelector("[data-pjl-form]")) return;
    const row = document.createElement("div");
    row.className = "pjl-chat-msg-row pjl";
    row.setAttribute("data-pjl-form", "true");
    const av = document.createElement("div");
    av.className = "pjl-chat-msg-avatar hidden";
    row.appendChild(av);
    const bubble = document.createElement("div");
    bubble.className = "pjl-chat-form-bubble";
    bubble.innerHTML = `
      <h3>Drop your details</h3>
      <p>$95 service call covers mobilization plus a quick on-site assessment. Diagnostic and repair labour billed separately at $95/hr — quoted in writing before any work begins. <strong>Bonus:</strong> if the AI's diagnosis here matches what we find on-site, you get one hour of repair labour free.</p>
      <form data-pjl-lead-form>
        <div class="pjl-chat-form-grid">
          <div><label>First name <span class="req">*</span></label><input type="text" name="first_name" required></div>
          <div><label>Last name <span class="req">*</span></label><input type="text" name="last_name" required></div>
          <div><label>Email <span class="req">*</span></label><input type="email" name="email" required></div>
          <div><label>Phone <span class="req">*</span></label><input type="tel" name="phone" required></div>
          <div class="full"><label>Service address</label><input type="text" name="address" placeholder="Street, City"></div>
          <div class="full"><label>Anything else we should know?</label><textarea name="notes" rows="2" placeholder="Access notes, gate code, dog on property..."></textarea></div>
        </div>
        <button type="submit">Send My Details →</button>
      </form>
    `;
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();

    bubble.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target).entries());
      submitLead(f, e.target);
    });

    // Wire Google Places Autocomplete on the address input — same UX as
    // the rest of the public site (coverage-checker pages, contact form).
    bindAddressAutocomplete(bubble.querySelector('input[name="address"]'));

    composerInput.disabled = true;
    sendBtn.disabled = true;
    attachBtn.disabled = true;
    composerInput.placeholder = "Filling out booking form...";
  }

  // Send the current transcript to the CRM. Runs after every AI reply so
  // Patrick has a near-live feed of conversations. Also runs on `close()`
  // (with ended:true) and on page unload via sendBeacon. We intentionally
  // tolerate failures silently — the customer's chat must not be blocked
  // because background telemetry got rejected.
  function pushTranscript({ ended = false, useBeacon = false } = {}) {
    if (!state.chatSessionId) return;
    const transcript = buildTranscript();
    // Don't bother sending until there's at least one real exchange (the
    // first two messages are always the AI's welcome — those alone are noise).
    const realMessages = state.messages.filter((m) => {
      if (m.role !== "user") return false;
      if (typeof m.content === "string") return m.content.trim().length > 0;
      return true; // multimodal user messages always count
    });
    if (realMessages.length === 0 && !ended) return;

    const payload = {
      sessionId: state.chatSessionId,
      transcript,
      messageCount: state.messages.length,
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      ended
    };

    try {
      if (useBeacon && navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        navigator.sendBeacon(TRANSCRIPT_ENDPOINT, blob);
        return;
      }
      // Fire-and-forget. Use keepalive so if the user navigates mid-fetch
      // the request still completes.
      fetch(TRANSCRIPT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    } catch (e) { /* swallow */ }
  }

  function buildTranscript() {
    const lines = [];
    for (const m of state.messages) {
      const who = m.role === "user" ? "Customer" : "Patrick (AI)";
      let text;
      if (typeof m.content === "string") {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        const imageCount = m.content.filter((b) => b.type === "image").length;
        const tp = m.content.find((b) => b.type === "text");
        text = (imageCount ? `[attached ${imageCount} photo${imageCount > 1 ? "s" : ""}] ` : "") + (tp ? tp.text : "");
      } else { text = ""; }
      text = stripTokens(text);
      if (text) lines.push(`${who}: ${text}`);
    }
    return lines.join("\n\n");
  }

  function submitLead(formFields, formEl) {
    const submitBtn = formEl.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";

    const fullName = `${(formFields.first_name || "").trim()} ${(formFields.last_name || "").trim()}`.trim();
    const photos = state.photoIds.map((id) => photoCache.get(id)).filter(Boolean).map((p) => ({
      data: p.base64, mediaType: p.mediaType
    }));

    const payload = {
      source: "ai_diagnose",
      contact: {
        name: fullName,
        phone: formFields.phone || "",
        email: formFields.email || "",
        address: formFields.address || "",
        notes: formFields.notes || ""
      },
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      mode: "ai_diagnose",
      transcript: buildTranscript(),
      chatSessionId: state.chatSessionId || null,
      // Structured AI quote payload (if the AI emitted [QUOTE_JSON]). The
      // server validates each line-item key against pricing.json, recomputes
      // the total, and creates a Quote record linked to this lead.
      quotePayload: state.pendingQuote || null,
      photos
    };

    fetch(LEAD_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        state.bookingComplete = true;
        saveState();
        showThankYou({ kind: "booking", portalUrl: body.portalUrl });
      } else {
        const msg = (body.errors && body.errors[0]) || `Submit failed (${r.status})`;
        throw new Error(msg);
      }
    }).catch((err) => {
      console.error("Lead submit error:", err);
      showToast(err.message || "Couldn't send your details — please try again or call us directly.");
      submitBtn.disabled = false;
      submitBtn.textContent = "Send My Details →";
    });
  }

  // -------- Contact-capture form (self-fix success path) --------
  // Lighter-weight than the booking form: name + phone + email + address only.
  // No service selection, no photos. Posts to the same /api/quotes endpoint
  // with a different `source` so the lead lands in the CRM tagged for
  // future fall outreach instead of an active repair booking.
  function showContactCaptureBubble() {
    if (messagesEl.querySelector("[data-pjl-capture]")) return;
    const row = document.createElement("div");
    row.className = "pjl-chat-msg-row pjl";
    row.setAttribute("data-pjl-capture", "true");
    const av = document.createElement("div");
    av.className = "pjl-chat-msg-avatar hidden";
    row.appendChild(av);
    const bubble = document.createElement("div");
    bubble.className = "pjl-chat-form-bubble";
    bubble.innerHTML = `
      <h3>Stay in touch</h3>
      <p>Drop your info below and we'll reach out in the fall when we start booking Fall Closing Services. No commitment — just so you know who to call.</p>
      <form data-pjl-capture-form>
        <div class="pjl-chat-form-grid">
          <div><label>First name <span class="req">*</span></label><input type="text" name="first_name" required></div>
          <div><label>Last name <span class="req">*</span></label><input type="text" name="last_name" required></div>
          <div><label>Email <span class="req">*</span></label><input type="email" name="email" required></div>
          <div><label>Phone <span class="req">*</span></label><input type="tel" name="phone" required></div>
          <div class="full"><label>Service address</label><input type="text" name="address" placeholder="Street, City"></div>
        </div>
        <button type="submit">Add Me to the List →</button>
      </form>
    `;
    row.appendChild(bubble);
    messagesEl.appendChild(row);
    scrollToBottom();

    bubble.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target).entries());
      submitContactCapture(f, e.target);
    });

    // Same Places Autocomplete wiring as the booking form.
    bindAddressAutocomplete(bubble.querySelector('input[name="address"]'));

    composerInput.disabled = true;
    sendBtn.disabled = true;
    attachBtn.disabled = true;
    composerInput.placeholder = "Filling out contact form...";
  }

  function submitContactCapture(formFields, formEl) {
    const submitBtn = formEl.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending...";

    const fullName = `${(formFields.first_name || "").trim()} ${(formFields.last_name || "").trim()}`.trim();

    const payload = {
      source: "ai_self_fix_capture",
      contact: {
        name: fullName,
        phone: formFields.phone || "",
        email: formFields.email || "",
        address: formFields.address || "",
        notes: ""
      },
      // Empty features = not a quote; the lead is a future-prospect contact.
      features: [],
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      mode: "ai_self_fix_capture",
      transcript: buildTranscript(),
      chatSessionId: state.chatSessionId || null,
      photos: []
    };

    fetch(LEAD_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    }).then(async (r) => {
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        state.captureComplete = true;
        saveState();
        showThankYou({ kind: "capture", portalUrl: body.portalUrl });
      } else {
        const msg = (body.errors && body.errors[0]) || `Submit failed (${r.status})`;
        throw new Error(msg);
      }
    }).catch((err) => {
      console.error("Capture submit error:", err);
      showToast(err.message || "Couldn't send your details — please try again or call us directly.");
      submitBtn.disabled = false;
      submitBtn.textContent = "Add Me to the List →";
    });
  }

  // Show the thank-you overlay with copy + portal block tailored to the
  // flow that just completed. `kind` is "booking" (active repair booked)
  // or "capture" (self-fix success, future-prospect opt-in).
  function showThankYou({ kind, portalUrl }) {
    const headingEl = tyOverlay.querySelector("[data-pjl-ty-heading]");
    const bodyEl = tyOverlay.querySelector("[data-pjl-ty-body]");
    if (kind === "capture") {
      if (headingEl) headingEl.textContent = "Got you on the list.";
      if (bodyEl) bodyEl.textContent = "We'll reach out in the fall when we start booking winterizations. No need to do anything until then — your sprinkler system is back up and running, and that's the win.";
    } else {
      if (headingEl) headingEl.textContent = "You're now a PJL customer.";
      if (bodyEl) bodyEl.textContent = "We'll reach out within 24 hours to confirm your visit. Check your email for the booking confirmation.";
    }
    if (portalUrl) {
      const portalBlock = tyOverlay.querySelector("[data-pjl-ty-portal]");
      const portalLink = tyOverlay.querySelector("[data-pjl-ty-portal-link]");
      if (portalBlock && portalLink) {
        portalLink.href = portalUrl;
        portalLink.textContent = portalUrl;
        portalBlock.hidden = false;
      }
    }
    tyOverlay.classList.add("is-visible");
  }

  // -------- Welcome / first-time messages --------
  function ensureWelcome() {
    if (state.messages.length > 0) return;
    setTimeout(() => {
      const m1 = { role: "assistant", content: "Hey, I'm Patrick from PJL Land Services 👋" };
      state.messages.push(m1);
      appendPJLMessageDOM(m1.content);
      saveState();
    }, 200);
    setTimeout(showTyping, 1000);
    setTimeout(() => {
      hideTyping();
      const m2 = { role: "assistant", content: "Tell me what's going on with your sprinkler system — describe it however feels natural, like you'd tell a neighbour. I'll come back with what's likely happening, what you can try yourself, and an honest read on whether you need a tech." };
      state.messages.push(m2);
      appendPJLMessageDOM(m2.content);
      saveState();
      composerInput.focus();
    }, 2400);
  }

  // -------- Public API --------
  const api = {
    open() {
      if (!panelEl) return;
      panelEl.classList.add("is-open");
      launcherEl.classList.remove("has-unread");
      state.panelOpen = true;
      saveState();
      // On mobile, lock body scroll when panel is fullscreen.
      if (window.matchMedia("(max-width: 767px)").matches) {
        document.body.classList.add("pjl-chat-locked");
      }
      ensureWelcome();
      // Showing the panel implies the launcher should track this conversation.
      launcherEl.classList.add("is-visible");
      setTimeout(() => composerInput && composerInput.focus(), 150);
    },
    minimize() {
      panelEl.classList.remove("is-open");
      state.panelOpen = false;
      saveState();
      document.body.classList.remove("pjl-chat-locked");
      // Show launcher pill so they can come back
      launcherEl.classList.add("is-visible");
    },
    close() {
      // "End chat" — clear state so launcher disappears completely.
      // Send a final transcript snapshot before clearing so the abandoned
      // chat is captured in the CRM.
      pushTranscript({ ended: true });
      panelEl.classList.remove("is-open");
      launcherEl.classList.remove("is-visible");
      document.body.classList.remove("pjl-chat-locked");
      clearAllState();
    },
    async restart() {
      if (!confirm("Start a new conversation? This will clear everything you've typed so far.")) return;
      await clearAllState();
      messagesEl.innerHTML = "";
      photoRailEl.innerHTML = "";
      composerInput.disabled = false;
      sendBtn.disabled = false;
      attachBtn.disabled = false;
      composerInput.placeholder = mobilePlaceholder();
      composerInput.value = "";
      tyOverlay.classList.remove("is-visible");
      state.panelOpen = true;
      saveState();
      ensureWelcome();
    },
    isActive() {
      return state.messages.length > 0 || state.bookingComplete;
    }
  };
  window.pjlChat = api;

  // -------- Init --------
  async function init() {
    // 1. Build DOM
    launcherEl = buildLauncher();
    panelEl = buildPanel();
    document.body.appendChild(launcherEl);
    document.body.appendChild(panelEl);

    messagesEl = panelEl.querySelector("[data-pjl-messages]");
    composerInput = panelEl.querySelector("[data-pjl-input]");
    sendBtn = panelEl.querySelector('[data-action="send"]');
    attachBtn = panelEl.querySelector('[data-action="attach"]');
    photoInput = panelEl.querySelector("[data-pjl-photo-input]");
    photoRailEl = panelEl.querySelector("[data-pjl-photo-rail]");
    tyOverlay = panelEl.querySelector("[data-pjl-ty]");
    composerInput.placeholder = mobilePlaceholder();
    // Keep the placeholder in sync if the user rotates / resizes (e.g. opens
    // dev tools on desktop, switches landscape on mobile).
    try {
      const mq = window.matchMedia("(max-width: 767px)");
      const mqHandler = () => { if (composerInput && !composerInput.value) composerInput.placeholder = mobilePlaceholder(); };
      mq.addEventListener ? mq.addEventListener("change", mqHandler) : mq.addListener(mqHandler);
    } catch (e) {}
    attachPanelHandlers();

    // 2. Load persisted state
    const hadState = loadState();

    // 3. Hydrate photos from IndexedDB (must finish before we render messages
    // that contain image attachments)
    const allPhotos = await dbAllPhotos();
    allPhotos.forEach((p) => photoCache.set(p.id, p));

    // 4. Decide visibility
    if (hadState && (state.bookingComplete || state.captureComplete)) {
      // They converted (booked OR captured), then navigated. Treat as a
      // completed session and clear state — launcher disappears, fresh
      // start on next visit. Same logic for both terminal flows.
      await clearAllState();
    } else if (hadState && state.messages.length > 0) {
      // Active conversation — show ONLY the launcher pill on a fresh page
      // load. We deliberately do NOT auto-open the panel even if it was open
      // on the previous page; the customer reopens it by clicking the pill.
      // (Auto-opening on every navigation would obscure the page they just
      // navigated to.) The conversation, photos, and form state are all
      // still there — they just stay collapsed until requested.
      state.panelOpen = false;
      saveState();
      launcherEl.classList.add("is-visible");
      // Pre-render the messages + photo rail so re-opening is instant.
      renderMessages();
      renderPhotoRail();
      // Re-render whichever form was active. Booking takes precedence if
      // somehow both were shown (defensive — the send flow gates this).
      if (state.bookingShown) {
        showBookingFormBubble();
      } else if (state.captureShown) {
        showContactCaptureBubble();
      }
    }

    // 5. Wire any data-pjl-chat triggers on this page (CTA buttons, links).
    bindCtaTriggers();

    // 6. On tab close / nav away, beacon a final transcript snapshot so we
    //    don't lose the conversation when a customer just walks away.
    window.addEventListener("pagehide", () => {
      // Already captured via /api/quotes — skip the beacon to avoid duplicate
      // transcript writes. Same for both terminal flows.
      if (state.bookingComplete || state.captureComplete) return;
      if (!state.messages.length || !state.chatSessionId) return;
      pushTranscript({ useBeacon: true });
    });
  }

  function bindCtaTriggers() {
    document.querySelectorAll("[data-pjl-chat]").forEach((el) => {
      if (el.dataset.pjlChatBound) return;
      el.dataset.pjlChatBound = "1";
      el.addEventListener("click", (e) => {
        // If it's a link, don't navigate — open the chat instead.
        if (el.tagName === "A") e.preventDefault();
        api.open();
      });
    });
  }

  // Also rebind triggers if the page mutates (rarely needed but cheap insurance).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
