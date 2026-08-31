// Searchable list of properties, in the shape of a phone address book:
// one tappable line per site, filtered as you type. The admin table has
// columns worth having on a desk; on a phone the address is the only
// thing worth reading at a glance, so it gets the line.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AuthRequiredError, listProperties } from '../api';
import { colors, radius, space, type } from '../theme';

export default function PropertiesScreen({ onOpen }) {
  const [all, setAll] = useState([]);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setAll(await listProperties());
      setState('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else { setError(err?.message || 'Could not load properties.'); setState('error'); }
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = all.filter((p) => !p.deletedAt && !p.archivedAt);
    if (!q) return visible;
    return visible.filter((p) =>
      [p.address, p.customerName, p.customerEmail, p.code, p.billingEntity]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [all, query]);

  if (state === 'loading') {
    return <View style={styles.centre}><ActivityIndicator color={colors.brand} /></View>;
  }
  if (state === 'auth') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Not signed in</Text>
        <Text style={styles.centreBody}>Open the Today tab and sign in — this list shares that session.</Text>
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

  return (
    <View style={styles.screen}>
      <View style={styles.searchWrap}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search address, customer, code"
          placeholderTextColor={colors.textFaint}
          style={styles.search}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.brand} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {query ? `Nothing matching "${query.trim()}".` : 'No properties yet.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onOpen(item.id)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{(item.address || '?').trim().charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>{item.address || 'Address not set'}</Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {[item.customerName, item.code].filter(Boolean).join(' · ') || '—'}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.card },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, backgroundColor: colors.ground },
  centreTitle: { ...type.title, marginBottom: space.sm },
  centreBody: { ...type.label, textAlign: 'center', lineHeight: 21 },
  retry: {
    marginTop: space.lg, backgroundColor: colors.brand,
    paddingHorizontal: space.xl, paddingVertical: space.md, borderRadius: radius.card,
  },
  retryText: { color: '#fff', fontWeight: '600' },
  searchWrap: { padding: space.md, backgroundColor: colors.ground },
  search: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: 11,
    fontSize: 16,
    color: colors.text,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  rowPressed: { backgroundColor: colors.ground },
  avatar: {
    width: 40, height: 40, borderRadius: radius.pill,
    backgroundColor: colors.brandTint, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: colors.brand, fontWeight: '700', fontSize: 17 },
  rowText: { flex: 1 },
  rowTitle: { ...type.body, fontWeight: '600' },
  rowSub: { ...type.caption, marginTop: 2 },
  chevron: { color: colors.textFaint, fontSize: 22 },
  empty: { ...type.caption, textAlign: 'center', marginTop: space.xl },
});
