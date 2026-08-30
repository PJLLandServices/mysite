// Merge one property into another — the CLI.
//
//   node scripts/merge-properties.mjs --keep P-2026-0056 --delete P-2026-0040
//   node scripts/merge-properties.mjs --keep P-2026-0056 --delete P-2026-0040 --apply
//
// All the logic lives in server/lib/property-merge.js, which the admin
// route POST /api/properties/:id/merge-into also calls. Same arrangement as
// backfill-booking-customers.js and territory-export.js: one
// implementation, two entry points, so a merge run from a shell and one run
// from the CRM cannot behave differently.
//
// This CLI is the escape hatch for whoever has a shell on the box. The
// route exists because on Render nobody does.
//
// Dry-run by default; nothing is written without --apply.

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { mergeProperties, DEFAULT_DATA_DIR } =
  require(path.join(ROOT, "server/lib/property-merge.js"));

function parseArgs(argv) {
  const args = { apply: false, allowDifferentCustomer: false, alignDraftInvoiceAddresses: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--allow-different-customer") args.allowDifferentCustomer = true;
    else if (a === "--align-draft-invoice-addresses") args.alignDraftInvoiceAddresses = true;
    else if (a === "--keep") args.keep = argv[++i];
    else if (a === "--delete") args.remove = argv[++i];
    else if (a === "--data") args.dataDir = argv[++i];
    else if (a === "--by") args.by = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
  }
  return args;
}

const USAGE = `
Merge one property into another, then delete the duplicate.

  node scripts/merge-properties.mjs --keep <code|id> --delete <code|id> [options]

  --keep <code|id>    The property that survives (e.g. P-2026-0056)
  --delete <code|id>  The duplicate, deleted once everything is re-pointed
  --apply             Actually write. Without it this is a dry run.
  --data <dir>        Data directory (default server/data)
  --by <name>         Who to record in the property history (default "admin")
  --allow-different-customer
                      Proceed even though the two properties sit on
                      different customers. Merge the CUSTOMERS first if you
                      can — this is an override, not a shortcut.
  --align-draft-invoice-addresses
                      Also rewrite the service address on any DRAFT invoice
                      that moves. Sent, paid and void invoices are never
                      touched: their address is the envelope they were
                      issued with.

Run it once with no --apply, read the plan, then run it again with --apply.
`.trim();

// The terminal renderer. The route returns the same `plan` object as JSON
// and lets the client present it, so this stays CLI-only.
function printPlan(result) {
  const { plan } = result;
  const out = [];
  out.push("");
  out.push(result.applied ? "MERGE APPLIED" : "DRY RUN — nothing written");
  out.push("");
  out.push(`  Keep    ${plan.keep.code || "(no code)"}  ${plan.keep.id}`);
  out.push(`          "${plan.keep.address || ""}"`);
  out.push(`  Delete  ${plan.dup.code || "(no code)"}  ${plan.dup.id}`);
  out.push(`          "${plan.dup.address || ""}"`);
  out.push("");

  if (!plan.repoints.length) {
    out.push("  Nothing links to the duplicate — it only needs deleting.");
  } else {
    out.push(`  Re-point ${plan.totalRepointed} reference(s) to the keeper:`);
    for (const r of plan.repoints) {
      out.push(`    ${r.file} (${r.count})`);
      for (const line of r.records) out.push(`      - ${line}`);
    }
  }
  out.push("");

  if (plan.leadSuggestionFix) {
    out.push(`  Drop the stale duplicate-suggestion on ${plan.leadSuggestionFix.leadIds.length} lead(s).`);
    out.push("");
  }

  if (plan.invoicesAfter.length) {
    out.push(`  Invoices on the surviving property afterwards (${plan.invoicesAfter.length}):`);
    for (const i of plan.invoicesAfter) {
      out.push(`    ${i.moving ? "→" : " "} ${i.id} — ${i.status} — $${i.total ?? "?"} — "${i.address}"`);
    }
    out.push("    Each keeps the address it was ISSUED with — that is the record of what");
    out.push("    the customer received, and it is not rewritten by the merge.");
    out.push("");
  }

  if (plan.reportOnly.length) {
    out.push("  Append-only records that mention the duplicate and are LEFT AS THEY ARE");
    out.push("  (they describe what already happened; rewriting them would falsify them):");
    for (const r of plan.reportOnly) {
      out.push(`    ${r.file} (${r.count})`);
      for (const line of r.records) out.push(`      - ${line}`);
    }
    out.push("");
  }

  if (plan.draftInvoiceAligns.length) {
    out.push("  Draft invoices whose service address will be re-written:");
    for (const a of plan.draftInvoiceAligns) {
      out.push(`    ${a.id}`);
      out.push(`      from "${a.from}"`);
      out.push(`      to   "${a.to}"`);
    }
    out.push("");
  }

  out.push(plan.changes.length ? "  Property record changes:" : "  Property record: keeper's fields already cover everything.");
  for (const c of plan.changes) out.push(`    - ${c}`);
  out.push("");

  if (plan.conflicts.length) {
    out.push("  NEEDS A LOOK AFTERWARDS:");
    for (const c of plan.conflicts) out.push(`    ! ${c}`);
    out.push("");
  }
  if (plan.notes.length) {
    out.push("  Notes:");
    for (const n of plan.notes) out.push(`    - ${n}`);
    out.push("");
  }
  return out.join("\n");
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(`\n${USAGE}`);
    process.exit(2);
  }
  if (args.help || !args.keep || !args.remove) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 2);
  }

  let result;
  try {
    result = mergeProperties({
      dataDir: args.dataDir ? path.resolve(args.dataDir) : DEFAULT_DATA_DIR,
      keep: args.keep,
      remove: args.remove,
      apply: args.apply,
      allowDifferentCustomer: args.allowDifferentCustomer,
      alignDraftInvoiceAddresses: args.alignDraftInvoiceAddresses,
      by: args.by || "admin"
    });
  } catch (err) {
    console.error(`\nMerge failed: ${err.message}\n`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error("\nRefused:\n");
    for (const p of result.problems) console.error(`  ! ${p}`);
    console.error("");
    process.exit(1);
  }

  console.log(printPlan(result));

  if (result.applied) {
    console.log("  Backup of every file touched, before the merge:");
    console.log(`    ${result.backupDir}`);
    console.log(`    (${result.backedUp.join(", ")})`);
    console.log("");
    console.log("  To undo, copy those files back over server/data/ and restart the service.");
    console.log("");
  } else {
    console.log("  Re-run with --apply to write it.");
    console.log("");
  }
}

main();
