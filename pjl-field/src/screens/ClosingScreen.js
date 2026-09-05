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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import {
  AuthRequiredError, completeWorkOrder, deferIssues, getWorkOrder,
  patchWorkOrder, signatureBypass,
} from '../api';
import { colors, radius, space, type } from '../theme';
import StartStage from './closing/StartStage';
import WaterOffStage from './closing/WaterOffStage';
import ZoneStage from './closing/ZoneStage';
import CloseOutStage from './closing/CloseOutStage';
import SignOffStage from './closing/SignOffStage';
import { CLOSEOUT_STEPS } from './closing/steps';

const STAGES = [
  { key: 'start', label: 'Start' },
  { key: 'water', label: 'Water' },
  { key: 'zones', label: 'Zones' },
  { key: 'closeout', label: 'Close-out' },
  { key: 'signoff', label: 'Sign-off' },
];

export default function ClosingScreen({ workOrderId, onExit, onFinished }) {
  const [wo, setWo] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [stage, setStage] = useState('start');
  const [zoneIndex, setZoneIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [unsaved, setUnsaved] = useState(false);

  const load = useCallback(async () => {
    try {
      setWo(await getWorkOrder(workOrderId));
      setState('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else { setError(err?.message || "Couldn't load this work order."); setState('error'); }
    }
  }, [workOrderId]);

  useEffect(() => { load(); }, [load]);

  // Optimistic: the screen shows the change immediately and the PATCH
  // follows. A failure raises the flag rather than silently reverting —
  // reverting under someone's thumb mid-visit is how you lose trust in a
  // tool you're standing in a garden with.
  const save = useCallback(async (patch) => {
    setWo((prev) => ({ ...prev, ...patch }));
    setSaving(true);
    try {
      const data = await patchWorkOrder(workOrderId, patch);
      // PATCH returns the work order alone. The GET that loaded this
      // screen decorated it with `property` and `lead`, and replacing the
      // whole object here threw those away on the first save — so a
      // screen that read wo.property worked once and then silently
      // stopped. Carry the decorations forward.
      if (data?.workOrder) {
        setWo((prev) => ({
          ...data.workOrder,
          property: prev?.property ?? null,
          lead: prev?.lead ?? null,
        }));
      }
      setUnsaved(false);
    } catch (err) {
      setUnsaved(true);
      Alert.alert("Didn't save", err?.message || 'That change is on the phone but not on the server yet.');
    } finally {
      setSaving(false);
    }
  }, [workOrderId]);

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

  // Close-out's Finish banks the findings and moves to sign-off. It does
  // NOT complete anything: findings move to the property FIRST, so that a
  // closing abandoned at sign-off — nobody home, dead battery, a customer
  // who wants to talk — still leaves next spring's work recorded. Losing
  // that because of who was standing on the lawn would be the worst
  // possible trade.
  const toSignOff = useCallback(() => {
    Alert.alert(
      'Finish the walk-through?',
      findings
        ? `${findings} finding${findings === 1 ? '' : 's'} will be saved to the property for next spring, then you'll go to sign-off.`
        : "No findings recorded. You'll go straight to sign-off.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          onPress: async () => {
            setSaving(true);
            try {
              if (findings) await deferIssues(workOrderId);
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
      const nowIso = new Date().toISOString();
      let data;
      if (result.mode === 'customer') {
        data = await completeWorkOrder(workOrderId, {
          signature: result.signature,
          arrivedAt: wo?.arrivedAt ? null : nowIso,
          departedAt: wo?.departedAt ? null : nowIso,
        });
      } else {
        await signatureBypass(workOrderId, { reason: result.reason, note: result.note });
        data = await completeWorkOrder(workOrderId, {
          arrivedAt: wo?.arrivedAt ? null : nowIso,
          departedAt: wo?.departedAt ? null : nowIso,
        });
      }
      const invoiceId = data?.cascade?.invoiceId || data?.cascade?.invoice?.id || null;
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
  }, [workOrderId, wo, onFinished]);

  if (state === 'loading') return <View style={styles.centre}><ActivityIndicator color={colors.brand} /></View>;
  if (state === 'auth') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Not signed in</Text>
        <Text style={styles.centreBody}>Open any other tab and sign in to PJL.</Text>
      </View>
    );
  }
  if (state === 'error') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Couldn't load</Text>
        <Text style={styles.centreBody}>{error}</Text>
        <Pressable onPress={load} style={styles.retry}><Text style={styles.retryText}>Try again</Text></Pressable>
      </View>
    );
  }

  // True only while a finger is on the signature pad. The pad lives in a
  // WebView, and a WebView does not stop the ScrollView around it from taking
  // the drag -- so without this the page scrolls under the customer's hand
  // while they are signing, and they sign a moving target.
  const [signing, setSigning] = useState(false);

  const shared = { wo, save, saving };

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Pressable onPress={onExit} hitSlop={10}><Text style={styles.back}>‹ Today</Text></Pressable>
        <Text style={styles.woId} numberOfLines={1}>{wo?.id || 'Work order'}</Text>
        <Text style={[styles.saveState, unsaved && styles.saveStateBad]}>
          {saving ? 'Saving…' : unsaved ? 'Not saved' : 'Saved'}
        </Text>
      </View>

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
