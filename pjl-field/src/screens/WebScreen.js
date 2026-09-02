// A CRM page hosted in the app.
//
// TRANSITIONAL. The app is moving to its own screens end to end; this is
// what still runs on the website until each native replacement lands.
//
// While it is here it must not be a trap door. Handing a tech from a
// native screen into a web page with no way back strands them mid-visit:
// the tab bar switches tabs but does not undo the handoff, and the page's
// own chrome is hidden by design. Any screen that pushes a path here
// passes `onBack`, and a bar appears with it.

import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { HOST } from '../api';
import { colors, radius, space, type } from '../theme';

// Hides the CRM's own site navigation inside the app. The tab bar is the
// app's navigation; the hamburger would lead into the fifteen admin
// pages this app deliberately doesn't carry. CSS only, injected at the
// app end — the website is untouched for desktop.
const HIDE_CRM_NAV = `
  (function () {
    var id = 'pjl-field-app-chrome';
    if (document.getElementById(id)) return;
    var s = document.createElement('style');
    s.id = id;
    s.textContent = '.pjl-admin-nav,#navToggle{display:none !important}';
    document.head.appendChild(s);
  })();
  true;
`;

export default function WebScreen({ path, onBack, title }) {
  const ref = useRef(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const handleRequest = useCallback((request) => {
    const { url } = request;
    if (url.startsWith(HOST) || url.startsWith('about:')) return true;
    Linking.openURL(url).catch(() => {});
    return false;
  }, []);

  return (
    <View style={styles.screen}>
      {onBack ? (
        <View style={styles.bar}>
          <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          {title ? <Text style={styles.barTitle} numberOfLines={1}>{title}</Text> : null}
        </View>
      ) : null}
      <WebView
        ref={ref}
        source={{ uri: `${HOST}${path}` }}
        style={styles.web}
        sharedCookiesEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        originWhitelist={['https://*', 'http://*', 'about:*']}
        onShouldStartLoadWithRequest={handleRequest}
        injectedJavaScript={HIDE_CRM_NAV}
        onLoadEnd={() => setLoading(false)}
        onError={() => { setLoading(false); setFailed(true); }}
        onHttpError={({ nativeEvent }) => { if (nativeEvent.statusCode >= 500) setFailed(true); }}
        renderError={() => <View />}
      />
      {loading && !failed ? (
        <View style={styles.overlay} pointerEvents="none"><ActivityIndicator color={colors.brand} /></View>
      ) : null}
      {failed ? (
        <View style={styles.overlay}>
          <Text style={styles.title}>Can't reach PJL</Text>
          <Text style={styles.body}>No connection, or the server didn't answer. Your queued work is still on the phone.</Text>
          <Pressable
            style={styles.button}
            onPress={() => { setFailed(false); setLoading(true); ref.current?.reload(); }}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.card },
  web: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  back: { paddingVertical: 4, paddingRight: space.sm },
  backText: { ...type.body, color: colors.brand, fontWeight: '600' },
  barTitle: { ...type.body, color: colors.textMuted, flexShrink: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    padding: space.xl, backgroundColor: colors.card,
  },
  title: { ...type.hero, fontSize: 22, color: colors.brand, marginBottom: space.sm },
  body: { ...type.label, textAlign: 'center', lineHeight: 21, marginBottom: space.xl },
  button: {
    backgroundColor: colors.brand,
    paddingVertical: 14, paddingHorizontal: 28, borderRadius: radius.card,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
