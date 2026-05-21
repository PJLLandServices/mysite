// Shared CRM sidebar/topbar nav behaviour. Used by every admin page that
// embeds the standard <aside class="pjl-admin-nav"> + <header class=
// "pjl-app-topbar"> chrome. Hamburger toggle on mobile + auto-close when
// any link inside is tapped (browsers that bf-cache the previous DOM
// would otherwise show the menu still open over the next page).
(function setupCrmNav() {
  const toggle = document.getElementById("navToggle");
  const nav = document.querySelector(".pjl-admin-nav");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  nav.querySelectorAll(".pjl-nav-links a").forEach((a) => {
    a.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
  // Logout button — every page that embeds the nav has one in the
  // sidebar footer. Hits the existing /api/logout endpoint.
  const logout = document.getElementById("logoutButton");
  if (logout) {
    logout.addEventListener("click", async () => {
      try { await fetch("/api/logout", { method: "POST" }); } catch {}
      location.href = "/login";
    });
  }
})();
// Materials section sub-nav dropdown. On viewports < 768px the four-tab
// strip (Material Lists / Purchase Orders / Suppliers / Catalog) is
// hidden by CSS and the parallel <details class="suppliers-subnav-dropdown">
// takes over. This handler closes the dropdown on outside-tap, on Escape,
// and after a menu item is tapped (covers bf-cache restores).
(function setupSubnavDropdown() {
  const dropdown = document.querySelector(".suppliers-subnav-dropdown");
  if (!dropdown) return;
  document.addEventListener("pointerdown", (event) => {
    if (!dropdown.open) return;
    const target = event.target;
    if (target && target.closest && target.closest(".suppliers-subnav-dropdown")) return;
    dropdown.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dropdown.open) dropdown.open = false;
  });
  dropdown.querySelectorAll(".suppliers-subnav-menu a").forEach((a) => {
    a.addEventListener("click", () => { dropdown.open = false; });
  });
})();

// The portal-message unread badge lives in /crm/nav-badges.js so it can
// be loaded on every admin page (including pages with inline nav-toggle
// scripts that would otherwise double-bind if they also pulled in this
// crm-nav.js).
