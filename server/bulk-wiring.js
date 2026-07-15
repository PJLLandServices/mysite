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
      listSelector: "#quotesContainer",
      rowSelector: ".qf-card",
      idAttribute: "data-quote-id",
      actions: () => [
        action_buildCombination(),
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

  // Build a combined ("two projects, one property") proposal from exactly two
  // selected quotes. Prompts for the bundle terms, POSTs to the combined-build
  // endpoint, then opens the generated preview. Not a bulk op — validates the
  // count and merges the pair into one new proposal.
  function action_buildCombination() {
    return {
      id: "build-combination",
      label: "Build combination proposal",
      run: async (ids) => {
        if (ids.length !== 2) {
          throw new Error("Select exactly two quotes (e.g. sprinklers + lighting) to combine.");
        }
        const terms = await pickCombinationTerms();
        if (!terms) return { succeededIds: [], failedIds: ids, message: "Cancelled." };
        // Open the preview tab synchronously off the modal click so it isn't
        // popup-blocked; point it at the result once the build returns.
        const tab = window.open("about:blank", "_blank");
        let data;
        try {
          const r = await fetch("/api/quotes/combined", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ childIds: ids, ...terms })
          });
          data = await r.json().catch(() => ({}));
          if (!r.ok || !data.ok) {
            throw new Error((data.errors && data.errors[0]) || `Couldn't build the combined proposal (${r.status}).`);
          }
        } catch (err) {
          if (tab) { try { tab.close(); } catch {} }
          throw err;
        }
        if (tab) tab.location = data.previewUrl;
        else window.location.href = data.previewUrl;
        return { succeededIds: ids, failedIds: [], message: `Combined proposal ${data.combinedId} built — preview opened in a new tab.` };
      }
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

  // Combination-terms prompt — a small form modal for the bundle options.
  // Everything is optional with sensible defaults, so a plain bundle is one
  // click. Resolves to { bundleSaving, freeService, depositPercent,
  // validityDays, linkMode } or null on cancel.
  function pickCombinationTerms() {
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
      title.textContent = "Build combination proposal";
      panel.appendChild(title);

      const desc = document.createElement("p");
      desc.className = "pjl-bulk-modal-body";
      desc.textContent = "Merge the two selected quotes into one “both together” proposal. Everything below is optional — leave the defaults for a plain bundle.";
      panel.appendChild(desc);

      const form = document.createElement("div");
      form.style.display = "flex";
      form.style.flexDirection = "column";
      form.style.gap = "12px";
      form.style.margin = "4px 0 18px";

      function styleInput(el) {
        el.style.padding = "8px 10px";
        el.style.borderRadius = "8px";
        el.style.border = "1px solid rgba(128,141,155,.4)";
        el.style.background = "#fff";
        el.style.color = "#111";
        el.style.font = "inherit";
        el.style.width = "100%";
        el.style.boxSizing = "border-box";
      }
      function field(labelText, inputEl, hint) {
        const wrap = document.createElement("label");
        wrap.style.display = "flex";
        wrap.style.flexDirection = "column";
        wrap.style.gap = "4px";
        wrap.style.fontSize = "12px";
        wrap.style.fontWeight = "600";
        const span = document.createElement("span");
        span.textContent = labelText;
        wrap.appendChild(span);
        wrap.appendChild(inputEl);
        if (hint) {
          const h = document.createElement("span");
          h.textContent = hint;
          h.style.opacity = "0.6";
          h.style.fontSize = "11px";
          h.style.fontWeight = "400";
          wrap.appendChild(h);
        }
        return wrap;
      }

      const saving = document.createElement("input");
      saving.type = "number"; saving.min = "0"; saving.step = "50"; saving.placeholder = "0"; styleInput(saving);
      const free = document.createElement("input");
      free.type = "text"; free.maxLength = 80; free.placeholder = "e.g. Fall Closing 2026"; styleInput(free);
      const deposit = document.createElement("input");
      deposit.type = "number"; deposit.min = "0"; deposit.max = "100"; deposit.value = "25"; styleInput(deposit);
      const validity = document.createElement("input");
      validity.type = "number"; validity.min = "1"; validity.max = "365"; validity.value = "90"; styleInput(validity);
      const linkMode = document.createElement("select"); styleInput(linkMode);
      [["link", "Link to the standalone proposals"], ["embed", "Embed each quote’s PDF in the page"]]
        .forEach(([v, l]) => { const o = document.createElement("option"); o.value = v; o.textContent = l; linkMode.appendChild(o); });

      form.appendChild(field("Bundle saving ($ off the combined price)", saving, "Blank or 0 = no discount"));
      form.appendChild(field("Free service included (optional)", free, "Shown as a bonus, e.g. a free seasonal service"));
      form.appendChild(field("Deposit (%)", deposit));
      form.appendChild(field("Offer valid for (days)", validity));
      form.appendChild(field("Option buttons point to…", linkMode, "Link = the live standalone pages; Embed = a copy of each PDF baked in"));
      panel.appendChild(form);

      const actions = document.createElement("div");
      actions.className = "pjl-bulk-modal-actions";
      const cancel = document.createElement("button");
      cancel.type = "button"; cancel.className = "pjl-bulk-modal-btn pjl-bulk-modal-btn-secondary"; cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => cleanup(null));
      const build = document.createElement("button");
      build.type = "button"; build.className = "pjl-bulk-modal-btn pjl-bulk-modal-btn-primary"; build.textContent = "Build proposal";
      build.addEventListener("click", () => cleanup({
        bundleSaving: Number(saving.value) || 0,
        freeService: free.value.trim(),
        depositPercent: Number(deposit.value) || 25,
        validityDays: Number(validity.value) || 90,
        linkMode: linkMode.value === "embed" ? "embed" : "link"
      }));
      actions.appendChild(cancel);
      actions.appendChild(build);
      panel.appendChild(actions);

      backdrop.appendChild(panel);
      document.body.appendChild(backdrop);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(null); });
      function onKey(e) { if (e.key === "Escape") { e.preventDefault(); cleanup(null); } }
      backdrop.addEventListener("keydown", onKey, true);
      setTimeout(() => { try { saving.focus(); } catch {} }, 30);

      function cleanup(result) {
        backdrop.removeEventListener("keydown", onKey, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (previouslyFocused && previouslyFocused.focus) { try { previouslyFocused.focus(); } catch {} }
        resolve(result);
      }
    });
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
