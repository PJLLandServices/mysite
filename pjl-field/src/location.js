// Where the tech was when they started the visit.
//
// Never a blocker. A refused permission, a phone with no fix, a basement
// — all of them return null and the visit starts anyway. arrivedAt still
// records when; this only adds where when the phone can honestly say.

import * as Location from 'expo-location';

export async function currentFix() {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    if (!pos?.coords) return null;
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
      capturedAt: new Date(pos.timestamp || Date.now()).toISOString(),
    };
  } catch {
    return null;
  }
}
