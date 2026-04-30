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
  const FORM_TRIGGER = "[SHOW_BOOKING_FORM]";
  const STORAGE_KEY = "pjl_chat_state_v1";
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
    panelOpen: false,
    awaiting: false       // reset to false on rehydrate (in-flight requests don't survive nav)
  };

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
        panelOpen: state.panelOpen
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
      bookingShown: false, bookingComplete: false, panelOpen: false, awaiting: false
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
          <input type="file" data-pjl-photo-input accept="image/*" capture="environment" multiple style="display:none">
          <textarea data-pjl-input rows="1" placeholder="Tell us what's going on with your sprinklers..."></textarea>
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
          <h2>Thanks — we've got you.</h2>
          <p>We'll reach out within 24 hours to schedule your visit. Check your email for a confirmation.</p>
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

  // -------- Rendering --------
  function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function formatBubbleText(text) {
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
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
      const text = (typeof msg.content === "string" ? msg.content : "")
        .replace(FORM_TRIGGER, "")
        .trim();
      bubble.innerHTML = formatBubbleText(text);
      row.appendChild(bubble);
    }
    messagesEl.appendChild(row);
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
      saveState();
      const cleanReply = reply.replace(FORM_TRIGGER, "").trim();
      const showForm = reply.includes(FORM_TRIGGER);
      return { reply: cleanReply, showForm };
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
    if (state.awaiting || state.bookingComplete) return;
    const text = (composerInput.value || "").trim();
    const photoIds = state.pendingPhotoIds.slice();
    if (!text && !photoIds.length) return;

    state.awaiting = true;
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
      const { reply, showForm } = await callPJL(text, photoIds);
      hideTyping();
      if (reply) appendPJLMessageDOM(reply);
      if (showForm) {
        state.bookingShown = true;
        saveState();
        setTimeout(showBookingFormBubble, 400);
      }
      // If chat is minimized when reply lands, mark unread on launcher
      if (!state.panelOpen) launcherEl.classList.add("has-unread");
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
      <p>$95 service call covers mobilization plus the first hour on-site. Any parts or extra labour quoted before we do the work.</p>
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

    composerInput.disabled = true;
    sendBtn.disabled = true;
    attachBtn.disabled = true;
    composerInput.placeholder = "Filling out booking form...";
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
      text = text.replace(FORM_TRIGGER, "").trim();
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
        tyOverlay.classList.add("is-visible");
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
      composerInput.placeholder = "Tell us what's going on with your sprinklers...";
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
    attachPanelHandlers();

    // 2. Load persisted state
    const hadState = loadState();

    // 3. Hydrate photos from IndexedDB (must finish before we render messages
    // that contain image attachments)
    const allPhotos = await dbAllPhotos();
    allPhotos.forEach((p) => photoCache.set(p.id, p));

    // 4. Decide visibility
    if (hadState && state.bookingComplete) {
      // They booked, then navigated. Don't show launcher — booking is done.
      // Surface the panel only if they explicitly had it open.
      // Default: clean state. Most pages should hide both.
      // But keep launcher off; they may revisit later in a fresh session.
      // For now, we treat post-booking as "session closed" and clear it.
      await clearAllState();
    } else if (hadState && state.messages.length > 0) {
      // Active conversation — show ONLY the launcher pill on a fresh page
      // load. We deliberately do NOT auto-open the panel even if it was open
      // on the previous page; the customer reopens it by clicking the pill.
      // (Auto-opening on every navigation would obscure the page they just
      // navigated to.) The conversation, photos, and booking-form state are
      // all still there — they just stay collapsed until requested.
      state.panelOpen = false;
      saveState();
      launcherEl.classList.add("is-visible");
      // Pre-render the messages + photo rail so re-opening is instant.
      renderMessages();
      renderPhotoRail();
      if (state.bookingShown) {
        showBookingFormBubble();
      }
    }

    // 5. Wire any data-pjl-chat triggers on this page (CTA buttons, links).
    bindCtaTriggers();
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
