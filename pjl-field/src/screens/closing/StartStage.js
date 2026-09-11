// Arrival. Everything needed before getting out of the truck, and the
// one button that starts the clock.
//
// THE FACTS ARE THE PROPERTY'S, NOT THE VISIT'S. Where the controller is,
// what it is, where the water shuts off, where the line blows out — these
// are true of the address, not of one October morning. They were shown
// here from the first version and could not be CHANGED, so a tech standing
// in the garage looking at a Hunter HPC-400 had the answer the office had
// been missing for a year and nowhere to put it. Now the same rows edit in
// place and save to the property record, which is what the CRM reads.
//
// Patrick: "The information that is updated here MUST also follow over to
// the properties information thats on my CRM."
//
// WHO TO MEET COMES FIRST on a commercial site, because it is the thing
// you need before you are out of the truck — and only when the property
// actually has a site contact, so a driveway never carries an empty box.

import { useState } from 'react';
import {
  Alert, Linking, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { colors, radius, space, type } from '../../theme';
import { currentFix } from '../../location';
import { Button, Section } from './parts';

const stamp = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null
    : d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

// One list, so the read view and the edit view cannot drift about which
// row is which. The labels are the CRM's own words: the screen used to say
// "Controller" for the brand and "Located" for the place, which reads as
// the reverse of the form Patrick fills in.
export const SYSTEM_FIELDS = [
  { key: 'controllerBrand', label: 'Controller', placeholder: 'e.g. Hunter HPC-400' },
  { key: 'controllerLocation', label: 'Location', placeholder: 'e.g. Garage, north wall' },
  { key: 'shutoffLocation', label: 'Main shut-off', placeholder: 'e.g. Furnace room' },
  { key: 'blowoutLocation', label: 'Blow-out', placeholder: 'e.g. Rear hose bib' },
];

const clean = (v) => String(v == null ? '' : v).trim();

// What the tech typed, ready for the property record. Trimmed, and every
// field present — a cleared box has to reach the server as "" or clearing
// something would silently do nothing.
export function systemPatch(draft) {
  const patch = {};
  for (const f of SYSTEM_FIELDS) patch[f.key] = clean(draft?.[f.key]);
  patch.notes = clean(draft?.notes);
  return patch;
}

// Whether this property has anything on file at all. Four "Not recorded"
// rows stacked up is a wall of nothing; an empty record says so once.
export function nothingKnown(sys) {
  return !SYSTEM_FIELDS.some((f) => clean(sys?.[f.key])) && !clean(sys?.notes);
}

export default function StartStage({ wo, save, saveSystem, saving, findings, onNext }) {
  const [starting, setStarting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [savingSys, setSavingSys] = useState(false);
  const started = !!wo?.arrivedAt;
  const sys = wo?.property?.system || {};
  const contacts = Array.isArray(wo?.property?.siteContacts)
    ? wo.property.siteContacts.filter((c) => c && clean(c.name))
    : [];
  // No property on the work order means nothing to write back to. The rows
  // still show; the pencil does not.
  const canEdit = Boolean(wo?.property?.id && saveSystem);
  const blank = nothingKnown(sys);

  const beginEdit = () => {
    const next = {};
    for (const f of SYSTEM_FIELDS) next[f.key] = clean(sys[f.key]);
    next.notes = clean(sys.notes);
    setDraft(next);
    setEditing(true);
  };

  const commit = async () => {
    setSavingSys(true);
    try {
      if (await saveSystem(systemPatch(draft))) setEditing(false);
    } finally {
      setSavingSys(false);
    }
  };

  const start = async () => {
    setStarting(true);
    // The fix is attempted before the status flip so the two land
    // together. A refused permission or a phone with no signal returns
    // null and the visit starts anyway — arrivedAt still records when.
    const fix = await currentFix();
    try {
      const recorded = await save({
        status: 'on_site',
        arrivedAt: new Date().toISOString(),
        arrivalLocation: fix,
      });
      if (!recorded) return;
      if (!fix) {
        Alert.alert(
          'Started without a location',
          "Your phone couldn't give a position. The time is recorded; the place isn't.",
        );
      }
      onNext();
    } finally {
      setStarting(false);
    }
  };

  const openMaps = () => {
    const dest = wo?.address;
    if (dest) Linking.openURL(`http://maps.apple.com/?daddr=${encodeURIComponent(dest)}`).catch(() => {});
  };

  const call = (number) => {
    const to = clean(number).replace(/[^\d+]/g, '');
    if (to) Linking.openURL(`tel:${to}`).catch(() => {});
  };

  return (
    <>
      <View style={styles.hero}>
        <Text style={styles.customer}>{wo?.customerName || 'Customer'}</Text>
        <Text style={styles.address}>{wo?.address || 'No address'}</Text>
        <Text style={styles.meta}>Fall Closing · {wo?.id}</Text>
      </View>

      {/* Above the system facts on purpose — on a condo board's site the
          first question is who opens the door, not where the valve is. */}
      {contacts.length ? (
        <Section title={contacts.length > 1 ? 'Who to meet' : 'Who to meet'}>
          {contacts.map((c, i) => (
            <View key={c.id || i} style={[styles.contact, i === contacts.length - 1 && styles.contactLast]}>
              <Text style={styles.contactName}>{c.name}</Text>
              {clean(c.role) ? <Text style={styles.contactRole}>{c.role}</Text> : null}
              {clean(c.phone) ? (
                <Pressable onPress={() => call(c.phone)} hitSlop={8}>
                  <Text style={styles.contactLink}>{c.phone}  ·  Call</Text>
                </Pressable>
              ) : null}
              {clean(c.email) ? <Text style={styles.contactSub}>{c.email}</Text> : null}
            </View>
          ))}
        </Section>
      ) : null}

      <Section
        title="On arrival"
        action={canEdit ? (
          editing ? (
            <View style={styles.headActions}>
              <Pressable onPress={() => setEditing(false)} hitSlop={8} disabled={savingSys}>
                <Text style={styles.headCancel}>Cancel</Text>
              </Pressable>
              <Pressable onPress={commit} hitSlop={8} disabled={savingSys}>
                <Text style={styles.headSave}>{savingSys ? 'Saving…' : 'Save'}</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable onPress={beginEdit} hitSlop={8}>
              <Text style={styles.headEdit}>Edit</Text>
            </Pressable>
          )
        ) : null}
        footer={editing
          ? 'Recorded on this phone first, then synced to the property.'
          : 'Corrections update the property when synced.'}
      >
        {editing ? (
          <>
            {SYSTEM_FIELDS.map((f) => (
              <View key={f.key} style={styles.editRow}>
                <Text style={styles.factLabel}>{f.label}</Text>
                <TextInput
                  style={styles.input}
                  value={draft[f.key]}
                  onChangeText={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                  placeholder={f.placeholder}
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="sentences"
                />
              </View>
            ))}
            <View style={styles.notesEdit}>
              <Text style={styles.factLabel}>Notes</Text>
              <TextInput
                style={[styles.input, styles.multiline]}
                value={draft.notes}
                onChangeText={(v) => setDraft((d) => ({ ...d, notes: v }))}
                placeholder="Gate code, dog, access — anything the next tech needs"
                placeholderTextColor={colors.textFaint}
                multiline
              />
            </View>
          </>
        ) : (
          <>
            {/* Said once, rather than four times down the column. */}
            {blank ? (
              <View style={styles.emptyRow}>
                <Text style={styles.emptyText}>
                  Nothing recorded for this property yet — whatever you put in is what the
                  next tech reads.
                </Text>
              </View>
            ) : null}
            {SYSTEM_FIELDS.map((f) => (
              <Fact
                key={f.key}
                label={f.label}
                value={sys[f.key]}
                terse={blank}
                onPress={canEdit ? beginEdit : null}
              />
            ))}
            <Fact
              label="Notes"
              value={sys.notes}
              terse={blank}
              wrap
              last
              onPress={canEdit ? beginEdit : null}
            />
          </>
        )}
      </Section>

      {started ? (
        <Section title="Started">
          <View style={styles.startedBox}>
            <Text style={styles.startedText}>{stamp(wo.arrivedAt)}</Text>
            <Text style={styles.startedSub}>
              {wo.arrivalLocation
                ? `Location recorded (±${Math.round(wo.arrivalLocation.accuracy || 0)} m)`
                : 'No location recorded'}
            </Text>
          </View>
        </Section>
      ) : null}

      {/* The button that starts the work, exactly where it was. Nothing
          above can block it — a visit is not gated on paperwork — except
          while an edit is open, so a half-typed gate code is not lost to
          a tap. */}
      <View style={styles.actions}>
        {started ? (
          <Button label="Continue to water off" onPress={onNext} disabled={editing} />
        ) : (
          <Button
            label={starting ? 'Starting…' : 'Start Service (Fall Closing)'}
            onPress={start}
            disabled={starting || saving || editing}
          />
        )}
        <Button label="Navigate" tone="ghost" onPress={openMaps} disabled={!wo?.address} />
      </View>

      {findings ? (
        <Text style={styles.note}>{findings} finding{findings === 1 ? '' : 's'} recorded so far this visit.</Text>
      ) : null}
    </>
  );
}

// `terse` is the empty-record form: the row keeps its name and offers a ＋
// instead of repeating "Not recorded" down the whole column.
function Fact({ label, value, terse, wrap, last, onPress }) {
  const shown = clean(value);
  const body = (
    <View style={[styles.fact, wrap && shown && styles.factWrap, last && styles.factLast]}>
      <Text style={styles.factLabel}>{label}</Text>
      {shown ? (
        <Text style={[styles.factValue, wrap && styles.factValueWrap]}>{shown}</Text>
      ) : (
        <Text style={[styles.factValue, styles.factMissing]}>
          {terse ? '' : 'Not recorded'}{onPress ? '  ＋' : ''}
        </Text>
      )}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${shown || 'not recorded'}. Tap to edit.`}
      style={({ pressed }) => pressed && styles.pressed}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: { paddingHorizontal: space.xs, paddingTop: space.sm, gap: 2 },
  customer: { ...type.hero },
  address: { ...type.label, lineHeight: 21 },
  meta: { ...type.caption, marginTop: 2 },

  fact: {
    flexDirection: 'row', justifyContent: 'space-between', gap: space.lg,
    paddingHorizontal: space.lg, paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  // Notes run long, so they sit under their label rather than fighting it
  // for one line.
  factWrap: { flexDirection: 'column', alignItems: 'flex-start', gap: 3 },
  factLast: { borderBottomWidth: 0 },
  factLabel: { ...type.label, flexShrink: 0 },
  factValue: { ...type.body, flex: 1, textAlign: 'right' },
  factValueWrap: { textAlign: 'left', lineHeight: 21 },
  factMissing: { color: colors.textFaint },
  pressed: { backgroundColor: colors.ground },

  emptyRow: {
    paddingHorizontal: space.lg, paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  emptyText: { ...type.caption, lineHeight: 19 },

  headActions: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  headEdit: { ...type.body, color: colors.brand, fontWeight: '600' },
  headCancel: { ...type.body, color: colors.textMuted },
  headSave: { ...type.body, color: colors.brand, fontWeight: '700' },

  editRow: {
    paddingHorizontal: space.lg, paddingVertical: 11, gap: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  notesEdit: { paddingHorizontal: space.lg, paddingVertical: 11, gap: space.xs },
  input: {
    ...type.body, backgroundColor: colors.ground, borderRadius: radius.card,
    paddingHorizontal: space.md, paddingVertical: space.sm, minHeight: 44,
  },
  multiline: { minHeight: 76, textAlignVertical: 'top' },

  contact: {
    paddingHorizontal: space.lg, paddingVertical: 13, gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator,
  },
  contactLast: { borderBottomWidth: 0 },
  contactName: { ...type.body, fontWeight: '600' },
  contactRole: { ...type.section, color: colors.brand },
  contactLink: { ...type.body, color: colors.brand, fontWeight: '600', marginTop: 2 },
  contactSub: { ...type.caption },

  startedBox: { padding: space.lg, gap: 3 },
  startedText: { ...type.title },
  startedSub: { ...type.caption },
  actions: { gap: space.sm },
  note: { ...type.caption, textAlign: 'center' },
});
