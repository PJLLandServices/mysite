// Preview server for the customer-migration dry-run report (Brief 1).
//
// Brief 1 ships no UI — the lib + script are backend infrastructure.
// This is a *preview* tool, separate from the eventual admin UI in
// Brief 3, that renders the latest migration-reports/customers-*.json
// as a readable HTML page so the dry-run output can be eyeballed.
//
// Usage:
//   node scripts/preview-migration-report.js
//   then open http://127.0.0.1:4174/
//
// The report is re-read on every request, so you can iterate:
// modify fixtures → re-run `npm run migrate:customers` → refresh.
//
// No persistent state. Ctrl+C to stop.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const REPORT_DIR = path.join(REPO_ROOT, "server", "data", "migration-reports");
const PORT = 4174;

function latestReport() {
  if (!fs.existsSync(REPORT_DIR)) return { missing: true };
  const files = fs.readdirSync(REPORT_DIR)
    .filter((f) => f.startsWith("customers-") && f.endsWith(".json"))
    .sort();
  if (!files.length) return { missing: true };
  const full = path.join(REPORT_DIR, files[files.length - 1]);
  try {
    return { report: JSON.parse(fs.readFileSync(full, "utf8")), filename: files[files.length - 1] };
  } catch (err) {
    return { error: err.message };
  }
}

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusBadge(status) {
  const colors = {
    active:   "#0c8a3e",
    lead:     "#1763b3",
    lost:     "#9b2b2b",
    inactive: "#666"
  };
  const bg = colors[status] || "#444";
  return `<span class="badge" style="background:${bg}">${esc(status)}</span>`;
}

function renderShell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(title)}</title>
  <style>
    :root {
      --bg: #f5f4f0;
      --panel: #fff;
      --text: #1a1a1a;
      --muted: #666;
      --border: #d4d2cb;
      --accent: #2d5016;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    header {
      background: var(--accent);
      color: #fff;
      padding: 20px 32px;
    }
    header h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: 0.5px; }
    header .sub { font-size: 13px; opacity: 0.85; margin-top: 4px; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px 32px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px 24px;
      margin-bottom: 24px;
    }
    .card h2 {
      margin: 0 0 16px 0;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--muted);
    }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .stat { padding: 14px; background: #fafaf7; border: 1px solid var(--border); border-radius: 4px; }
    .stat .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); }
    .stat .value { font-size: 28px; font-weight: 600; margin-top: 4px; color: var(--text); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    th { background: #fafaf7; font-weight: 600; color: var(--muted); text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; }
    tr:last-child td { border-bottom: none; }
    .badge {
      display: inline-block;
      padding: 2px 9px;
      border-radius: 12px;
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; }
    .muted { color: var(--muted); }
    .pill { display: inline-block; padding: 2px 8px; background: #eee; border-radius: 4px; font-size: 11px; }
    .conflict { background: #fef6e6; border: 1px solid #d6a800; padding: 12px 16px; border-radius: 4px; margin-bottom: 8px; }
    .orphan { background: #fff3f3; border: 1px solid #d6a0a0; padding: 12px 16px; border-radius: 4px; margin-bottom: 8px; }
    .empty { padding: 16px; color: var(--muted); text-align: center; font-style: italic; }
    details { margin-top: 12px; }
    summary { cursor: pointer; color: var(--muted); font-size: 12px; }
    .footer { color: var(--muted); font-size: 11px; text-align: center; padding: 24px 0; }
  </style>
</head>
<body>
  <header>
    <h1>PJL — Customer Migration Preview</h1>
    <div class="sub">Brief 1 dry-run output · ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC</div>
  </header>
  <main>
    ${body}
    <div class="footer">
      Preview tool — not the final admin UI (that's Brief 3). Refresh after re-running <span class="mono">npm run migrate:customers</span>.
    </div>
  </main>
</body>
</html>`;
}

function renderMissing(reason) {
  const body = `
    <div class="card">
      <h2>No report available</h2>
      <p class="empty">${esc(reason)}</p>
      <p>To generate a report, run:</p>
      <pre class="mono" style="background:#fafaf7;padding:12px;border:1px solid var(--border);border-radius:4px">npm run migrate:customers</pre>
    </div>
  `;
  return renderShell("Customer Migration — no report", body);
}

function renderReport(report, filename) {
  const { inputs, summary, customers, conflicts, orphanedProperties, leadToCustomer } = report;

  const inputsTable = `
    <table>
      <thead><tr><th>File</th><th>Records</th></tr></thead>
      <tbody>
        ${Object.entries(inputs).map(([k, v]) => `
          <tr><td class="mono">${esc(k)}</td><td>${esc(v)}</td></tr>
        `).join("")}
      </tbody>
    </table>
  `;

  const statsCards = `
    <div class="stats">
      <div class="stat"><div class="label">Total Customers</div><div class="value">${summary.totalCustomers}</div></div>
      <div class="stat"><div class="label">Active</div><div class="value">${summary.byStatus.active || 0}</div></div>
      <div class="stat"><div class="label">Lead</div><div class="value">${summary.byStatus.lead || 0}</div></div>
      <div class="stat"><div class="label">Lost</div><div class="value">${summary.byStatus.lost || 0}</div></div>
      <div class="stat"><div class="label">Inactive</div><div class="value">${summary.byStatus.inactive || 0}</div></div>
      <div class="stat"><div class="label">No Email</div><div class="value">${summary.withoutEmail}</div></div>
      <div class="stat"><div class="label">No Phone</div><div class="value">${summary.withoutPhone}</div></div>
      <div class="stat"><div class="label">Orphan Properties</div><div class="value">${summary.orphanedProperties}</div></div>
      <div class="stat"><div class="label">Conflicts</div><div class="value">${summary.conflicts}</div></div>
    </div>
  `;

  const customerRows = customers.length ? customers.map((c) => `
    <tr>
      <td class="mono">${esc(c.id)}</td>
      <td>
        <strong>${esc(c.name) || '<span class="muted">(no name)</span>'}</strong>
        ${c.spouseName ? `<div class="muted" style="font-size:11px">+ ${esc(c.spouseName)}</div>` : ""}
      </td>
      <td>${statusBadge(c.status)}</td>
      <td>${esc(c.email) || '<span class="muted">—</span>'}</td>
      <td class="mono">${esc(c.phone) || '<span class="muted">—</span>'}</td>
      <td class="mono">${esc(c.customerSince)}</td>
      <td><span class="pill">${esc(c.source)}</span></td>
      <td class="mono" style="text-align:right">${c._migration?.sourceLeadIds?.length || 0}</td>
      <td class="mono" style="text-align:right">${c._migration?.sourcePropertyIds?.length || 0}</td>
    </tr>
  `).join("") : "";

  const customersTable = customers.length ? `
    <table>
      <thead><tr>
        <th>ID</th><th>Name</th><th>Status</th><th>Email</th><th>Phone</th>
        <th>Since</th><th>Source</th><th style="text-align:right">Leads</th><th style="text-align:right">Properties</th>
      </tr></thead>
      <tbody>${customerRows}</tbody>
    </table>
  ` : `<p class="empty">No customers synthesized. Migration script saw no leads or properties.</p>`;

  const conflictsSection = conflicts.length ? `
    <div class="card">
      <h2>Conflicts flagged for review (${conflicts.length})</h2>
      ${conflicts.map((c) => `
        <div class="conflict">
          <strong>${esc(c.type)}</strong> — ${esc(c.customerId)}
          <div class="mono" style="margin-top:6px;font-size:12px">
            existing: ${esc(c.existing)} · spouse: ${esc(c.spouse || "—")} · additional: ${esc(c.additional)}
          </div>
          <div class="muted" style="font-size:11px;margin-top:4px">From lead ${esc(c.sourceLeadId)}</div>
        </div>
      `).join("")}
    </div>
  ` : "";

  const orphansSection = orphanedProperties.length ? `
    <div class="card">
      <h2>Orphaned properties (${orphanedProperties.length})</h2>
      <p class="muted" style="margin-top:0">Property records with customer info but no matching lead. Placeholder customer created (status: inactive).</p>
      ${orphanedProperties.map((o) => `
        <div class="orphan">
          <span class="mono"><strong>${esc(o.propertyCode || o.propertyId)}</strong></span>
          → ${esc(o.placeholderCustomerId)}
          <span class="muted" style="font-size:11px"> · ${esc(o.reason)}</span>
        </div>
      `).join("")}
    </div>
  ` : "";

  const leadMapEntries = Object.entries(leadToCustomer);
  const leadMapSection = leadMapEntries.length ? `
    <div class="card">
      <h2>leadId → customerId portal redirect map (${leadMapEntries.length})</h2>
      <p class="muted" style="margin-top:0;font-size:12px">Persisted as migration-leadId-map.json by Brief 2. Old <span class="mono">/portal/&lt;leadId&gt;</span> URLs redirect to <span class="mono">/portal/&lt;customerId&gt;</span>.</p>
      <details>
        <summary>Show map</summary>
        <table style="margin-top:12px">
          <thead><tr><th>Lead ID</th><th>→</th><th>Customer ID</th></tr></thead>
          <tbody>
            ${leadMapEntries.map(([k, v]) => `
              <tr><td class="mono">${esc(k)}</td><td class="muted">→</td><td class="mono">${esc(v)}</td></tr>
            `).join("")}
          </tbody>
        </table>
      </details>
    </div>
  ` : "";

  const body = `
    <div class="card">
      <h2>Summary</h2>
      ${statsCards}
      <div class="muted" style="font-size:11px;margin-top:14px">
        Report: <span class="mono">${esc(filename)}</span> · Generated ${esc(report.generatedAt)}
      </div>
    </div>

    <div class="card">
      <h2>Inputs</h2>
      ${inputsTable}
    </div>

    <div class="card">
      <h2>Synthesized customers (${customers.length})</h2>
      ${customersTable}
    </div>

    ${conflictsSection}
    ${orphansSection}
    ${leadMapSection}
  `;

  return renderShell("Customer Migration — dry-run preview", body);
}

const server = http.createServer((req, res) => {
  if (req.url !== "/" && req.url !== "/index.html") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found. Open /.");
    return;
  }
  const result = latestReport();
  let html;
  if (result.missing) {
    html = renderMissing("No migration report found in server/data/migration-reports/.");
  } else if (result.error) {
    html = renderMissing(`Failed to read report: ${result.error}`);
  } else {
    html = renderReport(result.report, result.filename);
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("============================================================");
  console.log(" PJL — Migration Report Preview");
  console.log("============================================================");
  console.log("");
  console.log(`   Open: http://127.0.0.1:${PORT}/`);
  console.log("");
  console.log("   The page re-reads the latest report on each request.");
  console.log("   To regenerate: npm run migrate:customers");
  console.log("   Ctrl+C to stop.");
  console.log("");
});
