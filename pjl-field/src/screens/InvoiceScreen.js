// Where a finished closing lands.
//
// The completion cascade drafts the invoice server-side the moment the
// visit completes, so by the time this screen opens the document already
// exists. Nothing here creates or prices anything — it shows what was
// drafted and offers the two things worth doing while still on the
// driveway: send it, or take the money now.
//
// THE APP NEVER TALKS TO STRIPE ABOUT MONEY. Taking payment opens the
// customer's own payment page in Safari, on the server's domain, where the
// intent is minted and the keys live. Tap to Pay on iPhone is the same
// rule with the card in the room: the server mints the charge for the
// balance, the reader collects it, and the server asks Stripe before the
// invoice reads Paid. That is not squeamishness: the server already
// refuses to double-charge an invoice whose money has moved and cancels a
// stale intent when the amount changes, and none of that protection
// travels with a copy of the logic in a phone app.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import {
  AuthRequiredError, finalizeTerminalPayment, getInvoice, invoicePaymentLink, recordInvoicePayment, resendInvoice,
  sendInvoice, startTerminalPayment,
} from '../api';
import { READER, useTapToPay } from '../taptopay/useTapToPay';
import { useTapToPayLocation } from '../taptopay/TapToPayProvider';
import { money as formatMoney } from '../format';
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
// Formatting is shared with the rest of the app (src/format.js) so the same
// invoice cannot read "$285.00 CAD" here and "$285.00" on the property
// screen, and so a five-figure balance groups its thousands in both places.
// What stays local is the fallback: on THIS screen a missing field must
// render "—", because Number(null) is 0 and "$0.00" on a balance reads as
// "nothing owing", which is the opposite of "we don't know".
const money = (value, currency = 'CAD') => formatMoney(value, currency) ?? '—';

export default function InvoiceScreen({ invoiceId, onBack, onSignIn }) {
  const [invoice, setInvoice] = useState(null);
  const [state, setState] = useState('loading');
  const [busy, setBusy] = useState(false);
  const [sentAt, setSentAt] = useState(null);
  const [recording, setRecording] = useState(false);   // the sheet is open
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('card_qb');
  // 5.9 — the last Tap to Pay outcome, kept so the screen can name it
  // (approved, declined, timed out, cancelled) rather than a bare spinner.
  const [tapOutcome, setTapOutcome] = useState(null);

  // 1.5 / 5.6 — the reader is warmed as soon as the invoice opens, so by the
  // time the button is pressed Apple's sheet comes up at once.
  const { locationId, tokenError } = useTapToPayLocation();
  const tap = useTapToPay();
  useEffect(() => {
    if (!locationId) return;
    tap.setLocation(locationId);
    tap.warmUp();
  }, [locationId, tap.setLocation, tap.warmUp]);

  const load = useCallback(async () => {
    try {
      setInvoice(await getInvoice(invoiceId));
      setState('ready');
    } catch (err) {
      setState(err instanceof AuthRequiredError ? 'auth' : 'error');
    }
  }, [invoiceId]);

  useEffect(() => { load(); }, [load]);

  // The customer pays in Safari; when the tech comes back to the app the
  // invoice must say what happened there. Re-read on every return to the
  // foreground, quietly — the screen keeps showing what it had until the
  // fresh copy lands, and a failed re-read leaves it alone.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      getInvoice(invoiceId).then(setInvoice).catch(() => {});
    });
    return () => sub.remove();
  }, [invoiceId]);

  // Already out of draft = already emailed at least once, and /send only
  // accepts drafts. The server's word, not this screen's memory.
  const alreadySent = (inv) => Boolean(inv?.sentAt) || (inv?.status && inv.status !== 'draft');

  const send = () => {
    Alert.alert('Send this invoice?', 'Emails it to the customer now.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Send',
        onPress: async () => {
          setBusy(true);
          try {
            if (alreadySent(invoice) || sentAt) await resendInvoice(invoiceId);
            else await sendInvoice(invoiceId);
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

  // Tap to Pay on iPhone. Three steps, and only the middle one is the phone's:
  //   1. the server creates the charge for the balance (it picks the amount)
  //   2. the reader collects and confirms it (Apple's sheet, the card)
  //   3. the server re-reads it from Stripe and only then marks it paid
  // If step 3 cannot reach the server, the money has moved and Stripe's
  // webhook will still flip the invoice; the screen says so and offers a
  // re-check rather than a second charge (the server refuses one anyway).
  const finalizeTap = async (paymentIntentId) => {
    try {
      await finalizeTerminalPayment(invoiceId, paymentIntentId);
      setTapOutcome({ ok: true, outcome: 'approved', paymentIntentId });
    } catch (err) {
      setTapOutcome({
        ok: false, outcome: 'approved_unconfirmed', paymentIntentId,
        error: err?.message || 'The server could not confirm it yet.',
      });
    }
    try { setInvoice(await getInvoice(invoiceId)); } catch { /* the screen keeps what it had */ }
  };

  const tapToPay = async () => {
    setTapOutcome(null);
    setBusy(true);
    try {
      let started;
      try {
        started = await startTerminalPayment(invoiceId);
      } catch (err) {
        if (err instanceof AuthRequiredError) { setState('auth'); return; }
        if (err?.code === 'already_paid') { await load(); return; }
        setTapOutcome({ ok: false, outcome: 'not_started', error: err?.message || 'Could not start the payment.' });
        return;
      }
      const result = await tap.collect({ clientSecret: started.clientSecret });
      if (result.ok) await finalizeTap(result.paymentIntentId || started.paymentIntentId);
      else setTapOutcome(result);
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

  // Rendered in EVERY state, before anything else. This screen is where a
  // finished closing lands and where a payment is recorded — and it is an
  // overlay, so it covers the tab bar. `saveRecorded` drops back to
  // 'loading' after taking money; if that re-read 401s or hangs, a state
  // without this bar would strand the tech on an exit-less screen holding
  // a customer's card.
  const exitBar = (
    <Pressable onPress={onBack} hitSlop={12} style={styles.exitBar}>
      <Text style={styles.backText}>‹ Back</Text>
    </Pressable>
  );

  if (state === 'loading') {
    return (
      <View style={styles.screen}>
        {exitBar}
        <View style={styles.centre}><ActivityIndicator color={colors.brand} /></View>
      </View>
    );
  }
  if (state !== 'ready') {
    return (
      <View style={styles.screen}>
        {exitBar}
        <View style={styles.centre}>
          <Text style={styles.centreTitle}>
            {state === 'auth' ? 'Not signed in' : "Couldn't load the invoice"}
          </Text>
          <Text style={styles.centreBody}>
            {state === 'auth'
              ? 'Sign in to PJL to open this invoice.'
              : 'The visit is finished and the invoice exists — it just would not load. Try again, or open it at the desk.'}
          </Text>
          <Pressable
            style={styles.retry}
            onPress={state === 'auth' ? onSignIn : () => { setState('loading'); load(); }}
          >
            <Text style={styles.retryText}>{state === 'auth' ? 'Sign in' : 'Try again'}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const already = alreadySent(invoice) || sentAt;
  // The server derives these; a partial payment leaves the invoice open and
  // the balance is what a second payment should default to.
  const owing = Number(invoice?.balanceDue);
  // Paid is the server's status — or money covering the whole balance on
  // a server that has not yet learned to flip a paid draft. Either way a
  // settled invoice must never offer Send or Take payment again.
  const paid = invoice?.status === 'paid'
    || (Number(invoice?.amountPaid) > 0 && Number.isFinite(owing) && owing <= 0.01);
  const partPaid = !paid && Number.isFinite(owing) && owing > 0 && Number(invoice?.amountPaid) > 0;
  // A draft signed off "Bill later" waits for Patrick's review; the server
  // refuses to open it for payment, so the button is not offered.
  const payableHere = !(invoice?.status === 'draft' && invoice?.paidOnSiteAtCompletion !== true);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>‹ Back</Text>
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
        <Text style={tapOutcome?.ok ? styles.tapOk : styles.note}>
          {tapOutcome?.ok ? 'Approved — paid by Tap to Pay on iPhone.' : 'This one is already paid. Nothing left to do.'}
        </Text>
      ) : (
        <View style={styles.actions}>
          {/* 5.2 — FIRST in the list of payment options, reachable without
              scrolling. 5.3 — never greyed out once the device supports it:
              pressing it when the reader is not ready starts it, and before
              the terms are accepted it is what brings up Apple's own sheet.
              5.4 — Apple's English wording, exactly (tap.label). 5.5 — no
              icon, the cheapest way to meet the SF Symbol rule. Only offered
              where the server would take payment on site (Bill later waits
              for Patrick, and the server refuses it anyway). */}
          {payableHere && tap.supported !== false ? (
            <Pressable
              style={[styles.button, styles.buttonTap]}
              onPress={tapToPay}
              disabled={busy || tap.state === READER.COLLECTING || tap.state === READER.PROCESSING}
              accessibilityRole="button"
              accessibilityLabel={tap.label}
            >
              <Text style={styles.buttonText}>{tap.label}</Text>
              {/* 5.7 / 3.9.1 / 5.8 — say which state we are in. */}
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
          ) : null}

          {/* The reader could not start. Stripe's or Apple's own words,
              because "couldn't start the reader" does not say whether to
              update iOS, sign in, or use the link instead. */}
          {payableHere && (tap.state === READER.FAILED || tokenError) ? (
            <Text style={styles.tapError}>{tap.error || tokenError}</Text>
          ) : null}

          {/* 5.9 — approved, declined, timed out, cancelled: all named.
              4.8 / Canada — a declined tap points at the fallback rather
              than dead-ending, because offline-PIN cards cannot be tapped
              here and that is a normal outcome, not a fault. */}
          {tapOutcome && tapOutcome.outcome === 'approved_unconfirmed' ? (
            <View style={styles.tapPending}>
              <Text style={styles.tapPendingText}>
                The card was approved. The invoice will read Paid once the server hears it from Stripe — do not take the
                payment again. ({tapOutcome.error})
              </Text>
              <Pressable onPress={() => { setBusy(true); finalizeTap(tapOutcome.paymentIntentId).finally(() => setBusy(false)); }} disabled={busy}>
                <Text style={styles.tapPendingAction}>Check again</Text>
              </Pressable>
            </View>
          ) : tapOutcome && !tapOutcome.ok ? (
            <Text style={styles.tapError}>
              {tapOutcome.outcome === 'canceled' ? 'Cancelled — nothing was charged.'
                : tapOutcome.outcome === 'timed_out' ? 'The card timed out. Try again, or send the payment link.'
                : tapOutcome.outcome === 'not_started' ? tapOutcome.error
                : `${tapOutcome.error || 'Declined.'} Some Canadian cards need a PIN and cannot be tapped — ask for another card or a digital wallet, or use Take payment now to send the payment link.`}
            </Text>
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
          {payableHere ? (
            <Pressable style={[styles.button, busy && styles.off]} onPress={takePayment} disabled={busy}>
              <Text style={styles.buttonText}>Take payment now</Text>
            </Pressable>
          ) : (
            <Text style={styles.note}>Signed off as “Bill later” — Patrick reviews this one before it goes to the customer.</Text>
          )}

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
  exitBar: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm },
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
  // The Tap to Pay button is the primary action here, so it carries the
  // brand fill. No disabled/greyed variant — Apple 5.3 forbids one.
  buttonTap: { backgroundColor: colors.brand, gap: 2 },
  buttonSub: { color: '#fff', fontSize: 13, opacity: 0.9 },
  tapError: { ...type.body, color: colors.danger, paddingHorizontal: space.sm },
  tapOk: { ...type.body, color: colors.brand, fontWeight: '600' },
  tapPending: { backgroundColor: colors.warningTint, borderRadius: radius.card, padding: space.md, gap: space.sm },
  tapPendingText: { ...type.body, color: colors.warning },
  tapPendingAction: { ...type.body, color: colors.brand, fontWeight: '600' },

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
