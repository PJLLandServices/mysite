// One conversation.
//
// THE LOOK IS iMESSAGE. THE TRUTH IS EMAIL. Both halves of that matter.
//
// The look: bubbles, the customer on the left in grey, PJL on the right
// in the brand green, tails omitted because a flat radius reads cleaner
// at this size, a day divider when the date changes, and the newest
// message at the bottom with the view opening there. Anyone who has used
// a phone can read this without being taught it.
//
// The truth: a reply POSTs to the CRM, is committed to the thread, and
// is then EMAILED to the customer — fire-and-forget, `.catch(() => {})`
// on the server, so a dead SMTP leaves the reply saved with nobody
// told. It is not an SMS and it never was. So this screen will not say
// "Delivered" and will not say "Sent"; it says "Emailed", and the
// composer says so too. A green bubble that reads "Delivered" over a
// message that went to an inbox is the kind of small lie that ends with
// someone standing in a driveway insisting they texted.
//
// What it CAN say honestly is "Read" — the customer's portal marks
// admin replies read (POST /api/portal/:token/messages/read), so
// readByCustomer is a real receipt rather than a hopeful one.
//
// And when a text really is wanted, the Text button hands off to Apple's
// own Messages app with the customer's number. That is the only way an
// iPhone app can put an SMS on the wire, and it leaves from the phone's
// own number so the reply comes back to the phone rather than into a
// system nobody is watching.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  AuthRequiredError,
  getThread,
  markThreadRead,
  replyToThread,
  REPLY_MAX,
} from '../api';
import { colors, radius, space, type } from '../theme';

const dayKey = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toDateString();
};

const dayLabel = (iso, now = Date.now()) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(now - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
};

const clockOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

// Walks the messages oldest-first and inserts a day divider wherever the
// date changes. Pure, and exported, because "the divider appears exactly
// when the day turns over" is the sort of thing that is easy to get
// subtly wrong and impossible to see in a screenshot.
export function withDayDividers(messages) {
  const out = [];
  let last = null;
  for (const m of messages || []) {
    if (!m) continue;
    const key = dayKey(m.ts);
    if (key && key !== last) {
      out.push({ kind: 'day', id: `day-${key}`, ts: m.ts });
      last = key;
    }
    out.push({ kind: 'msg', id: m.id || `${m.ts}-${m.from}`, message: m });
  }
  return out;
}

// What goes under the last outgoing bubble. NEVER "Delivered" and never
// "Sent" — this left by email and the server does not wait to find out
// whether it arrived.
export function deliveryNote(message) {
  if (!message || message.from !== 'admin') return null;
  return message.readByCustomer ? 'Read' : 'Emailed';
}

export default function ThreadScreen({ leadId, onBack, onSignIn }) {
  const [thread, setThread] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const t = await getThread(leadId);
      if (!t) throw new Error('That conversation is no longer there.');
      setThread(t);
      setState('ready');
      // Opening the thread IS reading it, so claim it at the moment it
      // becomes true. Best-effort: a failed mark must not turn a
      // readable conversation into an error screen.
      markThreadRead(leadId).catch(() => {});
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else { setError(err?.message || "Couldn't load this conversation."); setState('error'); }
    }
  }, [leadId]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => withDayDividers(thread?.messages), [thread]);

  // The exit renders in EVERY state, including the ones that render
  // nothing else. This screen sits in an overlay that covers the tab
  // bar, and getJson has no timeout — a loading state without a way out
  // is a force-quit, which is exactly what shipped on three screens last
  // round.
  const exitBar = (
    <View style={styles.bar}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>‹ Messages</Text>
      </Pressable>
      <Text style={styles.barTitle} numberOfLines={1}>{thread?.customerName || ''}</Text>
      <View style={styles.barActions}>
        {thread?.customerPhone ? (
          <>
            <Pressable
              onPress={() => Linking.openURL(`tel:${String(thread.customerPhone).replace(/[^\d+]/g, '')}`).catch(() => {})}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Call ${thread.customerName || 'customer'}`}
            >
              <Text style={styles.action}>Call</Text>
            </Pressable>
            <Pressable
              onPress={textCustomer}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Text ${thread.customerName || 'customer'}`}
            >
              <Text style={styles.action}>Text</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </View>
  );

  // A real SMS, from the phone's own number, via Apple's Messages app.
  // The only route an iPhone app has to the SMS wire — and the right one,
  // because a reply then comes back to the phone rather than into a
  // portal thread nobody is watching from the truck.
  function textCustomer() {
    const to = String(thread?.customerPhone || '').replace(/[^\d+]/g, '');
    if (!to) return;
    // `?body=` is the separator both iOS and Android accept; `&body=` is
    // iOS-only. Opening with no body is fine here — this is a blank text
    // to a customer, not a prepared message.
    Linking.openURL(`sms:${to}`).catch(() => {
      Alert.alert("Couldn't open Messages", 'Try the Call button instead.');
    });
  }

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const entry = await replyToThread(leadId, body);
      setDraft('');
      // Append what the SERVER returned rather than a locally-built
      // bubble: the id, the timestamp and readByCustomer are its to
      // decide, and a guessed bubble that disagrees with the next reload
      // is how a thread starts showing a message twice.
      if (entry) {
        setThread((t) => (t ? { ...t, messages: [...(t.messages || []), entry] } : t));
      } else {
        await load();
      }
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else {
        Alert.alert(
          "Couldn't send that reply",
          err?.message || 'Nothing was sent. Try again, or answer from the desk.',
        );
      }
    } finally {
      setSending(false);
    }
  };

  if (state === 'loading') {
    return (
      <View style={styles.screen}>
        {exitBar}
        <View style={styles.centre}><ActivityIndicator color={colors.brand} /></View>
      </View>
    );
  }
  if (state === 'auth') {
    return (
      <View style={styles.screen}>
        {exitBar}
        <View style={styles.centre}>
          <Text style={styles.centreTitle}>Not signed in</Text>
          <Text style={styles.centreBody}>Sign in to PJL to read and answer this conversation.</Text>
          <Pressable onPress={onSignIn} style={styles.retry}>
            <Text style={styles.retryText}>Sign in</Text>
          </Pressable>
        </View>
      </View>
    );
  }
  if (state === 'error') {
    return (
      <View style={styles.screen}>
        {exitBar}
        <View style={styles.centre}>
          <Text style={styles.centreTitle}>Couldn't load</Text>
          <Text style={styles.centreBody}>{error}</Text>
          <Pressable onPress={load} style={styles.retry}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const over = draft.length > REPLY_MAX;
  const lastOutgoing = [...(thread?.messages || [])].reverse().find((m) => m?.from === 'admin');

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {exitBar}

      <FlatList
        ref={listRef}
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListEmptyComponent={
          <View style={styles.centre}>
            <Text style={styles.centreBody}>No messages in this conversation yet.</Text>
          </View>
        }
        renderItem={({ item }) => {
          if (item.kind === 'day') {
            return <Text style={styles.day}>{dayLabel(item.ts)}</Text>;
          }
          const m = item.message;
          const mine = m.from === 'admin';
          const note = m === lastOutgoing ? deliveryNote(m) : null;
          return (
            <View style={[styles.bubbleRow, mine && styles.bubbleRowMine]}>
              <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
                <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]} selectable>
                  {m.body}
                </Text>
              </View>
              <Text style={[styles.stamp, mine && styles.stampMine]}>
                {clockOf(m.ts)}{note ? ` · ${note}` : ''}
              </Text>
            </View>
          );
        }}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          // Says what it is on the box the words go into. The customer
          // receives this as an EMAIL from the portal, not as a text.
          placeholder="Reply by email…"
          placeholderTextColor={colors.textFaint}
          multiline
          editable={!sending}
          accessibilityLabel="Reply, sent to the customer by email"
        />
        <Pressable
          onPress={send}
          disabled={!draft.trim() || sending || over}
          style={({ pressed }) => [
            styles.send,
            (!draft.trim() || sending || over) && styles.sendOff,
            pressed && styles.sendPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Send reply by email"
        >
          {sending
            ? <ActivityIndicator color={colors.onBrand} size="small" />
            : <Text style={styles.sendText}>↑</Text>}
        </Pressable>
      </View>
      {over ? (
        <Text style={styles.overflow}>
          {draft.length - REPLY_MAX} characters too long — the server keeps the first {REPLY_MAX}.
        </Text>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  centreTitle: { ...type.title },
  centreBody: { ...type.label, textAlign: 'center', lineHeight: 21 },
  retry: {
    marginTop: space.lg, backgroundColor: colors.brand,
    paddingHorizontal: space.xl, paddingVertical: space.md,
    borderRadius: radius.card, minHeight: 48, justifyContent: 'center',
  },
  retryText: { color: colors.onBrand, fontWeight: '600' },

  bar: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, paddingVertical: space.sm,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  back: { paddingVertical: 4 },
  backText: { ...type.body, color: colors.brand, fontWeight: '600' },
  barTitle: { ...type.body, fontWeight: '600', flex: 1, textAlign: 'center' },
  barActions: { flexDirection: 'row', gap: space.md },
  action: { ...type.body, color: colors.brand, fontWeight: '600' },

  list: { padding: space.md, gap: space.xs, flexGrow: 1 },
  day: {
    ...type.caption, color: colors.textFaint, textAlign: 'center',
    marginVertical: space.md, fontWeight: '600',
  },
  bubbleRow: { maxWidth: '82%', alignSelf: 'flex-start', marginBottom: space.xs },
  bubbleRowMine: { alignSelf: 'flex-end' },
  bubble: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.bubble },
  bubbleTheirs: { backgroundColor: colors.card, borderBottomLeftRadius: radius.bubbleTail },
  bubbleMine: { backgroundColor: colors.brand, borderBottomRightRadius: radius.bubbleTail },
  bubbleText: { ...type.body, lineHeight: 21 },
  bubbleTextMine: { color: colors.onBrand },
  stamp: { ...type.caption, color: colors.textFaint, marginTop: 2, marginHorizontal: space.xs },
  stampMine: { textAlign: 'right' },

  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: space.sm,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator,
  },
  input: {
    flex: 1, ...type.body,
    maxHeight: 120, minHeight: 40,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: colors.ground,
    borderRadius: radius.bubble,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator,
  },
  send: {
    width: 40, height: 40, borderRadius: radius.pill,
    backgroundColor: colors.brand,
    alignItems: 'center', justifyContent: 'center',
  },
  sendOff: { opacity: 0.35 },
  sendPressed: { opacity: 0.7 },
  sendText: { color: colors.onBrand, fontSize: 20, fontWeight: '700', lineHeight: 22 },
  overflow: {
    ...type.caption, color: colors.danger,
    paddingHorizontal: space.lg, paddingBottom: space.sm, backgroundColor: colors.card,
  },
});
