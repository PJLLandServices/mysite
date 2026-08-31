// Getting a photo off the phone and into a work order.
//
// The server wants base64 with no data: prefix, a real mediaType it can
// verify against the file's magic bytes, and nothing over its size cap —
// so images are downscaled and re-encoded as JPEG before they leave the
// device rather than shipped straight off the camera at 12 megapixels.
// A tech on rural cellular should not be uploading 8MB because nobody
// resized it.

import * as ImagePicker from 'expo-image-picker';

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
    mediaType: 'image/jpeg',
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
