// What the phone shows when the app fails to start, instead of closing.
//
// WHY. Build 12 (2026-09-24) closed 0.35 s after every launch. The crash
// report said only that expo-updates' error recovery aborted on a
// JavaScript error during startup — with no older bundle to fall back to,
// it shuts the app. The error's own words never reached anyone: not the
// phone, not the report. A field app that vanishes on launch is the worst
// possible failure in a driveway, and the second worst is one that can't
// say why.
//
// So index.js starts the app through BootGuard (src/BootGuard.js), which
// catches an error while loading or rendering the app and shows this text
// on screen, selectable, so it can be read out or screenshotted. Pure
// functions, no imports, so the tests run them in plain Node.

const MAX_STACK_LINES = 12;

export function describeBootError(error, { phase = 'start', versionLines = [] } = {}) {
  const name = (error && error.name) || 'Error';
  const message = String((error && error.message) || error || 'Unknown error').slice(0, 800);
  const stack = String((error && error.stack) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(`${name}: ${message}`) && l !== message)
    .slice(0, MAX_STACK_LINES);
  return {
    title: 'PJL Field could not start',
    phase,
    summary: `${name}: ${message}`,
    stack,
    versionLines: Array.isArray(versionLines) ? versionLines.slice(0, 5) : [],
    advice: 'Screenshot this screen and send it to Claude. Nothing on the phone was deleted. The CRM website still works in Safari.',
  };
}

// The text block the screen renders (and a person copies).
export function bootErrorText(d) {
  if (!d) return '';
  return [d.summary, `(while: ${d.phase})`, '', ...d.stack, '', ...d.versionLines].join('\n').trim();
}

// Installs a global JS error handler that turns a FATAL error into a call
// to onFatal instead of React Native's default, which (in a release build
// under expo-updates) ends in an abort. Non-fatal errors still go to the
// previous handler. Returns an uninstall function. `errorUtils` is React
// Native's global ErrorUtils; absent (tests, web) → a no-op.
export function installFatalHandler(errorUtils, onFatal) {
  if (!errorUtils || typeof errorUtils.setGlobalHandler !== 'function') return () => {};
  const previous = typeof errorUtils.getGlobalHandler === 'function' ? errorUtils.getGlobalHandler() : null;
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal) {
      try { onFatal(error); return; } catch { /* fall through to the default */ }
    }
    if (typeof previous === 'function') previous(error, isFatal);
  });
  return () => { if (typeof previous === 'function') errorUtils.setGlobalHandler(previous); };
}
