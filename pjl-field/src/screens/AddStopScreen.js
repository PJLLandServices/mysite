// A customer walks over while you are on their neighbour's lawn.
//
// Patrick: "Sometimes we are approached by customers while on a daily
// route, we try not to turn anyone down... we still want to remain
// professional and be able to tackle their closing as well, while still
// recording all paperwork, and then adding it into the daily flow as it
// would have been."
//
// "AS IT WOULD HAVE BEEN" is the whole specification. When this is done
// the job has to be indistinguishable from one booked three weeks ago:
// the same customer record, the same property, the same lead, the same
// work order, the same price off the same tier. Nothing here invents a
// cheaper path — it walks the ordinary one, quickly, and hands you the
// work order at the end of it.
//
// Three questions, in the order the driveway asks them: whose house,
// what are we doing, who are you. The rules behind the address hint and
// the time it lands at are in src/add-stop.js, with their reasoning.
//
// NO NEW SERVER CODE. The force-book path this uses — source:
// "admin_custom" — already skips the bucket grid, the service-area gate
// and the ten-minute hold, and is already open to a signed-in tech.
// Everything a walk-up needs was built for Patrick booking by phone.

import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  AuthRequiredError, listServices, openWorkOrder, reserveBooking,
  suggestAddresses, verifyAddress,
} from '../api';
import {
  bandLabel, bandsFor, catalogNotes, categoriesInOrder, FOLLOW_UPS,
  ISSUE_COUNTS, issueCountLabel, serviceKeyFor, zoneOptionsFor,
} from '../booking-catalog';
import { zoneCountLabel } from './BookScreen';
import { localYmd, nextFreeStart, streetHint, WALK_UP_NOTE } from '../add-stop';
import { colors, radius, space, type } from '../theme';
import { PickerSheet, SelectRow } from '../ui';

const clean = (v) => String(v == null ? '' : v).trim();

const STEPS = ['where', 'what', 'who'];

export default function AddStopScreen({
  day, dayBookings, fromAddress, onExit, onOpenWorkOrder, onSignIn,
}) {
  // Re-read each render rather than at import: the app is open across
  // midnight more often than you would think.
  const todayYmd = localYmd(new Date());
  const [step, setStep] = useState('where');
  const [services, setServices] = useState({});
  const [loaded, setLoaded] = useState(false);

  const [typed, setTyped] = useState(streetHint(fromAddress));
  const [suggestions, setSuggestions] = useState([]);
  const [verified, setVerified] = useState(null);
  const [checking, setChecking] = useState(false);

  const [category, setCategory] = useState(null);
  const [band, setBand] = useState(null);
  const [zoneCount, setZoneCount] = useState('');
  const [issueCount, setIssueCount] = useState('');
  const [sheet, setSheet] = useState(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    listServices()
      .then((svc) => { if (alive) { setServices(svc); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  const categories = useMemo(() => categoriesInOrder(services), [services]);
  const bands = useMemo(
    () => (category?.family ? bandsFor(services, category.family) : []),
    [services, category],
  );
  const serviceKey = serviceKeyFor(category, band);
  const ready = Boolean(serviceKey && (category?.follow !== 'zones' || band));

  const suggest = async (text) => {
    setTyped(text);
    setVerified(null);
    if (clean(text).length < 3) { setSuggestions([]); return; }
    try {
      const res = await suggestAddresses(clean(text));
      setSuggestions(res.suggestions || []);
    } catch { setSuggestions([]); }
  };

  const settle = async (text) => {
    const value = clean(text);
    if (!value) return;
    setChecking(true);
    setSuggestions([]);
    try {
      // Verified for the FORMATTED address and the coordinates, not for
      // permission: a force-book skips the service-area gate on purpose.
      // You are standing on the lawn; a machine in Newmarket arguing
      // about the boundary helps nobody.
      const res = await verifyAddress(value);
      setVerified({ address: res.address || value });
      setTyped(res.address || value);
      setStep('what');
    } catch (err) {
      if (err instanceof AuthRequiredError) { onSignIn?.(); return; }
      // Out of area is not a refusal here — take it as typed and carry on.
      setVerified({ address: value, unverified: true });
      setStep('what');
    } finally {
      setChecking(false);
    }
  };

  const create = async () => {
    if (saving || !verified || !serviceKey) return;
    if (!clean(firstName) && !clean(lastName)) {
      Alert.alert('A name, at least', 'The invoice has to be addressed to somebody.');
      return;
    }
    setSaving(true);
    try {
      const res = await reserveBooking({
        serviceKey,
        // The deliberate staff act: off the bucket grid, past the
        // service-area gate, and exempt from the ten-minute hold. All
        // three are correct for a job you are about to do by hand.
        source: 'admin_custom',
        slotStart: nextFreeStart(dayBookings, { day }),
        zoneCount: clean(zoneCount) || 'unsure',
        contact: {
          name: [clean(firstName), clean(lastName)].filter(Boolean).join(' '),
          firstName: clean(firstName),
          lastName: clean(lastName),
          phone: clean(phone),
          email: clean(email),
          address: verified.address,
          notes: [WALK_UP_NOTE,
            catalogNotes({ category, zoneCount, issueCount })].filter(Boolean).join(' ').trim(),
        },
      });
      const leadId = res?.leadId || null;
      if (!leadId) {
        Alert.alert('Booked', 'It is on today. Open it from the day list to start the work.');
        onExit?.();
        return;
      }
      // Straight into the paperwork — the point of the exercise.
      const wo = (await openWorkOrder(leadId))?.workOrder;
      onExit?.();
      // No work order came back: the booking is real and on the day, so
      // say so rather than implying nothing happened.
      if (wo?.id) onOpenWorkOrder?.(wo);
      else Alert.alert('Booked', 'It is on the day. Open it from the list to start the work.');
    } catch (err) {
      if (err instanceof AuthRequiredError) onSignIn?.();
      else Alert.alert("Couldn't add it", err?.message || 'Nothing was created. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const sheets = {
    service: {
      title: 'What are we doing?',
      selectedKey: category?.key || null,
      options: categories.map((c) => ({ key: c.key, label: c.label })),
      onSelect: (o) => {
        const c = categories.find((x) => x.key === o.key);
        if (!c) return;
        setCategory(c); setBand(null); setZoneCount(''); setIssueCount('');
      },
    },
    band: {
      title: FOLLOW_UPS.zones,
      selectedKey: band?.key || null,
      options: bands.map((b) => ({
        key: b.key, label: bandLabel(bands, b),
        group: b.commercial ? 'Commercial' : 'Residential',
      })),
      onSelect: (o) => { const b = bands.find((x) => x.key === o.key); if (b) { setBand(b); setZoneCount(''); } },
    },
    zones: {
      title: 'How many zones exactly?',
      selectedKey: clean(zoneCount) || null,
      options: zoneOptionsFor(bands, band)
        .map((n) => ({ key: String(n), label: zoneCountLabel(String(n)) }))
        .concat([{ key: 'unsure', label: 'Not sure yet' }]),
      onSelect: (o) => setZoneCount(o.key),
    },
    issues: {
      title: FOLLOW_UPS.issues,
      selectedKey: clean(issueCount) || null,
      options: ISSUE_COUNTS.map((v) => ({ key: v, label: issueCountLabel(v) })),
      onSelect: (o) => setIssueCount(o.key),
    },
  };
  const asking = sheet ? sheets[sheet] : null;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.bar}>
        <Pressable onPress={onExit} hitSlop={10}><Text style={styles.back}>‹ Today</Text></Pressable>
        <Text style={styles.title}>Add a stop</Text>
        <View style={styles.steps}>
          {STEPS.map((k, i) => (
            <View key={k} style={[styles.pip, STEPS.indexOf(step) >= i && styles.pipOn]} />
          ))}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {step === 'where' ? (
          <>
            <Text style={styles.lead}>Whose house?</Text>
            <TextInput
              style={styles.input}
              value={typed}
              onChangeText={suggest}
              placeholder="Number and street"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="words"
              autoCorrect={false}
              returnKeyType="search"
              onSubmitEditing={() => settle(typed)}
            />
            {fromAddress ? (
              <Text style={styles.hint}>
                Started from the street you're on. Change the number.
              </Text>
            ) : null}
            {suggestions.map((s) => (
              <Pressable
                key={s.id}
                onPress={() => settle(s.description)}
                style={({ pressed }) => [styles.suggest, pressed && styles.pressed]}
              >
                <Text style={styles.suggestText} numberOfLines={2}>{s.description}</Text>
              </Pressable>
            ))}
            {checking ? (
              <View style={styles.row}>
                <ActivityIndicator color={colors.brand} size="small" />
                <Text style={styles.hint}>Checking the address…</Text>
              </View>
            ) : null}
            {!checking && clean(typed) ? (
              <Pressable onPress={() => settle(typed)} style={styles.primary}>
                <Text style={styles.primaryText}>That's the one</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        {step === 'what' ? (
          <>
            <Pressable onPress={() => setStep('where')} hitSlop={10}>
              <Text style={styles.backLink} numberOfLines={1}>‹ {verified?.address}</Text>
            </Pressable>
            <Text style={styles.lead}>What are we doing?</Text>
            {!loaded ? <ActivityIndicator color={colors.brand} /> : null}
            <SelectRow
              label="Service"
              value={category?.label}
              placeholder="Choose"
              onPress={() => setSheet('service')}
            />
            {category?.follow === 'zones' ? (
              <SelectRow
                label="Zones"
                value={band ? `${bandLabel(bands, band)} · ${band.commercial ? 'commercial' : 'residential'}` : ''}
                placeholder="About how many?"
                onPress={() => setSheet('band')}
              />
            ) : null}
            {(category?.follow === 'zones' && band) || category?.follow === 'zones_only' ? (
              <SelectRow
                label="Exactly how many"
                value={zoneCountLabel(zoneCount)}
                placeholder="Count in the ground"
                onPress={() => setSheet('zones')}
              />
            ) : null}
            {category?.follow === 'issues' ? (
              <SelectRow
                label="Issues"
                value={issueCountLabel(issueCount)}
                placeholder="How many are we looking at?"
                onPress={() => setSheet('issues')}
              />
            ) : null}
            <Text style={styles.hint}>
              Priced off the same tier the website quotes — a favour on a driveway is not a
              discount nobody can explain in March.
            </Text>
            <Pressable
              onPress={() => setStep('who')}
              disabled={!ready}
              style={({ pressed }) => [styles.primary, !ready && styles.off, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>Their details</Text>
            </Pressable>
          </>
        ) : null}

        {step === 'who' ? (
          <>
            <Pressable onPress={() => setStep('what')} hitSlop={10}>
              <Text style={styles.backLink}>‹ {category?.label}</Text>
            </Pressable>
            <Text style={styles.lead}>Who are they?</Text>
            <Field label="First name" value={firstName} onChange={setFirstName} autoCapitalize="words" />
            <Field label="Last name" value={lastName} onChange={setLastName} autoCapitalize="words" />
            <Field label="Telephone" value={phone} onChange={setPhone} keyboardType="phone-pad" />
            {/* Optional on purpose: a stranger on a driveway gives you a
                number and not much else. */}
            <Field label="Email" value={email} onChange={setEmail} keyboardType="email-address" optional />
            <View style={styles.summary}>
              <Text style={styles.summaryWhat}>{verified?.address}</Text>
              <Text style={styles.summarySub}>
                {[category?.label, zoneCountLabel(zoneCount), issueCountLabel(issueCount)]
                  .filter(Boolean).join(' · ')}
              </Text>
              <Text style={styles.summaryNote}>
                {day && day !== todayYmd
                  ? 'Goes on that day after the last stop.'
                  : 'Goes on today after your last stop.'}
                {' '}The work order records when you actually did it.
              </Text>
            </View>
            <Pressable
              onPress={create}
              disabled={saving}
              style={({ pressed }) => [styles.primary, saving && styles.off, pressed && styles.pressed]}
            >
              {saving
                ? <ActivityIndicator color={colors.onBrand} size="small" />
                : <Text style={styles.primaryText}>Add to today &amp; open the work order</Text>}
            </Pressable>
          </>
        ) : null}
      </ScrollView>

      <PickerSheet
        visible={Boolean(asking)}
        title={asking?.title}
        options={asking?.options || []}
        selectedKey={asking?.selectedKey ?? null}
        onClose={() => setSheet(null)}
        onSelect={(item) => { asking?.onSelect(item); setSheet(null); }}
      />
    </KeyboardAvoidingView>
  );
}

function Field({ label, value, onChange, optional, ...rest }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>
        {label}{optional ? <Text style={styles.optional}>  optional</Text> : null}
      </Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        placeholderTextColor={colors.textFaint}
        autoCorrect={false}
        {...rest}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  back: { ...type.body, color: colors.brand, fontWeight: '600' },
  title: { ...type.title },
  steps: { flexDirection: 'row', gap: space.xs },
  pip: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.separator },
  pipOn: { backgroundColor: colors.brand },
  body: { padding: space.lg, gap: space.sm, paddingBottom: space.xl * 2 },
  lead: { ...type.title, marginTop: space.sm },
  backLink: { ...type.body, color: colors.brand, fontWeight: '600', marginBottom: space.xs },
  hint: { ...type.caption, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.sm },
  input: {
    ...type.body, backgroundColor: colors.card, borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
    paddingHorizontal: space.md, paddingVertical: space.md, minHeight: 48,
  },
  field: { gap: space.xs, marginBottom: space.sm },
  fieldLabel: { ...type.caption, color: colors.textMuted, fontWeight: '600' },
  optional: { ...type.caption, color: colors.textFaint, fontWeight: '400' },
  suggest: {
    backgroundColor: colors.card, borderRadius: radius.card,
    paddingHorizontal: space.md, paddingVertical: space.md, minHeight: 48,
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
  },
  suggestText: { ...type.body },
  summary: {
    backgroundColor: colors.brandTint, borderRadius: radius.card,
    padding: space.md, gap: 2, marginTop: space.sm,
  },
  summaryWhat: { ...type.body, fontWeight: '700', color: colors.brand },
  summarySub: { ...type.caption, color: colors.text },
  summaryNote: { ...type.caption, color: colors.textMuted, marginTop: 3, lineHeight: 18 },
  primary: {
    backgroundColor: colors.brand, borderRadius: radius.card,
    paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 48,
    alignItems: 'center', justifyContent: 'center', marginTop: space.lg,
  },
  primaryText: { color: colors.onBrand, ...type.body, fontWeight: '600' },
  off: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
