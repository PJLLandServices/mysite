// Route preview for /admin/season-plan.
//
// WHY THIS EXISTS. The re-sequencer's output is a list of addresses and
// times, and a list cannot be checked. Patrick verified a day by hand
// against a real map in another tool and found two genuine defects that
// way — a detour between neighbours, and a morning that ran out to
// Pickering before the afternoon came back west. Neither was visible in
// the list. A route drawn on a map makes both obvious in a glance.
//
// TWO SURFACES, DELIBERATELY:
//
//   Preview   an in-page map with numbered stops, for checking the order
//             at a desk before assignments go out.
//   Open in   a plain Google Maps directions URL, for driving it. No API,
//   Maps      no key, no billing, and it opens in the phone's Maps app
//             with turn-by-turn. This is the one that gets used in a
//             truck, and it keeps working even if the preview does not.
//
// COST AND KEYS. The Maps script is loaded lazily, on the first preview
// only, so a page view that never opens a map is never billed for one.
// The key comes from GOOGLE_MAPS_BROWSER_KEY in the environment; with it
// unset the preview button does not render and "Open in Google Maps"
// still works, because that path needs no key at all.
//
// ROADS, WITH A HONEST FALLBACK. The preview asks the Directions service
// for the real road path. If that fails — quota, a restriction, a
// waypoint limit — it draws straight lines between the stops instead and
// says so. Straight lines still answer the question the preview is for,
// which is whether the ORDER is sane; they just do not show the roads.

(function seasonPlanMap() {
  const MAPS_CALLBACK = "__pjlSeasonPlanMapsReady";
  let mapsPromise = null;
  let map = null;
  let renderer = null;
  let markers = [];
  let fallbackLine = null;

  // ---- Lazy Maps loader ---------------------------------------------

  function loadMaps(key) {
    if (mapsPromise) return mapsPromise;
    mapsPromise = new Promise((resolve, reject) => {
      if (window.google && window.google.maps) { resolve(window.google.maps); return; }
      window[MAPS_CALLBACK] = () => resolve(window.google.maps);
      const script = document.createElement("script");
      script.src = "https://maps.googleapis.com/maps/api/js?key="
        + encodeURIComponent(key) + "&callback=" + MAPS_CALLBACK + "&loading=async";
      script.async = true;
      script.defer = true;
      script.onerror = () => reject(new Error("Google Maps failed to load."));
      document.head.appendChild(script);
    });
    return mapsPromise;
  }

  // ---- Building the stop list ----------------------------------------

  // Map order is the DRIVING order, which is the timeline's order — not
  // the order the buckets happen to be listed in. Reading it from the
  // timeline is the same discipline the cards use, for the same reason:
  // two sources for one sequence is how they drift.
  function stopsFor(day) {
    const byCode = new Map();
    for (const stop of [...(day.morning || []), ...(day.afternoon || [])]) byCode.set(stop.code, stop);
    return (day.timeline || [])
      .map((t) => {
        const stop = byCode.get(t.propertyCode);
        if (!stop || !stop.coords) return null;
        return {
          number: t.stopNumber,
          arriveAt: t.arriveAt,
          bucket: t.bucket,
          address: stop.address || "",
          customerName: stop.customerName || "",
          coords: stop.coords
        };
      })
      .filter(Boolean);
  }

  // ---- Open in Google Maps -------------------------------------------
  //
  // The plain directions URL takes at most nine waypoints between origin
  // and destination. The day cap is ten stops, so a full day can exceed
  // it; rather than silently dropping the tail, we say the link covers
  // the first nine and the rest have to be driven from the list.
  const MAX_WAYPOINTS = 9;

  function directionsUrl(stops, origin) {
    if (!stops.length) return null;
    const point = (c) => `${c.lat},${c.lng}`;
    const start = origin && origin.lat != null ? point(origin) : point(stops[0].coords);
    const via = stops.slice(0, MAX_WAYPOINTS).map((s) => point(s.coords));
    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("travelmode", "driving");
    url.searchParams.set("origin", start);
    url.searchParams.set("destination", start);   // the day is a round trip
    url.searchParams.set("waypoints", via.join("|"));
    return url.toString();
  }

  // ---- Drawing --------------------------------------------------------

  function clearOverlays() {
    markers.forEach((m) => m.setMap(null));
    markers = [];
    if (fallbackLine) { fallbackLine.setMap(null); fallbackLine = null; }
    if (renderer) renderer.setDirections({ routes: [] });
  }

  function drawMarkers(maps, stops, origin) {
    const bounds = new maps.LatLngBounds();
    if (origin && origin.lat != null) {
      const home = new maps.Marker({
        position: { lat: origin.lat, lng: origin.lng },
        map,
        title: `Start and end — ${origin.formattedAddress || origin.address || "base"}`,
        label: { text: "⌂", color: "#fff", fontSize: "16px" },
        zIndex: 1
      });
      markers.push(home);
      bounds.extend(home.getPosition());
    }
    for (const stop of stops) {
      const marker = new maps.Marker({
        position: stop.coords,
        map,
        title: `${stop.number}. ${stop.arriveAt} — ${stop.address}`,
        label: { text: String(stop.number), color: "#fff", fontWeight: "700" },
        zIndex: 2
      });
      markers.push(marker);
      bounds.extend(marker.getPosition());
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, 48);
  }

  async function drawRoute(maps, stops, origin, noteEl) {
    clearOverlays();
    drawMarkers(maps, stops, origin);
    if (stops.length < 2) { noteEl.textContent = ""; return; }

    const start = origin && origin.lat != null ? origin : stops[0].coords;
    const service = new maps.DirectionsService();
    if (!renderer) {
      renderer = new maps.DirectionsRenderer({
        map,
        suppressMarkers: true,          // our numbered markers, not Google's letters
        preserveViewport: true,
        polylineOptions: { strokeColor: "#1B4D2E", strokeWeight: 4, strokeOpacity: 0.85 }
      });
    }
    try {
      const result = await service.route({
        origin: start,
        destination: start,
        waypoints: stops.slice(0, MAX_WAYPOINTS).map((s) => ({ location: s.coords, stopover: true })),
        optimizeWaypoints: false,       // the SEQUENCER decides the order; this only draws it
        travelMode: maps.TravelMode.DRIVING
      });
      renderer.setDirections(result);
      const legs = result.routes?.[0]?.legs || [];
      const minutes = Math.round(legs.reduce((t, l) => t + (l.duration?.value || 0), 0) / 60);
      const kmTotal = (legs.reduce((t, l) => t + (l.distance?.value || 0), 0) / 1000).toFixed(1);
      noteEl.textContent = `Google routes this day as ${kmTotal} km, about ${minutes} min driving.`
        + (stops.length > MAX_WAYPOINTS
          ? ` Only the first ${MAX_WAYPOINTS} stops are drawn — Google's limit.` : "");
    } catch (error) {
      // Straight lines still answer "is the order sane?", which is what
      // the preview is for. Say what is being shown rather than let it
      // look like a road route.
      renderer.setMap(null);
      renderer = null;
      const path = [start, ...stops.map((s) => s.coords), start];
      fallbackLine = new maps.Polyline({
        path, map, strokeColor: "#E07B24", strokeWeight: 3,
        strokeOpacity: 0.9, geodesic: true
      });
      noteEl.textContent = "Couldn't get road directions, so the line shows the ORDER of stops "
        + "as straight hops, not the roads you'd drive.";
    }
  }

  // ---- Modal ----------------------------------------------------------

  function ensureModal() {
    let modal = document.getElementById("mapModal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "mapModal";
    modal.className = "sp-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="sp-modal-card sp-map-card" role="dialog" aria-modal="true" aria-labelledby="mapTitle">
        <header class="sp-modal-head">
          <h2 id="mapTitle">Route</h2>
          <button type="button" class="sp-modal-close" id="mapClose" aria-label="Close">&times;</button>
        </header>
        <div class="sp-map" id="mapCanvas"></div>
        <p class="sp-map-note" id="mapNote"></p>
        <ol class="sp-map-legend" id="mapLegend"></ol>
        <footer class="sp-modal-foot">
          <a class="pjl-btn pjl-btn-primary" id="mapOpen" target="_blank" rel="noopener">Open in Google Maps</a>
        </footer>
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector("#mapClose").addEventListener("click", () => { modal.hidden = true; });
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
    return modal;
  }

  async function openMap(day, plan) {
    const modal = ensureModal();
    const stops = stopsFor(day);
    const origin = plan.routeOrigin;

    modal.hidden = false;
    modal.querySelector("#mapTitle").textContent = `${day.label || "Route"} — ${day.weekday}`;
    const noteEl = modal.querySelector("#mapNote");
    noteEl.textContent = "Loading map…";

    const legend = modal.querySelector("#mapLegend");
    legend.innerHTML = "";
    for (const stop of stops) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="sp-map-num">${stop.number}</span>`
        + `<span class="sp-map-when">${stop.arriveAt}</span>`
        + `<span>${stop.address.split(",")[0]}${stop.customerName ? ` — ${stop.customerName}` : ""}</span>`;
      legend.appendChild(li);
    }

    const openLink = modal.querySelector("#mapOpen");
    const url = directionsUrl(stops, origin);
    if (url) { openLink.href = url; openLink.hidden = false; } else { openLink.hidden = true; }

    if (!plan.mapsBrowserKey) {
      noteEl.textContent = "No map preview: GOOGLE_MAPS_BROWSER_KEY isn't set on the server. "
        + "\"Open in Google Maps\" still works — it needs no key.";
      return;
    }
    try {
      const maps = await loadMaps(plan.mapsBrowserKey);
      const canvas = modal.querySelector("#mapCanvas");
      if (!map) {
        map = new maps.Map(canvas, {
          zoom: 9, center: origin && origin.lat != null ? origin : { lat: 44.0592, lng: -79.4613 },
          mapTypeControl: false, streetViewControl: false, fullscreenControl: true
        });
      }
      await drawRoute(maps, stops, origin, noteEl);
    } catch (error) {
      noteEl.textContent = `Map couldn't load (${error.message}). "Open in Google Maps" still works.`;
    }
  }

  // Exposed for season-plan.js, which owns the day cards.
  window.PJLSeasonPlanMap = { openMap, directionsUrl, stopsFor };
})();
