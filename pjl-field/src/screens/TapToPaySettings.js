// Tap to Pay, reachable when he is NOT standing at an invoice.
//
// Apple 3.6: "Your app must allow users to enable Tap to Pay on iPhone
// outside of the usual communications and checkout flow, such as through
// your app settings." The app had no settings surface at all, so this is
// it — deliberately one screen about one feature rather than a settings
// section invented to hold it.
//
// It also carries 4.3 (education reachable later) once the education
// module lands. Until then this screen says where that will be rather
// than pretending it is here.
//
// 1.6 — nothing about acceptance is stored here. The state shown is the
// reader's own, asked fresh. A cached "he accepted" boolean goes stale
// the moment Apple resets it and then this screen lies.

import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { READER, useTapToPay } from '../taptopay/useTapToPay';
import { useTapToPayLocation } from '../taptopay/TapToPayProvider';
import { colors, radius, space, type } from '../theme';

const STATUS = {
  [READER.UNSUPPORTED]: 'Not available on this device',
  [READER.IDLE]: 'Not started yet',
  [READER.PREPARING]: 'Getting ready…',
  [READER.READY]: 'Ready',
  [READER.COLLECTING]: 'Waiting for a card',
  [READER.PROCESSING]: 'Processing a payment',
  [READER.FAILED]: 'Could not start',
};

export default function TapToPaySettings({ onBack }) {
  const { locationId, tokenError } = useTapToPayLocation();
  const tap = useTapToPay();

  useEffect(() => {
    if (!locationId) return;
    tap.setLocation(locationId);
  }, [locationId, tap.setLocation]);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      {onBack ? (
        <Pressable onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
      ) : null}

      {/* Apple's own name, in full. Never shortened. */}
      <Text style={styles.title}>{tap.label}</Text>

      {tap.supported === false ? (
        <Text style={styles.body}>
          This device cannot accept contactless payments. Tap to Pay on iPhone needs an
          iPhone XS or later — an iPad has no reader for it, whatever else it can do.
          Payment links and recording a payment you took still work here.
        </Text>
      ) : (
        <>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Status</Text>
            <Text style={styles.statusValue}>
              {STATUS[tap.state] || tap.state}
              {tap.state === READER.PREPARING && tap.progress != null
                ? ` ${Math.round(Number(tap.progress) * 100)}%`
                : ''}
            </Text>
          </View>

          {tap.error || tokenError ? (
            <Text style={styles.error}>{tap.error || tokenError}</Text>
          ) : null}

          {/* 3.5 / 3.7 — the clear action. Pressing it when the terms have
              not been accepted is what brings up Apple's own terms sheet;
              we never draw that screen. 3.8 — only an admin can get here
              at all, because every call this makes is staff-gated on the
              server and a tech's session is refused. */}
          <Pressable style={styles.button} onPress={tap.warmUp}>
            <Text style={styles.buttonText}>
              {tap.state === READER.READY ? 'Check the reader again' : 'Set up Tap to Pay on iPhone'}
            </Text>
          </Pressable>

          <Text style={styles.note}>
            The first time, Apple will ask you to accept its Terms and Conditions with your
            Apple Account. That screen is Apple's — it cannot be skipped, and only the account
            holder can accept it.
          </Text>

          {/* Canada, and a real limit rather than a footnote: Apple's own
              fallback copy is required in merchant education (4.8), and
              this is the plain-English version of the same fact. */}
          <Text style={styles.note}>
            Some Canadian cards need a PIN entered on a physical terminal and cannot be tapped.
            When that happens, ask for another card or a digital wallet, or send the payment
            link — both still work.
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: space.lg, gap: space.md },
  back: { paddingVertical: space.xs },
  backText: { ...type.body, color: colors.brand, fontWeight: '600' },
  title: { ...type.title },
  body: { ...type.body, color: colors.textFaint },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: space.md,
  },
  statusLabel: { ...type.body, color: colors.textFaint },
  statusValue: { ...type.body, fontWeight: '600' },
  button: {
    backgroundColor: colors.brand,
    borderRadius: radius.card,
    paddingVertical: 15,
    alignItems: 'center',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  note: { ...type.body, color: colors.textFaint },
  error: { ...type.body, color: colors.danger },
});
