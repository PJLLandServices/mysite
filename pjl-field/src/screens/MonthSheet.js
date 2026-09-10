// A month at a glance, for picking a day that is not in this week.
//
// The week strip answers "what am I doing this week". Getting to the 23rd
// of next month through it means tapping › five times and counting. This
// is the other question — "what am I doing on that day" — and it deserves
// a calendar rather than a longer strip.
//
// Built from Modal, Pressable and View: all React Native core, so it ships
// over the air. A date-picker library would have meant a new build.

import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  addMonths, fromYmd, monthGrid, sameMonth, startOfMonth, WEEKDAY_INITIALS, ymd,
} from '../dates';
import { colors, radius, space, type } from '../theme';

export default function MonthSheet({ visible, selected, today, onPick, onClose }) {
  // Which month is on screen, which is not the same as which day is
  // chosen: you page through months to look around without committing to
  // anything until you tap a date.
  const [cursor, setCursor] = useState(() => startOfMonth(fromYmd(selected || today || ymd(new Date()))));

  // Re-anchor each time it opens, so it never reopens on a month left
  // behind from a previous look.
  const onShow = () => setCursor(startOfMonth(fromYmd(selected || today || ymd(new Date()))));

  const days = monthGrid(cursor);
  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onShow={onShow}
      onRequestClose={onClose}
    >
      {/* Tapping the dimmed area closes it — the iOS habit, and it means
          backing out never requires finding a small target. */}
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.head}>
            <Pressable onPress={() => setCursor(addMonths(cursor, -1))} hitSlop={12} style={styles.step}>
              <Text style={styles.stepText}>‹</Text>
            </Pressable>
            <Text style={styles.monthLabel}>{monthLabel}</Text>
            <Pressable onPress={() => setCursor(addMonths(cursor, 1))} hitSlop={12} style={styles.step}>
              <Text style={styles.stepText}>›</Text>
            </Pressable>
          </View>

          <View style={styles.row}>
            {WEEKDAY_INITIALS.map((w, i) => (
              <Text key={`${w}${i}`} style={styles.initial}>{w}</Text>
            ))}
          </View>

          <View style={styles.grid}>
            {days.map((d) => {
              const key = ymd(d);
              const isSelected = key === selected;
              const isToday = key === today;
              const outside = !sameMonth(d, cursor);
              return (
                <Pressable
                  key={key}
                  onPress={() => onPick(key)}
                  style={styles.cell}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  accessibilityLabel={d.toLocaleDateString(undefined, {
                    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
                  })}
                >
                  <View style={[styles.pill, isSelected && styles.pillSelected]}>
                    <Text
                      style={[
                        styles.num,
                        outside && styles.numOutside,
                        isToday && !isSelected && styles.numToday,
                        isSelected && styles.numSelected,
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                  </View>
                  <View style={[styles.dot, isToday && !isSelected && styles.dotOn]} />
                </Pressable>
              );
            })}
          </View>

          <Pressable onPress={onClose} style={styles.close} accessibilityRole="button">
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    padding: space.lg,
  },
  sheet: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md,
  },

  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  step: { paddingHorizontal: space.md, paddingVertical: 4 },
  stepText: { fontSize: 22, color: colors.brand, fontWeight: '600' },
  monthLabel: { ...type.title },

  row: { flexDirection: 'row' },
  initial: { ...type.caption, flex: 1, textAlign: 'center' },

  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  // Seven to a row, and the height is fixed so the six-week grid never
  // changes size between months.
  cell: { width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 6 },
  pill: {
    width: 34, height: 34, borderRadius: radius.pill,
    alignItems: 'center', justifyContent: 'center',
  },
  pillSelected: { backgroundColor: colors.brand },
  num: { ...type.body, fontVariant: ['tabular-nums'] },
  // Days from the neighbouring months stay tappable — the 1st of next
  // month is often what you want — but recede so the month reads as a
  // shape rather than a wall of numbers.
  numOutside: { color: colors.textFaint },
  numToday: { color: colors.brand, fontWeight: '700' },
  numSelected: { color: '#fff', fontWeight: '700' },

  dot: { width: 5, height: 5, borderRadius: 3, marginTop: 3, backgroundColor: 'transparent' },
  dotOn: { backgroundColor: colors.brand },

  close: { alignSelf: 'center', paddingVertical: space.sm, paddingHorizontal: space.xl },
  closeText: { ...type.body, color: colors.brand, fontWeight: '600' },
});
