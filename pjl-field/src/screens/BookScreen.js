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
//
// THE SERVICE QUESTIONS DO NOT SCROLL, which is why they have a slide of
// their own. Stacked on the end of the address slide they were a wall of
// six buttons and then eight more — "I currently have to scroll through".
// They are SELECTS now: one row per question, the choices in a sheet, so
// the tallest that slide ever gets is three rows and it fits on an SE. It
// is the same sheet the Properties tab opens for its town filter, shared
// rather than copied.
//
// The details slide is still a form and still scrolls — five contact
// fields and a notes box do not fit a phone, and hiding half of them
// behind a disclosure would be worse. What it does NOT do is ask anything
// twice: everything the earlier slides settled is one summary card at the
// top, not a second set of questions.
//
// THE SLOT IS HELD WHILE THE DETAILS ARE TAKEN. The server refuses a
// standard booking that does not arrive holding its slot — otherwise two
// people fill in the whole form for one time and only one of them can
// have it. Its exemptions are all cases with no form being filled in, and
// a booking taken on the phone is the opposite of that: it is the longest
// form in the flow. So the hold is taken the moment a time is chosen, the
// token rides on the reserve, and changing your mind releases the old one
// rather than eating a second slot's worth of capacity.
//
// THE KEYBOARD GOES AWAY the moment an address is settled. It used to sit
// over the confirmation and the button under it, so the next tap was
// really two.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
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
  holdSlot,
  releaseHold,
  whyNoDays,
  listProperties,
  listServices,
  reserveBooking,
  suggestAddresses,
  verifyAddress,
} from '../api';
import {
  bandForZones,
  bandLabel,
  bandsFor,
  catalogNotes,
  categoriesInOrder,
  FOLLOW_UPS,
  ISSUE_COUNTS,
  issueCountLabel,
  serviceKeyFor,
  zoneOptionsFor,
} from '../booking-catalog';
import { colors, radius, space, type } from '../theme';
import { PickerSheet, SelectRow } from '../ui';

export const STEPS = ['address', 'service', 'when', 'who'];

// The steps you are allowed to swipe to: as far forward as you have
// actually GOT, not as far as you happen to be standing.
//
// It used to read off the current step, which meant swiping back from the
// day list collapsed the pager to one page and stranded you there — you
// had to re-tap your way forward through work you had already done. The
// furthest point reached is the honest boundary: everything behind it has
// been answered, and nothing in front of it exists yet.
export function reachedSteps(furthest) {
  const i = STEPS.indexOf(furthest);
  return STEPS.slice(0, i < 0 ? 1 : i + 1);
}

// The later of two steps, so going back never shortens the pager.
export function laterStep(a, b) {
  return STEPS.indexOf(b) > STEPS.indexOf(a) ? b : a;
}

// The wall-clock time a hold runs out, in the form a watch shows it.
export function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// What the zone answer says out loud. 'unsure' is a real value the server
// takes — it must not read as the number zero, or as nothing asked.
export function zoneCountLabel(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v === 'unsure') return 'Not sure yet';
  return `${v} zone${v === '1' ? '' : 's'}`;
}

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

// What the picker says about a service's season, in words a customer can
// be told. `season` comes from /api/booking/services, derived server-side
// from the same authority the availability gate uses.
//
// This exists because picking "Spring opening" on 8 September produced an
// empty calendar and nothing else — and an empty calendar in front of a
// customer reads as "we're full", which is the opposite of "that season
// ended in June".
export function seasonNote(service) {
  const s = service?.season;
  if (!s || s.open) return null;
  const when = (iso) => {
    const d = new Date(`${iso}T12:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    // THE YEAR, when it is not this one. Read on 8 September, a bare
    // "Dates from Mar 1" is next March — and reads like this March, which
    // has been and gone.
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
    });
  };
  // DATES, not permission. Fall 2026's window is Sep 28 - Oct 30: booking
  // has been open since Sep 1, and what starts on the 28th is the range
  // of days work can be put on. Saying "Booking opens September 28" on
  // the 8th told the owner he could not do something he had been able to
  // do for a week.
  if (s.startsOn) return `Dates from ${when(s.startsOn)}`;
  if (s.closed) return 'Season is over for this year';
  return null;
}

// Whether the service can be booked AT ALL today — which is not the same
// question as whether its dates have started. A season beginning three
// weeks out is bookable now; one that ended in June is not.
export function seasonShut(service) {
  const s = service?.season;
  return Boolean(s) && s.bookable === false;
}

// The text Patrick sends. Names the EXACT day and time that was just
// reserved — not "your appointment is confirmed", which tells a customer
// on the phone nothing they can write down.
export function confirmationText({ dayLabel, timeLabel, serviceLabel, address, standby }) {
  const where = address ? ` At ${address}.` : '';
  const what = serviceLabel ? ` ${serviceLabel}.` : '';
  // A standby booking has no day yet — saying one would be a promise
  // nobody can keep.
  if (standby) {
    return `PJL Land Services — you're on the list for the next time we're`
      + ` in your area.${what}${where} I'll text you the date as soon as it's set.`;
  }
  const when = [dayLabel, timeLabel].filter(Boolean).join(', ');
  return `PJL Land Services — you're booked for ${when}.`
    + `${what}${where}`
    + ` Reply here if anything changes.`;
}

// "First available" — the open bucket, and the reason a full calendar is
// not a dead end. The website's picker carries this card ALWAYS
// (`allowOpenBucket: true` in js/booking.js), and selecting it books no
// slot: the customer joins the standby list and gets placed onto a route
// day from the Season Plan later. Without it, an address the corridor
// cannot place efficiently — past the 40-minute widening cap — reads as
// "there is no space", which is false and loses the job.
//
// Site visits are the one exception, and the server enforces it: a
// consult needs a real time, so it returns `standby_unsupported`.
export function openBucketAllowed(service) {
  return Boolean(service) && service.category !== 'consult';
}

// The shape a slot takes when there is no slot.
const OPEN_BUCKET = {
  openBucket: true,
  start: null,
  dayLabel: 'First available',
  timeLabel: "when we're next nearby",
};

// Why the suggestions are empty, in words that point at the actual fix.
// "Google isn't answering" was true of every failure and useful for none
// of them — including the one that turned out to be a route that was
// never deployed.
export function suggestReason(d) {
  if (!d) return null;
  const tail = ' Type the address in full — it still books.';
  if (d.degraded === 'no_key') {
    return 'Suggestions are off: GOOGLE_MAPS_SERVER_KEY is not set on the server.' + tail;
  }
  if (d.degraded === 'google') {
    // REQUEST_DENIED is nearly always the Places API not being enabled on
    // the project, or the key being restricted to Geocoding and Distance
    // Matrix. Naming it saves an hour of looking at the app.
    const what = d.googleStatus === 'REQUEST_DENIED'
      ? 'Google refused the request — the Places API is probably not enabled for this key.'
      : `Google returned ${d.googleStatus || 'an error'}.`;
    return `${what}${d.googleMessage ? ` (${d.googleMessage})` : ''}${tail}`;
  }
  return "Couldn't reach the suggestion service." + tail;
}

const clean = (v) => String(v || '').trim();

export default function BookScreen({ onSignIn }) {
  const [step, setStep] = useState('address');
  // The furthest slide reached, which is what the pager's extent is drawn
  // from — see reachedSteps.
  const [furthest, setFurthest] = useState('address');
  // Which question's sheet is open, or null. One at a time, so one sheet.
  const [sheet, setSheet] = useState(null);
  const pagerRef = useRef(null);
  const [pageWidth, setPageWidth] = useState(0);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  const [properties, setProperties] = useState([]);
  const [services, setServices] = useState({});

  // --- Slide 1: the address -------------------------------------------
  const [typed, setTyped] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  // Why suggestions are absent, when they are. Silence here reads as a
  // broken app; naming it reads as a setting somebody can fix.
  const [suggestDegraded, setSuggestDegraded] = useState(null);
  const [picked, setPicked] = useState(null);      // an existing property, or null
  const [verified, setVerified] = useState(null);  // { address, minutes }
  const [checking, setChecking] = useState(false);

  // --- The cascade: category, then whatever it asks ---------------------
  const [category, setCategory] = useState(null);
  const [band, setBand] = useState(null);
  const [issueCount, setIssueCount] = useState('');

  // --- Slide 2: the day ------------------------------------------------
  const [serviceKey, setServiceKey] = useState('');
  const [days, setDays] = useState([]);
  const [loadingDays, setLoadingDays] = useState(false);
  const [slot, setSlot] = useState(null);
  // The ten-minute claim on `slot`: { token, expiresAt }. Null for the open
  // bucket, which has no slot to hold.
  const [hold, setHold] = useState(null);
  const [holding, setHolding] = useState(false);

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

  // Keep the pager on the step. Setting `step` from a button scrolls the
  // pages across; a swipe sets `step` and lands here as a no-op.
  useEffect(() => {
    if (!pageWidth) return;
    const i = STEPS.indexOf(step);
    if (i >= 0) pagerRef.current?.scrollTo({ x: i * pageWidth, animated: true });
  }, [step, pageWidth]);

  // Which address the screen is on. Bumped whenever one is abandoned, so a
  // reply for the old one is dropped rather than applied to the new.
  const gen = useRef(0);

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
        .then((res) => {
          if (mine !== seq.current) return;
          setSuggestions(res.suggestions);
          setSuggestDegraded(res.degraded ? { ...res } : null);
        })
        // A dead suggestion service must never block a booking: the tech
        // types the address and verify-address still does the real work.
        .catch(() => {
          if (mine !== seq.current) return;
          setSuggestions([]);
          setSuggestDegraded('upstream');
        });
    }, 350);
    return () => clearTimeout(t);
  }, [typed, verified]);

  const categories = useMemo(() => categoriesInOrder(services), [services]);
  const bands = useMemo(
    () => (category?.family ? bandsFor(services, category.family) : []),
    [services, category],
  );
  const chosenServiceKey = serviceKeyFor(category, band);

  // The steps that actually exist yet. You cannot swipe to a day list
  // before an address has been checked, because there isn't one.
  const reached = reachedSteps(furthest);
  // Enough to go and get days for. The exact zone count is wanted but not
  // required — "unsure" is a value the server understands, and holding the
  // calendar back over it would stall a live phone call.
  const readyForDays = Boolean(
    chosenServiceKey && (category?.follow !== 'zones' || band),
  );
  const noneBookable = days.length > 0 && !days.some((d) => d.slots?.length);
  const onFile = useMemo(() => matchProperties(properties, typed), [properties, typed]);
  const service = serviceKey ? { key: serviceKey, ...(services[serviceKey] || {}) } : null;

  // Forward. `furthest` only ever grows here, so swiping back and forward
  // again costs nothing.
  const go = (next) => {
    setStep(next);
    setFurthest((f) => laterStep(f, next));
  };

  // Backward, and destructively: everything after this step is no longer
  // true, so the slides holding it are taken away rather than left showing
  // a stale day list. Both values move together — a step further along
  // than the pager's extent would scroll to a page that isn't there.
  const clamp = (to) => {
    setStep(to);
    setFurthest(to);
  };

  // Give the slot back. Best-effort and never awaited into a flow: the
  // hold lapses on its own in ten minutes, so the worst a failure costs is
  // ten minutes of one slot's capacity.
  const dropHold = () => {
    if (hold?.token) releaseHold(hold.token);
    setHold(null);
  };

  // Typing over a settled address invalidates it — and with it the days
  // and the slot that were chosen for it. Left standing, the day slide
  // would be reading `verified.address` for an address that no longer
  // exists.
  const unsettle = () => {
    // Abandon anything in flight for the address being replaced, BEFORE
    // the early return below — a verify started a second ago is exactly
    // the case where nothing is settled yet, and it is the one that must
    // not be allowed to land. Otherwise typing over an address mid-check
    // brings the old one back as confirmed.
    gen.current += 1;
    // Called on every keystroke. With nothing settled there is nothing to
    // take away, and `setDays([])` would hand React a new array each time.
    if (!verified && !picked && !slot && !days.length && furthest === 'address') return;
    dropHold();
    setVerified(null);
    setPicked(null);
    setDays([]);
    setSlot(null);
    clamp('address');
  };

  // Everything we already know about a customer already in the book.
  // Clears the box AND everything it settled. A confirmed address left
  // sitting under a half-typed new one is how the wrong property gets
  // booked.
  const clearAddress = () => {
    setTyped('');
    setSuggestions([]);
    setSuggestDegraded(null);
    setCategory(null);
    setBand(null);
    setServiceKey('');
    setZoneCount('');
    setIssueCount('');
    // AND THE CONTACT. Taking a property from the book fills in its
    // customer's name, phone and email; clearing the box and typing a
    // different address left them sitting there, and the next booking went
    // out under the last customer's name and number.
    setFirstName('');
    setLastName('');
    setPhone('');
    setAltPhone('');
    setEmail('');
    unsettle();
  };

  const pickCategory = (c) => {
    setCategory(c);
    setBand(null);
    setDays([]);
    setSlot(null);
    // The days were fetched for the old service. Changing it takes that
    // slide away rather than leaving days nobody asked for.
    clamp('service');
    // A category with one service needs no follow-up to know what it is.
    setServiceKey(c.family ? '' : c.serviceKey || '');
    // Zones already on file pick the band for you.
    if (c.family && clean(zoneCount)) {
      const b = bandForZones(bandsFor(services, c.family), zoneCount, { commercial: false });
      if (b) setBand(b);
    }
  };

  const pickBand = (b) => {
    setBand(b);
    setServiceKey(b.key);
    setDays([]);
    setSlot(null);
    clamp('service');
    // A count the new band cannot hold is exactly the contradiction the
    // two answers exist to avoid — "7" under "1-4 zones". Drop it and ask
    // again, scoped to the band just chosen.
    const n = Number(zoneCount);
    if (Number.isFinite(n) && !zoneOptionsFor(bands, b).includes(n)) setZoneCount('');
  };

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
    // THE KEYBOARD GOES AWAY. It sat over the ✓ and the button beneath it,
    // so picking an address and then getting on with the call was two taps
    // and a guess at where the button had gone.
    Keyboard.dismiss();
    const mine = ++gen.current;
    setChecking(true);
    setSuggestions([]);
    try {
      const res = await verifyAddress(value);
      // Cleared or retyped while the server was thinking: the address this
      // answers for is gone, and putting it back would undo the ✕.
      if (mine !== gen.current) return;
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

  // The one place that asks for days, so the two callers below cannot
  // drift about what a stale reply means.
  const fetchDays = async (key) => {
    const mine = gen.current;
    const res = await bookingAvailability({ service: key, address: verified.address });
    // Swiping back and editing the address mid-request would otherwise drop
    // the user onto a day slide with nothing on it.
    return mine === gen.current ? (res.days || []) : null;
  };

  const showDays = async (key) => {
    if (!verified || !key) return;
    setServiceKey(key);
    setLoadingDays(true);
    setDays([]);
    setSlot(null);
    dropHold();
    // The slot just went. Asking for days again after swiping back left
    // the details slide mounted and reading `slot.dayLabel` off null,
    // which is a crash in the middle of a phone call.
    clamp('service');
    try {
      const fresh = await fetchDays(key);
      if (fresh === null) return;
      setDays(fresh);
      go('when');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else Alert.alert("Couldn't load available days", err?.message || 'Try again.');
    } finally {
      setLoadingDays(false);
    }
  };

  // Back to a fresh day list without leaving the day slide — what happens
  // when a time turns out to be gone. `clamp('when')` rather than
  // 'service' so he is not bounced through a slide he did not ask for.
  const reloadDays = async () => {
    if (!verified || !serviceKey) return;
    setSlot(null);
    dropHold();
    clamp('when');
    setLoadingDays(true);
    setDays([]);
    try {
      const fresh = await fetchDays(serviceKey);
      if (fresh !== null) setDays(fresh);
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
    } finally {
      setLoadingDays(false);
    }
  };

  // Claim the time, THEN take their details — which is the order the hold
  // exists to enforce. A slot that cannot be held is one that would be
  // refused at "Book it" anyway, and finding out now costs the call
  // nothing; finding out at the end costs it the customer.
  const takeSlot = async () => {
    if (!slot || holding) return;
    // The open bucket has no slot to hold, and the server exempts it for
    // exactly that reason.
    if (slot.openBucket) { go('who'); return; }
    setHolding(true);
    try {
      const res = await holdSlot({
        serviceKey,
        slotStart: slot.start,
        address: verified.address,
        // Changing your mind must not eat two units of capacity.
        releaseToken: hold?.token,
      });
      setHold({ token: res.holdToken || null, expiresAt: res.expiresAt || null });
      go('who');
    } catch (err) {
      if (err instanceof AuthRequiredError) { setState('auth'); return; }
      Alert.alert(
        err?.code === 'slot_taken' ? 'That time just went' : "Couldn't hold that time",
        err?.message || 'Pick another time.',
      );
      reloadDays();
    } finally {
      setHolding(false);
    }
  };

  // A count of 7 moves the band to 7-8 rather than leaving a contradiction
  // on screen. The sheet is already scoped to the band, so this is the
  // path that matters: a zone count read off an existing property's file.
  // Stays inside the property type already chosen — a commercial site does
  // not get snapped into a residential tier.
  const onZones = (value) => {
    setZoneCount(String(value));
    if (!category?.family) return;
    const better = bandForZones(bands, value, { commercial: Boolean(band?.commercial) });
    if (better && better.key !== band?.key) {
      setBand(better);
      setServiceKey(better.key);
      // CHANGING THE BAND CHANGES WHAT IS BEING BOOKED, and every other
      // handler that does that says so. Left out, a count that moved the
      // band re-pointed the booking at a longer, differently-priced
      // service while the day list and the chosen slot stayed alive — so
      // "Book it" would send the new service against a slot sized for the
      // old one.
      setDays([]);
      setSlot(null);
      clamp('service');
    }
  };

  const confirm = async () => {
    if (!slot || booking) return;
    setBooking(true);
    try {
      const name = [clean(firstName), clean(lastName)].filter(Boolean).join(' ');
      await reserveBooking({
        serviceKey,
        // A standby booking has no slot — that is the whole point of it.
        ...(slot.openBucket
          ? { standby: true }
          : { slotStart: slot.start, holdToken: hold?.token }),
        zoneCount: clean(zoneCount) || 'unsure',
        contact: {
          name,
          firstName: clean(firstName),
          lastName: clean(lastName),
          phone: clean(phone),
          altPhone: clean(altPhone),
          email: clean(email),
          address: verified.address,
          // What the category asked for, written where a tech will read
          // it. The server has no field for "how many issues" — rather
          // than invent one, it is recorded in the notes and labelled.
          notes: [catalogNotes({ category, zoneCount, issueCount }), clean(notes)]
            .filter(Boolean).join(' ')
            .trim(),
        },
      });
      // Reserve consumes the hold; keeping the token would mean trying to
      // release one that no longer exists.
      setHold(null);
      setDone({
        slot,
        text: confirmationText({
          dayLabel: slot.dayLabel,
          timeLabel: slot.timeLabel,
          serviceLabel: service?.label,
          address: verified.address,
          standby: slot.openBucket === true,
        }),
      });
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else {
        // These three all mean the same thing to the person on the phone:
        // the time is not yours, pick again. Anything else leaves the form
        // exactly as it is, because retyping a customer's details because
        // the server hiccuped is unforgivable.
        const lostTheSlot = err?.code === 'hold_expired'
          || err?.code === 'hold_required'
          || err?.code === 'slot_taken';
        Alert.alert(
          lostTheSlot ? 'That time is no longer yours' : "That slot didn't take",
          err?.message || 'Nothing was booked. Pick another time, or try again.',
        );
        if (lostTheSlot) reloadDays();
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
    setCategory(null); setBand(null); setIssueCount('');
    setFirstName(''); setLastName(''); setPhone(''); setAltPhone('');
    setEmail(''); setZoneCount(''); setNotes('');
    setSheet(null);
    dropHold();
    clamp('address');
  };

  // EVERY QUESTION IS A SHEET, and there is one of them. Each entry says
  // what it asks, what is currently answered, and what the answer does —
  // so the slide itself holds rows, not lists.
  const sheets = {
    service: {
      title: 'What are we booking?',
      selectedKey: category?.key || null,
      // Season in progress first, and the note says why the others are
      // where they are. A spent season still shows: Patrick books work
      // the public flow will not, and hiding it is its own lie.
      options: categories.map((c) => ({ key: c.key, label: c.label, note: seasonNote(c) })),
      onSelect: (o) => {
        const c = categories.find((x) => x.key === o.key);
        if (c) pickCategory(c);
      },
    },
    band: {
      title: FOLLOW_UPS.zones,
      selectedKey: band?.key || null,
      // Residential and commercial under their own headers, because their
      // tiers genuinely differ — one 5-8 where residential splits 5-6.
      options: bands.map((b) => ({
        key: b.key,
        label: bandLabel(bands, b),
        group: b.commercial ? 'Commercial' : 'Residential',
      })),
      onSelect: (o) => {
        const b = bands.find((x) => x.key === o.key);
        if (b) pickBand(b);
      },
    },
    zones: {
      title: 'How many zones exactly?',
      selectedKey: clean(zoneCount) || null,
      options: zoneOptionsFor(bands, band)
        .map((n) => ({ key: String(n), label: zoneCountLabel(String(n)) }))
        .concat([{ key: 'unsure', label: 'Not sure yet', note: 'The tech counts them on site' }]),
      onSelect: (o) => onZones(o.key),
    },
    issues: {
      title: FOLLOW_UPS.issues,
      selectedKey: clean(issueCount) || null,
      options: ISSUE_COUNTS.map((v) => ({ key: v, label: issueCountLabel(v) })),
      onSelect: (o) => setIssueCount(o.key),
    },
  };
  const asking = sheet ? sheets[sheet] : null;

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
        <Text style={styles.bookedWhen}>
          {done.slot.openBucket
            ? 'On the list — first available'
            : `${done.slot.dayLabel}, ${done.slot.timeLabel}`}
        </Text>
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

      {/* Swipe sideways between the three steps. The pager and the `step`
          state drive each other: a swipe reports which page settled, and
          setting `step` scrolls to it — so the back links, the pips and
          the gesture never disagree about where you are. Pages you have
          not reached are not swipeable to; `pageWidth` is measured rather
          than assumed so it is right on any handset. */}
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={reached.length > 1}
        onLayout={({ nativeEvent }) => setPageWidth(nativeEvent.layout.width)}
        onMomentumScrollEnd={({ nativeEvent: e }) => {
          if (!pageWidth) return;
          const i = Math.round(e.contentOffset.x / pageWidth);
          const next = reached[Math.max(0, Math.min(reached.length - 1, i))];
          if (next && next !== step) setStep(next);
        }}
      >
      {reached.map((pageKey) => (
      <ScrollView
        key={pageKey}
        style={pageWidth ? { width: pageWidth } : undefined}
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
      {(() => { const step = pageKey; return (<>
        {/* ---- 1. The address ------------------------------------------ */}
        {step === 'address' ? (
          <>
            <Text style={styles.lead}>What's the address?</Text>
            <View style={styles.addressField}>
              <TextInput
                style={[styles.input, styles.addressInput]}
                value={typed}
                onChangeText={(v) => { setTyped(v); unsettle(); }}
                placeholder="Start typing…"
                placeholderTextColor={colors.textFaint}
                autoCorrect={false}
                autoCapitalize="words"
                returnKeyType="search"
                onSubmitEditing={() => settleAddress(typed)}
              />
              {/* Clears the box outright, so the next address starts from
                  nothing — and clears what the last one settled with it,
                  because a confirmed address under a half-typed new one is
                  how the wrong property gets booked. */}
              {clean(typed) ? (
                <Pressable
                  onPress={clearAddress}
                  hitSlop={12}
                  style={styles.clearBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Clear the address"
                >
                  <Text style={styles.clearGlyph}>✕</Text>
                </Pressable>
              ) : null}
            </View>

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

            {!verified && suggestDegraded && typed.trim().length >= 3 ? (
              <Text style={styles.hint}>
                {suggestReason(suggestDegraded)}
              </Text>
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

                {/* And that is the whole slide. The service questions used
                    to hang off the bottom of it, which made the one slide
                    that must stay short the longest one in the app. */}
                <Pressable
                  onPress={() => go('service')}
                  style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
                >
                  <Text style={styles.primaryText}>What are we booking?</Text>
                </Pressable>
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

        {/* ---- 2. What we are booking ---------------------------------- */}
        {step === 'service' ? (
          <>
            <Pressable onPress={() => setStep('address')} hitSlop={10}>
              <Text style={styles.back} numberOfLines={1}>
                ‹ {verified?.address || 'Address'}
              </Text>
            </Pressable>
            <Text style={styles.lead}>What are we booking?</Text>

            {/* THREE ROWS AT MOST, and usually one. Nineteen services
                became six questions; six questions became a row with the
                answer written in it. */}
            <SelectRow
              label="Service"
              value={category?.label}
              note={category ? seasonNote(category) : null}
              placeholder="Choose"
              onPress={() => setSheet('service')}
            />

            {category?.follow === 'zones' ? (
              <SelectRow
                label="Zones"
                value={band
                  ? `${bandLabel(bands, band)} · ${band.commercial ? 'commercial' : 'residential'}`
                  : ''}
                placeholder="Which band?"
                onPress={() => setSheet('band')}
              />
            ) : null}

            {/* The exact number, once the band is chosen. Two answers
                because they are two things: the band is what we are
                selling, the count is what is in the ground. */}
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

            {/* Said here rather than discovered as an empty calendar. A
                season whose dates are spent is still bookable by Patrick —
                "after that i have control to open up further bookings" —
                so this is a warning, not a block. */}
            {category && seasonShut(category) ? (
              <Text style={styles.hint}>
                Those dates are past for this year, so the day list will come back
                empty until the season is opened up.
              </Text>
            ) : null}

            {/* Present from the start, lit when the questions are answered
                — so the slide never changes height as it is filled in. */}
            <Pressable
              onPress={() => showDays(chosenServiceKey)}
              disabled={!readyForDays || loadingDays}
              style={({ pressed }) => [
                styles.primary,
                (!readyForDays || loadingDays) && styles.off,
                pressed && styles.pressed,
              ]}
            >
              {loadingDays
                ? <ActivityIndicator color={colors.onBrand} size="small" />
                : <Text style={styles.primaryText}>See available days</Text>}
            </Pressable>
          </>
        ) : null}

        {/* ---- 3. The day ---------------------------------------------- */}
        {step === 'when' && verified ? (
          <>
            <Pressable onPress={() => setStep('service')} hitSlop={10}>
              <Text style={styles.back} numberOfLines={1}>
                {/* The CATEGORY, not the service. `service.label` is the
                    server's own — "Fall winterization (5-6 zones
                    residential)" — which is the whole line and then some
                    on a back link. */}
                ‹ {[category?.label, zoneCountLabel(zoneCount)].filter(Boolean).join(' · ')
                   || 'What we are booking'}
              </Text>
            </Pressable>
            <Text style={styles.lead}>Read them the days</Text>
            <Text style={styles.hint}>{verified.address} · {service?.label}</Text>

            {/* WHY, not "no space". The server hands back a reason per
                day and they are not the same problem: out of season,
                outside the route area that week, or genuinely full. */}
            {noneBookable ? (
              <View style={styles.emptyDays}>
                <Text style={styles.emptyTitle}>{whyNoDays(days) || 'No open days.'}</Text>
                <Text style={styles.hint}>
                  {openBucketAllowed(service)
                    ? 'They can still go on the list below — that is what the website offers too.'
                    : 'A site visit needs a real time, so it cannot go on the standby list.'}
                </Text>
              </View>
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

            {/* ALWAYS present, exactly as it is on the website — not a
                fallback that appears only when the list is empty. Some
                customers take it over a date three weeks out. */}
            {openBucketAllowed(service) ? (
              <Pressable
                onPress={() => setSlot(OPEN_BUCKET)}
                style={({ pressed }) => [
                  styles.bucket,
                  slot?.openBucket && styles.bucketOn,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.bucketTitle, slot?.openBucket && styles.bucketTitleOn]}>
                  First available
                </Text>
                <Text style={styles.bucketBody}>
                  No fixed date — they go on the list and you place them from the
                  Season Plan when you're next nearby.
                </Text>
              </Pressable>
            ) : null}

            {slot ? (
              <Pressable
                onPress={takeSlot}
                disabled={holding}
                style={({ pressed }) => [styles.primary, holding && styles.off, pressed && styles.pressed]}
              >
                {holding
                  ? <ActivityIndicator color={colors.onBrand} size="small" />
                  : (
                    <Text style={styles.primaryText}>
                      {slot.openBucket
                        ? "They'll take first available"
                        : `They'll take ${slot.dayLabel}, ${slot.timeLabel}`}
                    </Text>
                  )}
              </Pressable>
            ) : null}
          </>
        ) : null}

        {/* ---- 4. Who they are ----------------------------------------- */}
        {step === 'who' && slot && verified ? (
          <>
            <Pressable onPress={() => setStep('when')} hitSlop={10}>
              <Text style={styles.back}>‹ Days</Text>
            </Pressable>

            {/* Everything the earlier slides settled, in one card. It was
                three separate read-only rows below the form, which is
                150pt of a slide that is already long — and they read as
                more fields to fill in rather than as a summary. */}
            <View style={styles.holding}>
              <Text style={styles.holdingWhen}>
                {slot.openBucket ? 'First available' : `${slot.dayLabel}, ${slot.timeLabel}`}
              </Text>
              {/* Auto-populated from slide one — asked once, not twice. */}
              <Text style={styles.holdingWhere}>{verified.address}</Text>
              {/* Ten minutes is generous for a phone call and short enough
                  to matter, so it is said rather than discovered. */}
              {hold?.expiresAt ? (
                <Text style={styles.heldUntil}>Held until {clockOf(hold.expiresAt)}</Text>
              ) : null}
              <Text style={styles.holdingWhat}>
                <Text style={styles.holdingKey}>Booking</Text>
                {`  ${service?.label || '—'}`}
                {clean(zoneCount) ? ` · ${zoneCountLabel(zoneCount)}` : ''}
                {clean(issueCount) ? ` · ${issueCountLabel(issueCount)}` : ''}
              </Text>
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
      </>); })()}
      </ScrollView>
      ))}
      </ScrollView>

      {/* The app's one sheet. Which question it is asking is the only
          thing that changes — so there is a single modal on this screen
          rather than one per question, and they cannot open at once. */}
      <PickerSheet
        visible={Boolean(asking)}
        title={asking?.title}
        options={asking?.options || []}
        selectedKey={asking?.selectedKey ?? null}
        onClose={() => setSheet(null)}
        onSelect={(item) => {
          asking?.onSelect(item);
          setSheet(null);
        }}
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

  addressField: { justifyContent: 'center' },
  // Room for the ✕ so a long address never runs underneath it.
  addressInput: { paddingRight: 44 },
  clearBtn: {
    position: 'absolute', right: 6,
    width: 32, height: 32, borderRadius: radius.pill,
    backgroundColor: colors.separator,
    alignItems: 'center', justifyContent: 'center',
  },
  clearGlyph: { color: colors.card, fontSize: 15, fontWeight: '700', lineHeight: 17 },
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

  holding: {
    backgroundColor: colors.brandTint, borderRadius: radius.card,
    padding: space.md, gap: 2, marginBottom: space.sm,
  },
  holdingWhen: { ...type.body, fontWeight: '700', color: colors.brand },
  holdingWhere: { ...type.caption, color: colors.text },
  holdingWhat: { ...type.caption, color: colors.text, marginTop: 2, lineHeight: 18 },
  heldUntil: { ...type.caption, color: colors.warning, fontWeight: '600', marginTop: 2 },
  holdingKey: { ...type.caption, color: colors.brand, fontWeight: '700' },

  emptyDays: {
    backgroundColor: colors.warningTint, borderRadius: radius.card,
    padding: space.md, gap: space.xs, marginTop: space.sm,
  },
  emptyTitle: { ...type.body, fontWeight: '600', color: colors.warning },
  bucket: {
    backgroundColor: colors.card, borderRadius: radius.card,
    padding: space.md, gap: space.xs, marginTop: space.lg,
    borderWidth: 1, borderColor: colors.separator,
  },
  bucketOn: { borderColor: colors.brand, backgroundColor: colors.brandTint },
  bucketTitle: { ...type.body, fontWeight: '600' },
  bucketTitleOn: { color: colors.brand, fontWeight: '700' },
  bucketBody: { ...type.caption, lineHeight: 19 },
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
