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
import { Platform, Pressable, SafeAreaView, StatusBar as RNStatusBar, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import PropertiesScreen from './src/screens/PropertiesScreen';
import TodayScreen from './src/screens/TodayScreen';
import BookScreen from './src/screens/BookScreen';
import ClosingScreen from './src/screens/ClosingScreen';
import InvoiceScreen from './src/screens/InvoiceScreen';
import MessagesScreen from './src/screens/MessagesScreen';
import PropertyProfileScreen from './src/screens/PropertyProfileScreen';
import SignInScreen from './src/screens/SignInScreen';
import TapToPaySettings from './src/screens/TapToPaySettings';
import ThreadScreen from './src/screens/ThreadScreen';
import WebScreen from './src/screens/WebScreen';
import { getSession } from './src/api';
import { TapToPayProvider } from './src/taptopay/TapToPayProvider';
import { colors, space } from './src/theme';
import { applyPendingUpdate } from './src/updates';

// `admin: true` means the tab does not exist for a tech. Not disabled —
// ABSENT. A locked tab teaches someone to press a thing that never works,
// and the app's own answer to "may I" is only a hint anyway: the server
// is what actually refuses, and it does.
const TABS = [
  { key: 'today',      label: 'Today',      glyph: '◷' },
  { key: 'properties', label: 'Properties', glyph: '⌂' },
  { key: 'book',       label: 'Book',       glyph: '＋', admin: true },
  { key: 'messages',   label: 'Messages',   glyph: '✉' },
];

// The tabs a given role may see. Exported so the rule can be tested
// without React Native — a Book tab appearing for a tech is exactly the
// sort of thing nobody notices until a tech books a job.
export function tabsForRole(role) {
  return TABS.filter((tab) => !tab.admin || role === 'admin');
}

// What an open job can be. A closed set rather than three independent
// booleans, because two of them being true at once was always a bug and
// this makes that unrepresentable.
//
//   { kind: 'closing', workOrderId }  — the native fall-closing flow
//   { kind: 'web',     url, title }   — any other work order, on the web
//   { kind: 'invoice', invoiceId }    — where a finished closing lands
export const JOB = { CLOSING: 'closing', WEB: 'web', INVOICE: 'invoice', THREAD: 'thread' };

// A work order becomes one of two things. Kept out of the component so
// the routing decision can be tested without React Native — the same
// reason src/workorder-routing.js exists.
// A finished visit is a RECORD, not a form. Routing on `type` alone sent a
// completed fall closing back into the editable closing flow, where every
// stage is interactive and every tap calls patchWorkOrder — which the
// server refuses on a locked work order, so each one produced "Didn't save"
// and a red "Not saved" header on a visit that was finished and invoiced.
// Terminal states go to the web record, which is where the sign-off and the
// invoice actually live.
const TERMINAL_WO = new Set(['completed', 'cancelled', 'no_show']);

export function jobForWorkOrder(workOrder) {
  if (!workOrder || !workOrder.id) return null;
  if (workOrder.type === 'fall_closing' && !TERMINAL_WO.has(workOrder.status)) {
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
  // Bumped every time a job closes. Today reloads on it, because the whole
  // point of the three-state button and the map tick is that they are TRUE
  // — and both read a payload that was fetched before the job opened. You
  // finish a closing, dismiss it, and without this the card still says
  // "Resume" and the pin is still a number.
  const [jobsClosed, setJobsClosed] = useState(0);
  // Tap to Pay's own screen, opened from Today's header. Apple 3.6 wants
  // it reachable outside checkout; an overlay over the current tab keeps
  // the tab bar honest about where you are. It survived the restructure
  // unchanged — the Work and Invoices tabs went, this did not.
  const [tapSettingsOpen, setTapSettingsOpen] = useState(false);

  // Signing in, over everything, from anywhere.
  //
  // Auth rides the WebView's cookie jar (src/api.js), so before Messages
  // went native every "not signed in" state could point at a tab that
  // happened to be a web page. Now none of them is. Without this overlay
  // the app would tell you to sign in somewhere and have nowhere to
  // send you — which is not a worse message, it is an app you cannot
  // use. `signedIn` is bumped on success so every mounted screen
  // reloads: they each hold their own `auth` state and none of them is
  // watching the cookie jar.
  const [signInOpen, setSignInOpen] = useState(false);
  const [signedIn, setSignedIn] = useState(0);
  // Null until /api/session answers. Book is admin-only, and a tab that
  // flickers into existence a second after launch is worse than one that
  // arrives with the rest of the app — so the bar renders without it
  // until the answer is in, and never guesses.
  const [role, setRole] = useState(null);

  // Cold start: pull a newer bundle if there is one, then reload into
  // it. Without this the app runs the previous bundle for one more
  // launch, which reads as "my update didn't work".
  useEffect(() => { applyPendingUpdate(); }, []);

  // Re-asked on every sign-in, because the person signing in is not
  // necessarily the person who signed out.
  useEffect(() => {
    let alive = true;
    getSession()
      .then((s) => { if (alive) setRole(s.authenticated ? s.role : null); })
      .catch(() => { if (alive) setRole(null); });
    return () => { alive = false; };
  }, [signedIn]);

  const select = useCallback((key) => {
    setActive(key);
    setVisited((v) => (v[key] ? v : { ...v, [key]: true }));
  }, []);

  const openWorkOrder = useCallback((workOrder) => {
    const next = jobForWorkOrder(workOrder);
    if (next) setJob(next);
  }, []);

  const closeJob = useCallback(() => {
    setJob(null);
    setJobsClosed((n) => n + 1);
  }, []);

  const openSignIn = useCallback(() => setSignInOpen(true), []);
  const finishSignIn = useCallback(() => {
    setSignInOpen(false);
    setSignedIn((n) => n + 1);
  }, []);

  const visibleTabs = tabsForRole(role);

  // A tab that disappears under you — sign out of admin while Book is
  // open — must not leave the shell showing a pane with no tab.
  useEffect(() => {
    if (!visibleTabs.some((t) => t.key === active)) setActive('today');
  }, [visibleTabs, active]);

  return (
    <TapToPayProvider>
    <View style={styles.root}>
      <StatusBar style="dark" />
      <SafeAreaView style={styles.safe}>
        <View style={styles.body}>
          {visibleTabs.map((tab) => {
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
                    key={`today-${signedIn}`}
                    onOpenWorkOrder={openWorkOrder}
                    refreshToken={jobsClosed}
                    onSignIn={openSignIn}
                    onOpenTapToPay={() => setTapSettingsOpen(true)}
                  />
                ) : tab.key === 'properties' ? (
                  openPropertyId ? (
                    <PropertyProfileScreen
                      key={`property-${openPropertyId}-${signedIn}`}
                      propertyId={openPropertyId}
                      onBack={() => setOpenPropertyId(null)}
                      onOpenWorkOrder={openWorkOrder}
                      onOpenInvoice={(invoiceId) => setJob({ kind: JOB.INVOICE, invoiceId })}
                      onSignIn={openSignIn}
                    />
                  ) : (
                    <PropertiesScreen
                      key={`properties-${signedIn}`}
                      onOpen={setOpenPropertyId}
                      onSignIn={openSignIn}
                    />
                  )
                ) : tab.key === 'book' ? (
                  <BookScreen key={`book-${signedIn}`} onSignIn={openSignIn} />
                ) : tab.key === 'messages' ? (
                  <MessagesScreen
                    key={`messages-${signedIn}`}
                    refreshToken={jobsClosed}
                    onOpenThread={(leadId) => setJob({ kind: JOB.THREAD, leadId })}
                    onSignIn={openSignIn}
                  />
                ) : null}
              </View>
            );
          })}
        </View>

        <View style={styles.tabBar}>
          {visibleTabs.map((tab) => {
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
        // accessibilityViewIsModal is the non-visual half of "the overlay
        // covers the tab bar": without it VoiceOver swipes straight past
        // the job into the tab bar underneath and switches tabs invisibly,
        // which is the exact confusion the overlay exists to prevent.
        <View style={styles.overlay} accessibilityViewIsModal>
          <SafeAreaView style={styles.overlaySafe}>
            {job.kind === JOB.CLOSING ? (
              <ClosingScreen
                key={`closing-${job.workOrderId}-${signedIn}`}
                workOrderId={job.workOrderId}
                onExit={closeJob}
                onSignIn={openSignIn}
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
              <InvoiceScreen
                key={`invoice-${job.invoiceId}-${signedIn}`}
                invoiceId={job.invoiceId}
                onBack={closeJob}
                onSignIn={openSignIn}
              />
            ) : job.kind === JOB.THREAD ? (
              <ThreadScreen
                key={`thread-${job.leadId}-${signedIn}`}
                leadId={job.leadId}
                onBack={closeJob}
                onSignIn={openSignIn}
              />
            ) : (
              <WebScreen path={job.url} onBack={closeJob} title={job.title} />
            )}
          </SafeAreaView>
        </View>
      ) : null}

      {/* Tap to Pay's settings screen. A sibling of the job overlay, not
          an arm of it: Apple 3.6 wants it reachable outside a checkout,
          and it is opened from Today's header rather than from a job. */}
      {tapSettingsOpen ? (
        <View style={styles.overlay} accessibilityViewIsModal>
          <SafeAreaView style={styles.overlaySafe}>
            <TapToPaySettings onBack={() => setTapSettingsOpen(false)} />
          </SafeAreaView>
        </View>
      ) : null}

      {/* LAST, so it sits above everything including Tap to Pay: a
          session can expire while a closing is open or while the reader
          screen is up, and the sign-in has to reach over whatever is
          already there. Modal to VoiceOver for the same reason the job
          overlay is. */}
      {signInOpen ? (
        <View style={styles.overlay} accessibilityViewIsModal>
          <SafeAreaView style={styles.overlaySafe}>
            <SignInScreen onSignedIn={finishSignIn} onCancel={() => setSignInOpen(false)} />
          </SafeAreaView>
        </View>
      ) : null}
    </View>
    </TapToPayProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.card },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.ground },
  safe: { flex: 1, backgroundColor: colors.card, paddingTop: RNStatusBar.currentHeight || 0 },
  // The shell's `safe` is card-white because the TAB BAR sits at its
  // bottom. The overlay has no tab bar, and every screen inside it draws
  // on `ground` — so reusing `safe` painted a white band across the bottom
  // inset with a hard seam above it, on the closing and the invoice, the
  // two screens a tech is in longest.
  overlaySafe: { flex: 1, backgroundColor: colors.ground, paddingTop: RNStatusBar.currentHeight || 0 },
  body: { flex: 1 },
  pane: { ...StyleSheet.absoluteFillObject },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.ground },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    backgroundColor: colors.card,
    paddingTop: 6,
    // React Native's own SafeAreaView is iOS-only — on Android it is a
    // plain View — and app.json sets edgeToEdgeEnabled, so the labels
    // would sit 2pt off the bottom edge under the gesture pill. The top
    // is already handled by RNStatusBar.currentHeight above; this is the
    // other end. No new dependency: react-native-safe-area-context would
    // move the Expo fingerprint and force a native rebuild.
    paddingBottom: Platform.OS === 'android' ? space.md : 2,
  },
  tab: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: space.xs },
  tabGlyph: { fontSize: 19, color: colors.textFaint },
  tabLabel: { fontSize: 10, fontWeight: '600', color: colors.textFaint },
  tabActive: { color: colors.brand },
});
