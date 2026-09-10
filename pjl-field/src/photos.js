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
import { mediaTypeOf } from './media-type';

const OPTIONS = {
  mediaTypes: ['images'],
  quality: 0.55,
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

// Returns a photo payload, or null when the tech backed out — backing
// out is a normal outcome, not an error to report.
export async function takePhoto(meta = {}) {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    throw new Error('Camera access is off for PJL Field. Turn it on in Settings → PJL Field.');
  }
  const result = await ImagePicker.launchCameraAsync(OPTIONS);
  if (result.canceled) return null;
  return toPayload(result.assets?.[0], meta);
}

export async function pickPhoto(meta = {}) {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    throw new Error('Photo access is off for PJL Field. Turn it on in Settings → PJL Field.');
  }
  const result = await ImagePicker.launchImageLibraryAsync(OPTIONS);
  if (result.canceled) return null;
  return toPayload(result.assets?.[0], meta);
}
