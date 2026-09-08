// Booking a job from the truck.
//
// EXISTING CUSTOMERS COME FIRST, and that is the whole shape of step one.
// The search box is the default path and "New customer" sits underneath
// it, because the expensive mistake here is not a slow search — it is a
// second property record for an address PJL already services, which then
// splits that address's history, invoices and work orders in two. The
// same rule the CRM follows.
//
// HOW AN EXISTING CUSTOMER IS ACTUALLY REUSED. Not by sending `leadId`.
// That path exists for scheduling a lead that is still WAITING to be
// booked, and it overwrites `lead.booking` — pointing it at a won lead
// from two seasons ago would wipe that visit's envelope. Instead the
// customer's stored email and address go up as the contact, and the
// server's own `attachLead` binds the new lead to the property it
// already matches, by address and email. One property, one history.
//
// THE ADDRESS IS GEOCODED BEFORE ANY DATE IS OFFERED, which is the rule
// the public booking page follows and the reason it can promise a date
// at all: `/api/booking/verify-address` runs the booking gate — junk
// addresses and anything outside the service area are refused here,
// before a calendar is drawn — and hands back Google's formatted
// address, which is then the one availability is computed against.
//
// ZONES ARE TWO ANSWERS, NOT ONE. The service key carries the zone
// BAND, because that is what sets the visit length and the price
// (spring_open_6z is fifty minutes). The actual number is a separate
// field on the booking. Patrick asked for both and they are genuinely
// different things: the band is what we are selling, the count is what
// the tech will find in the ground.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AuthRequiredError,
  bookingAvailability,
  listProperties,
  listServices,
  reserveBooking,
  verifyAddress,
} from '../api';
import { colors, radius, space, type } from '../theme';

export const STEPS = ['customer', 'job', 'when'];

// Matches a property against what the tech typed. Name and address both,
// because "Holmes" and "90 Oriole" are the same question asked two ways
// and a tech in a driveway will use whichever they have.
export function matchProperties(all, query) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const hit = (p) =>
    String(p?.customerName || '').toLowerCase().includes(q)
    || String(p?.address || '').toLowerCase().includes(q);
  return (all || []).filter(hit).slice(0, 12);
}

// The zone count already on file for a property. `zones` is the WALKED
// record and beats the number the customer told us, exactly as
// lib/properties.js documents.
export function zonesOnFile(property) {
  const zones = property?.system?.zones;
  if (Array.isArray(zones) && zones.length) return zones.length;
  const declared = Number(property?.system?.zoneCount);
  return Number.isFinite(declared) && declared > 0 ? declared : null;
}

// Only the services a booking can actually be made against, in the
// server's own order, grouped by family so a list of twenty keys reads
// as four decisions.
export function bookableList(services) {
  return Object.entries(services || {})
    .filter(([, s]) => s && s.bookable)
    .map(([key, s]) => ({ key, ...s }));
}

// Which service the zone count implies, so picking "7" moves the
// selection to the 7-8 band rather than leaving a contradiction on
// screen. Returns null when nothing in the family matches — a 20-zone
// commercial site has no residential band and should not be forced into
// one.
export function serviceForZones(list, family, zoneCount) {
  const n = Number(zoneCount);
  if (!family || !Number.isFinite(n) || n < 1) return null;
  const inFamily = list.filter((s) => s.family === family && s.category !== 'commercial');
  const band = (key) => {
    const m = String(key).match(/_(\d+)z$/);
    return m ? Number(m[1]) : (/_16plus$/.test(key) ? Infinity : null);
  };
  const withBands = inFamily
    .map((s) => ({ ...s, top: band(s.key) }))
    .filter((s) => s.top !== null)
    .sort((a, b) => a.top - b.top);
  return withBands.find((s) => n <= s.top) || null;
}

const clean = (v) => String(v || '').trim();

export default function BookScreen({ onSignIn }) {
  const [step, setStep] = useState('customer');
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  const [properties, setProperties] = useState([]);
  const [services, setServices] = useState({});
  const [query, setQuery] = useState('');
  // The property this booking is FOR, when it is an existing one. Null
  // means a new customer is being typed.
  const [picked, setPicked] = useState(null);
  const [isNew, setIsNew] = useState(false);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [altPhone, setAltPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');

  const [serviceKey, setServiceKey] = useState('');
  const [zoneCount, setZoneCount] = useState('');

  // The address as GOOGLE spells it, set by verify-address. Availability
  // and the booking both use this rather than what was typed, so the
  // drive-time corridor is computed against the same point the pin will
  // land on.
  const [verified, setVerified] = useState(null);
  const [checking, setChecking] = useState(false);
  const [days, setDays] = useState([]);
  const [loadingDays, setLoadingDays] = useState(false);
  const [slot, setSlot] = useState(null);
  const [booking, setBooking] = useState(false);
  const [done, setDone] = useState(null);

  const load = useCallback(async () => {
    try {
      const [props, svc] = await Promise.all([listProperties(), listServices()]);
      setProperties(props);
      setServices(svc);
      setState('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else { setError(err?.message || "Couldn't load booking."); setState('error'); }
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const list = useMemo(() => bookableList(services), [services]);
  const results = useMemo(() => matchProperties(properties, query), [properties, query]);
  const service = serviceKey ? { key: serviceKey, ...(services[serviceKey] || {}) } : null;

  const choose = (property) => {
    setPicked(property);
    setIsNew(false);
    // Everything we already know, filled in. A tech re-typing a phone
    // number that is already on file is how a second spelling of the
    // same customer gets created.
    const parts = clean(property.customerName).split(/\s+/).filter(Boolean);
    setFirstName(parts[0] || '');
    setLastName(parts.slice(1).join(' '));
    setPhone(clean(property.customerPhone));
    setEmail(clean(property.customerEmail));
    setAddress(clean(property.address));
    const zones = zonesOnFile(property);
    setZoneCount(zones ? String(zones) : '');
    setVerified(null);
    setStep('job');
  };

  const startNew = () => {
    setPicked(null);
    setIsNew(true);
    setFirstName(''); setLastName(''); setPhone(''); setAltPhone('');
    setEmail(''); setAddress(''); setZoneCount(''); setVerified(null);
    setStep('job');
  };

  // Zone count drives the band. Typing 7 moves the service to the 7-8
  // band rather than leaving "1-4 zones" selected beside a 7.
  const onZones = (value) => {
    const digits = value.replace(/[^\d]/g, '').slice(0, 2);
    setZoneCount(digits);
    const family = service?.family;
    const better = serviceForZones(list, family, digits);
    if (better && better.key !== serviceKey) setServiceKey(better.key);
  };

  const checkAddress = async () => {
    const typed = clean(address);
    if (!typed) return;
    setChecking(true);
    setVerified(null);
    try {
      const res = await verifyAddress(typed);
      setVerified({ address: res.address || typed, minutes: res.minutes ?? null });
      setAddress(res.address || typed);
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else {
        Alert.alert(
          "That address won't book",
          err?.message || 'Check the address and try again.',
        );
      }
    } finally {
      setChecking(false);
    }
  };

  const loadDays = async () => {
    if (!verified || !serviceKey) return;
    setLoadingDays(true);
    setDays([]);
    setSlot(null);
    try {
      const res = await bookingAvailability({ service: serviceKey, address: verified.address });
      setDays(res.days || []);
      setStep('when');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else Alert.alert("Couldn't load available days", err?.message || 'Try again.');
    } finally {
      setLoadingDays(false);
    }
  };

  const confirm = async () => {
    if (!slot || booking) return;
    setBooking(true);
    try {
      // The customer's own stored email and address when this is an
      // existing property, so the server binds the new lead to the
      // property it already has rather than minting a second one.
      const name = [clean(firstName), clean(lastName)].filter(Boolean).join(' ');
      const res = await reserveBooking({
        serviceKey,
        slotStart: slot.start,
        zoneCount: clean(zoneCount) || 'unsure',
        contact: {
          name,
          firstName: clean(firstName),
          lastName: clean(lastName),
          phone: clean(phone),
          altPhone: clean(altPhone),
          email: clean(email),
          address: verified.address,
          notes: clean(notes),
        },
      });
      setDone({ when: slot, id: res?.booking?.id || res?.lead?.id || null });
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else {
        Alert.alert(
          "That slot didn't take",
          err?.message || 'Nothing was booked. Pick another time, or try again.',
        );
      }
    } finally {
      setBooking(false);
    }
  };

  const reset = () => {
    setDone(null); setPicked(null); setIsNew(false); setQuery('');
    setFirstName(''); setLastName(''); setPhone(''); setAltPhone('');
    setEmail(''); setAddress(''); setNotes(''); setZoneCount('');
    setServiceKey(''); setVerified(null); setDays([]); setSlot(null);
    setStep('customer');
  };

  if (state === 'loading') {
    return <View style={styles.centre}><ActivityIndicator color={colors.brand} /></View>;
  }
  if (state === 'auth') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Not signed in</Text>
        <Text style={styles.centreBody}>Sign in to PJL to book work onto the calendar.</Text>
        <Pressable onPress={onSignIn} style={styles.primary}>
          <Text style={styles.primaryText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }
  if (state === 'error') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Couldn't load</Text>
        <Text style={styles.centreBody}>{error}</Text>
        <Pressable onPress={load} style={styles.primary}>
          <Text style={styles.primaryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (done) {
    return (
      <View style={styles.centre}>
        <Text style={styles.bookedMark}>✓</Text>
        <Text style={styles.centreTitle}>Booked</Text>
        <Text style={styles.centreBody}>
          {[clean(firstName), clean(lastName)].filter(Boolean).join(' ') || 'The customer'}
          {' — '}{done.when.dayLabel}, {done.when.timeLabel}
        </Text>
        <Text style={styles.confirmNote}>
          The customer has been sent their confirmation. It's on the schedule.
        </Text>
        <Pressable onPress={reset} style={styles.primary}>
          <Text style={styles.primaryText}>Book another</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Book</Text>
        <View style={styles.steps}>
          {STEPS.map((key, i) => (
            <View key={key} style={[styles.pip, STEPS.indexOf(step) >= i && styles.pipOn]} />
          ))}
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {step === 'customer' ? (
          <>
            <Text style={styles.lead}>Who is this for?</Text>
            <Text style={styles.hint}>
              Search the book first. Booking an address we already service onto a
              new record splits its history in two.
            </Text>
            <TextInput
              style={styles.input}
              value={query}
              onChangeText={setQuery}
              placeholder="Name or address"
              placeholderTextColor={colors.textFaint}
              autoCorrect={false}
              autoCapitalize="words"
            />
            {results.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => choose(p)}
                style={({ pressed }) => [styles.result, pressed && styles.resultPressed]}
              >
                <Text style={styles.resultName} numberOfLines={1}>
                  {p.customerName || 'No name'}
                </Text>
                <Text style={styles.resultAddress} numberOfLines={1}>{p.address}</Text>
              </Pressable>
            ))}
            {query.trim().length >= 2 && !results.length ? (
              <Text style={styles.hint}>Nothing in the book matches that.</Text>
            ) : null}

            <Pressable onPress={startNew} style={styles.secondary}>
              <Text style={styles.secondaryText}>New customer</Text>
            </Pressable>
          </>
        ) : null}

        {step === 'job' ? (
          <>
            <Pressable onPress={() => setStep('customer')} hitSlop={10}>
              <Text style={styles.back}>‹ Who</Text>
            </Pressable>

            {picked ? (
              <View style={styles.chosen}>
                <Text style={styles.chosenName}>{picked.customerName || 'No name'}</Text>
                <Text style={styles.chosenAddress}>{picked.address}</Text>
                <Text style={styles.chosenNote}>On file — this booking joins their record.</Text>
              </View>
            ) : null}

            {isNew ? (
              <>
                <Text style={styles.lead}>New customer</Text>
                <Field label="First name" value={firstName} onChange={setFirstName} autoCapitalize="words" />
                <Field label="Last name" value={lastName} onChange={setLastName} autoCapitalize="words" />
                <Field label="Telephone" value={phone} onChange={setPhone} keyboardType="phone-pad" />
                <Field
                  label="Alternate telephone"
                  value={altPhone}
                  onChange={setAltPhone}
                  keyboardType="phone-pad"
                  optional
                />
                <Field label="Email" value={email} onChange={setEmail} keyboardType="email-address" />
              </>
            ) : null}

            <Text style={styles.lead}>Address</Text>
            <Text style={styles.hint}>
              Checked against the service area and geocoded before any day is
              offered — the same check the website does.
            </Text>
            <TextInput
              style={styles.input}
              value={address}
              onChangeText={(v) => { setAddress(v); setVerified(null); }}
              placeholder="123 Example Rd, Aurora, ON"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="words"
            />
            {verified ? (
              <Text style={styles.ok}>
                ✓ {verified.address}
                {verified.minutes != null ? `  ·  ${verified.minutes} min from base` : ''}
              </Text>
            ) : (
              <Pressable
                onPress={checkAddress}
                disabled={checking || !clean(address)}
                style={({ pressed }) => [
                  styles.secondary,
                  (checking || !clean(address)) && styles.off,
                  pressed && styles.pressed,
                ]}
              >
                {checking
                  ? <ActivityIndicator color={colors.brand} size="small" />
                  : <Text style={styles.secondaryText}>Check this address</Text>}
              </Pressable>
            )}

            <Text style={styles.lead}>Zones</Text>
            <Text style={styles.hint}>
              How many zones are actually in the ground. The band below sets the
              visit length and the price.
            </Text>
            <TextInput
              style={styles.input}
              value={zoneCount}
              onChangeText={onZones}
              placeholder="e.g. 7"
              placeholderTextColor={colors.textFaint}
              keyboardType="number-pad"
            />

            <Text style={styles.lead}>Service</Text>
            {list.map((s) => (
              <Pressable
                key={s.key}
                onPress={() => setServiceKey(s.key)}
                style={({ pressed }) => [
                  styles.option,
                  serviceKey === s.key && styles.optionOn,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.optionText, serviceKey === s.key && styles.optionTextOn]}>
                  {s.label}
                </Text>
                <Text style={styles.optionMeta}>{s.displayMinutes || `${s.minutes} min`}</Text>
              </Pressable>
            ))}

            <Text style={styles.lead}>Notes</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Anything the tech should know"
              placeholderTextColor={colors.textFaint}
              multiline
            />

            <Pressable
              onPress={loadDays}
              disabled={!verified || !serviceKey || loadingDays}
              style={({ pressed }) => [
                styles.primary,
                (!verified || !serviceKey || loadingDays) && styles.off,
                pressed && styles.pressed,
              ]}
            >
              {loadingDays
                ? <ActivityIndicator color={colors.onBrand} size="small" />
                : <Text style={styles.primaryText}>See available days</Text>}
            </Pressable>
            {!verified ? <Text style={styles.hint}>Check the address first.</Text> : null}
          </>
        ) : null}

        {step === 'when' ? (
          <>
            <Pressable onPress={() => setStep('job')} hitSlop={10}>
              <Text style={styles.back}>‹ Job</Text>
            </Pressable>
            <Text style={styles.lead}>When</Text>

            {!days.length ? (
              <Text style={styles.hint}>
                No days come back for that address and service inside the booking
                window. That is the calendar being genuinely full or out of season,
                not an error.
              </Text>
            ) : null}

            {days.filter((d) => d.slots && d.slots.length).map((day) => (
              <View key={day.date} style={styles.day}>
                <Text style={styles.dayLabel}>
                  {day.label}{day.recommended ? '  ★ on our route' : ''}
                </Text>
                <View style={styles.slots}>
                  {day.slots.map((s) => (
                    <Pressable
                      key={s.start}
                      onPress={() => setSlot(s)}
                      style={({ pressed }) => [
                        styles.slot,
                        slot?.start === s.start && styles.slotOn,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={[styles.slotText, slot?.start === s.start && styles.slotTextOn]}>
                        {s.timeLabel}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            ))}

            {slot ? (
              <Pressable
                onPress={confirm}
                disabled={booking}
                style={({ pressed }) => [styles.primary, booking && styles.off, pressed && styles.pressed]}
              >
                {booking
                  ? <ActivityIndicator color={colors.onBrand} size="small" />
                  : <Text style={styles.primaryText}>Book {slot.dayLabel}, {slot.timeLabel}</Text>}
              </Pressable>
            ) : null}
          </>
        ) : null}
      </ScrollView>
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
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm, backgroundColor: colors.ground },
  centreTitle: { ...type.title },
  centreBody: { ...type.label, textAlign: 'center', lineHeight: 21 },
  confirmNote: { ...type.caption, textAlign: 'center', marginTop: space.xs },
  bookedMark: { fontSize: 44, color: colors.brand, marginBottom: space.sm },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  title: { ...type.hero },
  steps: { flexDirection: 'row', gap: space.xs },
  pip: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: colors.separator },
  pipOn: { backgroundColor: colors.brand },

  body: { padding: space.lg, gap: space.sm, paddingBottom: space.xl * 2 },
  lead: { ...type.title, marginTop: space.md },
  hint: { ...type.caption, lineHeight: 19, marginBottom: space.xs },
  back: { ...type.body, color: colors.brand, fontWeight: '600', marginBottom: space.sm },
  ok: { ...type.caption, color: colors.brand, fontWeight: '600', paddingVertical: space.sm },

  input: {
    ...type.body,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
    paddingHorizontal: space.md, paddingVertical: space.md,
    minHeight: 48,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  field: { gap: space.xs, marginBottom: space.sm },
  fieldLabel: { ...type.caption, color: colors.textMuted, fontWeight: '600' },
  optional: { ...type.caption, color: colors.textFaint, fontWeight: '400' },

  result: {
    backgroundColor: colors.card, borderRadius: radius.card,
    paddingHorizontal: space.md, paddingVertical: space.md,
    minHeight: 56, justifyContent: 'center', gap: 2,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
  },
  resultPressed: { backgroundColor: colors.brandTint },
  resultName: { ...type.body, fontWeight: '600' },
  resultAddress: { ...type.caption },

  chosen: {
    backgroundColor: colors.brandTint, borderRadius: radius.card,
    padding: space.md, gap: 2, marginBottom: space.sm,
  },
  chosenName: { ...type.body, fontWeight: '700', color: colors.brand },
  chosenAddress: { ...type.caption, color: colors.text },
  chosenNote: { ...type.caption, color: colors.brand, marginTop: space.xs },

  option: {
    backgroundColor: colors.card, borderRadius: radius.card,
    paddingHorizontal: space.md, paddingVertical: space.md,
    minHeight: 48, justifyContent: 'center', gap: 2,
    borderWidth: 1, borderColor: colors.separator,
  },
  optionOn: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  optionText: { ...type.body },
  optionTextOn: { color: colors.brand, fontWeight: '600' },
  optionMeta: { ...type.caption },

  day: { marginTop: space.md, gap: space.sm },
  dayLabel: { ...type.label, color: colors.text, fontWeight: '600' },
  slots: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  slot: {
    backgroundColor: colors.card, borderRadius: radius.card,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    minHeight: 44, justifyContent: 'center',
    borderWidth: 1, borderColor: colors.separator,
  },
  slotOn: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  slotText: { ...type.body },
  slotTextOn: { color: colors.brand, fontWeight: '700' },

  primary: {
    backgroundColor: colors.brand, borderRadius: radius.card,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    minHeight: 48, alignItems: 'center', justifyContent: 'center',
    marginTop: space.lg,
  },
  primaryText: { color: colors.onBrand, ...type.body, fontWeight: '600' },
  secondary: {
    backgroundColor: colors.card, borderRadius: radius.card,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    minHeight: 48, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.brand, marginTop: space.md,
  },
  secondaryText: { color: colors.brand, ...type.body, fontWeight: '600' },
  off: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
