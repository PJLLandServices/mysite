// The day with them in it, before you commit to it.
//
// Patrick, 2026-09-11, after a booked day turned out to run Pickering to
// North York: "I want to temporarily see the whole day (WITH) that
// navigation map (actual drive line) inserted."
//
// So the map IS the screen. Not a summary of the map, not a panel of
// numbers beside it — the same map already sitting above the Today list,
// full height, with the stop being considered drawn into it and wearing
// the orange ring that map already uses for "this is the one you are
// looking at".
//
// IT IS A LOOK, NOT A STEP. Nothing is chosen by opening it, nothing is
// held, nothing is booked. Swipe it away and the time list is exactly
// where it was. That is why it is a pageSheet rather than a slide in the
// booking flow: a step you can back out of still feels like a step, and
// this is a glance.
//
// NO NEW MAP. The app carries no map SDK — the Today map is a WebView
// onto server/today-map.js, deliberately, so the CRM's map and the
// phone's cannot drift. This is that page with two more parameters.
// Everything it can draw, this draws, including the honest dotted line
// when the server could not reach Google for real road geometry.

import { useState } from 'react';
import {
  ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { HOST } from '../api';
import { isOurPage } from './DayMap';
import { colors, radius, space, type } from '../theme';

// A load that never finishes has to become a message. The same reasoning
// as DayMap's: on a driveway the difference between slow and broken is
// what decides whether you wait.
const LOAD_TIMEOUT_MS = 20000;

export function previewUrl({ date, address, customerName, serviceLabel }) {
  const q = new URLSearchParams({
    preview: '1',
    date: String(date || ''),
    address: String(address || ''),
  });
  if (customerName) q.set('who', String(customerName));
  if (serviceLabel) q.set('service', String(serviceLabel));
  return `${HOST}/admin/today/map?${q.toString()}`;
}

export default function DayPreview({
  visible, date, dayLabel, address, customerName, serviceLabel, onClose,
}) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  // Remounted per open, so a second look at a different day never shows
  // the first day's map while it loads.
  const key = `${date}|${address}`;

  return (
    <Modal
      visible={Boolean(visible)}
      animationType="slide"
      // Swipe-down to dismiss on iOS, which is what "temporary" should
      // feel like. Android gets the back button, handled below.
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={onClose}
    >
      <View style={styles.screen}>
        <View style={styles.bar}>
          <View style={styles.barText}>
            <Text style={styles.title} numberOfLines={1}>{dayLabel || 'That day'}</Text>
            <Text style={styles.sub} numberOfLines={1}>
              {address ? `with ${address}` : 'the day as it stands'}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.mapWrap}>
          {failed ? (
            <View style={styles.centre}>
              <Text style={styles.centreTitle}>Couldn't draw the day</Text>
              <Text style={styles.centreBody}>
                The map didn't load. Nothing has been booked — close this and pick a time as usual.
              </Text>
            </View>
          ) : (
            <WebView
              key={key}
              source={{ uri: previewUrl({ date, address, customerName, serviceLabel }) }}
              style={styles.web}
              sharedCookiesEnabled
              // The ORIGIN, with no path — a path here is why the Today
              // map once opened itself in Safari (2026-09-07).
              originWhitelist={[HOST]}
              onShouldStartLoadWithRequest={(request) => isOurPage(request?.url)}
              onLoadStart={() => { setLoading(true); setFailed(false); }}
              onLoadEnd={() => setLoading(false)}
              onError={() => { setLoading(false); setFailed(true); }}
              onHttpError={() => { setLoading(false); setFailed(true); }}
              startInLoadingState={false}
            />
          )}
          {loading && !failed ? (
            <View style={styles.loading} pointerEvents="none">
              <ActivityIndicator color={colors.brand} />
              <Text style={styles.loadingText}>Working out the drive…</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.foot}>
          <Text style={styles.footText}>
            Nothing is booked by looking. Close this and pick a time as usual.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  bar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: space.md, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm,
    backgroundColor: colors.card,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  barText: { flex: 1, minWidth: 0 },
  title: { ...type.title },
  sub: { ...type.caption, marginTop: 1 },
  close: { ...type.body, color: colors.brand, fontWeight: '600' },
  mapWrap: { flex: 1, backgroundColor: colors.ground },
  web: { flex: 1, backgroundColor: colors.ground },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center', gap: space.sm,
  },
  loadingText: { ...type.caption },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: 6 },
  centreTitle: { ...type.title },
  centreBody: { ...type.caption, textAlign: 'center', lineHeight: 19 },
  foot: {
    paddingHorizontal: space.lg, paddingVertical: space.md,
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator,
  },
  footText: { ...type.caption, textAlign: 'center' },
});
