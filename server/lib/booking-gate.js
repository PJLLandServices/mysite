// The booking gate — who the PUBLIC booking flow will take.
//
// Patrick, piloting before the Sept 10 blast: "a massive issue that
// might insinuate a ton of potential spam... only full address
// selections can be approved to move forward... we need to put a lock
// on who can book — it needs to be within our service areas."
//
// Two rules, enforced SERVER-SIDE (a spammer does not use the pretty
// autocomplete):
//
//   1. FULL ADDRESSES ONLY. The address must geocode to street level —
//      a street number or a premise. "Toronto", "L3X", "asdf" all
//      geocode to *something* (a town centre, nothing) and none of them
//      is a bookable property.
//   2. INSIDE THE SERVICE AREA. Within MAX_DRIVE_MINUTES of the
//      Newmarket base — the same 90-minute outer tier the public
//      coverage checker calls "confirmed coverage" (coverage-checker.js
//      TIER_EXTENDED). Past that, the answer is the phone, exactly what
//      the coverage page already tells people.
//
// One deliberate exception: WHEN THE FAILURE IS OURS — the Maps key is
// missing, refused, or the network is down — the gate stands aside
// (allowed, loudly flagged). Invariant 5: our outage never blocks a
// customer's booking; the anti-bot gate still stands in front of spam.
// A DEFINITIVE answer from Google (no such address, or resolved but not
// street-level) refuses. This resolves the fail-open-vs-fail-closed
// residual from the geocode-posture entry: the public booking flow now
// fails CLOSED on bad addresses and open only on our own faults.

const MAX_DRIVE_MINUTES = 90; // coverage-checker.js TIER_EXTENDED — keep in step

// gate(geo, { travelMinutes, base }) → one of:
//   { ok: true, minutes, degraded? }             — take the booking
//   { ok: false, code, message }                 — refuse, customer-readable
//
// `geo` is geocode()'s result. `travelMinutes(origin, dest)` is
// lib/distance.js's function (Google with a Haversine fallback, so it
// always answers); `base` is PJL_BASE.
async function gate(geo, { travelMinutes, base } = {}) {
  // Our fault → stand aside, flagged. reason is Google's real status:
  // ZERO_RESULTS is a definitive "no such address"; everything else
  // (no key, REQUEST_DENIED, quota, network) is a service failure.
  if (!geo || geo.ok !== true) {
    const reason = geo?.reason || "unknown";
    if (reason !== "ZERO_RESULTS" && reason !== "empty address") {
      return { ok: true, minutes: null, degraded: true, reason };
    }
    return {
      ok: false,
      code: "address_unverified",
      message: "We couldn't find that address. Please pick your full address from the "
        + "suggestions as you type — or call (905) 960-0181 and we'll book you in."
    };
  }

  // Resolved, but not to a real street address. Cached entries from
  // before streetLevel existed lack the field entirely — those are
  // real, served addresses, so only an explicit false refuses.
  if (geo.coords && geo.coords.streetLevel === false) {
    return {
      ok: false,
      code: "address_incomplete",
      message: "That looks like a town or area, not a full address. Please pick your "
        + "exact street address from the suggestions so we know where to send the crew."
    };
  }

  // The service-area lock. distance.js always answers (Haversine when
  // Google can't), so this cannot wedge a booking on a network blip.
  let minutes = null;
  if (typeof travelMinutes === "function" && base && geo.coords && geo.coords.lat != null) {
    try {
      const result = await travelMinutes(base, { lat: geo.coords.lat, lng: geo.coords.lng });
      minutes = Number.isFinite(result?.minutes) ? result.minutes
        : Number.isFinite(result) ? result : null;
    } catch (_) {
      minutes = null; // measurement failure is ours — do not refuse on it
    }
  }
  if (minutes != null && minutes > MAX_DRIVE_MINUTES) {
    return {
      ok: false,
      code: "outside_service_area",
      message: "That address sits outside our service area (about "
        + `${Math.round(minutes)} minutes from our Newmarket base — we cover roughly 90). `
        + "If you think we should make the trip anyway, call (905) 960-0181 and we'll talk it through."
    };
  }

  return { ok: true, minutes };
}

module.exports = { gate, MAX_DRIVE_MINUTES };
