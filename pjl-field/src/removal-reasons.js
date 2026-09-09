// Why a visit came off the day.
//
// Patrick: "Customer calls throughout the day (or we go to house and
// already completed) we need a way on that Daily booking system to be able
// to 'Remove visit' ... but record it somewhere."
//
// Recording it is the feature. Dropping the stop is already automatic — a
// booking that stops holding its slot leaves the day AND the route with no
// resequencing code at all — so all this list has to get right is the
// difference between the five things that actually happen. Six months on,
// "they rang and cancelled" and "nobody was home" are not the same event,
// and only one of them is chargeable.
//
// THIS IS A MIRROR of REMOVAL_REASONS in server/lib/bookings.js. The
// server chooses the outcome from the code and never trusts one sent to
// it; this list exists so the phone can draw the sheet without asking.
// scripts/test-remove-visit.mjs asserts the two agree, because two lists
// of the same thing in two files is exactly how a button starts sending a
// code the server refuses.

export const REMOVAL_REASONS = [
  {
    code: 'customer_cancelled',
    label: 'Customer cancelled',
    hint: 'They rang — frees the slot',
  },
  {
    code: 'already_done',
    label: 'Already done',
    hint: 'Closed by someone else, or last week',
    // The one reason that means something went wrong upstream — a double
    // booking, or a job closed without the calendar being told. Patrick
    // asked to be prompted so the cause is findable later.
    asksWhy: true,
    whyPrompt: 'What happened?',
    whyPlaceholder: 'e.g. we closed it last Thursday — booked twice',
  },
  {
    code: 'no_answer',
    label: 'Nobody home',
    hint: 'Recorded as a no-show',
  },
  {
    code: 'no_access',
    label: "Couldn't get access",
    hint: 'Gate, dog, car on the valve',
  },
  {
    code: 'weather',
    label: 'Weather',
    hint: 'Called off for the day',
  },
];

export function reasonByCode(code) {
  return REMOVAL_REASONS.find((r) => r.code === code) || null;
}

// What the removed row says it was, once it is done. Falls back to the
// stored free text: an older removal made from the CRM carries no code.
export function removalLabel(row) {
  return reasonByCode(row?.removalCode)?.label || row?.reason || 'Removed';
}

// "Removed 8:41 AM by Patrick" — the line under a struck-through stop.
// Who did it matters as much as why: on a two-truck day the question is
// always which of us took it off.
export function removalNote(row) {
  const when = row?.removedAt ? new Date(row.removedAt) : null;
  const time = when && !Number.isNaN(when.getTime())
    ? when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : null;
  return [
    time ? `Removed ${time}` : 'Removed',
    row?.removedBy ? `by ${row.removedBy}` : '',
    row?.status === 'no_show' ? 'no-show' : '',
  ].filter(Boolean).join(' · ');
}
