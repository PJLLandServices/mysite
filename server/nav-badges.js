// Shared admin-nav badges. Loaded on EVERY admin page (including ones
// that have their own inline nav-toggle scripts). Keeps the dependency
// graph clean: this script only does network fetches + DOM updates for
// badge counts; it never touches the nav toggle, logout, or anything
// else that could double-bind.
(function () {
  // Portal-message unread badge. The Messages nav link on every admin
  // page carries a [data-portal-msg-badge] span; we populate it with
  // the cross-lead unread count on page load.
  const badge = document.querySelector("[data-portal-msg-badge]");
  if (!badge) return;
  fetch("/api/admin/portal-messages/unread-count", { cache: "no-store" })
    .then((r) => r.json())
    .then((data) => {
      if (!data || !data.ok) return;
      if (data.count > 0) {
        badge.textContent = String(data.count);
        badge.hidden = false;
      } else {
        badge.hidden = true;
      }
    })
    .catch(() => { /* leave badge hidden — graceful failure */ });
})();
