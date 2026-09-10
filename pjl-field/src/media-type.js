// What a picked file actually is, in the server's vocabulary.
//
// The server verifies a photo's declared mediaType against its MAGIC
// BYTES, so the declared type has to be the truth. The photo module used
// to hardcode 'image/jpeg' on every payload while claiming in a comment
// that images were re-encoded to JPEG on the device. Nothing did that. An
// iPhone photo library hands back HEIC and a screenshot hands back PNG, so
// the server saw JPEG in the envelope and something else in the bytes and
// refused the upload: "File 1 doesn't look like a real image/jpeg."
// Intermittently, because a camera capture often IS a JPEG — which is why
// it worked until it didn't, on a driveway.
//
// Pure, so it can be tested without React Native.
// Covered by scripts/test-media-type.mjs.

// The work-order media whitelist on the server, minus PDF (a picker only
// ever hands back images).
const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  gif: 'image/gif',
};

// Prefer the asset's own mimeType; fall back to the file extension, which
// is all an older picker build gives us. JPEG is the last resort rather
// than the assumption — and it is a safe one, because the magic-bytes
// check catches a wrong guess rather than storing a corrupt file.
// Only ever emits a type from the table above. Passing an unrecognised
// `image/*` straight through would just move the rejection from here to
// the server, on a driveway, after the upload.
const KNOWN = new Set(Object.values(MIME_BY_EXT));

export function mediaTypeOf(asset) {
  const declared = String(asset?.mimeType || '').toLowerCase().split(';')[0].trim();
  if (KNOWN.has(declared)) return declared;
  const source = String(asset?.fileName || asset?.uri || '');
  const ext = source.split('?')[0].split('#')[0].split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'image/jpeg';
}
