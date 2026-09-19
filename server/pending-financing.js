const tableBody = document.getElementById("pfBody");
const tableEl = document.getElementById("pfTable");
const emptyEl = document.getElementById("pfEmpty");
const filterBtns = document.querySelectorAll("[data-stage-filter]");

let currentFilter = "";
let allRows = [];

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function fmt(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

const STAGE_LABELS = {
  link_sent: "Waiting on customer",
  authorized: "Authorized",
  declined: "Declined",
  partially_captured: "Partially captured"
};

// PJL-35: financing can now authorize BEFORE a signature exists, so
// "Authorized" alone can no longer be read as "clear to schedule" — the
// row's own `signed` field (server-computed via quotes.isAccepted, the
// one shared rule) says which one it actually is.
function stageLabel(row) {
  if (row.stage === "authorized") {
    return row.signed ? "Authorized — clear to schedule" : "Authorized — awaiting signature";
  }
  return STAGE_LABELS[row.stage] || String(row.stage || "");
}

// Deadline column: only authorized/partially_captured rows carry a
// captureBy clock. Colour escalates the closer it gets, matching the
// urgency the reminder sweep uses for its own thresholds (14/7/3/1 days).
function deadlineCell(row) {
  if (row.daysLeft == null) {
    if (row.stage === "link_sent") return `<span class="pf-deadline-note">no application yet</span>`;
    if (row.stage === "declined") return `<span class="pf-deadline-note">follow up another way</span>`;
    return `<span class="pf-deadline-note">—</span>`;
  }
  const days = row.daysLeft;
  if (days < 0) return `<span class="pf-deadline pf-deadline--expired">expired</span>`;
  const wholeDays = Math.floor(days);
  const label = wholeDays <= 0
    ? `${Math.max(1, Math.ceil(days * 24))}h left`
    : `${wholeDays} day${wholeDays === 1 ? "" : "s"} left`;
  const urgency = days <= 3 ? "urgent" : days <= 7 ? "soon" : "ok";
  return `<span class="pf-deadline pf-deadline--${urgency}">${label}</span>`;
}

function detailUrl(row) {
  return row.invoiceId
    ? `/admin/invoice/${encodeURIComponent(row.invoiceId)}`
    : `/admin/quote/${encodeURIComponent(row.id)}/proposal`;
}

function render() {
  const items = currentFilter ? allRows.filter((r) => r.stage === currentFilter) : allRows;
  if (!items.length) {
    tableEl.hidden = true;
    emptyEl.hidden = false;
    return;
  }
  emptyEl.hidden = true;
  tableEl.hidden = false;
  tableBody.innerHTML = items.map((row) => `
    <tr class="pf-row">
      <td><a href="${detailUrl(row)}">${escapeHtml(row.quoteNumberDisplay)}</a></td>
      <td>
        <strong>${escapeHtml(row.customerName || "—")}</strong>
        ${row.pairedWithDeposit ? `<br><span class="pf-row-sub">balance after deposit</span>` : ""}
      </td>
      <td class="pf-amount">${fmt(row.financedAmount?.total)}</td>
      <td><span class="pf-status pf-status--${escapeHtml(row.stage)}${row.stage === "authorized" && !row.signed ? " pf-status--unsigned" : ""}">${escapeHtml(stageLabel(row))}</span></td>
      <td>${deadlineCell(row)}</td>
    </tr>
  `).join("");
}

async function load() {
  const r = await fetch("/api/admin/financing/pending", { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  allRows = (data.ok && Array.isArray(data.quotes)) ? data.quotes : [];
  render();
}

filterBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentFilter = btn.dataset.stageFilter || "";
    filterBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
    render();
  });
});

load();
