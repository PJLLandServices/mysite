// Season plan review — /admin/season-plan
//
// Three jobs, in the order they matter:
//   1. Import the generated plan and show what it resolved to.
//   2. Show what did NOT resolve, loudly. A property code with no record
//      behind it is a stop that will quietly not exist.
//   3. Probe an address, so the geography filter's arithmetic is visible
//      rather than a thing you have to trust.
//
// Moving a stop between days/buckets is the only edit offered. The plan
// is regenerated every season from live data, so a richer editor would
// be maintained for no one.

(function seasonPlanPage() {
  const el = (id) => document.getElementById(id);
  const seasonSelect = el("seasonSelect");
  const yearSelect = el("yearSelect");
  const planMeta = el("planMeta");
  const dayList = el("dayList");
  const emptyState = el("emptyState");
  const problemsPanel = el("problemsPanel");
  const problemsList = el("problemsList");
  const toast = el("toast");

  let current = null;

  // ---- Year options: this year and the next two. The plan is a
  // forward-looking artifact; there is no reason to offer history.
  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y <= thisYear + 2; y++) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    yearSelect.appendChild(opt);
  }
  yearSelect.value = String(thisYear);

  function showToast(message, tone = "ok") {
    toast.textContent = message;
    toast.className = `sp-toast is-${tone}`;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.hidden = true; }, 4200);
  }

  function base() {
    return `/api/season-plans/${seasonSelect.value}/${yearSelect.value}`;
  }

  // ---- Render ------------------------------------------------------

  function stopRow(stop, date, bucket, arrival) {
    const li = document.createElement("li");
    li.className = `sp-stop${stop.resolved ? "" : " is-unresolved"}`;
    li.dataset.code = stop.code;

    // Stop number and arrival estimate. Both admin-facing only — the
    // customer is told a bucket and never a minute, which is what makes
    // reordering free. The number comes from the sequencer, not from the
    // row's position, so it stays true even if this list were ever
    // rendered in another order.
    const lead = document.createElement("div");
    lead.className = "sp-stop-lead";
    if (stop.stopNumber) {
      const n = document.createElement("span");
      n.className = "sp-stop-num";
      n.textContent = stop.stopNumber;
      n.setAttribute("aria-label", `Stop ${stop.stopNumber}`);
      lead.appendChild(n);
    }
    if (arrival) {
      const when = document.createElement("span");
      when.className = "sp-stop-time";
      when.textContent = arrival.arriveAt;
      when.title = `${arrival.driveMinutes} min drive, ${arrival.onSiteMinutes} min on site`;
      lead.appendChild(when);
    }
    if (lead.childNodes.length) li.appendChild(lead);

    // Street line first, the rest underneath. The panel is 360px wide, so a
    // full "90 Oriole Drive, East Gwillimbury, ON, Canada" on one line wraps
    // to three and a seven-stop day stops being scannable. One customer can
    // hold many properties (Willowridge has 14), so the address still leads —
    // it is the identifying fact, not the name.
    const main = document.createElement("div");
    main.className = "sp-stop-main";
    const parts = String(stop.address || "").split(",").map((x) => x.trim()).filter(Boolean);
    const street = document.createElement("span");
    street.className = "sp-stop-who";
    street.textContent = stop.resolved ? (parts[0] || "no address") : stop.problem;
    street.title = stop.resolved ? stop.address : stop.problem;
    main.appendChild(street);

    const sub = document.createElement("span");
    sub.className = "sp-stop-sub";
    // The property code goes in the tooltip, not the line: at this width it
    // was being ellipsised away mid-name anyway, and the name is what tells
    // you at a glance whose driveway this is.
    sub.textContent = [parts[1], stop.customerName].filter(Boolean).join(" · ");
    sub.title = [stop.code, stop.address].filter(Boolean).join(" — ");
    main.appendChild(sub);
    li.appendChild(main);

    const meta = document.createElement("div");
    meta.className = "sp-stop-meta";
    if (stop.resolved) {
      const zones = document.createElement("span");
      zones.className = stop.zonesEstimated ? "sp-tag is-warn" : "sp-tag";
      zones.textContent = stop.zonesEstimated ? "zones unknown" : `${stop.zones} zones`;
      meta.appendChild(zones);
      if (stop.minutes) {
        const mins = document.createElement("span");
        mins.className = "sp-tag";
        mins.textContent = `${stop.minutes} min`;
        meta.appendChild(mins);
      }
      if (!stop.hasCoords) {
        const geo = document.createElement("span");
        geo.className = "sp-tag is-bad";
        geo.textContent = "no coordinates";
        meta.appendChild(geo);
      }
      meta.appendChild(moveControl(stop, date, bucket));
    }
    li.appendChild(meta);
    return li;
  }

  function moveControl(stop, fromDate, fromBucket) {
    const select = document.createElement("select");
    select.className = "sp-move";
    select.setAttribute("aria-label", `Move ${stop.code}`);
    const head = document.createElement("option");
    head.value = "";
    head.textContent = "Move to…";
    select.appendChild(head);
    for (const day of current.days) {
      for (const bucket of ["morning", "afternoon"]) {
        if (day.date === fromDate && bucket === fromBucket) continue;
        const opt = document.createElement("option");
        opt.value = `${day.date}|${bucket}`;
        opt.textContent = `${day.label || day.date} · ${bucket}`;
        select.appendChild(opt);
      }
    }
    select.addEventListener("change", async () => {
      if (!select.value) return;
      const [toDate, toBucket] = select.value.split("|");
      select.disabled = true;
      try {
        const response = await fetch(`${base()}/move`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ propertyCode: stop.code, toDate, toBucket })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error((data.errors || ["Move failed."]).join(" "));
        render(data.plan);
        showToast(`${stop.code} moved to ${toDate} ${toBucket}.`);
      } catch (error) {
        showToast(error.message, "bad");
        select.disabled = false;
        select.value = "";
      }
    });
    return select;
  }

  function bucketBlock(day, bucket) {
    const stops = day[bucket];
    const wrap = document.createElement("div");
    wrap.className = "sp-bucket";

    const head = document.createElement("h4");
    head.className = "sp-bucket-head";
    const over = stops.length > current.bucketCap;
    head.innerHTML = `<span>${bucket === "morning" ? "Morning" : "Afternoon"}</span>`;
    const count = document.createElement("span");
    count.className = `sp-count${over ? " is-over" : ""}`;
    count.textContent = `${stops.length} / ${current.bucketCap}`;
    head.appendChild(count);
    wrap.appendChild(head);

    if (!stops.length) {
      const none = document.createElement("p");
      none.className = "sp-bucket-empty";
      none.textContent = "Open — room for standby or a new customer.";
      wrap.appendChild(none);
      return wrap;
    }
    const list = document.createElement("ul");
    list.className = "sp-stops";
    const arrivals = new Map((day.timeline || []).map((t) => [t.propertyCode, t]));
    stops.forEach((stop) => list.appendChild(stopRow(stop, day.date, bucket, arrivals.get(stop.code))));
    wrap.appendChild(list);
    return wrap;
  }

  function dayCard(day) {
    const card = document.createElement("section");
    card.className = "sp-day";

    const head = document.createElement("header");
    head.className = "sp-day-head";
    const title = document.createElement("div");
    // The DATE, not just the weekday. It was missing, which was survivable
    // when a day could not move and is not now: you cannot reschedule a day
    // you cannot see the date of.
    title.innerHTML = `<h3>${day.label || "—"} · ${day.weekday}, ${prettyDate(day.date)}</h3>`;
    title.appendChild(rescheduleControl(day));
    if (day.territory) {
      const t = document.createElement("p");
      t.className = "sp-day-territory";
      t.textContent = day.territory;
      title.appendChild(t);
    }
    head.appendChild(title);

    const stats = document.createElement("div");
    stats.className = "sp-day-stats";
    const total = document.createElement("span");
    total.className = `sp-count${day.counts.total > current.dayCap ? " is-over" : ""}`;
    total.textContent = `${day.counts.total} / ${current.dayCap} stops`;
    stats.appendChild(total);
    const hours = document.createElement("span");
    hours.className = "sp-tag";
    const h = Math.floor(day.onSiteMinutes / 60);
    const m = day.onSiteMinutes % 60;
    hours.textContent = `${h}h ${String(m).padStart(2, "0")}m on site`;
    stats.appendChild(hours);
    if (day.driveMinutes != null) {
      const drive = document.createElement("span");
      drive.className = "sp-tag";
      drive.textContent = `${day.driveMinutes} min driving`;
      stats.appendChild(drive);
    }
    if (day.homeAt) {
      const home = document.createElement("span");
      home.className = "sp-tag";
      home.textContent = `home ${day.homeAt}`;
      stats.appendChild(home);
    }
    // The noon rule, shown as a fact rather than buried in a warning list.
    if (day.morningEndsAt) {
      const overruns = (day.flags || []).some((f) => f.code === "morning_overruns");
      const am = document.createElement("span");
      am.className = overruns ? "sp-tag is-bad" : "sp-tag";
      am.textContent = `morning ends ${day.morningEndsAt}`;
      stats.appendChild(am);
    }
    head.appendChild(stats);
    card.appendChild(head);

    const notes = [...(day.flags || []), ...(day.suggestions || [])];
    if (notes.length) {
      const strip = document.createElement("ul");
      strip.className = "sp-day-notes";
      for (const n of notes) {
        const li = document.createElement("li");
        li.className = n.code === "morning_overruns" ? "is-bad"
          : n.code === "bucket_move_suggested" ? "is-suggestion" : "";
        li.textContent = n.message;
        strip.appendChild(li);
      }
      card.appendChild(strip);
    }

    // The route, drawn on the day itself. Not behind a button and not in
    // another tab: the point is seeing eleven days' shape by scrolling.
    //
    // The map is the card and the stops float over it — a live Google map,
    // so it pans and zooms and reads like the map everyone already knows.
    const body = document.createElement("div");
    body.className = "sp-daybody";

    const mapBox = document.createElement("div");
    mapBox.className = "sp-map";
    body.appendChild(mapBox);

    const panel = document.createElement("div");
    panel.className = "sp-stoppanel";

    const panelHead = document.createElement("div");
    panelHead.className = "sp-stoppanel-head";
    const panelTitle = document.createElement("div");
    const h4 = document.createElement("h4");
    h4.textContent = `${day.counts.total} stop${day.counts.total === 1 ? "" : "s"}`;
    panelTitle.appendChild(h4);
    const when = document.createElement("p");
    when.className = "sp-stoppanel-when";
    const firstArrival = (day.timeline || [])[0];
    when.textContent = firstArrival && day.homeAt
      ? `${firstArrival.arriveAt} – ${day.homeAt}`
      : "not sequenced";
    panelTitle.appendChild(when);
    panelHead.appendChild(panelTitle);

    // Turn-by-turn handoff. The Maps URL API is free and needs no key, so
    // the day goes to a phone without us building anything.
    const openRoute = googleMapsLink(day);
    if (openRoute) {
      const link = document.createElement("a");
      link.className = "sp-open-route";
      link.href = openRoute;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open route";
      panelHead.appendChild(link);
    }
    panel.appendChild(panelHead);

    const scroll = document.createElement("div");
    scroll.className = "sp-stoppanel-scroll";
    scroll.appendChild(bucketBlock(day, "morning"));
    scroll.appendChild(bucketBlock(day, "afternoon"));
    panel.appendChild(scroll);
    body.appendChild(panel);
    card.appendChild(body);

    // BUILT ON SCROLL, NOT ON LOAD. Eleven days rendering at once fired
    // eleven route requests in the same tick; the ones that lost that race
    // came back refused and the page finished half-drawn. One day at a
    // time, and only the days actually looked at.
    whenVisible(mapBox, () => drawDayMap(mapBox, scroll, day));

    return card;
  }

  function prettyDate(date) {
    const [y, m, d] = String(date || "").split("-").map(Number);
    if (!y || !m || !d) return date || "—";
    return new Date(y, m - 1, d).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
  }

  // Re-dating a day. Only this day moves — the rest of the season keeps its
  // dates, because a warm Monday does not mean a warm Friday.
  function rescheduleControl(day) {
    const wrap = document.createElement("div");
    wrap.className = "sp-reschedule";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "sp-reschedule-open";
    button.textContent = "Reschedule";

    const form = document.createElement("form");
    form.className = "sp-reschedule-form";
    form.hidden = true;
    const input = document.createElement("input");
    input.type = "date";
    input.value = day.date;
    input.required = true;
    const go = document.createElement("button");
    go.type = "submit";
    go.className = "pjl-btn pjl-btn-primary sp-reschedule-go";
    go.textContent = "Move";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "sp-reschedule-cancel";
    cancel.textContent = "Cancel";
    form.appendChild(input); form.appendChild(go); form.appendChild(cancel);

    button.addEventListener("click", () => {
      form.hidden = false; button.hidden = true; input.focus();
    });
    cancel.addEventListener("click", () => {
      form.hidden = true; button.hidden = false; input.value = day.date;
    });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const toDate = input.value;
      if (!toDate || toDate === day.date) { cancel.click(); return; }
      go.disabled = true;
      try {
        const response = await fetch(`${base()}/day`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fromDate: day.date, toDate })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error((data.errors || ["Move failed."]).join(" "));
        render(data.plan);
        const moved = data.moved || {};
        // Saturdays and Sundays are allowed but said out loud, because
        // landing on one by accident reads exactly like landing on one on
        // purpose until somebody drives out on a Sunday.
        showToast(`${moved.label || "Day"} moved to ${prettyDate(toDate)}.`
          + (moved.weekend ? " That is a weekend." : ""), moved.weekend ? "warn" : "ok");
      } catch (error) {
        showToast(error.message, "bad");
        go.disabled = false;
      }
    });

    wrap.appendChild(button);
    wrap.appendChild(form);
    return wrap;
  }

  // ---- Map ---------------------------------------------------------
  //
  // Google Maps JavaScript API. The basemap, the labels and the road styling
  // are Google's, which is the point — this screen is read at a glance and a
  // desaturated substitute made it harder, not cleaner.
  //
  // The browser key comes from /api/maps-config rather than the HTML, and the
  // ROAD LINE is fetched from our own server, already cached: that keeps the
  // server key server-side and costs one Directions call per route change
  // instead of one per page view.

  let mapsPromise = null;
  function mapsReady() {
    if (mapsPromise) return mapsPromise;
    mapsPromise = (async () => {
      const response = await fetch("/api/maps-config", { cache: "no-store" });
      const config = await response.json();
      if (!config.ok || !config.available) {
        throw new Error(config.reason || "No Maps browser key is configured.");
      }
      await new Promise((resolve, reject) => {
        const callback = "__pjlMapsReady";
        window[callback] = () => { delete window[callback]; resolve(); };
        const script = document.createElement("script");
        script.async = true;
        // `places` is for the probe's address autocomplete. Libraries cannot
        // be added after the fact, and this is the only script load on the
        // page, so it has to be asked for here.
        script.src = "https://maps.googleapis.com/maps/api/js"
          + `?key=${encodeURIComponent(config.key)}&libraries=places`
          + `&v=weekly&callback=${callback}`;
        // A referrer-restricted key fails here and nowhere else, so the
        // message names that first — it is the likeliest cause by far.
        script.onerror = () => reject(new Error(
          "Google Maps did not load. Check the browser key's HTTP-referrer "
          + "restriction allows this domain, and that Maps JavaScript API is on its API list."));
        document.head.appendChild(script);
      });
      // coverage-checker.js drives every other address box on the site.
      // Reusing it means this field behaves identically to the ten others
      // rather than becoming a second implementation to keep in step. It
      // skips its full-checker half when that markup is absent, which it is
      // here, and wires any input.js-address-autocomplete.
      if (typeof window.initCoverageCheck === "function") {
        try { window.initCoverageCheck(); } catch (err) {
          console.warn("[season-plan] address autocomplete:", err && err.message);
        }
      }
    })();
    return mapsPromise;
  }

  function whenVisible(el, run) {
    if (typeof IntersectionObserver !== "function") { run(); return; }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.disconnect();
        run();
      }
    }, { rootMargin: "200px" });
    observer.observe(el);
  }

  // Stops in driving order that we can actually put a pin on. A stop with no
  // coordinates still belongs in the list — it is a real job — but it cannot
  // be drawn, and pretending otherwise would move the route.
  function mappableStops(day) {
    const byCode = new Map();
    for (const bucket of ["morning", "afternoon"]) {
      for (const stop of day[bucket] || []) byCode.set(stop.code, { stop, bucket });
    }
    return (day.timeline || []).map((t) => {
      const found = byCode.get(t.propertyCode);
      if (!found || !found.stop.coords || found.stop.coords.lat == null) return null;
      return {
        code: t.propertyCode,
        number: t.stopNumber,
        bucket: found.bucket,
        arriveAt: t.arriveAt,
        address: found.stop.address || t.address || "",
        customerName: found.stop.customerName || "",
        coords: { lat: Number(found.stop.coords.lat), lng: Number(found.stop.coords.lng) }
      };
    }).filter(Boolean);
  }

  function googleMapsLink(day) {
    const stops = mappableStops(day);
    if (!stops.length) return null;
    const origin = current && current.routeOrigin;
    if (!origin || origin.lat == null) return null;
    const at = (c) => `${c.lat},${c.lng}`;
    const url = new URL("https://www.google.com/maps/dir/");
    url.searchParams.set("api", "1");
    url.searchParams.set("origin", at(origin));
    url.searchParams.set("destination", at(origin));
    // The Maps URL API takes at most nine waypoints. Our longest day is nine
    // stops, so this sits at the limit rather than past it.
    url.searchParams.set("waypoints", stops.slice(0, 9).map((s) => at(s.coords)).join("|"));
    url.searchParams.set("travelmode", "driving");
    return url.toString();
  }

  const AM_GREEN = "#1B4D2E";
  const PM_GREEN = "#4A8C5C";
  const HOT_AMBER = "#E07B24";

  function pinIcon(stop, hot) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: hot ? 15 : 13,
      fillColor: stop.bucket === "morning" ? AM_GREEN : PM_GREEN,
      fillOpacity: 1,
      strokeColor: hot ? HOT_AMBER : "#ffffff",
      strokeWeight: hot ? 3 : 2
    };
  }

  function yardIcon() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26">'
      + '<rect x="3" y="3" width="20" height="20" rx="5" fill="#0F1F14" stroke="#ffffff" stroke-width="2"/></svg>';
    return {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
      anchor: new google.maps.Point(13, 13),
      labelOrigin: new google.maps.Point(13, 13)
    };
  }

  async function drawDayMap(mapBox, listRoot, day) {
    const stops = mappableStops(day);
    if (!stops.length) { note(mapBox, "No stop on this day has coordinates to draw.", true); return; }

    try {
      await mapsReady();
    } catch (error) {
      note(mapBox, error.message, true);
      return;
    }

    const map = new google.maps.Map(mapBox, {
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      // The page scrolls past eleven of these. Without cooperative gestures a
      // scroll over a map zooms it instead of moving the page.
      gestureHandling: "cooperative",
      zoom: 10,
      center: stops[0].coords
    });

    const bounds = new google.maps.LatLngBounds();
    const info = new google.maps.InfoWindow();
    const origin = current && current.routeOrigin;
    if (origin && origin.lat != null) {
      const yard = { lat: Number(origin.lat), lng: Number(origin.lng) };
      new google.maps.Marker({
        position: yard, map, icon: yardIcon(), zIndex: 1,
        label: { text: "Y", color: "#FAFAF5", fontSize: "11px", fontWeight: "700" },
        title: `Yard — ${origin.formattedAddress || origin.address || ""}`
      });
      bounds.extend(yard);
    }

    const markers = new Map();
    for (const stop of stops) {
      const marker = new google.maps.Marker({
        position: stop.coords, map, icon: pinIcon(stop, false), zIndex: 2,
        // Two digits fit here. Google's STATIC map markers take a single
        // character, which is why stops past nine used to lose their number.
        label: { text: String(stop.number), color: "#ffffff", fontSize: "12px", fontWeight: "700" },
        title: `Stop ${stop.number} · ${stop.arriveAt || ""} · ${stop.address}`
      });
      marker.addListener("click", () => {
        info.setContent(
          `<div style="font:13px/1.45 system-ui,sans-serif;max-width:230px">`
          + `<strong>Stop ${stop.number}${stop.arriveAt ? ` · ${stop.arriveAt}` : ""}</strong><br>`
          + `${escapeHtml(stop.address)}`
          + `${stop.customerName ? `<br>${escapeHtml(stop.customerName)}` : ""}</div>`
        );
        info.open({ map, anchor: marker });
      });
      markers.set(stop.code, { marker, stop });
      bounds.extend(stop.coords);
    }
    map.fitBounds(bounds, 48);

    linkRowsToPins(listRoot, markers);
    drawRoadLine(map, day, mapBox);
  }

  // Hovering a row lights its pin and the other way round. Without it the
  // panel and the map are two lists that happen to share a card.
  function linkRowsToPins(listRoot, markers) {
    listRoot.querySelectorAll(".sp-stop").forEach((row) => {
      const entry = markers.get(row.dataset.code);
      if (!entry) return;
      const set = (on) => {
        row.classList.toggle("is-hot", on);
        entry.marker.setIcon(pinIcon(entry.stop, on));
        entry.marker.setZIndex(on ? 5 : 2);
      };
      row.addEventListener("mouseenter", () => set(true));
      row.addEventListener("mouseleave", () => set(false));
      row.addEventListener("click", () => google.maps.event.trigger(entry.marker, "click"));
      entry.marker.addListener("mouseover", () => set(true));
      entry.marker.addListener("mouseout", () => set(false));
    });
  }

  async function drawRoadLine(map, day, mapBox) {
    const url = `/api/season-plans/${seasonSelect.value}/${yearSelect.value}/route-line/${day.date}`;
    try {
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok || !Array.isArray(data.coords) || data.coords.length < 2) {
        note(mapBox, (data.errors || ["Could not draw the drive for this day."]).join(" "), true);
        return;
      }
      const straight = data.source !== "google" && data.source !== "osrm";
      const path = data.coords.map(([lat, lng]) => ({ lat, lng }));
      new google.maps.Polyline({
        map, path,
        strokeColor: straight ? "#7A7A72" : AM_GREEN,
        strokeOpacity: straight ? 0 : 0.85,
        strokeWeight: straight ? 2 : 4,
        // Dashes are drawn as repeated symbols; a solid line with opacity 0
        // plus dot symbols is how the Maps API does a dashed path.
        icons: straight ? [{
          icon: { path: "M 0,-1 0,1", strokeOpacity: 0.8, strokeWeight: 2, scale: 3 },
          offset: "0", repeat: "12px"
        }] : undefined,
        zIndex: 1
      });
      // A straight line between stops is not a drive, and a map that shows one
      // without saying so is making a claim it cannot support.
      note(mapBox, straight
        ? `Straight hops, not roads — ${data.error || "no router answered."}`
        : "Y is the yard. Numbers are stops in driving order.", straight);
    } catch (error) {
      note(mapBox, `Could not draw the drive — ${error.message}`, true);
    }
  }

  function note(mapBox, text, bad) {
    let el = mapBox.parentElement.querySelector(".sp-map-note");
    if (!el) {
      el = document.createElement("p");
      el.className = "sp-map-note";
      mapBox.parentElement.appendChild(el);
    }
    el.className = bad ? "sp-map-note is-bad" : "sp-map-note";
    el.textContent = text;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render(plan) {
    current = plan;
    dayList.innerHTML = "";
    if (!plan) {
      planMeta.textContent = "No plan loaded for this season yet.";
      emptyState.hidden = false;
      emptyState.textContent = "Import the generated route plan to seed this season.";
      problemsPanel.hidden = true;
      return;
    }
    emptyState.hidden = true;

    const stamp = plan.updatedAt || plan.generatedAt;
    const when = stamp ? new Date(stamp).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "unknown";
    const drive = plan.driveMinutes
      ? ` · ${Math.round(plan.driveMinutes / 60)}h ${plan.driveMinutes % 60}m driving across the season`
      : "";
    const overrun = (plan.overrunDays || []).length
      ? ` · ${plan.overrunDays.length} day${plan.overrunDays.length === 1 ? "" : "s"} overrun the morning`
      : "";
    planMeta.textContent =
      `${plan.totalStops} stops across ${plan.days.length} route days${drive}${overrun} · updated ${when}`
      + (plan.updatedBy ? ` by ${plan.updatedBy}` : "");

    // The anchor, stated. A route pointed at the wrong start looks exactly
    // like a route pointed at the right one, so the only defence is saying
    // out loud where every day begins and ends.
    const origin = plan.routeOrigin;
    let anchor = document.getElementById("routeAnchor");
    if (!anchor) {
      anchor = document.createElement("p");
      anchor.id = "routeAnchor";
      anchor.className = "sp-anchor";
      planMeta.insertAdjacentElement("afterend", anchor);
    }
    if (origin && origin.resolved) {
      anchor.className = "sp-anchor";
      anchor.textContent = `Every day starts and ends at ${origin.formattedAddress || origin.address}.`;
    } else if (origin) {
      anchor.className = "sp-anchor is-bad";
      anchor.textContent = `Could not locate ${origin.address} — routes are anchored to the `
        + "Newmarket town centre instead, so the order of stops may be wrong. Check the address.";
    }

    problemsList.innerHTML = "";
    if (plan.problems && plan.problems.length) {
      problemsPanel.hidden = false;
      for (const p of plan.problems) {
        const li = document.createElement("li");
        li.innerHTML = `<strong>${p.code}</strong> <span class="sp-problem-where">${p.label || p.date}</span> — ${p.problem}`;
        problemsList.appendChild(li);
      }
    } else {
      problemsPanel.hidden = true;
    }

    plan.days.forEach((day) => dayList.appendChild(dayCard(day)));
  }

  async function load() {
    dayList.innerHTML = "";
    planMeta.textContent = "Loading…";
    try {
      const response = await fetch(base(), { cache: "no-store" });
      if (response.status === 404) { render(null); return; }
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't load the plan."]).join(" "));
      render(data.plan);
    } catch (error) {
      planMeta.textContent = error.message;
      render(null);
    }
  }

  // The probe is above the day cards, so it would otherwise have no
  // autocomplete until a map scrolled into view. mapsReady() is memoised —
  // this is the same single script load, just started sooner. Loading the
  // library is not a billable map load; only `new google.maps.Map` is.
  mapsReady().catch((err) => {
    console.warn("[season-plan] maps unavailable, probe autocomplete off:", err && err.message);
  });

  // ---- Probe -------------------------------------------------------

  el("probeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const address = el("probeAddress").value.trim();
    const out = el("probeOut");
    if (!address) return;
    out.hidden = false;
    out.textContent = "Checking…";
    try {
      const response = await fetch(`${base()}/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Probe failed."]).join(" "));
      renderProbe(out, data);
    } catch (error) {
      out.textContent = error.message;
    }
  });

  function renderProbe(out, data) {
    out.innerHTML = "";
    const head = document.createElement("p");
    head.className = "sp-probe-head";
    head.textContent = data.filterSkipped
      ? `${data.address} — could not be geocoded, so the filter is skipped and every day is offered.`
      : `${data.address} — offered on ${data.routeDaysOffered} of ${data.routeDaysTotal} route days, `
        + `where inserting them costs ${data.thresholdMinutes} min of extra driving or less.`;
    out.appendChild(head);

    // Without this line the table reads as the whole answer, and a row of
    // "no" looks like the customer has been shut out of the season. They
    // have not: the filter only has an opinion about days that carry a
    // planned route.
    const rest = document.createElement("p");
    rest.className = "sp-probe-note";
    rest.textContent = "This table covers route days only. Every other open day in the season "
      + "has no planned route, so it is offered to this address as normal — a customer with no "
      + "route day still sees most of the calendar.";
    out.appendChild(rest);

    const table = document.createElement("table");
    table.className = "sp-probe-table";
    table.innerHTML = "<thead><tr><th>Route</th><th>Date</th><th>Stops</th><th>Added drive</th><th>Offered</th></tr></thead>";
    const body = document.createElement("tbody");
    for (const day of data.days) {
      const tr = document.createElement("tr");
      tr.className = day.offered ? "is-offered" : "";
      const added = day.addedDriveMinutes == null ? "—" : `${day.addedDriveMinutes} min`;
      tr.innerHTML = `<td>${day.label || "—"}</td><td>${day.date}</td><td>${day.points}</td>`
        + `<td class="sp-num">${added}</td><td>${day.offered ? "yes" : "no"}</td>`;
      body.appendChild(tr);
    }
    table.appendChild(body);
    out.appendChild(table);
  }

  // ---- Import ------------------------------------------------------

  const modal = el("importModal");
  const importText = el("importText");
  const importError = el("importError");

  function openImport() { modal.hidden = false; importError.hidden = true; importText.focus(); }
  function closeImport() { modal.hidden = true; }

  el("importBtn").addEventListener("click", openImport);
  el("importClose").addEventListener("click", closeImport);
  el("importCancel").addEventListener("click", closeImport);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeImport(); });

  el("importFile").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    importText.value = await file.text();
  });

  el("importSave").addEventListener("click", async () => {
    importError.hidden = true;
    let parsed;
    try {
      parsed = JSON.parse(importText.value);
    } catch (error) {
      importError.textContent = `That isn't valid JSON — ${error.message}`;
      importError.hidden = false;
      return;
    }
    try {
      const response = await fetch(base(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed)
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Import failed."]).join(" "));
      render(data.plan);
      closeImport();
      const warned = (data.warnings || []).length;
      showToast(warned
        ? `Imported with ${warned} warning${warned === 1 ? "" : "s"} — see Needs attention.`
        : "Plan imported.");
    } catch (error) {
      importError.textContent = error.message;
      importError.hidden = false;
    }
  });

  seasonSelect.addEventListener("change", load);
  yearSelect.addEventListener("change", load);
  load();
})();
