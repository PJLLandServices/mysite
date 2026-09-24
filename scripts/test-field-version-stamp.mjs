#!/usr/bin/env node
// scripts/test-field-version-stamp.mjs
//
// The installed field app can say which commit it runs, and the server's
// log hears the same commit from it.
//
// WHY. On 2026-09-23 the server ran main while every phone still ran
// JavaScript from before 2026-09-11: two OTA publishes in a row had
// refused to go out ("no installed build can receive this update") and the
// phone's only label was "App updated <time>". Nobody could look at a
// phone, or at the server, and know which fixes were in the trucks.
//
//   A. the workflows' stamper writes the commit into the bundle, and
//      refuses to ship a bundle with no commit
//   B. the app describes itself: commit, build/update, runtime — and an
//      unstamped bundle says "commit unknown" instead of guessing
//   C. every api.js request carries x-pjl-client (and none does before
//      App.js installs it, so the bare-vm tests of api.js are unchanged)
//   D. the real server logs "[field-client] <user> runs commit=<sha> …"
//      once per user per version, lists it at /api/admin/field-clients
//      (admin only), and never logs a malformed header
//   E. both app workflows stamp BEFORE eas bundles, and the stamp is not
//      a native change (it cannot move the fingerprint)
//
// Run: node scripts/test-field-version-stamp.mjs   (also in build:check)

import fs from "node:fs";
import os from "node:os";
import vm from "node:vm";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootServer } from "./lib/field-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const SHA = "4f1c2d3e4a5b6c7d8e9f00112233445566778899";
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; } };

// ---- A. the stamper ---------------------------------------------------------
{
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stamp-")), "buildInfo.json");
  const run = (args, env) => spawnSync(process.execPath, [path.join(ROOT, "scripts/stamp-field-build-info.mjs"), ...args],
    { env: { PATH: process.env.PATH, STAMP_OUT: out, ...env }, encoding: "utf8" });
  const r = run(["build"], { GITHUB_SHA: SHA, GITHUB_REF_NAME: "main", GITHUB_RUN_NUMBER: "41" });
  let info = null; try { info = JSON.parse(fs.readFileSync(out, "utf8")); } catch {}
  ok(r.status === 0 && info?.commit === SHA && info?.source === "build" && info?.run === "41" && info?.ref === "main",
    `A. the stamper writes the commit into the bundle (${r.status} ${JSON.stringify(info)})`);
  fs.rmSync(out, { force: true });
  const bare = run(["update"], {});
  ok(bare.status === 1 && !fs.existsSync(out), `A. …and refuses with no commit to stamp (${bare.status})`);
  ok(run(["nightly"], { GITHUB_SHA: SHA }).status === 2, "A. …and only knows build|update");
  const placeholder = JSON.parse(read("pjl-field/src/buildInfo.json") || "{}");
  ok("commit" in placeholder && placeholder.commit === null, "A. the placeholder in git carries no commit (a local bundle can't pose as a release)");
}

// ---- B. the app describes itself ---------------------------------------------
let cv = null;
try { cv = await import(pathToFileURL(path.join(ROOT, "pjl-field/src/clientVersionInfo.mjs")).href); } catch {}
ok(Boolean(cv?.describeClientVersion), "B. pjl-field/src/clientVersionInfo.mjs exists");
if (cv?.describeClientVersion) {
  const built = cv.describeClientVersion({ commit: SHA, source: "build", run: "41", ref: "main" },
    { isEmbeddedLaunch: true, updateId: "ignored", runtimeVersion: "4737af92cef62d333f59ee5cc83d67bd8e400ff4", channel: "production" });
  const lines = cv.clientVersionLines(built);
  ok(lines[0] === "Commit 4f1c2d3 · TestFlight build (run #41)", `B. a fresh build names its commit (${lines[0]})`);
  ok(lines[1] === "Running the bundle shipped with the build", `B. …and says it runs the build's own bundle (${lines[1]})`);
  ok(lines[2] === "Runtime 4737af92 · production", `B. …and its runtime (${lines[2]})`);
  const updated = cv.describeClientVersion({ commit: SHA, source: "update", run: "52" },
    { isEmbeddedLaunch: false, updateId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", runtimeVersion: "4737af92cef6" });
  const ul = cv.clientVersionLines(updated);
  ok(ul[0] === "Commit 4f1c2d3 · over-the-air update (run #52)" && ul[1] === "Update 0199a1b2",
    `B. an OTA update names its commit and update id (${ul.join(" | ")})`);
  const unstamped = cv.clientVersionLines(cv.describeClientVersion({ commit: null }, { isEmbeddedLaunch: true }));
  ok(unstamped[0] === "Commit unknown — this bundle was not stamped", `B. an unstamped bundle says so (${unstamped[0]})`);
  const header = cv.clientVersionHeaderValue(built);
  ok(header === `commit=${SHA};source=build;run=41;update=embedded;runtime=4737af92cef62d333f59ee5cc83d67bd8e400ff4;channel=production`,
    `B. the request header carries the same facts (${header})`);
  const hostile = cv.clientVersionHeaderValue(cv.describeClientVersion({ commit: "abc;\nfake=1\r\n[field-client] admin", source: "build" }, {}));
  ok(!/[\r\n]/.test(hostile) && hostile.split(";").length === 6, `B. a value can't inject a separator or a newline (${JSON.stringify(hostile)})`);
}

// ---- C. every api.js request carries it --------------------------------------
{
  const src = read("pjl-field/src/api.js")
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/\bexport (async function|function|const|class|let)/g, "$1");
  const calls = [];
  const fetchStub = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, workOrder: { id: "WO-1" }, properties: [] }), json: async () => ({ ok: true }) };
  };
  const context = { fetch: fetchStub, AbortController, URL, URLSearchParams, JSON, Promise, Error, TypeError, console, setTimeout, clearTimeout };
  vm.createContext(context);
  let api = null;
  try {
    vm.runInContext(src + "\n;globalThis.__api = { getWorkOrder, listProperties, completeWorkOrder, openWorkOrder, setClientVersionHeader: typeof setClientVersionHeader === 'function' ? setClientVersionHeader : null };", context);
    api = context.__api;
  } catch (e) { console.error("  (api.js did not load in the vm:", e.message, ")"); }
  ok(typeof api?.setClientVersionHeader === "function", "C. api.js lets the app install the version header");
  if (api) {
    await api.getWorkOrder("WO-1");
    ok(calls.length && !("x-pjl-client" in calls[calls.length - 1].headers), "C. before it is installed no header is sent (bare-vm api tests unchanged)");
    if (api.setClientVersionHeader) {
      const value = `commit=${SHA};source=build;run=41;update=embedded;runtime=r;channel=production`;
      api.setClientVersionHeader(() => value);
      calls.length = 0;
      await api.getWorkOrder("WO-1");
      await api.listProperties();
      await api.completeWorkOrder("WO-1", {}).catch(() => {});
      await api.openWorkOrder("L-1").catch(() => {});
      ok(calls.length >= 4 && calls.every((c) => c.headers["x-pjl-client"] === value),
        `C. every request carries x-pjl-client (${calls.filter((c) => c.headers["x-pjl-client"] === value).length}/${calls.length})`);
      ok(calls.every((c) => c.headers.accept === "application/json"), "C. …without dropping the headers the request already had");
      api.setClientVersionHeader(() => { throw new Error("boom"); });
      calls.length = 0;
      await api.getWorkOrder("WO-1").catch(() => {});
      ok(calls.length === 1 && !("x-pjl-client" in calls[0].headers), "C. a failing provider never blocks a request");
    }
  }
  // The offline queue's own request() (it imports react-native, so it is
  // checked in source): it must use the same header helper.
  ok(/headers:\s*withClientVersion\(/.test(read("pjl-field/src/offline/field.js")), "C. the offline sync's requests carry it too (withClientVersion)");
  ok(/setClientVersionHeader\(clientVersionHeader\)/.test(read("pjl-field/App.js")), "C. App.js installs it at startup");
  ok(/clientVersionText\(\)/.test(read("pjl-field/src/screens/TodayScreen.js")), "C. the Today tab shows the lines");
}

// ---- D. the real server logs it -----------------------------------------------
{
  const srv = await bootServer({ port: 4990 + Math.floor(Math.random() * 400) });
  try {
    await srv.login({ role: "tech" });
    const value = `commit=${SHA};source=build;run=41;update=embedded;runtime=4737af92;channel=production`;
    await srv.api("GET", "/api/session", undefined, { "x-pjl-client": value });
    await srv.api("GET", "/api/work-orders", undefined, { "x-pjl-client": value });
    await new Promise((r) => setTimeout(r, 300));
    const lines = srv.logs().split("\n").filter((l) => l.includes("[field-client]"));
    ok(lines.length === 1 && lines[0].includes(`commit=${SHA}`) && /tech-\d+@pjl\.test \(tech\)/.test(lines[0]),
      `D. the server logs which commit this tech's phone runs, once (${JSON.stringify(lines)})`);
    ok(lines[0]?.includes("source=build") && lines[0]?.includes("update=embedded") && lines[0]?.includes("runtime=4737af92"),
      "D. …with build/update and runtime");
    const denied = await srv.api("GET", "/api/admin/field-clients");
    ok(denied.status === 401 || denied.status === 403, `D. a tech can't read the list (${denied.status})`);
    await srv.api("GET", "/api/session", undefined, { "x-pjl-client": "commit=abc [field-client] forged admin;source=build" });
    await srv.api("GET", "/api/session", undefined, { "x-pjl-client": value.replace("run=41", "run=42") });
    await new Promise((r) => setTimeout(r, 300));
    const after = srv.logs().split("\n").filter((l) => l.includes("[field-client]"));
    ok(!after.some((l) => l.includes("forged")), "D. a malformed header is never written to the log");
    ok(after.length === 2 && after[1].includes("run=42"), `D. a new version logs a new line (${after.length})`);
    await srv.login({ role: "admin" });
    const list = await srv.api("GET", "/api/admin/field-clients");
    const mine = (list.body.clients || []).find((c) => /tech-\d+@pjl\.test/.test(c.user));
    ok(list.status === 200 && mine?.version?.commit === SHA && mine?.version?.run === "42",
      `D. /api/admin/field-clients lists the tech's latest report (${list.status} ${JSON.stringify(mine)})`);
  } catch (err) {
    failed += 1; console.error(`  FAIL: D crashed: ${err?.stack || err}`);
  } finally { await srv.stop(); }
}

// ---- E. the workflows stamp before EAS bundles ---------------------------------
for (const [file, cmd, source] of [
  [".github/workflows/field-app-build.yml", "eas-cli@23.2.0 build", "build"],
  [".github/workflows/field-app-update.yml", "eas-cli@23.2.0 update", "update"]
]) {
  const yml = read(file);
  const stamp = yml.indexOf(`node scripts/stamp-field-build-info.mjs ${source}`);
  const eas = yml.indexOf(cmd);
  ok(stamp !== -1 && eas !== -1 && stamp < eas, `E. ${path.basename(file)} stamps the commit before \`${cmd}\``);
  ok(/commit -q -m "Stamp [a-z]+ \$\{GITHUB_SHA::7\} \(not pushed\)" -- pjl-field\/src\/buildInfo\.json/.test(yml) && !/git push/.test(yml),
    `E. ${path.basename(file)} commits the stamp locally so EAS packs it, and never pushes`);
}
{
  ok(!/buildInfo/.test(read("pjl-field/app.json")), "E. the stamp is not app config, so it cannot move the native fingerprint");
}

console.log(`field-version-stamp: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
