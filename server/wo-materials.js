// Materials embed for the WO editor — Phase 2.
// Loads any material lists attached to this WO (parentType="work_order",
// parentId=<woId>), renders them as compact rows, and offers a "+ New
// material list" button that spawns one pre-attached and redirects to
// the builder.
//
// Standalone module; the host page (work-order.html) just needs to drop
// in <section id="woMaterialsSection"> with the inner markup that this
// script writes into and load this file. work-order.js doesn't need to
// know it exists.

(function () {
  if (window.__woMaterialsInit) return;
  window.__woMaterialsInit = true;

  const root = document.getElementById("woMaterialsSection");
  if (!root) return;

  const woIdMatch = location.pathname.match(/^\/admin\/work-order\/([^/]+)/);
  if (!woIdMatch) return;
  const woId = decodeURIComponent(woIdMatch[1]);

  const els = {
    list: document.getElementById("woMaterialsList"),
    empty: document.getElementById("woMaterialsEmpty"),
    addBtn: document.getElementById("woMaterialsAdd"),
    error: document.getElementById("woMaterialsError")
  };

  const STATUS_LABELS = {
    draft: "Draft",
    in_progress: "In progress",
    complete: "Complete",
    archived: "Archived"
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function fmtCents(c) { return "$" + ((Number(c) || 0) / 100).toFixed(2); }

  // Pull the WO's customer info from the existing DOM (work-order.js
  // populated #woCustomer, #woHero name, etc.) so a new ML inherits them
  // without us re-fetching the WO record. Fallbacks gracefully if the
  // host hasn't rendered yet.
  function readWoMeta() {
    const customerName = (document.getElementById("woCustomer")?.textContent || "").trim();
    return { customerName: customerName === "—" ? "" : customerName };
  }

  async function load() {
    try {
      els.error.hidden = true;
      const r = await fetch(`/api/material-lists?parentType=work_order&parentId=${encodeURIComponent(woId)}&withTotals=1&includeArchived=1`, { cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.error.hidden = false;
        els.error.textContent = (data.errors && data.errors[0]) || `Couldn't load material lists (${r.status})`;
        return;
      }
      render(data.lists || []);
    } catch (err) {
      els.error.hidden = false;
      els.error.textContent = err.message || "Couldn't load material lists.";
    }
  }

  function render(lists) {
    if (!lists.length) {
      els.empty.hidden = false;
      els.list.innerHTML = "";
      return;
    }
    els.empty.hidden = true;
    els.list.innerHTML = lists.map((rec) => {
      const totals = rec.totals || {};
      const status = STATUS_LABELS[rec.status] || rec.status;
      const needPart = totals.needCount ? `<span style="color:#7A5500"> · ${totals.needCount} need</span>` : "";
      const havePart = totals.haveCount ? `<span style="color:#1B4D2E"> · ${totals.haveCount} have</span>` : "";
      return `
        <li>
          <a class="proj-row" href="/admin/material-list/${encodeURIComponent(rec.id)}">
            <div class="proj-row-info">
              <div class="proj-row-title">${escapeHtml(rec.name || "(untitled list)")}</div>
              <div class="proj-row-meta">
                <span class="proj-row-id">${escapeHtml(rec.id)}</span>
                <span class="ml-status ml-status--${escapeHtml(rec.status)}">${escapeHtml(status)}</span>
                <span>${totals.lineCount || 0} lines${needPart}${havePart}</span>
              </div>
            </div>
            <div class="proj-row-end">
              <span style="font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:700;color:#1B4D2E">${fmtCents(totals.grandSubtotalCents)}</span>
            </div>
          </a>
        </li>
      `;
    }).join("");
  }

  async function createNew() {
    const meta = readWoMeta();
    els.addBtn.disabled = true;
    try {
      const r = await fetch("/api/material-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `WO ${woId} materials`,
          parentType: "work_order",
          parentId: woId,
          customerName: meta.customerName
        })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) {
        els.error.hidden = false;
        els.error.textContent = (data.errors && data.errors[0]) || `Couldn't create list (${r.status})`;
        els.addBtn.disabled = false;
        return;
      }
      // Drop straight into the builder so the user can start adding items.
      location.href = `/admin/material-list/${encodeURIComponent(data.list.id)}`;
    } catch (err) {
      els.error.hidden = false;
      els.error.textContent = err.message || "Couldn't create material list.";
      els.addBtn.disabled = false;
    }
  }

  els.addBtn.addEventListener("click", createNew);
  load();
})();
