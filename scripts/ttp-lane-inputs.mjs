#!/usr/bin/env node
// scripts/ttp-lane-inputs.mjs — the first step of the Tap to Pay release lane.
//
//   MODE=… LANE_SHA=… CONFIRM=… GROUP=… REF=… node scripts/ttp-lane-inputs.mjs config/ttp-lane.json
//
// Refuses anything but a well-formed request, before the lane is checked out
// or any token is in reach. The confirmation phrases are typed, not
// selected: a publish names the commit it sends and the runtime it sends it
// to, so a phrase copied from an earlier run does not fit a later commit.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEX40 = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const publishPhrase = (sha, cfg) => `publish ${sha.slice(0, 12)} to ${cfg.installedBuild.runtime.slice(0, 8)}`;
export const rollbackPhrase = (group) => `rollback to ${group}`;

// Returns { ok, errors, plan }.
export function checkInputs(env, cfg) {
  const mode = String(env.MODE || "");
  const sha = String(env.LANE_SHA || "").trim();
  const confirm = String(env.CONFIRM || "").trim();
  const group = String(env.GROUP || "").trim();
  const ref = String(env.REF || "");
  const errors = [];

  if (!["check-only", "publish", "rollback"].includes(mode)) errors.push(`mode must be check-only, publish or rollback, not ${JSON.stringify(mode)}`);
  if ((mode === "publish" || mode === "rollback") && ref !== "refs/heads/main") {
    errors.push(`${mode} runs only from main (this run is from ${ref || "an unknown ref"}); main holds the guard and the expectations`);
  }

  if (mode === "check-only" || mode === "publish") {
    if (!HEX40.test(sha)) errors.push(`lane_sha must be a full 40-character commit, not ${JSON.stringify(sha)}`);
    if (group) errors.push("rollback_group is for rollback only; leave it empty");
  }
  if (mode === "publish" && HEX40.test(sha) && confirm !== publishPhrase(sha, cfg)) {
    errors.push(`confirm must be exactly "${publishPhrase(sha, cfg)}"`);
  }

  if (mode === "rollback") {
    if (sha) errors.push("lane_sha is not used by rollback; leave it empty");
    const known = (cfg.knownGood || []).find((k) => k.group === group);
    if (!UUID.test(group)) errors.push(`rollback_group must be an update group id, not ${JSON.stringify(group)}`);
    else if (!known) errors.push(`${group} is not a known-good group in config/ttp-lane.json (${(cfg.knownGood || []).map((k) => k.group).join(", ") || "none"})`);
    else if (known.runtime !== cfg.installedBuild.runtime) errors.push(`known-good group ${group} is runtime ${known.runtime}, not the phone's ${cfg.installedBuild.runtime}`);
    if (confirm !== rollbackPhrase(group)) errors.push(`confirm must be exactly "${rollbackPhrase(group)}"`);
  }

  const plan = mode === "check-only" ? `check-only: run the guard on ${sha.slice(0, 12)}. Nothing is published.${confirm ? " (confirm is ignored in check-only.)" : ""}`
    : mode === "publish" ? `publish ${sha.slice(0, 12)} to runtime ${cfg.installedBuild.runtime} (iOS, branch ${cfg.updateBranch}) if the guard passes twice`
    : `rollback: republish known-good group ${group} (iOS)`;
  return { ok: !errors.length, errors, plan };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const r = checkInputs(process.env, cfg);
  for (const e of r.errors) console.log(`::error::${e}`);
  if (!r.ok) { console.log("::error::Nothing was checked out and nothing was published."); process.exit(1); }
  console.log(r.plan);
}
