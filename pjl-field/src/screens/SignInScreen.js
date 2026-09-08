// Signing in.
//
// WHY THIS SCREEN HAD TO EXIST. Authentication rides the WebView's
// cookie jar (see src/api.js): a WebView mounted with
// `sharedCookiesEnabled` puts pjl_crm_session in the system cookie
// store, and React Native's fetch reads that same store. So a login on
// ANY web surface authenticates every native screen too.
//
// That worked by accident while a tab happened to be a web page. Every
// "not signed in" state in this app told you to go and open one. Making
// Messages native removed the last of them — and would have left an app
// that says "sign in on another tab" while having no tab that can. The
// sign-in surface is now a thing in its own right rather than a side
// effect of where a tab pointed.
//
// It is deliberately just the CRM's own /login page. One password form,
// one set of rules about what a valid session is, one place a lockout or
// a reset is handled. A native form here would be a second implementation
// of the most security-sensitive screen in the business, and it would
// still have to hand the cookie back to this WebView in the end.

import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { HOST } from '../api';
import { colors, radius, space, type } from '../theme';


// Where the login form sends you once it succeeds. login.js reads ?next
// and defaults to /admin, so this is also the signal: a navigation to
// anything that is NOT the login page means the session exists.
const NEXT = '/admin';
const LOGIN_PATH = `/login?next=${encodeURIComponent(NEXT)}`;

// The path part of a URL on OUR host, or null for anything else.
//
// `startsWith(HOST)` alone is not a host check: it also matches
// `https://www.pjllandservices.com.attacker.tld/admin`, because the
// prefix is there. The character after the host has to be a boundary.
export function pathOnHost(url) {
  const target = String(url || '');
  if (!target.startsWith(HOST)) return null;
  const rest = target.slice(HOST.length);
  if (rest && !'/?#'.includes(rest[0])) return null;
  return (rest.split('#')[0].split('?')[0]) || '/';
}

export function isLoginUrl(url) {
  const path = pathOnHost(url);
  return path === '/login' || path === '/login/';
}

// Signed in means REACHED THE PLACE LOGIN SENDS YOU. Not "anywhere that
// is not the login page" — the login page itself carries two ordinary
// links, the PJL logo to `/` and an orange "your portal sign-in" link to
// `/portal/login` sitting directly above the email field, right under
// the thumb. Under the looser rule, tapping either one navigated
// on-host, away from /login, and the app played its entire sign-in
// success animation for someone who never typed a password — then
// showed "Not signed in" on all three tabs.
export function isSignedInUrl(url) {
  const path = pathOnHost(url);
  if (!path) return false;
  return path === NEXT || path.startsWith(`${NEXT}/`);
}

// Where the WebView is allowed to go. Anything else is refused, so a
// stray tap cannot wander off the login form and cannot be mistaken for
// success. The login form POSTs to /api/login by XHR, which is not a
// navigation and is unaffected.
export function isAllowedNavigation(url) {
  const target = String(url || '');
  if (target.startsWith('about:')) return true;
  const path = pathOnHost(target);
  if (!path) return false;
  return isLoginUrl(target) || isSignedInUrl(target) || path === '/reset-password';
}

export default function SignInScreen({ onSignedIn, onCancel }) {
  const [loading, setLoading] = useState(true);
  // Offline or a 5xx used to leave a blank white sheet with Cancel as the
  // only affordance. `reloads` remounts the WebView for a retry.
  const [failed, setFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  // Fires once. Without this the /admin page's own subsequent
  // navigations would each re-announce a sign-in, and the caller would
  // reload its data several times over.
  const announced = useRef(false);

  const settle = (url) => {
    if (announced.current) return;
    if (!isSignedInUrl(url)) return;
    announced.current = true;
    onSignedIn?.();
  };

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Pressable onPress={onCancel} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>Cancel</Text>
        </Pressable>
        <Text style={styles.barTitle}>Sign in to PJL</Text>
        {/* Balances the Cancel button so the title sits centred. */}
        <View style={styles.barSpacer} />
      </View>

      <View style={styles.viewport}>
        <WebView
          key={reloads}
          source={{ uri: `${HOST}${LOGIN_PATH}` }}
          style={styles.web}
          // The whole point: this is what puts the session cookie
          // somewhere the app's own fetch can read it.
          sharedCookiesEnabled
          // onShouldStartLoadWithRequest keeps the sheet ON the login
          // form: the logo and the customer-portal link are both ordinary
          // links, and following either one used to read as success.
          onShouldStartLoadWithRequest={(request) => isAllowedNavigation(request?.url)}
          // Settle on LOAD END, not on navigation start. The session
          // cookie is written by an XHR inside the WebView, and the
          // write-back from WKHTTPCookieStore to the shared store that
          // this app's fetch reads is asynchronous — tearing the WebView
          // down the instant /admin starts loading races it, and the
          // symptom is "signed in, but everything still says signed
          // out", cured by signing in twice. Waiting for the destination
          // page to finish loading gives that write-back a real chance.
          onLoadEnd={({ nativeEvent }) => {
            setLoading(false);
            settle(nativeEvent?.url);
          }}
          onError={() => { setLoading(false); setFailed(true); }}
          onHttpError={({ nativeEvent }) => {
            if (nativeEvent?.statusCode >= 500) { setLoading(false); setFailed(true); }
          }}
        />
        {failed ? (
          <View style={styles.overlay}>
            <Text style={styles.failTitle}>Can't reach PJL</Text>
            <Text style={styles.failBody}>
              No connection, or the server didn't answer.
            </Text>
            <Pressable
              onPress={() => { setFailed(false); setLoading(true); setReloads((n) => n + 1); }}
              style={styles.retry}
            >
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : null}
        {loading ? (
          <View style={styles.overlay} pointerEvents="none">
            <ActivityIndicator color={colors.brand} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.card },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  back: { paddingVertical: 4, minWidth: 60 },
  backText: { ...type.body, color: colors.brand, fontWeight: '600' },
  barTitle: { ...type.body, fontWeight: '600' },
  barSpacer: { minWidth: 60 },
  viewport: { flex: 1 },
  web: { flex: 1, backgroundColor: colors.card },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.sm,
    backgroundColor: colors.card,
  },
  failTitle: { ...type.title },
  failBody: { ...type.label, textAlign: 'center', lineHeight: 21 },
  retry: {
    marginTop: space.lg, backgroundColor: colors.brand,
    paddingHorizontal: space.xl, paddingVertical: space.md,
    borderRadius: radius.card, minHeight: 48, justifyContent: 'center',
  },
  retryText: { color: colors.onBrand, fontWeight: '600' },
});
