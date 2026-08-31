// Arrival. Everything needed before getting out of the truck, and the
// one button that starts the clock.

import { useState } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { colors, space, type } from '../../theme';
import { currentFix } from '../../location';
import { Button, Section } from './parts';

const stamp = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export default function StartStage({ wo, save, saving, findings, onNext }) {
  const [starting, setStarting] = useState(false);
  const started = !!wo?.arrivedAt;
  const sys = wo?.property?.system || {};

  const start = async () => {
    setStarting(true);
    // The fix is attempted before the status flip so the two land
    // together. A refused permission or a phone with no signal returns
    // null and the visit starts anyway — arrivedAt still records when.
    const fix = await currentFix();
    try {
      await save({
        status: 'on_site',
        arrivedAt: new Date().toISOString(),
        arrivalLocation: fix,
      });
      if (!fix) {
        Alert.alert(
          'Started without a location',
          "Your phone couldn't give a position. The time is recorded; the place isn't.",
        );
      }
      onNext();
    } finally {
      setStarting(false);
    }
  };

  const openMaps = () => {
    const dest = wo?.address;
    if (dest) Linking.openURL(`http://maps.apple.com/?daddr=${encodeURIComponent(dest)}`).catch(() => {});
  };

  return (
    <>
      <View style={styles.hero}>
        <Text style={styles.customer}>{wo?.customerName || 'Customer'}</Text>
        <Text style={styles.address}>{wo?.address || 'No address'}</Text>
        <Text style={styles.meta}>Fall Closing · {wo?.id}</Text>
      </View>

      <Section title="On arrival">
        <Fact label="Controller" value={sys.controllerBrand} />
        <Fact label="Located" value={sys.controllerLocation} />
        <Fact label="Shutoff" value={sys.shutoffLocation} />
        <Fact label="Blow-out" value={sys.blowoutLocation} last />
      </Section>

      {started ? (
        <Section title="Started">
          <View style={styles.startedBox}>
            <Text style={styles.startedText}>{stamp(wo.arrivedAt)}</Text>
            <Text style={styles.startedSub}>
              {wo.arrivalLocation
                ? `Location recorded (±${Math.round(wo.arrivalLocation.accuracy || 0)} m)`
                : 'No location recorded'}
            </Text>
          </View>
        </Section>
      ) : null}

      <View style={styles.actions}>
        {started ? (
          <Button label="Continue to water off" onPress={onNext} />
        ) : (
          <Button
            label={starting ? 'Starting…' : 'Start Service (Fall Closing)'}
            onPress={start}
            disabled={starting || saving}
          />
        )}
        <Button label="Navigate" tone="ghost" onPress={openMaps} disabled={!wo?.address} />
      </View>

      {findings ? (
        <Text style={styles.note}>{findings} finding{findings === 1 ? '' : 's'} recorded so far this visit.</Text>
      ) : null}
    </>
  );
}

function Fact({ label, value, last }) {
  return (
    <View style={[styles.fact, last && styles.factLast]}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={[styles.factValue, !value && styles.factMissing]}>{value || 'Not recorded'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { paddingHorizontal: space.xs, paddingTop: space.sm, gap: 2 },
  customer: { ...type.hero },
  address: { ...type.label, lineHeight: 21 },
  meta: { ...type.caption, marginTop: 2 },
  fact: {
    flexDirection: 'row', justifyContent: 'space-between', gap: space.lg,
    paddingHorizontal: space.lg, paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  factLast: { borderBottomWidth: 0 },
  factLabel: { ...type.label, flexShrink: 0 },
  factValue: { ...type.body, flex: 1, textAlign: 'right' },
  factMissing: { color: colors.textFaint },
  startedBox: { padding: space.lg, gap: 3 },
  startedText: { ...type.title },
  startedSub: { ...type.caption },
  actions: { gap: space.sm },
  note: { ...type.caption, textAlign: 'center' },
});
