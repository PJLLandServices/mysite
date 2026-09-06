// Where a finished closing lands.
//
// The completion cascade drafts the invoice server-side the moment the
// visit completes, so by the time this screen opens the document already
// exists. Nothing here creates or prices anything — it shows what was
// drafted and offers the two things worth doing while still on the
// driveway: send it, or take the money now.
//
// THE APP STILL HOLDS NO STRIPE KEY. Two ways to take money live here now.
//
// The payment LINK opens the customer's own page in Safari, on the
// server's domain, where the intent is minted and the keys live. The
// server refuses to double-charge an invoice whose money has moved and
// cancels a stale intent when the amount changes, and none of that
// protection travels with a copy of the logic in a phone app.
//
// TAP TO PAY collects the card here, through the Stripe Terminal SDK.
// The one thing the app fetches is a short-lived connection token from
// our own staff-gated route — card data goes from the card to Apple's
// secure element to Stripe and never touches our code, which is what
// keeps this out of PCI scope.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { AuthRequiredError, getInvoice, invoicePaymentLink, recordInvoicePayment, sendInvoice } from '../api';
import { READER, useTapToPay } from '../taptopay/useTapToPay';
import { useTapToPayLocation } from '../taptopay/TapToPayProvider';
import { colors, radius, space, type } from '../theme';

// DOLLARS. Every money field on an invoice is dollars, end to end:
// balanceDue is `round2(total - amountPaid)`, addPayment takes dollars, and
// the Stripe path divides its cents by 100 before recording. The server's
// own tolerance ("a balance within a cent counts as settled") only makes
// sense in dollars.
//
// This used to guess — "an integer of 1000 or more must be cents" — which
// rendered a $1,000.00 invoice as $10.00. It never bit because a closing is
// $90-$400, and it would have bitten on the first big job, on the screen the
// collected amount is read from.
const money = (value, currency = 'CAD') => {
  // A missing field is not zero. Number(null) is 0, and "$0.00" on a balance
  // reads as "nothing owing" — the opposite of "we don't know".
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)} ${currency}`;
};

export default function InvoiceScreen({ invoiceId, onBack }) {
  const [invoice, setInvoice] = useState(null);
  const [state, setState] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(null);
  const [recording, setRecording] = useState(false);   // the sheet is open
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('card_qb');
  // 5.9 — the last outcome, kept so the screen can name it rather than
  // silently returning to a button. null until something has happened.
  const [tapOutcome, setTapOutcome] = useState(null);

  const { locationId, tokenError } = useTapToPayLocation();
  const tap = useTapToPay();

  const load = useCallback(async () => {
    try {
      setInvoice(await getInvoice(invoiceId));
      setState('ready');
    } catch (err) {
      setState(err instanceof AuthRequiredError ? 'auth' : 'error');
    }
  }, [invoiceId]);

  useEffect(() => { load(); }, [load]);

  // 1.5 — warm up as soon as the invoice is on screen, not when the
  // button is pressed. Connecting takes seconds the first time, and 5.6
  // wants Apple's sheet up within one second when he presses it on a
  // driveway with someone waiting.
  useEffect(() => {
    if (!locationId) return;
    tap.setLocation(locationId);
    tap.warmUp();
  }, [locationId, tap.setLocation, tap.warmUp]);

  // Take the card here. The amount is the invoice's, never typed —
  // re-keying a total is how the wrong number gets charged.
  const tapToPay = useCallback(async () => {
    setTapOutcome(null);
    const due = Number(invoice?.balanceDue);
    const dollars = Number.isFinite(due) && due > 0 ? due : Number(invoice?.total);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      Alert.alert('Nothing to charge', 'This invoice has no balance owing.');
      return;
    }
    // Dollars everywhere on an invoice; Stripe wants the smallest unit.
    const amountCents = Math.round(dollars * 100);

    setBusy(true);
    try {
      const result = await tap.collect({
        amountCents,
        currency: (invoice?.currency || 'CAD').toLowerCase(),
        description: `Invoice ${invoice?.id || invoiceId}`,
      });
      setTapOutcome(result);
      if (result.ok) {
        // Record it against the invoice the way every other card payment
        // is recorded. card_qb is the general card method — it renders as
        // "Card" and reversing one warns to refund in Stripe first.
        await recordInvoicePayment(invoiceId, {
          amount: dollars,
          method: 'card_qb',
          notes: `Tap to Pay on iPhone${result.paymentIntentId ? ` (${result.paymentIntentId})` : ''}`,
        });
        // Re-read rather than patch locally: amountPaid, balanceDue and
        // status are all derived server-side.
        await load();
      }
    } catch (err) {
      // The tap succeeded but recording failed — the money moved, so say
      // so plainly rather than implying it did not.
      setTapOutcome({
        ok: false,
        outcome: 'recorded_failed',
        error: err?.message || 'The card was charged but the invoice could not be updated. Check Stripe.',
      });
    } finally {
      setBusy(false);
    }
  }, [invoice, invoiceId, tap.collect, load]);

  const send = () => {
    Alert.alert('Send this invoice?', 'Emails it to the customer now.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send',
        onPress: async () => {
          setBusy(true);
          try {
            await sendInvoice(invoiceId);
            setSentAt(new Date());
          } catch (err) {
            Alert.alert("Didn't send", err?.message || 'Nothing was sent. Try again.');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  // Their payment page, opened in Safari rather than in the app: it is
  // the customer's page, they may want to use their own Apple Pay, and a
  // payment sheet inside a tech's app is the wrong place for someone
  // else's card.
  const takePayment = async () => {
    setBusy(true);
    try {
      // A draft invoice has no payable link until one is minted, so ask
      // for it rather than assembling a URL that would 404 on a driveway.
      const url = await invoicePaymentLink(invoiceId);
      if (!url) throw new Error('No payment link came back.');
      await Linking.openURL(url);
    } catch (err) {
      Alert.alert("Couldn't open the payment page", err?.message || 'Send the invoice instead — they can pay from the email.');
    } finally {
      setBusy(false);
    }
  };

  // Money that arrived some other way — a card tapped in Stripe's own app,
  // cash, a cheque. The server owns the ledger and derives the balance and
  // the status; this only reports what was collected.
  const saveRecorded = async () => {
    const value = Number(String(amount).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      Alert.alert('How much?', 'Enter the amount collected.');
      return;
    }
    setBusy(true);
    try {
      await recordInvoicePayment(invoiceId, {
        amount: value,
        method,
        notes: method === 'card_qb' ? 'Card taken on site (Stripe app)' : 'Collected on site',
      });
      setRecording(false);
      setAmount('');
      // Re-read rather than patching locally: amountPaid, balanceDue and the
      // status are all derived server-side, and a partial payment leaves the
      // invoice open. Guessing that here is how a balance goes wrong.
      setState('loading');
      await load();
    } catch (err) {
      Alert.alert("Didn't record", err?.message || 'Nothing was recorded. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return <View style={styles.centre}><ActivityIndicator color={colors.brand} /></View>;
  }
  if (state !== 'ready') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>
          {state === 'auth' ? 'Not signed in' : "Couldn't load the invoice"}
        </Text>
        <Text style={styles.centreBody}>
          {state === 'auth'
            ? 'Open any other tab and sign in to PJL.'
            : 'The visit is finished and the invoice exists — it just would not load. Try again, or open it at the desk.'}
        </Text>
        <Pressable style={styles.retry} onPress={() => { setState('loading'); load(); }}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  const already = invoice?.sentAt || sentAt;
  const paid = invoice?.status === 'paid';
  // The server derives these; a partial payment leaves the invoice open and
  // the balance is what a second payment should default to.
  const owing = Number(invoice?.balanceDue);
  const partPaid = !paid && Number.isFinite(owing) && owing > 0 && Number(invoice?.amountPaid) > 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>‹ Today</Text>
      </Pressable>

      <Text style={styles.done}>Closing complete</Text>
      <Text style={styles.id}>{invoice?.id || invoiceId}</Text>

      <View style={styles.card}>
        <Row label="Customer" value={invoice?.customerName || invoice?.billTo?.name || '—'} />
        <Row label="Property" value={invoice?.address || invoice?.propertyAddress || '—'} />
        <Row label="Total" value={money(invoice?.total ?? invoice?.amountDue, invoice?.currency)} strong />
        {partPaid ? (
          <Row label="Still owing" value={money(invoice?.balanceDue, invoice?.currency)} strong />
        ) : null}
        <Row
          label="Status"
          value={paid ? 'Paid' : partPaid ? 'Part paid' : already ? 'Sent, awaiting payment' : 'Draft — not sent yet'}
          last
        />
      </View>

      {paid ? (
        <Text style={styles.note}>This one is already paid. Nothing left to do.</Text>
      ) : (
        <View style={styles.actions}>
          {/* 5.2 — FIRST in the list of payment options, and reachable
              without scrolling. 5.3 — never greyed out or hidden once the
              device supports it: pressing it when the reader is not ready
              starts it, and pressing it before the terms are accepted is
              what brings up Apple's own terms sheet.

              No icon, deliberately: 5.5 constrains iconography to two SF
              Symbols, and the cheapest way to comply is to use none.

              5.4 — the English long form, exactly. Never shortened to
              "Tap to Pay" (Marketing Guide, p24). */}
          {tap.supported === false ? null : (
            <Pressable
              style={[styles.button, styles.buttonTap]}
              onPress={tapToPay}
              disabled={busy || tap.state === READER.COLLECTING || tap.state === READER.PROCESSING}
              accessibilityRole="button"
              accessibilityLabel="Tap to Pay on iPhone"
            >
              <Text style={styles.buttonText}>{tap.label}</Text>
              {/* 5.7 / 3.9.1 — say which of the states we are in rather
                  than showing a bare spinner. */}
              {tap.state === READER.PREPARING ? (
                <Text style={styles.buttonSub}>
                  Getting ready…{tap.progress != null ? ` ${Math.round(Number(tap.progress) * 100)}%` : ''}
                </Text>
              ) : null}
              {tap.state === READER.COLLECTING ? (
                <Text style={styles.buttonSub}>Hold their card to the top of your phone</Text>
              ) : null}
              {tap.state === READER.PROCESSING ? (
                <Text style={styles.buttonSub}>Processing…</Text>
              ) : null}
            </Pressable>
          )}

          {/* The reader could not start. Stripe's or Apple's own words,
              because "couldn't start the reader" does not say whether to
              update iOS, sign in, or use the link instead. */}
          {tap.state === READER.FAILED || tokenError ? (
            <Text style={styles.tapError}>{tap.error || tokenError}</Text>
          ) : null}

          {/* 5.9 — approved, declined, timed out, cancelled: all named.
              4.8 / Canada — a declined tap points at the fallback rather
              than dead-ending, because offline-PIN cards cannot be tapped
              here and that is a normal outcome, not a fault. */}
          {tapOutcome && !tapOutcome.ok ? (
            <Text style={styles.tapError}>
              {tapOutcome.outcome === 'canceled' ? 'Cancelled — nothing was charged.'
                : tapOutcome.outcome === 'timed_out' ? 'The card timed out. Try again, or send the payment link.'
                : tapOutcome.outcome === 'recorded_failed' ? tapOutcome.error
                : `${tapOutcome.error || 'Declined.'} Some Canadian cards need a PIN and cannot be tapped — ask for another card or a digital wallet, or use the payment link below.`}
            </Text>
          ) : null}
          {tapOutcome && tapOutcome.ok ? (
            <Text style={styles.tapOk}>Approved. The invoice has been updated.</Text>
          ) : null}

          <Pressable
            style={[styles.button, styles.buttonGhost, busy && styles.off]}
            onPress={send}
            disabled={busy}
          >
            <Text style={styles.buttonGhostText}>
              {busy ? 'Working…' : already ? 'Send again' : 'Send invoice'}
            </Text>
          </Pressable>
          <Pressable style={[styles.button, busy && styles.off]} onPress={takePayment} disabled={busy}>
            <Text style={styles.buttonText}>Take payment now</Text>
          </Pressable>

          {/* For money collected some other way. Opening the sheet fills the
              amount with what is still owed, because that is what it almost
              always is — but it stays editable for a part payment. */}
          {recording ? null : (
            <Pressable
              style={[styles.button, styles.buttonGhost, busy && styles.off]}
              onPress={() => {
                const due = Number.isFinite(owing) && owing > 0 ? owing : Number(invoice?.total);
                setAmount(Number.isFinite(due) ? String(due.toFixed(2)) : '');
                setRecording(true);
              }}
              disabled={busy}
            >
              <Text style={styles.buttonGhostText}>Record a payment I took</Text>
            </Pressable>
          )}
        </View>
      )}

      {recording ? (
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>What did you collect?</Text>

          <TextInput
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={colors.textFaint}
            style={styles.amountInput}
          />

          <View style={styles.methods}>
            {[
              ['card_qb', 'Card'],
              ['cash', 'Cash'],
              ['cheque', 'Cheque'],
              ['e_transfer', 'e-Transfer'],
            ].map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => setMethod(key)}
                style={[styles.method, method === key && styles.methodOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: method === key }}
              >
                <Text style={[styles.methodText, method === key && styles.methodTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.sheetNote}>
            {method === 'card_qb'
              ? 'For a card tapped in the Stripe app. This records it against the invoice — it does not charge anything here.'
              : 'Recorded against the invoice. Nothing is charged here.'}
          </Text>

          <View style={styles.sheetActions}>
            <Pressable
              style={[styles.button, styles.sheetBtn, styles.buttonGhost, busy && styles.off]}
              onPress={() => setRecording(false)}
              disabled={busy}
            >
              <Text style={styles.buttonGhostText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.sheetBtn, busy && styles.off]} onPress={saveRecorded} disabled={busy}>
              <Text style={styles.buttonText}>{busy ? 'Recording…' : 'Record it'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <Text style={styles.footer}>
        {paid
          ? ''
          : already
            ? 'Sent. They can pay from the link in their email whenever they like.'
            : 'Send it and they pay in their own time, or take payment here while you are standing with them.'}
      </Text>
    </ScrollView>
  );
}

function Row({ label, value, strong, last }) {
  return (
    <View style={[styles.row, last && styles.rowLast]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.rowValueStrong]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.sm },
  centreTitle: { ...type.hero, fontSize: 20, textAlign: 'center' },
  centreBody: { ...type.caption, textAlign: 'center', lineHeight: 20 },
  retry: {
    marginTop: space.md, backgroundColor: colors.brand,
    borderRadius: radius.card, paddingVertical: 13, paddingHorizontal: space.xl,
  },
  retryText: { color: '#fff', fontSize: 16, fontWeight: '600' },

  back: { paddingVertical: 4 },
  backText: { ...type.body, color: colors.brand, fontWeight: '600' },
  done: { ...type.hero },
  id: { ...type.caption, fontVariant: ['tabular-nums'] },

  card: { backgroundColor: colors.card, borderRadius: radius.card, overflow: 'hidden' },
  row: {
    flexDirection: 'row', gap: space.md,
    paddingHorizontal: space.lg, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  rowLast: { borderBottomWidth: 0 },
  rowLabel: { ...type.body, color: colors.textMuted, width: 96 },
  rowValue: { ...type.body, flex: 1, textAlign: 'right' },
  rowValueStrong: { fontWeight: '700' },

  actions: { gap: space.sm },
  button: { backgroundColor: colors.brand, borderRadius: radius.card, paddingVertical: 15, alignItems: 'center' },
  buttonGhost: { backgroundColor: colors.brandTint },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonGhostText: { color: colors.brand, fontSize: 16, fontWeight: '600' },
  off: { opacity: 0.5 },

  // The Tap to Pay button is the primary action on this screen, so it
  // carries the brand fill rather than the ghost treatment. Note there is
  // no disabled/greyed variant — 5.3 forbids one.
  buttonTap: { backgroundColor: colors.brand, gap: 2 },
  buttonSub: { color: '#fff', fontSize: 13, opacity: 0.9 },
  tapError: { ...type.body, color: colors.danger, paddingHorizontal: space.sm },
  tapOk: { ...type.body, color: colors.brand, fontWeight: '600', paddingHorizontal: space.sm },

  sheet: { backgroundColor: colors.card, borderRadius: radius.card, padding: space.lg, gap: space.md },
  sheetTitle: { ...type.title },
  amountInput: {
    ...type.hero,
    backgroundColor: colors.ground,
    borderRadius: radius.card,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontVariant: ['tabular-nums'],
  },
  methods: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  method: {
    paddingVertical: 10, paddingHorizontal: space.lg,
    borderRadius: radius.pill, backgroundColor: colors.ground,
  },
  methodOn: { backgroundColor: colors.brand },
  methodText: { ...type.body, fontWeight: '600', color: colors.text },
  methodTextOn: { color: '#fff' },
  sheetNote: { ...type.caption, lineHeight: 19 },
  sheetActions: { flexDirection: 'row', gap: space.sm },
  // Equal halves; without this the two buttons size to their labels and
  // "Cancel" ends up a different width from "Record it".
  sheetBtn: { flex: 1 },

  note: { ...type.caption, lineHeight: 20 },
  footer: { ...type.caption, lineHeight: 20 },
});
