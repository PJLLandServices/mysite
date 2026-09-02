// One zone, one page. "Zone 5 of 8" — you step through them.
//
// Deliberately sparse: a closing is find-only, so the only questions
// that matter here are whether anything needs repairing next year, what
// kind, and what it looked like. The five condition checks the spring
// opening uses are not shown — you are blowing zones out, not running
// them — but the fields are left untouched in the data for spring.

import { useEffect, useState } from 'react';
import { Alert, Image, StyleSheet, Text, TextInput, View } from 'react-native';
import { getProperty, patchProperty, removePropertyZone, uploadWoPhotos, woPhotoUri } from '../../api';
import { colors, radius, space, type } from '../../theme';
import { pickPhoto, takePhoto } from '../../photos';
import { Button, CheckRow, Chip, Section } from './parts';

// Patrick's field vocabulary on the left, the stored ZONE_ISSUE_TYPES on
// the right. `pipe`, `wire` and `controller` still exist server-side and
// remain reachable from the full web work order — they are not offered
// here because a closing rarely produces them and a shorter list is
// faster in the cold.
// Why a zone is coming off the property. A closed set so the trail can be
// counted later; "other" carries the note instead. Mirrors
// ZONE_REMOVAL_REASONS in server/lib/properties.js, which validates it.
const REMOVAL_REASONS = [
  { key: 'not_present', label: "Isn't on this property" },
  { key: 'merged', label: 'Merged into another zone' },
  { key: 'mistake', label: 'Added by mistake' },
  { key: 'other', label: 'Other (say why)' },
];

// A zone the tech adds on site. Matches what the server scaffolds, so a
// zone added here behaves like one that came from the property.
const blankZone = (number) => ({
  number,
  location: '',
  sprinklerTypes: [],
  coverage: [],
  status: '',
  notes: '',
  checks: {},
  issues: [],
});

const REPAIR_TYPES = [
  { key: 'broken_head', label: 'Sprinkler Head' },
  { key: 'leak', label: 'Leak / Pipe Break' },
  { key: 'valve', label: 'Valve Leak' },
  { key: 'zone_revamp', label: 'Zone Revamp' },
  { key: 'other', label: 'Other (use notes)' },
];

export default function ZoneStage({ wo, save, saving, zoneIndex, setZoneIndex, onDoneAll }) {
  const zones = wo?.zones || [];
  const zone = zones[zoneIndex] || {};
  const total = zones.length;

  const [label, setLabel] = useState(zone.location || '');
  const [notes, setNotes] = useState(zone.notes || '');
  const [types, setTypes] = useState(() => (zone.issues || []).map((i) => i.type));
  const [repairs, setRepairs] = useState(() => (zone.issues || []).length > 0);
  const [busy, setBusy] = useState(false);
  // The removal sheet slides down over the page: pick a reason, then
  // confirm. Kept in one piece of state so it can only be open for the
  // zone it was opened on.
  const [removing, setRemoving] = useState(null);   // { number } | null
  const [removeReason, setRemoveReason] = useState('');
  const [removeNote, setRemoveNote] = useState('');

  // Re-seed when the page changes, so stepping to the next zone doesn't
  // carry the last one's answers across.
  useEffect(() => {
    setLabel(zone.location || '');
    setNotes(zone.notes || '');
    setTypes((zone.issues || []).map((i) => i.type));
    setRepairs((zone.issues || []).length > 0);
  }, [zoneIndex, zone.location, zone.notes, zone.issues]);

  const writeZone = (patch) => {
    const next = zones.map((z, i) => (i === zoneIndex ? { ...z, ...patch } : z));
    return save({ zones: next });
  };

  const toggleType = (key) => {
    setTypes((prev) => (prev.includes(key) ? prev.filter((t) => t !== key) : [...prev, key]));
  };

  // Several types ticked become several issues, one per type. Fast to
  // capture, and next spring each arrives as its own line that can be
  // priced or declined on its own rather than one lump.
  const issuesFromSelection = () =>
    (repairs ? types : []).map((t) => ({ type: t, qty: 1, notes: notes.trim() }));

  const markDone = async () => {
    // status doubles as "this zone has been looked at" — the same test
    // the web page uses for a reviewed zone, so both surfaces agree.
    const status = repairs && types.length ? 'repair_required'
      : notes.trim() ? 'other'          // looked at, something to say — e.g. couldn't reach it
      : 'working_well';
    await writeZone({
      location: label.trim(),
      notes: notes.trim(),
      issues: issuesFromSelection(),
      status,
    });

    // A corrected label belongs to the property, not just to today.
    //
    // The property is FETCHED FRESH here rather than read off the work
    // order, and that matters twice over. `PATCH /api/properties/:id`
    // merges `system` only one level deep, so the `zones` array it
    // receives REPLACES the stored one outright — send a stale copy and
    // you revert every rename made earlier in this visit; send an empty
    // one and you erase the property's zone list altogether. A work-order
    // copy goes stale the moment the first zone is renamed, so it is not
    // safe to patch from. One extra request, on an action a tech takes
    // rarely, buys an array that is provably current.
    if (wo?.propertyId && label.trim() && label.trim() !== (zone.location || '')) {
      try {
        const fresh = await getProperty(wo.propertyId);
        const propSystem = fresh?.system || {};
        const existing = Array.isArray(propSystem.zones) ? propSystem.zones : [];
        if (!existing.length) {
          Alert.alert(
            'Zone renamed here only',
            "This visit has the new name, but the property record doesn't list any zones to rename."
          );
        } else if (!existing.some((z) => Number(z.number) === Number(zone.number))) {
          Alert.alert(
            'Zone renamed here only',
            `The property record has no Zone ${zone.number}, so there was nothing to rename on it.`
          );
        } else {
          const propZones = existing.map((z) =>
            Number(z.number) === Number(zone.number)
              // Both names: older property records key off `label`, newer
              // off `location`, and the CRM reads `location || label`.
              // Writing one and leaving the other stale shows the old name
              // on whichever surface reads the other.
              //
              // pendingReview drops here too. A zone materialized from a
              // declared count carries it until someone has actually seen
              // the zone; a tech standing in front of it, naming it, IS
              // that confirmation — and it is what stops the customer
              // overwriting a walked count from their appointment page.
              ? { ...z, location: label.trim(), label: label.trim(), pendingReview: false }
              : z
          );
          await patchProperty(wo.propertyId, { system: { ...propSystem, zones: propZones } });
        }
      } catch (err) {
        // The visit record is right either way; the property just didn't
        // learn from it. Worth saying, not worth blocking on.
        Alert.alert('Zone renamed here only', "The property record didn't update: " + (err?.message || ''));
      }
    }

    if (zoneIndex + 1 < total) setZoneIndex(zoneIndex + 1);
    else onDoneAll();
  };

  const attach = async (getter) => {
    setBusy(true);
    try {
      const photo = await getter({ category: 'issue', zoneNumber: zone.number, label: `zone_${zone.number}` });
      if (!photo) return;
      const data = await uploadWoPhotos(wo.id, [photo]);
      if (data?.workOrder) save({ photos: data.workOrder.photos });
    } catch (err) {
      Alert.alert("Photo didn't attach", err?.message || 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  // Add a zone the customer's count didn't know about. Numbered one past
  // the highest on the work order — never reusing a number a removed zone
  // once had, because the controller station it named may still exist.
  const addZone = async () => {
    const nextNumber = zones.reduce((max, z) => Math.max(max, Number(z.number) || 0), 0) + 1;
    setBusy(true);
    try {
      const fresh = wo?.propertyId ? await getProperty(wo.propertyId) : null;
      if (fresh) {
        const propSystem = fresh.system || {};
        const propZones = Array.isArray(propSystem.zones) ? propSystem.zones : [];
        if (!propZones.some((z) => Number(z.number) === nextNumber)) {
          await patchProperty(wo.propertyId, {
            system: {
              ...propSystem,
              zones: [...propZones, { number: nextNumber, location: '', label: '', notes: '', pendingReview: true }],
            },
          });
        }
      }
      save({ zones: [...zones, blankZone(nextNumber)] });
      setZoneIndex(zones.length);
    } catch (err) {
      Alert.alert("Couldn't add the zone", err?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    const number = removing?.number;
    if (!number) return;
    setBusy(true);
    try {
      if (wo?.propertyId) {
        await removePropertyZone(wo.propertyId, number, {
          reason: removeReason,
          note: removeNote.trim(),
        });
      }
      const next = zones.filter((z) => Number(z.number) !== Number(number));
      save({ zones: next });
      // Step back rather than off the end when the last page goes.
      setZoneIndex(Math.max(0, Math.min(zoneIndex, next.length - 1)));
      setRemoving(null);
      setRemoveReason('');
      setRemoveNote('');
      if (!next.length) onDoneAll();
    } catch (err) {
      Alert.alert("Couldn't remove the zone", err?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const zonePhotos = (wo?.photos || []).filter((p) => p.zoneNumber === zone.number);
  const done = !!zone.status;

  return (
    <>
      <View style={styles.pager}>
        <Button label="‹" tone="ghost" onPress={() => setZoneIndex(Math.max(0, zoneIndex - 1))} disabled={zoneIndex === 0} />
        <View style={styles.pagerMid}>
          <Text style={styles.pagerText}>Zone {zone.number ?? zoneIndex + 1} of {total}</Text>
          {done ? <Text style={styles.pagerDone}>Done</Text> : null}
        </View>
        <Button label="›" tone="ghost" onPress={() => setZoneIndex(Math.min(total - 1, zoneIndex + 1))} disabled={zoneIndex + 1 >= total} />
      </View>

      <Section title="Where is it?" footer="Correcting this updates the property record too, so the system gets better described every visit.">
        <TextInput
          value={label}
          onChangeText={setLabel}
          placeholder="e.g. Front lawn — north strip"
          placeholderTextColor={colors.textFaint}
          style={styles.input}
        />
      </Section>

      <Section title="Next year">
        <CheckRow
          label="Repairs required for next year?"
          checked={repairs}
          onToggle={() => setRepairs((v) => !v)}
          last={!repairs}
        />
        {repairs ? (
          <View style={styles.chips}>
            {REPAIR_TYPES.map((t) => (
              <Chip key={t.key} label={t.label} active={types.includes(t.key)} onPress={() => toggleType(t.key)} />
            ))}
          </View>
        ) : null}
      </Section>

      <Section title="Notes" footer="Anything worth knowing next spring — including a zone you couldn't reach and why.">
        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="Notes for this zone"
          placeholderTextColor={colors.textFaint}
          style={[styles.input, styles.textarea]}
          multiline
        />
      </Section>

      <Section title="Photos">
        {zonePhotos.length ? (
          <View style={styles.thumbs}>
            {zonePhotos.map((p) => (
              <Image
                key={p.n}
                source={{ uri: woPhotoUri(wo.id, p) }}
                style={styles.thumb}
                resizeMode="cover"
              />
            ))}
          </View>
        ) : (
          <Text style={styles.none}>No photos on this zone.</Text>
        )}
      </Section>

      <Section
        title="This zone list"
        footer="The count came from the customer. Fix it here if the ground disagrees — the property record follows."
      >
        <View style={styles.listActions}>
          <Button label="+ Add a zone" tone="ghost" onPress={addZone} disabled={busy || saving} />
          <Button
            label={`Remove Zone ${zone.number ?? zoneIndex + 1}`}
            tone="ghost"
            danger
            onPress={() => { setRemoveReason(''); setRemoveNote(''); setRemoving({ number: zone.number }); }}
            disabled={busy || saving}
          />
        </View>
      </Section>

      {removing ? (
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Remove Zone {removing.number}?</Text>
          <Text style={styles.sheetBody}>
            It comes off this visit and off the property record. The zones after it keep their
            numbers — Zone 5 is still whatever the controller calls Zone 5.
          </Text>

          <Text style={styles.sheetLabel}>Why?</Text>
          <View style={styles.sheetChips}>
            {REMOVAL_REASONS.map((r) => (
              <Chip
                key={r.key}
                label={r.label}
                active={removeReason === r.key}
                onPress={() => setRemoveReason(r.key)}
              />
            ))}
          </View>

          <TextInput
            value={removeNote}
            onChangeText={setRemoveNote}
            placeholder={removeReason === 'other' ? 'Say what happened' : 'Anything to add (optional)'}
            placeholderTextColor={colors.textFaint}
            style={[styles.input, styles.sheetInput]}
            multiline
          />

          <View style={styles.sheetActions}>
            <Button label="Keep it" tone="ghost" onPress={() => setRemoving(null)} disabled={busy} />
            <Button
              label={busy ? 'Removing…' : 'Remove zone'}
              danger
              onPress={confirmRemove}
              disabled={busy || !removeReason || (removeReason === 'other' && removeNote.trim().length < 4)}
            />
          </View>
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button label={busy ? 'Working…' : 'Take a photo'} tone="ghost" onPress={() => attach(takePhoto)} disabled={busy} />
        <Button label="Choose from library" tone="ghost" onPress={() => attach(pickPhoto)} disabled={busy} />
        <Button
          label={repairs && !types.length ? 'Pick a repair type' : zoneIndex + 1 < total ? 'Done — next zone' : 'Done — close out'}
          onPress={markDone}
          disabled={saving || (repairs && !types.length)}
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  listActions: { flexDirection: 'row', gap: space.sm, padding: space.md },
  sheet: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md,
    borderWidth: 2,
    borderColor: colors.danger,
  },
  sheetTitle: { ...type.hero, fontSize: 19 },
  sheetBody: { ...type.caption, lineHeight: 19 },
  sheetLabel: { ...type.section },
  sheetChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  sheetInput: { minHeight: 72, textAlignVertical: 'top' },
  sheetActions: { flexDirection: 'row', gap: space.sm },
  pager: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pagerMid: { flex: 1, alignItems: 'center' },
  pagerText: { ...type.title },
  pagerDone: { ...type.caption, color: colors.brand, fontWeight: '600' },
  input: {
    ...type.body,
    paddingHorizontal: space.lg, paddingVertical: 14,
    color: colors.text,
  },
  textarea: { minHeight: 96, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.md, paddingTop: 0 },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, padding: space.md },
  thumb: { width: 96, height: 96, borderRadius: radius.card, backgroundColor: colors.separator },
  none: { ...type.caption, padding: space.lg },
  actions: { gap: space.sm },
});
