// Native-independent durable outbox. Mutations commit synchronously before
// notifying a screen. The network never owns the only copy of field evidence.
const copy = value => JSON.parse(JSON.stringify(value));
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value ?? null;
};
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
// The server adds issue ids/default fields when hydrating a zone. Those
// additions do not mean the submitted assessment was rejected.
const includesSubmitted = (actual, submitted) => {
  if (Array.isArray(submitted)) return Array.isArray(actual) && actual.length === submitted.length && submitted.every((v, i) => includesSubmitted(actual[i], v));
  if (submitted && typeof submitted === 'object') return !!actual && Object.entries(submitted).every(([k, v]) => includesSubmitted(actual[k], v));
  return equal(actual, submitted);
};
const issue = (message, code) => Object.assign(new Error(message), { code });

export function createQueue({ store, transport }) {
  let state = store.read() || { version: 1, sequence: 0, records: {}, pending: [], drafts: {}, errors: {} };
  if (state.version !== 1) throw new Error('This phone has an unsupported offline database. Keep the app installed and contact support.');
  let draining = null;
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) { try { fn(); } catch {} } };
  const commit = fn => {
    const next = copy(state);
    fn(next);
    store.write(next); // A full disk must NOT become an optimistic success.
    state = next;
    emit();
  };
  const status = key => ({
    pending: state.pending.filter(p => p.key === key).length,
    drafts: Object.keys(state.drafts[key] || {}).filter(name => name.startsWith('zone:')).length,
    error: state.errors[key] || null,
    syncing: !!draining,
  });
  const view = key => {
    if (!state.records[key]) return null;
    const value = copy(state.records[key]);
    if (key.startsWith('wo:') && value.property?.id && state.records[`prop:${value.property.id}`]) {
      value.property = view(`prop:${value.property.id}`);
    }
    for (const p of state.pending.filter(p => p.key === key)) {
      if (p.kind === 'patch') Object.assign(value, copy(p.patch));
      if (p.kind === 'photo' && !(value.photos || []).some(x => x.clientUploadId === p.id)) {
        value.photos = [...(value.photos || []), { ...p.preview, n: p.id, clientUploadId: p.id, pending: true }];
      }
    }
    return value;
  };
  const requireRecord = key => {
    const value = view(key);
    if (!value) throw new Error('Open this record while connected before editing it offline.');
    return value;
  };
  const patch = (key, values) => {
    const before = requireRecord(key);
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => !equal(before[k], v)));
    if (!Object.keys(changed).length) return view(key);
    commit(s => {
      s.pending.push({ id: `edit-${++s.sequence}`, key, kind: 'patch', patch: copy(changed),
        before: Object.fromEntries(Object.keys(changed).map(k => [k, before[k] ?? null])) });
    });
    return view(key);
  };
  const photo = (key, payload) => {
    requireRecord(key);
    const id = `field-${Date.now().toString(36)}-${(state.sequence + 1).toString(36)}-${Math.random().toString(36).slice(2)}`;
    const full = { ...payload, clientUploadId: id };
    store.putBlob(id, full); // Orphan on failed queue commit is safe; losing bytes is not.
    const { data, ...preview } = full;
    commit(s => { s.sequence++; s.pending.push({ id, key, kind: 'photo', preview }); });
    return view(key);
  };
  const acknowledge = (entry, remote) => {
    commit(s => {
      s.records[entry.key] = copy(remote);
      s.pending = s.pending.filter(p => p.id !== entry.id);
      // Rebase the next edit's comparison onto the acknowledged normalized
      // record, but only where it was based on this exact submitted value.
      if (entry.kind === 'patch') {
        for (const [field, submitted] of Object.entries(entry.patch)) {
          const next = s.pending.find(p => p.key === entry.key && p.kind === 'patch' && field in p.patch);
          if (next && equal(next.before[field], submitted)) next.before[field] = copy(remote[field] ?? null);
        }
      }
      delete s.errors[entry.key];
    });
    if (entry.kind === 'photo') { try { store.deleteBlob(entry.id); } catch {} }
  };
  const flush = ({ retry = false } = {}) => {
    if (draining) return draining;
    draining = (async () => {
      const blocked = new Set(Object.entries(state.errors)
        .filter(([, e]) => !retry && !['network', 'auth'].includes(e.code)).map(([key]) => key));
      try {
        if (!(await transport.verifyOwner())) throw issue('Sign in with the account that recorded this work.', 'auth');
        while (true) {
          const entry = state.pending.find(p => !blocked.has(p.key));
          if (!entry) break;
          try {
            if (!(await transport.verifyOwner())) throw issue('Sign in with the account that recorded this work.', 'auth');
            const remote = await transport.read(entry.key);
            if (!remote) throw issue('The server no longer has this record. Your local copy is retained.', 'missing');
            let result;
            if (entry.kind === 'photo') {
              if ((remote.photos || []).some(p => p.clientUploadId === entry.id)) result = remote;
              else {
                const bytes = store.getBlob(entry.id);
                if (!bytes) throw issue('The locally recorded photo cannot be read. Keep the app installed.', 'storage');
                result = await transport.photo(entry.key, bytes);
              }
            } else {
              const changes = {};
              for (const [field, value] of Object.entries(entry.patch)) {
                if (includesSubmitted(remote[field], value)) continue; // Accepted, response lost.
                if (!equal(remote[field], entry.before[field])) {
                  throw issue(`The office changed ${field}. Your field copy is retained; review both before syncing.`, 'conflict');
                }
                changes[field] = value;
              }
              if (Object.keys(changes).length && entry.key.startsWith('wo:') && ['completed', 'cancelled', 'no_show'].includes(remote.status)) {
                throw issue('This visit has been closed on the server. Your field changes are retained for review.', 'closed');
              }
              result = Object.keys(changes).length
                ? await transport.patch(entry.key, changes, remote.updatedAt)
                : remote;
            }
            acknowledge(entry, result);
          } catch (err) {
            blocked.add(entry.key);
            commit(s => { s.errors[entry.key] = { message: err.message || 'Waiting for connection', code: err.code || 'network' }; });
          }
        }
      } catch (err) {
        commit(s => {
          for (const p of s.pending) s.errors[p.key] = { message: err.message, code: err.code || 'network' };
        });
      }
    })().finally(() => { draining = null; emit(); });
    return draining;
  };
  return {
    view, patch, photo, status, flush,
    seed(key, remote) {
      const currentTime = Date.parse(state.records[key]?.updatedAt);
      const incomingTime = Date.parse(remote.updatedAt);
      if (!(Number.isFinite(currentTime) && Number.isFinite(incomingTime) && incomingTime < currentTime)) {
        commit(s => { s.records[key] = copy(remote); });
      }
      return view(key);
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    keys: () => Object.keys(state.records),
    draft(key, name, value) { commit(s => { s.drafts[key] ||= {}; s.drafts[key][name] = copy(value); }); },
    getDraft: (key, name) => copy(state.drafts[key]?.[name] ?? null),
    clearDraft(key, name) { commit(s => { if (s.drafts[key]) delete s.drafts[key][name]; }); },
    photoPayload: id => store.getBlob(id),
  };
}
