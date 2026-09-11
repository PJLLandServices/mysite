// Today's schedule, native.
//
// This replaces the CRM's /admin/today page inside the app. Same data,
// same two actions, same endpoints — the difference is that it is laid
// out like the rest of this app rather than like an admin page that
// happens to be narrow.
//
// One line worth being explicit about: the two buttons at the bottom of
// each card WRITE. "Notify on route" sends a real SMS and email to a
// real customer, and "Start work order" creates a work order when the
// lead hasn't got one. Elsewhere this app reads natively and leaves
// writing to the web pages. These two earn the exception because a
// Today screen that can't do them is worse than the page it replaces —
// so both confirm first, both disable while in flight, and Notify
// disables permanently once it has fired.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  AuthRequiredError,
  createWorkOrderForProperty,
  getToday,
  removeVisit,
  listPropertyWorkOrders,
  notifyOnRoute,
  openWorkOrder,
} from '../api';
import { telHref } from '../format';
import { addDays, fromYmd, startOfWeek, WEEKDAY_INITIALS, ymd } from '../dates';
import DayMap from './DayMap';
import MonthSheet from './MonthSheet';
import { colors, radius, space, type } from '../theme';
import { runningVersionLabel } from '../updates';
import { fieldDay } from '../offline/field';
import { Pill, PickerSheet, PromptSheet } from '../ui';
import { REMOVAL_REASONS, reasonByCode, removalLabel, removalNote } from '../removal-reasons';
import { canAddStop, whereYouAre } from '../add-stop';
import {
  canStartWorkOrder,
  existingWorkOrderFor,
  isFinishedRow,
  routeForRow,
  rowKey,
  workOrderActionLabel,
  workOrderStatusLabel,
} from '../workorder-routing';

const timeOf = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

// All date maths is done on LOCAL dates anchored at noon. Building a
// The date arithmetic lives in ../dates so the week strip and the month
// picker below it cannot disagree about where a week starts.

const longDate = (ymd) => {
  const d = ymd ? new Date(`${ymd}T12:00:00`) : new Date();
  if (Number.isNaN(d.getTime())) return 'Today';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};

export default function TodayScreen({ onOpenWorkOrder, onAddStop, refreshToken = 0, onSignIn }) {
  const [payload, setPayload] = useState(null);
  // The job "Not today" is being asked about, and the reason picked for it.
  const [removing, setRemoving] = useState(null);        // the job being taken off
  const [asking, setAsking] = useState(null);            // { booking, reason }
  const [why, setWhy] = useState('');
  const [removingBusy, setRemovingBusy] = useState(false);
  // The server's idea of today, learned from the first response rather
  // than assumed from the phone's clock — the schedule belongs to the
  // server's day.
  const [serverToday, setServerToday] = useState(null);
  const [selected, setSelected] = useState(null); // null until the first load answers
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Which stop the map is emphasising. Held here rather than in the map
  // so a tap on a card and a tap on a pin move the same one thing.
  const [focusKey, setFocusKey] = useState(null);
  const scrollRef = useRef(null);
  // Mirrors `selected` for the refresh effect below, which must reload the
  // day you are LOOKING at without re-running every time you change days
  // (goTo already fetches those).
  const selectedRef = useRef(null);
  selectedRef.current = selected;
  // Where each card starts, learned from its own layout. A tapped pin has
  // to scroll to its card, and the card is the only thing that knows
  // where it ended up once the week strip and the map are above it.
  const cardTops = useRef(new Map());

  const load = useCallback(async (date) => {
    try {
      const data = await fieldDay(date || undefined);
      setPayload(data);
      if (!date && data?.date) {
        setServerToday(data.date);
        setSelected(data.date);
      }
      setState('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else { setError(err?.message || "Couldn't load the schedule."); setState('error'); }
    }
  }, []);

  useEffect(() => { load(null); }, [load]);

  // Reload when a job closes. The card's label ("Start WO" / "Resume" /
  // "View WO"), the finished dimming and the map's ticks all read
  // `payload`, which was fetched BEFORE the job opened — so without this
  // you finish a closing, dismiss it, and the card still says "Resume".
  // Skips the first render, which `load(null)` above already covers.
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return; }
    load(selectedRef.current || null);
  }, [refreshToken, load]);

  // Any day other than the first one is fetched explicitly.
  const goTo = useCallback((date) => {
    if (!date || date === selected) return;
    setSelected(date);
    setState('loading');
    load(date);
  }, [load, selected]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load(selected);
    setRefreshing(false);
  }, [load, selected]);

  // Take the stop off the day. The server decides from the code whether
  // that is a cancellation or a no-show, and whether the customer hears
  // about it — the phone only says why.
  const applyRemoval = useCallback(async (booking, reason, note) => {
    if (!booking?.bookingId) {
      Alert.alert(
        "Can't remove this one",
        'It has no booking record behind it — a job scheduled straight onto a property. '
        + 'Take it off in the CRM.',
      );
      return;
    }
    setRemovingBusy(true);
    try {
      await removeVisit(booking.bookingId, { reasonCode: reason.code, note });
      setRemoving(null);
      // Refetch rather than patch: the removal changes the driving order
      // of everything after it, and the server is the one that decides
      // that order. Guessing it here is how the map and the list disagree.
      await load(selected);
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else Alert.alert("Didn't remove it", err?.message || 'It is still on the day. Try again.');
    } finally {
      setRemovingBusy(false);
    }
  }, [load, selected]);

  // "Already done" is the one reason that means something went wrong
  // upstream — a double booking, or a job closed without the calendar
  // being told. Patrick asked to be prompted, so the cause is findable in
  // February rather than guessed at.
  const pickReason = useCallback((booking, reason) => {
    setRemoving(null);
    if (!reason?.asksWhy) { applyRemoval(booking, reason, ''); return; }
    // A sheet rather than Alert.prompt, which is iOS-only and does
    // nothing at all on Android — app.json declares an android target.
    setWhy('');
    setAsking({ booking, reason });
  }, [applyRemoval]);

  const open = (url) => Linking.openURL(url).catch(() => {});

  const navigate = (b) => {
    const dest = b.coords && b.coords.lat != null ? `${b.coords.lat},${b.coords.lng}` : b.address || '';
    if (dest) open(`http://maps.apple.com/?daddr=${encodeURIComponent(dest)}`);
  };

  const confirmNotify = (b) => {
    Alert.alert(
      'Notify on route?',
      `Texts and emails ${b.customerName || 'the customer'} to say you're on the way.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send',
          style: 'default',
          onPress: async () => {
            setBusyId(b.leadId);
            try {
              await notifyOnRoute(b.leadId);
              // Reflect it immediately rather than making them refresh
              // to find out whether it went.
              setPayload((prev) => prev && ({
                ...prev,
                bookings: prev.bookings.map((row) =>
                  row.leadId === b.leadId
                    ? { ...row, onRouteNotifiedAt: new Date().toISOString() }
                    : row),
              }));
            } catch (err) {
              Alert.alert('Not sent', err?.message || 'The message did not go. Nothing was sent.');
            } finally {
              setBusyId(null);
            }
          },
        },
      ]
    );
  };

  // A booking with no lead cannot go through /api/leads/:id/open-wo —
  // there is no id to put in the path, and the request 404s. Those rows
  // are property-first (an assignment booking off a season plan), so the
  // work order is raised against the PROPERTY instead, exactly as the
  // CRM's own property page does it.
  //
  // Checked before created: /api/work-orders has no upsert, so a second
  // tap would raise a second work order for the same visit. If the
  // property already has an unfinished one of this type, that is the one
  // that opens.
  const goToWorkOrder = async (b) => {
    const route = routeForRow(b);
    if (route.action === 'open') { onOpenWorkOrder(route.workOrder); return; }
    if (route.action === 'none') return;

    setBusyId(rowKey(b));
    try {
      let wo;
      if (route.action === 'lead') {
        wo = (await openWorkOrder(route.leadId))?.workOrder;
      } else {
        // Property-first. Look before creating: POST /api/work-orders has
        // no upsert, so a second tap would raise a second work order for
        // the same visit.
        const onProperty = await listPropertyWorkOrders(route.propertyId);
        wo = existingWorkOrderFor(onProperty, route.type)
          || await createWorkOrderForProperty({ type: route.type, propertyId: route.propertyId });
      }
      // The whole work order, not a URL: the shell decides from its
      // `type` whether this opens the native closing flow or the full
      // web page, and only it knows which surfaces exist.
      if (wo?.id) onOpenWorkOrder(wo);
      else Alert.alert('No work order', 'The server did not return a work order for this booking.');
    } catch (err) {
      Alert.alert("Couldn't open", err?.message || 'Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const handleWorkOrder = (b) => {
    if (b.workOrder) return goToWorkOrder(b);
    Alert.alert(
      'Start a work order?',
      `Creates a new work order for ${b.customerName || 'this booking'}.`,
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Start', onPress: () => goToWorkOrder(b) }]
    );
  };

  if (state === 'loading') {
    return <View style={styles.centre}><ActivityIndicator color={colors.brand} /></View>;
  }
  if (state === 'auth') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Not signed in</Text>
        <Text style={styles.centreBody}>
          Sign in to PJL to see the day.
        </Text>
        <Pressable onPress={onSignIn} style={styles.retry}><Text style={styles.retryText}>Sign in</Text></Pressable>
      </View>
    );
  }
  if (state === 'error') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Couldn't load</Text>
        <Text style={styles.centreBody}>{error}</Text>
        <Pressable onPress={() => load(selected)} style={styles.retry}><Text style={styles.retryText}>Try again</Text></Pressable>
      </View>
    );
  }

  const bookings = payload?.bookings || [];
  const removed = payload?.removed || [];
  // Changes whenever a row appears, disappears or finishes. That is
  // exactly when the map has to redraw — a completed work order is what
  // turns a numbered pin into a tick, and waiting for a pull-to-refresh
  // to show it would make the map the last thing to know.
  const mapSignature = bookings
    .map((b) => `${rowKey(b)}:${b.workOrder?.status || ''}`)
    .join('|');

  const revealStop = (key) => {
    setFocusKey(key || null);
    const top = key ? cardTops.current.get(key) : null;
    if (top == null || !scrollRef.current) return;
    // A little above the card, so it does not sit welded to the map's
    // bottom edge.
    scrollRef.current.scrollTo({ y: Math.max(0, top - 12), animated: true });
  };
  const versionLabel = runningVersionLabel();
  const anchor = fromYmd(selected || payload?.date || ymd(new Date()));
  const weekStart = startOfWeek(anchor);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekEnd = weekDays[6];
  // "Sep 1 – 7" when a week sits in one month, "Aug 25 – Sep 7" when it
  // straddles two.
  const weekLabel = weekStart.getMonth() === weekEnd.getMonth()
    ? `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${weekEnd.getDate()}`
    : `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.brand} />}
    >
      <View style={styles.week}>
        {/* Today lives with the other date controls, not down beside the
            job count where the first version put it — that is where you
            look for it. It stays visible even when it has nothing to do,
            so its position never moves; a control that appears and
            disappears is a control you have to hunt for. */}
        <View style={styles.weekBar}>
          <Pressable
            onPress={() => goTo(serverToday)}
            disabled={!serverToday || selected === serverToday}
            style={({ pressed }) => [
              styles.todayBtn,
              (!serverToday || selected === serverToday) && styles.todayBtnOff,
              pressed && styles.todayBtnPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Jump to today"
          >
            <Text style={[
              styles.todayBtnText,
              (!serverToday || selected === serverToday) && styles.todayBtnTextOff,
            ]}>Today</Text>
          </Pressable>

          <View style={styles.stepper}>
            <Pressable onPress={() => goTo(ymd(addDays(anchor, -7)))} hitSlop={10} style={styles.step}>
              <Text style={styles.stepText}>‹</Text>
            </Pressable>
            <Pressable
              onPress={() => setPickerOpen(true)}
              hitSlop={8}
              style={({ pressed }) => pressed && styles.weekLabelPressed}
              accessibilityRole="button"
              accessibilityLabel={`${weekLabel}. Open the calendar to pick a date.`}
            >
              <Text style={styles.weekLabel}>{weekLabel}</Text>
            </Pressable>
            <Pressable onPress={() => goTo(ymd(addDays(anchor, 7)))} hitSlop={10} style={styles.step}>
              <Text style={styles.stepText}>›</Text>
            </Pressable>
          </View>
        </View>
        <View style={styles.days}>
          {weekDays.map((d, i) => {
            const key = ymd(d);
            const isSelected = key === selected;
            const isToday = key === serverToday;
            return (
              <Pressable
                key={key}
                onPress={() => goTo(key)}
                style={styles.day}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
              >
                <Text style={[styles.dayInitial, isSelected && styles.daySelectedText]}>
                  {WEEKDAY_INITIALS[i]}
                </Text>
                <View style={[styles.dayPill, isSelected && styles.dayPillSelected]}>
                  <Text style={[styles.dayNum, isSelected && styles.daySelectedText]}>{d.getDate()}</Text>
                </View>
                <View style={[styles.todayDot, isToday && !isSelected && styles.todayDotOn]} />
              </Pressable>
            );
          })}
        </View>
      </View>

      <MonthSheet
        visible={pickerOpen}
        selected={selected}
        today={serverToday}
        onPick={(key) => { setPickerOpen(false); goTo(key); }}
        onClose={() => setPickerOpen(false)}
      />

      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.date}>{longDate(payload?.date)}</Text>
          <Text style={styles.count}>
            {bookings.length ? `${bookings.length} ${bookings.length === 1 ? 'job' : 'jobs'}` : 'Nothing booked'}
          </Text>
          {payload?.offline ? <Text style={styles.count}>Saved schedule · offline · changes may be missing</Text> : null}
        </View>
        {/* A walk-up is not an admin act — the person it happens to is
            whoever is holding the phone on that street, which is usually
            not Patrick. Patrick: "everyone can add a stop". Hidden on a
            day that has already been driven, because backdating a job
            onto a route nobody drove is not a thing anyone means to do. */}
        {onAddStop && canAddStop(selected || payload?.date) ? (
          <Pressable
            onPress={() => onAddStop({
              day: selected || payload?.date || null,
              dayBookings: bookings,
              fromAddress: whereYouAre(bookings),
            })}
            style={({ pressed }) => [styles.addStop, pressed && styles.todayBtnPressed]}
            accessibilityRole="button"
            accessibilityLabel="Add a stop to this day"
          >
            <Text style={styles.addStopText}>＋ Add a stop</Text>
          </Pressable>
        ) : null}
      </View>

      {/* The route, above the list it belongs to. Only when there is a
          route: an empty day would draw an empty map and take 200px of a
          phone screen to say nothing. */}
      {bookings.length ? (
        <DayMap
          date={payload?.date || selected}
          refreshToken={mapSignature}
          focusKey={focusKey}
          onSelectStop={revealStop}
        />
      ) : null}

      {bookings.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>Clear day</Text>
          <Text style={styles.emptyBody}>Nothing is booked for this day. Pull down to check again.</Text>
        </View>
      ) : null}

      {bookings.map((b) => {
        const busy = busyId === rowKey(b);
        // Start WO needs somewhere to hang the work order: a lead, or a
        // property. A row with neither can only be navigated to.
        const canStartWo = canStartWorkOrder(b);
        const notified = !!b.onRouteNotifiedAt;
        const woLabel = b.workOrder ? workOrderStatusLabel(b.workOrder.status) : null;
        const key = rowKey(b);
        return (
          <Pressable
            key={key}
            style={[
              styles.card,
              focusKey === key && styles.cardFocused,
              isFinishedRow(b) && styles.cardDone,
            ]}
            onPress={() => setFocusKey(key)}
            onLayout={(event) => { cardTops.current.set(key, event.nativeEvent.layout.y); }}
            accessibilityLabel={`Show ${b.address || 'this stop'} on the map`}
          >
            <View style={styles.cardTop}>
              <View style={styles.time}>
                <Text style={styles.timeStart}>{b.startLabel || timeOf(b.start) || '—'}</Text>
                {b.endLabel ? <Text style={styles.timeEnd}>{b.endLabel}</Text> : null}
              </View>
              <View style={styles.cardHead}>
                <Text style={styles.name} numberOfLines={1}>{b.customerName || 'Customer'}</Text>
                <Text style={styles.address} numberOfLines={2}>
                  {[b.address, b.town].filter(Boolean).join(', ') || 'No address'}
                </Text>
                <View style={styles.pills}>
                  <Pill tone="brand">{b.serviceLabel || 'Appointment'}</Pill>
                  {woLabel ? <Pill>{woLabel}</Pill> : null}
                  {notified ? <Pill tone="warn">{`On route ${timeOf(b.onRouteNotifiedAt)}`}</Pill> : null}
                </View>
              </View>
            </View>

            {b.customerNotes ? <Text style={styles.note}>{b.customerNotes}</Text> : null}
            {b.internalNotes ? (
              <Text style={[styles.note, styles.internal]}>Internal: {b.internalNotes}</Text>
            ) : null}

            <View style={styles.actions}>
              <Action label="Navigate" onPress={() => navigate(b)} disabled={!b.address && !b.coords} />
              <Action label="Call" onPress={() => open(telHref(b.customerPhone))} disabled={!b.customerPhone} />
              <Action
                label={notified ? 'Notified' : 'Notify'}
                onPress={() => confirmNotify(b)}
                disabled={notified || busy || !b.leadId}
              />
              <Action
                label={workOrderActionLabel(b)}
                onPress={() => handleWorkOrder(b)}
                disabled={busy || !canStartWo}
                primary
              />
              {/* Last, so a thumb reaching for "Work order" never finds
                  it first. Amber rather than red: taking a stop off the
                  day is bookkeeping, not a disaster. */}
              <Action
                label="Not today"
                onPress={() => setRemoving(b)}
                disabled={busy || removingBusy || !b.bookingId}
                warn
              />
            </View>
          </Pressable>
        );
      })}

      {/* WHAT CAME OFF, and why. The list above deliberately drops these
          — nobody should be driven to a dead job — but a stop that simply
          vanishes is the thing you ring about at 4pm. */}
      {removed.length ? (
        <>
          <Text style={styles.removedHead}>
            Removed today ({removed.length})
          </Text>
          {removed.map((r) => (
            <View key={r.bookingId || r.leadId} style={styles.removedCard}>
              <View style={styles.removedTop}>
                <Text style={styles.removedWho} numberOfLines={1}>
                  {r.customerName || 'Customer'}
                </Text>
                <Text style={styles.removedTag}>{removalLabel(r)}</Text>
              </View>
              {r.address ? (
                <Text style={styles.removedAddr} numberOfLines={1}>{r.address}</Text>
              ) : null}
              <Text style={styles.removedWhy}>{removalNote(r)}</Text>
              {/* The free text, when there is any — "already done" asks
                  for it, and it is the half that says what went wrong. */}
              {r.reason && reasonByCode(r.removalCode) && r.reason !== removalLabel(r) ? (
                <Text style={styles.removedNote}>{r.reason}</Text>
              ) : null}
            </View>
          ))}
        </>
      ) : null}

      {versionLabel ? (
        <Text style={styles.version}>App updated {versionLabel}</Text>
      ) : null}
      <View style={styles.footerSpace} />

      <PickerSheet
        visible={Boolean(removing)}
        title={removing ? `Not today — ${removing.customerName || 'this stop'}` : ''}
        options={REMOVAL_REASONS.map((r) => ({ key: r.code, label: r.label, note: r.hint }))}
        selectedKey={null}
        onClose={() => setRemoving(null)}
        onSelect={(item) => {
          const reason = reasonByCode(item.key);
          if (reason && removing) pickReason(removing, reason);
        }}
      />

      <PromptSheet
        visible={Boolean(asking)}
        title={asking?.reason?.whyPrompt || 'What happened?'}
        message={'This is the one that usually means a double booking, or a job closed without '
          + 'the calendar being told. Whatever you put here is what makes it findable later.'}
        placeholder={asking?.reason?.whyPlaceholder || ''}
        value={why}
        onChangeText={setWhy}
        confirmLabel="Remove"
        busy={removingBusy}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          const held = asking;
          setAsking(null);
          if (held) applyRemoval(held.booking, held.reason, why.trim());
        }}
      />
    </ScrollView>
  );
}

function Action({ label, onPress, disabled, primary, warn }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.action,
        primary && styles.actionPrimary,
        warn && styles.actionWarn,
        disabled && styles.actionDisabled,
        pressed && !disabled && styles.actionPressed,
      ]}
    >
      <Text style={[
        styles.actionText,
        primary && styles.actionTextPrimary,
        warn && styles.actionTextWarn,
        disabled && styles.actionTextDisabled,
      ]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  content: { paddingBottom: space.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, backgroundColor: colors.ground },
  centreTitle: { ...type.title, marginBottom: space.sm },
  centreBody: { ...type.label, textAlign: 'center', lineHeight: 21 },
  retry: {
    marginTop: space.lg, backgroundColor: colors.brand,
    paddingHorizontal: space.xl, paddingVertical: space.md, borderRadius: radius.card,
  },
  retryText: { color: '#fff', fontWeight: '600' },

  week: {
    backgroundColor: colors.card,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  weekBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: space.md,
    paddingRight: space.sm,
    paddingBottom: space.sm,
  },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  step: { width: 34, alignItems: 'center' },
  stepText: { fontSize: 24, color: colors.brand, marginTop: -4 },
  weekLabel: { ...type.label, fontWeight: '600', color: colors.text },
  weekLabelPressed: { opacity: 0.55 },
  days: { flexDirection: 'row', paddingHorizontal: space.sm },
  day: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 2 },
  dayInitial: { fontSize: 11, fontWeight: '600', color: colors.textFaint },
  dayPill: {
    width: 34, height: 34, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  dayPillSelected: { backgroundColor: colors.brand },
  dayNum: { fontSize: 16, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  daySelectedText: { color: '#fff' },
  todayDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: 'transparent' },
  todayDotOn: { backgroundColor: colors.brand },

  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md,
    gap: space.md,
  },
  headText: { flexShrink: 1 },
  // Quiet on purpose. It sits beside the day's headline because that is
  // where "what is on today" is answered, but it is not competing with
  // the jobs underneath it — nine days in ten nobody touches it.
  addStop: {
    backgroundColor: colors.brandTint, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: 8, minHeight: 36,
    alignItems: 'center', justifyContent: 'center',
  },
  addStopText: { color: colors.brand, fontWeight: '600', fontSize: 13 },
  todayBtn: {
    backgroundColor: colors.brandTint,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  todayBtnOff: { backgroundColor: 'transparent' },
  todayBtnPressed: { opacity: 0.6 },
  todayBtnText: { color: colors.brand, fontWeight: '600', fontSize: 13 },
  todayBtnTextOff: { color: colors.textFaint },
  date: { ...type.hero },
  count: { ...type.label, marginTop: 2 },

  emptyCard: {
    backgroundColor: colors.card, borderRadius: radius.card,
    marginHorizontal: space.md, padding: space.xl, alignItems: 'center', gap: 6,
  },
  emptyTitle: { ...type.title },
  emptyBody: { ...type.caption, textAlign: 'center' },

  // The border is always there and usually invisible. Growing one on
  // focus would shove every card below it down two pixels at the exact
  // moment the screen is scrolling to one.
  cardFocused: { borderColor: colors.brand },
  // Done, not gone. It was one of the stops; it is what the map ticks.
  // Was `opacity: 0.72` on the whole Pressable — which dimmed the live
  // primary button inside it, so a finished stop read as DISABLED while
  // remaining fully tappable, and sat only 0.27 away from the app's real
  // disabled treatment (0.45). It also washed out cardFocused's brand
  // border on precisely the card you had just tapped. A recessive ground
  // and a softened border say "done" without lying about what is tappable;
  // the Completed pill and the map's tick carry the rest.
  cardDone: { backgroundColor: colors.ground, borderColor: colors.separator },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: 2,
    borderColor: 'transparent',
    marginHorizontal: space.md,
    marginBottom: space.md,
    padding: space.lg,
    gap: space.md,
  },
  cardTop: { flexDirection: 'row', gap: space.md },
  time: { width: 66, flexShrink: 0 },
  timeStart: { ...type.title, fontVariant: ['tabular-nums'] },
  timeEnd: { ...type.caption, fontVariant: ['tabular-nums'] },
  cardHead: { flex: 1, gap: 4 },
  name: { ...type.title },
  address: { ...type.label, lineHeight: 20 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },

  note: { ...type.body, fontSize: 15, lineHeight: 21, color: colors.textMuted },
  internal: { color: colors.textFaint },

  actions: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  action: {
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: space.md,
    borderRadius: radius.card,
    backgroundColor: colors.ground,
  },
  actionPrimary: { backgroundColor: colors.brand },
  actionPressed: { opacity: 0.65 },
  actionDisabled: { opacity: 0.45 },
  actionText: { fontSize: 14, fontWeight: '600', color: colors.brand },
  actionTextPrimary: { color: '#fff' },
  // Amber, not red. Taking a stop off the day is bookkeeping — a red
  // button beside "Work order" reads as "delete the customer".
  actionWarn: { backgroundColor: colors.warningTint },
  actionTextWarn: { color: colors.warning },
  actionTextDisabled: { color: colors.textFaint },

  removedHead: {
    ...type.section, marginTop: space.xl, marginBottom: space.sm,
    marginHorizontal: space.lg,
  },
  removedCard: {
    backgroundColor: colors.card, borderRadius: radius.card,
    marginHorizontal: space.md, marginBottom: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.md, gap: 2,
  },
  removedTop: {
    flexDirection: 'row', alignItems: 'baseline',
    justifyContent: 'space-between', gap: space.md,
  },
  // Struck through, because it was on the day and is not any more —
  // and left legible, because you may want to ring them.
  removedWho: {
    ...type.body, fontWeight: '600', color: colors.textMuted,
    textDecorationLine: 'line-through', flexShrink: 1,
  },
  removedTag: { ...type.section, color: colors.warning, flexShrink: 0 },
  removedAddr: { ...type.caption },
  removedWhy: { ...type.caption, color: colors.textMuted, marginTop: 2 },
  removedNote: { ...type.caption, color: colors.text, lineHeight: 19, marginTop: 2 },

  version: { ...type.caption, textAlign: 'center', paddingTop: space.md },
  footerSpace: { height: space.lg },
});
