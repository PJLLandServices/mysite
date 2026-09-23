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

// Three-way merge of one field: `base` is what this edit was made against,
// `mine` is the edit, `theirs` is what the server has now.
//
// The whole `zones` array (and the whole property `system` object) used to
// count as ONE field, so the office renaming Zone 4 while the tech marked
// Zone 2 done offline was a "conflict" nothing on the phone could resolve —
// Finish blocked forever (fall-closing fix #6). Now objects merge key by
// key and zone lists merge zone by zone (keyed by `number`), so edits to
// different zones or different fields both survive. Only the SAME leaf
// changed two different ways is a conflict, and `prefer` ('mine' |
// 'theirs') is the tech's answer to it.
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
// Lists merged element by element: zone rows (keyed by kind + number) and
// anything whose elements carry a string id (a zone's `issues`).
//
// Round 2: valve-box / controller rows all carry number 0, so keying on
// `number` alone collapsed them into one and the merge dropped rows. A
// row's key is its kind and number, plus its position among rows with the
// same kind and number — unique, and stable while the list is edited.
const isKeyedList = v => Array.isArray(v) && v.every(x => isObject(x) && (x.number != null || typeof x.id === 'string'));
const listKeys = list => {
  const seen = new Map();
  return (list || []).map((x) => {
    const base = typeof x.id === 'string' && x.number == null
      ? `id:${x.id}`
      : `${x.kind || 'zone'}:${x.number}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  });
};
const keyLabel = k => (k.startsWith('zone:') ? `zone ${k.slice(5)}` : k.startsWith('id:') ? `finding ${k.slice(3)}` : k.replace(':', ' '));
// The server's own bookkeeping stamp (fix #5: a finding copied to the
// property). It is never an office edit, and never a reason to conflict.
const withoutStamp = v => {
  if (Array.isArray(v)) return v.map(withoutStamp);
  if (isObject(v)) { const { deferredId, ...rest } = v; return Object.fromEntries(Object.entries(rest).map(([k, x]) => [k, withoutStamp(x)])); }
  return v;
};
function merge3(base, mine, theirs, prefer, path, conflicts) {
  if (equal(mine, theirs)) return mine;
  if (equal(mine, base)) return theirs;
  if (equal(theirs, base)) return mine;
  if (isObject(mine) && isObject(theirs) && (base == null || isObject(base))) {
    const b = base || {};
    const out = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(b)])) {
      const v = merge3(b[k], mine[k], theirs[k], prefer, [...path, k], conflicts);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (isKeyedList(mine) && isKeyedList(theirs) && (base == null || isKeyedList(base))) {
    const byKey = list => { const keys = listKeys(list); return new Map((list || []).map((x, i) => [keys[i], x])); };
    const B = byKey(base), M = byKey(mine), T = byKey(theirs);
    // The server's order, then anything only the phone has, in its order.
    const out = [];
    for (const k of new Set([...T.keys(), ...M.keys()])) {
      const v = merge3(B.get(k), M.get(k), T.get(k), prefer, [...path, keyLabel(k)], conflicts);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
  // The office's only change was the server's stamp: the phone's edit
  // (including removing the row) stands.
  if (equal(withoutStamp(theirs), withoutStamp(base))) return mine;
  // `prefer` is the tech's answer for the clashes they were SHOWN, by path
  // (PJL-98 gap 4). A plain string is the older, whole-record answer that
  // a phone may still carry from the previous release.
  const where = path.join(' › ');
  const choice = typeof prefer === 'string' ? prefer : prefer?.[where];
  if (choice === 'mine') return mine;
  if (choice === 'theirs') return theirs;
  // Both values travel with the clash, so "Keep mine" can keep the office's
  // in the visit notes instead of throwing it away.
  conflicts.push({ path: where, mine: mine ?? null, theirs: theirs ?? null });
  return mine;
}

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
  // Which zone drafts still count as unrecorded work (PJL-98 gap 2). A
  // draft written against a zone that has since left the visit — the phone
  // removed it, or the OFFICE did — can never be opened again, so it must
  // not hold sign-off; it is kept for the Finish note instead. "Written
  // against" is stamped when the draft is saved (`draftZones`), so a draft
  // for a zone this phone never listed still blocks, as it always did.
  const zoneDrafts = key => {
    const names = Object.keys(state.drafts[key] || {}).filter(name => name.startsWith('zone:'));
    const onVisit = new Set((view(key)?.zones || []).map(z => String(z?.number)));
    const seen = state.draftZones?.[key] || {};
    const stale = names.filter(name => seen[name] && !onVisit.has(name.slice(5)));
    return { live: names.filter(name => !stale.includes(name)), stale };
  };
  const status = key => ({
    pending: state.pending.filter(p => p.key === key).length,
    drafts: zoneDrafts(key).live.length,
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
  // `clearDrafts`: drafts to drop in the SAME commit (a note that carries a
  // draft's text must not be written without the draft going, or twice).
  const patch = (key, values, { clearDrafts = [] } = {}) => {
    const before = requireRecord(key);
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => !equal(before[k], v)));
    if (!Object.keys(changed).length) return view(key);
    // A zone taken off the visit takes its unfinished draft with it. Left
    // behind, a `zone:N` draft for a zone that no longer exists blocked
    // sign-off forever — nothing on screen could open it (fall-closing #6).
    const removedZones = Array.isArray(changed.zones) && Array.isArray(before.zones)
      ? before.zones.map(z => String(z?.number)).filter(n => !changed.zones.some(z => String(z?.number) === n))
      : [];
    commit(s => {
      s.pending.push({ id: `edit-${++s.sequence}`, key, kind: 'patch', patch: copy(changed),
        before: Object.fromEntries(Object.keys(changed).map(k => [k, before[k] ?? null])) });
      for (const name of [...removedZones.map(n => `zone:${n}`), ...clearDrafts]) {
        if (s.drafts[key]) delete s.drafts[key][name];
        if (s.draftZones?.[key]) delete s.draftZones[key][name];
      }
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
  // `sent`: what actually went to the server for each field (a merge of the
  // tech's edit and the office's changes), when anything was sent.
  const acknowledge = (entry, remote, sent = {}) => {
    commit(s => {
      s.records[entry.key] = copy(remote);
      s.pending = s.pending.filter(p => p.id !== entry.id);
      // Rebase the next edit's comparison onto the acknowledged normalized
      // record, but only where it was based on this exact submitted value —
      // and only when the server's copy IS that value (plus its own ids and
      // defaults). If office changes were merged in, the next edit was made
      // without them; rebasing onto them would make its stale copy look like
      // a deliberate undo, and the office's edit would be reverted in
      // silence (PJL-98 gap 1). Left un-rebased, the next edit merges
      // against the office's change like any other.
      if (entry.kind === 'patch') {
        for (const [field, submitted] of Object.entries(entry.patch)) {
          const next = s.pending.find(p => p.key === entry.key && p.kind === 'patch' && field in p.patch);
          const onlyMine = (!(field in sent) || equal(sent[field], submitted)) && includesSubmitted(remote[field], submitted);
          if (next && onlyMine && equal(next.before[field], submitted)) next.before[field] = copy(remote[field] ?? null);
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
        .filter(([, e]) => !retry && !['network', 'auth', 'version_conflict'].includes(e.code)).map(([key]) => key));
      // version_conflict: the server's in-lock If-Match check refused a save
      // that raced another (fall-closing #1 round 2). The next pass re-reads
      // and merges, so it retries on its own like a network error.
      try {
        if (!(await transport.verifyOwner())) throw issue('Sign in with the account that recorded this work.', 'auth');
        while (true) {
          const entry = state.pending.find(p => !blocked.has(p.key));
          if (!entry) break;
          try {
            if (!(await transport.verifyOwner())) throw issue('Sign in with the account that recorded this work.', 'auth');
            const remote = await transport.read(entry.key);
            if (!remote) throw issue('The server no longer has this record. Your local copy is retained.', 'missing');
            let result, sent;
            if (entry.kind === 'photo') {
              if ((remote.photos || []).some(p => p.clientUploadId === entry.id)) result = remote;
              else {
                const bytes = store.getBlob(entry.id);
                if (!bytes) throw issue('The locally recorded photo cannot be read. Keep the app installed.', 'storage');
                result = await transport.photo(entry.key, bytes);
              }
            } else {
              const changes = {};
              const conflicts = [];
              for (const [field, value] of Object.entries(entry.patch)) {
                if (includesSubmitted(remote[field], value)) continue; // Accepted, response lost.
                if (equal(remote[field], entry.before[field])) { changes[field] = value; continue; }
                // The office moved this field too: merge instead of refusing.
                const merged = merge3(entry.before[field], value, remote[field], entry.prefer || null, [field], conflicts);
                if (!equal(merged, remote[field])) changes[field] = merged;
              }
              if (conflicts.length) {
                const paths = conflicts.map(c => c.path);
                throw Object.assign(issue(
                  `The office also changed ${paths.slice(0, 2).join(' and ')}${paths.length > 2 ? ` (+${paths.length - 2} more)` : ''}. Choose which version to keep.`,
                  'conflict'), { paths, clashes: conflicts, entryId: entry.id });
              }
              if (Object.keys(changes).length && entry.key.startsWith('wo:') && ['completed', 'cancelled', 'no_show'].includes(remote.status)) {
                throw issue('This visit has been closed on the server. Your field changes are retained for review.', 'closed');
              }
              sent = changes;
              result = Object.keys(changes).length
                ? await transport.patch(entry.key, changes, remote.updatedAt)
                : remote;
            }
            acknowledge(entry, result, sent);
          } catch (err) {
            blocked.add(entry.key);
            commit(s => { s.errors[entry.key] = { message: err.message || 'Waiting for connection', code: err.code || 'network',
              ...(err.paths ? { paths: err.paths, clashes: err.clashes, entryId: err.entryId } : {}) }; });
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
  // The tech's answer to a true conflict: keep the phone's version of the
  // contested parts, or take the office's. Everything that did not
  // conflict merges either way. The next flush applies it.
  //
  // The answer covers exactly what the tech was shown: the paths of the
  // edit that raised the clash. It used to be stamped on EVERY pending edit
  // of the record, deciding clashes nobody had seen (PJL-98 gap 4); a later
  // clash is now asked for like the first. `note` ({ key, field, text }) is
  // appended in the same commit — the office's overridden values.
  const resolveConflict = (key, prefer, { note } = {}) => {
    if (!['mine', 'theirs'].includes(prefer)) throw new Error('Choose mine or theirs.');
    const shown = state.errors[key]?.code === 'conflict' && state.errors[key].entryId && Array.isArray(state.errors[key].paths)
      ? state.errors[key] : null;
    const noted = note?.text ? view(note.key) : null;
    commit(s => {
      for (const p of s.pending) {
        if (p.key !== key || p.kind !== 'patch') continue;
        if (!shown) { p.prefer = prefer; continue; } // An error recorded by the previous release.
        if (p.id !== shown.entryId) continue;
        const answers = typeof p.prefer === 'string' || !p.prefer ? {} : { ...p.prefer };
        for (const path of shown.paths) answers[path] = prefer;
        p.prefer = answers;
      }
      delete s.errors[key];
      if (noted) {
        const current = noted[note.field] || '';
        s.pending.push({ id: `edit-${++s.sequence}`, key: note.key, kind: 'patch',
          patch: { [note.field]: current ? `${current}\n\n${note.text}` : note.text },
          before: { [note.field]: noted[note.field] ?? null } });
      }
    });
  };
  return {
    view, patch, photo, status, flush, resolveConflict,
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
    draft(key, name, value) {
      const onVisit = name.startsWith('zone:') && (view(key)?.zones || []).some(z => String(z?.number) === name.slice(5));
      commit(s => {
        s.drafts[key] ||= {}; s.drafts[key][name] = copy(value);
        if (onVisit) { s.draftZones ||= {}; (s.draftZones[key] ||= {})[name] = true; }
      });
    },
    getDraft: (key, name) => copy(state.drafts[key]?.[name] ?? null),
    clearDraft(key, name) {
      commit(s => { if (s.drafts[key]) delete s.drafts[key][name]; if (s.draftZones?.[key]) delete s.draftZones[key][name]; });
    },
    zoneDrafts,
    photoPayload: id => store.getBlob(id),
  };
}
