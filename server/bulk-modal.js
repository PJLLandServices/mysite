// PJL CRM bulk-actions confirmation modal.
//
// Returns a Promise<boolean>: true if the user confirmed, false on cancel /
// Esc / backdrop click. Handles focus trap, typed-DELETE friction for
// high-volume destructive actions, and the standard <5 confirm flow.
//
// API:
//   pjlBulkModal.confirm({
//     title: "Delete 3 leads?",
//     body:  "These leads will be moved to Trash and permanently deleted after 30 days.",
//     confirmLabel: "Delete",
//     cancelLabel:  "Cancel",
//     destructive:  true,            // styles the confirm button red
//     requireTypedConfirm: false     // when true, requires user to type "DELETE"
//   })  -> Promise<boolean>
//
// Visual: .pjl-bulk-modal* classes in crm.css.

(function () {
  function confirm({ title = "Confirm action", body = "", confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false, requireTypedConfirm = false } = {}) {
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;

      const backdrop = document.createElement("div");
      backdrop.className = "pjl-bulk-modal-backdrop";

      const panel = document.createElement("div");
      panel.className = "pjl-bulk-modal-panel";
      panel.setAttribute("role", "alertdialog");
      panel.setAttribute("aria-modal", "true");
      const titleId = "pjl-bulk-modal-title-" + Math.random().toString(36).slice(2, 8);
      const bodyId = "pjl-bulk-modal-body-" + Math.random().toString(36).slice(2, 8);
      panel.setAttribute("aria-labelledby", titleId);
      panel.setAttribute("aria-describedby", bodyId);

      const titleEl = document.createElement("h2");
      titleEl.id = titleId;
      titleEl.className = "pjl-bulk-modal-title";
      titleEl.textContent = title;
      panel.appendChild(titleEl);

      const bodyEl = document.createElement("p");
      bodyEl.id = bodyId;
      bodyEl.className = "pjl-bulk-modal-body";
      bodyEl.textContent = body;
      panel.appendChild(bodyEl);

      let typedInput = null;
      if (requireTypedConfirm) {
        const label = document.createElement("label");
        label.className = "pjl-bulk-modal-typed-label";
        label.textContent = "Type DELETE to confirm:";
        panel.appendChild(label);

        typedInput = document.createElement("input");
        typedInput.type = "text";
        typedInput.className = "pjl-bulk-modal-typed-input";
        typedInput.autocomplete = "off";
        typedInput.setAttribute("aria-label", "Type DELETE to confirm");
        panel.appendChild(typedInput);
      }

      const actions = document.createElement("div");
      actions.className = "pjl-bulk-modal-actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "pjl-bulk-modal-btn pjl-bulk-modal-btn-secondary";
      cancelBtn.textContent = cancelLabel;
      actions.appendChild(cancelBtn);

      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "pjl-bulk-modal-btn " + (destructive ? "pjl-bulk-modal-btn-destructive" : "pjl-bulk-modal-btn-primary");
      confirmBtn.textContent = confirmLabel;
      if (requireTypedConfirm) confirmBtn.disabled = true;
      actions.appendChild(confirmBtn);

      panel.appendChild(actions);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);

      // Auto-focus: the typed input if present, else the cancel button so
      // an over-eager Enter doesn't fire the destructive action.
      (typedInput || cancelBtn).focus();

      if (typedInput) {
        typedInput.addEventListener("input", () => {
          confirmBtn.disabled = typedInput.value.trim().toUpperCase() !== "DELETE";
        });
        typedInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !confirmBtn.disabled) {
            e.preventDefault();
            confirmBtn.click();
          }
        });
      }

      function cleanup(result) {
        backdrop.removeEventListener("keydown", onKeydown, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (previouslyFocused && previouslyFocused.focus) {
          try { previouslyFocused.focus(); } catch {}
        }
        resolve(result);
      }

      cancelBtn.addEventListener("click", () => cleanup(false));
      confirmBtn.addEventListener("click", () => cleanup(true));
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) cleanup(false);
      });

      function onKeydown(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          cleanup(false);
          return;
        }
        if (e.key === "Tab") {
          // Focus trap — keep tab inside the modal.
          const focusables = Array.from(panel.querySelectorAll('input, button:not([disabled])'));
          if (!focusables.length) return;
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
      backdrop.addEventListener("keydown", onKeydown, true);
    });
  }

  window.pjlBulkModal = { confirm };
})();
