// The fall closing, as performed.
//
// Four stages rather than one scroll: start, water off, one page per
// zone, close-out. You move between them freely — the checkmarks happen
// after the work, not as a wizard driving you through it.
//
// Three things gate finishing, and they are the things that must be true
// of a closing: the water is off and recorded, every zone has been
// looked at, and the winterization steps are done. Findings are counted
// but never required — a property with nothing wrong is a valid closing.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { AuthRequiredError, deferIssues, getWorkOrder, patchWorkOrder } from '../api';
import { colors, radius, space, type } from '../theme';
import StartStage from './closing/StartStage';
import WaterOffStage from './closing/WaterOffStage';
import ZoneStage from './closing/ZoneStage';
import CloseOutStage from './closing/CloseOutStage';
import { CLOSEOUT_STEPS } from './closing/steps';

const STAGES = [
  { key: 'start', label: 'Start' },
  { key: 'water', label: 'Water' },
  { key: 'zones', label: 'Zones' },
  { key: 'closeout', label: 'Close-out' },
];

export default function ClosingScreen({ workOrderId, onExit, onOpenFullWorkOrder }) {
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
      if (data?.workOrder) setWo(data.workOrder);
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

  const finish = useCallback(() => {
    Alert.alert(
      'Finish fall closing?',
      findings
        ? `${findings} finding${findings === 1 ? '' : 's'} will be saved to the property for next spring, then you'll go to sign-off.`
        : "No findings recorded. You'll go straight to sign-off.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Finish',
          onPress: async () => {
            setSaving(true);
            try {
              // Findings move to the property FIRST. If sign-off is
              // abandoned afterwards the findings are still banked —
              // losing next spring's work because nobody was home to
              // sign would be the worst possible trade.
              if (findings) await deferIssues(workOrderId);
              onOpenFullWorkOrder(`/admin/work-order/${encodeURIComponent(workOrderId)}/tech`);
            } catch (err) {
              Alert.alert("Couldn't finish", err?.message || 'Please try again.');
            } finally {
              setSaving(false);
            }
          },
        },
      ]
    );
  }, [findings, workOrderId, onOpenFullWorkOrder]);

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

      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent} keyboardShouldPersistTaps="handled">
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
        ) : (
          <CloseOutStage {...shared} blockers={blockers} onFinish={finish} />
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
