// Getting a photo off the phone and into a work order.
//
// The server wants base64 with no data: prefix and a real mediaType it
// verifies against the file's MAGIC BYTES — so the declared type has to be
// the truth, not a hopeful default.
//
// This module used to hardcode 'image/jpeg' on every payload, with a
// comment claiming images were re-encoded as JPEG before they left the
// device. Nothing did that. An iPhone photo library hands back HEIC, and a
// screenshot hands back PNG, so the server saw JPEG in the envelope and
// something else in the bytes and refused it: "File 1 doesn't look like a
// real image/jpeg." Intermittently — a camera capture often does come back
// as JPEG, which is why it worked until it didn't. Say what the file
// actually is; the server's work-order whitelist takes JPEG, PNG, HEIC,
// WebP and GIF.

import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { mediaTypeOf } from './media-type';
import { saveOriginalToLibrary } from './photo-library';

// CHOOSE FROM LIBRARY. (The camera no longer uses these: see CAMERA below.)
// quality 0.40 (was 0.55), PJL-113: the upload is most of what a closing
// sends, and the server keeps a 2400 px re-encode at quality 82 of
// whatever arrives, so the extra detail at 0.55 was mostly discarded. This
// is the no-native-change step; resizing on the phone (to 2400 px, before
// upload) is the larger one and comes with the photo markup canvas.
const OPTIONS = {
  mediaTypes: ['images'],
  quality: 0.4,
  base64: true,
  exif: false,
  allowsEditing: false,
};

function toPayload(asset, meta) {
  if (!asset?.base64) return null;
  return {
    mediaType: mediaTypeOf(asset),
    data: asset.base64,
    ...meta,
  };
}

// With shrinking on (the server's photoShrink switch, PJL-112), the photo
// is taken at 0.80 and resized on the phone to 2400 px at 0.75 before it
// queues: a sharper source and a smaller upload (0.60 MB against 0.75 MB
// at 0.40, measured in test-photo-canvas.mjs on one 4032×3024 JPEG from
// the website's files — a stand-in, not a photo from Patrick's phone; the
// device check measures real ones). If the resize fails, the 0.80 original
// goes up as it is.
export const SHRINK_SOURCE_QUALITY = 0.8;
const options = ({ shrink = false } = {}) => (shrink ? { ...OPTIONS, quality: SHRINK_SOURCE_QUALITY } : OPTIONS);

// THE CAMERA (PJL-114, Patrick 2026-10-06). Every photo taken in the app is
// shot at FULL quality, and that full-size original is saved to the
// iPhone's photo library (photo-library.js: add-only, never awaited here,
// so a refused or slow save never holds up the work order). The work order
// gets its own, smaller copy, made on the phone from the original:
//   - shrink on (the server's photoShrink switch): 2400 px on the long edge,
//     JPEG 0.75 — PJL-112's target — and marked `resized`, so the closing
//     screen does not run it through the on-screen shrinker a second time;
//   - shrink off: full size, JPEG 0.40, which is what the camera used to
//     shoot for every upload.
// If making the copy fails, the original itself goes to the work order:
// bigger, but the photo is never lost.
const CAMERA = {
  mediaTypes: ['images'],
  quality: 1,
  base64: false,
  exif: false,
  allowsEditing: false,
};
export const UPLOAD_EDGE = 2400;
export const UPLOAD_QUALITY = { shrink: 0.75, full: 0.4 };

async function uploadCopy(asset, meta, { shrink = false } = {}) {
  let ref = null;
  try {
    const ctx = ImageManipulator.manipulate(asset.uri);
    const w = Number(asset.width) || 0;
    const h = Number(asset.height) || 0;
    if (shrink && Math.max(w, h) > UPLOAD_EDGE) {
      ctx.resize(w >= h ? { width: UPLOAD_EDGE } : { height: UPLOAD_EDGE });
    }
    ref = await ctx.renderAsync();
    const out = await ref.saveAsync({
      compress: shrink ? UPLOAD_QUALITY.shrink : UPLOAD_QUALITY.full,
      format: SaveFormat.JPEG,
      base64: true,
    });
    if (!out?.base64) throw new Error('no image data');
    return { mediaType: 'image/jpeg', data: out.base64, ...meta, ...(shrink ? { resized: true } : {}) };
  } catch {
    const data = await new File(asset.uri).base64();
    return { mediaType: mediaTypeOf(asset), data, ...meta };
  } finally {
    try { ref?.release?.(); } catch {}
  }
}

// Returns a photo payload, or null when the tech backed out — backing
// out is a normal outcome, not an error to report.
export async function takePhoto(meta = {}, opts) {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    throw new Error('Camera access is off for PJL Field. Turn it on in Settings → PJL Field.');
  }
  const result = await ImagePicker.launchCameraAsync(CAMERA);
  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset?.uri) return null;
  // Not awaited: the work order never waits on the photo library.
  saveOriginalToLibrary(asset.uri);
  return uploadCopy(asset, meta, opts);
}

export async function pickPhoto(meta = {}, opts) {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    throw new Error('Photo access is off for PJL Field. Turn it on in Settings → PJL Field.');
  }
  const result = await ImagePicker.launchImageLibraryAsync(options(opts));
  if (result.canceled) return null;
  return toPayload(result.assets?.[0], meta);
}
