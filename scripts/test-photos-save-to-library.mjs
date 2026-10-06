#!/usr/bin/env node
// scripts/test-photos-save-to-library.mjs
//
// Every photo taken with PJL Field's camera keeps its full-size original in
// the iPhone's photo library, and a smaller copy goes to the work order
// (PJL-114, Patrick 2026-10-06).
//
// The decisions this pins:
//   - the camera shoots at FULL quality (quality 1), not the 0.40 / 0.80
//     it used to, so there is a full-size original to keep;
//   - that original is saved to the photo library, ADD-ONLY: iOS is asked
//     for "add photos" and nothing more — no album, no Full Access
//     (Patrick: "just download them to the library");
//   - the work order gets a separate copy: 2400 px on the long edge at JPEG
//     0.75 when the server's photoShrink is on, JPEG 0.40 when it is off;
//   - saving to the library NEVER blocks the work order: refused, throwing,
//     or never finishing, the photo still comes back; one quiet note, once;
//   - a resize that fails still gives the work order a photo (the original);
//   - a photo chosen from the library is never saved to it again.
//
// photos.js and photo-library.js import the phone's native modules, which
// cannot load here, so each is copied into a temp folder with those imports
// pointed at stand-ins that record every call.
//
// Run: node scripts/test-photos-save-to-library.mjs   (also in build:check)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "pjl-field", "src");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-photos-"));
const MOCKS = {
  "expo-image-picker": "picker.mjs",
  "expo-media-library": "library.mjs",
  "expo-image-manipulator": "manipulator.mjs",
  "expo-file-system": "filesystem.mjs",
  "react-native": "rn.mjs",
};
// One shared log the stand-ins write into, and knobs a case can turn.
fs.writeFileSync(path.join(TMP, "state.mjs"), `export const S = { calls: [], knobs: {} };\nexport const reset = (k = {}) => { S.calls.length = 0; S.knobs = k; };\n`);
fs.writeFileSync(path.join(TMP, "picker.mjs"), `import { S } from './state.mjs';
export const requestCameraPermissionsAsync = async () => ({ granted: true });
export const requestMediaLibraryPermissionsAsync = async () => ({ granted: true });
export const launchCameraAsync = async (o) => { S.calls.push(['camera', o]); return S.knobs.cancel ? { canceled: true } : { canceled: false, assets: [{ uri: 'file:///cam/original.jpg', width: 4032, height: 3024, mimeType: 'image/jpeg', fileName: 'original.jpg', base64: o.base64 ? 'CAMB64' : undefined }] }; };
export const launchImageLibraryAsync = async (o) => { S.calls.push(['library-pick', o]); return { canceled: false, assets: [{ uri: 'file:///lib/picked.heic', mimeType: 'image/heic', fileName: 'picked.heic', base64: 'PICKB64' }] }; };
`);
fs.writeFileSync(path.join(TMP, "library.mjs"), `import { S } from './state.mjs';
export const requestPermissionsAsync = async (writeOnly, granular) => { S.calls.push(['perm', writeOnly, granular]); if (S.knobs.permThrows) throw new Error('perm boom'); return { granted: !S.knobs.denied, status: S.knobs.denied ? 'denied' : 'granted', accessPrivileges: S.knobs.denied ? 'none' : 'all' }; };
export const getPermissionsAsync = async (writeOnly) => { S.calls.push(['getperm', writeOnly]); return { granted: !S.knobs.denied }; };
export const saveToLibraryAsync = async (uri) => { S.calls.push(['save', uri]); if (S.knobs.hang) return new Promise(() => {}); if (S.knobs.saveThrows) throw new Error('save boom'); };
export const createAssetAsync = async (uri, album) => { S.calls.push(['createAsset', uri, album]); if (S.knobs.saveThrows) throw new Error('save boom'); return { id: 'A1', uri }; };
export const createAlbumAsync = async (...a) => { S.calls.push(['createAlbum', ...a]); return { id: 'AL1' }; };
export const getAlbumAsync = async (...a) => { S.calls.push(['getAlbum', ...a]); return null; };
export const addAssetsToAlbumAsync = async (...a) => { S.calls.push(['addToAlbum', ...a]); return true; };
`);
fs.writeFileSync(path.join(TMP, "manipulator.mjs"), `import { S } from './state.mjs';
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' };
export const ImageManipulator = { manipulate(uri) {
  const ops = [];
  const ctx = {
    resize(size) { ops.push(['resize', size]); return ctx; },
    async renderAsync() { if (S.knobs.resizeThrows) throw new Error('resize boom'); return { async saveAsync(opts) { S.calls.push(['manip', uri, ops, opts]); return { uri: 'file:///cache/upload.jpg', width: 2400, height: 1800, base64: 'SMALLB64' }; } }; },
  };
  return ctx;
} };
`);
fs.writeFileSync(path.join(TMP, "filesystem.mjs"), `import { S } from './state.mjs';
export class File { constructor(uri) { this.uri = uri; } async base64() { S.calls.push(['readOriginal', this.uri]); return 'ORIGB64'; } }
`);
fs.writeFileSync(path.join(TMP, "rn.mjs"), `import { S } from './state.mjs';
export const Alert = { alert: (...a) => S.calls.push(['alert', ...a]) };
export const Platform = { OS: 'ios' };
`);

// Copy a source module in, with its native imports pointed at the stand-ins
// and its relative imports at the copies.
function copyIn(name) {
  const from = path.join(SRC, name);
  if (!fs.existsSync(from)) return false;
  let code = fs.readFileSync(from, "utf8");
  for (const [spec, file] of Object.entries(MOCKS)) {
    code = code.replace(new RegExp(`from '${spec}(/[a-z]+)?'`, "g"), `from './${file}'`);
  }
  code = code.replace(/from '\.\/([\w-]+)'/g, (m, f) => `from './${f}.mjs'`);
  fs.writeFileSync(path.join(TMP, name.replace(/\.m?js$/, ".mjs")), code);
  return true;
}
const havePhotos = copyIn("photos.js");
copyIn("media-type.js");
const haveLibrary = copyIn("photo-library.js");
ok(haveLibrary, "pjl-field/src/photo-library.js exists (saving to the iPhone photo library)");

const { S, reset } = await import(pathToFileURL(path.join(TMP, "state.mjs")).href);
const photos = havePhotos ? await import(pathToFileURL(path.join(TMP, "photos.mjs")).href) : {};
const lib = haveLibrary ? await import(pathToFileURL(path.join(TMP, "photo-library.mjs")).href) : {};
const flush = () => new Promise((r) => setTimeout(r, 20));
const calls = (kind) => S.calls.filter((c) => c[0] === kind);
const meta = { category: "issue", zoneNumber: 3, label: "zone_3" };

async function take(knobs, opts) {
  reset(knobs);
  lib.resetNoticeForTests?.();
  const p = await Promise.race([photos.takePhoto(meta, opts), new Promise((r) => setTimeout(() => r("TIMEOUT"), 1500))]);
  await flush();
  return p;
}

// 1. Full quality, original saved, add-only.
{
  const p = await take({}, { shrink: true });
  const cam = calls("camera")[0]?.[1];
  ok(cam && cam.quality === 1, `the camera shoots at full quality (quality ${cam?.quality})`);
  ok(cam && cam.base64 === false, "…and does not hand the full-size photo back as base64 (it is never sent)");
  const saves = calls("save");
  ok(saves.length === 1 && saves[0][1] === "file:///cam/original.jpg", `the ORIGINAL is saved to the photo library, once (saved ${JSON.stringify(saves.map((s) => s[1]))})`);
  const perms = calls("perm");
  ok(perms.length >= 1 && perms.every((c) => c[1] === true), `permission is asked add-only, never Full Access (${JSON.stringify(perms.map((c) => c[1]))})`);
  ok(calls("createAlbum").length + calls("getAlbum").length + calls("addToAlbum").length === 0, "no album is made or looked for");
  ok(p && p !== "TIMEOUT" && p.data === "SMALLB64" && p.mediaType === "image/jpeg", "the work order gets the smaller copy, as JPEG");
  ok(p && p.category === "issue" && p.zoneNumber === 3 && p.label === "zone_3", "…carrying the zone and label it was taken for");
  const m = calls("manip")[0];
  ok(m && m[1] === "file:///cam/original.jpg", "the smaller copy is made from the original");
  ok(m && m[2].some((o) => o[0] === "resize" && (o[1].width === 2400 || o[1].height === 2400)), `shrink on: resized to 2400 px on the long edge (${JSON.stringify(m?.[2])})`);
  ok(m && m[3].compress === 0.75 && m[3].format === "jpeg" && m[3].base64 === true, `…at JPEG 0.75 (${JSON.stringify(m?.[3])})`);
  ok(p && p.resized === true, "…and says it is already resized, so the closing screen does not shrink it twice");
}

// 2. Shrink off: no resize, today's upload quality.
{
  const p = await take({}, { shrink: false });
  const m = calls("manip")[0];
  ok(m && !m[2].some((o) => o[0] === "resize") && m[3].compress === 0.4, `shrink off: not resized, JPEG 0.40 (${JSON.stringify(m?.[2])} ${JSON.stringify(m?.[3])})`);
  ok(p && p.data === "SMALLB64" && !p.resized, "…and the work order gets that copy");
  ok(calls("save").length === 1, "the original is still saved to the library");
}

// 3. Never blocks the work order.
{
  let p = await take({ denied: true }, { shrink: true });
  ok(p && p.data === "SMALLB64", "Photos access refused: the work order still gets its photo");
  ok(calls("save").length === 0, "…and nothing is saved");
  ok(calls("alert").length === 1, "…with one quiet note");
  reset({ denied: true });
  await photos.takePhoto(meta, { shrink: true });
  await flush();
  ok(calls("alert").length === 0, "…once — not again on the next photo");

  p = await take({ saveThrows: true }, { shrink: true });
  ok(p && p.data === "SMALLB64", "the save throws: the work order still gets its photo");
  p = await take({ permThrows: true }, { shrink: true });
  ok(p && p.data === "SMALLB64", "asking permission throws: the work order still gets its photo");
  p = await take({ hang: true }, { shrink: true });
  ok(p && p !== "TIMEOUT" && p.data === "SMALLB64", "the save never finishes: the work order is not kept waiting");
}

// 4. A failed resize still gives the work order a photo.
{
  const p = await take({ resizeThrows: true }, { shrink: true });
  ok(p && p !== "TIMEOUT" && p.data === "ORIGB64", "the resize fails: the original goes to the work order instead");
  ok(p && p.mediaType === "image/jpeg" && !p.resized, "…labelled as what it is, and not marked resized");
  ok(calls("save").length === 1, "…and is still saved to the library");
}

// 5. Backing out of the camera.
{
  const p = await take({ cancel: true }, { shrink: true });
  ok(p === null, "backing out of the camera returns nothing");
  ok(calls("save").length === 0 && calls("perm").length === 0, "…and touches the photo library not at all");
}

// 6. A photo chosen from the library is never saved again.
{
  reset({});
  const p = await photos.pickPhoto?.(meta, { shrink: true });
  await flush();
  ok(p && p.data === "PICKB64", "a library pick still attaches");
  ok(calls("save").length === 0 && calls("createAsset").length === 0 && calls("perm").length === 0, "…and is never saved to the library again");
}

// 7. The closing screen does not shrink an already-resized photo twice.
{
  const closing = fs.readFileSync(path.join(SRC, "screens", "ClosingScreen.js"), "utf8");
  ok(/!resized && shrinkOn/.test(closing), "ClosingScreen skips the on-screen shrinker for a photo the camera path already resized");
  ok(/resized: _resized|delete [a-z]+\.resized|\{ resized[^}]*\.\.\./.test(closing), "…and the `resized` marker never goes up with the photo");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`test-photos-save-to-library: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
