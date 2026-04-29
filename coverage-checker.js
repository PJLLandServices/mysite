/**
 * PJL Land Services — Live Coverage Checker
 * Google Places Autocomplete + Distance Matrix from Newmarket base.
 * Used on: coverage-map.html, quote.html, estimate.html, contact.html
 *
 * Required DOM IDs on the host page:
 *   #cov-address-input    — text input for the address
 *   #cov-clear-btn        — clear button (×) — toggled hidden/visible by script
 *   #cov-checker-result   — result panel (filled in by script)
 *
 * Loaded via Google Maps callback: ?callback=initCoverageCheck
 */
(function () {
  // PJL Newmarket base coordinates
  var PJL_BASE = { lat: 44.0592, lng: -79.4613 };
  // Tier thresholds in MINUTES of driving time (one-way)
  var TIER_CORE = 25;        // ≤ 25 min → core same-day area
  var TIER_REGULAR = 60;     // ≤ 60 min → regular service area
  var TIER_EXTENDED = 90;    // ≤ 90 min → extended scheduled route
  // > TIER_EXTENDED → soft no

  var input, resultEl, clearBtn, autocomplete;

  // Called by Google Maps script via &callback=initCoverageCheck
  window.initCoverageCheck = function () {
    input = document.getElementById('cov-address-input');
    resultEl = document.getElementById('cov-checker-result');
    clearBtn = document.getElementById('cov-clear-btn');
    if (!input || !resultEl) return;

    // Bias autocomplete to Ontario, Canada — addresses only
    autocomplete = new google.maps.places.Autocomplete(input, {
      componentRestrictions: { country: 'ca' },
      fields: ['formatted_address', 'geometry', 'name'],
      types: ['address'],
      // Bias toward southern Ontario (rough rectangle around Newmarket)
      bounds: new google.maps.LatLngBounds(
        new google.maps.LatLng(43.0, -80.7),  // SW corner
        new google.maps.LatLng(44.7, -78.5)   // NE corner
      ),
      strictBounds: false
    });

    autocomplete.addListener('place_changed', handlePlaceChanged);

    // Show clear button when typing
    input.addEventListener('input', function () {
      if (clearBtn) clearBtn.hidden = !input.value;
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        input.value = '';
        clearBtn.hidden = true;
        resultEl.hidden = true;
        input.focus();
      });
    }

    // Suppress browser autofill on this single field (won't fight Places dropdown)
    input.setAttribute('autocomplete', 'new-password');
  };

  function handlePlaceChanged() {
    var place = autocomplete.getPlace();
    if (!place || !place.geometry || !place.geometry.location) {
      renderError('We couldn\'t place that address. Try picking from the dropdown, or call us directly.');
      return;
    }
    if (clearBtn) clearBtn.hidden = false;
    renderLoading();
    measureDriveTime(place);
  }

  function measureDriveTime(place) {
    var dest = place.geometry.location;
    var service = new google.maps.DistanceMatrixService();
    service.getDistanceMatrix({
      origins: [PJL_BASE],
      destinations: [dest],
      travelMode: google.maps.TravelMode.DRIVING,
      unitSystem: google.maps.UnitSystem.METRIC,
      drivingOptions: undefined
    }, function (response, status) {
      if (status !== 'OK' || !response || !response.rows || !response.rows[0] || !response.rows[0].elements[0]) {
        renderError('Couldn\'t calculate drive time right now. Call us at (905) 960-0181 and we\'ll confirm coverage manually.');
        return;
      }
      var element = response.rows[0].elements[0];
      if (element.status !== 'OK') {
        renderError('That destination isn\'t reachable by road from Newmarket. Double-check the address or call us.');
        return;
      }
      var minutes = Math.round(element.duration.value / 60);
      var km = Math.round(element.distance.value / 1000);
      renderResult(minutes, km, place.formatted_address || place.name || '');
    });
  }

  function renderLoading() {
    resultEl.hidden = false;
    resultEl.className = 'cov-checker__result is-loading';
    resultEl.innerHTML =
      '<div class="cov-checker__result-icon">⏳</div>' +
      '<h3 class="cov-checker__result-title">Checking drive time…</h3>' +
      '<p class="cov-checker__result-detail">One moment — measuring the route from our Newmarket base.</p>';
  }

  function renderError(msg) {
    resultEl.hidden = false;
    resultEl.className = 'cov-checker__result is-error';
    resultEl.innerHTML =
      '<div class="cov-checker__result-icon">⚠️</div>' +
      '<h3 class="cov-checker__result-title">Hmm — that didn\'t work</h3>' +
      '<p class="cov-checker__result-detail">' + escapeHtml(msg) + '</p>' +
      '<div class="cov-checker__result-actions">' +
        '<a href="tel:+19059600181" class="primary">📞 Call (905) 960-0181</a>' +
      '</div>';
  }

  function renderResult(minutes, km, address) {
    var addressLine = address ? '<strong>' + escapeHtml(address) + '</strong> · ' : '';
    var driveLine = '~<strong>' + minutes + ' min</strong> drive (' + km + ' km) from our Newmarket base';

    if (minutes <= TIER_CORE) {
      resultEl.className = 'cov-checker__result';
      resultEl.innerHTML =
        '<div class="cov-checker__result-icon">✅</div>' +
        '<h3 class="cov-checker__result-title">You\'re right in our core service area.</h3>' +
        '<p class="cov-checker__result-detail">' + addressLine + driveLine + '. Same-day repair available during the April–October season. This is exactly the territory we work in every day.</p>' +
        '<div class="cov-checker__result-actions">' +
          '<a href="quote.html" class="primary">Get a free estimate →</a>' +
          '<a href="tel:+19059600181" class="secondary">📞 (905) 960-0181</a>' +
        '</div>';
    } else if (minutes <= TIER_REGULAR) {
      resultEl.className = 'cov-checker__result';
      resultEl.innerHTML =
        '<div class="cov-checker__result-icon">✅</div>' +
        '<h3 class="cov-checker__result-title">Confirmed coverage — regular service area.</h3>' +
        '<p class="cov-checker__result-detail">' + addressLine + driveLine + '. We\'re out your way regularly during the season. Same-day repair usually available; install bookings slot into the next available crew day.</p>' +
        '<div class="cov-checker__result-actions">' +
          '<a href="quote.html" class="primary">Get a free estimate →</a>' +
          '<a href="tel:+19059600181" class="secondary">📞 (905) 960-0181</a>' +
        '</div>';
    } else if (minutes <= TIER_EXTENDED) {
      resultEl.className = 'cov-checker__result';
      resultEl.innerHTML =
        '<div class="cov-checker__result-icon">✅</div>' +
        '<h3 class="cov-checker__result-title">Confirmed coverage — extended scheduled route.</h3>' +
        '<p class="cov-checker__result-detail">' + addressLine + driveLine + '. You\'re in our extended-route territory. We batch installs and seasonal service into route days rather than promising same-day, but pricing is identical to the core area — we absorb the drive-time difference.</p>' +
        '<div class="cov-checker__result-actions">' +
          '<a href="quote.html" class="primary">Get a free estimate →</a>' +
          '<a href="tel:+19059600181" class="secondary">📞 (905) 960-0181</a>' +
        '</div>';
    } else {
      resultEl.className = 'cov-checker__result is-warning';
      resultEl.innerHTML =
        '<div class="cov-checker__result-icon">🚧</div>' +
        '<h3 class="cov-checker__result-title">Outside our standard route — call to discuss.</h3>' +
        '<p class="cov-checker__result-detail">' + addressLine + driveLine + ' — past our usual ~90-minute coverage radius. We sometimes still take on jobs out there if we\'re already scheduled for a neighbour, or if it\'s a larger install. Best to call so we can be honest about timing and pricing.</p>' +
        '<div class="cov-checker__result-actions">' +
          '<a href="tel:+19059600181" class="primary">📞 Call (905) 960-0181</a>' +
          '<a href="contact.html" class="secondary">Send us your details →</a>' +
        '</div>';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Graceful fallback if Maps API fails to load (offline, blocked, key issue)
  window.gm_authFailure = function () {
    var el = document.getElementById('cov-checker-result');
    if (el) {
      el.hidden = false;
      el.className = 'cov-checker__result is-error';
      el.innerHTML =
        '<div class="cov-checker__result-icon">⚠️</div>' +
        '<h3 class="cov-checker__result-title">Address checker temporarily unavailable</h3>' +
        '<p class="cov-checker__result-detail">Call us at <a href="tel:+19059600181" style="color:inherit;text-decoration:underline;"><strong>(905) 960-0181</strong></a> with your address and we\'ll confirm coverage manually — usually faster than the form anyway.</p>';
    }
  };
})();
