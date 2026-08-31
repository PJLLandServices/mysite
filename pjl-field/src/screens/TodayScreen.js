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

const longDate = (ymd) => {
  const d = ymd ? new Date(`${ymd}T12:00:00`) : new Date();
  if (Number.isNaN(d.getTime())) return 'Today';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
};

export default function TodayScreen({ onOpenWorkOrder }) {
  const [payload, setPayload] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      setPayload(await getToday());
      setState('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else { setError(err?.message || "Couldn't load today's schedule."); setState('error'); }
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

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
        <Pressable onPress={load} style={styles.retry}><Text style={styles.retryText}>Try again</Text></Pressable>
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

  const bookings = payload?.bookings || [];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.brand} />}
    >
      <View style={styles.head}>
        <Text style={styles.date}>{longDate(payload?.date)}</Text>
        <Text style={styles.count}>
          {bookings.length ? `${bookings.length} ${bookings.length === 1 ? 'job' : 'jobs'}` : 'Nothing booked'}
        </Text>
      </View>

      {bookings.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>Clear day</Text>
          <Text style={styles.emptyBody}>Nothing is booked for today. Pull down to check again.</Text>
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

  head: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.md },
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

  footerSpace: { height: space.lg },
});
