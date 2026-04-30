// PJL Land Services — Shared JS

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

// ── Mobile hamburger ──
const hamburger = document.querySelector('.nav-hamburger');
const mobileNav = document.querySelector('.nav-mobile');
if (hamburger && mobileNav) {
  const tabletNavQuery = window.matchMedia('(max-width: 1024px)');
  const spans = hamburger.querySelectorAll('span');
  const resetHamburger = () => {
    spans[0].style.transform = '';
    spans[1].style.opacity = '';
    spans[2].style.transform = '';
  };
  const closeMobileNav = () => {
    mobileNav.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
    resetHamburger();
  };

  const toggleMobileNav = () => {
    const isOpen = mobileNav.classList.toggle('open');
    hamburger.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) {
      spans[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
      spans[1].style.opacity = '0';
      spans[2].style.transform = 'rotate(-45deg) translate(5px, -5px)';
    } else {
      resetHamburger();
    }
  };

  hamburger.addEventListener('click', toggleMobileNav);

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
