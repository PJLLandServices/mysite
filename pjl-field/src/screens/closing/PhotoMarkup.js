// Drawing on a work-order photo (PJL-112): pen, arrow, circle, text, undo,
// reset. PJL's own markup, not Apple's — Apple's needs native code the
// installed build does not have, so this is a WebView canvas, like the
// signature pad, and ships over the air.
//
// The original is never touched. Done saves a NEW photo (the photo and
// its marks, at most 2400 px, JPEG 0.85) that names the original; the
// customer's report shows it in the original's place. Cancel saves
// nothing.
//
// The drawing itself lives in photo-canvas.mjs (EDITOR_HTML); this is the
// frame around it: big buttons for gloves, Cancel and Done always on
// screen, the text label typed natively.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { EDITOR_HTML } from '../../photo-canvas.mjs';
import { PromptSheet } from '../../ui';
import { colors, space } from '../../theme';

const TOOLS = [
  { key: 'pen', label: 'Pen' },
  { key: 'arrow', label: 'Arrow' },
  { key: 'circle', label: 'Circle' },
  { key: 'text', label: 'Text' },
];
const COLORS = [
  { key: '#E5322D', label: 'Red' },
  { key: '#FFD60A', label: 'Yellow' },
  { key: '#FFFFFF', label: 'White' },
];

// `source`: the photo as a data URL, or null while it loads.
// onSave(base64Jpeg) · onCancel()
export default function PhotoMarkup({ visible, source, onSave, onCancel }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [marks, setMarks] = useState(0);
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState(COLORS[0].key);
  const [width, setWidth] = useState('thick');
  const [textAt, setTextAt] = useState(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const send = (msg) => ref.current?.postMessage(JSON.stringify(msg));

  // A fresh editor each time it opens.
  useEffect(() => {
    if (!visible) { setReady(false); setLoaded(false); setMarks(0); setSaving(false); setTextAt(null); }
  }, [visible]);
  useEffect(() => { if (ready && source) send({ type: 'load', src: source }); }, [ready, source]);
  useEffect(() => { if (ready) send({ type: 'tool', tool, color, width }); }, [ready, tool, color, width]);

  const message = useCallback((event) => {
    let msg;
    try { msg = JSON.parse(event.nativeEvent.data); } catch { return; }
    if (msg.type === 'ready') setReady(true);
    else if (msg.type === 'loaded') setLoaded(true);
    else if (msg.type === 'loadError') { Alert.alert("Couldn't open the photo", 'Try again, or take a new photo.'); onCancel(); }
    else if (msg.type === 'marks') setMarks(msg.count);
    else if (msg.type === 'textAt') { setText(''); setTextAt(msg.at); }
    else if (msg.type === 'exported') onSave(String(msg.data).slice(String(msg.data).indexOf(',') + 1));
    else if (msg.type === 'exportError') { setSaving(false); Alert.alert("Couldn't save the markup", msg.message || 'Try again.'); }
  }, [onSave, onCancel]);

  const done = () => { setSaving(true); send({ type: 'export' }); };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onCancel}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.bar}>
          <Big label="Cancel" onPress={onCancel} disabled={saving} />
          <Text style={styles.title}>Mark up</Text>
          <Big label={saving ? 'Saving…' : 'Done'} onPress={done} disabled={!loaded || !marks || saving} strong />
        </View>
        <View style={styles.canvas}>
          {visible ? (
            <WebView
              ref={ref}
              source={{ html: EDITOR_HTML }}
              originWhitelist={['*']}
              onMessage={message}
              scrollEnabled={false}
              bounces={false}
              style={styles.web}
              startInLoadingState={false}
            />
          ) : null}
          {!loaded ? <ActivityIndicator style={styles.spinner} color={colors.onBrand} size="large" /> : null}
        </View>
        <View style={styles.tools}>
          <View style={styles.row}>
            {TOOLS.map((t) => <Big key={t.key} label={t.label} active={tool === t.key} onPress={() => setTool(t.key)} />)}
          </View>
          <View style={styles.row}>
            {COLORS.map((c) => (
              <Pressable key={c.key} onPress={() => setColor(c.key)} accessibilityRole="button" accessibilityLabel={c.label}
                style={[styles.swatch, { backgroundColor: c.key }, color === c.key && styles.swatchOn]} />
            ))}
            <Big label={width === 'thick' ? 'Thick' : 'Thin'} onPress={() => setWidth(width === 'thick' ? 'thin' : 'thick')} />
          </View>
          <View style={styles.row}>
            <Big label="Undo" onPress={() => send({ type: 'undo' })} disabled={!marks} />
            <Big label="Reset" onPress={() => send({ type: 'reset' })} disabled={!marks} />
          </View>
        </View>
        <PromptSheet
          visible={!!textAt}
          title="Label"
          placeholder="e.g. Broken head"
          value={text}
          onChangeText={setText}
          confirmLabel="Place"
          optional={false}
          onCancel={() => setTextAt(null)}
          onConfirm={() => { send({ type: 'text', at: textAt, text: text.trim() }); setTextAt(null); }}
        />
      </SafeAreaView>
    </Modal>
  );
}

// 56 pt: a gloved thumb in the cold.
function Big({ label, onPress, disabled, active, strong }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={6} accessibilityRole="button" accessibilityState={{ disabled: !!disabled, selected: !!active }}
      style={({ pressed }) => [styles.big, active && styles.bigOn, pressed && styles.pressed, disabled && styles.off]}>
      <Text style={[styles.bigText, (active || strong) && styles.bigTextStrong]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.sm, paddingVertical: space.xs },
  title: { color: colors.onBrand, fontSize: 17, fontWeight: '600' },
  canvas: { flex: 1 },
  web: { flex: 1, backgroundColor: '#000' },
  spinner: { position: 'absolute', alignSelf: 'center', top: '45%' },
  tools: { gap: space.sm, padding: space.sm, backgroundColor: '#111' },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center', justifyContent: 'center' },
  big: { minWidth: 72, minHeight: 56, paddingHorizontal: space.md, borderRadius: 12, backgroundColor: '#2A2A2E', alignItems: 'center', justifyContent: 'center' },
  bigOn: { backgroundColor: colors.brand },
  bigText: { color: colors.onBrand, fontSize: 16 },
  bigTextStrong: { fontWeight: '700' },
  pressed: { opacity: 0.6 },
  off: { opacity: 0.35 },
  swatch: { width: 56, height: 56, borderRadius: 28, borderWidth: 2, borderColor: '#444' },
  swatchOn: { borderColor: colors.onBrand, borderWidth: 4 },
});
