// One place for the visual language, so the native screens and anything
// added later stay consistent. Deliberately close to iOS's own grouped-
// list look (Settings, Contacts): a grey ground, white cards, hairline
// separators, muted uppercase section headers. A field app that looks
// like the phone it runs on needs no explaining.

export const colors = {
  brand: '#1B4D2E',        // the green already used by tech mode's header
  brandTint: '#E8F0EA',
  ground: '#F2F2F7',       // iOS grouped-table background
  card: '#FFFFFF',
  separator: '#E3E3E8',
  text: '#11181C',
  textMuted: '#6B7280',
  textFaint: '#9CA3AF',
  danger: '#B3261E',
  warning: '#9A6700',
  warningTint: '#FFF6E0',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { card: 12, pill: 999 };

export const type = {
  hero: { fontSize: 24, fontWeight: '700', color: colors.text },
  title: { fontSize: 17, fontWeight: '600', color: colors.text },
  body: { fontSize: 16, color: colors.text },
  label: { fontSize: 15, color: colors.textMuted },
  section: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  caption: { fontSize: 13, color: colors.textFaint },
};
