// Which code this phone is actually running, in words and in a header.
//
// WHY. On 2026-09-23 the server was on main while every phone was still on
// JavaScript from before 2026-09-11: two publishes in a row had refused to
// go out and nothing on the phone said so. "App updated <time>" names a
// time, not a commit, so nobody could look at a phone and know which fixes
// it carried. This names the commit, the update, and the runtime — on the
// Today tab for a person, and on every request for the server's log.
//
// Pure functions, no imports, so the tests run them in plain Node. The app
// feeds them src/buildInfo.json (stamped by the build/update workflows)
// and the expo-updates constants; see clientVersion.js.
//
// buildInfo.json in git is a placeholder of nulls. A bundle that was never
// stamped says so ("commit unknown") rather than guessing — which is itself
// the answer to "did this come through the pipeline?".

const SAFE = /[^A-Za-z0-9._:#/+-]/g;
const clean = (v, max = 64) => (v == null ? '' : String(v).replace(SAFE, '').slice(0, max));

// info: buildInfo.json. updates: { isEmbeddedLaunch, updateId, runtimeVersion, channel, createdAt }.
export function describeClientVersion(info = {}, updates = {}) {
  const commit = clean(info?.commit, 40) || null;
  const embedded = updates?.isEmbeddedLaunch === true;
  const updateId = embedded ? null : (clean(updates?.updateId, 36) || null);
  return {
    commit,
    commitShort: commit ? commit.slice(0, 7) : null,
    source: clean(info?.source, 16) || null,      // "build" | "update"
    run: clean(info?.run, 12) || null,            // GitHub Actions run number
    ref: clean(info?.ref, 64) || null,
    stampedAt: clean(info?.stampedAt, 32) || null,
    embedded,
    updateId,
    runtimeVersion: clean(updates?.runtimeVersion, 64) || null,
    channel: clean(updates?.channel, 32) || null,
    updateCreatedAt: updates?.createdAt ? new Date(updates.createdAt).toISOString() : null,
  };
}

// One line per fact, for the footer of the Today tab.
export function clientVersionLines(v) {
  if (!v) return [];
  const from = v.source === 'build' ? 'TestFlight build' : v.source === 'update' ? 'over-the-air update' : 'unknown source';
  return [
    v.commit ? `Commit ${v.commitShort} · ${from}${v.run ? ` (run #${v.run})` : ''}` : 'Commit unknown — this bundle was not stamped',
    v.embedded ? 'Running the bundle shipped with the build' : `Update ${v.updateId ? v.updateId.slice(0, 8) : 'unknown'}`,
    `Runtime ${v.runtimeVersion ? v.runtimeVersion.slice(0, 8) : 'unknown'}${v.channel ? ` · ${v.channel}` : ''}`,
  ];
}

// The request header: `key=value;…`, every value from the SAFE set so it
// can never carry a separator or a newline into the server's log.
export const CLIENT_VERSION_HEADER = 'x-pjl-client';
export function clientVersionHeaderValue(v) {
  if (!v) return null;
  return [
    `commit=${v.commit || 'unknown'}`,
    `source=${v.source || 'unknown'}`,
    `run=${v.run || ''}`,
    `update=${v.embedded ? 'embedded' : (v.updateId || 'unknown')}`,
    `runtime=${v.runtimeVersion || 'unknown'}`,
    `channel=${v.channel || ''}`,
  ].join(';');
}
