// The message list.
//
// WHAT THESE MESSAGES ARE, AND WHAT THEY ARE NOT. This is the customer
// portal's thread — the conversation PJL owns a record of, the same one
// the CRM's Messages page shows. It is NOT the phone's Messages app.
// iOS gives an app no read access to SMS or iMessage content at any
// entitlement level, so "show me this customer's texts in here" cannot
// be built by anyone. Every thread below is one PJL can actually answer.
//
// It is SHAPED like Messages, because that shape is the right one for a
// list of conversations and everyone already knows how to read it:
// initials in a circle, name, a one-line preview of the last thing said,
// the time on the right, and unread weight carried by the row rather
// than by a badge nobody looks at.
//
// Where it deliberately stops imitating Messages is the word "sent" —
// see ThreadScreen. A reply here leaves by EMAIL.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AuthRequiredError, listThreads } from '../api';
import { initials, messageStamp } from '../format';
import { colors, radius, space, type } from '../theme';

// The preview line. Newlines become spaces because a two-line preview
// in a one-line row silently loses its second half, and a reply of
// PJL's own is prefixed so a list of threads does not read as though the
// customer said everything in it.
export function previewOf(thread) {
  const last = thread?.lastMessage;
  if (!last || !last.body) return 'No messages yet';
  const body = String(last.body).replace(/\s+/g, ' ').trim();
  return last.from === 'admin' ? `You: ${body}` : body;
}

export default function MessagesScreen({ onOpenThread, onSignIn }) {
  const [threads, setThreads] = useState([]);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { threads: rows } = await listThreads();
      setThreads(rows);
      setState('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else { setError(err?.message || "Couldn't load messages."); setState('error'); }
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (state === 'loading') {
    return <View style={styles.centre}><ActivityIndicator color={colors.brand} /></View>;
  }
  if (state === 'auth') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Not signed in</Text>
        <Text style={styles.centreBody}>
          Sign in to PJL to read and answer customer messages.
        </Text>
        <Pressable onPress={onSignIn} style={styles.retry}>
          <Text style={styles.retryText}>Sign in</Text>
        </Pressable>
      </View>
    );
  }
  if (state === 'error') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Couldn't load</Text>
        <Text style={styles.centreBody}>{error}</Text>
        <Pressable onPress={load} style={styles.retry}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Messages</Text>
        <Text style={styles.sub}>Customer portal</Text>
      </View>

      <FlatList
        data={threads}
        keyExtractor={(t) => String(t.leadId)}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.brand} />
        }
        ListEmptyComponent={
          <View style={styles.centre}>
            <Text style={styles.centreTitle}>No messages</Text>
            <Text style={styles.centreBody}>
              When a customer writes from their portal, the thread appears here.
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const unread = Number(item.unreadCount) > 0;
          return (
            <Pressable
              onPress={() => onOpenThread?.(item.leadId)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              accessibilityRole="button"
              accessibilityLabel={
                `${item.customerName || 'No name'}. ${unread ? `${item.unreadCount} unread. ` : ''}${previewOf(item)}`
              }
            >
              {/* The unread mark is a dot in the gutter, where Messages
                  puts it — not a number. "How many" is not the question
                  anyone asks of a thread; "is there anything new" is. */}
              <View style={styles.dotSlot}>{unread ? <View style={styles.dot} /> : null}</View>

              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials(item.customerName)}</Text>
              </View>

              <View style={styles.body}>
                <View style={styles.line}>
                  <Text style={[styles.name, unread && styles.nameUnread]} numberOfLines={1}>
                    {item.customerName || 'No name'}
                  </Text>
                  <Text style={styles.time}>{messageStamp(item.lastMessage?.ts)}</Text>
                </View>
                <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={2}>
                  {previewOf(item)}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.card },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  centreTitle: { ...type.title, marginBottom: space.xs },
  centreBody: { ...type.label, textAlign: 'center', lineHeight: 21 },
  retry: {
    marginTop: space.lg,
    backgroundColor: colors.brand,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.card,
    minHeight: 48,
    justifyContent: 'center',
  },
  retryText: { color: colors.onBrand, fontWeight: '600' },

  header: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  title: { ...type.hero },
  sub: { ...type.caption, color: colors.textMuted },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingRight: space.lg,
    paddingVertical: space.md,
    minHeight: 72,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  rowPressed: { backgroundColor: colors.ground },
  dotSlot: { width: space.lg + space.xs, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 9, height: 9, borderRadius: radius.pill, backgroundColor: colors.brand },
  avatar: {
    width: 44, height: 44, borderRadius: radius.pill,
    backgroundColor: colors.brandTint,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { ...type.label, color: colors.brand, fontWeight: '700' },
  body: { flex: 1, gap: 2 },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  name: { ...type.body, flex: 1 },
  nameUnread: { fontWeight: '700' },
  time: { ...type.caption, color: colors.textFaint },
  preview: { ...type.caption, color: colors.textMuted, lineHeight: 19 },
  previewUnread: { color: colors.text },
});
