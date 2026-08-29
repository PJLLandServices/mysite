// Warranty claim queue. Reads GET /api/warranty-claims once, then filters
// and sorts client-side — PJL's claim volume is small enough that a
// round trip per filter would be slower and less predictable than
// filtering an array we already have.
//
// The list defaults to OPEN claims only. A warranty queue is a worklist,
// not an archive; resolved and denied claims are one checkbox away but
// never the default view, because a queue that shows finished work stops
// reading as a to-do list.
(function () {
  var STATUS_LABELS = {
    received: "Received",
    under_review: "Under review",
    info_requested: "Info requested",
    contact_customer: "Contacting customer",
    service_booked: "Service call booked",
    resolved: "Resolved",
    denied: "Denied",
    disputed: "Disputed"
  };
  var CLOSED = { resolved: true, denied: true };

  var all = [];
  var summary = { open: 0, stale: 0 };
  var statusFilter = "";
  var showClosed = false;
  var search = "";

  var tableEl    = document.getElementById("wcqTable");
  var bodyEl     = document.getElementById("wcqBody");
  var emptyEl    = document.getElementById("wcqEmpty");
  var emptyText  = document.getElementById("wcqEmptyText");
  var statsEl    = document.getElementById("wcqStats");
  var reminderEl = document.getElementById("wcqReminder");
  var reminderList = document.getElementById("wcqReminderList");
  var reminderTitle = document.getElementById("wcqReminderTitle");

  function fmtDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
  }

  // "3h" / "2d 4h". Claims are chased in hours on day one and days after
  // that, so a single unit reads wrong at both ends.
  function fmtWait(hours) {
    if (hours == null) return "—";
    if (hours < 24) return hours + "h";
    var days = Math.floor(hours / 24);
    var rem = hours % 24;
    return days + "d" + (rem ? " " + rem + "h" : "");
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function claimHref(id) {
    return "/admin/warranty-claim/" + encodeURIComponent(id);
  }

  function matchesSearch(claim) {
    if (!search) return true;
    var haystack = [
      claim.id,
      claim.claimant && claim.claimant.name,
      claim.claimant && claim.claimant.email,
      claim.claimant && claim.claimant.phone,
      claim.invoiceRef
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.indexOf(search) !== -1;
  }

  function visibleClaims() {
    return all.filter(function (c) {
      if (!matchesSearch(c)) return false;
      if (statusFilter) return c.status === statusFilter;
      // No explicit status filter: honour the closed toggle.
      if (!showClosed && CLOSED[c.status]) return false;
      return true;
    });
  }

  function renderStats() {
    statsEl.textContent = "";
    var cards = [
      { label: "Outstanding", value: summary.open || 0, tone: (summary.open ? "warn" : "ok") },
      { label: "Needs an update", value: summary.stale || 0, tone: (summary.stale ? "bad" : "ok") },
      { label: "Total filed", value: all.length, tone: "neutral" }
    ];
    cards.forEach(function (card) {
      var box = el("div", "wcq-stat wcq-stat--" + card.tone);
      box.appendChild(el("strong", "wcq-stat-value", String(card.value)));
      box.appendChild(el("span", "wcq-stat-label", card.label));
      statsEl.appendChild(box);
    });
  }

  function renderReminder() {
    var stale = all.filter(function (c) { return c.stale; })
      .sort(function (a, b) { return Date.parse(a.lastStatusAt) - Date.parse(b.lastStatusAt); });
    if (!stale.length) {
      reminderEl.hidden = true;
      return;
    }
    reminderTitle.textContent = stale.length === 1
      ? "1 claim needs a status update"
      : stale.length + " claims need a status update";
    reminderList.textContent = "";
    stale.forEach(function (claim) {
      var li = el("li", "wcq-reminder-item");
      var a = document.createElement("a");
      a.href = claimHref(claim.id);
      a.className = "wcq-reminder-link";
      a.appendChild(el("strong", "wcq-reminder-number", claim.id));
      a.appendChild(el("span", "wcq-reminder-name",
        (claim.claimant && claim.claimant.name) || "—"));
      a.appendChild(el("span", "wcq-reminder-status",
        (STATUS_LABELS[claim.status] || claim.status) + " · waiting " + fmtWait(claim.hoursSinceStatus)));
      li.appendChild(a);
      reminderList.appendChild(li);
    });
    reminderEl.hidden = false;
  }

  function crossCheckCell(claim) {
    var link = claim.link || {};
    var wrap = el("div", "wcq-check");
    var conf = link.confidence || "none";
    wrap.appendChild(el("span", "wcq-conf wcq-conf--" + conf,
      conf === "strong" ? "Matched" : conf === "partial" ? "Partial" : "No match"));

    var w = link.warranty;
    if (w && w.active === true) {
      wrap.appendChild(el("span", "wcq-warranty wcq-warranty--in", "In warranty"));
    } else if (w && w.active === false) {
      wrap.appendChild(el("span", "wcq-warranty wcq-warranty--out", "Outside window"));
    } else {
      wrap.appendChild(el("span", "wcq-warranty wcq-warranty--unknown", "Warranty unknown"));
    }
    return wrap;
  }

  function renderTable() {
    var rows = visibleClaims();
    bodyEl.textContent = "";

    if (!rows.length) {
      tableEl.hidden = true;
      emptyText.textContent = all.length
        ? "No claims match this filter."
        : "No warranty claims yet. They arrive here the moment a customer files one.";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    tableEl.hidden = false;

    rows.forEach(function (claim) {
      var tr = el("tr", "wcq-row" + (claim.stale ? " is-stale" : ""));

      // Claim number — the link to the detail page.
      var tdId = el("td", "wcq-cell-id");
      var a = document.createElement("a");
      a.href = claimHref(claim.id);
      a.className = "wcq-id-link";
      a.textContent = claim.id;
      tdId.appendChild(a);
      tdId.appendChild(el("span", "wcq-filed", "Filed " + fmtDate(claim.createdAt)));
      if (claim.attachmentCount) {
        tdId.appendChild(el("span", "wcq-files",
          claim.attachmentCount + " file" + (claim.attachmentCount === 1 ? "" : "s")));
      }
      tr.appendChild(tdId);

      // Customer
      var tdWho = el("td", "wcq-cell-who");
      tdWho.appendChild(el("strong", null, (claim.claimant && claim.claimant.name) || "—"));
      tdWho.appendChild(el("span", "wcq-sub", (claim.claimant && claim.claimant.phone) || ""));
      tdWho.appendChild(el("span", "wcq-sub", (claim.claimant && claim.claimant.email) || ""));
      tr.appendChild(tdWho);

      // Invoice reference as the customer typed it
      var tdInv = el("td", "wcq-cell-inv");
      tdInv.appendChild(el("span", "wcq-invref", claim.invoiceRef || "—"));
      if (claim.link && claim.link.invoiceId) {
        tdInv.appendChild(el("span", "wcq-sub", "→ " + claim.link.invoiceId));
      }
      tr.appendChild(tdInv);

      // Cross-check
      var tdCheck = el("td", "wcq-cell-check");
      tdCheck.appendChild(crossCheckCell(claim));
      tr.appendChild(tdCheck);

      // Status
      var tdStatus = el("td", "wcq-cell-status");
      var badge = el("span", "wcq-badge", STATUS_LABELS[claim.status] || claim.status);
      badge.dataset.status = claim.status;
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      // Waiting
      var tdWait = el("td", "wcq-cell-wait");
      tdWait.appendChild(el("span", "wcq-wait" + (claim.stale ? " is-stale" : ""),
        fmtWait(claim.hoursSinceStatus)));
      tr.appendChild(tdWait);

      bodyEl.appendChild(tr);
    });
  }

  function renderAll() {
    renderStats();
    renderReminder();
    renderTable();
  }

  async function load() {
    try {
      var res = await fetch("/api/warranty-claims", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) { location.href = "/login"; return; }
      var data = await res.json();
      if (!data || !data.ok) throw new Error("Could not load warranty claims.");
      all = data.claims || [];
      summary = data.summary || { open: 0, stale: 0 };
      renderAll();
    } catch (err) {
      emptyText.textContent = "Couldn't load warranty claims. Reload the page, or check the server log.";
      emptyEl.hidden = false;
      tableEl.hidden = true;
    }
  }

  // ---- Controls -------------------------------------------------------
  var searchEl = document.getElementById("wcqSearch");
  if (searchEl) {
    searchEl.addEventListener("input", function () {
      search = searchEl.value.trim().toLowerCase();
      renderTable();
    });
  }

  var closedEl = document.getElementById("wcqShowClosed");
  if (closedEl) {
    closedEl.addEventListener("change", function () {
      showClosed = closedEl.checked;
      renderTable();
    });
  }

  var filtersEl = document.getElementById("wcqFilters");
  if (filtersEl) {
    filtersEl.addEventListener("click", function (event) {
      var btn = event.target.closest("[data-status-filter]");
      if (!btn) return;
      statusFilter = btn.getAttribute("data-status-filter") || "";
      filtersEl.querySelectorAll("[data-status-filter]").forEach(function (b) {
        b.classList.toggle("is-active", b === btn);
      });
      renderTable();
    });
  }

  load();
})();
