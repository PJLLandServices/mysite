// Saving a photo taken in PJL Field to the iPhone's photo library (PJL-114).
//
// Patrick, 2026-10-02: "The pictures that I am taking for the work order
// does not save to my phones photo library." And 2026-10-06: every photo
// taken in the app goes to Photos, full size — "just download them to the
// library", no album.
//
// ADD-ONLY, on purpose. `requestPermissionsAsync(true)` asks iOS for "add
// photos" and nothing else: the app can put a photo in the library and can
// never read one back. That is all saving needs. An album would need Full
// Access (Apple will not let an add-only or "Selected Photos" app create or
// find albums), which is why there is none.
//
// NEVER BLOCKS THE WORK ORDER. The caller does not await this: refused,
// throwing or slow, the photo still goes to the work order. Anything short
// of a saved photo is noted once per app run, quietly, and never again.

import * as MediaLibrary from 'expo-media-library';
import { Alert } from 'react-native';

let noticeShown = false;

function noteOnce(refused) {
  if (noticeShown) return;
  noticeShown = true;
  Alert.alert(
    refused ? 'Photos access is off' : "Couldn't save to Photos",
    refused
      ? 'Your photos still go to the work order. To also keep a copy in Photos, turn on Photos for PJL Field in iPhone Settings.'
      : 'Your photos still go to the work order. The copy in Photos was skipped this time.',
  );
}

// Resolves true when the photo is in the library, false otherwise. Never
// rejects.
export async function saveOriginalToLibrary(uri) {
  try {
    const perm = await MediaLibrary.requestPermissionsAsync(true);
    if (!perm?.granted) { noteOnce(true); return false; }
    await MediaLibrary.saveToLibraryAsync(uri);
    return true;
  } catch {
    noteOnce(false);
    return false;
  }
}

// Tests only: each case starts with the note unshown.
export function resetNoticeForTests() { noticeShown = false; }
