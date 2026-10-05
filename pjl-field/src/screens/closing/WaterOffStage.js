// Water off — the documentation that matters most if a freeze claim
// ever lands.
//
// One or the other, never both: a customer who already closed the water
// leaves the tech nothing to close. That is also why the photo is
// optional here — if the customer shut it off before you arrived, there
// is nothing to photograph.

import { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { uploadWoPhotos } from '../../api';
import { space, type } from '../../theme';
import { pickPhoto, takePhoto } from '../../photos';
import { Button, ChoiceRow, Section } from './parts';
import PhotoThumbs from './PhotoThumbs';

export default function WaterOffStage({ wo, save, saving, onNext, attachPhoto, photoUri, deletePhoto, markupPhoto, justTaken, photoOptions }) {
  const [busy, setBusy] = useState(false);
  const photos = (wo?.photos || []).filter((p) => p.label === 'water_off');

  const attach = async (getter) => {
    setBusy(true);
    try {
      const photo = await getter({ category: 'pre_work', label: 'water_off' }, photoOptions);
      if (!photo) return;               // backed out — a normal outcome
      await attachPhoto(photo);
    } catch (err) {
      Alert.alert("Photo didn't attach", err?.message || 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="How was the water shut off?"
        footer="One or the other. If the customer had already closed it, there's nothing for you to close — and nothing to photograph."
      >
        <ChoiceRow
          label="Water shut off by"
          value={wo?.waterShutoffBy || ''}
          options={[
            { value: 'customer', label: 'Customer' },
            { value: 'tech', label: 'At main, by me' },
          ]}
          onChange={(v) => save({ waterShutoffBy: v })}
          last
        />
      </Section>

      <Section title="Photo" footer="Optional, but worth having whenever you closed it yourself.">
        <PhotoThumbs wo={wo} photos={photos} photoUri={photoUri} onDelete={deletePhoto} onMarkup={markupPhoto} justTaken={justTaken} empty="No photo attached." />
      </Section>

      <View style={styles.actions}>
        <Button
          label={busy ? 'Working…' : 'Take a photo'}
          tone="ghost"
          onPress={() => attach(takePhoto)}
          disabled={busy || saving}
        />
        <Button
          label="Choose from library"
          tone="ghost"
          onPress={() => attach(pickPhoto)}
          disabled={busy || saving}
        />
        <Button
          label="Continue to zones"
          onPress={onNext}
          disabled={!wo?.waterShutoffBy}
        />
      </View>

      {!wo?.waterShutoffBy ? (
        <Text style={styles.hint}>Pick one before carrying on — the closing can't finish without it.</Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  actions: { gap: space.sm },
  hint: { ...type.caption, textAlign: 'center' },
});
