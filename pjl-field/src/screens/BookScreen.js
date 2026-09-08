// Booking a customer while you are on the phone to them.
//
// THE ORDER IS THE POINT, and it is Patrick's, not a form designer's:
//
//   - I open the app
//   - request that customers address (a place to type in address with
//     autocomplete)
//   - it shows me JUST LIKE WHEN I search on desktop OR they go on the
//     website
//   - Once i show them the booking dates, I select the date they accept
//   - I send them a text message with that EXACT BOOKING DAY for that
//     appointment time
//
// So: ADDRESS first, DATES second, and the customer's details LAST —
// because the call goes "what's the address… I can do Thursday
// morning… great, let me take your details." A form that asks for a
// name before it can offer a day makes you hold a stranger on the phone
// while you type. That is why the address is on slide one and
// auto-populates into slide three rather than being asked for twice.
//
// EXISTING CUSTOMERS ARE SOURCED FIRST, and the address-first order is
// what makes that cheap: the same box that suggests addresses also
// matches the book, so an address PJL already services announces itself
// before anything is created. The expensive mistake is a second property
// record for one address — it splits its history, invoices and work
// orders in two.
//
// THE ADDRESS IS GEOCODED BEFORE ANY DATE IS OFFERED. A Places
// suggestion is only a string; `/api/booking/verify-address` is what runs
// the booking gate (junk and out-of-area refused) and returns the
// formatted address availability is then computed against. Picking a
// suggestion can never skip that.
//
// ZONES ARE TWO ANSWERS. The service key carries the BAND, which sets
// the price and the visit length; the count is what is actually in the
// ground. Patrick asked for both.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
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
  suggestAddresses,
  verifyAddress,
} from '../api';
import { colors, radius, space, type } from '../theme';

export const STEPS = ['address', 'when', 'who'];

// Existing customers, matched on the same string that is fetching
// address suggestions. Address and name both, because a tech may have
// either.
export function matchProperties(all, query) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 3) return [];
  const hit = (p) =>
    String(p?.address || '').toLowerCase().includes(q)
    || String(p?.customerName || '').toLowerCase().includes(q);
  return (all || []).filter(hit).slice(0, 6);
}

// The zone count already on file. `zones` is the walked record and beats
// the number the customer told us, as lib/properties.js documents.
export function zonesOnFile(property) {
  const zones = property?.system?.zones;
  if (Array.isArray(zones) && zones.length) return zones.length;
  const declared = Number(property?.system?.zoneCount);
  return Number.isFinite(declared) && declared > 0 ? declared : null;
}

export function bookableList(services) {
  return Object.entries(services || {})
    .filter(([, s]) => s && s.bookable)
    .map(([key, s]) => ({ key, ...s }));
}

// Which band holds this many zones, so typing 7 moves the service to
// 7-8 rather than leaving a contradiction on screen.
export function serviceForZones(list, family, zoneCount) {
  const n = Number(zoneCount);
  if (!family || !Number.isFinite(n) || n < 1) return null;
  const band = (key) => {
    const m = String(key).match(/_(\d+)z$/);
    return m ? Number(m[1]) : (/_16plus$/.test(key) ? Infinity : null);
  };
  return list
    .filter((s) => s.family === family && s.category !== 'commercial')
    .map((s) => ({ ...s, top: band(s.key) }))
    .filter((s) => s.top !== null)
    .sort((a, b) => a.top - b.top)
    .find((s) => n <= s.top) || null;
}

// The text Patrick sends. Names the EXACT day and time that was just
// reserved — not "your appointment is confirmed", which tells a customer
// on the phone nothing they can write down.
export function confirmationText({ dayLabel, timeLabel, serviceLabel, address }) {
  const when = [dayLabel, timeLabel].filter(Boolean).join(', ');
  return `PJL Land Services — you're booked for ${when}.`
    + `${serviceLabel ? ` ${serviceLabel}.` : ''}`
    + `${address ? ` At ${address}.` : ''}`
    + ` Reply here if anything changes.`;
}

const clean = (v) => String(v || '').trim();

export default function BookScreen({ onSignIn }) {
  const [step, setStep] = useState('address');
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  const [properties, setProperties] = useState([]);
  const [services, setServices] = useState({});

  // --- Slide 1: the address -------------------------------------------
  const [typed, setTyped] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [picked, setPicked] = useState(null);      // an existing property, or null
  const [verified, setVerified] = useState(null);  // { address, minutes }
  const [checking, setChecking] = useState(false);

  // --- Slide 2: the day ------------------------------------------------
  const [serviceKey, setServiceKey] = useState('');
  const [days, setDays] = useState([]);
  const [loadingDays, setLoadingDays] = useState(false);
  const [slot, setSlot] = useState(null);

  // --- Slide 3: who they are -------------------------------------------
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [altPhone, setAltPhone] = useState('');
  const [email, setEmail] = useState('');
  const [zoneCount, setZoneCount] = useState('');
  const [notes, setNotes] = useState('');
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

  // Suggestions, debounced. Every keystroke is a paid Google call, so
  // this waits for the typing to stop rather than racing it.
  const seq = useRef(0);
  useEffect(() => {
    if (verified) return undefined;             // already settled
    const q = typed.trim();
    if (q.length < 3) { setSuggestions([]); return undefined; }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      suggestAddresses(q)
        .then((rows) => { if (mine === seq.current) setSuggestions(rows); })
        // A dead suggestion service must never block a booking: the tech
        // types the address and verify-address still does the real work.
        .catch(() => { if (mine === seq.current) setSuggestions([]); });
    }, 350);
    return () => clearTimeout(t);
  }, [typed, verified]);

  const list = useMemo(() => bookableList(services), [services]);
  const onFile = useMemo(() => matchProperties(properties, typed), [properties, typed]);
  const service = serviceKey ? { key: serviceKey, ...(services[serviceKey] || {}) } : null;

  // Everything we already know about a customer already in the book.
  const takeProperty = (p) => {
    setPicked(p);
    const parts = clean(p.customerName).split(/\s+/).filter(Boolean);
    setFirstName(parts[0] || '');
    setLastName(parts.slice(1).join(' '));
    setPhone(clean(p.customerPhone));
    setEmail(clean(p.customerEmail));
    const zones = zonesOnFile(p);
    setZoneCount(zones ? String(zones) : '');
    setTyped(clean(p.address));
    setSuggestions([]);
    return clean(p.address);
  };

  const settleAddress = async (text) => {
    const value = clean(text);
    if (!value) return;
    setChecking(true);
    setSuggestions([]);
    try {
      const res = await verifyAddress(value);
      const formatted = res.address || value;
      setVerified({ address: formatted, minutes: res.minutes ?? null });
      setTyped(formatted);
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else Alert.alert("That address won't book", err?.message || 'Check it and try again.');
    } finally {
      setChecking(false);
    }
  };

  const showDays = async (key) => {
    if (!verified || !key) return;
    setServiceKey(key);
    setLoadingDays(true);
    setDays([]);
    setSlot(null);
    try {
      const res = await bookingAvailability({ service: key, address: verified.address });
      setDays(res.days || []);
      setStep('when');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else Alert.alert("Couldn't load available days", err?.message || 'Try again.');
    } finally {
      setLoadingDays(false);
    }
  };

  const onZones = (value) => {
    const digits = value.replace(/[^\d]/g, '').slice(0, 2);
    setZoneCount(digits);
    const better = serviceForZones(list, service?.family, digits);
    if (better && better.key !== serviceKey) setServiceKey(better.key);
  };

  const confirm = async () => {
    if (!slot || booking) return;
    setBooking(true);
    try {
      const name = [clean(firstName), clean(lastName)].filter(Boolean).join(' ');
      await reserveBooking({
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
      setDone({
        slot,
        text: confirmationText({
          dayLabel: slot.dayLabel,
          timeLabel: slot.timeLabel,
          serviceLabel: service?.label,
          address: verified.address,
        }),
      });
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

  // The text Patrick sends himself, from his own number, with the exact
  // day already written. `?body=` is the separator both platforms take.
  const sendText = () => {
    const to = clean(phone).replace(/[^\d+]/g, '');
    const url = to
      ? `sms:${to}?body=${encodeURIComponent(done.text)}`
      : `sms:?body=${encodeURIComponent(done.text)}`;
    Linking.openURL(url).catch(() => {
      Alert.alert("Couldn't open Messages", 'The booking is made either way.');
    });
  };

  const reset = () => {
    setDone(null); setPicked(null); setTyped(''); setSuggestions([]); setVerified(null);
    setServiceKey(''); setDays([]); setSlot(null);
    setFirstName(''); setLastName(''); setPhone(''); setAltPhone('');
    setEmail(''); setZoneCount(''); setNotes('');
    setStep('address');
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
      <ScrollView contentContainerStyle={styles.centre}>
        <Text style={styles.bookedMark}>✓</Text>
        <Text style={styles.centreTitle}>Booked</Text>
        <Text style={styles.bookedWhen}>{done.slot.dayLabel}, {done.slot.timeLabel}</Text>
        <Text style={styles.centreBody}>{verified.address}</Text>

        <View style={styles.textCard}>
          <Text style={styles.textCardLabel}>The text they'll get from you</Text>
          <Text style={styles.textCardBody}>{done.text}</Text>
        </View>

        <Pressable onPress={sendText} style={styles.primary}>
          <Text style={styles.primaryText}>
            {clean(phone) ? `Text ${clean(phone)}` : 'Text the confirmation'}
          </Text>
        </Pressable>
        {/* Said plainly so nobody double-texts a customer by accident. */}
        <Text style={styles.confirmNote}>
          The system also sends its own confirmation automatically. This one comes
          from your number, so they can reply to you.
        </Text>

        <Pressable onPress={reset} style={styles.secondary}>
          <Text style={styles.secondaryText}>Book another</Text>
        </Pressable>
      </ScrollView>
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
        {/* ---- 1. The address ------------------------------------------ */}
        {step === 'address' ? (
          <>
            <Text style={styles.lead}>What's the address?</Text>
            <TextInput
              style={styles.input}
              value={typed}
              onChangeText={(v) => { setTyped(v); setVerified(null); setPicked(null); }}
              placeholder="Start typing…"
              placeholderTextColor={colors.textFaint}
              autoCorrect={false}
              autoCapitalize="words"
            />

            {/* On file first — an address PJL already services announces
                itself before anything new is created. */}
            {!verified && onFile.length ? (
              <>
                <Text style={styles.groupLabel}>Already in the book</Text>
                {onFile.map((p) => (
                  <Pressable
                    key={p.id}
                    onPress={() => settleAddress(takeProperty(p))}
                    style={({ pressed }) => [styles.suggest, styles.onFile, pressed && styles.pressed]}
                  >
                    <Text style={styles.suggestText} numberOfLines={1}>{p.address}</Text>
                    <Text style={styles.onFileWho} numberOfLines={1}>
                      {p.customerName || 'No name'}
                    </Text>
                  </Pressable>
                ))}
              </>
            ) : null}

            {!verified && suggestions.length ? (
              <>
                <Text style={styles.groupLabel}>Suggestions</Text>
                {suggestions.map((s) => (
                  <Pressable
                    key={s.id}
                    onPress={() => { setTyped(s.description); settleAddress(s.description); }}
                    style={({ pressed }) => [styles.suggest, pressed && styles.pressed]}
                  >
                    <Text style={styles.suggestText} numberOfLines={2}>{s.description}</Text>
                  </Pressable>
                ))}
              </>
            ) : null}

            {checking ? (
              <View style={styles.checking}>
                <ActivityIndicator color={colors.brand} size="small" />
                <Text style={styles.hint}>Checking the service area…</Text>
              </View>
            ) : null}

            {verified ? (
              <>
                <Text style={styles.ok}>
                  ✓ {verified.address}
                  {verified.minutes != null ? `  ·  ${verified.minutes} min from base` : ''}
                </Text>
                {picked ? (
                  <Text style={styles.onFileNote}>
                    {picked.customerName || 'This address'} is already in the book — this
                    booking joins their record.
                  </Text>
                ) : null}

                <Text style={styles.lead}>What are we booking?</Text>
                {list.map((s) => (
                  <Pressable
                    key={s.key}
                    onPress={() => showDays(s.key)}
                    disabled={loadingDays}
                    style={({ pressed }) => [styles.option, pressed && styles.pressed]}
                  >
                    <Text style={styles.optionText}>{s.label}</Text>
                    <Text style={styles.optionMeta}>{s.displayMinutes || `${s.minutes} min`}</Text>
                  </Pressable>
                ))}
                {loadingDays ? <ActivityIndicator color={colors.brand} /> : null}
              </>
            ) : (
              !checking && clean(typed) ? (
                <Pressable onPress={() => settleAddress(typed)} style={styles.secondary}>
                  <Text style={styles.secondaryText}>Use this address</Text>
                </Pressable>
              ) : null
            )}
          </>
        ) : null}

        {/* ---- 2. The day ---------------------------------------------- */}
        {step === 'when' ? (
          <>
            <Pressable onPress={() => setStep('address')} hitSlop={10}>
              <Text style={styles.back}>‹ Address</Text>
            </Pressable>
            <Text style={styles.lead}>Read them the days</Text>
            <Text style={styles.hint}>{verified.address} · {service?.label}</Text>

            {!days.some((d) => d.slots?.length) ? (
              <Text style={styles.hint}>
                No days come back for that address and service inside the booking
                window — the calendar is genuinely full or out of season.
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
              <Pressable onPress={() => setStep('who')} style={styles.primary}>
                <Text style={styles.primaryText}>
                  They'll take {slot.dayLabel}, {slot.timeLabel}
                </Text>
              </Pressable>
            ) : null}
          </>
        ) : null}

        {/* ---- 3. Who they are ----------------------------------------- */}
        {step === 'who' ? (
          <>
            <Pressable onPress={() => setStep('when')} hitSlop={10}>
              <Text style={styles.back}>‹ Days</Text>
            </Pressable>

            <View style={styles.holding}>
              <Text style={styles.holdingWhen}>{slot.dayLabel}, {slot.timeLabel}</Text>
              {/* Auto-populated from slide one — asked once, not twice. */}
              <Text style={styles.holdingWhere}>{verified.address}</Text>
            </View>

            <Text style={styles.lead}>Their details</Text>
            <Field label="First name" value={firstName} onChange={setFirstName} autoCapitalize="words" />
            <Field label="Last name" value={lastName} onChange={setLastName} autoCapitalize="words" />
            <Field label="Telephone" value={phone} onChange={setPhone} keyboardType="phone-pad" />
            {/* iOS never gives an app the number of the call you are on —
                CallKit reports that a call exists, never who is on it, at
                any entitlement level. So this is typed. */}
            <Field
              label="Alternate telephone"
              value={altPhone}
              onChange={setAltPhone}
              keyboardType="phone-pad"
              optional
            />
            <Field label="Email" value={email} onChange={setEmail} keyboardType="email-address" />

            <Text style={styles.lead}>Zones</Text>
            <Text style={styles.hint}>
              How many are actually in the ground. The band sets the price and the
              visit length.
            </Text>
            <Field label="Zone count" value={zoneCount} onChange={onZones} keyboardType="number-pad" />
            <View style={styles.band}>
              <Text style={styles.bandLabel}>Band</Text>
              <Text style={styles.bandValue}>{service?.label || '—'}</Text>
            </View>

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
              onPress={confirm}
              disabled={booking}
              style={({ pressed }) => [styles.primary, booking && styles.off, pressed && styles.pressed]}
            >
              {booking
                ? <ActivityIndicator color={colors.onBrand} size="small" />
                : <Text style={styles.primaryText}>Book it</Text>}
            </Pressable>
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
  centre: {
    flexGrow: 1, alignItems: 'center', justifyContent: 'center',
    padding: space.xl, gap: space.sm, backgroundColor: colors.ground,
  },
  centreTitle: { ...type.title },
  centreBody: { ...type.label, textAlign: 'center', lineHeight: 21 },
  confirmNote: { ...type.caption, textAlign: 'center', marginTop: space.sm, lineHeight: 18 },
  bookedMark: { fontSize: 44, color: colors.brand },
  bookedWhen: { ...type.hero, fontSize: 20, color: colors.brand, textAlign: 'center' },

  textCard: {
    backgroundColor: colors.card, borderRadius: radius.card,
    padding: space.md, marginTop: space.lg, gap: space.xs,
    alignSelf: 'stretch',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
  },
  textCardLabel: { ...type.caption, color: colors.textMuted, fontWeight: '600' },
  textCardBody: { ...type.body, lineHeight: 21 },

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
  hint: { ...type.caption, lineHeight: 19 },
  groupLabel: { ...type.section, marginTop: space.md },
  back: { ...type.body, color: colors.brand, fontWeight: '600', marginBottom: space.sm },
  ok: { ...type.body, color: colors.brand, fontWeight: '600', paddingVertical: space.sm },
  checking: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.md },

  input: {
    ...type.body, backgroundColor: colors.card, borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
    paddingHorizontal: space.md, paddingVertical: space.md, minHeight: 48,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  field: { gap: space.xs, marginBottom: space.sm },
  fieldLabel: { ...type.caption, color: colors.textMuted, fontWeight: '600' },
  optional: { ...type.caption, color: colors.textFaint, fontWeight: '400' },

  suggest: {
    backgroundColor: colors.card, borderRadius: radius.card,
    paddingHorizontal: space.md, paddingVertical: space.md,
    minHeight: 48, justifyContent: 'center', gap: 2,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
  },
  suggestText: { ...type.body },
  onFile: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  onFileWho: { ...type.caption, color: colors.brand, fontWeight: '600' },
  onFileNote: { ...type.caption, color: colors.brand, lineHeight: 19 },

  option: {
    backgroundColor: colors.card, borderRadius: radius.card,
    paddingHorizontal: space.md, paddingVertical: space.md,
    minHeight: 48, justifyContent: 'center', gap: 2,
    borderWidth: 1, borderColor: colors.separator,
  },
  optionText: { ...type.body },
  optionMeta: { ...type.caption },

  holding: {
    backgroundColor: colors.brandTint, borderRadius: radius.card,
    padding: space.md, gap: 2, marginBottom: space.sm,
  },
  holdingWhen: { ...type.body, fontWeight: '700', color: colors.brand },
  holdingWhere: { ...type.caption, color: colors.text },

  band: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: space.md, backgroundColor: colors.card, borderRadius: radius.card,
    paddingHorizontal: space.md, paddingVertical: space.md, minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
  },
  bandLabel: { ...type.caption, color: colors.textMuted, fontWeight: '600' },
  bandValue: { ...type.body, flexShrink: 1, textAlign: 'right' },

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
    marginTop: space.lg, alignSelf: 'stretch',
  },
  primaryText: { color: colors.onBrand, ...type.body, fontWeight: '600', textAlign: 'center' },
  secondary: {
    backgroundColor: colors.card, borderRadius: radius.card,
    paddingHorizontal: space.lg, paddingVertical: space.md,
    minHeight: 48, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.brand, marginTop: space.md, alignSelf: 'stretch',
  },
  secondaryText: { color: colors.brand, ...type.body, fontWeight: '600' },
  off: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
