// The day's route, on the map, above the list.
//
// WHY THIS IS A WEBVIEW AND NOT A NATIVE MAP. The map it has to match is
// the one on /admin/season-plan — numbered stops, the road line, the same
// greens. Drawing it a second time with a native map SDK would mean two
// implementations that drift, a new native dependency, and a rebuild
// every time the map changed. `server/today-map.js` is the one
// implementation; this is one of its two hosts. The CRM's Today page is
// the other, and both get every fix at once.
//
// It reads the SAME endpoint the list below it reads, in the same order,
// so a pin and the card beside it cannot disagree about which stop is
// which.
//
// The cookie already in the app is what signs it in — `sharedCookiesEnabled`,
// the same arrangement WebScreen has used since the app shipped.

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { HOST } from '../api';
import { colors, radius, space, type } from '../theme';

const SHORT = 210;
const TALL = 430;

export default function DayMap({ date, refreshToken, focusKey, onSelectStop }) {
  const ref = useRef(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [tall, setTall] = useState(false);
  const readyRef = useRef(false);

  // Post into the page rather than reloading it: a reload throws away the
  // basemap tiles and the pan the user just did, which on a driveway is
  // the difference between a glance and a wait.
  const post = (message) => {
    if (!ref.current || !readyRef.current) return;
    ref.current.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(JSON.stringify(message))}}));true;`,
    );
  };

  // The map redraws when the day's rows change — completing a work order
  // is what turns a numbered pin into a tick, and that has to show up
  // without a pull-to-refresh.
  useEffect(() => {
    if (refreshToken === undefined) return;
    post({ type: 'refresh' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  useEffect(() => {
    post({ type: 'focus', key: focusKey || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const handleMessage = (event) => {
    let message;
    try { message = JSON.parse(event?.nativeEvent?.data || ''); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') { readyRef.current = true; return; }
    if (message.type === 'stop' && onSelectStop) onSelectStop(message.key);
  };

  if (failed) {
    // A map that cannot load must not take the day sheet with it. The
    // list below this is the part the work depends on.
    return (
      <Pressable
        style={[styles.frame, styles.failed, { height: SHORT }]}
        onPress={() => { setFailed(false); setLoading(true); readyRef.current = false; ref.current?.reload(); }}
      >
        <Text style={styles.failedTitle}>The route map didn’t load</Text>
        <Text style={styles.failedBody}>Tap to try again. The list below still works.</Text>
      </Pressable>
    );
  }

  return (
    <View style={[styles.frame, { height: tall ? TALL : SHORT }]}>
      <WebView
        ref={ref}
        source={{ uri: `${HOST}/admin/today/map?date=${encodeURIComponent(date || '')}` }}
        style={styles.web}
        sharedCookiesEnabled
        originWhitelist={[`${HOST}/*`]}
        onMessage={handleMessage}
        onLoadStart={() => { readyRef.current = false; }}
        onLoadEnd={() => setLoading(false)}
        onError={() => { setLoading(false); setFailed(true); }}
        // The map is a glance, not a document. Nothing here should bounce
        // or offer to be a web page.
        scrollEnabled={false}
        bounces={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
      />
      {loading ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : null}
      <Pressable
        onPress={() => setTall((v) => !v)}
        hitSlop={10}
        style={styles.size}
        accessibilityRole="button"
        accessibilityLabel={tall ? 'Shrink the route map' : 'Enlarge the route map'}
      >
        <Text style={styles.sizeText}>{tall ? '⌃' : '⌄'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: radius.card,
    overflow: 'hidden',
    backgroundColor: colors.card,
    marginHorizontal: space.md,
    marginBottom: space.md,
  },
  web: { flex: 1, backgroundColor: colors.card },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  size: {
    position: 'absolute',
    right: 8,
    top: 8,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(15,31,20,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sizeText: { color: '#FAFAF5', fontSize: 15, fontWeight: '700', lineHeight: 17 },
  failed: { alignItems: 'center', justifyContent: 'center', padding: space.md },
  failedTitle: { ...type.body, fontWeight: '700' },
  failedBody: { ...type.body, color: colors.textFaint, textAlign: 'center', marginTop: 4 },
});
