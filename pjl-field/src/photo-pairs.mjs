// Which photo a marked-up photo belongs to, for the screens (PJL-112): each
// original with its newest markup, in the order taken. A markup whose
// original is not in the list stands on its own. The thumbnails show the
// markup in the original's place, as the customer's report does.
import { isMarkupOf, linkOf, photoRef } from './offline/queue.mjs';

export function pairPhotos(photos) {
  const list = photos || [];
  const tiles = [];
  for (const p of list) {
    if (linkOf(p) && list.some((o) => o !== p && isMarkupOf(p, photoRef(o)))) continue;
    const marks = list.filter((m) => m !== p && isMarkupOf(m, photoRef(p)));
    tiles.push({ original: p, markup: marks.length ? marks[marks.length - 1] : null });
  }
  return tiles;
}
