# CLAUDE.md

Before changing backend code, read docs/FLOW_REGISTER.md. Do not modify a flow marked PASS without re-verifying it.

## Lifecycle states: finish the workflow, not the write

A record's state is not done when the record flips. It is done when every
reader agrees. Before adding or changing a state — cancelled, completed,
void, archived, no_show, standby, protected — walk this:

1. **Find every reader.** Grep the field. A state meaning "this no longer
   counts" has to be honoured by all of them, not just the one you are in.
2. **Define the rule once**, as a named function, and call it from each
   reader. Two copies of a state test will drift. A cancelled appointment
   held its calendar slot for exactly this reason: `activeBookings()`
   tested the status in its canonical pass and not in its lead-snapshot
   pass, so every cancellation leaked a slot while looking successful
   (2026-09-08, `bookingHoldsItsSlot`).
3. **Walk the whole workflow, not the write.** For each state change ask:
   what does the customer see, what does Patrick receive, what happens to
   capacity/the calendar, what cascades to linked records (work order,
   invoice, property, season plan), and what does the audit trail keep?
   Name the ones you deliberately leave alone — silence is how a half-built
   transition ships.
4. **Pin it with a test that fails on the OLD code.** Run it against the
   unfixed version first. If it passes before the fix, it is not testing
   the fix.

`scripts/test-booking-lifecycle.mjs` is the worked example: it asserts a
dead booking frees its slot through BOTH passes, and that the two passes
can never answer differently for the same state.
