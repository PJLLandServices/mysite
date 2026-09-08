// The app shell: a three-tab bar over the three places the field needs,
// with the job you are doing laid OVER them rather than filed under a
// tab of its own.
//
// WHY THERE IS NO WORK TAB. There was, and it showed whichever work
// order you last opened — a tab whose contents depended on where you had
// been, and which said "Work" while showing one job from three weeks
// ago. A work order is not a place. It is something that happens to a
// job on the schedule or to an address in the book, and it is reached
// from one or the other. Its history lives on the property, where
// "did we do this address in April" is actually asked.
//
// WHY THERE IS NO INVOICES TAB. Same reasoning, and it was worse: the
// tab rendered /admin/invoices, a desktop page, at phone width with its
// sidebar hidden by injected CSS. Invoices belong to an address too.
//
// So an open job is an OVERLAY. It covers the tab bar deliberately —
// mid-closing, switching tabs is not a thing anyone means to do, and the
// old arrangement let you do it and then wonder where the closing went.
// Every overlay carries its own way out.
//
// Properties is native (see src/screens/PropertyProfileScreen.js): a
// record you only read is cheap to rebuild and benefits most from being
// shaped for a phone. Messages stays as the web page that already does
// the work correctly and carries FLOW_REGISTER coverage.
//
// Tabs keep their state once visited: each is mounted on first open and
// then hidden rather than unmounted, so switching away from a half-
// scrolled list and back doesn't reload it.

import { useCallback, useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StatusBar as RNStatusBar, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import PropertiesScreen from './src/screens/PropertiesScreen';
import TodayScreen from './src/screens/TodayScreen';
import ClosingScreen from './src/screens/ClosingScreen';
import InvoiceScreen from './src/screens/InvoiceScreen';
import PropertyProfileScreen from './src/screens/PropertyProfileScreen';
import WebScreen from './src/screens/WebScreen';
import { colors, space } from './src/theme';
import { applyPendingUpdate } from './src/updates';

const TABS = [
  { key: 'today',      label: 'Today',      glyph: '◷' },
  { key: 'properties', label: 'Properties', glyph: '⌂' },
  { key: 'messages',   label: 'Messages',   glyph: '✉', path: '/admin/messages' },
];

// What an open job can be. A closed set rather than three independent
// booleans, because two of them being true at once was always a bug and
// this makes that unrepresentable.
//
//   { kind: 'closing', workOrderId }  — the native fall-closing flow
//   { kind: 'web',     url, title }   — any other work order, on the web
//   { kind: 'invoice', invoiceId }    — where a finished closing lands
export const JOB = { CLOSING: 'closing', WEB: 'web', INVOICE: 'invoice' };

// A work order becomes one of two things. Kept out of the component so
// the routing decision can be tested without React Native — the same
// reason src/workorder-routing.js exists.
export function jobForWorkOrder(workOrder) {
  if (!workOrder || !workOrder.id) return null;
  if (workOrder.type === 'fall_closing') {
    return { kind: JOB.CLOSING, workOrderId: workOrder.id };
  }
  return {
    kind: JOB.WEB,
    url: `/admin/work-order/${encodeURIComponent(workOrder.id)}/tech`,
    title: 'Work order',
  };
}

export default function App() {
  const [active, setActive] = useState('today');
  // Mount lazily, then keep. An unvisited tab costs nothing; a visited
  // one keeps its scroll position and its session.
  const [visited, setVisited] = useState({ today: true });
  const [openPropertyId, setOpenPropertyId] = useState(null);
  // The job laid over the tabs. Null means there isn't one.
  const [job, setJob] = useState(null);

  // Cold start: pull a newer bundle if there is one, then reload into
  // it. Without this the app runs the previous bundle for one more
  // launch, which reads as "my update didn't work".
  useEffect(() => { applyPendingUpdate(); }, []);

  const select = useCallback((key) => {
    setActive(key);
    setVisited((v) => (v[key] ? v : { ...v, [key]: true }));
  }, []);

  const openWorkOrder = useCallback((workOrder) => {
    const next = jobForWorkOrder(workOrder);
    if (next) setJob(next);
  }, []);

  const closeJob = useCallback(() => setJob(null), []);

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
                  <TodayScreen onOpenWorkOrder={openWorkOrder} />
                ) : tab.key === 'properties' ? (
                  openPropertyId ? (
                    <PropertyProfileScreen
                      propertyId={openPropertyId}
                      onBack={() => setOpenPropertyId(null)}
                      onOpenWorkOrder={openWorkOrder}
                      onOpenInvoice={(invoiceId) => setJob({ kind: JOB.INVOICE, invoiceId })}
                    />
                  ) : (
                    <PropertiesScreen onOpen={setOpenPropertyId} />
                  )
                ) : (
                  <WebScreen path={tab.path} />
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

      {/* The open job, over everything including the tab bar. Each of
          these owns its own exit; none of them is a trap door. */}
      {job ? (
        <View style={styles.overlay}>
          <SafeAreaView style={styles.safe}>
            {job.kind === JOB.CLOSING ? (
              <ClosingScreen
                workOrderId={job.workOrderId}
                onExit={closeJob}
                // A finished closing goes straight to its invoice. When
                // the cascade did not hand one back — it is best-effort
                // and the visit is completed either way — fall back to
                // the work order rather than stranding the tech on a
                // screen that has just told them it is done.
                onFinished={({ invoiceId }) => {
                  if (invoiceId) setJob({ kind: JOB.INVOICE, invoiceId });
                  else setJob({
                    kind: JOB.WEB,
                    url: `/admin/work-order/${encodeURIComponent(job.workOrderId)}/tech`,
                    title: 'Work order',
                  });
                }}
              />
            ) : job.kind === JOB.INVOICE ? (
              <InvoiceScreen invoiceId={job.invoiceId} onBack={closeJob} />
            ) : (
              <WebScreen path={job.url} onBack={closeJob} title={job.title} />
            )}
          </SafeAreaView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.card },
  safe: { flex: 1, backgroundColor: colors.card, paddingTop: RNStatusBar.currentHeight || 0 },
  body: { flex: 1 },
  pane: { ...StyleSheet.absoluteFillObject },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.ground },
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
