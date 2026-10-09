// Referral — "send a neighbour or friend our way" (2026-10-09).
//
// Two things, on the sign-off, because that is the last stop before the
// invoice exists and Patrick's rule is that a referral has to be mentioned
// before it: "If I create the invoice it's not available."
//
//   * REFERRED BY — who sent this customer. Picking someone gives THAT
//     customer 10% off their next seasonal visit (the welcome email's
//     promise). This customer pays the normal price. Admin only; locked
//     once the visit has an invoice.
//   * THIS VISIT'S CREDIT — when this customer is a referrer, the 10% the
//     server will take off the closing fee, said out loud so the tech can
//     tell them.
//
// Everything here is the server's answer (GET /api/work-orders/:id/
// referral); nothing is worked out on the phone. Online only: offline it
// says so and the visit finishes as normal.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { getReferral, searchReferrers, setReferral } from '../../api';
import { money } from '../../format';
import { colors, radius, space, type } from '../../theme';
import { Pill, PickerSheet, SelectRow } from '../../ui';
import { Section } from './parts';

const NOBODY = '__nobody__';

export default function ReferralSection({ wo, role = null, busy = false }) {
  const [view, setView] = useState(null);
  const [failed, setFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!wo?.id) return;
    getReferral(wo.id)
      .then((d) => { setView(d); setFailed(false); })
      .catch(() => setFailed(true));
  }, [wo?.id]);
  useEffect(() => { load(); }, [load]);

  // Search as they type, a beat after the last key; only the newest answer
  // is shown.
  useEffect(() => {
    if (!picking || !wo?.id) return undefined;
    const term = q.trim();
    if (term.length < 2) { setResults([]); return undefined; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      searchReferrers(wo.id, term)
        .then((list) => { if (mine === seq.current) setResults(list); })
        .catch(() => { if (mine === seq.current) setResults([]); });
    }, 300);
    return () => clearTimeout(t);
  }, [q, picking, wo?.id]);

  if (failed) {
    return (
      <Section title="Referral" footer="Needs a connection. The visit finishes as normal without it.">
        <View style={styles.pad}><Text style={styles.muted}>Couldn't load the referral details.</Text></View>
      </Section>
    );
  }
  if (!view || !view.customerId) return null;

  const isAdmin = role === 'admin';
  const by = view.referredBy;
  const canChange = isAdmin && !view.locked && !busy && !saving;
  const note = view.locked
    ? (view.lockedReason === 'invoiced'
      ? 'Locked: this visit already has an invoice.'
      : view.lockedReason === 'recorded_elsewhere' ? 'Recorded on an earlier visit.' : null)
    : !isAdmin ? 'Only the office can record a referral.' : null;

  const choose = async (item) => {
    setPicking(false);
    setQ('');
    setResults([]);
    const id = item.key === NOBODY ? null : item.key;
    if ((by?.customerId || null) === id) return;
    setSaving(true);
    try {
      const next = await setReferral(wo.id, id);
      setView(next);
    } catch (err) {
      Alert.alert("Couldn't save the referral", `${err?.message || 'Nothing changed.'}`);
      load();
    } finally {
      setSaving(false);
    }
  };

  const options = [
    ...results.map((c) => ({ key: c.customerId, label: c.name || 'Customer', note: null, meta: null, sub: c.address })),
    ...(by ? [{ key: NOBODY, label: 'Nobody — remove the referral' }] : []),
  ].map((o) => (o.sub ? { ...o, label: `${o.label} · ${String(o.sub).split(',')[0]}` } : o));

  const used = (view.referred || []).filter((r) => r.state === 'available' || r.usedHere);
  const firstName = (wo?.customerName || 'They').split(' ')[0];

  return (
    <>
      <Section
        title="Referral"
        footer={by
          ? `${by.name || 'They'} gets 10% off their next seasonal visit. ${firstName} pays the normal price.`
          : 'Did someone send them to PJL? The person who referred them gets 10% off their next seasonal visit. Add it before the invoice is made.'}
      >
        <View style={styles.pad}>
          <SelectRow
            label="Referred by"
            value={saving ? 'Saving…' : by ? by.name || 'A customer' : ''}
            placeholder="Nobody (optional)"
            note={note}
            onPress={() => setPicking(true)}
            disabled={!canChange}
            accessibilityLabel={`Referred by. ${by ? by.name : 'Nobody'}.${note ? ` ${note}` : ''}`}
          />
        </View>
      </Section>

      {view.credit ? (
        <View style={styles.credit}>
          <Text style={styles.creditTitle}>Referral credit on this visit</Text>
          <Text style={styles.creditBody}>{`${money(view.credit.amount) ?? '—'} off the closing fee. ${String(view.credit.label || '').replace(/\.?$/, '.')}`}</Text>
        </View>
      ) : null}

      {used.length ? (
        <Section title={`${firstName} has referred`}>
          {used.map((r, i) => (
            <View key={r.referralId} style={[styles.row, i === used.length - 1 && styles.rowLast]}>
              <Text style={styles.rowLabel} numberOfLines={1}>{r.name || 'A customer'}</Text>
              <Pill tone={r.usedHere ? 'brand' : 'warn'}>{r.usedHere ? 'Using now' : 'Waiting · next visit'}</Pill>
            </View>
          ))}
        </Section>
      ) : null}

      <PickerSheet
        visible={picking}
        title={`Who referred ${firstName}?`}
        options={options}
        selectedKey={by?.customerId || null}
        onSelect={choose}
        onClose={() => { setPicking(false); setQ(''); setResults([]); }}
        search={{ value: q, onChangeText: setQ, placeholder: 'Name, street or phone' }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  pad: { padding: space.md },
  muted: { ...type.label },
  credit: { backgroundColor: colors.brandTint, borderRadius: radius.card, padding: space.lg, gap: 4 },
  creditTitle: { ...type.section, color: colors.brand },
  creditBody: { ...type.body, color: colors.brand, lineHeight: 21 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { ...type.label, flexShrink: 1 },
});
