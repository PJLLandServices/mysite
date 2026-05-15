// /admin/trash — soft-deleted records across the CRM with bulk restore +
// permanent purge. One page covers every soft-delete-aware resource via a
// tab strip; the tab data is loaded lazily on switch.
//
// Action flow:
//   - Restore   → /api/admin/bulk/<resource> action: restore
//   - Permanently delete → /api/admin/bulk/<resource> action: purge
//
// Each tab reuses pjlBulkSelection so the selection/toolbar UX is
// identical to the per-resource list pages.

(function () {
  // Resources eligible for soft-delete (per brief §3.1). Suppliers
  // archive but don't soft-delete; invoices have no delete at all.
  const RESOURCES = [
    { key: "leads",            label: "Leads" },
    { key: "properties",       label: "Properties" },
    { key: "work-orders",      label: "Work orders" },
    { key: "quotes",           label: "Quotes" },
    { key: "material-lists",   label: "Material lists" },
    { key: "purchase-orders",  label: "Purchase orders" }
  ];

  const tabsEl = document.getElementById("trashTabs");
  const listEl = document.getElementById("trashList");
  const emptyEl = document.getElementById("trashEmpty");

  let currentResource = RESOURCES[0].key;
  const countsByResource = {};
  let bulkHandle = null;

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric" });
    } catch { return iso; }
  }

  function renderTabs() {
    tabsEl.innerHTML = RESOURCES.map((res) => {
      const isActive = res.key === currentResource;
      const count = countsByResource[res.key];
      const countLabel = typeof count === "number" ? count : "·";
      return `
        <button type="button" class="pjl-trash-tab${isActive ? " is-active" : ""}" data-resource="${res.key}" role="tab" aria-selected="${isActive ? "true" : "false"}">
          ${escapeHtml(res.label)}
          <span class="pjl-trash-tab-count">${escapeHtml(String(countLabel))}</span>
        </button>
      `;
    }).join("");
  }

  // Resource-specific row rendering. The brief sets no canonical row
  // template; per-resource we surface the fields most useful for "is
  // this the right record to restore?" — usually a name + secondary
  // identifier + deletedAt timestamp.
  function rowFor(resource, rec) {
    let title, sub;
    switch (resource) {
      case "leads":
        title = (rec.contact && (rec.contact.name || rec.contact.email)) || rec.id;
        sub = (rec.contact && (rec.contact.address || rec.contact.email)) || "—";
        break;
      case "properties":
        title = rec.customerName || rec.customerEmail || rec.id;
        sub = rec.address || rec.code || "—";
        break;
      case "work-orders":
        title = rec.customerName || rec.id;
        sub = `${rec.id} · ${rec.address || "—"}`;
        break;
      case "quotes":
        title = rec.id + (rec.version > 1 ? ` (v${rec.version})` : "");
        sub = `${rec.customerEmail || "—"} · $${Number(rec.total || 0).toFixed(2)}`;
        break;
      case "material-lists":
        title = rec.name || rec.id;
        sub = `${rec.id} · ${rec.customerName || rec.customerEmail || "—"}`;
        break;
      case "purchase-orders":
        title = `${rec.supplierName || "(no supplier)"}`;
        sub = `${rec.id} · ${(rec.lineItems || []).length} lines`;
        break;
      default:
        title = rec.id;
        sub = "";
    }
    const id = rec.id;
    const noun = (resource || "row").replace(/-/g, " ");
    return `
      <li class="pjl-trash-row" data-id="${escapeHtml(id)}">
        <label class="pjl-bulk-checkbox-wrap" aria-label="Select ${noun}">
          <input type="checkbox" class="pjl-bulk-checkbox" aria-label="Select ${noun}">
        </label>
        <div class="pjl-trash-row-meta">
          <span class="pjl-trash-row-title">${escapeHtml(title)}</span>
          <span class="pjl-trash-row-sub">${escapeHtml(sub)} · deleted ${escapeHtml(fmtDate(rec.deletedAt))}</span>
        </div>
      </li>
    `;
  }

  async function loadTab(resource) {
    listEl.innerHTML = "";
    emptyEl.hidden = true;
    if (bulkHandle) { bulkHandle.destroy(); bulkHandle = null; }

    try {
      const r = await fetch("/api/admin/trash/" + encodeURIComponent(resource), { credentials: "same-origin", cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        listEl.innerHTML = `<li class="pjl-trash-empty"><h3>Couldn't load Trash.</h3><p>${escapeHtml(data.error || ("Server error " + r.status))}</p></li>`;
        return;
      }
      const records = Array.isArray(data.records) ? data.records : [];
      countsByResource[resource] = records.length;
      renderTabs();
      bindTabClicks();

      if (!records.length) {
        emptyEl.hidden = false;
        return;
      }

      listEl.innerHTML = records.map((rec) => rowFor(resource, rec)).join("");

      // Wire pjlBulkSelection on this list so checkbox + range-select +
      // floating toolbar all work identically to the per-resource pages.
      bulkHandle = window.pjlBulkSelection.init({
        resource,
        listSelector: "#trashList",
        rowSelector: "li.pjl-trash-row",
        idAttribute: "data-id",
        actions: [
          {
            id: "restore",
            label: "Restore",
            confirmTitle: (n) => "Restore " + n + " record" + (n === 1 ? "" : "s") + "?",
            confirmBody: "Restoring puts these records back in the active list. The deletedAt timestamp is cleared.",
            confirmLabel: "Restore",
            run: (ids) => window.pjlBulkSelection.callBulk(resource, "restore", ids)
          },
          {
            id: "purge",
            label: "Permanently delete",
            destructive: true,
            requireTypedConfirm: (n) => n > 5,
            confirmTitle: (n) => "Permanently delete " + n + " record" + (n === 1 ? "" : "s") + "?",
            confirmBody: "This cannot be undone. Records will be hard-removed from the JSON store immediately.",
            confirmLabel: "Delete permanently",
            run: (ids) => window.pjlBulkSelection.callBulk(resource, "purge", ids)
          }
        ],
        onActionComplete: () => {
          // After restore or purge, re-fetch the trash list so the row
          // disappears. Each tab tracks its own count, which we refresh
          // here too so the badge updates immediately.
          setTimeout(() => loadTab(resource), 100);
        }
      });
    } catch (err) {
      listEl.innerHTML = `<li class="pjl-trash-empty"><h3>Couldn't load Trash.</h3><p>${escapeHtml((err && err.message) || "Network error")}</p></li>`;
    }
  }

  function bindTabClicks() {
    Array.from(tabsEl.querySelectorAll("[data-resource]")).forEach((btn) => {
      if (btn._bound) return;
      btn._bound = true;
      btn.addEventListener("click", () => {
        const next = btn.getAttribute("data-resource");
        if (!next || next === currentResource) return;
        currentResource = next;
        renderTabs();
        bindTabClicks();
        loadTab(currentResource);
      });
    });
  }

  // Logout — shared CRM pattern, hooks the sidebar Log out button.
  const logoutButton = document.getElementById("logoutButton");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      try {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      } catch {}
      location.href = "/login";
    });
  }

  renderTabs();
  bindTabClicks();
  loadTab(currentResource);
})();
