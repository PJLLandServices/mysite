/* ════════════════════════════════════════════════════════════════════
   SPRINKLER BUILDER — State logic + interactivity
   ────────────────────────────────────────────────────────────────────
   Customer flow:
     Step 1. Pick tier (1–4) → reveals Steps 2, 3, 4
     Step 2. Front of House — image + 3 feature toggles
     Step 3. Back of House  — image + 3 feature toggles
     Step 4. Submit form → mailto fallback (TODO: wire to real handler)

   Both yard sections render simultaneously after tier select. Each has
   its own image + features and updates independently as toggles change.
   ════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  // All features default to ON ("everything by default, remove what
  // doesn't apply" model — keeps the customer focused on subtraction).
  const state = {
    tier: null,                                     // 1, 2, 3, or 4
    frontFeatures: { T: true, C: true, G: true },   // Trees, Cedars, Garden
    backFeatures:  { P: true, C: true, G: true }    // Pool, Cedars, Garden
  };

  // ── Tier metadata (for form summary + alt text) ──────────────
  const TIER_META = {
    1: { name: 'Starter Home',   size: 'Up to 3,000 sq ft yard' },
    2: { name: 'Family Home',    size: '3,000–6,000 sq ft yard' },
    3: { name: 'Executive Home', size: '6,000–15,000 sq ft yard' },
    4: { name: 'Luxury Estate',  size: '½ acre or larger' }
  };

  // ── Feature label maps (for hidden form fields + alt text) ──
  const FRONT_FEATURE_LABELS = { T: 'Trees', C: 'Cedar hedges', G: 'Garden beds' };
  const BACK_FEATURE_LABELS  = { P: 'Pool',  C: 'Cedar hedges', G: 'Garden beds' };
  const FRONT_ORDER = ['T', 'C', 'G'];
  const BACK_ORDER  = ['P', 'C', 'G'];

  // ── DOM references ───────────────────────────────────────────
  const tierCards          = document.querySelectorAll('.tier-card');
  const sectionFront       = document.getElementById('builderFront');
  const sectionBack        = document.getElementById('builderBack');
  const sectionForm        = document.getElementById('builderForm');
  const imgFront           = document.getElementById('builderImageFront');
  const imgBack            = document.getElementById('builderImageBack');
  const captionFront       = document.getElementById('imageCaptionFront');
  const captionBack        = document.getElementById('imageCaptionBack');
  const featureGridFront   = document.querySelector('.feature-grid[data-yard-view="FRONT"]');
  const featureGridBack    = document.querySelector('.feature-grid[data-yard-view="BACK"]');
  const quoteForm          = document.getElementById('quoteForm');
  const quoteSuccess       = document.getElementById('quoteSuccess');
  const qfTier             = document.getElementById('qfTier');
  const qfFrontFeatures    = document.getElementById('qfFrontFeatures');
  const qfBackFeatures     = document.getElementById('qfBackFeatures');
  const qfError            = document.getElementById('qfError');
  const qsName             = document.getElementById('qsName');

  // ── Image filename derivation ────────────────────────────────
  // Builds e.g. "images/builder/T2_FRONT_TCG.png" from current state.
  function getImageFilename(yard) {
    if (!state.tier) return null;

    const features = yard === 'FRONT' ? state.frontFeatures : state.backFeatures;
    const order    = yard === 'FRONT' ? FRONT_ORDER : BACK_ORDER;

    let flags = '';
    order.forEach(k => { if (features[k]) flags += k; });
    if (flags === '') flags = 'BARE';

    return `images/builder/T${state.tier}_${yard}_${flags}.png`;
  }

  // ── Build a human-readable feature list ──────────────────────
  function getFeatureSummary(yard) {
    const features = yard === 'FRONT' ? state.frontFeatures : state.backFeatures;
    const labels   = yard === 'FRONT' ? FRONT_FEATURE_LABELS : BACK_FEATURE_LABELS;
    const order    = yard === 'FRONT' ? FRONT_ORDER : BACK_ORDER;

    const active = order.filter(k => features[k]).map(k => labels[k]);
    return active.length ? active.join(', ') : 'None';
  }

  // ── Build descriptive alt text for an image ──────────────────
  function getAltText(yard) {
    if (!state.tier) return 'Your home preview';
    const tier = TIER_META[state.tier];
    const yardWord = yard === 'FRONT' ? 'front yard' : 'back yard';
    const features = getFeatureSummary(yard);
    const featurePart = features === 'None' ? 'no features' : `with ${features.toLowerCase()}`;
    return `${tier.name}, ${yardWord} ${featurePart}.`;
  }

  // ── Image swap (snappy when cached, brief fade only if not) ──
  // Strategy:
  //   1. If the new image is already in the browser cache (it almost
  //      always will be — we preload all 16 on tier select), swap the
  //      src instantly. No fade, no delay.
  //   2. If it's NOT cached, start fetching it. Only show a light fade
  //      if the fetch takes longer than 80ms — fast loads stay snappy,
  //      slow loads get visual feedback that something is happening.
  function updateImage(yard) {
    const imgEl = yard === 'FRONT' ? imgFront : imgBack;
    if (!imgEl) return;
    const src = getImageFilename(yard);
    if (!src) return;

    // Skip if we're already showing this exact image
    const filename = src.split('/').pop();
    if (imgEl.src && imgEl.src.endsWith(filename)) return;

    // Probe the cache via a hidden Image() — if complete sync, it's cached
    const probe = new Image();
    probe.src = src;

    if (probe.complete && probe.naturalWidth > 0) {
      // Cached → instant swap
      imgEl.src = src;
      imgEl.alt = getAltText(yard);
      return;
    }

    // Not cached → fade only if load is slow (>80ms)
    let fadeApplied = false;
    const fadeTimer = setTimeout(() => {
      imgEl.classList.add('is-fading');
      fadeApplied = true;
    }, 80);

    const onReady = () => {
      clearTimeout(fadeTimer);
      imgEl.src = src;
      imgEl.alt = getAltText(yard);
      if (fadeApplied) {
        requestAnimationFrame(() => imgEl.classList.remove('is-fading'));
      }
    };

    probe.addEventListener('load',  onReady, { once: true });
    probe.addEventListener('error', () => {
      clearTimeout(fadeTimer);
      if (fadeApplied) imgEl.classList.remove('is-fading');
    }, { once: true });
  }

  // ── Update the caption strip below an image ──────────────────
  function updateCaption(yard) {
    const el = yard === 'FRONT' ? captionFront : captionBack;
    if (!el) return;
    const features = getFeatureSummary(yard);
    const yardLabel = yard === 'FRONT' ? 'Front Yard' : 'Back Yard';
    el.textContent = features === 'None'
      ? `${yardLabel}: nothing selected — add features above.`
      : `${yardLabel}: ${features}`;
  }

  // ── Update both yards at once (used on tier select) ──────────
  function updateAll() {
    updateImage('FRONT');
    updateImage('BACK');
    updateCaption('FRONT');
    updateCaption('BACK');
    updateHiddenFields();
  }

  // ── Preload all 16 images for the active tier ────────────────
  // Run after tier selection so toggles feel instant.
  const preloadedTiers = new Set();
  function preloadTierImages(tier) {
    if (preloadedTiers.has(tier)) return;
    preloadedTiers.add(tier);

    const frontFlags = ['BARE', 'T', 'C', 'G', 'TC', 'TG', 'CG', 'TCG'];
    const backFlags  = ['BARE', 'P', 'C', 'G', 'PC', 'PG', 'CG', 'PCG'];

    [['FRONT', frontFlags], ['BACK', backFlags]].forEach(([yard, flags]) => {
      flags.forEach(flag => {
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = `images/builder/T${tier}_${yard}_${flag}.png`;
        document.head.appendChild(link);
      });
    });
  }

  // ── Update hidden form fields with current state ─────────────
  function updateHiddenFields() {
    if (!state.tier) return;
    const tier = TIER_META[state.tier];
    if (qfTier)          qfTier.value = `Tier ${state.tier} — ${tier.name} (${tier.size})`;
    if (qfFrontFeatures) qfFrontFeatures.value = getFeatureSummary('FRONT');
    if (qfBackFeatures)  qfBackFeatures.value  = getFeatureSummary('BACK');
  }

  // ── Reveal Steps 2/3/4 (only the first time) ─────────────────
  let revealed = false;
  function revealTierDependentSections() {
    if (revealed) return;
    revealed = true;
    if (sectionFront) sectionFront.hidden = false;
    if (sectionBack)  sectionBack.hidden  = false;
    if (sectionForm)  sectionForm.hidden  = false;

    // Smooth scroll to Step 2 so the user sees their selection unfold
    setTimeout(() => {
      if (sectionFront && sectionFront.scrollIntoView) {
        sectionFront.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 300);
  }

  // ── Tier card click handler ──────────────────────────────────
  tierCards.forEach(card => {
    card.addEventListener('click', () => {
      const tier = parseInt(card.dataset.tier, 10);
      if (!tier) return;

      state.tier = tier;

      // Update card selected states
      tierCards.forEach(c => {
        const isSelected = c === card;
        c.classList.toggle('is-selected', isSelected);
        c.setAttribute('aria-checked', isSelected ? 'true' : 'false');
      });

      // Update both yards + reveal dependent sections
      updateAll();
      preloadTierImages(tier);
      revealTierDependentSections();
    });

    // Keyboard support: Space toggle (Enter is native on buttons)
    card.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        card.click();
      }
    });
  });

  // ── Feature card toggle ──────────────────────────────────────
  // Each feature grid (front/back) knows its yard via data-yard-view.
  function bindFeatureCards(grid) {
    if (!grid) return;
    const yardOfGrid = grid.dataset.yardView; // 'FRONT' or 'BACK'

    grid.querySelectorAll('.feature-card').forEach(card => {
      card.addEventListener('click', () => {
        const flag = card.dataset.flag;
        if (!flag) return;

        const features = yardOfGrid === 'FRONT'
          ? state.frontFeatures
          : state.backFeatures;

        // Toggle the flag
        features[flag] = !features[flag];

        // Update card visual state
        card.classList.toggle('is-on', features[flag]);
        card.setAttribute('aria-checked', features[flag] ? 'true' : 'false');

        // Update only this yard's image + caption + hidden field
        updateImage(yardOfGrid);
        updateCaption(yardOfGrid);
        updateHiddenFields();
      });

      // Keyboard support for Space (Enter is native for buttons)
      card.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          card.click();
        }
      });
    });
  }
  bindFeatureCards(featureGridFront);
  bindFeatureCards(featureGridBack);

  // ── Form submission ──────────────────────────────────────────
  if (quoteForm) {
    quoteForm.addEventListener('submit', handleSubmit);

    // Live re-validate to clear errors as user types
    quoteForm.querySelectorAll('input, select, textarea').forEach(field => {
      field.addEventListener('input', () => field.classList.remove('is-error'));
    });
  }

  function handleSubmit(e) {
    e.preventDefault();

    // Make sure the customer picked a tier first
    if (!state.tier) {
      showError("Please pick a home tier above before submitting.");
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    // Validate required fields
    const fields = {
      name:    document.getElementById('qfName'),
      phone:   document.getElementById('qfPhone'),
      email:   document.getElementById('qfEmail'),
      address: document.getElementById('qfAddress')
    };
    let firstInvalid = null;
    Object.values(fields).forEach(f => f && f.classList.remove('is-error'));

    if (!fields.name.value.trim()) {
      fields.name.classList.add('is-error');
      firstInvalid = firstInvalid || fields.name;
    }
    if (!fields.phone.value.trim()) {
      fields.phone.classList.add('is-error');
      firstInvalid = firstInvalid || fields.phone;
    }
    if (!fields.email.value.trim() || !isValidEmail(fields.email.value)) {
      fields.email.classList.add('is-error');
      firstInvalid = firstInvalid || fields.email;
    }
    if (!fields.address.value.trim()) {
      fields.address.classList.add('is-error');
      firstInvalid = firstInvalid || fields.address;
    }
    if (firstInvalid) {
      showError("Please fill in all required fields with valid info.");
      firstInvalid.focus();
      return;
    }

    hideError();
    updateHiddenFields();

    // Build the payload
    const payload = {
      name:            fields.name.value.trim(),
      phone:           fields.phone.value.trim(),
      email:           fields.email.value.trim(),
      address:         fields.address.value.trim(),
      best_time:       document.getElementById('qfTime').value,
      notes:           document.getElementById('qfNotes').value.trim(),
      selected_tier:   qfTier.value,
      front_features:  qfFrontFeatures.value,
      back_features:   qfBackFeatures.value
    };

    // ── Submit to PJL backend ──
    submitToBackend(payload);
  }

  function submitToBackend(p) {
    // The interactive builder collects tier + per-yard feature selections that
    // don't map 1:1 to the backend's master FEATURES catalog (those are flat-priced
    // service items, this is a tier-based new-install quote). So we send the rich
    // selection data as customer notes and let PJL price it on-site — source is
    // sprinkler_quote so it lands in the New Sprinkler Quote pipeline.
    const noteLines = [
      "Selected tier: " + (p.selected_tier || "(none)"),
      "Front-yard features: " + (p.front_features || "(none)"),
      "Back-yard features: " + (p.back_features || "(none)"),
      "Best time to call: " + (p.best_time || "No preference")
    ];
    if (p.notes) noteLines.push("", "Customer notes:", p.notes);

    const body = JSON.stringify({
      source: "sprinkler_quote",
      contact: {
        name:    p.name,
        phone:   p.phone,
        email:   p.email,
        address: p.address,
        notes:   noteLines.join("\n")
      },
      pageUrl: window.location.href,
      userAgent: navigator.userAgent,
      mode: "sprinkler-quote-builder"
    });

    fetch((window.PJL_API_BASE || '') + '/api/quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          showSuccess(p.name);
        } else {
          const message = (data.errors || []).join(" ") || "Submission failed.";
          showError("Sorry — " + message + " Please call (905) 960-0181 or email info@pjllandservices.com.");
        }
      })
      .catch(err => {
        console.error('Quote submit failed:', err);
        showError("Sorry — your request didn't send. Please call (905) 960-0181 or email info@pjllandservices.com.");
      });
  }

  function showSuccess(name) {
    if (qsName) qsName.textContent = name.split(' ')[0] || 'friend';
    if (quoteForm)    quoteForm.hidden    = true;
    if (quoteSuccess) quoteSuccess.hidden = false;

    if (quoteSuccess && quoteSuccess.scrollIntoView) {
      quoteSuccess.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function showError(msg) {
    if (!qfError) return;
    qfError.textContent = msg;
    qfError.hidden = false;
  }
  function hideError() {
    if (qfError) qfError.hidden = true;
  }

  function isValidEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  }

  // ── Initialize ───────────────────────────────────────────────
  // Sections 2/3/4 stay hidden via [hidden] until the first tier click.
  // Pre-warm hidden field defaults so they're never empty if submitted.
  updateHiddenFields();
})();
