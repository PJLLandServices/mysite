// The fall closing, as performed.
//
// Five stages rather than one scroll: start, water off, one page per
// zone, close-out, sign-off. You move between them freely — the
// checkmarks happen after the work, not as a wizard driving you through
// it.
//
// Three things gate finishing, and they are the things that must be true
// of a closing: the water is off and recorded, every zone has been
// looked at, and the winterization steps are done. Findings are counted
// but never required — a property with nothing wrong is a valid closing.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import {
  AuthRequiredError, completeWorkOrder, deferIssues, getWorkOrder, patchProperty,
  patchWorkOrder, signatureBypass,
} from '../api';
import { colors, radius, space, type } from '../theme';
import StartStage from './closing/StartStage';
import WaterOffStage from './closing/WaterOffStage';
import ZoneStage from './closing/ZoneStage';
import CloseOutStage from './closing/CloseOutStage';
import SignOffStage from './closing/SignOffStage';
import { CLOSEOUT_STEPS } from './closing/steps';
import { openFieldWorkOrder, watchFieldQueue, flushBeforeFinish, pendingPhotoUri, fieldStatus } from '../offline/field';

const STAGES = [
  { key: 'start', label: 'Start' },
  { key: 'water', label: 'Water' },
  { key: 'zones', label: 'Zones' },
  { key: 'closeout', label: 'Close-out' },
  { key: 'signoff', label: 'Sign-off' },
];

export default function ClosingScreen({ workOrderId, onExit, onFinished, onSignIn }) {
  const [wo, setWo] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [stage, setStage] = useState('start');
  const [zoneIndex, setZoneIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const field = useRef(null);
  const [syncState, setSyncState] = useState({ pending: 0, error: null });
  const [fieldContext, setFieldContext] = useState(null);
  // True only while a finger is on the signature pad. The pad lives in a
  // WebView, and a WebView does not stop the ScrollView around it from taking
  // the drag -- so without this the page scrolls under the customer's hand
  // while they are signing, and they sign a moving target.
  //
  // UP HERE WITH THE OTHER HOOKS, above the early returns below. It was
  // declared after them, which made it a conditional hook: eight hooks while
  // loading, nine once the work order arrived, and React refuses that. Every
  // work order crashed on open.
  const [signing, setSigning] = useState(false);

  const load = useCallback(async () => {
    try {
      const context = await openFieldWorkOrder(workOrderId);
      field.current = context;
      setFieldContext(context);
      setWo(context.workOrder);
      setState('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else { setError(err?.message || "Couldn't load this work order."); setState('error'); }
    }
  }, [workOrderId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!fieldContext) return;
    const { queue, key } = fieldContext;
    const refresh = () => {
      setWo(queue.view(key));
      setSyncState(fieldStatus(queue, key));
    };
    refresh();
    const unsubscribe = queue.subscribe(refresh);
    const stop = watchFieldQueue(queue);
    return () => { unsubscribe(); stop(); };
  }, [fieldContext]);

  // SQLite commits before the screen announces success. Uploading is a
  // separate serialized operation, and its responses reapply pending edits.
  const save = useCallback(async (patch) => {
    setSaving(true);
    try {
      const { queue, key } = field.current;
      queue.patch(key, patch);
      queue.clearDraft(key, 'signoff');
      setUnsaved(false);
      queue.flush().catch(() => {});
      return true;
    } catch (err) {
      setUnsaved(true);
      Alert.alert("Couldn't record on this phone", err?.message || 'Keep this screen open and try again.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [workOrderId]);

  const saveDraft = useCallback((name, value) => {
    try {
      field.current.queue.draft(field.current.key, name, value);
      if (name.startsWith('zone:')) field.current.queue.clearDraft(field.current.key, 'signoff');
      return true;
    } catch (err) {
      setUnsaved(true);
      Alert.alert("Couldn't record on this phone", err?.message || 'Keep this screen open.');
      return false;
    }
  }, []);
  const getDraft = useCallback(name => field.current?.queue.getDraft(field.current.key, name), []);
  const clearDraft = useCallback(name => field.current.queue.clearDraft(field.current.key, name), []);
  const attachPhoto = useCallback(async photo => {
    const { queue, key } = field.current;
    queue.photo(key, photo);
    queue.flush().catch(() => {});
  }, []);
  const photoUri = photo => pendingPhotoUri(field.current.queue, photo);

  // The system facts on the arrival screen belong to the PROPERTY, not to
  // this visit — which is why correcting one on a driveway in October is
  // still right the following April, and why it has to reach the CRM.
  //
  // A local-storage failure puts the old value back. A network failure
  // leaves the correction recorded on the phone, with the pending banner.
  const saveSystem = useCallback(async (patch) => {
    const propertyId = wo?.property?.id;
    if (!propertyId) return false;
    const before = wo.property;
    setWo((prev) => ({
      ...prev,
      property: { ...prev.property, system: { ...(prev.property?.system || {}), ...patch } },
    }));
    try {
      const { queue } = field.current;
      const key = `prop:${propertyId}`;
      queue.patch(key, { system: { ...(queue.view(key)?.system || {}), ...patch } });
      queue.flush().catch(() => {});
      return true;
    } catch (err) {
      setWo((prev) => ({ ...prev, property: before }));
      if (err instanceof AuthRequiredError) setState('auth');
      else {
        Alert.alert(
          "Couldn't record the property correction",
          err?.message || 'Keep the screen open and try again.',
        );
      }
      return false;
    }
  }, [wo]);

  const zones = useMemo(() => (Array.isArray(wo?.zones) ? wo.zones : []), [wo]);

  // A zone counts as done when it has a status — the same test the web
  // page uses for "reviewed" (work-order-tech.js:1423), so both surfaces
  // agree about what a walked zone is.
  const zonesDone = zones.filter((z) => z.status).length;
  const findings = zones.reduce((n, z) => n + (z.issues?.length || 0), 0);
  const checklist = wo?.serviceChecklist || {};
  const closeoutDone = CLOSEOUT_STEPS.filter((s) => checklist[s.key] === true).length
    + (wo?.backFlush ? 1 : 0);
  const closeoutTotal = CLOSEOUT_STEPS.length + 1;
  const waterDone = !!wo?.waterShutoffBy;

  const blockers = [];
  if (!waterDone) blockers.push('Record how the water was shut off');
  if (zones.length && zonesDone < zones.length) blockers.push(`${zones.length - zonesDone} zone${zones.length - zonesDone === 1 ? '' : 's'} still to do`);
  if (closeoutDone < closeoutTotal) blockers.push(`${closeoutTotal - closeoutDone} close-out step${closeoutTotal - closeoutDone === 1 ? '' : 's'} left`);

  // Close-out preserves the findings with this visit and opens sign-off.
  // The server transfer clears WO issues, so it must wait until all queued
  // zone edits have landed. The transfer runs before connected completion.
  const toSignOff = useCallback(() => {
    Alert.alert(
      'Finish the walk-through?',
      findings
        ? `${findings} finding${findings === 1 ? '' : 's'} are recorded with this visit. They move to the property when you finish while connected.`
        : "No findings recorded. You'll go straight to sign-off.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: async () => {
            setSaving(true);
            try {
              // Do not call the destructive server sweep while edits may
              // still be pending. It clears WO issues after transferring
              // them. Finish performs it once the outbox has drained.
              setStage('signoff');
            } catch (err) {
              Alert.alert("Couldn't save the findings", err?.message || 'Please try again.');
            } finally {
              setSaving(false);
            }
          },
        },
      ]
    );
  }, [findings, workOrderId]);

  // Sign-off's Finish. Both paths end with the completion cascade, which
  // writes the service record, promotes the zone names, drafts the
  // invoice, stamps the warranty and emails the customer — all
  // server-side, all in one transition to `completed`.
  //
  // A bypass locks the work order but does not complete it, so that path
  // is two calls. Deliberately in this order: lock first, complete second.
  // If the second fails the visit is still recorded as accepted and can be
  // completed from the desk; the reverse would leave a completed visit
  // with no record of how it was accepted.
  const [finishing, setFinishing] = useState(false);
  const finishSignOff = useCallback(async (result) => {
    setFinishing(true);
    try {
      const { queue, key } = field.current;
      queue.draft(key, 'signoff', result);
      await flushBeforeFinish(queue, key);
      const freshBeforeFinish = await getWorkOrder(workOrderId);
      if (freshBeforeFinish.zones?.some(z => z.issues?.length)) await deferIssues(workOrderId);
      const nowIso = new Date().toISOString();
      let data;
      if (result.mode === 'customer') {
        data = await completeWorkOrder(workOrderId, {
          signature: result.signature,
          arrivedAt: wo?.arrivedAt ? null : nowIso,
          departedAt: wo?.departedAt ? null : nowIso,
        });
      } else {
        // If the prior attempt lost its response after locking, continue
        // from that accepted state rather than trying to bypass twice.
        const current = await getWorkOrder(workOrderId);
        if (!current.signatureBypass) await signatureBypass(workOrderId, { reason: result.reason, note: result.note });
        data = await completeWorkOrder(workOrderId, {
          arrivedAt: wo?.arrivedAt ? null : nowIso,
          departedAt: wo?.departedAt ? null : nowIso,
        });
      }
      const invoiceId = data?.cascade?.invoiceId || data?.cascade?.invoice?.id || null;
      queue.clearDraft(key, 'signoff');
      queue.seed(key, { ...wo, ...data?.workOrder });
      onFinished({ workOrder: data?.workOrder || wo, invoiceId });
    } catch (err) {
      // The server's own gate list, when it has one. These are the things
      // that can still be fixed standing here, so name them rather than
      // showing one sentence and no way forward.
      if (Array.isArray(err?.gateFailures) && err.gateFailures.length) {
        Alert.alert(
          'Not quite ready',
          err.gateFailures.map((g) => `• ${g.label || g.key}`).join('\n')
        );
      } else {
        Alert.alert("Couldn't finish", err?.message || 'Please try again.');
      }
    } finally {
      setFinishing(false);
    }
  }, [workOrderId, wo, onFinished, findings]);

  // The way out comes FIRST, and is rendered in every state including the
  // ones that render nothing else. This screen is an overlay now: it covers
  // the tab bar, so a state without this bar is a state you can only leave
  // by force-quitting the app. That is not a hypothetical — loading has no
  // timeout, and `auth` is reachable from a cold start in a driveway.
  const exitBar = (
    <View style={styles.bar}>
      <Pressable onPress={onExit} hitSlop={10}><Text style={styles.back}>‹ Back</Text></Pressable>
    </View>
  );

  if (state === 'loading') {
    return (
      <View style={styles.screen}>
        {exitBar}
        <View style={styles.centre}><ActivityIndicator color={colors.brand} /></View>
      </View>
    );
  }
  if (state === 'auth') {
    return (
      <View style={styles.screen}>
        {exitBar}
        <View style={styles.centre}>
          <Text style={styles.centreTitle}>Not signed in</Text>
          {/* Messages by name: auth rides the WebView cookie jar, so the
              web tab is the ONLY surface that can sign you in. "Any other
              tab" was three-fifths true when there were five tabs and is
              false now. */}
          <Text style={styles.centreBody}>Sign in to PJL to open this closing.</Text>
          <Pressable onPress={onSignIn} style={styles.retry}><Text style={styles.retryText}>Sign in</Text></Pressable>
        </View>
      </View>
    );
  }
  if (state === 'error') {
    return (
      <View style={styles.screen}>
        {exitBar}
        <View style={styles.centre}>
          <Text style={styles.centreTitle}>Couldn't load</Text>
          <Text style={styles.centreBody}>{error}</Text>
          <Pressable onPress={load} style={styles.retry}><Text style={styles.retryText}>Try again</Text></Pressable>
        </View>
      </View>
    );
  }

  if (['completed', 'cancelled', 'no_show'].includes(wo?.status)) {
    return (
      <View style={styles.screen}>
        {exitBar}
        <View style={styles.centre}>
          <Text style={styles.centreTitle}>This visit is closed</Text>
          <Text style={styles.centreBody}>Return to the schedule to view its record.</Text>
        </View>
      </View>
    );
  }

  const shared = { wo, save, saveSystem, saving, saveDraft, getDraft, clearDraft, attachPhoto, photoUri };

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Pressable onPress={onExit} hitSlop={10}><Text style={styles.back}>‹ Back</Text></Pressable>
        <Text style={styles.woId} numberOfLines={1}>{wo?.id || 'Work order'}</Text>
        <Text style={[styles.saveState, unsaved && styles.saveStateBad]}>
          {saving ? 'Recording…' : unsaved ? 'Not recorded' : syncState.pending ? `On phone · ${syncState.pending} pending` : syncState.drafts ? 'Draft on phone' : 'Synced'}
        </Text>
      </View>

      {syncState.pending > 0 ? (
        <Pressable onPress={() => {
          if (syncState.error?.code === 'auth') onSignIn();
          else field.current.queue.flush({ retry: true }).catch(() => {});
        }} style={styles.syncNotice}>
          <Text style={styles.syncText}>
            {syncState.error && syncState.error.code !== 'network'
              ? syncState.error.message
              : 'Recorded on this phone. Keep the app open when connected to sync. Tap to retry.'}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.tabs}>
        {STAGES.map((s) => {
          const active = stage === s.key;
          const badge =
            s.key === 'water' ? (waterDone ? '✓' : '')
            : s.key === 'zones' ? (zones.length ? `${zonesDone}/${zones.length}` : '')
            : s.key === 'closeout' ? `${closeoutDone}/${closeoutTotal}`
            : '';
          return (
            <Pressable key={s.key} onPress={() => setStage(s.key)} style={[styles.tab, active && styles.tabActive]}>
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{s.label}</Text>
              {badge ? <Text style={[styles.tabBadge, active && styles.tabLabelActive]}>{badge}</Text> : null}
            </Pressable>
          );
        })}
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={!signing}
      >
        {stage === 'start' ? (
          <StartStage {...shared} findings={findings} onNext={() => setStage('water')} />
        ) : stage === 'water' ? (
          <WaterOffStage {...shared} onNext={() => setStage('zones')} />
        ) : stage === 'zones' ? (
          zones.length ? (
            <ZoneStage
              {...shared}
              zoneIndex={Math.min(zoneIndex, zones.length - 1)}
              setZoneIndex={setZoneIndex}
              onDoneAll={() => setStage('closeout')}
            />
          ) : (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>No zones on this work order</Text>
              <Text style={styles.cardBody}>
                Nothing to walk. Add zones to the property record and reopen, or carry on to close-out.
              </Text>
            </View>
          )
        ) : stage === 'closeout' ? (
          <CloseOutStage {...shared} blockers={blockers} onFinish={toSignOff} />
        ) : (
          <SignOffStage {...shared} onFinish={finishSignOff} busy={finishing} onStrokeChange={setSigning} />
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, backgroundColor: colors.ground },
  centreTitle: { ...type.title, marginBottom: space.sm },
  centreBody: { ...type.label, textAlign: 'center', lineHeight: 21 },
  retry: { marginTop: space.lg, backgroundColor: colors.brand, paddingHorizontal: space.xl, paddingVertical: space.md, borderRadius: radius.card },
  retryText: { color: '#fff', fontWeight: '600' },

  bar: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  back: { color: colors.brand, fontSize: 17 },
  woId: { ...type.label, flex: 1, textAlign: 'center', fontWeight: '600', color: colors.text },
  saveState: { ...type.caption, minWidth: 62, textAlign: 'right' },
  saveStateBad: { color: colors.danger, fontWeight: '600' },
  syncNotice: { padding: space.md, backgroundColor: colors.warningTint },
  syncText: { ...type.label, color: colors.warning },

  tabs: { flexDirection: 'row', backgroundColor: colors.card, paddingHorizontal: space.sm, paddingBottom: space.sm, gap: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 7, borderRadius: radius.card, backgroundColor: colors.ground, gap: 1 },
  tabActive: { backgroundColor: colors.brand },
  tabLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  tabLabelActive: { color: '#fff' },
  tabBadge: { fontSize: 11, color: colors.textFaint, fontVariant: ['tabular-nums'] },

  body: { flex: 1 },
  bodyContent: { padding: space.md, paddingBottom: space.xl, gap: space.md },
  card: { backgroundColor: colors.card, borderRadius: radius.card, padding: space.lg, gap: 6 },
  cardTitle: { ...type.title },
  cardBody: { ...type.label, lineHeight: 21 },
});
