#!/usr/bin/env node
// scripts/ttp-lane-result.mjs — read what EAS says it did, for the Tap to Pay
// release lane.
//
//   node scripts/ttp-lane-result.mjs view   <config> <update:view json>
//   node scripts/ttp-lane-result.mjs record <config> <tmpdir> <out.json>
//
// `view`: before a rollback, the group asked for must be on EAS as the
//   known-good iOS update on the phone's runtime.
// `record`: after a publish or rollback, every update EAS reports must be iOS,
//   on the phone's runtime, on the lane's update branch, in one group. An
//   update on another runtime goes nowhere and looks exactly like success, so
//   this turns the run red with the ids. Then it writes the record (job
//   summary, artifact, and the tag the record job pushes).
//
// The JSON shapes are eas-cli 23.2.0's own: `update --json` and `update:view
// --json` print getUpdateJsonInfosForUpdates (runtimeVersion, branch name);
// `update:republish --json` prints the publish mutation's updates
// (runtime.version, branch.name). Both are read.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runtimeOf = (u) => u?.runtimeVersion ?? u?.runtime?.version ?? null;
const branchOf = (u) => (typeof u?.branch === "string" ? u.branch : u?.branch?.name ?? null);

// Returns { ok, errors, updates } over an eas-cli JSON result.
export function checkUpdates(json, cfg, { group = null } = {}) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.updates) ? json.updates : null;
  const errors = [];
  if (!list || !list.length) return { ok: false, errors: ["EAS reported no updates"], updates: [] };
  const updates = list.map((u) => ({ id: u.id, group: u.group, platform: u.platform, runtime: runtimeOf(u), branch: branchOf(u) }));
  for (const u of updates) {
    if (u.platform !== cfg.platform) errors.push(`update ${u.id} is ${u.platform}, not ${cfg.platform}`);
    if (u.runtime !== cfg.installedBuild.runtime) errors.push(`update ${u.id} is on runtime ${u.runtime}, not the phone's ${cfg.installedBuild.runtime}`);
    if (u.branch !== cfg.updateBranch) errors.push(`update ${u.id} is on branch ${u.branch}, not ${cfg.updateBranch}`);
  }
  const groups = [...new Set(updates.map((u) => u.group))];
  if (groups.length !== 1) errors.push(`expected one update group, got ${groups.join(", ")}`);
  if (group && groups[0] !== group) errors.push(`expected group ${group}, got ${groups.join(", ")}`);
  return { ok: !errors.length, errors, updates };
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

export function buildRecord({ env, cfg, tmp, now = new Date() }) {
  const mode = env.MODE;
  const guard = readJson(path.join(tmp, "guard.json"));
  const guardStamped = readJson(path.join(tmp, "guard-stamped.json"));
  const result = readJson(path.join(tmp, "eas-result.json"));
  const record = {
    mode, at: now.toISOString(), actor: env.ACTOR || null, run: env.RUN_URL || null, workflowCommit: env.WORKFLOW_SHA || null,
    laneSha: env.LANE_SHA || null, rollbackGroup: env.GROUP || null, phoneRuntime: cfg.installedBuild.runtime,
    guard: guard && { ok: guard.ok, results: guard.results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.id}: ${r.detail}`) },
    guardAfterStamp: guardStamped && { ok: guardStamped.ok, results: guardStamped.results.map((r) => `${r.pass ? "PASS" : "FAIL"} ${r.id}: ${r.detail}`) },
    published: null, errors: [],
  };
  if (mode === "check-only") {
    record.outcome = guard?.ok ? "check-only: guard PASS, nothing published" : "check-only: guard FAIL, nothing published";
    return { ok: Boolean(guard?.ok), record };
  }
  if (!result) {
    record.outcome = `${mode}: NOTHING PUBLISHED (an earlier step stopped the run)`;
    record.errors.push("no EAS result");
    return { ok: false, record };
  }
  const known = (cfg.knownGood || []).find((k) => k.group === env.GROUP);
  const check = checkUpdates(result, cfg, { group: mode === "rollback" ? env.GROUP : null });
  record.published = check.updates;
  record.errors = check.errors;
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  if (mode === "publish") {
    record.target = env.LANE_SHA;
    record.tag = `field-ttp/publish/${stamp}-${String(env.LANE_SHA).slice(0, 7)}`;
  } else {
    record.target = known?.commit || null;
    record.tag = `field-ttp/rollback/${stamp}-${String(env.GROUP).slice(0, 8)}`;
  }
  record.outcome = check.ok ? `${mode}: published group ${check.updates[0].group} to runtime ${cfg.installedBuild.runtime}` : `${mode}: EAS RESULT DOES NOT MATCH THE PHONE — see errors`;
  return { ok: check.ok && Boolean(record.target), record };
}

export function tagMessage(record) {
  return [
    `Tap to Pay lane ${record.mode}: ${record.outcome}`,
    "",
    `Target commit: ${record.target}`,
    `Phone runtime: ${record.phoneRuntime}`,
    ...(record.published || []).map((u) => `Update ${u.id} · group ${u.group} · ${u.platform} · ${u.runtime} · ${u.branch}`),
    ...(record.guardAfterStamp?.results || record.guard?.results || []).map((r) => `Guard ${r}`),
    `Run: ${record.run}`,
    `Actor: ${record.actor} · workflow commit ${record.workflowCommit} · ${record.at}`,
  ].join("\n");
}

function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const d = `EOF_${Math.random().toString(36).slice(2)}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${d}\n${value}\n${d}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, cfgPath, a, b] = process.argv.slice(2);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  if (cmd === "view") {
    const known = (cfg.knownGood || []).find((k) => k.group === process.env.GROUP);
    const r = checkUpdates(readJson(a), cfg, { group: process.env.GROUP });
    if (r.ok && known?.iosUpdate && !r.updates.some((u) => u.id === known.iosUpdate)) r.errors.push(`group ${process.env.GROUP} does not hold the recorded iOS update ${known.iosUpdate}`);
    for (const e of r.errors) console.log(`::error::${e}`);
    if (r.errors.length) { console.log("::error::Nothing was rolled back."); process.exit(1); }
    console.log(`Group ${process.env.GROUP} is on EAS: ${r.updates.map((u) => `${u.platform} ${u.id} on ${u.runtime}`).join("; ")}`);
  } else if (cmd === "record") {
    const { ok, record } = buildRecord({ env: process.env, cfg, tmp: a });
    fs.writeFileSync(b, JSON.stringify(record, null, 2) + "\n");
    for (const e of record.errors) console.log(`::error::${e}`);
    console.log(record.outcome);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### ${record.outcome}\n\n${(record.published || []).map((u) => `- update \`${u.id}\` · group \`${u.group}\` · ${u.platform} · runtime \`${u.runtime}\` · branch ${u.branch}`).join("\n")}\n`);
    }
    if (ok && record.mode !== "check-only") {
      output("target", record.target);
      output("tag", record.tag);
      output("message", tagMessage(record));
    }
    process.exit(ok ? 0 : 1);
  } else {
    console.error("usage: ttp-lane-result.mjs view|record …");
    process.exit(2);
  }
}
