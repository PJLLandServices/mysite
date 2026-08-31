// The grouped-list primitives the screens are built from. Kept small and
// dumb on purpose — layout only, no data knowledge.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from './theme';

export function SectionHeader({ children, style }) {
  return <Text style={[styles.section, style]}>{children}</Text>;
}

export function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

// One line of a grouped list. `last` suppresses the hairline so the
// separator never runs to the bottom edge of a card.
export function Row({ label, value, onPress, last, valueStyle }) {
  const body = (
    <View style={[styles.row, last && styles.rowLast]}>
      <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
      <Text style={[styles.rowValue, valueStyle]} selectable>{value}</Text>
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>
      {body}
    </Pressable>
  );
}

// Free-text block for notes, where a right-aligned value column would
// read badly.
export function NoteRow({ label, children, last }) {
  return (
    <View style={[styles.note, last && styles.rowLast]}>
      <Text style={styles.noteLabel}>{label}</Text>
      <Text style={styles.noteBody} selectable>{children}</Text>
    </View>
  );
}

export function Pill({ children, tone = 'neutral' }) {
  const tones = {
    neutral: { bg: colors.ground, fg: colors.textMuted },
    brand: { bg: colors.brandTint, fg: colors.brand },
    warn: { bg: colors.warningTint, fg: colors.warning },
    danger: { bg: '#FCE8E6', fg: colors.danger },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <View style={[styles.pill, { backgroundColor: t.bg }]}>
      <Text style={[styles.pillText, { color: t.fg }]}>{children}</Text>
    </View>
  );
}

// The circular row under the hero, in the shape Apple's Contacts uses:
// icon glyph over a short verb.
export function ActionButton({ glyph, label, onPress, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.action, (disabled || pressed) && { opacity: disabled ? 0.35 : 0.6 }]}
    >
      <View style={styles.actionCircle}>
        <Text style={styles.actionGlyph}>{glyph}</Text>
      </View>
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

export function Empty({ children }) {
  return <Text style={styles.empty}>{children}</Text>;
}

const styles = StyleSheet.create({
  section: {
    ...type.section,
    marginTop: space.xl,
    marginBottom: space.sm,
    marginHorizontal: space.lg,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    marginHorizontal: space.md,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { ...type.label, flexShrink: 0 },
  rowValue: { ...type.body, flex: 1, textAlign: 'right' },
  pressed: { backgroundColor: colors.ground },
  note: {
    paddingHorizontal: space.lg,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  noteLabel: { ...type.label, marginBottom: space.xs },
  noteBody: { ...type.body, lineHeight: 22 },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 12, fontWeight: '600' },
  action: { alignItems: 'center', gap: 6, width: 72 },
  actionCircle: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionGlyph: { fontSize: 22 },
  actionLabel: { fontSize: 12, color: colors.brand, fontWeight: '600' },
  empty: {
    ...type.caption,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
});
