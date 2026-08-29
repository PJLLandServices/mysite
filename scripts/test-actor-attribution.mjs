// Actor attribution — the operator who made a change is named in the
// record's own history, instead of the literal string "admin".
//
//   node scripts/test-actor-attribution.mjs
//
// WHAT THIS COVERS. Seventeen write paths in server.js used to stamp a
// hardcoded `by: "admin"` into the record history they append. With one
// person on the CRM that is invisible; with two operators — a second tech,
// or an agent acting from the field — the records genuinely could not say
// who did a thing. They now stamp actorLabel(req).
//
// The safety property that makes a seventeen-site change reasonable is
// that actorLabel() cannot throw and falls back to the exact literal it
// replaced, so the worst case is the old behaviour. That is pinned here,
// along with the source guards that stop the literals creeping back.
//
// The VALUE is a display name, not a uid, because `by` is rendered
// straight to the screen (work-order.js: HISTORY_ACTOR_LABELS[raw] || raw,
// and eight `by ${h.by || "system"}` surfaces). The machine-stable
// attribution lives in the action log. Both halves are asserted.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const server = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");

// ---- 1. The literals are gone and cannot come back quietly -----------

{
  // Code lines only. The helper's own doc comment quotes the literal it
  // replaced, which is documentation, not a write path.
  const hardcoded = server.split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line))
    .filter(({ line }) => /\bby:\s*"admin"/.test(line));
  ok("no write path stamps a hardcoded by: \"admin\"",
    hardcoded.length === 0,
    hardcoded.map((h) => `line ${h.n}`).join(", "));

  // The same defect wearing a different hat.
  for (const variant of [/\bby:\s*'admin'/, /\bwaivedBy:\s*"admin"/, /\badminId:\s*"admin"/]) {
    ok(`no ${variant} literal`, !variant.test(server));
  }

  const wired = (server.match(/by: await actorLabel\(req\)/g) || []).length;
  ok("every replaced site calls actorLabel", wired === 17, String(wired));
}

// ---- 2. The helper's contract ----------------------------------------

{
  ok("actorLabel exists", /async function actorLabel\(req, fallback = "admin"\)/.test(server));

  const start = server.indexOf("async function actorLabel(");
  const body = server.slice(start, server.indexOf("\n}", start));

  // Cannot throw — the whole change rests on this.
  ok("actorLabel wraps its work in try/catch", /try\s*\{[\s\S]*\}\s*catch/.test(body));
  ok("actorLabel falls back rather than throwing", /catch \(_\) \{\s*return fallback;/.test(body));

  // No path can return undefined into a history entry: every exit either
  // returns the fallback outright, or returns a resolved name that is
  // itself `|| fallback`-guarded against an empty string.
  const returns = body.match(/return [^;]+;/g) || [];
  ok("there are no unguarded returns",
    returns.length > 0 && returns.every((r) => r.includes("fallback")), returns.join(" | "));
  ok("at least three early exits return the fallback outright",
    returns.filter((r) => /^return fallback;$/.test(r.trim())).length >= 3, returns.join(" | "));

  const resolved = returns.find((r) => r.includes("user.name"));
  ok("one return resolves an actual name", Boolean(resolved), returns.join(" | "));
  // A display name, not a uid — `by` is rendered directly to the screen.
  // Within that expression the preference order is name, then email, then
  // the uid only as a last resort.
  ok("resolution order is name → email → uid",
    resolved &&
    resolved.indexOf("user.name") < resolved.indexOf("user.email") &&
    resolved.indexOf("user.email") < resolved.indexOf("session.uid"),
    resolved);
  ok("an empty resolved name still degrades to the fallback",
    resolved && /\|\|\s*fallback/.test(resolved), resolved);

  // Same cap the receiving libs apply, so what is stamped is what is
  // stored (lib/quotes.js, lib/projects.js: String(by).slice(0, 80)).
  ok("caps at the 80 chars the libs store", body.includes("slice(0, 80)"));

  // It re-resolves from the request, so it works in the many routes that
  // never bound a `session` local of their own.
  ok("resolves the session from the request", body.includes("await requireUser(req)"));
}

// ---- 3. It is only used where a request actor exists ------------------

{
  // Genuinely automated cascades must keep saying "system" — attributing
  // a background deposit hook to whoever happened to trigger it would be
  // a lie, not an improvement.
  ok("system cascades still say system", /by: "system"/.test(server));

  // actorLabel must never be called outside a request handler — it takes
  // `req`, so a call without one would be a ReferenceError at runtime.
  const calls = server.match(/actorLabel\([^)]*\)/g) || [];
  const badCalls = calls.filter((c) => !/actorLabel\(req(,|\))/.test(c) && !c.includes("req, fallback"));
  ok("every call passes req", badCalls.length === 0, badCalls.join(", "));
}

// ---- 4. The rendering contract it depends on --------------------------

{
  const wo = fs.readFileSync(path.join(ROOT, "server/work-order.js"), "utf8");
  // A name that isn't in the label map must pass through unchanged. If
  // this ever became a strict lookup, every real name would render blank.
  ok("work-order history renders an unmapped actor verbatim",
    wo.includes("HISTORY_ACTOR_LABELS[actorRaw] || actorRaw"));

  const customer = fs.readFileSync(path.join(ROOT, "server/customer.js"), "utf8");
  ok("customer history renders the actor verbatim", customer.includes('by ${esc(h.by || "system")}'));
}

// ---- 5. The other half of the trail still exists ----------------------

{
  // A display name is not stable across a rename, which is fine ONLY
  // because the action log carries the uid for the same events. If that
  // ever goes away, this change needs revisiting.
  ok("the action log still records a uid",
    fs.readFileSync(path.join(ROOT, "server/lib/admin-actions.js"), "utf8").includes("uid: uid ? truncate(uid, 100) : null"));
  ok("the action log hook is still wired", server.includes("adminActions.record({"));
}

// ---- Result -----------------------------------------------------------

if (failures.length) {
  console.error(`\nactor-attribution: ${failures.length} FAILED, ${pass} passed\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("");
  process.exit(1);
}
console.log(`actor-attribution: ${pass} assertions passed`);
