// How a row on Today's schedule reaches a work order.
//
// There are two kinds of row and they need different routes:
//
//   A LEAD BOOKING (public booking flow) has a leadId, and the server's
//   /api/leads/:id/open-wo returns its work order, creating one if the
//   lead has none.
//
//   An ASSIGNMENT BOOKING — written from a season plan, which is how a
//   management company's route days get scheduled — has NO lead at all.
//   Its leadId comes back as "". Putting that in the path produces
//   /api/leads//open-wo, which matches no route and 404s as "API endpoint
//   not found". That is the bug this module exists to prevent: those rows
//   go through the PROPERTY instead, the same POST /api/work-orders the
//   CRM's own property page uses.
//
// Kept out of the screen so it can be tested without React Native.
// Covered by scripts/test-wo-routing.mjs.

// A row's stable identity: leadId when there is a lead, else the
// canonical booking id. Used for the list key and for tracking which row
// is mid-request — two rows must never share one.
export const rowKey = (b) => b?.leadId || b?.bookingId || b?.workOrder?.id || b?.start || '';

// Which work-order template a booked service becomes. Mirrors
// templateForServiceKey() in server/lib/work-orders.js — the prefixes are
// BOOKABLE_SERVICES keys (fall_close_8z, fall_close_commercial_9plus,
// spring_open_4z...). Anything else is a one-off visit, which is the same
// safe default the server picks.
export const templateForServiceKey = (serviceKey) => {
  const key = String(serviceKey || '');
  if (key.startsWith('spring_open_')) return 'spring_opening';
  if (key.startsWith('fall_close_')) return 'fall_closing';
  return 'service_visit';
};

// A work order that still represents unfinished work.
const TERMINAL = ['completed', 'cancelled', 'no_show'];
export const isOpenWorkOrder = (wo) => !!wo && !TERMINAL.includes(wo.status);

// Can this row produce a work order at all? It needs somewhere to hang
// one: an existing work order, a lead, or a property.
export const canStartWorkOrder = (b) => !!(b?.workOrder || b?.leadId || b?.propertyId);

// The route to take, as a plain value the screen acts on. Separated from
// the fetching so the decision is testable on its own.
//
//   { action: 'open',      workOrder }  — already have it, just open it
//   { action: 'lead',      leadId }     — POST /api/leads/:id/open-wo
//   { action: 'property',  propertyId, type } — look, then create
//   { action: 'none' }                  — nothing to hang a WO on
export function routeForRow(b) {
  if (b?.workOrder) return { action: 'open', workOrder: b.workOrder };
  if (b?.leadId) return { action: 'lead', leadId: b.leadId };
  if (b?.propertyId) {
    return { action: 'property', propertyId: b.propertyId, type: templateForServiceKey(b.serviceKey) };
  }
  return { action: 'none' };
}

// Given every work order already on the property, which one should open?
// Undefined means none fits and a new one must be created.
//
// This is the guard against duplicates: POST /api/work-orders has no
// upsert, so without it a second tap raises a second work order for the
// same visit — two documents, two invoices, one lawn.
export function existingWorkOrderFor(workOrders, type) {
  return (workOrders || []).find((wo) => wo && wo.type === type && isOpenWorkOrder(wo));
}
