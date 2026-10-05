// Shrinks a photo on the phone before it queues (PJL-112): at most 2400 px
// on the long edge, JPEG 0.75 — what the server keeps anyway — in a hidden
// WebView canvas (photo-canvas.mjs SHRINK_HTML), so it ships over the air.
//
// Mounted only while the server's `photoShrink` switch is on, and separate
// from the markup editor: if resizing full-size photos misbehaves on the
// phone, the switch goes off and nothing else changes.
//
// It never stands between the tech and the photo. Anything but a smaller
// JPEG back within 10 s — not ready, an undecodable photo, a result that
// would be bigger, no answer — and the original goes up untouched.

import { useCallback, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { SHRINK_HTML } from './photo-canvas.mjs';

const TIMEOUT_MS = 10000;

// onReady(shrink): `await shrink(payload)` → the payload, smaller or as it was.
export default function PhotoShrinker({ onReady }) {
  const ref = useRef(null);
  const ready = useRef(false);
  const waiting = useRef(new Map());
  const seq = useRef(0);

  const shrink = useCallback((payload) => new Promise((resolve) => {
    if (!ref.current || !ready.current || !/^image\//.test(payload?.mediaType || '') || !payload?.data) { resolve(payload); return; }
    const id = String(++seq.current);
    const timer = setTimeout(() => { waiting.current.delete(id); resolve(payload); }, TIMEOUT_MS);
    waiting.current.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.data) resolve({ ...payload, mediaType: 'image/jpeg', data: msg.data.slice(msg.data.indexOf(',') + 1) });
      else resolve(payload);
    });
    ref.current.postMessage(JSON.stringify({
      type: 'shrink', id, src: `data:${payload.mediaType};base64,${payload.data}`, bytes: Math.round(payload.data.length * 0.75),
    }));
  }), []);

  const message = useCallback((event) => {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (msg.type === 'ready') { ready.current = true; onReady?.(shrink); }
    else if (msg.type === 'shrunk') {
      const done = waiting.current.get(msg.id);
      waiting.current.delete(msg.id);
      done?.(msg);
    }
  }, [onReady, shrink]);

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView ref={ref} source={{ html: SHRINK_HTML }} originWhitelist={['*']} onMessage={message} startInLoadingState={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, left: -10, top: -10 },
});
