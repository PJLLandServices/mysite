// The grouped-list primitives the screens are built from. Kept small and
// dumb on purpose — layout only, no data knowledge.

import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, space, type } from './theme';

export function SectionHeader({ children, style }) {
  return <Text style={[styles.section, style]}>{children}</Text>;
}

export function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

// One line of a grouped list. `last` suppresses the hairline so the
// separator never runs to the bottom edge of a card.
//
// `right` takes a NODE instead of text, for rows whose right-hand side is
// a pill or an amount beside one. It exists because passing a <Pill> as
// `value` puts a View inside a Text — legal on iOS, and unreliable about
// sizing — so the rows that need one get a real container rather than a
// nesting trick that mostly works.
export function Row({ label, value, right, onPress, last, valueStyle }) {
  const body = (
    <View style={[styles.row, last && styles.rowLast]}>
      <Text style={styles.rowLabel} numberOfLines={1}>{label}</Text>
      {right != null ? (
        <View style={styles.rowRight}>{right}</View>
      ) : (
        <Text style={[styles.rowValue, valueStyle]} selectable>{value}</Text>
      )}
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

// A SELECT: the row form of a question. The label sits above the answer
// so an unanswered row and an answered one are the same height and the
// same shape — a list of them does not reflow as it is filled in.
//
// The choices are NOT on the screen. They live in the sheet below, which
// is the whole point: six services stacked on a slide is a scroll, and a
// scroll in the middle of a phone call is a customer waiting.
export function SelectRow({
  label, value, placeholder, note, onPress, disabled, accessibilityLabel,
}) {
  const answered = Boolean(value);
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || `${label}. ${value || 'not chosen'}.`}
      style={({ pressed }) => [
        styles.select,
        answered && styles.selectOn,
        disabled && styles.selectOff,
        pressed && styles.selectPressed,
      ]}
    >
      <View style={styles.selectBody}>
        <Text style={[styles.selectLabel, answered && styles.selectLabelOn]}>{label}</Text>
        <Text
          style={[styles.selectValue, !answered && styles.selectPlaceholder]}
          numberOfLines={1}
        >
          {value || placeholder || 'Choose'}
        </Text>
        {note ? <Text style={styles.selectNote}>{note}</Text> : null}
      </View>
      <Text style={[styles.chevron, answered && styles.chevronOn]}>›</Text>
    </Pressable>
  );
}

// The sheet a SelectRow opens, and the only one in the app.
//
// It was written twice — the Properties tab's town filter and the Book
// tab's service picker — which is two sheets that would have drifted
// apart on the first change to either. One component, both callers.
//
// `options` are `{ key, label, note, meta, group }`. `group` prints a
// header the first time it changes, which is how the zone bands keep
// residential and commercial apart without two lists.
export function PickerSheet({ visible, title, options, selectedKey, onSelect, onClose }) {
  const rows = options || [];
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Tap anywhere off the sheet to dismiss it — the gesture everyone
          already expects, and the reason no Cancel button is needed. */}
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
      />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
        <FlatList
          data={rows}
          keyExtractor={(item) => String(item.key)}
          style={styles.sheetList}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item, index }) => {
            const selected = item.key === selectedKey;
            const heads = item.group && item.group !== rows[index - 1]?.group;
            return (
              <View>
                {heads ? <Text style={styles.sheetGroup}>{item.group}</Text> : null}
                <Pressable
                  onPress={() => onSelect(item)}
                  style={({ pressed }) => [styles.sheetRow, pressed && styles.pressed]}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                >
                  <View style={styles.sheetRowBody}>
                    <Text
                      style={[styles.sheetRowText, selected && styles.sheetRowSelected]}
                      numberOfLines={1}
                    >
                      {item.label}
                    </Text>
                    {item.note ? <Text style={styles.sheetRowNote}>{item.note}</Text> : null}
                  </View>
                  {item.meta != null ? <Text style={styles.sheetRowMeta}>{item.meta}</Text> : null}
                  <Text style={[styles.check, !selected && styles.checkHidden]}>✓</Text>
                </Pressable>
              </View>
            );
          }}
        />
      </View>
    </Modal>
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
  // The label SHRINKS. It used to be flexShrink: 0, which on a 320pt
  // screen meant "I-2026-0042 · Sep 8, 2026" (~170pt) held its full width
  // and the amount and its pill had ~78pt to fit ~148pt of content — so
  // the pill wrapped to a second line or was clipped by Card's
  // overflow: 'hidden'. At 390pt it landed on the boundary, so SOME rows
  // in one list wrapped and others did not, which is the worst of the
  // outcomes. It truncates with an ellipsis instead; the id is at the
  // front, which is the part that identifies the row.
  rowLabel: { ...type.label, flexShrink: 1, flexGrow: 0 },
  rowValue: { ...type.body, flex: 1, textAlign: 'right' },
  rowRight: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.sm,
  },
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
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.separator,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    minHeight: 56,
  },
  selectOn: { borderColor: colors.brand },
  selectOff: { opacity: 0.4 },
  selectPressed: { opacity: 0.7 },
  selectBody: { flex: 1, gap: 1 },
  selectLabel: { ...type.section, fontSize: 11, letterSpacing: 0.7 },
  selectLabelOn: { color: colors.brand },
  selectValue: { ...type.body, fontWeight: '600' },
  selectPlaceholder: { color: colors.textFaint, fontWeight: '400' },
  selectNote: { ...type.caption, color: colors.warning, fontWeight: '600' },
  chevron: { color: colors.textFaint, fontSize: 22 },
  chevronOn: { color: colors.brand },

  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,24,28,0.35)' },
  sheet: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    maxHeight: '72%',
    backgroundColor: colors.card,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingBottom: space.xl,
  },
  grabber: {
    width: 38, height: 4, borderRadius: 2,
    backgroundColor: colors.separator,
    alignSelf: 'center', marginTop: space.sm, marginBottom: space.md,
  },
  sheetTitle: { ...type.section, marginHorizontal: space.lg, marginBottom: space.sm },
  sheetList: { flexGrow: 0 },
  sheetGroup: {
    ...type.section,
    backgroundColor: colors.ground,
    paddingHorizontal: space.lg,
    paddingVertical: 6,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  sheetRowBody: { flex: 1, gap: 1 },
  sheetRowText: { ...type.body },
  sheetRowSelected: { color: colors.brand, fontWeight: '600' },
  sheetRowNote: { ...type.caption, color: colors.warning, fontWeight: '600' },
  sheetRowMeta: { ...type.caption, fontVariant: ['tabular-nums'] },
  check: { color: colors.brand, fontSize: 16, width: 16, textAlign: 'center' },
  checkHidden: { opacity: 0 },

  empty: {
    ...type.caption,
    paddingHorizontal: space.lg,
    paddingVertical: 13,
  },
});
