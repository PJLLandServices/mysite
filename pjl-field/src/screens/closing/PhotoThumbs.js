// A visit's photo thumbnails, each one tappable: mark it up, move it to
// another zone, or delete it (PJL-110/111/112).
//
// All of it is queued on the phone like every other field action (offline/
// queue.mjs markup / deletePhoto / movePhoto): the screen changes at once,
// and the server catches up when there is signal. A delete is for good —
// the confirm step is the only safeguard, so it says so.
//
// A marked-up photo shows in its original's place, badged, because that is
// what the customer's report shows (D-B1). The original stays on the work
// order; "Mark up again" always starts from it (D-B2), and "Remove markup"
// puts it back.

import { useState } from 'react';
import { ActionSheetIOS, Alert, Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { woPhotoUri } from '../../api';
import { pairPhotos } from '../../photo-pairs.mjs';
import { PickerSheet } from '../../ui';
import { colors, radius, space, type } from '../../theme';
import { Button } from './parts';

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

// `canMove`: offer "Move to zone…" (zone photos). Water-off photos are not
// moved: the photo is the water-off record, not a zone's.
// `justTaken`: the upload id of the photo just taken, for its "Mark up"
// button (D-B3: offered, never opened on its own).
export default function PhotoThumbs({ wo, photos, photoUri, onDelete, onMove, onMarkup, canMove = false, justTaken, empty }) {
  const [moving, setMoving] = useState(null);

  const confirm = (title, message, action, run) => {
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel' },
      { text: action, style: 'destructive', onPress: run },
    ]);
  };

  const openActions = ({ original, markup }) => {
    const options = ['Cancel', markup ? 'Mark up again' : 'Mark up', ...(markup ? ['Remove markup'] : []), ...(canMove ? ['Move to zone…'] : []), 'Delete photo'];
    const pick = (label) => {
      if (label === 'Mark up' || label === 'Mark up again') onMarkup(original);
      if (label === 'Remove markup') {
        confirm('Remove the markup?', 'The photo goes back to how it was taken. The drawing is deleted.', 'Remove markup', () => onDelete(markup));
      }
      if (label === 'Move to zone…') setMoving(original);
      if (label === 'Delete photo') {
        confirm('Delete this photo?', `It's removed from the visit and the customer's report${markup ? ', with its markup' : ''}. This can't be undone.`, 'Delete photo', () => onDelete(original));
      }
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

  const tiles = pairPhotos(photos);
  const fresh = justTaken ? tiles.find((t) => t.original.clientUploadId === justTaken && !t.markup) : null;
  return (
    <>
      {tiles.length ? (
        <>
          <View style={styles.thumbs}>
            {tiles.map((t) => {
              const shown = t.markup || t.original;
              return (
                <Pressable
                  key={String(t.original.n)}
                  onPress={() => openActions(t)}
                  onLongPress={() => openActions(t)}
                  style={({ pressed }) => pressed && styles.pressed}
                  accessibilityRole="button"
                  accessibilityLabel={`Photo${t.markup ? ', marked up' : ''} — mark up, ${canMove ? 'move ' : ''}or delete`}
                >
                  <Image source={{ uri: photoUri(shown) || woPhotoUri(wo.id, shown) }} style={styles.thumb} resizeMode="cover" />
                  {t.markup ? <Text style={styles.badge}>Marked up</Text> : null}
                </Pressable>
              );
            })}
          </View>
          {fresh ? (
            <View style={styles.fresh}>
              <Button label="Mark up this photo" tone="ghost" onPress={() => onMarkup(fresh.original)} />
            </View>
          ) : null}
          <Text style={styles.hint}>{canMove ? 'Tap a photo to mark it up, move it to another zone or delete it.' : 'Tap a photo to mark it up or delete it.'}</Text>
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
  badge: {
    position: 'absolute', left: 4, bottom: 4, paddingHorizontal: 6, paddingVertical: 2,
    borderRadius: radius.pill, overflow: 'hidden', backgroundColor: colors.brand, color: colors.onBrand, fontSize: 11, fontWeight: '600',
  },
  pressed: { opacity: 0.6 },
  fresh: { paddingHorizontal: space.md },
  hint: { ...type.caption, paddingHorizontal: space.md, paddingBottom: space.sm },
  none: { ...type.caption, padding: space.lg },
});
