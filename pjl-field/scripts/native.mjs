// Shared plumbing for the two commands in package.json: `npm run send`
// and `npm run rebuild`.
//
// The question that has to be answered before every update is "does this
// need Xcode?", and the honest answer was never a rule of thumb — it is
// the Expo FINGERPRINT. An over-the-air update installs only onto a build
// whose native code is identical, so the test is simply: does the
// fingerprint of the code I am about to publish match the fingerprint of
// the build that is on the phone?
//
// Both halves of that are knowable. The first is computed from the
// source. The second is whatever it was when `npm run rebuild` last ran,
// which is why that command writes it down.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(APP, '..');

// Where the fingerprint of the build now on the phone is recorded. Local
// to this Mac — like ios/ itself, it is a fact about a build that only
// exists here, so it is not in the repo.
export const BUILD_RECORD = path.join(APP, '.build-fingerprint');

const E = '[';
export const c = {
  bold: (s) => `${E}1m${s}${E}0m`,
  green: (s) => `${E}32m${s}${E}0m`,
  amber: (s) => `${E}33m${s}${E}0m`,
  red: (s) => `${E}31m${s}${E}0m`,
  dim: (s) => `${E}2m${s}${E}0m`,
};

// npx, by the name the platform actually has for it.
//
// On Windows npx is `npx.cmd`, and execFileSync('npx', ...) throws ENOENT
// looking for an extensionless file that is not there. That failure is
// worse than it sounds: send.mjs reads it as "EAS is not installed" and
// tells you to install a tool you already have. Patrick works from a
// Windows PC as well as the Mac (2026-09-11), and none of this was ever
// tried there.
export const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Xcode does not exist off macOS, so a rebuild cannot even be attempted.
export const CAN_BUILD_NATIVE = process.platform === 'darwin';

export function say(...lines) { console.log(lines.join('\n')); }
export function rule() { say(c.dim('-'.repeat(64))); }

// A headline you cannot miss halfway up a scrollback.
export function banner(text, colour = c.green) {
  rule();
  say(colour(c.bold(`  ${text}`)));
  rule();
}

export async function fingerprint() {
  const fp = await import('@expo/fingerprint');
  const res = await fp.createFingerprintAsync(APP, { platforms: ['ios'] });
  return res.hash;
}

export function recordedBuild() {
  try {
    const raw = JSON.parse(readFileSync(BUILD_RECORD, 'utf8'));
    return raw && typeof raw.hash === 'string' ? raw : null;
  } catch { return null; }
}

export function recordBuild(hash) {
  writeFileSync(BUILD_RECORD, `${JSON.stringify({ hash, at: new Date().toISOString() }, null, 2)}\n`);
}

export function git(...args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
  } catch { return ''; }
}

// The generated Xcode project. Absent until the first prebuild.
export function iosProject() {
  const ios = path.join(APP, 'ios');
  if (!existsSync(ios)) return null;
  const proj = readdirSync(ios).find((f) => f.endsWith('.xcodeproj'));
  if (!proj) return null;
  const pbx = path.join(ios, proj, 'project.pbxproj');
  if (!existsSync(pbx)) return null;
  return {
    dir: ios,
    name: proj.replace(/\.xcodeproj$/, ''),
    proj: path.join(ios, proj),
    pbx,
  };
}

// --- The two settings a prebuild wipes -----------------------------------
//
// Both are re-set by hand today, every rebuild, and getting either wrong
// produces a failure that looks like something else: the wrong Team gives
// "requires a development team" on Release only, and a Debug
// configuration gives a red RCTFatal screen the moment the phone leaves
// the Mac. Neither is a decision — they are the same answer every time —
// so they are restored rather than re-asked.

const TEAM = /DEVELOPMENT_TEAM\s*=\s*"?([A-Z0-9]{10})"?\s*;/;

// Read the team out of the project BEFORE it is wiped, so a rebuild puts
// back what was already there. Never guessed: a wrong team id fails in a
// way that is hard to read.
export function readTeam(pbxPath) {
  try { return (readFileSync(pbxPath, 'utf8').match(TEAM) || [])[1] || null; }
  catch { return null; }
}

// Set the signing team on EVERY configuration of the app target, which is
// what Xcode's "All" tab does. Setting it on Debug alone is the classic
// version of this that looks fixed and is not.
export function writeTeam(pbxPath, team) {
  if (!/^[A-Z0-9]{10}$/.test(String(team))) {
    throw new Error(`"${team}" is not a 10-character Team ID`);
  }
  const src = readFileSync(pbxPath, 'utf8');
  // Strip any team lines already present, so running twice cannot stack
  // duplicates and a changed team id actually changes.
  const cleaned = src.replace(/^[ \t]*(?:DEVELOPMENT_TEAM|CODE_SIGN_STYLE) = [^\n]*\n/gm, '');
  // The app target's configurations are the ones carrying the bundle id.
  let count = 0;
  const out = cleaned.replace(
    /^([ \t]*)PRODUCT_BUNDLE_IDENTIFIER = ([^\n]*)\n/gm,
    (line, indent, value) => {
      count += 1;
      return `${indent}PRODUCT_BUNDLE_IDENTIFIER = ${value}\n`
        + `${indent}DEVELOPMENT_TEAM = ${team};\n`
        + `${indent}CODE_SIGN_STYLE = Automatic;\n`;
    },
  );
  if (!count) throw new Error('could not find the app target in project.pbxproj');
  writeFileSync(pbxPath, out);
  return count;
}

// The scheme's Run action decides what a press of the play button builds.
// Prebuild leaves it on Debug.
export function schemePath(project) {
  const dir = path.join(project.proj, 'xcshareddata', 'xcschemes');
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.endsWith('.xcscheme'));
  return file ? path.join(dir, file) : null;
}

export function setRunConfiguration(schemeFile, value = 'Release') {
  const src = readFileSync(schemeFile, 'utf8');
  // Only the LaunchAction — the Test, Profile and Analyze actions have
  // their own build configurations and are none of our business.
  const launch = src.indexOf('<LaunchAction');
  if (launch < 0) throw new Error('no LaunchAction in the scheme');
  const head = src.slice(0, launch);
  const tail = src.slice(launch);
  const before = (tail.match(/buildConfiguration = "([^"]+)"/) || [])[1] || null;
  writeFileSync(
    schemeFile,
    head + tail.replace(/buildConfiguration = "[^"]+"/, `buildConfiguration = "${value}"`),
  );
  return before;
}
