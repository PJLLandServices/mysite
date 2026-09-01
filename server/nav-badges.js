// Shared admin-nav badges. Loaded on EVERY admin page (including ones
// that have their own inline nav-toggle scripts). Keeps the dependency
// graph clean: this script only does network fetches + DOM updates for
// badge counts; it never touches the nav toggle, logout, or anything
// else that could double-bind.
(function () {
  // Helper — populates a badge span with a count, or hides it. Pure
  // DOM update; the caller does the fetch.
  function applyCount(badge, count) {
    if (!badge) return;
    if (count > 0) {
      badge.textContent = String(count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // Portal-message unread badge. The Messages nav link on every admin
  // page carries a [data-portal-msg-badge] span; we populate it with
  // the cross-lead unread count on page load.
  const portalBadge = document.querySelector("[data-portal-msg-badge]");
  if (portalBadge) {
    fetch("/api/admin/portal-messages/unread-count", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.ok) return;
        applyCount(portalBadge, data.count);
      })
      .catch(() => { /* leave badge hidden — graceful failure */ });
  }

  // Recently-accepted quotes badge. The Quotes nav link on every admin
  // page carries a [data-quote-accepted-badge] span; populate with the
  // count of quotes accepted in the last 7 days that haven't yet been
  // converted to a project. Click → quote folder filtered to Accepted.
  // Complements the SMS+email push notifications fired from the three
  // acceptance routes (Build A); a visible at-a-glance signal even when
  // Patrick has alert fatigue or missed a push.
  const quoteBadge = document.querySelector("[data-quote-accepted-badge]");
  if (quoteBadge) {
    fetch("/api/admin/quotes/accepted-recently", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.ok) return;
        applyCount(quoteBadge, data.count);
      })
      .catch(() => { /* leave badge hidden — graceful failure */ });
  }

  // Outstanding warranty-claims badge. The Warranty nav link on every
  // admin page carries a [data-warranty-badge] span; populate it with the
  // count of OPEN claims (not just the overdue ones) — an open claim is
  // an answer owed to a customer whether or not its 24-hour clock has run
  // out, and a badge that only appears once we're already late defeats
  // the point. The queue page itself is where overdue claims get called
  // out in red.
  const warrantyBadge = document.querySelector("[data-warranty-badge]");
  if (warrantyBadge) {
    fetch("/api/warranty-claims/outstanding", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!data || !data.ok) return;
        applyCount(warrantyBadge, data.count);
      })
      .catch(() => { /* leave badge hidden — graceful failure */ });
  }
})();
