// A CRM page hosted in the app. The transactional flows — completing a
// work order, invoicing, messaging — stay on the pages that already do
// them correctly and are covered by FLOW_REGISTER. Only reading and
// browsing was worth rebuilding natively.

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

export default function WebScreen({ path }) {
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
