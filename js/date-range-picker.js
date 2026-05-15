// PJL Date-Range Picker — Expedia-style two-date range selection.
//
// Used by /admin/schedule for the "Block off time" dialog so Patrick
// can pick a vacation range with two clicks instead of typing two
// datetime-local fields. Same month-grid pattern as time-picker.js,
// minus availability filtering (a range picker just needs valid
// dates).
//
// Contract:
//   mountDateRangePicker(rootEl, {
//     initialMonth: "YYYY-MM" | Date,    // default = current month
//     currentDate: Date,                  // "today" override for tests
//     allowPast: boolean,                 // default false; vacation in
//                                         // the past usually nonsense
//     onChange: ({start, end}) => void,   // fires when BOTH dates set
//     minNights: number                   // default 0 (same-day allowed)
//   })
//
// Returns a destroy() function. Idempotent on the same root: a second
// call tears down the previous instance first. Read state any time via
// rootEl.__rangeGet() which returns { start: Date|null, end: Date|null }.

(function () {
  if (window.mountDateRangePicker) return;

  const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  function localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  function parseDateKey(key) {
    const [y, m, d] = String(key).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }
  function monthGridRange(year, month) {
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const from = new Date(year, month, 1 - startOffset);
    const to = new Date(from);
    to.setDate(from.getDate() + 41);
    return { from, to };
  }
  function dateAtMidnight(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function mountDateRangePicker(rootEl, opts = {}) {
    if (!rootEl || rootEl.nodeType !== 1) {
      throw new Error("mountDateRangePicker: rootEl must be an element");
    }
    if (typeof rootEl.__rangeDestroy === "function") {
      try { rootEl.__rangeDestroy(); } catch (_) {}
    }

    const today = opts.currentDate instanceof Date ? dateAtMidnight(opts.currentDate) : dateAtMidnight(new Date());
    const allowPast = opts.allowPast === true;
    const onChange = typeof opts.onChange === "function" ? opts.onChange : null;
    const minNights = Number.isFinite(opts.minNights) ? Math.max(0, opts.minNights) : 0;

    // Resolve initial month.
    let initialDate;
    if (opts.initialMonth instanceof Date) {
      initialDate = new Date(opts.initialMonth);
    } else if (typeof opts.initialMonth === "string" && /^\d{4}-\d{2}/.test(opts.initialMonth)) {
      const [y, m] = opts.initialMonth.split("-").map(Number);
      initialDate = new Date(y, (m || 1) - 1, 1);
    } else {
      initialDate = new Date(today);
    }
    let viewYear = initialDate.getFullYear();
    let viewMonth = initialDate.getMonth();

    // State: rangeStart and rangeEnd are Date objects (local midnight).
    // hoverDate is the cell currently being previewed when only start
    // is set — paints the in-progress range across the grid.
    let rangeStart = null;
    let rangeEnd = null;
    let hoverDate = null;
    let destroyed = false;

    rootEl.innerHTML = "";
    rootEl.classList.add("drp");
    const wrap = document.createElement("div");
    wrap.className = "drp-wrap";
    wrap.innerHTML = `
      <header class="drp-header">
        <button type="button" class="drp-nav drp-nav-prev" aria-label="Previous month">‹</button>
        <h3 class="drp-month-label" data-month-label></h3>
        <button type="button" class="drp-nav drp-nav-next" aria-label="Next month">›</button>
      </header>
      <div class="drp-weekdays" aria-hidden="true">
        ${WEEKDAY_LETTERS.map((l) => `<span>${l}</span>`).join("")}
      </div>
      <div class="drp-grid" data-grid role="grid"></div>
      <p class="drp-hint" data-hint></p>
    `;
    rootEl.appendChild(wrap);

    const monthLabelEl = wrap.querySelector("[data-month-label]");
    const gridEl = wrap.querySelector("[data-grid]");
    const hintEl = wrap.querySelector("[data-hint]");
    const prevBtn = wrap.querySelector(".drp-nav-prev");
    const nextBtn = wrap.querySelector(".drp-nav-next");

    function canNavigatePrev() {
      if (allowPast) return true;
      const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const firstOfView = new Date(viewYear, viewMonth, 1);
      return firstOfView.getTime() > firstOfThisMonth.getTime();
    }

    function renderHeader() {
      monthLabelEl.textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;
      prevBtn.disabled = !canNavigatePrev();
    }

    function renderHint() {
      if (rangeStart && rangeEnd) {
        const days = Math.round((rangeEnd - rangeStart) / 86400000) + 1;
        const fmt = (d) => d.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
        hintEl.textContent = `${fmt(rangeStart)} → ${fmt(rangeEnd)} · ${days} day${days === 1 ? "" : "s"}`;
      } else if (rangeStart) {
        hintEl.textContent = "Pick the last day of the range.";
      } else {
        hintEl.textContent = "Pick the first day of the range.";
      }
    }

    // Is `cell` part of the currently-selected (or in-progress) range?
    function cellInRange(cell) {
      if (!rangeStart) return false;
      const lo = rangeStart;
      const hi = rangeEnd || hoverDate || rangeStart;
      const [a, b] = lo <= hi ? [lo, hi] : [hi, lo];
      return cell >= a && cell <= b;
    }

    function renderGrid() {
      const { from } = monthGridRange(viewYear, viewMonth);
      gridEl.innerHTML = "";
      for (let i = 0; i < 42; i++) {
        const cellDate = new Date(from);
        cellDate.setDate(from.getDate() + i);
        cellDate.setHours(0, 0, 0, 0);
        const key = localDateKey(cellDate);
        const inThisMonth = cellDate.getMonth() === viewMonth;
        const inPast = !allowPast && cellDate.getTime() < today.getTime();

        const classes = ["drp-day"];
        if (!inThisMonth) classes.push("is-other-month");
        if (isSameDay(cellDate, today)) classes.push("is-today");
        if (inPast) classes.push("is-disabled");

        // Range painting
        const isStart = rangeStart && isSameDay(cellDate, rangeStart);
        const isEnd = rangeEnd && isSameDay(cellDate, rangeEnd);
        if (isStart) classes.push("is-range-start");
        if (isEnd) classes.push("is-range-end");
        if (cellInRange(cellDate) && !isStart && !isEnd) classes.push("is-in-range");
        if (isStart && isEnd) classes.push("is-range-single");

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = classes.join(" ");
        btn.dataset.date = key;
        btn.textContent = String(cellDate.getDate());
        if (inPast) btn.disabled = true;
        gridEl.appendChild(btn);
      }
    }

    function commit() {
      if (typeof onChange === "function") {
        onChange({
          start: rangeStart ? new Date(rangeStart) : null,
          end: rangeEnd ? new Date(rangeEnd) : null
        });
      }
    }

    // Class-only repaint that updates the visual range state WITHOUT
    // rebuilding the grid DOM. Critical on iPhone Safari: the previous
    // implementation tore down + rebuilt the entire grid on every
    // mouseover, so after the first tap the synthetic mouseover fired
    // before the synthetic click could land — the click target was a
    // stale DOM node and the second click never registered.
    // Re-use this from click AND hover; only month navigation needs a
    // full renderGrid() rebuild.
    function paintRange() {
      const cells = gridEl.querySelectorAll(".drp-day");
      cells.forEach((btn) => {
        if (btn.disabled) return;
        const key = btn.dataset.date;
        if (!key) return;
        const cellDate = parseDateKey(key);
        cellDate.setHours(0, 0, 0, 0);
        const isStart = rangeStart && isSameDay(cellDate, rangeStart);
        const isEnd = rangeEnd && isSameDay(cellDate, rangeEnd);
        const inRange = cellInRange(cellDate);
        btn.classList.toggle("is-range-start", Boolean(isStart));
        btn.classList.toggle("is-range-end", Boolean(isEnd));
        btn.classList.toggle("is-range-single", Boolean(isStart && isEnd));
        btn.classList.toggle("is-in-range", Boolean(inRange && !isStart && !isEnd));
      });
    }

    function handleCellClick(cell) {
      // Three states: nothing → start; start only → end (with swap); both → reset to new start.
      if (!rangeStart || (rangeStart && rangeEnd)) {
        rangeStart = cell;
        rangeEnd = null;
        hoverDate = null;
      } else {
        // rangeStart set, no rangeEnd yet — this click ends the range.
        if (cell.getTime() < rangeStart.getTime()) {
          // User clicked an earlier date than the start; swap.
          rangeEnd = rangeStart;
          rangeStart = cell;
        } else {
          rangeEnd = cell;
        }
        // Enforce minNights (rare; default 0 = same-day allowed).
        if (minNights > 0) {
          const span = Math.round((rangeEnd - rangeStart) / 86400000);
          if (span < minNights) {
            rangeEnd = new Date(rangeStart.getTime() + minNights * 86400000);
          }
        }
      }
      paintRange();
      renderHint();
      commit();
    }

    // Detect touch-capable devices so we can skip the hover handlers
    // entirely. On iOS, mouseover fires synthetically after every tap;
    // even with the class-only paint above, skipping the work is cheaper
    // and clearer.
    const hasTouch = typeof window !== "undefined"
      && ("ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0);

    // Wire interactions.
    prevBtn.addEventListener("click", () => {
      if (!canNavigatePrev()) return;
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      renderHeader();
      renderGrid();           // month changed → cells change → full rebuild
    });
    nextBtn.addEventListener("click", () => {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderHeader();
      renderGrid();           // month changed → cells change → full rebuild
    });
    gridEl.addEventListener("click", (event) => {
      const btn = event.target.closest(".drp-day");
      if (!btn || btn.disabled) return;
      const key = btn.dataset.date;
      if (!key) return;
      handleCellClick(parseDateKey(key));
    });
    if (!hasTouch) {
      gridEl.addEventListener("mouseover", (event) => {
        // Hover preview only matters when we have a start but no end yet.
        if (!rangeStart || rangeEnd) return;
        const btn = event.target.closest(".drp-day");
        if (!btn || btn.disabled) return;
        const key = btn.dataset.date;
        if (!key) return;
        const nextHover = parseDateKey(key);
        if (hoverDate && isSameDay(nextHover, hoverDate)) return;
        hoverDate = nextHover;
        paintRange();
      });
      gridEl.addEventListener("mouseleave", () => {
        if (!hoverDate) return;
        hoverDate = null;
        paintRange();
      });
    }

    // First paint.
    renderHeader();
    renderGrid();
    renderHint();

    // Expose a reader so callers can fetch state without re-instantiating.
    rootEl.__rangeGet = () => ({
      start: rangeStart ? new Date(rangeStart) : null,
      end: rangeEnd ? new Date(rangeEnd) : null
    });

    function destroy() {
      destroyed = true;
      rootEl.innerHTML = "";
      rootEl.classList.remove("drp");
      delete rootEl.__rangeDestroy;
      delete rootEl.__rangeGet;
    }
    rootEl.__rangeDestroy = destroy;
    return destroy;
  }

  window.mountDateRangePicker = mountDateRangePicker;
})();
