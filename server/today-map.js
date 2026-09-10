// Today's route, as a map — the same map language as /admin/season-plan.
//
// WHY THIS IS ITS OWN PAGE. It is drawn in two places: inside the field
// app's Today screen, in a band above the list, and inside the CRM's
// Today page. Writing it twice would produce two maps that drift apart,
// and the field app has no Google Maps of its own — adding a native map
// SDK would mean a new native dependency and a new build every time the
// map changed. A page both surfaces load is one implementation.
//
// WHERE THE DATA COMES FROM. `/api/schedule/today` — the SAME endpoint
// the app's list and the CRM's Today page read, in the SAME order. The
// stop numbers here are positions in that response, so a pin can never
// disagree with the card beside it. Nothing about the day is computed
// here; if a row is missing from the map it is missing from the day.
//
// THE KEYS STAY WHERE THEY BELONG. The browser key comes from
// /api/maps-config, as it does on the season plan. The ROAD LINE is
// drawn by our server from GOOGLE_MAPS_SERVER_KEY, which never reaches
// this page.
//
// Covered by scripts/test-today-map.mjs.

(function () {
  "use strict";

  var AM_GREEN = "#1B4D2E";     // --pjl-green
  var PM_GREEN = "#4A8C5C";
  var DONE_GREY = "#8C948E";    // a finished stop stops competing for attention
  var YARD_INK = "#0F1F14";

  var mapBox = document.getElementById("map");
  var noteBox = document.getElementById("note");

  function note(text, bad) {
    if (!text) { noteBox.hidden = true; return; }
    noteBox.hidden = false;
    noteBox.textContent = text;
    noteBox.classList.toggle("is-bad", !!bad);
  }

  function param(name) {
    return new URLSearchParams(window.location.search).get(name) || "";
  }

  // Byte-for-byte the rule in pjl-field/src/workorder-routing.js. The app
  // sends a tapped pin's key back and scrolls its own list to the card
  // with that key, so the two MUST agree. test-today-map.mjs asserts the
  // two sources still spell it the same way.
  function rowKey(row) {
    return (row && (row.leadId || row.bookingId || (row.workOrder && row.workOrder.id) || row.start)) || "";
  }

  function isDone(row) {
    return !!(row && row.workOrder && row.workOrder.status === "completed");
  }

  // Number(null) is 0, and so is Number(""). A row whose coordinates came
  // back empty would otherwise be drawn at 0,0 — in the Gulf of Guinea,
  // on a map of Newmarket, as a confident numbered pin. Absent has to be
  // absent, not zero.
  function num(value) {
    if (value === null || value === undefined || value === "") return NaN;
    var n = Number(value);
    return isFinite(n) ? n : NaN;
  }

  function isMorning(row) {
    if (!row || !row.start) return true;
    var d = new Date(row.start);
    return isNaN(d.getTime()) ? true : d.getHours() < 12;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Whoever is hosting this page. The field app injects
  // window.ReactNativeWebView; the CRM's Today page frames it.
  function tellHost(message) {
    var payload = JSON.stringify(message);
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(payload);
    }
    if (window.parent && window.parent !== window) {
      try { window.parent.postMessage(payload, window.location.origin); } catch (err) { /* framed cross-origin */ }
    }
  }

  var mapsPromise = null;
  function mapsReady() {
    if (mapsPromise) return mapsPromise;
    mapsPromise = (async function () {
      var response = await fetch("/api/maps-config", { cache: "no-store", credentials: "same-origin" });
      var config = await response.json();
      if (!config.ok || !config.available) {
        throw new Error(config.reason || "No Maps browser key is configured.");
      }
      await new Promise(function (resolve, reject) {
        var callback = "__pjlTodayMapReady";
        window[callback] = function () { delete window[callback]; resolve(); };
        var script = document.createElement("script");
        script.async = true;
        script.src = "https://maps.googleapis.com/maps/api/js"
          + "?key=" + encodeURIComponent(config.key)
          + "&v=weekly&callback=" + callback;
        // A referrer-restricted key fails here and nowhere else, so the
        // message names that cause first.
        script.onerror = function () {
          reject(new Error("Google Maps did not load. Check the browser key's HTTP-referrer restriction allows this domain."));
        };
        document.head.appendChild(script);
      });
    })();
    return mapsPromise;
  }

  function pinIcon(stop) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: stop.focused ? 15 : 13,
      fillColor: stop.done ? DONE_GREY : (stop.morning ? AM_GREEN : PM_GREEN),
      fillOpacity: stop.done ? 0.75 : 1,
      strokeColor: stop.focused ? "#E07B24" : "#ffffff",
      strokeWeight: stop.focused ? 3 : 2
    };
  }

  function yardIcon() {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26">'
      + '<rect x="3" y="3" width="20" height="20" rx="5" fill="' + YARD_INK + '" stroke="#ffffff" stroke-width="2"/></svg>';
    return {
      url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg),
      anchor: new google.maps.Point(13, 13),
      labelOrigin: new google.maps.Point(13, 13)
    };
  }

  // Positions in the day's own order. A row with no coordinates keeps its
  // place in the list but cannot be drawn, and the note says how many —
  // a map quietly missing a stop is worse than one that admits it.
  function mappableStops(rows) {
    var stops = [];
    var skipped = 0;
    (rows || []).forEach(function (row, index) {
      var coords = row && row.coords;
      var lat = coords ? num(coords.lat) : NaN;
      var lng = coords ? num(coords.lng) : NaN;
      if (!isFinite(lat) || !isFinite(lng)) { skipped += 1; return; }
      stops.push({
        key: rowKey(row),
        number: index + 1,
        coords: { lat: lat, lng: lng },
        done: isDone(row),
        morning: isMorning(row),
        address: row.address || "",
        town: row.town || "",
        customerName: row.customerName || "",
        serviceLabel: row.serviceLabel || "",
        startLabel: row.startLabel || "",
        focused: false
      });
    });
    return { stops: stops, skipped: skipped };
  }

  var state = { map: null, markers: new Map(), line: null, focusedKey: null };

  function focusStop(key, openInfo) {
    state.focusedKey = key || null;
    state.markers.forEach(function (entry, entryKey) {
      entry.stop.focused = entryKey === state.focusedKey;
      entry.marker.setIcon(pinIcon(entry.stop));
      entry.marker.setZIndex(entry.stop.focused ? 5 : (entry.stop.done ? 2 : 3));
    });
    var hit = key ? state.markers.get(key) : null;
    if (hit && openInfo && state.info) {
      state.info.setContent(bubble(hit.stop));
      state.info.open({ map: state.map, anchor: hit.marker });
      state.map.panTo(hit.stop.coords);
    }
  }

  function bubble(stop) {
    return '<div style="font:13px/1.45 system-ui,sans-serif;max-width:230px">'
      + "<strong>" + (stop.done ? "Done · " : "Stop ") + stop.number
      + (stop.startLabel ? " · " + escapeHtml(stop.startLabel) : "") + "</strong><br>"
      + escapeHtml(stop.address) + (stop.town ? ", " + escapeHtml(stop.town) : "")
      + (stop.customerName ? "<br>" + escapeHtml(stop.customerName) : "")
      + (stop.serviceLabel ? "<br>" + escapeHtml(stop.serviceLabel) : "")
      + "</div>";
  }

  // The endpoint answers with [lat, lng] PAIRS, not {lat, lng} objects —
  // see lib/route-geometry.js, and /admin/season-plan converts them the
  // same way before drawing. Handing the raw pairs to google.maps.Polyline
  // draws NOTHING, silently: no error, no warning, just numbered pins with
  // no line between them. That is exactly what shipped on 2026-09-07.
  function toPath(coords) {
    if (!Array.isArray(coords)) return [];
    return coords
      .map(function (point) {
        if (Array.isArray(point)) {
          var lat = num(point[0]);
          var lng = num(point[1]);
          return isFinite(lat) && isFinite(lng) ? { lat: lat, lng: lng } : null;
        }
        if (point && typeof point === "object") {
          var oLat = num(point.lat);
          var oLng = num(point.lng);
          return isFinite(oLat) && isFinite(oLng) ? { lat: oLat, lng: oLng } : null;
        }
        return null;
      })
      .filter(Boolean);
  }

  // Roads, or hops? Anything that is not a router's own geometry is hops.
  // Testing for "straight" by name would draw a solid road for a source
  // this page has not been taught about yet, which is the failure that
  // matters: a line that claims to be a drive and is not.
  function isRoadLine(source) {
    return source === "google" || source === "osrm";
  }

  // The road line, drawn by our server. Ordered coordinates go up, road
  // geometry comes back — the same helper the season plan's line uses,
  // so a day drawn on both screens is drawn the same way.
  async function drawLine(stops) {
    try {
      var response = await fetch("/api/schedule/today/route-line", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stops: stops.map(function (s) { return s.coords; }) })
      });
      var data = await response.json();
      if (!data.ok || !Array.isArray(data.coords) || data.coords.length < 2) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  async function draw() {
    var date = param("date");
    var query = date ? "?date=" + encodeURIComponent(date) : "";

    var rows;
    try {
      var response = await fetch("/api/schedule/today" + query, { cache: "no-store", credentials: "same-origin" });
      if (response.status === 401 || response.status === 403) {
        note("Sign in to see the day's route.", true);
        return;
      }
      var data = await response.json();
      rows = (data && (data.bookings || data.rows)) || [];
    } catch (err) {
      note("Could not load the day.", true);
      return;
    }

    var mapped = mappableStops(rows);
    if (!mapped.stops.length) {
      note(rows.length ? "Nothing on this day has an address the map can place." : "Nothing booked on this day.", false);
      return;
    }

    try {
      await mapsReady();
    } catch (err) {
      note(err.message, true);
      return;
    }

    state.map = new google.maps.Map(mapBox, {
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      // Inside the app this map sits above a scrolling list. Greedy
      // gestures would swallow the scroll that is trying to get past it.
      gestureHandling: "greedy",
      zoom: 11,
      center: mapped.stops[0].coords
    });
    state.info = new google.maps.InfoWindow();

    var bounds = new google.maps.LatLngBounds();
    state.markers = new Map();

    mapped.stops.forEach(function (stop) {
      var marker = new google.maps.Marker({
        position: stop.coords,
        map: state.map,
        icon: pinIcon(stop),
        zIndex: stop.done ? 2 : 3,
        // A finished stop wears a tick instead of its number. The number
        // is still on the card beside it; what the map is for at 2pm is
        // seeing at a glance which houses are behind you.
        label: {
          text: stop.done ? "✓" : String(stop.number),
          color: "#ffffff",
          fontSize: stop.done ? "13px" : "12px",
          fontWeight: "700"
        },
        title: (stop.done ? "Done · " : "Stop ") + stop.number + " · " + stop.address
      });
      marker.addListener("click", function () {
        focusStop(stop.key, true);
        tellHost({ type: "stop", key: stop.key, number: stop.number, done: stop.done });
      });
      state.markers.set(stop.key, { marker: marker, stop: stop });
      bounds.extend(stop.coords);
    });

    var line = await drawLine(mapped.stops);
    if (line && line.origin && line.origin.lat != null) {
      new google.maps.Marker({
        position: line.origin, map: state.map, icon: yardIcon(), zIndex: 1,
        label: { text: "Y", color: "#FAFAF5", fontSize: "11px", fontWeight: "700" },
        title: "Yard"
      });
      bounds.extend(line.origin);
    }
    var path = line ? toPath(line.coords) : [];
    if (path.length >= 2) {
      var roads = isRoadLine(line.source);
      state.line = new google.maps.Polyline({
        path: path,
        map: state.map,
        strokeColor: roads ? AM_GREEN : "#7A7A72",
        strokeOpacity: roads ? 0.85 : 0,
        strokeWeight: roads ? 4 : 2,
        // A straight-hop fallback is drawn as dots, never as a road it is
        // not. route-geometry.js fails soft on purpose; this is the half
        // of that promise the screen has to keep.
        icons: roads
          ? undefined
          : [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.7, scale: 3 }, offset: "0", repeat: "12px" }],
        zIndex: 0
      });
    }

    state.map.fitBounds(bounds, 40);

    var messages = [];
    if (mapped.skipped) {
      messages.push(mapped.skipped + (mapped.skipped === 1 ? " stop has" : " stops have") + " no map location");
    }
    if (path.length >= 2 && !isRoadLine(line.source)) messages.push("straight hops, not roads");
    if (path.length < 2) messages.push("no route line");
    note(messages.join(" · "), false);

    tellHost({ type: "ready", stops: mapped.stops.length, skipped: mapped.skipped });
  }

  // The host talks back: the app asks for a redraw when a work order is
  // completed, and highlights the pin for whichever card is tapped.
  function hostMessage(event) {
    var message;
    try { message = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch (err) { return; }
    if (!message || typeof message !== "object") return;
    if (message.type === "refresh") { draw(); return; }
    if (message.type === "focus") { focusStop(message.key || null, false); }
  }
  window.addEventListener("message", hostMessage);
  document.addEventListener("message", hostMessage);   // Android WebView

  draw();
})();
