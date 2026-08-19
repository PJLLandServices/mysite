import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';

// The tech's morning hub — today's bookings, each linking through to the
// field WO tech-mode page. Everything the app shows lives on the server;
// this app is the shell around it, not a second copy of it.
const HOST = 'https://www.pjllandservices.com';
const START_URL = `${HOST}/admin/today`;

// Anything that isn't a page on our own site gets handed to iOS instead of
// being loaded in here: the Navigate button's Apple/Google Maps chooser,
// tel: links to the customer, mailto:. Loading those in the WebView would
// either dead-end or strand the tech away from the work order.
function isInternal(url) {
  return url.startsWith(HOST) || url.startsWith('about:');
}

export default function App() {
  const webRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const handleRequest = useCallback((request) => {
    const { url } = request;
    if (isInternal(url)) return true;
    Linking.openURL(url).catch(() => {});
    return false;
  }, []);

  const retry = useCallback(() => {
    setFailed(false);
    setLoading(true);
    webRef.current?.reload();
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />

      <WebView
        ref={webRef}
        source={{ uri: START_URL }}
        style={styles.web}
        // Keeps the session cookie in the system store, so the tech isn't
        // logged out every time the app is closed.
        sharedCookiesEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        originWhitelist={['https://*', 'http://*', 'about:*']}
        onShouldStartLoadWithRequest={handleRequest}
        onLoadEnd={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setFailed(true);
        }}
        onHttpError={({ nativeEvent }) => {
          // 401/403 are the login redirect doing its job, not a failure.
          if (nativeEvent.statusCode >= 500) setFailed(true);
        }}
        renderError={() => <View />}
      />

      {loading && !failed ? (
        <View style={styles.overlay} pointerEvents="none">
          <ActivityIndicator size="large" color="#1B4D2E" />
        </View>
      ) : null}

      {failed ? (
        <View style={styles.overlay}>
          <Text style={styles.title}>Can't reach PJL</Text>
          <Text style={styles.body}>
            No connection, or the server didn't answer. Your queued work is
            still on the phone.
          </Text>
          <Pressable style={styles.button} onPress={retry}>
            <Text style={styles.buttonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#1B4D2E',
  },
  web: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1B4D2E',
    marginBottom: 8,
  },
  body: {
    fontSize: 15,
    lineHeight: 21,
    color: '#444',
    textAlign: 'center',
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#1B4D2E',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
