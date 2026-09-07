// Tap to Pay on iPhone: bringing the reader up, and taking one payment.
//
// The shape of this is dictated by Apple's requirements, not by taste —
// docs/TAP_TO_PAY_REQUIREMENTS.md maps each one. The load-bearing ones:
//
//   1.5   warm the reader when the app opens or comes forward, which is
//         the ONLY way 5.6 (UI up within a second, 90% of the time) is
//         achievable — connecting takes seconds the first time.
//   1.6   never cache "has he accepted the terms" ourselves. The SDK
//         asks Apple. A local boolean goes stale the moment he accepts
//         on another device or Apple resets it, and then the button
//         lies.
//   3.9.1 a configuration progress indicator, during first setup AND
//         whenever the reader is preparing.
//   5.7   an "initializing" screen when the button is pressed early.
//   5.9   approved / declined / timed out, all three named.
//
// The reader is the phone, so there is no hardware to pair: easyConnect
// with discoveryMethod 'tapToPay' discovers and connects in one call,
// and `tosAcceptancePermitted` is what lets Apple's own terms sheet
// appear. We never draw that sheet; Apple owns it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { useStripeTerminal } from '@stripe/stripe-terminal-react-native';
import { useTapToPayLocation } from './TapToPayProvider';

// What the invoice screen renders from. Deliberately a small closed set
// rather than a pile of booleans, because 5.7/5.8/5.9 are about the user
// always knowing which of these they are in.
export const READER = {
  UNSUPPORTED: 'unsupported',   // iPad, or an iPhone too old — 1.1 / 1.3
  IDLE: 'idle',                 // nothing started yet
  PREPARING: 'preparing',       // 3.9.1 / 5.7 — connecting or configuring
  READY: 'ready',               // 5.6 — a tap will come up immediately
  COLLECTING: 'collecting',     // Apple's sheet is up, waiting for the card
  PROCESSING: 'processing',     // 5.8 — card read, money moving
  FAILED: 'failed',             // couldn't get ready; `error` says why
};

// Apple's own name for it. Never shortened to "Tap to Pay" in anything
// the customer or merchant sees (Marketing Guide, p24), and never in the
// app's name (App Review Guideline 5.2.5).
export const TAP_TO_PAY_LABEL = 'Tap to Pay on iPhone';

export function useTapToPay({ onProgress } = {}) {
  const [state, setState] = useState(READER.IDLE);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null);
  // null = not asked yet. Only ever set to false when the SDK ANSWERS
  // false. A question we could not ask is not a "no" — see the effect
  // below, which used to conflate the two and told a brand-new iPhone it
  // could not accept contactless payments.
  const [supported, setSupported] = useState(null);

  const {
    initialize,
    easyConnect,
    connectedReader,
    supportsReadersOfType,
    createPaymentIntent,
    collectPaymentMethod,
    confirmPaymentIntent,
    cancelCollectPaymentMethod,
  } = useStripeTerminal({
    // 3.9.1 — the reader reports its own configuration progress. Passed
    // straight out so the screen can show it rather than a spinner that
    // says nothing about how long is left.
    onDidReportReaderSoftwareUpdateProgress: (p) => {
      setProgress(p);
      if (onProgress) onProgress(p);
    },
  });

  // The locationId the server resolved. Held in a ref rather than state
  // because reconnecting must not depend on a re-render having happened.
  const locationRef = useRef(null);
  const warmingRef = useRef(false);
  const initializedRef = useRef(false);
  // An automatic warm-up that failed does not retry itself on every
  // return to the foreground; pressing the button always does.
  const autoFailedRef = useRef(false);

  const { getLocationId } = useTapToPayLocation();

  // Android has no Tap to Pay on iPhone, by definition. That is the only
  // thing knowable without asking the SDK, so it is the only thing
  // decided here.
  useEffect(() => {
    if (Platform.OS !== 'ios') setSupported(false);
  }, []);

  // The SDK REFUSES every question until initialize() has run —
  // `supportsReadersOfType` throws "First call initialize" rather than
  // answering. So the support probe cannot come first, and initialize
  // cannot come second.
  //
  // It used to. The probe ran on mount, threw, and the catch recorded
  // "unsupported"; warmUp then refused to initialize because the device
  // was "unsupported". An iPhone 17 Pro Max was told it could not accept
  // contactless payments, and nothing could talk it out of that.
  const ensureInitialized = useCallback(async () => {
    if (initializedRef.current) return;
    // initialize() calls our tokenProvider, so this is also where "not
    // signed in as an admin" and "Terminal is off at Stripe" surface.
    const { error: initError } = (await initialize()) || {};
    if (initError) {
      throw new Error(initError.message || 'Could not start the payment reader.');
    }
    initializedRef.current = true;
  }, [initialize]);

  // 1.1 / 1.3 — an iPad has no NFC for payment acceptance, so Tap to Pay
  // is iPhone-only on both Apple's side and Stripe's. Asked rather than
  // assumed from the device model, so a phone that is simply too old
  // answers the same way and gets the same hidden button instead of one
  // that fails when pressed.
  const probeSupport = useCallback(async () => {
    if (Platform.OS !== 'ios') { setSupported(false); return false; }
    await ensureInitialized();
    const { readerSupportResult, error: supportError } =
      (await supportsReadersOfType({
        deviceType: 'tapToPay',
        discoveryMethod: 'tapToPay',
      })) || {};
    if (supportError) {
      throw new Error(supportError.message || 'Could not ask whether this iPhone can accept cards.');
    }
    setSupported(!!readerSupportResult);
    return !!readerSupportResult;
  }, [ensureInitialized, supportsReadersOfType]);

  // 1.5 — warm up on open and on every return to the foreground. This is
  // what buys 5.6: by the time he presses the button on a driveway the
  // reader is already connected, so Apple's sheet appears at once instead
  // of after a connect.
  const warmUp = useCallback(async ({ auto = false } = {}) => {
    if (warmingRef.current) return;
    if (supported === false) { setState(READER.UNSUPPORTED); return; }
    if (connectedReader) { setState(READER.READY); return; }
    if (auto && autoFailedRef.current) return;

    warmingRef.current = true;
    setError(null);
    setState(READER.PREPARING);
    try {
      // Initialize, then ask. Both inside the try, so a refusal from
      // either says what happened instead of becoming "unsupported".
      const ok = await probeSupport();
      if (!ok) { setState(READER.UNSUPPORTED); return; }
      // The token provider is wired once at the provider (see
      // TapToPayProvider); this only needs the Location, which the same
      // server call returns. Read through the getter as well as the ref,
      // because initialize() is what fetches the token that carries it —
      // the ref is set a render later, which is after this line.
      const locationId = locationRef.current || (getLocationId && getLocationId());
      if (!locationId) throw new Error('No Stripe Terminal location — the server did not send one.');

      const { error: connectError } = await easyConnect({
        discoveryMethod: 'tapToPay',
        locationId,
        // 3.5 / 3.8 — permits Apple's own Terms and Conditions sheet to
        // appear. We do not draw it and cannot restyle it; Apple owns
        // that screen, and only the signed-in Apple Account can accept.
        tosAcceptancePermitted: true,
        merchantDisplayName: 'PJL Land Services',
        autoReconnectOnUnexpectedDisconnect: true,
      });
      if (connectError) throw new Error(connectError.message || 'Could not start the reader.');
      autoFailedRef.current = false;
      setState(READER.READY);
    } catch (err) {
      autoFailedRef.current = true;
      setError(err?.message || 'Could not start the reader.');
      setState(READER.FAILED);
    } finally {
      warmingRef.current = false;
    }
  }, [supported, connectedReader, probeSupport, getLocationId, easyConnect]);

  // Foreground transitions, per 1.5. `change` fires on cold start too in
  // some cases but not reliably, so warmUp is also called directly by the
  // screen that needs it.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') warmUp({ auto: true });
    });
    return () => sub.remove();
  }, [warmUp]);

  const setLocation = useCallback((locationId) => {
    locationRef.current = locationId || null;
  }, []);

  // One payment, on an amount the invoice already knows. The amount is
  // never typed: 5.x assumes the merchant is confirming a known total,
  // and a re-keyed number is how the wrong amount gets taken.
  //
  // Returns { ok, outcome, paymentIntentId, error } where outcome is one
  // of 'approved' | 'declined' | 'timed_out' | 'canceled' — 5.9 wants all
  // of them named, not just success and "something went wrong".
  const collect = useCallback(async ({ amountCents, currency = 'cad', description }) => {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return { ok: false, outcome: 'declined', error: 'That amount cannot be charged.' };
    }
    setError(null);
    setState(READER.COLLECTING);
    try {
      const { paymentIntent, error: createError } = await createPaymentIntent({
        amount: amountCents,
        currency,
        // BOTH, and interacPresent is not optional in Canada: a large
        // share of what gets handed over on a driveway here is Interac
        // debit, and omitting it would decline those cards at the tap
        // while the customer is standing there holding one.
        paymentMethodTypes: ['cardPresent', 'interacPresent'],
        captureMethod: 'automatic',
        ...(description ? { description } : {}),
      });
      if (createError || !paymentIntent) {
        throw new Error(createError?.message || 'Could not start the payment.');
      }

      const { paymentIntent: collected, error: collectError } = await collectPaymentMethod({
        paymentIntent,
      });
      if (collectError) {
        const canceled = /cancel/i.test(collectError.message || '');
        return {
          ok: false,
          outcome: canceled ? 'canceled' : 'declined',
          error: collectError.message || 'The card was not read.',
        };
      }

      // 5.8 — the card has been read; money is moving. A separate state
      // because this is the part that takes a second or two and the
      // customer is still standing there.
      setState(READER.PROCESSING);
      const { paymentIntent: confirmed, error: confirmError } = await confirmPaymentIntent({
        paymentIntent: collected,
      });
      if (confirmError) {
        return {
          ok: false,
          outcome: /timed?.?out/i.test(confirmError.message || '') ? 'timed_out' : 'declined',
          error: confirmError.message || 'The payment was declined.',
          paymentIntentId: collected?.id || null,
        };
      }
      return {
        ok: true,
        outcome: 'approved',
        paymentIntentId: confirmed?.id || collected?.id || null,
      };
    } catch (err) {
      return { ok: false, outcome: 'declined', error: err?.message || 'The payment did not go through.' };
    } finally {
      // Back to ready, not idle: the reader is still connected, so the
      // next customer does not wait for a reconnect.
      setState((s) => (s === READER.COLLECTING || s === READER.PROCESSING ? READER.READY : s));
    }
  }, [createPaymentIntent, collectPaymentMethod, confirmPaymentIntent]);

  const cancel = useCallback(async () => {
    try { await cancelCollectPaymentMethod(); } catch { /* already finished */ }
  }, [cancelCollectPaymentMethod]);

  return {
    state,
    error,
    progress,
    supported,
    setLocation,
    warmUp,
    collect,
    cancel,
    label: TAP_TO_PAY_LABEL,
  };
}
