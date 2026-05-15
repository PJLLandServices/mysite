// Per-resource bulk-action configurations.
//
// Each admin list page calls `pjlBulkWiring.attach("resource-name")`
// after its rows are first rendered (and after re-renders). This module
// owns the action set + confirmation copy + endpoint routing so the
// per-page boilerplate stays small: a list selector + a row selector +
// a refresh callback.
//
// Pages that need custom rules (only one is suppliers — no soft-delete
// at all) can supply an `actionsOverride` callback to filter or tweak
// the default actions.

(function () {
  const RESOURCES = {
    properties: {
      listSelector: "#propertiesGrid",
      rowSelector: ".property-card",
      idAttribute: "data-id",
      actions: () => [
        action_archive("property", "properties"),
        action_softDelete("property", "properties")
      ]
    },
    "work-orders": {
      listSelector: "#woContainer",
      rowSelector: ".ml-card",
      idAttribute: "data-wo-id",
      actions: () => [
        action_changeStatus("work-orders", [
          { value: "scheduled", label: "Mark scheduled" },
          { value: "on_site",   label: "Mark on site" },
          { value: "completed", label: "Mark completed" },
          { value: "cancelled", label: "Mark cancelled" }
        ]),
        action_archive("work order", "work-orders"),
        action_softDelete("work order", "work-orders", { action: "delete-drafts", label: "Delete drafts" })
      ]
    },
    quotes: {
      listSelector: "#quotesBody",
      rowSelector: "tr.quote-row",
      idAttribute: "data-quote-id",
      actions: () => [
        action_expire(),
        action_softDelete("quote", "quotes", { action: "delete-drafts", label: "Delete drafts" })
      ]
    },
    invoices: {
      listSelector: "#invoicesBody",
      rowSelector: "tr.invoice-row",
      idAttribute: "data-invoice-id",
      actions: () => [
        action_changeStatus("invoices", [
          { value: "sent", label: "Mark sent (draft → sent)" }
        ]),
        action_resend("invoice", "invoices")
      ]
    },
    "material-lists": {
      listSelector: "#listsContainer",
      rowSelector: ".ml-card",
      idAttribute: "data-list-id",
      actions: () => [
        action_changeStatus("material-lists", [
          { value: "draft",       label: "Mark draft" },
          { value: "in_progress", label: "Mark in progress" },
          { value: "complete",    label: "Mark complete" },
          { value: "archived",    label: "Mark archived" }
        ]),
        action_softDelete("material list", "material-lists")
      ]
    },
    suppliers: {
      listSelector: "#suppliersList",
      rowSelector: ".supplier-card",
      idAttribute: "data-supplier-id",
      actions: () => [
        action_archiveSupplier()
      ]
    },
    "purchase-orders": {
      listSelector: "#poContainer",
      rowSelector: ".ml-card",
      idAttribute: "data-po-id",
      actions: () => [
        action_changeStatus("purchase-orders", [
          { value: "sent",      label: "Mark sent" },
          { value: "received",  label: "Mark received" },
          { value: "cancelled", label: "Mark cancelled" }
        ]),
        action_resend("purchase order", "purchase-orders"),
        action_softDelete("purchase order", "purchase-orders", { action: "delete-drafts", label: "Delete drafts" })
      ]
    }
  };

  // ---- Action factory helpers ----------------------------------------

  function action_softDelete(singular, resource, opts = {}) {
    const apiAction = opts.action || "delete";
    const label = opts.label || "Delete";
    return {
      id: apiAction,
      label,
      destructive: true,
      requireTypedConfirm: (n) => n > 5,
      confirmTitle: (n) => "Delete " + n + " " + (n === 1 ? singular : pluralize(singular)) + "?",
      confirmBody: "These records will be moved to Trash and permanently deleted after 30 days. You can restore them from Trash anytime before then.",
      confirmLabel: "Delete",
      run: (ids) => window.pjlBulkSelection.callBulk(resource, apiAction, ids),
      undo: (ids) => window.pjlBulkSelection.callBulk(resource, "restore", ids)
    };
  }

  function action_archive(singular, resource) {
    return {
      id: "archive",
      label: "Archive",
      confirmTitle: (n) => "Archive " + n + " " + (n === 1 ? singular : pluralize(singular)) + "?",
      confirmBody: "Archived records stay in the system but are hidden from the active list. You can find them under /admin/trash → archived view.",
      confirmLabel: "Archive",
      run: (ids) => window.pjlBulkSelection.callBulk(resource, "archive", ids),
      undo: (ids) => window.pjlBulkSelection.callBulk(resource, "unarchive", ids)
    };
  }

  function action_archiveSupplier() {
    return {
      id: "archive",
      label: "Archive",
      confirmTitle: (n) => "Archive " + n + " " + (n === 1 ? "supplier" : "suppliers") + "?",
      confirmBody: "Suppliers cannot be deleted — they're referenced by the parts catalog. Archived suppliers stay in the system but hidden from the default list.",
      confirmLabel: "Archive",
      run: (ids) => window.pjlBulkSelection.callBulk("suppliers", "archive", ids),
      undo: (ids) => window.pjlBulkSelection.callBulk("suppliers", "unarchive", ids)
    };
  }

  function action_changeStatus(resource, options) {
    return {
      id: "change-status",
      label: "Change status…",
      // No confirm modal — we ask which status, then fire. Implemented via
      // a custom run function that pops a small status-picker before
      // calling the server.
      run: async (ids) => {
        const newStatus = await pickStatus(options);
        if (!newStatus) return { succeededIds: ids, failedIds: [], message: "Cancelled." };
        return window.pjlBulkSelection.callBulk(resource, "change-status", ids, { newStatus });
      }
    };
  }

  function action_resend(singular, resource) {
    return {
      id: "resend",
      label: "Resend",
      confirmTitle: (n) => "Resend " + n + " " + (n === 1 ? singular : pluralize(singular)) + "?",
      confirmBody: "Marks each record as re-sent in the audit trail. To actually re-fire emails per record, open each one and use the per-record Resend button.",
      confirmLabel: "Resend",
      run: (ids) => window.pjlBulkSelection.callBulk(resource, "resend", ids)
    };
  }

  function action_expire() {
    return {
      id: "expire",
      label: "Expire",
      confirmTitle: (n) => "Expire " + n + " " + (n === 1 ? "quote" : "quotes") + "?",
      confirmBody: "Sent quotes will be marked expired. Only sent quotes are eligible — others will fail in the per-record check.",
      confirmLabel: "Expire",
      run: (ids) => window.pjlBulkSelection.callBulk("quotes", "expire", ids)
    };
  }

  function pluralize(singular) {
    if (singular === "property") return "properties";
    return singular + "s";
  }

  // Inline status picker — built ad-hoc rather than via the modal so the
  // user picks a value in one step. Returns the selected value or null
  // on cancel.
  function pickStatus(options) {
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      const backdrop = document.createElement("div");
      backdrop.className = "pjl-bulk-modal-backdrop";
      const panel = document.createElement("div");
      panel.className = "pjl-bulk-modal-panel";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");

      const title = document.createElement("h2");
      title.className = "pjl-bulk-modal-title";
      title.textContent = "Pick a status";
      panel.appendChild(title);

      const list = document.createElement("div");
      list.style.display = "flex";
      list.style.flexDirection = "column";
      list.style.gap = "8px";
      list.style.margin = "0 0 18px";

      options.forEach((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pjl-bulk-modal-btn pjl-bulk-modal-btn-primary";
        btn.style.justifyContent = "flex-start";
        btn.style.textAlign = "left";
        btn.textContent = opt.label;
        btn.addEventListener("click", () => cleanup(opt.value));
        list.appendChild(btn);
      });
      panel.appendChild(list);

      const actions = document.createElement("div");
      actions.className = "pjl-bulk-modal-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "pjl-bulk-modal-btn pjl-bulk-modal-btn-secondary";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => cleanup(null));
      actions.appendChild(cancel);
      panel.appendChild(actions);

      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);

      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(null); });
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); cleanup(null); }
      }
      backdrop.addEventListener("keydown", onKey, true);

      function cleanup(result) {
        backdrop.removeEventListener("keydown", onKey, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (previouslyFocused && previouslyFocused.focus) {
          try { previouslyFocused.focus(); } catch {}
        }
        resolve(result);
      }
    });
  }

  // ---- Public API -----------------------------------------------------

  let handle = null;

  function attach(resource, { onActionComplete } = {}) {
    const config = RESOURCES[resource];
    if (!config) {
      console.warn("[pjlBulkWiring] unknown resource:", resource);
      return null;
    }
    if (!window.pjlBulkSelection) {
      console.warn("[pjlBulkWiring] bulk-selection.js not loaded");
      return null;
    }
    if (handle) {
      handle.refresh();
      return handle;
    }
    handle = window.pjlBulkSelection.init({
      resource,
      listSelector: config.listSelector,
      rowSelector: config.rowSelector,
      idAttribute: config.idAttribute,
      actions: config.actions(),
      onActionComplete: () => {
        if (typeof onActionComplete === "function") onActionComplete();
        // Always re-decorate after the page's refresh runs.
        setTimeout(() => { if (handle) handle.refresh(); }, 600);
      }
    });
    return handle;
  }

  function refresh() {
    if (handle) handle.refresh();
  }

  window.pjlBulkWiring = { attach, refresh };
})();
