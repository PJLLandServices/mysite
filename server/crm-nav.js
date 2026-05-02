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
