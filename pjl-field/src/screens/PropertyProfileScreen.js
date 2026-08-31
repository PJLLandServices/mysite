// The property, shaped like a phone contact rather than a CRM record.
//
// Order is driven by what matters standing in a driveway, not by the
// shape of properties.json: where the controller and shutoff are first,
// then what's still outstanding on the site, then history. The admin
// page can stay organised for a desk; this one is organised for a truck.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AuthRequiredError, getProperty, HOST } from '../api';
import { colors, radius, space, type } from '../theme';
import { ActionButton, Card, Empty, NoteRow, Pill, Row, SectionHeader } from '../ui';

// deferredIssues statuses that still want a tech's attention. resolved
// and dismissed are done; everything else is live work.
const LIVE_ISSUE_STATUSES = new Set(['open', 'pre_authorized', 'in_progress', 're_deferred']);

const money = (n) =>
  typeof n === 'number' && Number.isFinite(n)
    ? `$${n.toFixed(2)}`
    : null;

const shortDate = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const absolute = (url) => (url && url.startsWith('/') ? `${HOST}${url}` : url);

const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, '')}`;

export default function PropertyProfileScreen({ propertyId, onBack }) {
  const [property, setProperty] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | auth | error
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await getProperty(propertyId);
      setProperty(p);
      setState('ready');
    } catch (err) {
      if (err instanceof AuthRequiredError) setState('auth');
      else { setError(err?.message || 'Could not load this property.'); setState('error'); }
    }
  }, [propertyId]);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  if (state === 'loading') {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }
  if (state === 'auth') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Not signed in</Text>
        <Text style={styles.centreBody}>Open the Today tab and sign in — this screen shares that session.</Text>
      </View>
    );
  }
  if (state === 'error') {
    return (
      <View style={styles.centre}>
        <Text style={styles.centreTitle}>Couldn't load</Text>
        <Text style={styles.centreBody}>{error}</Text>
        <Pressable onPress={load} style={styles.retry}><Text style={styles.retryText}>Try again</Text></Pressable>
      </View>
    );
  }

  const p = property || {};
  const sys = p.system || {};
  const zones = Array.isArray(sys.zones) ? sys.zones : [];
  const valveBoxes = Array.isArray(sys.valveBoxes) ? sys.valveBoxes : [];
  const photos = (Array.isArray(p.photos) ? p.photos : []).filter((ph) => ph && ph.url);
  const contacts = Array.isArray(p.siteContacts) ? p.siteContacts : [];
  const openIssues = (Array.isArray(p.deferredIssues) ? p.deferredIssues : [])
    .filter((i) => i && LIVE_ISSUE_STATUSES.has(i.status));
  const visits = (Array.isArray(p.serviceRecords) ? p.serviceRecords : [])
    .slice()
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));

  // zones.length is the walked-the-property record and beats the
  // customer-told-us number, exactly as lib/properties.js documents.
  const zoneCount = zones.length || sys.zoneCount || null;
  const phone = p.customerPhone || (contacts.find((c) => c.phone) || {}).phone || '';
  const email = p.customerEmail || (contacts.find((c) => c.email) || {}).email || '';
  const hero = photos[0];

  const open = (url) => Linking.openURL(url).catch(() => {});
  const navigate = () => {
    const dest = p.coords && p.coords.lat != null
      ? `${p.coords.lat},${p.coords.lng}`
      : p.address || '';
    if (dest) open(`http://maps.apple.com/?daddr=${encodeURIComponent(dest)}`);
  };

  const systemKnown = sys.controllerBrand || sys.controllerLocation || sys.shutoffLocation ||
    sys.blowoutLocation || zoneCount;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.brand} />}
    >
      {onBack ? (
        <Pressable onPress={onBack} style={styles.back} hitSlop={12}>
          <Text style={styles.backText}>‹ Properties</Text>
        </Pressable>
      ) : null}

      <View style={styles.hero}>
        {hero ? (
          <Image source={{ uri: absolute(hero.url) }} style={styles.heroImage} resizeMode="cover" />
        ) : (
          <View style={[styles.heroImage, styles.heroFallback]}>
            <Text style={styles.heroFallbackText}>
              {(p.address || '?').trim().charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <Text style={styles.heroTitle}>{p.address || 'Address not set'}</Text>
        <Text style={styles.heroSub}>
          {[p.customerName, p.code].filter(Boolean).join(' · ') || '—'}
        </Text>
        {p.billingEntity ? <View style={styles.heroPill}><Pill tone="brand">{p.billingEntity}</Pill></View> : null}
      </View>

      <View style={styles.actions}>
        <ActionButton glyph="➤" label="Navigate" onPress={navigate} disabled={!p.address && !p.coords} />
        <ActionButton glyph="✆" label="Call" onPress={() => open(telHref(phone))} disabled={!phone} />
        <ActionButton glyph="✉" label="Text" onPress={() => open(`sms:${phone}`)} disabled={!phone} />
        <ActionButton glyph="@" label="Email" onPress={() => open(`mailto:${email}`)} disabled={!email} />
      </View>

      <SectionHeader>The system</SectionHeader>
      <Card>
        {systemKnown ? (
          <>
            {sys.controllerBrand ? <Row label="Controller" value={sys.controllerBrand} /> : null}
            {sys.controllerLocation ? <Row label="Located" value={sys.controllerLocation} /> : null}
            {sys.shutoffLocation ? <Row label="Shutoff" value={sys.shutoffLocation} /> : null}
            {sys.blowoutLocation ? <Row label="Blowout" value={sys.blowoutLocation} /> : null}
            {zoneCount ? (
              <Row
                label="Zones"
                value={zones.length ? `${zoneCount}` : `${zoneCount} (declared)`}
                last={!sys.notes}
              />
            ) : null}
            {sys.notes ? <NoteRow label="Notes" last>{sys.notes}</NoteRow> : null}
          </>
        ) : (
          <Empty>Nothing recorded yet. Whoever walks this site next can fill it in from the CRM.</Empty>
        )}
      </Card>

      {zones.length ? (
        <>
          <SectionHeader>Zones</SectionHeader>
          <Card>
            {zones.map((z, i) => (
              <Row
                key={z.number ?? i}
                label={`Zone ${z.number ?? i + 1}`}
                value={[z.label, z.notes].filter(Boolean).join(' — ') || '—'}
                last={i === zones.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      {valveBoxes.length ? (
        <>
          <SectionHeader>Valve boxes</SectionHeader>
          <Card>
            {valveBoxes.map((v, i) => (
              <Row
                key={v.id || i}
                label={v.location || `Box ${i + 1}`}
                value={[v.valveCount ? `${v.valveCount} valves` : null, v.notes].filter(Boolean).join(' · ') || '—'}
                last={i === valveBoxes.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      {openIssues.length ? (
        <>
          <SectionHeader>Outstanding ({openIssues.length})</SectionHeader>
          <Card>
            {openIssues.map((issue, i) => (
              <View key={issue.id || i} style={[styles.issue, i === openIssues.length - 1 && styles.issueLast]}>
                <View style={styles.issueTop}>
                  <Text style={styles.issueTitle}>{issue.type || 'Deferred item'}</Text>
                  {issue.severity === 'emergency' ? <Pill tone="danger">Emergency</Pill> : null}
                  {issue.status === 'pre_authorized' ? <Pill tone="brand">Pre-authorised</Pill> : null}
                  {issue.reDeferralCount >= 3 ? <Pill tone="warn">Deferred {issue.reDeferralCount}×</Pill> : null}
                </View>
                {issue.notes ? <Text style={styles.issueNotes}>{issue.notes}</Text> : null}
                <Text style={styles.issueMeta}>
                  {[
                    issue.fromZone ? `Zone ${issue.fromZone}` : null,
                    issue.qty ? `Qty ${issue.qty}` : null,
                    shortDate(issue.declinedAt) ? `Since ${shortDate(issue.declinedAt)}` : null,
                  ].filter(Boolean).join(' · ')}
                </Text>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {contacts.length ? (
        <>
          <SectionHeader>Site contacts</SectionHeader>
          <Card>
            {contacts.map((c, i) => (
              <Row
                key={c.id || i}
                label={[c.name, c.role].filter(Boolean).join(' · ') || 'Contact'}
                value={c.phone || c.email || '—'}
                onPress={c.phone ? () => open(telHref(c.phone)) : undefined}
                valueStyle={c.phone ? styles.link : undefined}
                last={i === contacts.length - 1}
              />
            ))}
          </Card>
        </>
      ) : null}

      {visits.length ? (
        <>
          <SectionHeader>Service history</SectionHeader>
          <Card>
            {visits.slice(0, 12).map((v, i, arr) => (
              <Row
                key={v.id || v.woId || i}
                label={shortDate(v.completedAt) || 'Visit'}
                value={[v.summary || v.woType, money(v.total)].filter(Boolean).join(' · ')}
                last={i === arr.length - 1}
              />
            ))}
          </Card>
          {visits.length > 12 ? (
            <Text style={styles.more}>Showing the 12 most recent of {visits.length}.</Text>
          ) : null}
        </>
      ) : null}

      {photos.length ? (
        <>
          <SectionHeader>Photos</SectionHeader>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.photoStrip}>
            {photos.map((ph) => (
              <Image key={ph.id || ph.url} source={{ uri: absolute(ph.url) }} style={styles.photo} resizeMode="cover" />
            ))}
          </ScrollView>
        </>
      ) : null}

      <View style={styles.footerSpace} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  content: { paddingBottom: space.xl },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, backgroundColor: colors.ground },
  centreTitle: { ...type.title, marginBottom: space.sm },
  centreBody: { ...type.label, textAlign: 'center', lineHeight: 21 },
  retry: {
    marginTop: space.lg,
    backgroundColor: colors.brand,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.card,
  },
  retryText: { color: '#fff', fontWeight: '600' },
  back: { paddingHorizontal: space.lg, paddingTop: space.md },
  backText: { color: colors.brand, fontSize: 17 },
  hero: { alignItems: 'center', paddingTop: space.lg, paddingHorizontal: space.xl },
  heroImage: { width: 96, height: 96, borderRadius: radius.pill, marginBottom: space.md },
  heroFallback: { backgroundColor: colors.brand, alignItems: 'center', justifyContent: 'center' },
  heroFallbackText: { color: '#fff', fontSize: 36, fontWeight: '700' },
  heroTitle: { ...type.hero, textAlign: 'center' },
  heroSub: { ...type.label, marginTop: space.xs, textAlign: 'center' },
  heroPill: { marginTop: space.sm },
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.md,
    paddingVertical: space.lg,
  },
  issue: {
    paddingHorizontal: space.lg,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    gap: 6,
  },
  issueLast: { borderBottomWidth: 0 },
  issueTop: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  issueTitle: { ...type.title },
  issueNotes: { ...type.body, lineHeight: 21 },
  issueMeta: { ...type.caption },
  link: { color: colors.brand },
  photoStrip: { paddingHorizontal: space.md, gap: space.sm },
  photo: { width: 132, height: 132, borderRadius: radius.card, backgroundColor: colors.separator },
  more: { ...type.caption, marginTop: space.sm, marginHorizontal: space.lg },
  footerSpace: { height: space.xl },
});
