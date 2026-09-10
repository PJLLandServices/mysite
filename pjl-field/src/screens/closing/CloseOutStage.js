// Close-out. Back at the truck, property done, ticking off what was
// actually performed.
//
// Back-flush sits apart from the ticks on purpose: it is a question with
// two complete answers. An unticked checkbox reads as "not done yet",
// which would be wrong for a property that has no back-flush at all.

import { StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, space, type } from '../../theme';
import { CLOSEOUT_STEPS } from './steps';
import { Button, CheckRow, ChoiceRow, Section } from './parts';

export default function CloseOutStage({ wo, save, saving, blockers, onFinish }) {
  const checklist = wo?.serviceChecklist || {};

  const toggle = (key) => {
    save({ serviceChecklist: { ...checklist, [key]: !checklist[key] } });
  };

  const ready = blockers.length === 0;

  return (
    <>
      <Section title="Winterization">
        {CLOSEOUT_STEPS.map((step, i) => (
          <CheckRow
            key={step.key}
            label={step.label}
            checked={checklist[step.key] === true}
            onToggle={() => toggle(step.key)}
            last={i === CLOSEOUT_STEPS.length - 1}
          />
        ))}
      </Section>

      <Section title="Back flush" footer="Not every property has one. Answering “No” completes this step.">
        <ChoiceRow
          label="Back flush performed?"
          value={wo?.backFlush || ''}
          options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No / none here' }]}
          onChange={(v) => save({ backFlush: v })}
          last
        />
      </Section>

      <Section title="Notes for the customer" footer="This reaches them on the service report.">
        <TextInput
          value={wo?.customerNotes || ''}
          onChangeText={(v) => save({ customerNotes: v })}
          placeholder="Anything the customer should know"
          placeholderTextColor={colors.textFaint}
          style={styles.textarea}
          multiline
        />
      </Section>

      {blockers.length ? (
        <View style={styles.blockers}>
          <Text style={styles.blockersTitle}>Before this can be finished</Text>
          {blockers.map((b) => (
            <Text key={b} style={styles.blocker}>· {b}</Text>
          ))}
        </View>
      ) : null}

      <Button
        label="Finish Fall Closing"
        onPress={onFinish}
        disabled={!ready || saving}
      />
      <Text style={styles.after}>
        Findings are saved to the property first, then you go to signature and the invoice.
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  textarea: {
    ...type.body,
    minHeight: 110, textAlignVertical: 'top',
    paddingHorizontal: space.lg, paddingVertical: 14, color: colors.text,
  },
  blockers: {
    backgroundColor: colors.warningTint, borderRadius: radius.card,
    padding: space.lg, gap: 4,
  },
  blockersTitle: { ...type.title, fontSize: 15, color: colors.warning },
  blocker: { ...type.label, color: colors.warning },
  after: { ...type.caption, textAlign: 'center' },
});
