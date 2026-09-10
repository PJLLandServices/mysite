// What a picked photo is declared to be (field app).
//
//   node scripts/test-media-type.mjs
//
// WHAT THIS PROTECTS. The server verifies an uploaded photo's declared
// mediaType against its magic bytes and rejects a mismatch outright. The
// app used to declare 'image/jpeg' on everything, so an iPhone HEIC from
// the photo library — the default format an iPhone stores — was refused
// with "File 1 doesn't look like a real image/jpeg." It was intermittent,
// because a camera capture often IS a JPEG, which is the worst kind of
// bug: it works in testing and fails on a driveway with the water already
// off.
//
// So every case here is a real thing an iPhone hands back, and the
// mapping is checked against the server's OWN whitelist so the two cannot
// drift: a type this module can emit and the server would reject is a
// failed upload in the field.

import { createRequire } from "node:module";
import { mediaTypeOf } from "../pjl-field/src/media-type.js";

const require = createRequire(import.meta.url);
const fs = require("node:fs");
const path = require("node:path");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; } else { failed++; console.error("  ✗ FAIL:", label); }
}
function eq(a, b, label) { ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

// ---- 1. the bug: HEIC must be declared HEIC ---------------------------
eq(mediaTypeOf({ mimeType: "image/heic" }), "image/heic",
  "a HEIC from the photo library is declared HEIC, not JPEG");
eq(mediaTypeOf({ fileName: "IMG_0042.HEIC" }), "image/heic",
  "no mimeType — the .HEIC extension still gives the truth");
eq(mediaTypeOf({ uri: "file:///var/mobile/IMG_0042.heic" }), "image/heic",
  "a uri is enough when there is no filename either");

// ---- 2. the other things an iPhone hands back -------------------------
eq(mediaTypeOf({ mimeType: "image/jpeg" }), "image/jpeg", "a camera JPEG stays JPEG");
eq(mediaTypeOf({ mimeType: "image/png" }), "image/png", "a screenshot is PNG");
eq(mediaTypeOf({ fileName: "shot.PNG" }), "image/png", "extension case does not matter");
eq(mediaTypeOf({ mimeType: "IMAGE/HEIF" }), "image/heif", "mimeType case does not matter");
eq(mediaTypeOf({ mimeType: "image/jpeg; charset=binary" }), "image/jpeg",
  "a parameterised mimeType is trimmed to the type");
eq(mediaTypeOf({ uri: "file:///x/y.jpg?width=100" }), "image/jpeg",
  "a query string does not become part of the extension");

// ---- 3. falling back safely -------------------------------------------
eq(mediaTypeOf({}), "image/jpeg", "nothing to go on falls back to JPEG");
eq(mediaTypeOf(null), "image/jpeg", "a missing asset does not throw");
eq(mediaTypeOf({ fileName: "no-extension" }), "image/jpeg", "an extensionless name falls back");
eq(mediaTypeOf({ mimeType: "application/octet-stream", fileName: "a.heif" }), "image/heif",
  "a useless mimeType defers to the extension");
eq(mediaTypeOf({ mimeType: "application/pdf" }), "image/jpeg",
  "a non-image mimeType is not passed through — a picker returns images");
eq(mediaTypeOf({ mimeType: "image/tiff" }), "image/jpeg",
  "an image type the SERVER would reject is not passed through either");
eq(mediaTypeOf({ mimeType: "image/tiff", fileName: "scan.png" }), "image/png",
  "and the extension gets its say when the mimeType is unusable");

// ---- 4. the server would accept everything this can emit --------------
// Read the server's own work-order whitelist rather than restating it.
const serverSrc = fs.readFileSync(path.join(process.cwd(), "server", "server.js"), "utf8");
const block = serverSrc.match(/WO_MEDIA_MIME_WHITELIST\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
ok(!!block, "found WO_MEDIA_MIME_WHITELIST in the server");
const whitelist = new Set((block?.[1] || "").match(/"([^"]+)"/g)?.map((s) => s.slice(1, -1)) || []);
ok(whitelist.size > 0, "the whitelist parsed to something");

const everyOutput = [
  { mimeType: "image/heic" }, { mimeType: "image/heif" }, { mimeType: "image/jpeg" },
  { mimeType: "image/png" }, { mimeType: "image/webp" }, { mimeType: "image/gif" },
  { fileName: "a.jpg" }, { fileName: "a.jpeg" }, { fileName: "a.png" },
  { fileName: "a.heic" }, { fileName: "a.heif" }, { fileName: "a.webp" },
  { fileName: "a.gif" }, {},
  { mimeType: "image/tiff" }, { mimeType: "image/bmp" }, { mimeType: "image/avif" },
  { fileName: "a.tiff" }, { fileName: "a.bmp" }, { uri: "file:///a.dng" },
].map(mediaTypeOf);

const rejected = [...new Set(everyOutput)].filter((m) => !whitelist.has(m));
eq(rejected.join(", "), "", "every type this module can emit is one the server accepts");

console.log(`\nmedia-type: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
