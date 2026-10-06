// PJL Land Services — Shared JS

// ── API base detection ──
// Post-DNS-cutover (see memory/dns_cutover_done.md), pjllandservices.com IS
// Render — the public site and the API live at the same origin. Every form
// POST is now same-origin, so PJL_API_BASE is "" everywhere.
//
// Historical note: this used to detect Wix-hosted pages (pre-cutover) and
// route them cross-origin to the onrender subdomain. That bridge is dead;
// leaving it in caused every form on pjllandservices.com to POST to the
// onrender host, which then 30x-redirected users onto that host and made
// the PJL logo "feel" like it kept them on render.
window.PJL_API_BASE = "";

// ── Navigation scroll effect ──
document.documentElement.classList.add('js-reveal');

const nav = document.querySelector('.nav');
if (nav) {
  const isSolidNav = nav.classList.contains('nav-solid');
  const updateNavState = () => {
    if (isSolidNav) {
      nav.classList.add('scrolled');
      nav.style.setProperty('--nav-bg-alpha', '0.97');
      nav.style.setProperty('--nav-blur', '12px');
      nav.style.setProperty('--nav-shadow-alpha', '0.22');
      return;
    }
    const scrollY = window.scrollY || document.documentElement.scrollTop || 0;
    const progress = Math.min(scrollY / 150, 1);
    nav.classList.toggle('scrolled', scrollY > 40);
    nav.style.setProperty('--nav-bg-alpha', progress.toFixed(3));
    nav.style.setProperty('--nav-blur', `${Math.round(progress * 12)}px`);
    nav.style.setProperty('--nav-shadow-alpha', (progress * 0.22).toFixed(3));
  };

  updateNavState();
  window.addEventListener('scroll', updateNavState, { passive: true });
  window.addEventListener('load', updateNavState);
}

// Set by the blocks below so the slide-out menu and the bottom bar's
// Services panel can close each other (only one is open at a time).
let closeMainMenu = () => {};
let closeServicesSheet = () => {};

// ── Mobile hamburger ──
const hamburger = document.querySelector('.nav-hamburger');
const mobileNav = document.querySelector('.nav-mobile');
if (hamburger && mobileNav) {
  const tabletNavQuery = window.matchMedia('(max-width: 1024px)');
  const spans = hamburger.querySelectorAll('span');
  // Bottom quick-action bar's Menu button opens the same slide-out menu.
  const bottomMenuBtn = document.querySelector('.bottom-nav__menu');
  const syncBottomMenu = (isOpen) => {
    if (bottomMenuBtn) bottomMenuBtn.setAttribute('aria-expanded', String(isOpen));
  };
  const resetHamburger = () => {
    spans[0].style.transform = '';
    spans[1].style.opacity = '';
    spans[2].style.transform = '';
  };
  const closeMobileNav = () => {
    mobileNav.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
    syncBottomMenu(false);
    resetHamburger();
  };

  const toggleMobileNav = () => {
    const isOpen = mobileNav.classList.toggle('open');
    hamburger.setAttribute('aria-expanded', String(isOpen));
    syncBottomMenu(isOpen);
    if (isOpen) {
      closeServicesSheet();
      spans[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
      spans[1].style.opacity = '0';
      spans[2].style.transform = 'rotate(-45deg) translate(5px, -5px)';
    } else {
      resetHamburger();
    }
  };

  closeMainMenu = closeMobileNav;
  hamburger.addEventListener('click', toggleMobileNav);
  if (bottomMenuBtn) bottomMenuBtn.addEventListener('click', toggleMobileNav);

  // Keyboard support — hamburger is a div with role=button, so we wire
  // Enter and Space to behave like a real button.
  hamburger.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      toggleMobileNav();
    }
  });

  // Close on link click
  mobileNav.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      closeMobileNav();
    });
  });

  window.addEventListener('resize', () => {
    if (!tabletNavQuery.matches) {
      closeMobileNav();
    }
  });

  window.addEventListener('orientationchange', closeMobileNav);
}

// ── Scroll reveal ──
const revealEls = document.querySelectorAll('.reveal');
if (revealEls.length) {
  const shouldRevealNow = (el) => {
    const rect = el.getBoundingClientRect();
    return rect.top < (window.innerHeight - 40) && rect.bottom > 0;
  };
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
  revealEls.forEach(el => {
    if (shouldRevealNow(el)) {
      el.classList.add('visible');
      return;
    }
    observer.observe(el);
  });
}

// ── FAQ accordion ──
document.querySelectorAll('.faq-question').forEach(q => {
  q.addEventListener('click', () => {
    const item = q.parentElement;
    const isOpen = item.classList.contains('open');
    // Close all
    document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
    // Open clicked if wasn't open
    if (!isOpen) item.classList.add('open');
  });
});

// ── Counter animation ──
function animateCounter(el) {
  const target = parseInt(el.getAttribute('data-target'));
  const suffix = el.getAttribute('data-suffix') || '';
  const duration = 1800;
  const start = performance.now();
  const update = (now) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(target * eased) + suffix;
    if (progress < 1) requestAnimationFrame(update);
  };
  requestAnimationFrame(update);
}

const counterEls = document.querySelectorAll('.stat-number[data-target]');
if (counterEls.length) {
  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        counterObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });
  counterEls.forEach(el => counterObserver.observe(el));
}

// ── Active nav link ──
const currentPage = window.location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.nav-links a, .nav-mobile a, .nav-mobile__link').forEach(a => {
  const href = a.getAttribute('href');
  if (href === currentPage || (currentPage === '' && href === 'index.html')) {
    a.classList.add('is-active');
    a.style.color = '#fff';
    a.style.opacity = '1';
  }
});

// ── Bottom quick-action bar ──
const bottomNav = document.querySelector('.bottom-nav');
if (bottomNav) {
  // Highlight the current section.
  const page = (window.location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
  const servicePages = /^(sprinkler-|drip-irrigation$|commercial-irrigation$|landscape-lighting$|pricing$|process$|warranty$|water-promise$|coverage-map$)/;
  let section = null;
  if (page === 'index' || page === '') section = 'home';
  else if (page === 'book' || page === 'estimate' || page === 'quote') section = 'book';
  else if (servicePages.test(page)) section = 'services';
  if (section) {
    const item = bottomNav.querySelector(`[data-bnav="${section}"]`);
    if (item) {
      item.classList.add('is-active');
      // Services is a button that opens a panel, not a link to this page.
      if (item.tagName === 'A') item.setAttribute('aria-current', 'page');
    }
  }

  // Services → panel with Spring Opening / Fall Closing / Repairs.
  const servicesBtn = bottomNav.querySelector('.bottom-nav__services');
  const sheet = document.getElementById('bottom-nav-services');
  const backdrop = document.querySelector('.bottom-nav-backdrop');
  if (servicesBtn && sheet) {
    const tabletQuery = window.matchMedia('(max-width: 1024px)');
    sheet.querySelectorAll('a').forEach(a => {
      if ((a.getAttribute('href') || '').replace(/\.html$/, '') === page) a.setAttribute('aria-current', 'page');
      a.addEventListener('click', () => closeServicesSheet());
    });
    const onKey = (e) => {
      if (e.key === 'Escape') closeServicesSheet(true);
    };
    closeServicesSheet = (returnFocus = false) => {
      if (sheet.hidden) return;
      sheet.hidden = true;
      if (backdrop) backdrop.hidden = true;
      servicesBtn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', onKey);
      if (returnFocus) servicesBtn.focus();
    };
    const openServicesSheet = (fromKeyboard) => {
      closeMainMenu();
      sheet.hidden = false;
      if (backdrop) backdrop.hidden = false;
      servicesBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('keydown', onKey);
      if (fromKeyboard) {
        const first = sheet.querySelector('a');
        if (first) first.focus();
      }
    };
    servicesBtn.addEventListener('click', (e) => {
      // e.detail is 0 when the button was "clicked" with Enter/Space.
      if (sheet.hidden) openServicesSheet(e.detail === 0);
      else closeServicesSheet();
    });
    if (backdrop) backdrop.addEventListener('click', () => closeServicesSheet());
    window.addEventListener('resize', () => { if (!tabletQuery.matches) closeServicesSheet(); });
    window.addEventListener('orientationchange', () => closeServicesSheet());
    // Coming back to a page from the browser cache must not show a stale panel.
    window.addEventListener('pageshow', (e) => { if (e.persisted) closeServicesSheet(); });
  }

  // Book → booking page pre-set to the current season's service. The
  // season is decided only by js/season.js (window.PJLSeason) — the same
  // answer the town pages' "Book Fall Closing" buttons use — so the bar
  // flips Fall → off-season → Spring on its own. The href in the markup is
  // the fall fallback used if the script can't load.
  const bookBtn = bottomNav.querySelector('.bottom-nav__book');
  if (bookBtn) {
    const applySeason = () => {
      const S = window.PJLSeason;
      if (!S || typeof S.copyFor !== 'function') return;
      try {
        const copy = S.copyFor(S.season, S.calcSeason, '');
        if (copy && copy.ctaHref) bookBtn.setAttribute('href', copy.ctaHref);
      } catch (e) { /* keep the fallback href */ }
    };
    if (window.PJLSeason) {
      applySeason();
    } else {
      const script = document.createElement('script');
      script.src = 'js/season.js';
      script.async = true;
      script.onload = applySeason;
      document.head.appendChild(script);
    }
  }
}
