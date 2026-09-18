// Reminder sweep for the Klarna capture deadline (PJL-34, build order
// step 5). Finds every "authorized" quote whose financing.captureBy is
// inside the 14/7/3/1-day thresholds, or — once inside the final 24
// hours — hasn't had today's reminder yet, and pages Patrick (never a
// customer) via email + SMS.
//
// Mirrors lib/booking-reminders.js's shape: dependency-injected I/O so
// the test file swaps in fakes, mark-BEFORE-send so a crash mid-dispatch
// can't double-send on the next tick, and a consistent { due, sent,
// skipped, errors } result the caller logs from.
//
// No automatic capture — TRD §8, Patrick's decision. This sweep's whole
// job is making the deadline impossible to miss, nothing more.

const quotes = require("./quotes");
const klarna = require("./klarna");
const notifyFinancing = require("./notify-financing");
const notifySmsLib = require("./notify-sms");
const { resolvePublicBaseUrl } = require("./public-base-url");

const THRESHOLDS = [14, 7, 3, 1];

function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Every reminder label a quote is due for THIS pass, given what it's
// already had (fin.remindersSent) and how many days are left. A quote
// that hasn't been swept in a while can cross more than one threshold in
// a single pass — every one of them is due, none silently skipped.
function dueLabelsFor(fin, now) {
  const daysLeft = klarna.daysUntil(fin.captureBy, now);
  if (daysLeft == null) return [];
  const sent = Array.isArray(fin.remindersSent) ? fin.remindersSent : [];
  if (daysLeft < 1) {
    const finalLabel = `final-${localDateKey(now)}`;
    return sent.includes(finalLabel) ? [] : [finalLabel];
  }
  const labels = [];
  for (const t of THRESHOLDS) {
    const label = `${t}d`;
    if (daysLeft <= t && !sent.includes(label)) labels.push(label);
  }
  return labels;
}

function thresholdText(label) {
  if (label.startsWith("final-")) return "inside 24 hours";
  const n = label.replace("d", "");
  return `${n} day${n === "1" ? "" : "s"} left`;
}

async function sweepCaptureDeadlines({
  now = new Date(),
  listQuotes = quotes.list,
  markReminderSent = quotes.updateFinancingLifecycle,
  notifyEmail = notifyFinancing.sendCaptureDeadlineDigest,
  notifySms = notifySmsLib.sendFinancingReminderSms,
  baseUrl = resolvePublicBaseUrl()
} = {}) {
  const result = { due: 0, sent: 0, skipped: [], errors: [] };
  const all = await listQuotes();
  const authorized = all.filter((q) => q.financing?.stage === "authorized" && q.financing?.captureBy);

  // Same invoice join listPendingFinancing uses, so the digest's links
  // land on whichever page actually has the Capture/Void buttons.
  const invoiceIdByQuote = new Map();
  if (authorized.length) {
    try {
      const invoicesLib = require("./invoices");
      for (const inv of await invoicesLib.list()) {
        if (inv.quoteId && !invoiceIdByQuote.has(inv.quoteId)) invoiceIdByQuote.set(inv.quoteId, inv.id);
      }
    } catch { /* digest still works without invoice links */ }
  }

  const dueRows = [];
  for (const q of authorized) {
    const fin = q.financing;
    const labels = dueLabelsFor(fin, now);
    if (!labels.length) continue;
    result.due += 1;

    const nextSent = [...(Array.isArray(fin.remindersSent) ? fin.remindersSent : []), ...labels];
    try {
      // Mark FIRST — a crash mid-dispatch must never cause a double-send
      // on the next tick, same discipline as booking-reminders.js.
      await markReminderSent(q.id, { remindersSent: nextSent }, { by: "system", note: `Capture reminder sent (${labels.join(", ")})` });
      dueRows.push({
        id: q.id,
        quoteNumberDisplay: q.quoteNumberDisplay || q.id,
        customerName: q.customerName || "",
        invoiceId: invoiceIdByQuote.get(q.id) || null,
        financedTotal: fin.financedAmount?.total,
        captureBy: fin.captureBy,
        daysLeft: klarna.daysUntil(fin.captureBy, now),
        thresholdLabel: thresholdText(labels[labels.length - 1]),
        base: baseUrl
      });
    } catch (err) {
      result.errors.push({ quoteId: q.id, error: err?.message || String(err) });
    }
  }

  if (!dueRows.length) return result;

  try {
    const emailResult = await notifyEmail(dueRows);
    if (emailResult?.ok === false && !emailResult.skipped) {
      result.errors.push({ quoteId: null, error: `digest email failed: ${emailResult.error || "unknown"}` });
    }
  } catch (err) {
    result.errors.push({ quoteId: null, error: `digest email threw: ${err?.message}` });
  }

  try {
    const smsBody = dueRows.length === 1
      ? `PJL: ${dueRows[0].quoteNumberDisplay} Klarna hold needs capturing — ${dueRows[0].thresholdLabel}. ${dueRows[0].base}/admin/pending-financing`
      : `PJL: ${dueRows.length} Klarna holds need capturing soon. ${dueRows[0].base}/admin/pending-financing`;
    const smsResult = await notifySms(smsBody);
    if (smsResult?.ok === false && !smsResult.skipped) {
      result.errors.push({ quoteId: null, error: `digest sms failed: ${smsResult.error || "unknown"}` });
    }
  } catch (err) {
    result.errors.push({ quoteId: null, error: `digest sms threw: ${err?.message}` });
  }

  result.sent = dueRows.length;
  return result;
}

module.exports = { sweepCaptureDeadlines, dueLabelsFor, THRESHOLDS };
