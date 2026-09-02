// The app shell: a five-tab bar over the five things the field actually
// needs. The CRM's other fifteen admin pages are not reachable from
// here, which is the point — this is not the CRM on a small screen, it
// is the subset of it that gets used standing on someone's lawn.
//
// Properties is native (see src/screens/PropertyProfileScreen.js): a
// record you only read is cheap to rebuild and benefits most from being
// shaped for a phone. The rest stay as the web pages that already do the
// work correctly and carry FLOW_REGISTER coverage.
//
// Tabs keep their state once visited: each is mounted on first open and
// then hidden rather than unmounted, so switching away from a half-
// scrolled work order and back doesn't reload it.

import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StatusBar as RNStatusBar, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import PropertiesScreen from './src/screens/PropertiesScreen';
import TodayScreen from './src/screens/TodayScreen';
import ClosingScreen from './src/screens/ClosingScreen';
import PropertyProfileScreen from './src/screens/PropertyProfileScreen';
import WebScreen from './src/screens/WebScreen';
import { colors, space } from './src/theme';
import { applyPendingUpdate } from './src/updates';

// Where the Work tab sits when nothing has sent it somewhere specific.
const WORK_LIST = '/admin/work-orders';

const TABS = [
  { key: 'today',      label: 'Today',      glyph: '◷' },
  { key: 'properties', label: 'Properties', glyph: '⌂' },
  { key: 'work',       label: 'Work',       glyph: '✓', path: WORK_LIST },
  { key: 'invoices',   label: 'Invoices',   glyph: '$', path: '/admin/invoices' },
  { key: 'messages',   label: 'Messages',   glyph: '✉', path: '/admin/messages' },
];

export default function App() {
  const [active, setActive] = useState('today');
  // Mount lazily, then keep. An unvisited tab costs nothing; a visited
  // one keeps its scroll position and its session.
  const [visited, setVisited] = useState({ today: true });
  const [openPropertyId, setOpenPropertyId] = useState(null);
  // Today hands a work order to the Work tab rather than opening its own
  // WebView, so there is only ever one tech-mode page alive and the tab
  // bar keeps telling the truth about where you are.
  const [workUrl, setWorkUrl] = useState(WORK_LIST);
  // A fall closing opens the native flow; everything else opens the web
  // work order, which still owns sign-off, payment and the completion
  // cascade. Set together with the tab switch so the Work tab always
  // shows one thing or the other, never both.
  const [closingId, setClosingId] = useState(null);

  // Cold start: pull a newer bundle if there is one, then reload into
  // it. Without this the app runs the previous bundle for one more
  // launch, which reads as "my update didn't work".
  useEffect(() => { applyPendingUpdate(); }, []);

  const select = useCallback((key) => {
    setActive(key);
    setVisited((v) => (v[key] ? v : { ...v, [key]: true }));
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safe}>
        <View style={styles.body}>
          {TABS.map((tab) => {
            if (!visited[tab.key]) return null;
            const isActive = active === tab.key;
            return (
              <View
                key={tab.key}
                style={[styles.pane, { display: isActive ? 'flex' : 'none' }]}
                // Keeps VoiceOver and taps out of hidden panes.
                pointerEvents={isActive ? 'auto' : 'none'}
                accessibilityElementsHidden={!isActive}
              >
                {tab.key === 'today' ? (
                  <TodayScreen
                    onOpenWorkOrder={(workOrder) => {
                      if (workOrder.type === 'fall_closing') {
                        setClosingId(workOrder.id);
                      } else {
                        setClosingId(null);
                        setWorkUrl(`/admin/work-order/${encodeURIComponent(workOrder.id)}/tech`);
                      }
                      select('work');
                    }}
                  />
                ) : tab.key === 'properties' ? (
                  openPropertyId ? (
                    <PropertyProfileScreen
                      propertyId={openPropertyId}
                      onBack={() => setOpenPropertyId(null)}
                    />
                  ) : (
                    <PropertiesScreen onOpen={setOpenPropertyId} />
                  )
                ) : tab.key === 'work' && closingId ? (
                  <ClosingScreen
                    workOrderId={closingId}
                    onExit={() => { setClosingId(null); select('today'); }}
                    onOpenFullWorkOrder={(url) => { setClosingId(null); setWorkUrl(url); }}
                  />
                ) : (
                  <WebScreen
                    path={tab.key === 'work' ? workUrl : tab.path}
                    // Only a pushed page gets a back bar — the tab's own
                    // landing page has nowhere to go back TO. Without this
                    // the closing's handoff to the web work order was a
                    // one-way door: the tab bar switches tabs but does not
                    // undo the handoff, and the page's own nav is hidden.
                    onBack={tab.key === 'work' && workUrl !== WORK_LIST
                      ? () => setWorkUrl(WORK_LIST)
                      : undefined}
                    title={tab.key === 'work' && workUrl !== WORK_LIST ? 'Work orders' : undefined}
                  />
                )}
              </View>
            );
          })}
        </View>

        <View style={styles.tabBar}>
          {TABS.map((tab) => {
            const isActive = active === tab.key;
            return (
              <Pressable
                key={tab.key}
                onPress={() => select(tab.key)}
                style={styles.tab}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={tab.label}
              >
                <Text style={[styles.tabGlyph, isActive && styles.tabActive]}>{tab.glyph}</Text>
                <Text style={[styles.tabLabel, isActive && styles.tabActive]}>{tab.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.card },
  safe: { flex: 1, backgroundColor: colors.card, paddingTop: RNStatusBar.currentHeight || 0 },
  body: { flex: 1 },
  pane: { ...StyleSheet.absoluteFillObject },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    backgroundColor: colors.card,
    paddingTop: 6,
    paddingBottom: 2,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: space.xs },
  tabGlyph: { fontSize: 19, color: colors.textFaint },
  tabLabel: { fontSize: 10, fontWeight: '600', color: colors.textFaint },
  tabActive: { color: colors.brand },
});
