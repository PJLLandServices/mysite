// Where a PAID IN FULL closing lands (P-PJL-22 D).
//
// The office recorded that this customer prepaid (a season plan, a prepaid
// package), so the visit completes with no invoice and nothing to collect:
// no Send, no Take payment, no Tap to Pay. It is not No Charge — the visit
// was paid for, before.
//
// A technician is never told the arrangement (the server takes it off
// every reply a tech session gets); their copy says only that there is
// nothing to collect.

import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { colors, radius, space, type } from '../theme';

export default function PaidInFullScreen({ workOrderId, role = null, onBack }) {
  const admin = role === 'admin';
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>
      <Text style={styles.done}>{admin ? 'Paid in full — done' : 'Visit complete'}</Text>
      {workOrderId ? <Text style={styles.id}>{workOrderId}</Text> : null}
      <Text style={styles.note}>
        {admin
          ? 'This visit was prepaid, so there is no invoice and nothing to collect. The closing is recorded and the customer\'s report says Paid in full.'
          : 'Nothing to collect — payment is handled by the office. The closing is recorded and the customer\'s service report has what you found.'}
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
