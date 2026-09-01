// Properties, grouped by town.
//
// The list is long and flat in the CRM, which is fine at a desk with a
// search box. On a phone the question is nearly always "what have I got
// in Aurora" — so town is the organising principle: chips to narrow to
// one town, and section headers so a scroll still tells you where you
// are.
//
// Town is chosen from a dropdown rather than a strip of chips. The chip
// row was sized for the eighteen towns the service-area pages list;
// the real book has thirty-odd, alphabetical, so reaching Newmarket
// meant swiping past twenty of them. A sheet shows the whole list at
// once, with counts, and the current choice sits in the button.
//
// There is no avatar. The first version put a circle on each row showing
// the first character of the address, which on a street address is the
// house number — a column of meaningless digits. Nothing else about a
// property is recognisable at 40px, so the row is text.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AuthRequiredError, listProperties } from '../api';
import { townOf } from '../format';
import { colors, radius, space, type } from '../theme';

const UNKNOWN_TOWN = 'Other';

export default function PropertiesScreen({ onOpen }) {
  const [all, setAll] = useState([]);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [town, setTown] = useState(null); // null = all towns
  const [pickerOpen, setPickerOpen] = useState(false);
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

  // Decorate once, so the town parse doesn't rerun per keystroke.
  const decorated = useMemo(
    () => all
      .filter((p) => !p.deletedAt && !p.archivedAt)
      .map((p) => ({ ...p, _town: townOf(p) || UNKNOWN_TOWN })),
    [all]
  );

  // Towns alphabetical, but "Other" always last — it's a catch-all, not
  // a place, and sorting it among real towns hides it mid-list.
  const towns = useMemo(() => {
    const counts = new Map();
    for (const p of decorated) counts.set(p._town, (counts.get(p._town) || 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => {
        if (a[0] === UNKNOWN_TOWN) return 1;
        if (b[0] === UNKNOWN_TOWN) return -1;
        return a[0].localeCompare(b[0]);
      })
      .map(([name, count]) => ({ name, count }));
  }, [decorated]);

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = decorated.filter((p) => {
      if (town && p._town !== town) return false;
      if (!q) return true;
      return [p.address, p.customerName, p.customerEmail, p.code, p.billingEntity, p._town]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });

    const byTown = new Map();
    for (const p of matched) {
      if (!byTown.has(p._town)) byTown.set(p._town, []);
      byTown.get(p._town).push(p);
    }
    return [...byTown.entries()]
      .sort((a, b) => {
        if (a[0] === UNKNOWN_TOWN) return 1;
        if (b[0] === UNKNOWN_TOWN) return -1;
        return a[0].localeCompare(b[0]);
      })
      .map(([name, items]) => ({
        title: name,
        data: items.sort((x, y) => String(x.address || '').localeCompare(String(y.address || ''), undefined, { numeric: true })),
      }));
  }, [decorated, query, town]);

  const total = sections.reduce((n, s) => n + s.data.length, 0);

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
      <View style={styles.controls}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search address, customer, town"
          placeholderTextColor={colors.textFaint}
          style={styles.search}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
        <Pressable
          onPress={() => setPickerOpen(true)}
          style={({ pressed }) => [styles.picker, pressed && styles.pickerPressed]}
          accessibilityRole="button"
          accessibilityLabel={`Filter by town. Currently ${town || 'all towns'}.`}
        >
          <Text style={[styles.pickerLabel, town && styles.pickerLabelActive]} numberOfLines={1}>
            {town || 'All towns'}
          </Text>
          <Text style={styles.pickerCount}>{total}</Text>
          <Text style={styles.pickerChevron}>⌄</Text>
        </Pressable>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        stickySectionHeadersEnabled
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.brand} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {query || town ? 'Nothing matches that.' : 'No properties yet.'}
          </Text>
        }
        ListFooterComponent={
          total ? <Text style={styles.count}>{total} {total === 1 ? 'property' : 'properties'}</Text> : null
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <Text style={styles.sectionCount}>{section.data.length}</Text>
          </View>
        )}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onOpen(item.id)}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
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

      <Modal
        visible={pickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setPickerOpen(false)} />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.sheetTitle}>Filter by town</Text>
          <FlatList
            data={[{ key: '__all', name: null, label: 'All towns', count: decorated.length }]
              .concat(towns.map((t) => ({ key: t.name, name: t.name, label: t.name, count: t.count })))}
            keyExtractor={(item) => item.key}
            style={styles.sheetList}
            renderItem={({ item }) => {
              const selected = town === item.name;
              return (
                <Pressable
                  onPress={() => { setTown(item.name); setPickerOpen(false); }}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.rowPressed]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <Text style={[styles.sheetRowText, selected && styles.sheetRowSelected]} numberOfLines={1}>
                    {item.label}
                  </Text>
                  <Text style={styles.sheetRowCount}>{item.count}</Text>
                  <Text style={[styles.check, !selected && styles.checkHidden]}>✓</Text>
                </Pressable>
              );
            }}
          />
        </View>
      </Modal>
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

  controls: { backgroundColor: colors.ground, paddingTop: space.md, gap: space.sm },
  search: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    marginHorizontal: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 11,
    fontSize: 16,
    color: colors.text,
  },
  picker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    marginHorizontal: space.md,
    marginBottom: space.md,
    paddingHorizontal: space.md,
    paddingVertical: 11,
  },
  pickerPressed: { opacity: 0.7 },
  pickerLabel: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.textMuted },
  pickerLabelActive: { color: colors.brand },
  pickerCount: { ...type.caption, fontVariant: ['tabular-nums'] },
  pickerChevron: { color: colors.textFaint, fontSize: 15, marginTop: -3 },

  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,24,28,0.35)' },
  sheet: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    maxHeight: '72%',
    backgroundColor: colors.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: space.xl,
  },
  grabber: {
    width: 38, height: 4, borderRadius: 2,
    backgroundColor: colors.separator,
    alignSelf: 'center', marginTop: space.sm, marginBottom: space.md,
  },
  sheetTitle: { ...type.section, marginHorizontal: space.lg, marginBottom: space.sm },
  sheetList: { flexGrow: 0 },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  sheetRowText: { flex: 1, ...type.body },
  sheetRowSelected: { color: colors.brand, fontWeight: '600' },
  sheetRowCount: { ...type.caption, fontVariant: ['tabular-nums'] },
  check: { color: colors.brand, fontSize: 16, width: 16, textAlign: 'center' },
  checkHidden: { opacity: 0 },

  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.ground,
    paddingHorizontal: space.lg,
    paddingVertical: 6,
  },
  sectionTitle: { ...type.section },
  sectionCount: { ...type.caption, fontVariant: ['tabular-nums'] },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  rowPressed: { backgroundColor: colors.ground },
  rowText: { flex: 1 },
  rowTitle: { ...type.body, fontWeight: '600' },
  rowSub: { ...type.caption, marginTop: 2 },
  chevron: { color: colors.textFaint, fontSize: 22 },
  empty: { ...type.caption, textAlign: 'center', marginTop: space.xl },
  count: { ...type.caption, textAlign: 'center', paddingVertical: space.lg },
});
