// Where a NO-CHARGE closing lands (fall-closing fix #8).
//
// A visit that bills $0 — a per-property $0 rate, a courtesy closing — has
// no invoice by design: nothing to send, nothing to collect. It used to land
// on a $0 invoice screen with "Take payment" prefilled 0.00, which is a
// button that can only confuse a customer standing in their driveway. The
// visit, its service record and its report are the record.

import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { colors, radius, space, type } from '../theme';

export default function NoChargeScreen({ workOrderId, onBack }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>
      <Text style={styles.done}>No charge — done</Text>
      {workOrderId ? <Text style={styles.id}>{workOrderId}</Text> : null}
      <Text style={styles.note}>
        This visit is no charge, so there is no invoice and nothing to collect. The closing is recorded and the
        customer's service report has what you found.
      </Text>
      <Pressable style={styles.button} onPress={onBack}>
        <Text style={styles.buttonText}>Back to the day</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xl },
  back: { paddingVertical: 4 },
  backText: { ...type.body, color: colors.brand, fontWeight: '600' },
  done: { ...type.hero },
  id: { ...type.caption, fontVariant: ['tabular-nums'] },
  note: { ...type.caption, lineHeight: 20 },
  button: { backgroundColor: colors.brand, borderRadius: radius.card, paddingVertical: 15, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
