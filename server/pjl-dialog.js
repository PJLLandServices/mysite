/**
 * PJL Dialog — shared, sitewide, promise-based replacement for the
 * browser's native alert()/confirm()/prompt(). Generalizes the pattern
 * already proven in bulk-modal.js (focus trap, Escape/backdrop-to-cancel,
 * typed-DELETE friction) into one component usable from any CRM page.
 *
 * No HTML injection anywhere: all text goes through .textContent, and
 * icons are built as SVG DOM nodes, never innerHTML/template strings.
 *
 *   await pjlDialog.alert(message, { title, icon });
 *   const ok = await pjlDialog.confirm(message, { title, icon, destructive, requireTypedConfirm, confirmLabel, cancelLabel, warning });
 *   const value = await pjlDialog.prompt(message, { title, icon, defaultValue, confirmLabel, cancelLabel });
 *
 * confirm()/prompt() resolve `false`/`null` on Cancel, Escape, or a
 * backdrop click — never reject. alert() resolves with no value once
 * dismissed.
 */
(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";

  // Simple stroke-based pictograms, one per action type. Kept intentionally
  // minimal (a handful of primitives each) rather than pulling in an icon
  // library — matches the "no external assets" spirit of bulk-modal.js.
  var ICONS = {
    delete: {
      els: [
        ["path", { d: "M4 7h16" }],
        ["path", { d: "M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" }],
        ["path", { d: "M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7" }],
        ["path", { d: "M10 11v6" }],
        ["path", { d: "M14 11v6" }],
      ],
    },
    send: {
      els: [
        ["path", { d: "M3 11.5L21 3l-8.5 18-2.2-7.3L3 11.5z" }],
        ["path", { d: "M10.3 13.7L21 3" }],
      ],
    },
    warning: {
      els: [
        ["path", { d: "M12 3.5l9.5 16.5H2.5L12 3.5z" }],
        ["path", { d: "M12 9.5v5" }],
        ["circle", { cx: "12", cy: "17", r: "0.9", fill: "currentColor", stroke: "none" }],
      ],
    },
    info: {
      els: [
        ["circle", { cx: "12", cy: "12", r: "9" }],
        ["circle", { cx: "12", cy: "8", r: "0.9", fill: "currentColor", stroke: "none" }],
        ["path", { d: "M12 11v6" }],
      ],
    },
  };

  function createIcon(name) {
    var def = name && ICONS[name];
    if (!def) return null;
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "pjl-dialog-icon pjl-dialog-icon-" + name);
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.75");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    def.els.forEach(function (spec) {
      var el = document.createElementNS(SVG_NS, spec[0]);
      var attrs = spec[1];
      Object.keys(attrs).forEach(function (k) {
        el.setAttribute(k, attrs[k]);
      });
      svg.appendChild(el);
    });
    return svg;
  }

  function randomId(prefix) {
    return prefix + "-" + Math.random().toString(36).slice(2, 10);
  }

  function defaultTitle(mode) {
    if (mode === "alert") return "Notice";
    if (mode === "prompt") return "Enter a value";
    return "Confirm";
  }

  function defaultConfirmLabel(mode) {
    if (mode === "alert" || mode === "prompt") return "OK";
    return "Confirm";
  }

  function open(mode, bodyText, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var previouslyFocused = document.activeElement;
      var destructive = !!opts.destructive;
      var requireTypedConfirm = !!opts.requireTypedConfirm;
      var iconName = opts.icon || (destructive ? "warning" : null);

      var backdrop = document.createElement("div");
      backdrop.className = "pjl-dialog-backdrop";

      var panel = document.createElement("div");
      panel.className = "pjl-dialog-panel" + (destructive ? " pjl-dialog-panel-destructive" : "");
      panel.setAttribute("role", "alertdialog");
      panel.setAttribute("aria-modal", "true");

      var titleId = randomId("pjl-dialog-title");
      var bodyId = randomId("pjl-dialog-body");
      panel.setAttribute("aria-labelledby", titleId);
      panel.setAttribute("aria-describedby", bodyId);

      var header = document.createElement("div");
      header.className = "pjl-dialog-header";
      var iconEl = createIcon(iconName);
      if (iconEl) header.appendChild(iconEl);
      var h2 = document.createElement("h2");
      h2.className = "pjl-dialog-title";
      h2.id = titleId;
      h2.textContent = opts.title || defaultTitle(mode);
      header.appendChild(h2);
      panel.appendChild(header);

      var body = document.createElement("p");
      body.className = "pjl-dialog-body";
      body.id = bodyId;
      body.textContent = bodyText || "";
      panel.appendChild(body);

      var input = null;
      if (mode === "prompt") {
        input = document.createElement("input");
        input.type = "text";
        input.className = "pjl-dialog-input";
        input.value = opts.defaultValue || "";
        panel.appendChild(input);
      }

      if (opts.warning) {
        var warningEl = document.createElement("p");
        warningEl.className = "pjl-dialog-warning";
        warningEl.textContent = opts.warning;
        panel.appendChild(warningEl);
      }

      var typedInput = null;
      if (requireTypedConfirm) {
        var label = document.createElement("label");
        label.className = "pjl-dialog-typed-label";
        label.textContent = "Type DELETE to confirm";
        typedInput = document.createElement("input");
        typedInput.type = "text";
        typedInput.className = "pjl-dialog-typed-input";
        typedInput.autocomplete = "off";
        label.appendChild(typedInput);
        panel.appendChild(label);
      }

      var actions = document.createElement("div");
      actions.className = "pjl-dialog-actions";

      var cancelBtn = null;
      if (mode !== "alert") {
        cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "pjl-dialog-btn pjl-dialog-btn-secondary";
        cancelBtn.textContent = opts.cancelLabel || "Cancel";
        actions.appendChild(cancelBtn);
      }

      var confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "pjl-dialog-btn " + (destructive ? "pjl-dialog-btn-destructive" : "pjl-dialog-btn-primary");
      confirmBtn.textContent = opts.confirmLabel || defaultConfirmLabel(mode);
      if (requireTypedConfirm) confirmBtn.disabled = true;
      actions.appendChild(confirmBtn);

      panel.appendChild(actions);
      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);

      function cleanup(result) {
        backdrop.removeEventListener("keydown", onKeydown, true);
        backdrop.remove();
        try {
          if (previouslyFocused && typeof previouslyFocused.focus === "function") {
            previouslyFocused.focus();
          }
        } catch (e) {
          // Element may no longer be attached/focusable — ignore.
        }
        resolve(result);
      }

      function settle(confirmed) {
        if (mode === "alert") {
          cleanup(undefined);
        } else if (mode === "prompt") {
          cleanup(confirmed ? input.value : null);
        } else {
          cleanup(!!confirmed);
        }
      }

      confirmBtn.addEventListener("click", function () {
        settle(true);
      });
      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          settle(false);
        });
      }
      backdrop.addEventListener("click", function (e) {
        if (e.target === backdrop) settle(false);
      });

      if (requireTypedConfirm) {
        typedInput.addEventListener("input", function () {
          confirmBtn.disabled = typedInput.value.trim().toUpperCase() !== "DELETE";
        });
        typedInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter" && !confirmBtn.disabled) {
            e.preventDefault();
            settle(true);
          }
        });
      }

      if (mode === "prompt") {
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            settle(true);
          }
        });
      }

      function onKeydown(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          settle(false);
          return;
        }
        if (e.key === "Tab") {
          var focusable = panel.querySelectorAll("input, button:not([disabled])");
          if (!focusable.length) return;
          var first = focusable[0];
          var last = focusable[focusable.length - 1];
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

      var initialFocus = typedInput || input || cancelBtn || confirmBtn;
      initialFocus.focus();
    });
  }

  window.pjlDialog = {
    alert: function (message, opts) {
      return open("alert", message, opts);
    },
    confirm: function (message, opts) {
      return open("confirm", message, opts);
    },
    prompt: function (message, opts) {
      return open("prompt", message, opts);
    },
  };
})();
