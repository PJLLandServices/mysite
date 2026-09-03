// Sign-off — the end of a fall closing, and the moment it becomes a
// contract.
//
// It opens by asking who is actually standing there, because on a
// seasonal closing that genuinely varies and neither answer is the
// exception. "Customer here" wants a signature; "Nobody home" wants a
// reason recorded instead. Both end in the same place: the work order
// locks, the completion cascade fires, and an invoice exists.
//
// Two questions sit underneath, and the SERVER refuses a sign-off without
// either: how they're paying, and whether this job needs another visit.
// They are asked as two buttons each rather than defaulted, because a
// default is an answer nobody gave.
//
// Everything else the server gates on — every zone looked at, a customer
// note, the materials list, a completion photo — a fall closing has
// already satisfied by the time it reaches this screen, or does not need.

import { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, space, type } from '../../theme';
import { Button, ChoiceRow, Section } from './parts';
import SignaturePad from './SignaturePad';

// The server's BYPASS_REASONS, minus admin_override — that one exists for
// the desk, not for a driveway.
const BYPASS_REASONS = [
  { key: 'customer_not_home', label: 'Nobody was home' },
  { key: 'trusted_customer_verbal', label: 'Agreed verbally' },
  { key: 'other', label: 'Other (say why)' },
];

export default function SignOffStage({ wo, save, saving, onFinish, busy }) {
  // null until asked. Not defaulted: which of these is "normal" is the
  // thing that varies, and guessing wrong makes the common case worse.
  const [who, setWho] = useState(null);          // 'customer' | 'nobody'

  const [name, setName] = useState('');
  const [ack, setAck] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [capture, setCapture] = useState(null);  // () => Promise<dataURL>

  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  const paid = wo?.paidOnSite;
  const returning = wo?.needsReturnVisit;

  const onReady = useCallback((fn) => setCapture(() => fn), []);

  // Everything still standing between here and a finished closing, in the
  // order it appears on screen. Shown rather than hidden behind a dead
  // button: every one of these is something the tech can fix where they
  // are standing.
  const blockers = [];
  if (!who) blockers.push('Say who is signing');
  if (who === 'customer') {
    if (!name.trim()) blockers.push("The customer's printed name");
    if (!ack) blockers.push('The authorization tick');
    if (!drawn) blockers.push('A signature on the pad');
  }
  if (who === 'nobody') {
    if (!reason) blockers.push('A reason nobody signed');
    if (reason === 'other' && note.trim().length < 4) blockers.push('A note saying what happened');
  }
  if (paid !== true && paid !== false) blockers.push('How they are paying');
  if (returning !== true && returning !== false) blockers.push('Whether you are coming back');

  const finish = () => {
    if (blockers.length) return;
    const label = who === 'customer'
      ? `${name.trim()} signs, the visit completes, and the invoice is drafted.`
      : 'The visit completes without a signature, and the invoice is drafted.';
    Alert.alert('Finish this closing?', `${label}\n\nAfter this the scope is locked.`, [
      { text: 'Not yet', style: 'cancel' },
      {
        text: 'Finish',
        onPress: async () => {
          if (who === 'customer') {
            const imageData = capture ? await capture() : '';
            if (!imageData) {
              Alert.alert(
                "Signature didn't capture",
                'Have them sign again — nothing has been sent, and nothing is lost.'
              );
              return;
            }
            onFinish({ mode: 'customer', signature: { customerName: name.trim(), imageData, acknowledgement: true } });
          } else {
            onFinish({ mode: 'bypass', reason, note: note.trim() });
          }
        },
      },
    ]);
  };

  return (
    <>
      <Section title="Who is signing?" footer="Most closings happen with nobody home. Either answer is normal.">
        <View style={styles.who}>
          <Button
            label="Customer is here"
            tone={who === 'customer' ? 'primary' : 'ghost'}
            onPress={() => setWho('customer')}
            disabled={busy}
          />
          <Button
            label="Nobody home"
            tone={who === 'nobody' ? 'primary' : 'ghost'}
            onPress={() => setWho('nobody')}
            disabled={busy}
          />
        </View>
      </Section>

      {who === 'customer' ? (
        <Section title="Signature" footer="Their name as they print it, then have them sign.">
          <View style={styles.pad}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Printed name"
              placeholderTextColor={colors.textFaint}
              style={styles.input}
              autoCapitalize="words"
            />
            <SignaturePad onDrawnChange={setDrawn} onReady={onReady} />
          </View>
          <ChoiceRow
            label="They authorize the work as described"
            value={ack ? 'yes' : ''}
            options={[{ value: 'yes', label: 'Authorized' }]}
            onChange={(v) => setAck(v === 'yes')}
            last
          />
        </Section>
      ) : null}

      {who === 'nobody' ? (
        <Section title="Why no signature?" footer="This is the record of how the work was accepted, so it is worth a sentence.">
          <View style={styles.pad}>
            <View style={styles.reasons}>
              {BYPASS_REASONS.map((r) => (
                <Button
                  key={r.key}
                  label={r.label}
                  tone={reason === r.key ? 'primary' : 'ghost'}
                  onPress={() => setReason(r.key)}
                  disabled={busy}
                />
              ))}
            </View>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder={reason === 'other' ? 'Say what happened' : 'Anything to add (optional)'}
              placeholderTextColor={colors.textFaint}
              style={[styles.input, styles.noteInput]}
              multiline
            />
          </View>
        </Section>
      ) : null}

      <Section title="Before it closes">
        <ChoiceRow
          label="How are they paying?"
          value={paid === true ? 'paid' : paid === false ? 'bill' : ''}
          options={[{ value: 'paid', label: 'Paid on site' }, { value: 'bill', label: 'Bill later' }]}
          onChange={(v) => save({ paidOnSite: v === 'paid' ? true : v === 'bill' ? false : null })}
        />
        <ChoiceRow
          label="Does this job need another visit?"
          value={returning === true ? 'yes' : returning === false ? 'no' : ''}
          options={[{ value: 'no', label: 'Done today' }, { value: 'yes', label: 'Coming back' }]}
          onChange={(v) => save({ needsReturnVisit: v === 'yes' ? true : v === 'no' ? false : null })}
          last
        />
      </Section>

      {blockers.length ? (
        <View style={styles.blockers}>
          <Text style={styles.blockersTitle}>Still to do</Text>
          {blockers.map((b) => <Text key={b} style={styles.blocker}>• {b}</Text>)}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button
          label={busy ? 'Finishing…' : 'Finish and invoice'}
          onPress={finish}
          disabled={busy || saving || blockers.length > 0}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  who: { flexDirection: 'row', gap: space.sm, padding: space.md },
  pad: { padding: space.md, gap: space.md },
  reasons: { gap: space.sm },
  input: {
    ...type.body,
    backgroundColor: colors.ground,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: 12,
  },
  noteInput: { minHeight: 72, textAlignVertical: 'top' },
  blockers: {
    backgroundColor: colors.warningTint,
    borderRadius: radius.card,
    padding: space.lg,
    gap: 4,
  },
  blockersTitle: { ...type.section, color: colors.warning },
  blocker: { ...type.body, color: colors.warning, lineHeight: 21 },
  actions: { gap: space.sm },
});
