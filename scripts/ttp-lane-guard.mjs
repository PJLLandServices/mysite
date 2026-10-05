#!/usr/bin/env node
// scripts/ttp-lane-guard.mjs — may this Tap to Pay lane commit go to the phone?
//
//   node scripts/ttp-lane-guard.mjs --lane <checkout> --sha <lane commit>
//        [--config config/ttp-lane.json] [--after-stamp]
//        [--json <out.json>] [--summary <out.md>]
//
// Run by .github/workflows/field-app-ttp-lane.yml before anything is
// published, and again after the commit is stamped into the bundle. It
// changes nothing: every check reads the checkout, and the one check that
// needs a modified tree works on a throwaway copy.
//
// THE PHONE. Patrick's working phone runs a Tap to Pay app he hand-built on
// his Mac from 0c638a8 (config installedBuild). It reports runtime 41661c6f…
// and takes only updates published to exactly that runtime. The same tree
// fingerprints as a7df9c32… on a Linux runner, so the lane commits the
// phone's runtime as a literal (docs/TTP_RUNTIME_PIN.md). A literal switches
// off the fingerprint's own protection, so this proves native compatibility
// WITHOUT trusting it:
//
//   G0  the tree is exactly the commit asked for, clean, and descends from
//       the installed build (after the stamp: that commit plus the stamp of
//       src/buildInfo.json, nothing else);
//   G1  every native-relevant file equals the installed build's. The single
//       allowed difference is app.json's expo.runtimeVersion, from the
//       fingerprint policy to exactly the pinned literal;
//   G2  with that one field put back, in a throwaway copy, the fingerprint
//       equals the installed build's (a7df9c32…), so the native code is the
//       code the phone runs;
//   G3  the tree itself, the one that will be published, fingerprints as the
//       recorded pinned tree (ebf53e38…), and everything that fingerprint
//       reads is a file G1 compares;
//   G4  the runtime that tree resolves to is exactly the phone's.
//
// Every check runs and reports, pass or fail, so a red run says everything
// that is wrong at once. Exit 0 only when all pass.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HEX40 = /^[0-9a-f]{40}$/;

// ---- the real tools (replaced in tests) ------------------------------------

function git(repo, args, { allowFail = false, raw = false } = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")}: ${(r.stderr || "").trim()}`);
  return { status: r.status, out: raw ? (r.stdout || "") : (r.stdout || "").trim() };
}

// The project's OWN expo-updates computes both numbers, the same code
// `eas update` delegates to — not a reimplementation of it.
function expoUpdates(dir, args) {
  const out = execFileSync("npx", ["--no-install", "expo-updates", ...args], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

export const realTools = {
  git,
  fingerprint(dir, platform) {
    const j = expoUpdates(dir, ["fingerprint:generate", "--platform", platform]);
    return { hash: j.hash, sources: j.sources || [] };
  },
  runtime(dir, platform) {
    return expoUpdates(dir, ["runtimeversion:resolve", "--platform", platform]).runtimeVersion;
  },
  copyDir(from, to) {
    // `cp -a` keeps node_modules' symlinks as symlinks, as the original has them.
    execFileSync("cp", ["-a", `${from}/.`, to]);
  },
};

// ---- pure rules (unit-tested in scripts/test-ttp-lane-workflow.mjs) --------

const STAMP_FILE = (cfg) => `${cfg.appDir}/src/buildInfo.json`;

export function isNativePath(rel, cfg) {
  const n = cfg.nativeFiles;
  return n.files.includes(rel) || n.dirs.some((d) => rel.startsWith(d));
}

// app.json may differ from the installed build's in expo.runtimeVersion only:
// policy there, the exact pinned literal here, every other byte the same.
// Returns { ok, detail, normalized } — normalized is the lane's app.json with
// that one field put back, the file G2 fingerprints.
export function compareAppJson(baseText, laneText, cfg) {
  let base, lane;
  try { base = JSON.parse(baseText); lane = JSON.parse(laneText); }
  catch (e) { return { ok: false, detail: `app.json does not parse: ${e.message}` }; }
  const want = cfg.installedBuild.runtimeVersionField;
  const pin = cfg.pin.runtimeVersion;
  const problems = [];
  if (!isDeepStrictEqual(base?.expo?.runtimeVersion, want)) {
    problems.push(`the installed build's runtimeVersion is ${JSON.stringify(base?.expo?.runtimeVersion)}, not ${JSON.stringify(want)}`);
  }
  if (lane?.expo?.runtimeVersion !== pin) {
    problems.push(`the lane's runtimeVersion is ${JSON.stringify(lane?.expo?.runtimeVersion)}, not the pinned ${JSON.stringify(pin)}`);
  }
  const strip = (j) => { const c = structuredClone(j); if (c?.expo) delete c.expo.runtimeVersion; return c; };
  if (!isDeepStrictEqual(strip(base), strip(lane))) {
    problems.push(`app.json differs from the installed build's beyond expo.runtimeVersion: ${diffKeys(strip(base), strip(lane)).slice(0, 8).join(", ")}`);
  }
  const normalizedObj = structuredClone(lane);
  if (normalizedObj?.expo) normalizedObj.expo.runtimeVersion = structuredClone(base?.expo?.runtimeVersion);
  const normalized = JSON.stringify(normalizedObj, null, 2) + "\n";
  if (!problems.length && normalized !== baseText) {
    problems.push("app.json with runtimeVersion put back is not byte-identical to the installed build's (formatting or key order changed)");
  }
  // And byte for byte the other way: the lane's file is the installed build's
  // with that one value replaced — no reformatting rides along with the pin.
  const pinnedObj = structuredClone(base);
  if (pinnedObj?.expo) pinnedObj.expo.runtimeVersion = pin;
  if (!problems.length && laneText !== JSON.stringify(pinnedObj, null, 2) + "\n") {
    problems.push("the lane's app.json is not the installed build's with only the runtimeVersion value replaced (formatting changed)");
  }
  return problems.length
    ? { ok: false, detail: problems.join("; ") }
    : { ok: true, detail: `only expo.runtimeVersion differs: ${JSON.stringify(want)} → ${JSON.stringify(pin)}`, normalized };
}

function diffKeys(a, b, at = "") {
  if (isDeepStrictEqual(a, b)) return [];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.flatMap((k) => diffKeys(a[k], b[k], at ? `${at}.${k}` : k));
  }
  return [at || "(root)"];
}

// G1 over two `git ls-tree` maps (path → blob). Returns { ok, detail, appJson }.
export function compareNativeTrees(baseTree, laneTree, cfg, readBlob) {
  const pre = `${cfg.appDir}/`;
  const native = (tree) => new Map([...tree].filter(([p]) => p.startsWith(pre) && isNativePath(p.slice(pre.length), cfg)));
  const b = native(baseTree), l = native(laneTree);
  const appPath = `${pre}app.json`;
  const problems = [];
  for (const p of new Set([...b.keys(), ...l.keys()])) {
    if (p === appPath) continue;
    if (!b.has(p)) problems.push(`added: ${p}`);
    else if (!l.has(p)) problems.push(`removed: ${p}`);
    else if (b.get(p) !== l.get(p)) problems.push(`changed: ${p}`);
  }
  let appJson = null;
  if (!b.has(appPath) || !l.has(appPath)) problems.push(`app.json missing (${b.has(appPath) ? "lane" : "installed build"})`);
  else {
    appJson = compareAppJson(readBlob(b.get(appPath)), readBlob(l.get(appPath)), cfg);
    if (!appJson.ok) problems.push(appJson.detail);
  }
  return problems.length
    ? { ok: false, detail: problems.join("; "), appJson }
    : { ok: true, detail: `${l.size} native-relevant files equal the installed build's; ${appJson.detail}`, appJson };
}

// Everything the fingerprint reads must be something G1 compares; otherwise
// a native input could change without G1 noticing. node_modules is covered
// through package-lock.json (npm ci installs it exactly).
export function fingerprintCoverage(sources, cfg) {
  const uncovered = [];
  for (const s of sources || []) {
    if (s.type === "contents") {
      if (!cfg.nativeFiles.contentsSources[s.id || s.contentsId]) uncovered.push(`contents:${s.id || s.contentsId}`);
      continue;
    }
    const p = String(s.filePath || "");
    if (p === "node_modules" || p.startsWith("node_modules/")) continue;
    const rel = s.type === "dir" && !p.endsWith("/") ? `${p}/` : p;
    if (!isNativePath(rel, cfg)) uncovered.push(`${s.type}:${p}`);
  }
  return uncovered;
}

// ---- the guard ---------------------------------------------------------------

export function runGuard({ lane, sha, cfg, afterStamp = false, tools = realTools }) {
  const results = [];
  const add = (id, name, ok, detail) => { results.push({ id, name, pass: Boolean(ok), detail }); };
  const appAbs = path.join(lane, cfg.appDir);
  const base = cfg.installedBuild.commit;
  const platform = cfg.platform;

  // Config self-consistency: the pin IS the phone's runtime.
  if (cfg.pin.runtimeVersion !== cfg.installedBuild.runtime || !HEX40.test(cfg.pin.runtimeVersion)) {
    add("C", "config", false, `pin.runtimeVersion ${cfg.pin.runtimeVersion} is not the installed build's runtime ${cfg.installedBuild.runtime}`);
  }

  // G0 — the tree is what was asked for.
  const g0 = [];
  const g = (args, o) => tools.git(lane, args, o);
  if (!HEX40.test(sha || "")) g0.push(`not a full commit sha: ${JSON.stringify(sha)}`);
  else {
    const head = g(["rev-parse", "HEAD"], { allowFail: true }).out;
    if (!afterStamp && head !== sha) g0.push(`checkout is at ${head}, not ${sha}`);
    if (afterStamp) {
      const parent = g(["rev-parse", "HEAD^"], { allowFail: true }).out;
      if (parent !== sha) g0.push(`stamp commit's parent is ${parent}, not ${sha}`);
      const changed = g(["diff", "--name-only", sha, "HEAD"], { allowFail: true }).out.split("\n").filter(Boolean);
      if (changed.length !== 1 || changed[0] !== STAMP_FILE(cfg)) g0.push(`the stamp changed ${JSON.stringify(changed)}, not only ${STAMP_FILE(cfg)}`);
    }
    if (g(["merge-base", "--is-ancestor", base, sha], { allowFail: true }).status !== 0) g0.push(`${sha.slice(0, 12)} does not descend from the installed build ${base.slice(0, 12)}`);
  }
  const dirty = g(["status", "--porcelain", "--untracked-files=all"], { allowFail: true }).out;
  if (dirty) g0.push(`working tree is not clean: ${dirty.split("\n").slice(0, 5).join(" | ")}`);
  for (const d of ["ios", "android"]) if (fs.existsSync(path.join(appAbs, d))) g0.push(`${cfg.appDir}/${d}/ exists in the checkout (generated native code is not part of the lane)`);
  add("G0", "tree is the commit asked for, clean, descended from the installed build", !g0.length,
    g0.length ? g0.join("; ") : `${afterStamp ? "stamped " : ""}${String(sha).slice(0, 12)}, clean, descends from ${base.slice(0, 12)}`);

  // G1 — native-relevant files, from git objects (the clean tree IS them).
  let normalized = null;
  try {
    const lsTree = (rev) => new Map(g(["ls-tree", "-r", "--full-tree", rev, "--", cfg.appDir]).out.split("\n").filter(Boolean)
      .map((line) => { const [meta, p] = line.split("\t"); return [p, meta.split(" ")[2]]; }));
    const r = compareNativeTrees(lsTree(base), lsTree(sha), cfg, (blob) => g(["cat-file", "blob", blob], { raw: true }).out);
    normalized = r.appJson?.normalized || null;
    add("G1", "native-relevant files equal the installed build's, except expo.runtimeVersion", r.ok, r.detail);
  } catch (e) { add("G1", "native-relevant files equal the installed build's, except expo.runtimeVersion", false, e.message); }

  // G2 — native compatibility without the pin: a throwaway copy with the one
  // field put back must fingerprint as the installed build.
  if (normalized) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttp-lane-normalized-"));
    try {
      tools.copyDir(appAbs, tmp);
      fs.writeFileSync(path.join(tmp, "app.json"), normalized);
      const fp = tools.fingerprint(tmp, platform).hash;
      add("G2", "with runtimeVersion put back, the fingerprint is the installed build's", fp === cfg.installedBuild.nativeFingerprint,
        `normalized fingerprint ${fp}; installed build ${cfg.installedBuild.nativeFingerprint}`);
    } catch (e) { add("G2", "with runtimeVersion put back, the fingerprint is the installed build's", false, e.message); }
    finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  } else add("G2", "with runtimeVersion put back, the fingerprint is the installed build's", false, "not run: G1 found more than the runtimeVersion field changed");

  // G3 — the tree that will be published.
  try {
    const fp = tools.fingerprint(appAbs, platform);
    const uncovered = fingerprintCoverage(fp.sources, cfg);
    add("G3", "the published tree's fingerprint is the recorded pinned tree's", fp.hash === cfg.pin.pinnedTreeFingerprint && !uncovered.length,
      `fingerprint ${fp.hash}; recorded ${cfg.pin.pinnedTreeFingerprint}${uncovered.length ? `; read but not compared by G1: ${uncovered.join(", ")}` : ""}`);
  } catch (e) { add("G3", "the published tree's fingerprint is the recorded pinned tree's", false, e.message); }

  // G4 — the runtime an update from this tree goes to.
  try {
    const rt = tools.runtime(appAbs, platform);
    add("G4", "the runtime this tree resolves to is the phone's", rt === cfg.installedBuild.runtime && rt === cfg.pin.runtimeVersion,
      `resolves to ${rt}; phone ${cfg.installedBuild.runtime}`);
  } catch (e) { add("G4", "the runtime this tree resolves to is the phone's", false, e.message); }

  // Reading the tree must not have changed it.
  const after = g(["status", "--porcelain", "--untracked-files=all"], { allowFail: true }).out;
  if (after !== dirty) add("G0", "the checks left the tree untouched", false, `tree changed while checking: ${after.split("\n").slice(0, 5).join(" | ")}`);

  return { ok: results.every((r) => r.pass), afterStamp, sha, results };
}

export function summaryMarkdown(report, cfg) {
  const rows = report.results.map((r) => `| ${r.pass ? "✅" : "❌"} | ${r.id} | ${r.name} | ${String(r.detail).replace(/\|/g, "\\|")} |`);
  return [
    `### Tap to Pay lane guard${report.afterStamp ? " (after stamp)" : ""}: ${report.ok ? "PASS" : "FAIL — nothing may be published"}`,
    "",
    `Lane commit \`${report.sha}\` · installed build \`${cfg.installedBuild.commit.slice(0, 12)}\` · phone runtime \`${cfg.installedBuild.runtime}\``,
    "",
    "| | | Check | Result |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

// ---- CLI ---------------------------------------------------------------------

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--after-stamp") o.afterStamp = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = args(process.argv.slice(2));
  if (!o.lane || !o.sha) {
    console.error("usage: ttp-lane-guard.mjs --lane <checkout> --sha <lane commit> [--config <json>] [--after-stamp] [--json <out>] [--summary <out.md>]");
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(o.config || path.join(ROOT, "config", "ttp-lane.json"), "utf8"));
  const report = runGuard({ lane: path.resolve(o.lane), sha: o.sha, cfg, afterStamp: Boolean(o.afterStamp) });
  for (const r of report.results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}  ${r.name}\n      ${r.detail}`);
  console.log(report.ok ? "\nGUARD PASS" : "\nGUARD FAIL — nothing may be published from this tree");
  if (o.json) fs.writeFileSync(o.json, JSON.stringify(report, null, 2) + "\n");
  if (o.summary) fs.appendFileSync(o.summary, summaryMarkdown(report, cfg));
  process.exit(report.ok ? 0 : 1);
}
