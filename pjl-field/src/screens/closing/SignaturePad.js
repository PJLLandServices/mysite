// A place for a customer to sign, on a phone, with a finger.
//
// Drawn in a WebView canvas rather than natively. That is a deliberate
// choice and not a shortcut: react-native-webview is already a dependency,
// so this ships as an ordinary over-the-air update. Any native drawing
// library would change the app's fingerprint, which means a new build,
// TestFlight, and Apple — for a box you draw a line in.
//
// The canvas posts its PNG back as a data URL, which is exactly what the
// server stores in `signature.imageData`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { colors, radius, space, type } from '../../theme';
import { Button } from './parts';

// Self-contained: no network, no libraries. `touch-action: none` and the
// pointer-events API are what stop the page scrolling under the finger
// mid-signature, which is the difference between a signature and a
// scribble with a gap in it.
const PAD_HTML = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  html,body { margin:0; padding:0; height:100%; background:#fff; overscroll-behavior:none; }
  canvas { display:block; width:100%; height:100%; touch-action:none; }
</style>
</head><body>
<canvas id="c"></canvas>
<script>
  var c = document.getElementById('c');
  var ctx = c.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var drawn = false, drawing = false;

  function size() {
    var r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.floor(r.width * dpr));
    c.height = Math.max(1, Math.floor(r.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#11181C';
  }
  size();

  function pos(e) {
    var r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function post(type, payload) {
    window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({ type: type }, payload || {})));
  }

  c.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    drawing = true;
    var p = pos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  });
  c.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    e.preventDefault();
    var p = pos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!drawn) { drawn = true; post('drawn'); }
  });
  function end(e) {
    if (!drawing) return;
    drawing = false;
    try { c.releasePointerCapture(e.pointerId); } catch (_) {}
  }
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  c.addEventListener('pointerleave', end);

  document.addEventListener('message', handle);      // iOS
  window.addEventListener('message', handle);        // Android
  function handle(ev) {
    var msg = String(ev.data || '');
    if (msg === 'clear') {
      ctx.clearRect(0, 0, c.width, c.height);
      drawn = false;
      post('cleared');
    } else if (msg === 'capture') {
      // An empty canvas still produces a valid PNG, so the drawn flag is
      // what decides whether there is a signature — not the image.
      post('image', { data: drawn ? c.toDataURL('image/png') : '' });
    }
  }
</script>
</body></html>`;

// onDrawnChange(hasDrawn) fires as soon as the first stroke lands, so the
// screen can enable its own button without polling. onReady(capture) hands
// up the one function the parent needs: `await capture()` returns the PNG
// data URL, or '' when nothing was drawn.
export default function SignaturePad({ onDrawnChange, onReady }) {
  const ref = useRef(null);
  const [drawn, setDrawn] = useState(false);
  const pending = useRef(null);

  const message = useCallback((event) => {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (msg.type === 'drawn') { setDrawn(true); onDrawnChange?.(true); }
    else if (msg.type === 'cleared') { setDrawn(false); onDrawnChange?.(false); }
    else if (msg.type === 'image') {
      const resolve = pending.current;
      pending.current = null;
      resolve?.(msg.data || '');
    }
  }, [onDrawnChange]);

  // Exposed through the ref the parent holds, so "capture the signature"
  // reads as one await rather than a message dance at the call site.
  const capture = useCallback(() => new Promise((resolve) => {
    if (!ref.current) return resolve('');
    pending.current = resolve;
    ref.current.postMessage('capture');
    // The WebView answering is not something to bet a customer's
    // signature on. If it goes quiet, resolve empty and let the caller
    // report it rather than hanging on a driveway.
    setTimeout(() => {
      if (pending.current === resolve) { pending.current = null; resolve(''); }
    }, 4000);
  }), []);

  const clear = useCallback(() => ref.current?.postMessage('clear'), []);

  // Hand the capture function up once. `capture` is stable, so this runs
  // on mount and never again.
  useEffect(() => { onReady?.(capture); }, [onReady, capture]);

  return (
    <View style={styles.wrap}>
      <View style={styles.padBox}>
        <WebView
          ref={ref}
          source={{ html: PAD_HTML }}
          originWhitelist={['*']}
          onMessage={message}
          scrollEnabled={false}
          bounces={false}
          style={styles.pad}
          // Nothing here loads, so a spinner would only flash.
          startInLoadingState={false}
        />
        {!drawn ? <Text style={styles.hint} pointerEvents="none">Sign here</Text> : null}
      </View>
      <View style={styles.row}>
        <Text style={styles.caption}>{drawn ? 'Signed' : 'Nothing drawn yet'}</Text>
        <Button label="Clear" tone="ghost" onPress={clear} disabled={!drawn} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  padBox: {
    height: 190,
    borderRadius: radius.card,
    borderWidth: 2,
    borderColor: colors.separator,
    borderStyle: 'dashed',
    overflow: 'hidden',
    backgroundColor: '#fff',
    justifyContent: 'center',
  },
  pad: { flex: 1, backgroundColor: '#fff' },
  hint: {
    ...type.caption,
    position: 'absolute',
    alignSelf: 'center',
    color: colors.textFaint,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  caption: { ...type.caption, flex: 1 },
});
