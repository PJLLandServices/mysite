// A visit's photo thumbnails, each one tappable: move it to another zone,
// or delete it (PJL-110/111).
//
// Both are queued on the phone like every other field action (offline/
// queue.mjs deletePhoto / movePhoto): the screen changes at once, and the
// server catches up when there is signal. A delete is for good — the
// confirm step is the only safeguard, so it says so.

import { useState } from 'react';
import { ActionSheetIOS, Alert, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { woPhotoUri } from '../../api';
import { PickerSheet } from '../../ui';
import { colors, radius, space, type } from '../../theme';

const FINDING_LABEL = {
  broken_head: 'sprinkler head',
  leak: 'leak / pipe break',
  valve: 'valve leak',
  zone_revamp: 'zone revamp',
};
// The finding a photo is attached to, and its zone (the rule the server
// applies in server/lib/wo-photo-edits.js movePhoto).
function findingOf(wo, issueId) {
  if (!issueId) return null;
  for (const z of wo?.zones || []) {
    const issue = (z.issues || []).find((i) => i.id === issueId);
    if (issue) return { zoneNumber: Number(z.number), label: FINDING_LABEL[issue.type] || String(issue.type || 'repair').replace(/_/g, ' ') };
  }
  return null;
}
const visitZones = (wo) => (wo?.zones || [])
  .filter((z) => (z?.kind || 'zone') === 'zone' && Number(z?.number) > 0)
  .map((z) => ({ number: Number(z.number), location: z.location || '' }))
  .sort((a, b) => a.number - b.number);

// `canMove`: offer "Move to zone…" (zone photos). Water-off photos are
// delete-only: the photo is the water-off record, not a zone's.
export default function PhotoThumbs({ wo, photos, photoUri, onDelete, onMove, canMove = false, empty }) {
  const [moving, setMoving] = useState(null);

  const confirmDelete = (photo) => {
    Alert.alert(
      'Delete this photo?',
      "It's removed from the visit and the customer's report. This can't be undone.",
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete photo', style: 'destructive', onPress: () => onDelete(photo) },
      ],
    );
  };

  const openActions = (photo) => {
    const options = canMove ? ['Cancel', 'Move to zone…', 'Delete photo'] : ['Cancel', 'Delete photo'];
    const pick = (label) => {
      if (label === 'Move to zone…') setMoving(photo);
      if (label === 'Delete photo') confirmDelete(photo);
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: 'Photo', options, destructiveButtonIndex: options.length - 1, cancelButtonIndex: 0 },
        (i) => pick(options[i]),
      );
      return;
    }
    Alert.alert('Photo', undefined, [
      { text: 'Cancel', style: 'cancel' },
      ...options.slice(1).map((label) => ({ text: label, style: label === 'Delete photo' ? 'destructive' : 'default', onPress: () => pick(label) })),
    ]);
  };

  const finding = moving ? findingOf(wo, moving.issueId) : null;
  const here = moving?.zoneNumber == null ? null : Number(moving.zoneNumber);
  // Moving a finding's photo out of the finding's zone takes it off the
  // finding (Patrick, D-A3): said on the choice, before it happens.
  const offFinding = (to) => (finding && finding.zoneNumber !== to ? `Comes off the ${finding.label} finding` : undefined);
  const moveOptions = moving ? [
    ...visitZones(wo).map((z) => ({
      key: `zone:${z.number}`,
      label: `Zone ${z.number}${z.location ? ` — ${z.location}` : ''}`,
      note: offFinding(z.number),
      zoneNumber: z.number,
    })),
    { key: 'visit', label: 'Whole visit (no zone)', note: offFinding(null), zoneNumber: null },
  ] : [];

  return (
    <>
      {photos.length ? (
        <>
          <View style={styles.thumbs}>
            {photos.map((p) => (
              <Pressable
                key={p.n}
                onPress={() => openActions(p)}
                onLongPress={() => openActions(p)}
                style={({ pressed }) => pressed && styles.pressed}
                accessibilityRole="button"
                accessibilityLabel={canMove ? 'Photo — move or delete' : 'Photo — delete'}
              >
                <Image source={{ uri: photoUri(p) || woPhotoUri(wo.id, p) }} style={styles.thumb} resizeMode="cover" />
              </Pressable>
            ))}
          </View>
          <Text style={styles.hint}>{canMove ? 'Tap a photo to move it to another zone or delete it.' : 'Tap a photo to delete it.'}</Text>
        </>
      ) : (
        <Text style={styles.none}>{empty}</Text>
      )}
      <PickerSheet
        visible={!!moving}
        title="Move photo to…"
        options={moveOptions}
        selectedKey={here == null ? 'visit' : `zone:${here}`}
        onSelect={(item) => {
          const photo = moving;
          setMoving(null);
          if (item.zoneNumber !== here) onMove(photo, item.zoneNumber);
        }}
        onClose={() => setMoving(null)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.md },
  thumb: { width: 96, height: 96, borderRadius: radius.card, backgroundColor: colors.separator },
  pressed: { opacity: 0.6 },
  hint: { ...type.caption, paddingHorizontal: space.md, paddingBottom: space.sm },
  none: { ...type.caption, padding: space.lg },
});
