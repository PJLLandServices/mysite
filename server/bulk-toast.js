// PJL CRM bulk-actions toast notifications.
//
// Lightweight, stack-aware. One container at the bottom of the page,
// toasts append vertically, auto-dismiss in 10 seconds (longer than the
// usual 3-4s so Patrick has time to undo). Manual ✕ dismiss + optional
// Undo button.
//
// API:
//   pjlBulkToast.show({ type: "success"|"error", message: "...", undo?: () => Promise })
//   pjlBulkToast.dismissAll()   — kills every visible toast (e.g. on page change)
//
// Coupled to .pjl-bulk-toast* CSS classes in crm.css.

(function () {
  const TOAST_TTL_MS = 10_000;
  const UNDO_CONFIRM_TTL_MS = 2_000;

  let container = null;

  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement("div");
    container.className = "pjl-bulk-toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
    return container;
  }

  function show({ type = "success", message = "", undo = null } = {}) {
    const root = ensureContainer();
    const toast = document.createElement("div");
    toast.className = "pjl-bulk-toast pjl-bulk-toast-" + (type === "error" ? "error" : "success");
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.setAttribute("aria-live", type === "error" ? "assertive" : "polite");

    const glyph = document.createElement("span");
    glyph.className = "pjl-bulk-toast-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = type === "error" ? "⚠" : "✓";
    toast.appendChild(glyph);

    const text = document.createElement("span");
    text.className = "pjl-bulk-toast-text";
    text.textContent = message;
    toast.appendChild(text);

    let undoBtn = null;
    if (typeof undo === "function" && type !== "error") {
      undoBtn = document.createElement("button");
      undoBtn.type = "button";
      undoBtn.className = "pjl-bulk-toast-undo";
      undoBtn.textContent = "Undo";
      undoBtn.addEventListener("click", async () => {
        undoBtn.disabled = true;
        try {
          await undo();
          replaceWithRestored(toast);
        } catch (err) {
          replaceWithError(toast, err && err.message ? err.message : "Undo failed.");
        }
      });
      toast.appendChild(undoBtn);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "pjl-bulk-toast-close";
    close.setAttribute("aria-label", "Dismiss notification");
    close.innerHTML = "&times;";
    close.addEventListener("click", () => dismiss(toast));
    toast.appendChild(close);

    root.appendChild(toast);

    const ttl = setTimeout(() => dismiss(toast), TOAST_TTL_MS);
    toast.__ttl = ttl;
    return toast;
  }

  function dismiss(toast) {
    if (!toast || !toast.parentNode) return;
    clearTimeout(toast.__ttl);
    toast.classList.add("pjl-bulk-toast-leaving");
    // CSS transition handles the fade-out; remove from DOM after.
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 200);
  }

  function replaceWithRestored(toast) {
    if (!toast || !toast.parentNode) return;
    clearTimeout(toast.__ttl);
    // Reset content to "Restored." with auto-dismiss in 2s.
    toast.innerHTML = "";
    const glyph = document.createElement("span");
    glyph.className = "pjl-bulk-toast-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "✓";
    toast.appendChild(glyph);
    const text = document.createElement("span");
    text.className = "pjl-bulk-toast-text";
    text.textContent = "Restored.";
    toast.appendChild(text);
    toast.__ttl = setTimeout(() => dismiss(toast), UNDO_CONFIRM_TTL_MS);
  }

  function replaceWithError(toast, msg) {
    if (!toast || !toast.parentNode) return;
    clearTimeout(toast.__ttl);
    toast.classList.remove("pjl-bulk-toast-success");
    toast.classList.add("pjl-bulk-toast-error");
    toast.innerHTML = "";
    const glyph = document.createElement("span");
    glyph.className = "pjl-bulk-toast-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = "⚠";
    toast.appendChild(glyph);
    const text = document.createElement("span");
    text.className = "pjl-bulk-toast-text";
    text.textContent = msg;
    toast.appendChild(text);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "pjl-bulk-toast-close";
    close.setAttribute("aria-label", "Dismiss notification");
    close.innerHTML = "&times;";
    close.addEventListener("click", () => dismiss(toast));
    toast.appendChild(close);
    toast.__ttl = setTimeout(() => dismiss(toast), TOAST_TTL_MS);
  }

  function dismissAll() {
    if (!container) return;
    Array.from(container.children).forEach(dismiss);
  }

  window.pjlBulkToast = { show, dismissAll };
})();
