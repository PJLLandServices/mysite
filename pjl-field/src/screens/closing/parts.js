// Shared controls for the closing stages. Big targets, because these get
// tapped with cold hands, wet gloves, in low light.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from '../../theme';

export function Section({ title, children, footer }) {
  return (
    <View style={styles.section}>
      {title ? <Text style={styles.sectionTitle}>{title}</Text> : null}
      <View style={styles.card}>{children}</View>
      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </View>
  );
}

export function CheckRow({ label, checked, onToggle, last, disabled }) {
  return (
    <Pressable
      onPress={onToggle}
      disabled={disabled}
      style={({ pressed }) => [styles.row, last && styles.rowLast, pressed && styles.pressed]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: !!checked, disabled: !!disabled }}
    >
      <View style={[styles.box, checked && styles.boxOn]}>
        {checked ? <Text style={styles.tick}>✓</Text> : null}
      </View>
      <Text style={[styles.rowLabel, disabled && styles.dim]}>{label}</Text>
    </Pressable>
  );
}

// A question with a fixed set of answers, where every answer is complete.
// Distinct from a checkbox on purpose: unticked means "not yet", but
// "No" is a finished answer.
export function ChoiceRow({ label, value, options, onChange, last }) {
  return (
    <View style={[styles.choice, last && styles.rowLast]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.choiceOptions}>
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => onChange(active ? '' : opt.value)}
              style={[styles.opt, active && styles.optOn]}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.optText, active && styles.optTextOn]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Chip({ label, active, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, active && styles.chipOn]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function Button({ label, onPress, disabled, tone = 'primary' }) {
  const isGhost = tone === 'ghost';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        isGhost && styles.buttonGhost,
        disabled && styles.buttonOff,
        pressed && !disabled && styles.pressedBtn,
      ]}
    >
      <Text style={[styles.buttonText, isGhost && styles.buttonTextGhost, disabled && styles.buttonTextOff]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  sectionTitle: { ...type.section, marginHorizontal: space.xs },
  card: { backgroundColor: colors.card, borderRadius: radius.card, overflow: 'hidden' },
  footer: { ...type.caption, marginHorizontal: space.xs, lineHeight: 19 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  rowLast: { borderBottomWidth: 0 },
  pressed: { backgroundColor: colors.ground },
  box: {
    width: 26, height: 26, borderRadius: 7,
    borderWidth: 2, borderColor: colors.brand,
    alignItems: 'center', justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.brand },
  tick: { color: '#fff', fontSize: 15, fontWeight: '700', marginTop: -1 },
  rowLabel: { ...type.body, flex: 1, lineHeight: 21 },
  dim: { color: colors.textFaint },

  choice: {
    paddingHorizontal: space.lg, paddingVertical: 14, gap: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  choiceOptions: { flexDirection: 'row', gap: space.sm },
  opt: {
    flex: 1, alignItems: 'center', paddingVertical: 11,
    borderRadius: radius.card, backgroundColor: colors.ground,
  },
  optOn: { backgroundColor: colors.brand },
  optText: { fontSize: 15, fontWeight: '600', color: colors.textMuted },
  optTextOn: { color: '#fff' },

  chip: {
    paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: radius.pill, backgroundColor: colors.ground,
  },
  chipOn: { backgroundColor: colors.brand },
  chipText: { fontSize: 14, fontWeight: '600', color: colors.textMuted },
  chipTextOn: { color: '#fff' },

  button: {
    backgroundColor: colors.brand, borderRadius: radius.card,
    paddingVertical: 15, alignItems: 'center',
  },
  buttonGhost: { backgroundColor: colors.brandTint },
  buttonOff: { backgroundColor: colors.separator },
  pressedBtn: { opacity: 0.7 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonTextGhost: { color: colors.brand },
  buttonTextOff: { color: colors.textFaint },
});
