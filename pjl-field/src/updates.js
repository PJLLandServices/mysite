// Making an over-the-air update actually arrive on the first relaunch,
// and making it visible which one is running.
//
// expo-updates' default behaviour surprises people: on launch it starts
// downloading a new bundle in the BACKGROUND and swaps it in on the
// launch after that. So the honest instruction would have been "force-
// quit and reopen twice", which nobody will remember at 7am. Checking
// explicitly on cold start and reloading collapses that to one relaunch.

import * as Updates from 'expo-updates';

// Cold-start only. Reloading mid-task would throw away whatever the tech
// was in the middle of, so this is never called from a foreground event.
export async function applyPendingUpdate() {
  if (__DEV__) return false;
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check?.isAvailable) return false;
    await Updates.fetchUpdateAsync();
    await Updates.reloadAsync();
    return true;
  } catch {
    // Offline, or Expo unreachable. The app keeps running the bundle it
    // has, which is the correct outcome for a truck in a dead zone.
    return false;
  }
}

// A short human label for the bundle actually running, so "did my update
// land?" is answerable by looking rather than by guessing.
export function runningVersionLabel() {
  try {
    if (Updates.isEmbeddedLaunch) return 'shipped with the build';
    if (!Updates.createdAt) return null;
    return new Date(Updates.createdAt).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return null;
  }
}
