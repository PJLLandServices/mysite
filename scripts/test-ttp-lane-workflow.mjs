#!/usr/bin/env node
// scripts/test-ttp-lane-workflow.mjs
//
// The Tap to Pay release lane (.github/workflows/field-app-ttp-lane.yml):
// one safe way to put the lane's code on Patrick's working phone, and back.
//
// WHAT IT REPLACES. The emergency lane (field-app-hotfix-taptopay.yml, on
// claude/eas-update-pjl-field-wgmjtt) published on every push and rewrote
// app.json's runtimeVersion inside the runner after checkout, so the tree it
// published was not the tree anyone reviewed. It worked, and it is still the
// fallback, but it is not a release process.
//
// WHAT THIS PINS:
//   1. nothing publishes unless a person dispatches it: no push, PR, schedule,
//      tag or workflow trigger, and the default is check-only;
//   2. least privilege: nothing at the top, the release job reads only, and
//      the one write (contents, for the record tag) is a separate job that
//      runs only after a real publish or rollback;
//   3. nothing in the workflow writes app.json; the guard runs before AND
//      after the stamp, and the publish comes after both;
//   4. the guard (scripts/ttp-lane-guard.mjs) on a real git fixture: it passes
//      only when the native files equal the installed build's except
//      expo.runtimeVersion, and fails on every other change it is meant to
//      catch;
//   5. the typed confirmations and the EAS result check;
//   6. no native build while a runtime is pinned (both build workflows), and
//      the Tap to Pay build checks out #305's branch, not the stale #151 one;
//   7. no OTHER workflow can publish when this lane's files merge to main.
//
// The guard's real-fingerprint runs (expo-updates on the actual lane tree)
// are recorded in docs/FLOW_REGISTER.md; here the fingerprint is a stand-in
// over the same files, so this runs in seconds.
//
// Run: node scripts/test-ttp-lane-workflow.mjs   (also in build:check)

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const YAML = createRequire(path.join(ROOT, "pjl-field", "package.json"))("yaml");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const j = (v) => JSON.stringify(v)?.slice(0, 300);

const cfg = JSON.parse(read("config/ttp-lane.json"));
const { runGuard, realTools, compareAppJson, fingerprintCoverage } = await import("./ttp-lane-guard.mjs");
const { checkInputs, publishPhrase, rollbackPhrase } = await import("./ttp-lane-inputs.mjs");
const { checkUpdates, buildRecord } = await import("./ttp-lane-result.mjs");

// ---- 1 + 2 + 3: the workflow's shape ------------------------------------------
const WF_TEXT = read(".github/workflows/field-app-ttp-lane.yml");
const wf = YAML.parse(WF_TEXT);
{
  const on = wf.on ?? wf[true];
  ok(on && Object.keys(on).length === 1 && "workflow_dispatch" in on, `1: the only trigger is workflow_dispatch (${j(Object.keys(on || {}))})`);
  const inputs = on?.workflow_dispatch?.inputs || {};
  ok(inputs.mode?.type === "choice" && inputs.mode?.default === "check-only" && j(inputs.mode?.options) === j(["check-only", "publish", "rollback"]),
    `1: mode is a choice that defaults to check-only (${j(inputs.mode)})`);
  ok(!/^\s*(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|workflow_call|release|create):/m.test(WF_TEXT.split("\npermissions:")[0]),
    "1: no other trigger anywhere in the `on:` block");

  ok(wf.permissions && typeof wf.permissions === "object" && Object.keys(wf.permissions).length === 0, `2: workflow-level permissions are empty (${j(wf.permissions)})`);
  const jobs = wf.jobs || {};
  ok(j(Object.keys(jobs)) === j(["release", "record"]), `2: two jobs, release and record (${j(Object.keys(jobs))})`);
  ok(j(jobs.release?.permissions) === j({ contents: "read" }), `2: release reads only (${j(jobs.release?.permissions)})`);
  ok(j(jobs.record?.permissions) === j({ contents: "write" }), `2: record holds the one write (${j(jobs.record?.permissions)})`);
  ok(/needs\.release\.result == 'success'/.test(jobs.record?.if || "") && /inputs\.mode == 'publish' \|\| inputs\.mode == 'rollback'/.test(jobs.record?.if || "") && !/check-only/.test(jobs.record?.if || ""),
    `2: record runs only after a successful publish or rollback (${jobs.record?.if})`);
  const recordRuns = (jobs.record?.steps || []).map((s) => s.run || "").join("\n");
  ok(!/eas-cli|EXPO_TOKEN/.test(j(jobs.record)) && /git push origin "refs\/tags\/\$TAG"/.test(recordRuns) && /field-ttp\/\*/.test(recordRuns),
    "2: record has no Expo token and pushes only a field-ttp/ tag");

  const steps = jobs.release?.steps || [];
  const idx = (re) => steps.findIndex((s) => re.test(s.name || s.uses || ""));
  const tokenSteps = steps.filter((s) => /EXPO_TOKEN/.test(j(s.env || {})));
  ok(tokenSteps.length > 0 && tokenSteps.every((s) => /inputs\.mode == '(publish|rollback)'/.test(s.if || "")),
    `2: the Expo token reaches only publish/rollback steps (${j(tokenSteps.map((s) => [s.name, s.if]))})`);
  ok(steps.filter((s) => (s.uses || "").startsWith("actions/checkout")).every((s) => s.with?.["persist-credentials"] === false),
    "2: release checkouts persist no credentials");
  ok(steps.every((s) => !/\$\{\{\s*(inputs|github\.event)/.test(s.run || "")), "2: no input is pasted into a script (all through env)");

  const allRuns = steps.map((s) => s.run || "").join("\n");
  ok(!/app\.json/.test(allRuns) && !/runtimeVersion/.test(allRuns), "3: no step touches app.json or runtimeVersion");
  const guard1 = idx(/^Guard — /), stamp = idx(/^Stamp the lane commit/), guard2 = idx(/^Guard again/), publish = idx(/^Publish to the phone/);
  ok(guard1 >= 0 && guard1 < stamp && stamp < guard2 && guard2 < publish, `3: guard → stamp → guard again → publish (${[guard1, stamp, guard2, publish]})`);
  ok(/--after-stamp/.test(steps[guard2]?.run || "") && !/--after-stamp/.test(steps[guard1]?.run || ""), "3: the second guard checks the stamped tree");
  const pub = steps[publish] || {};
  ok(/inputs\.mode == 'publish'/.test(pub.if || "") && /--platform ios/.test(pub.run || "") && /--json/.test(pub.run || "") && !/--platform all|android/.test(pub.run || ""),
    `3: publish is publish-mode only, iOS only, JSON result (${pub.if})`);
  ok(idx(/^Check the inputs/) === 1 && /ttp-lane-inputs\.mjs/.test(steps[1]?.run || ""), "3: the inputs are checked before anything else is done");
  const rb = steps[idx(/^Roll the phone back/)] || {};
  ok(/update:republish/.test(rb.run || "") && /--group "\$GROUP"/.test(rb.run || "") && /--platform ios/.test(rb.run || "") && idx(/^Check the group is the phone's runtime/) < idx(/^Roll the phone back/),
    "3: rollback republishes the named group, iOS only, after checking it on EAS");
  ok(/main\/scripts\/ttp-lane-guard\.mjs/.test(steps[guard1]?.run || "") && /main\/config\/ttp-lane\.json/.test(steps[guard1]?.run || ""),
    "3: the guard and the expectations come from main, never the lane's own copy");
}

// ---- 4: the guard on a real git fixture ------------------------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttp-guard-fixture-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(path.join(repo, "pjl-field", "plugins"), { recursive: true });
  fs.mkdirSync(path.join(repo, "pjl-field", "src"), { recursive: true });
  const gitc = (...a) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
  const w = (rel, text) => fs.writeFileSync(path.join(repo, rel), text);
  const appJson = (rt, extra = {}) => JSON.stringify({ expo: { name: "PJL Field", ios: { supportsTablet: true }, runtimeVersion: rt, ...extra } }, null, 2) + "\n";
  execFileSync("git", ["init", "-q", repo]);
  w("pjl-field/app.json", appJson({ policy: "fingerprint" }));
  w("pjl-field/package.json", '{ "dependencies": { "expo-location": "~19.0.8" } }\n');
  w("pjl-field/package-lock.json", '{ "lockfileVersion": 3 }\n');
  w("pjl-field/plugins/withX.js", "module.exports = (c) => c;\n");
  w("pjl-field/src/screen.js", "export default 1;\n");
  w("pjl-field/src/buildInfo.json", '{ "commit": null }\n');
  w(".gitignore", "node_modules/\n");
  gitc("add", "-A"); gitc("commit", "-q", "-m", "installed build");
  const BASE = gitc("rev-parse", "HEAD");

  // Stand-in fingerprint: a hash over the native files the fixture has, read
  // from the directory it is given — so it sees a copy's edits, as the real
  // one does. The runtime is the literal when there is one, else that hash.
  const NATIVE = ["app.json", "package.json", "package-lock.json", "plugins/withX.js"];
  const tools = {
    ...realTools,
    copyDir: (from, to) => fs.cpSync(from, to, { recursive: true }),
    fingerprint: (dir) => {
      const h = createHash("sha1");
      for (const f of NATIVE) h.update(f + "\0" + (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f)) : "") + "\0");
      for (const f of fs.readdirSync(path.join(dir, "plugins"))) h.update(`plugin:${f}`);
      return { hash: h.digest("hex"), sources: [...NATIVE.map((f) => ({ type: "file", filePath: f })), { type: "contents", id: "expoConfig" }] };
    },
    runtime: (dir) => {
      const rt = JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8")).expo.runtimeVersion;
      return typeof rt === "string" ? rt : tools.fingerprint(dir).hash;
    },
  };
  const PHONE = cfg.installedBuild.runtime;
  const fx = structuredClone(cfg);
  fx.installedBuild.commit = BASE;
  fx.installedBuild.nativeFingerprint = tools.fingerprint(path.join(repo, "pjl-field")).hash;

  // The lane: main's JavaScript merged in, and the runtime pin.
  w("pjl-field/src/screen.js", "export default 2; // main's changes\n"); gitc("commit", "-qam", "merge main");
  w("pjl-field/app.json", appJson(PHONE)); gitc("commit", "-qam", "pin");
  const LANE = gitc("rev-parse", "HEAD");
  fx.pin.pinnedTreeFingerprint = tools.fingerprint(path.join(repo, "pjl-field")).hash;

  const guard = (sha, o = {}) => runGuard({ lane: repo, sha, cfg: fx, tools, ...o });
  const failing = (r) => r.results.filter((x) => !x.pass).map((x) => x.id);
  const reset = () => { gitc("checkout", "-q", "--detach", LANE); gitc("reset", "-q", "--hard", LANE); gitc("clean", "-qfdx"); };
  const variant = (msg, fn) => { reset(); fn(); gitc("add", "-A"); gitc("commit", "-q", "-m", msg); return gitc("rev-parse", "HEAD"); };

  reset();
  let r = guard(LANE);
  ok(r.ok, `4a: the pinned lane passes (${j(r.results.filter((x) => !x.pass))})`);
  ok(r.results.find((x) => x.id === "G2")?.pass && /only expo\.runtimeVersion differs/.test(r.results.find((x) => x.id === "G1")?.detail), "4a: …G1 sees only the runtimeVersion, G2 proves the native code");

  gitc("checkout", "-q", "--detach", BASE);
  r = guard(BASE);
  ok(!r.ok && failing(r).includes("G1") && failing(r).includes("G4"), `4b: the unpinned tree fails closed (#305 today) (${j(failing(r))})`);

  let sha = variant("edit another app.json field", () => w("pjl-field/app.json", appJson(PHONE, { ios: { supportsTablet: false } })));
  r = guard(sha);
  ok(!r.ok && failing(r).includes("G1") && /expo\.ios\.supportsTablet/.test(r.results.find((x) => x.id === "G1").detail), `4c: any other app.json change fails G1, by name (${j(r.results.find((x) => x.id === "G1"))})`);

  sha = variant("a different literal", () => w("pjl-field/app.json", appJson("a7df9c322260d841aac44036eef0d60a2d987459")));
  r = guard(sha);
  ok(!r.ok && ["G1", "G4"].every((g) => failing(r).includes(g)), `4d: a different pinned runtime fails G1 and G4 (${j(failing(r))})`);

  sha = variant("dependency change", () => { w("pjl-field/package.json", '{ "dependencies": { "expo-location": "19.0.7" } }\n'); w("pjl-field/package-lock.json", '{ "lockfileVersion": 3, "x": 1 }\n'); });
  r = guard(sha);
  ok(!r.ok && ["G1", "G2", "G3"].every((g) => failing(r).includes(g)) && !failing(r).includes("G4"),
    `4e: a dependency change fails G1, G2 and G3 — while the pinned runtime still "matches" (G4), which is why G4 alone proves nothing (${j(failing(r))})`);

  sha = variant("new config plugin", () => w("pjl-field/plugins/withY.js", "module.exports = (c) => c;\n"));
  r = guard(sha);
  ok(!r.ok && /added: pjl-field\/plugins\/withY\.js/.test(r.results.find((x) => x.id === "G1").detail), "4f: a new native file fails G1");

  reset();
  w("pjl-field/app.json", appJson({ policy: "fingerprint" }));
  r = guard(LANE);
  ok(!r.ok && failing(r).includes("G0") && failing(r).includes("G3"), `4g: rewriting app.json in the checkout (the old lane's move) fails G0 and G3 (${j(failing(r))})`);

  reset();
  w("pjl-field/src/buildInfo.json", '{ "commit": "stamped" }\n'); gitc("commit", "-qam", "stamp");
  r = guard(LANE, { afterStamp: true });
  ok(r.ok, `4h: after the stamp, the same tree passes (${j(r.results.filter((x) => !x.pass))})`);
  r = guard(LANE);
  ok(!r.ok && failing(r).includes("G0"), "4h: …but the stamped tree is not the lane commit without --after-stamp");

  reset();
  w("pjl-field/src/buildInfo.json", '{ "commit": "stamped" }\n'); w("pjl-field/src/screen.js", "export default 3;\n"); gitc("commit", "-qam", "stamp plus");
  r = guard(LANE, { afterStamp: true });
  ok(!r.ok && failing(r).includes("G0"), "4i: a 'stamp' that changes anything but buildInfo.json fails");

  reset();
  gitc("checkout", "-q", "--orphan", "stranger"); gitc("commit", "-q", "-m", "unrelated");
  const STRANGER = gitc("rev-parse", "HEAD");
  r = guard(STRANGER);
  ok(!r.ok && /does not descend from the installed build/.test(r.results.find((x) => x.id === "G0").detail), "4j: a commit not descended from the installed build fails");

  reset();
  fs.mkdirSync(path.join(repo, "pjl-field", "ios"));
  r = guard(LANE);
  ok(!r.ok && failing(r).includes("G0"), "4k: a generated ios/ folder in the checkout fails");

  reset();
  ok(fingerprintCoverage([{ type: "file", filePath: "metro.config.js" }, { type: "contents", id: "somethingNew" }], cfg).length === 2,
    "4l: anything the fingerprint reads that G1 does not compare fails G3");
  ok(fingerprintCoverage([{ type: "file", filePath: "eas.json" }, { type: "dir", filePath: "node_modules/expo" }, { type: "contents", id: "expoAutolinkingConfig:ios" }], cfg).length === 0,
    "4l: …and the real sources are covered");

  const base = appJson({ policy: "fingerprint" });
  ok(compareAppJson(base, base.replace(/\{\s*"policy": "fingerprint"\s*\}/, `"${PHONE}"`), cfg).ok, "4m: the exact pin is the allowed difference");
  ok(!compareAppJson(base, JSON.stringify(JSON.parse(base.replace(/\{\s*"policy": "fingerprint"\s*\}/, `"${PHONE}"`))) + "\n", cfg).ok, "4m: …reformatting the file is not");

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 5: confirmations and EAS results ------------------------------------------
{
  const SHA = "2124cba2178b3da8adbe61ada6766a08b3521020";
  const G = cfg.knownGood[0].group;
  const main = "refs/heads/main";
  ok(publishPhrase(SHA, cfg) === "publish 2124cba2178b to 41661c6f" && rollbackPhrase(G) === `rollback to ${G}`, "5: the phrases name the commit/group and the runtime");
  const c = (env) => checkInputs({ REF: main, ...env }, cfg);
  ok(c({ MODE: "check-only", LANE_SHA: SHA }).ok, "5: check-only needs only the commit");
  ok(c({ MODE: "check-only", LANE_SHA: SHA, REF: "refs/heads/some-branch" }).ok, "5: check-only may run from any ref");
  ok(c({ MODE: "publish", LANE_SHA: SHA, CONFIRM: publishPhrase(SHA, cfg) }).ok, "5: publish with the exact phrase from main");
  ok(!c({ MODE: "publish", LANE_SHA: SHA, CONFIRM: "publish" }).ok, "5: publish with a loose phrase is refused");
  ok(!c({ MODE: "publish", LANE_SHA: SHA, CONFIRM: publishPhrase("1".repeat(40), cfg) }).ok, "5: a phrase for another commit is refused");
  ok(!c({ MODE: "publish", LANE_SHA: SHA, CONFIRM: publishPhrase(SHA, cfg), REF: "refs/heads/claude/x" }).ok, "5: publish from a branch other than main is refused");
  ok(!c({ MODE: "publish", LANE_SHA: SHA.slice(0, 12), CONFIRM: publishPhrase(SHA, cfg) }).ok, "5: a short sha is refused");
  ok(!c({ MODE: "publish", LANE_SHA: "$(curl x)", CONFIRM: "x" }).ok, "5: a non-sha is refused");
  ok(c({ MODE: "rollback", GROUP: G, CONFIRM: rollbackPhrase(G) }).ok, "5: rollback to the known-good group with its phrase");
  ok(!c({ MODE: "rollback", GROUP: "11111111-2222-3333-4444-555555555555", CONFIRM: "rollback to 11111111-2222-3333-4444-555555555555" }).ok, "5: rollback to a group not in config is refused");
  ok(!c({ MODE: "rollback", GROUP: G, CONFIRM: rollbackPhrase(G), REF: "refs/heads/claude/x" }).ok, "5: rollback from a branch is refused");
  ok(!c({ MODE: "deploy", LANE_SHA: SHA }).ok, "5: an unknown mode is refused");

  const upd = (o = {}) => ({ id: "u1", group: "g1", platform: "ios", runtimeVersion: cfg.installedBuild.runtime, branch: "production", ...o });
  ok(checkUpdates([upd()], cfg).ok, "5: an iOS update on the phone's runtime is accepted (update --json shape)");
  ok(checkUpdates([{ id: "u1", group: "g1", platform: "ios", runtime: { version: cfg.installedBuild.runtime }, branch: { name: "production" } }], cfg).ok, "5: …and in update:republish's shape");
  ok(!checkUpdates([upd({ runtimeVersion: "a7df9c322260d841aac44036eef0d60a2d987459" })], cfg).ok, "5: an update on another runtime turns the run red");
  ok(!checkUpdates([upd(), upd({ id: "u2", platform: "android" })], cfg).ok, "5: an Android update turns it red");
  ok(!checkUpdates([], cfg).ok && !checkUpdates(null, cfg).ok, "5: no result is not success");
  ok(!checkUpdates([upd()], cfg, { group: G }).ok, "5: a rollback that republished a different group turns it red");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttp-record-"));
  let rec = buildRecord({ env: { MODE: "publish", LANE_SHA: SHA }, cfg, tmp });
  ok(!rec.ok && /NOTHING PUBLISHED/.test(rec.record.outcome), "5: a publish with no EAS result records that nothing was published");
  fs.writeFileSync(path.join(tmp, "eas-result.json"), JSON.stringify([upd()]));
  rec = buildRecord({ env: { MODE: "publish", LANE_SHA: SHA }, cfg, tmp, now: new Date("2026-10-02T15:04:05.000Z") });
  ok(rec.ok && rec.record.target === SHA && rec.record.tag === "field-ttp/publish/20261002T150405Z-2124cba", `5: a publish is recorded against the lane commit (${j(rec.record.tag)})`);
  fs.writeFileSync(path.join(tmp, "eas-result.json"), JSON.stringify([{ id: "u9", group: G, platform: "ios", runtime: { version: cfg.installedBuild.runtime }, branch: { name: "production" } }]));
  rec = buildRecord({ env: { MODE: "rollback", GROUP: G }, cfg, tmp });
  ok(rec.ok && rec.record.target === cfg.knownGood[0].commit && /^field-ttp\/rollback\//.test(rec.record.tag), "5: a rollback is recorded against the known-good commit");
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---- 6: no native build while a runtime is pinned -----------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ttp-refuse-"));
  fs.mkdirSync(path.join(tmp, "pjl-field"));
  for (const name of ["field-app-build.yml", "field-app-taptopay-build.yml"]) {
    const text = read(`.github/workflows/${name}`);
    const steps = Object.values(YAML.parse(text).jobs)[0].steps;
    const at = steps.findIndex((s) => s.name === "Refuse while the runtime is pinned");
    const build = steps.findIndex((s) => /eas-cli@[\d.]+ build/.test(s.run || ""));
    const checkout = steps.findIndex((s) => (s.uses || "").startsWith("actions/checkout"));
    ok(at > checkout && at < build && at < steps.findIndex((s) => s.name === "Install"), `6: ${name} refuses right after checkout, before install and build (${[checkout, at, build]})`);
    if (at < 0) { ok(false, `6: ${name} has no refusal step to run`); continue; }
    const run = (rt) => {
      fs.writeFileSync(path.join(tmp, "pjl-field", "app.json"), JSON.stringify({ expo: { runtimeVersion: rt } }));
      return spawnSync("bash", ["-e", "-c", steps[at].run], { cwd: path.join(tmp, steps[at]["working-directory"]), encoding: "utf8" }).status;
    };
    ok(run({ policy: "fingerprint" }) === 0, `6: ${name} builds on the fingerprint policy`);
    ok(run(cfg.pin.runtimeVersion) !== 0, `6: ${name} refuses the lane's pin`);
    ok(run("1.0.0") !== 0 && run(undefined) !== 0 && run({ policy: "appVersion" }) !== 0, `6: ${name} refuses any other runtime setting`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  const ttp = YAML.parse(read(".github/workflows/field-app-taptopay-build.yml"));
  const co = Object.values(ttp.jobs)[0].steps.find((s) => (s.uses || "").startsWith("actions/checkout"));
  ok(co?.with?.ref === cfg.laneBranch, `6: the Tap to Pay build checks out ${cfg.laneBranch}, not the stale #151 branch (${co?.with?.ref})`);
  ok(!/claude\/pjl-field-taptopay/.test(read(".github/workflows/field-app-taptopay-build.yml")), "6: …and names it nowhere");
}

// ---- 7: merging this lane publishes nothing ----------------------------------
{
  const dir = path.join(ROOT, ".github", "workflows");
  const publishers = [];
  for (const f of fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    if (/eas-cli@[^\s"]*["]? update\b|update:republish|"eas-cli@\$cli" update/.test(text)) publishers.push(f);
  }
  ok(j(publishers.sort()) === j(["field-app-ttp-lane.yml", "field-app-update.yml"]), `7: only two workflows can publish an update (${j(publishers)})`);
  const upd = YAML.parse(read(".github/workflows/field-app-update.yml"));
  const on = upd.on ?? upd[true];
  const paths = on?.push?.paths || [];
  ok(j(on?.push?.branches) === j(["main"]) && paths.length > 0, "7: main's OTA publishes only on pushes to main that match its paths");
  const laneFiles = [".github/workflows/field-app-ttp-lane.yml", ".github/workflows/field-app-build.yml", ".github/workflows/field-app-taptopay-build.yml",
    "config/ttp-lane.json", "scripts/ttp-lane-guard.mjs", "scripts/ttp-lane-inputs.mjs", "scripts/ttp-lane-result.mjs", "scripts/test-ttp-lane-workflow.mjs",
    "scripts/test-ota-channel.mjs", "docs/TTP_RUNTIME_PIN.md", "docs/FLOW_REGISTER.md", "package.json"];
  const matches = (p, pat) => (pat.endsWith("/**") ? p.startsWith(pat.slice(0, -2)) : p === pat);
  ok(laneFiles.every((p) => !paths.some((pat) => matches(p, pat))), `7: none of this lane's files match main's OTA paths (${j(paths)})`);
}

// ---- config agrees with the documents that state it -------------------------
{
  const doc = read("docs/TTP_RUNTIME_PIN.md");
  ok(cfg.pin.runtimeVersion === cfg.installedBuild.runtime && /^[0-9a-f]{40}$/.test(cfg.pin.runtimeVersion), "config: the pin is the phone's runtime");
  ok(doc.includes(cfg.pin.runtimeVersion) && doc.includes(cfg.installedBuild.nativeFingerprint.slice(0, 8)) && doc.includes(cfg.pin.pinnedTreeFingerprint.slice(0, 8)) && /TEMPORARY/.test(doc),
    "config: docs/TTP_RUNTIME_PIN.md states the same runtime and fingerprints, and that it is temporary");
  ok(read("scripts/test-ota-channel.mjs").includes(`INSTALLED_TTP_RUNTIME = '${cfg.pin.runtimeVersion}'`), "config: test-ota-channel allows exactly this literal");
  ok(cfg.easCli === JSON.parse(read("pjl-field/eas.json")).cli.version, "config: the lane's eas-cli is the one the builds use");
}

console.log(`\nttp lane workflow: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
