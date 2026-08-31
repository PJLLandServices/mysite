// The winterization ticks, in their own module so the container and the
// close-out stage can both read them without importing each other.
//
// Mirrors SERVICE_CHECKLISTS.fall_closing in server/lib/work-orders.js.
// Back flush is deliberately absent: it is a yes/no answer stored as
// `backFlush` on the work order, because an unticked box reads as "not
// done yet" and cannot say "this property hasn't got one".
export const CLOSEOUT_STEPS = [
  { key: 'controller_off', label: 'Controller set to off / winter mode' },
  { key: 'water_off', label: 'Water shut off at main' },
  { key: 'compressor_disconnected', label: 'Compressor disconnected' },
  { key: 'system_winterized', label: 'System winterized' },
];
