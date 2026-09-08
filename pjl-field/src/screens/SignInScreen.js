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

// True while the WebView is still sitting on the login page. Exported
// because "did signing in work" is the whole job of this screen and it
// should be testable without a WebView.
export function isLoginUrl(url) {
  const target = String(url || '');
  if (!target.startsWith(HOST)) return false;
  const path = target.slice(HOST.length).split('#')[0].split('?')[0];
  return path === '/login' || path === '/login/';
}

// The page reached after a successful login. Anything on our own host
// that is not the login page means the cookie is set — including the
// /admin landing, and including a redirect somewhere else entirely.
export function isSignedInUrl(url) {
  const target = String(url || '');
  if (!target.startsWith(HOST)) return false;
  return !isLoginUrl(target);
}

export default function SignInScreen({ onSignedIn, onCancel }) {
  const [loading, setLoading] = useState(true);
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
          source={{ uri: `${HOST}${LOGIN_PATH}` }}
          style={styles.web}
          // The whole point: this is what puts the session cookie
          // somewhere the app's own fetch can read it.
          sharedCookiesEnabled
          onLoadEnd={({ nativeEvent }) => {
            setLoading(false);
            settle(nativeEvent?.url);
          }}
          onNavigationStateChange={(navState) => settle(navState?.url)}
        />
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
    backgroundColor: colors.card,
  },
});
