// "What am I signing for?" — the page Patrick turns the phone around to show.
//
// A customer on a driveway, 2026-10-01: "I don't even know what I'm signing
// for." Until then the sign-off screen showed one fee line under the
// signature pad, and the invoice screen only a total. This is the visit as
// the CUSTOMER reads it: who and where, the work done zone by zone, and the
// charges line by line with HST and the total. Large type, nothing internal.
//
// THE NUMBERS ARE THE SERVER'S (GET /api/work-orders/:id/customer-summary).
// Before Finish it previews the invoice from the very calculation Finish
// drafts it from; after Finish it reads the invoice itself. So what the
// customer reads before signing is what they are billed. Nothing here
// prices, adds or rounds anything; a price PJL sets after the visit arrives
// with no numbers and is shown as exactly that.
//
// Fetched on every open, so a zone changed a minute ago is in it.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { AuthRequiredError, getCustomerSummary } from '../api';
import { money } from '../format';
import { colors, radius, space, type } from '../theme';

const amount = (n) => money(n) ?? '—';

const dateLabel = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
};

export default function CustomerSummary({ visible, workOrderId, onClose }) {
  const [summary, setSummary] = useState(null);
  const [state, setState] = useState('loading');   // loading | ready | auth | error

  const load = useCallback(async () => {
    if (!workOrderId) { setState('error'); return; }
    setState('loading');
    try {
      const s = await getCustomerSummary(workOrderId);
      if (!s) throw new Error('empty');
      setSummary(s);
      setState('ready');
    } catch (err) {
      setState(err instanceof AuthRequiredError ? 'auth' : 'error');
    }
  }, [workOrderId]);

  useEffect(() => {
    if (visible) load();
    else setSummary(null);
  }, [visible, load]);

  const s = summary;
  const pending = s?.pricePending === true;
  const paid = !pending && Number(s?.amountPaid) > 0;

  return (
    <Modal
      visible={Boolean(visible)}
      animationType="slide"
      // Full screen, not a sheet: the customer holds the phone and reads it,
      // and a sheet's swipe-to-dismiss is too easy to trigger by accident.
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.screen}>
        <View style={styles.bar}>
          <Text style={styles.brand}>PJL Land Services</Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            style={({ pressed }) => [styles.done, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel="Close the summary"
          >
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>

        {state === 'loading' ? (
          <View style={styles.centre}>
            <ActivityIndicator color={colors.brand} />
            <Text style={styles.centreBody}>Getting the details…</Text>
          </View>
        ) : state !== 'ready' ? (
          <View style={styles.centre}>
            <Text style={styles.centreTitle}>{state === 'auth' ? 'Not signed in' : "Couldn't load the details"}</Text>
            <Text style={styles.centreBody}>
              {state === 'auth'
                ? 'Sign in to PJL again, then reopen this.'
                : 'Check the connection and try again. Nothing has been signed or charged.'}
            </Text>
            {state === 'error' ? (
              <Pressable onPress={load} style={({ pressed }) => [styles.retry, pressed && styles.pressed]} accessibilityRole="button">
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            <Text style={styles.kicker}>{s.source === 'invoice' ? `Invoice ${s.invoiceId}` : 'What you are signing for'}</Text>
            <Text style={styles.hero}>{s.serviceLabel}</Text>
            <View style={styles.who}>
              {s.customerName ? <Text style={styles.whoName}>{s.customerName}</Text> : null}
              {s.address ? <Text style={styles.whoLine}>{s.address}</Text> : null}
              {dateLabel(s.visitDate) ? <Text style={styles.whoLine}>{dateLabel(s.visitDate)}</Text> : null}
            </View>

            {s.zones?.length ? (
              <View style={styles.block}>
                <Text style={styles.blockTitle}>Work done</Text>
                <View style={styles.card}>
                  {s.zones.map((z, i) => (
                    <View key={z.number} style={[styles.zone, i === s.zones.length - 1 && styles.last]}>
                      <Text style={styles.zoneName}>
                        {`Zone ${z.number}`}{z.location ? <Text style={styles.zoneWhere}>{`  ${z.location}`}</Text> : null}
                      </Text>
                      <Text style={[styles.zoneStatus, z.repairs?.length ? styles.zoneFlag : null]}>
                        {z.repairs?.length ? `${z.statusLabel}: ${z.repairs.join(', ')}` : z.statusLabel}
                      </Text>
                    </View>
                  ))}
                </View>
                {s.zones.some((z) => z.repairs?.length) ? (
                  <Text style={styles.note}>Repairs noted for next season are not charged today.</Text>
                ) : null}
              </View>
            ) : null}

            <View style={styles.block}>
              <Text style={styles.blockTitle}>Charges</Text>
              <View style={styles.card}>
                {(s.lines || []).map((l, i) => (
                  <View key={`${l.label}:${i}`} style={styles.line}>
                    <Text style={styles.lineLabel}>{l.qty > 1 ? `${l.label} × ${l.qty}` : l.label}</Text>
                    {pending ? null : <Text style={styles.lineAmount}>{amount(l.lineTotal)}</Text>}
                  </View>
                ))}
                {pending ? (
                  <View style={[styles.line, styles.last]}>
                    <Text style={styles.pendingText}>PJL confirms the price after the visit and sends the invoice.</Text>
                  </View>
                ) : (
                  <>
                    <View style={[styles.line, styles.sumTop]}>
                      <Text style={styles.sumLabel}>Subtotal</Text>
                      <Text style={styles.sumAmount}>{amount(s.subtotal)}</Text>
                    </View>
                    <View style={styles.line}>
                      <Text style={styles.sumLabel}>HST</Text>
                      <Text style={styles.sumAmount}>{amount(s.hst)}</Text>
                    </View>
                    <View style={[styles.line, !paid && styles.last]}>
                      <Text style={styles.totalLabel}>Total</Text>
                      <Text style={styles.totalAmount}>{amount(s.total)}</Text>
                    </View>
                    {paid ? (
                      <>
                        <View style={styles.line}>
                          <Text style={styles.sumLabel}>Paid</Text>
                          <Text style={styles.sumAmount}>{amount(s.amountPaid)}</Text>
                        </View>
                        <View style={[styles.line, styles.last]}>
                          <Text style={styles.totalLabel}>Still owing</Text>
                          <Text style={styles.totalAmount}>{amount(s.balanceDue)}</Text>
                        </View>
                      </>
                    ) : null}
                  </>
                )}
              </View>
            </View>

            {s.authorization ? <Text style={styles.authorization}>{s.authorization}</Text> : null}
            <Text style={styles.contact}>Questions? Call or text PJL at (905) 960-0181.</Text>

            <Pressable
              onPress={onClose}
              style={({ pressed }) => [styles.back, pressed && styles.pressed]}
              accessibilityRole="button"
            >
              <Text style={styles.backText}>Done — back to the visit</Text>
            </Pressable>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 56, paddingBottom: space.md, paddingHorizontal: space.lg,
    backgroundColor: colors.brand,
  },
  brand: { color: colors.onBrand, fontSize: 18, fontWeight: '700' },
  done: { minHeight: 44, minWidth: 72, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.18)', paddingHorizontal: space.lg },
  doneText: { color: colors.onBrand, fontSize: 17, fontWeight: '600' },
  pressed: { opacity: 0.6 },

  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.md },
  centreTitle: { ...type.title },
  centreBody: { ...type.body, color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
  retry: { minHeight: 48, paddingHorizontal: space.xl, borderRadius: radius.card, backgroundColor: colors.brand, justifyContent: 'center' },
  retryText: { color: colors.onBrand, fontSize: 17, fontWeight: '600' },

  content: { padding: space.lg, paddingBottom: 48, gap: space.lg },
  kicker: { ...type.section, color: colors.brand },
  hero: { fontSize: 30, fontWeight: '700', color: colors.text },
  who: { gap: 4 },
  whoName: { fontSize: 20, fontWeight: '600', color: colors.text },
  whoLine: { fontSize: 17, color: colors.textMuted, lineHeight: 23 },

  block: { gap: space.sm },
  blockTitle: { ...type.section, marginHorizontal: space.xs },
  card: { backgroundColor: colors.card, borderRadius: radius.card, overflow: 'hidden' },
  last: { borderBottomWidth: 0 },
  zone: { paddingHorizontal: space.lg, paddingVertical: 14, gap: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  zoneName: { fontSize: 18, fontWeight: '600', color: colors.text },
  zoneWhere: { fontSize: 17, fontWeight: '400', color: colors.textMuted },
  zoneStatus: { fontSize: 16, color: colors.textMuted, lineHeight: 22 },
  zoneFlag: { color: colors.warning, fontWeight: '600' },
  note: { ...type.caption, fontSize: 14, marginHorizontal: space.xs, lineHeight: 19 },

  line: {
    flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  lineLabel: { flex: 1, fontSize: 18, color: colors.text, lineHeight: 24 },
  lineAmount: { fontSize: 18, color: colors.text, fontVariant: ['tabular-nums'] },
  sumTop: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  sumLabel: { fontSize: 17, color: colors.textMuted },
  sumAmount: { fontSize: 17, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  totalLabel: { fontSize: 20, fontWeight: '700', color: colors.text },
  totalAmount: { fontSize: 22, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  pendingText: { flex: 1, fontSize: 17, color: colors.text, lineHeight: 24 },

  authorization: { fontSize: 16, color: colors.text, lineHeight: 23, marginHorizontal: space.xs },
  contact: { ...type.caption, fontSize: 14, marginHorizontal: space.xs },
  back: { minHeight: 56, borderRadius: radius.card, backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center' },
  backText: { color: colors.onBrand, fontSize: 18, fontWeight: '600' },
});
