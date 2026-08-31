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

import { useCallback, useEffect, useState } from 'react';
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
import { AuthRequiredError, getToday, notifyOnRoute, openWorkOrder } from '../api';
import { telHref } from '../format';
import { colors, radius, space, type } from '../theme';
import { runningVersionLabel } from '../updates';
import { Pill } from '../ui';

const WO_STATUS_LABELS = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  on_site: 'On site',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const timeOf = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

// All date maths is done on LOCAL dates anchored at noon. Building a
// YYYY-MM-DD out of toISOString() would use UTC, which in Toronto is
// four or five hours ahead — enough to ask the server for tomorrow's
// schedule any evening after 8pm. Noon keeps a day safe from DST too.
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fromYmd = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0);
};

const addDays = (date, n) => {
  const c = new Date(date);
  c.setDate(c.getDate() + n);
  return c;
};

// Weeks run Monday to Sunday — a work week, not a calendar-app week.
const startOfWeek = (date) => addDays(date, -((date.getDay() + 6) % 7));

const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const longDate = (ymd) => {
  const d = ymd ? new Date(`${ymd}T12:00:00`) : new Date();
  if (Number.isNaN(d.getTime())) return 'Today';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};

export default function TodayScreen({ onOpenWorkOrder }) {
  const [payload, setPayload] = useState(null);
  // The server's idea of today, learned from the first response rather
  // than assumed from the phone's clock — the schedule belongs to the
  // server's day.
  const [serverToday, setServerToday] = useState(null);
  const [selected, setSelected] = useState(null); // null until the first load answers
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async (date) => {
    try {
      const data = await getToday(date || undefined);
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

  const goToWorkOrder = async (b) => {
    setBusyId(b.leadId);
    try {
      const data = await openWorkOrder(b.leadId);
      const id = data?.workOrder?.id;
      if (id) onOpenWorkOrder(`/admin/work-order/${encodeURIComponent(id)}/tech`);
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
          Open any other tab and sign in to PJL — this screen shares that session.
        </Text>
        <Pressable onPress={() => load(selected)} style={styles.retry}><Text style={styles.retryText}>Try again</Text></Pressable>
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
            <Text style={styles.weekLabel}>{weekLabel}</Text>
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

      <View style={styles.head}>
        <Text style={styles.date}>{longDate(payload?.date)}</Text>
        <Text style={styles.count}>
          {bookings.length ? `${bookings.length} ${bookings.length === 1 ? 'job' : 'jobs'}` : 'Nothing booked'}
        </Text>
      </View>

      {bookings.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>Clear day</Text>
          <Text style={styles.emptyBody}>Nothing is booked for this day. Pull down to check again.</Text>
        </View>
      ) : null}

      {bookings.map((b) => {
        const busy = busyId === b.leadId;
        const notified = !!b.onRouteNotifiedAt;
        const woLabel = b.workOrder ? (WO_STATUS_LABELS[b.workOrder.status] || b.workOrder.status) : null;
        return (
          <View key={b.leadId} style={styles.card}>
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
                disabled={notified || busy}
              />
              <Action
                label={b.workOrder ? 'Open WO' : 'Start WO'}
                onPress={() => handleWorkOrder(b)}
                disabled={busy}
                primary
              />
            </View>
          </View>
        );
      })}

      {versionLabel ? (
        <Text style={styles.version}>App updated {versionLabel}</Text>
      ) : null}
      <View style={styles.footerSpace} />
    </ScrollView>
  );
}

function Action({ label, onPress, disabled, primary }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.action,
        primary && styles.actionPrimary,
        disabled && styles.actionDisabled,
        pressed && !disabled && styles.actionPressed,
      ]}
    >
      <Text style={[styles.actionText, primary && styles.actionTextPrimary, disabled && styles.actionTextDisabled]}>
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

  head: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md },
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

  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
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
  actionTextDisabled: { color: colors.textFaint },

  version: { ...type.caption, textAlign: 'center', paddingTop: space.md },
  footerSpace: { height: space.lg },
});
