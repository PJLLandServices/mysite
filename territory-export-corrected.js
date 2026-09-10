#!/usr/bin/env node
//
// Fall Closing Territory Export — CLI wrapper. Read-only, writes NOTHING.
//
// Emits a de-identified JSON blob on stdout for offline territory analysis:
// which municipalities hold how many fall-closing properties, how big their
// systems are, and how much fall history each one has.
//
// Usage:
//   node territory-export-corrected.js > territory-export.json
//   node territory-export-corrected.js --year 2026 > territory-export.json
//
// Run it on the instance where server/data/ lives (that directory is
// gitignored runtime data and is not in the repo).
//
// NO LOGIC LIVES HERE. Everything — the privacy rules and the three
// correctness guards that are the reason this version exists — is in
// server/lib/territory-export.js, which this script and the admin download
// route (GET /api/admin/territory-export) both call. Read that file's header
// for what the guards are and why. Changing the export means changing the
// module, so the CLI and the browser download can never disagree.
//
// If you have a browser and an admin login, you do not need this script:
// /admin/settings has a "Download territory export (JSON)" button that
// returns the same payload.
//

'use strict';

const { buildTerritoryExport, TerritoryExportError } = require('./server/lib/territory-export');

const yearFlagIdx = process.argv.indexOf('--year');
const year = yearFlagIdx !== -1 && Number.isFinite(Number(process.argv[yearFlagIdx + 1]))
  ? Number(process.argv[yearFlagIdx + 1])
  : undefined;

buildTerritoryExport({ year })
  .then((output) => {
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  })
  .catch((err) => {
    if (err instanceof TerritoryExportError) {
      console.error(`FATAL: ${err.message}`);
    } else {
      console.error(`FATAL: ${err?.stack || err}`);
    }
    process.exit(1);
  });
