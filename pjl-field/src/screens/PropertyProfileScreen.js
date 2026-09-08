// The property, shaped like a phone contact rather than a CRM record.
//
// Order is driven by what matters standing in a driveway, not by the
// shape of properties.json: where the controller and shutoff are first,
// then what's still outstanding on the site, then history. The admin
// page can stay organised for a desk; this one is organised for a truck.

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  AuthRequiredError,
  getProperty,
  invoicePaymentLink,
  isOverdue,
  listPropertyInvoices,
  listPropertyWorkOrders,
} from '../api';
import { absolute, avatarLetter, money, shortDate, telHref, zoneMeta, zoneName } from '../format';
import { colors, radius, space, type } from '../theme';
import { ActionButton, Card, NoteRow, Pill, Row, SectionHeader } from '../ui';
import { isOpenWorkOrder } from '../workorder-routing';

// deferredIssues statuses that still want a tech's attention. resolved
// and dismissed are done; everything else is live work.
const LIVE_ISSUE_STATUSES = new Set(['open', 'pre_authorized', 'in_progress', 're_deferred']);

// The server's real invoice statuses. There is no `overdue` among them —
// see isOverdue() in api.js for why that is derived rather than stored.
const INVOICE_STATUS_LABELS = {
  draft: 'Draft',
  sent: 'Sent',
  partially_paid: 'Part paid',
  paid: 'Paid',
  void: 'Void',
};

const WO_STATUS_LABELS = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  on_site: 'On site',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

// Which invoice the "text a link" button acts on. NAMED on the button
// rather than left to guess: an address with three unpaid invoices and
// an unlabelled button is a way to send someone the wrong balance.
// Oldest first, because that is the one that has been waiting.
export function invoiceToChase(invoices) {
  const owing = (invoices || []).filter(
    (i) => i && i.status !== 'void' && i.status !== 'paid' && Number(i.balanceDue) > 0,
  );
  if (!owing.length) return null;
  return owing.reduce((oldest, i) => {
    const a = new Date(i.createdAt || 0).getTime();
    const b = new Date(oldest.createdAt || 0).getTime();
    return Number.isFinite(a) && a < b ? i : oldest;
  });
}


export default function PropertyProfileScreen({ propertyId, onBack, onOpenWorkOrder, onOpenInvoice }) {
  const [property, setProperty] = useState(null);
  // Both loaded beside the property rather than inside it: the property
  // record carries neither, and the two departing tabs are what these
  // sections replace.
  const [workOrders, setWorkOrders] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [linking, setLinking] = useState(false);
  const [state, setState] = useState('loading'); // loading | ready | auth | error
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const p = await getProperty(propertyId);
      setProperty(p);
      setState('ready');
      // After the property, and never blocking it. A property that
      // renders without its paperwork is useful; one that refuses to
      // render because the invoice list 500'd is not.
      listPropertyWorkOrders(propertyId).then(setWorkOrders).catch(() => setWorkOrders([]));
      listPropertyInvoices(propertyId).then(setInvoices).catch(() => setInvoices([]));
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

  // Mint the link, then hand the message to Apple's Messages app with it
  // already written. Two reasons it is a handoff rather than a send:
  // the server's payment-link route MINTS a url and sends nothing, and a
  // text that leaves from your own number is a text the customer can
  // reply to. You see it before it goes.
  const chase = invoiceToChase(invoices);
  const textPaymentLink = async () => {
    if (!chase) return;
    setLinking(true);
    try {
      const url = await invoicePaymentLink(chase.id);
      if (!url) throw new Error('No payment link came back.');
      const body = `Here's the payment link for ${chase.id}`
        + `${chase.balanceDue != null ? ` (${money(chase.balanceDue, chase.currency)})` : ''}`
        + `: ${url}`;
      const to = String(phone || '').replace(/[^\d+]/g, '');
      // `&body=` after a number, `?body=` without one — iOS ignores the
      // text entirely if the separator is wrong, which looks like the
      // link silently not attaching.
      await open(to ? `sms:${to}&body=${encodeURIComponent(body)}` : `sms:&body=${encodeURIComponent(body)}`);
    } catch (err) {
      Alert.alert(
        "Couldn't get a payment link",
        err?.message || 'Open the invoice and send it by email instead.',
      );
    } finally {
      setLinking(false);
    }
  };

  const systemKnown = sys.controllerBrand || sys.controllerLocation || sys.shutoffLocation ||
    sys.blowoutLocation || zoneCount;

  // zones.length is the walked-the-property record; zoneCount alone is
  // what a customer told us over the phone, so it gets labelled as such.
  const zoneText = zoneCount ? (zones.length ? String(zoneCount) : `${zoneCount} (declared)`) : '';

  const sysRow = (label, value, extra) => (
    <Row
      label={label}
      value={value || 'Not recorded'}
      valueStyle={value ? undefined : styles.missing}
      {...extra}
    />
  );

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
              {avatarLetter(p)}
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
      {/* Every row, every time, in the same order — even when empty.
          Rendering only the fields that had data made this card a
          different shape at every property: 25 Billinger opened on
          "Location", the next site opened on "Blowout", and there was
          nothing for the eye to learn. On a phone in a driveway,
          predictable beats compact.

          The gaps are worth showing too. "Shutoff — Not recorded" tells
          whoever is standing there that nobody has ever written it down,
          which is a job to do rather than a blank to scroll past. */}
      <Card>
        {sysRow('Controller', sys.controllerBrand)}
        {sysRow('Location', sys.controllerLocation)}
        {sysRow('Shutoff', sys.shutoffLocation)}
        {sysRow('Blowout', sys.blowoutLocation)}
        {sysRow('Zones', zoneText, { last: !sys.notes })}
        {sys.notes ? <NoteRow label="Notes" last>{sys.notes}</NoteRow> : null}
      </Card>
      {!systemKnown ? (
        <Text style={styles.cardHint}>
          Nothing recorded for this site yet — worth filling in from the CRM next time you're here.
        </Text>
      ) : null}

      {zones.length ? (
        <>
          <SectionHeader>Zones ({zones.length})</SectionHeader>
          <Card>
            {zones.map((z, i) => {
              const name = zoneName(z);
              const meta = zoneMeta(z);
              return (
                <View
                  key={z.number ?? i}
                  style={[styles.zone, i === zones.length - 1 && styles.zoneLast]}
                >
                  <View style={styles.zoneTop}>
                    <Text style={styles.zoneNum}>Zone {z.number ?? i + 1}</Text>
                    <Text style={[styles.zoneName, !name && styles.missing]} numberOfLines={2}>
                      {name || 'Not named'}
                    </Text>
                  </View>
                  {meta ? <Text style={styles.zoneMeta}>{meta}</Text> : null}
                </View>
              );
            })}
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

      {invoices.length ? (
        <>
          <SectionHeader>Invoices</SectionHeader>
          <Card>
            {invoices.slice(0, 8).map((inv, i, arr) => {
              const overdue = isOverdue(inv);
              const tone = overdue ? 'danger' : inv.status === 'paid' ? 'brand' : 'neutral';
              const label = overdue ? 'Overdue' : (INVOICE_STATUS_LABELS[inv.status] || inv.status);
              return (
                <Row
                  key={inv.id}
                  label={[inv.id, shortDate(inv.createdAt)].filter(Boolean).join(' · ')}
                  right={
                    <>
                      <Text style={styles.amount}>
                        {money(inv.balanceDue > 0 ? inv.balanceDue : inv.total, inv.currency)}
                      </Text>
                      <Pill tone={tone}>{label}</Pill>
                    </>
                  }
                  onPress={onOpenInvoice ? () => onOpenInvoice(inv.id) : undefined}
                  last={i === arr.length - 1}
                />
              );
            })}
          </Card>
          {chase ? (
            <Pressable
              onPress={textPaymentLink}
              disabled={linking}
              style={({ pressed }) => [styles.payBtn, (pressed || linking) && styles.payBtnPressed]}
              accessibilityRole="button"
            >
              <Text style={styles.payBtnText}>
                {linking ? 'Getting the link…' : `Text a payment link — ${chase.id}`}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {workOrders.length ? (
        <>
          <SectionHeader>Work orders</SectionHeader>
          <Card>
            {workOrders.slice(0, 10).map((wo, i, arr) => (
              <Row
                key={wo.id}
                label={[wo.type ? wo.type.replace(/_/g, ' ') : 'Visit', shortDate(wo.completedAt || wo.scheduledFor)]
                  .filter(Boolean).join(' · ')}
                right={
                  <Pill tone={isOpenWorkOrder(wo) ? 'warn' : 'neutral'}>
                    {WO_STATUS_LABELS[wo.status] || wo.status}
                  </Pill>
                }
                onPress={onOpenWorkOrder ? () => onOpenWorkOrder(wo) : undefined}
                last={i === arr.length - 1}
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
  // Tabular figures so a column of balances lines up on the decimal.
  amount: { ...type.body, fontVariant: ['tabular-nums'] },
  payBtn: {
    backgroundColor: colors.brand,
    borderRadius: radius.card,
    marginHorizontal: space.md,
    marginTop: space.sm,
    paddingVertical: 14,
    alignItems: 'center',
  },
  payBtnPressed: { opacity: 0.7 },
  payBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  missing: { color: colors.textFaint },
  zone: {
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
    gap: 3,
  },
  zoneLast: { borderBottomWidth: 0 },
  zoneTop: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  zoneNum: { ...type.label, width: 60, flexShrink: 0, fontVariant: ['tabular-nums'] },
  zoneName: { ...type.body, flex: 1 },
  zoneMeta: { ...type.caption, paddingLeft: 60 + space.md },
  cardHint: { ...type.caption, marginTop: space.sm, marginHorizontal: space.lg },
  photoStrip: { paddingHorizontal: space.md, gap: space.sm },
  photo: { width: 132, height: 132, borderRadius: radius.card, backgroundColor: colors.separator },
  more: { ...type.caption, marginTop: space.sm, marginHorizontal: space.lg },
  footerSpace: { height: space.xl },
});
