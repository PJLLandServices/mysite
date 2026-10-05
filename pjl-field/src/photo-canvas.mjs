// The two in-app canvases for photos (PJL-112): the markup editor and the
// on-phone shrink. Both are pages run inside react-native-webview — the
// same technique as the signature pad, so they ship over the air with no
// native change (the installed build has no image-manipulator and no
// PencilKit).
//
// KEPT APART ON PURPOSE (Patrick, 2026-10-04): markup and shrinking ship
// and fail independently. Markup works on whatever photo it is given;
// shrinking is its own page, its own component (PhotoShrinker.js) and its
// own switch (the server's fieldOffline.photoShrink). If resizing full-size
// photos misbehaves on the phone, it is switched off and markup is
// untouched.
//

// The server keeps 2400 px on the long edge (WO_PHOTO_MAX_EDGE), so
// nothing above that is ever seen.
export const MAX_EDGE = 2400;
// A marked-up photo is saved at 0.85: the drawing has to stay crisp.
export const MARKUP_QUALITY = 0.85;
// A shrunk photo is saved at 0.75. Measured on a real 4032×3024 iPhone
// photo (scripts/test-photo-canvas.mjs): at 0.85 the 2400 px copy (0.80
// MB) is no smaller than the full-size photo at the picker's 0.40 (0.75
// MB), so shrinking at the planned 0.85 (D-C3) saves nothing; at 0.75 it
// is 0.60 MB. The server re-encodes at 82 whatever arrives.
export const SHRINK_QUALITY = 0.75;

// The drawing rules, as SOURCE TEXT. They run inside the WebView, not in
// React Native — and the app's engine (Hermes) does not keep a function's
// source, so `fn.toString()` cannot carry them there. The tests evaluate
// this same text (canvasLib below), so what they check is what the phone
// runs.
//
//   fitWithin(w, h, max)  the size to draw at so the long edge is ≤ max
//   markSize(kind, long)  pen widths and text size, relative to the
//                         photo's long edge, so a mark is the same size on
//                         screen and in the saved photo
//   renderMarks(ctx, img, strokes, long)  the photo and its marks, in the
//                         photo's own pixel coordinates (the caller sets the
//                         transform). Strokes: { tool: 'pen', points } |
//                         { tool: 'arrow' | 'circle', from, to } |
//                         { tool: 'text', at, text }, each with color and
//                         width ('thin' | 'thick').
export const CANVAS_LIB = String.raw`
function fitWithin(w, h, max) {
  var long = Math.max(w, h);
  var scale = long > max ? max / long : 1;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale: scale };
}
function markSize(kind, longEdge) {
  var k = { thin: 0.004, thick: 0.009, text: 0.045 }[kind] || 0.004;
  return Math.max(1, longEdge * k);
}
function renderMarks(ctx, img, strokes, longEdge) {
  ctx.drawImage(img, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (var i = 0; i < strokes.length; i++) {
    var s = strokes[i];
    var lw = markSize(s.width, longEdge);
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = lw;
    if (s.tool === 'pen' && s.points.length) {
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (var j = 1; j < s.points.length; j++) ctx.lineTo(s.points[j].x, s.points[j].y);
      if (s.points.length === 1) ctx.lineTo(s.points[0].x + 0.1, s.points[0].y);
      ctx.stroke();
    } else if (s.tool === 'arrow') {
      var dx = s.to.x - s.from.x, dy = s.to.y - s.from.y;
      var angle = Math.atan2(dy, dx);
      var head = Math.max(lw * 4, Math.min(Math.hypot(dx, dy) * 0.35, lw * 9));
      ctx.beginPath();
      ctx.moveTo(s.from.x, s.from.y);
      ctx.lineTo(s.to.x, s.to.y);
      for (var side = -1; side <= 1; side += 2) {
        ctx.moveTo(s.to.x, s.to.y);
        ctx.lineTo(s.to.x - head * Math.cos(angle + side * 0.45), s.to.y - head * Math.sin(angle + side * 0.45));
      }
      ctx.stroke();
    } else if (s.tool === 'circle') {
      var cx = (s.from.x + s.to.x) / 2, cy = (s.from.y + s.to.y) / 2;
      var rx = Math.max(lw, Math.abs(s.to.x - s.from.x) / 2), ry = Math.max(lw, Math.abs(s.to.y - s.from.y) / 2);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.tool === 'text' && s.text) {
      var size = markSize('text', longEdge);
      ctx.font = 'bold ' + size + 'px -apple-system, Helvetica, Arial, sans-serif';
      ctx.textBaseline = 'middle';
      // A dark outline keeps a white or yellow label readable on grass,
      // gravel or sky.
      ctx.lineWidth = size * 0.16;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(s.text, s.at.x, s.at.y);
      ctx.fillText(s.text, s.at.x, s.at.y);
    }
  }
}
`;
// For the tests: the same text, evaluated.
export const canvasLib = () => new Function(`${CANVAS_LIB}; return { fitWithin: fitWithin, markSize: markSize, renderMarks: renderMarks };`)();

const shared = `var MAX_EDGE = ${MAX_EDGE}, MARKUP_QUALITY = ${MARKUP_QUALITY}, SHRINK_QUALITY = ${SHRINK_QUALITY};
${CANVAS_LIB}
function post(msg) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
function listen(fn) {
  var handle = function (ev) { var m; try { m = JSON.parse(String(ev.data || '')); } catch (_) { return; } fn(m); };
  document.addEventListener('message', handle); // iOS
  window.addEventListener('message', handle);   // Android
}`;

// ---- The markup editor -------------------------------------------------------
//
// The photo is shown fitted to the screen; marks are kept as a list in the
// photo's own pixel coordinates, so undo pops one and reset clears them,
// and nothing is flattened until export. Export draws the photo and the
// marks once, at the photo's size capped at 2400 px, as JPEG 0.85 — the
// only full-size canvas, freed straight after.
//
// In:  { type: 'load', src } · { type: 'tool', tool, color, width }
//      { type: 'text', at, text } · { type: 'undo' } · { type: 'reset' }
//      { type: 'export' }
// Out: ready · loaded {width,height} · loadError · marks {count}
//      textAt {at} · exported {data,width,height} · exportError
export const EDITOR_HTML = `<!doctype html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  html,body { margin:0; padding:0; height:100%; background:#000; overscroll-behavior:none; overflow:hidden; }
  canvas { display:block; width:100%; height:100%; touch-action:none; }
</style>
</head><body>
<canvas id="c"></canvas>
<script>
${shared}
var c = document.getElementById('c');
var ctx = c.getContext('2d');
var img = new Image();
var loaded = false, strokes = [], current = null;
var tool = 'pen', color = '#E5322D', width = 'thick';
var view = { s: 1, ox: 0, oy: 0, dpr: 1 };
function longEdge() { return Math.max(img.naturalWidth, img.naturalHeight); }
function layout() {
  var r = c.getBoundingClientRect();
  view.dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.floor(r.width * view.dpr));
  c.height = Math.max(1, Math.floor(r.height * view.dpr));
  if (!loaded) return;
  view.s = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  view.ox = (r.width - img.naturalWidth * view.s) / 2;
  view.oy = (r.height - img.naturalHeight * view.s) / 2;
  draw();
}
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  if (!loaded) return;
  var k = view.dpr * view.s;
  ctx.setTransform(k, 0, 0, k, view.dpr * view.ox, view.dpr * view.oy);
  renderMarks(ctx, img, current ? strokes.concat([current]) : strokes, longEdge());
}
function at(e) {
  var r = c.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.ox) / view.s, y: (e.clientY - r.top - view.oy) / view.s };
}
window.addEventListener('resize', layout);
c.addEventListener('pointerdown', function (e) {
  if (!loaded) return;
  e.preventDefault();
  var p = at(e);
  if (tool === 'text') { post({ type: 'textAt', at: p }); return; }
  try { c.setPointerCapture(e.pointerId); } catch (_) {}
  current = tool === 'pen' ? { tool: 'pen', color: color, width: width, points: [p] } : { tool: tool, color: color, width: width, from: p, to: p };
  draw();
});
c.addEventListener('pointermove', function (e) {
  if (!current) return;
  e.preventDefault();
  var p = at(e);
  if (current.tool === 'pen') current.points.push(p); else current.to = p;
  draw();
});
function end() {
  if (!current) return;
  strokes.push(current);
  current = null;
  draw();
  post({ type: 'marks', count: strokes.length });
}
c.addEventListener('pointerup', end);
c.addEventListener('pointercancel', end);
listen(function (m) {
  if (m.type === 'load') {
    img.onload = function () { loaded = true; layout(); post({ type: 'loaded', width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = function () { post({ type: 'loadError' }); };
    img.src = m.src;
  } else if (m.type === 'tool') {
    tool = m.tool || tool; color = m.color || color; width = m.width || width;
  } else if (m.type === 'text') {
    if (m.text) strokes.push({ tool: 'text', color: color, width: width, at: m.at, text: String(m.text).slice(0, 80) });
    draw(); post({ type: 'marks', count: strokes.length });
  } else if (m.type === 'undo') {
    strokes.pop(); draw(); post({ type: 'marks', count: strokes.length });
  } else if (m.type === 'reset') {
    strokes = []; draw(); post({ type: 'marks', count: 0 });
  } else if (m.type === 'export') {
    try {
      var f = fitWithin(img.naturalWidth, img.naturalHeight, MAX_EDGE);
      var off = document.createElement('canvas');
      off.width = f.width; off.height = f.height;
      var octx = off.getContext('2d');
      octx.setTransform(f.scale, 0, 0, f.scale, 0, 0);
      renderMarks(octx, img, strokes, longEdge());
      var data = off.toDataURL('image/jpeg', MARKUP_QUALITY);
      off.width = off.height = 0;
      post({ type: 'exported', data: data, width: f.width, height: f.height });
    } catch (err) { post({ type: 'exportError', message: String(err && err.message || err) }); }
  }
});
layout();
post({ type: 'ready' });
</script>
</body></html>`;

// ---- The shrink page ---------------------------------------------------------
//
// One photo in, the same photo at most 2400 px on its long edge out, as
// JPEG 0.75 (SHRINK_QUALITY). Answers `same` — keep the original — when it is already that
// small, or when the result would not be smaller than what came in. A
// photo the WebView cannot decode answers `error`, and the original goes
// up untouched.
//
// In:  { type: 'shrink', id, src, bytes } · Out: ready · shrunk {id, data?, same?, error?, width, height}
export const SHRINK_HTML = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<script>
${shared}
listen(function (m) {
  if (m.type !== 'shrink') return;
  var img = new Image();
  img.onload = function () {
    try {
      var f = fitWithin(img.naturalWidth, img.naturalHeight, MAX_EDGE);
      if (f.scale >= 1) { post({ type: 'shrunk', id: m.id, same: true, width: img.naturalWidth, height: img.naturalHeight }); return; }
      var off = document.createElement('canvas');
      off.width = f.width; off.height = f.height;
      off.getContext('2d').drawImage(img, 0, 0, f.width, f.height);
      var data = off.toDataURL('image/jpeg', SHRINK_QUALITY);
      off.width = off.height = 0;
      var outBytes = Math.round((data.length - data.indexOf(',') - 1) * 0.75);
      if (m.bytes && outBytes >= m.bytes) { post({ type: 'shrunk', id: m.id, same: true, width: img.naturalWidth, height: img.naturalHeight }); return; }
      post({ type: 'shrunk', id: m.id, data: data, width: f.width, height: f.height });
    } catch (err) { post({ type: 'shrunk', id: m.id, error: String(err && err.message || err) }); }
  };
  img.onerror = function () { post({ type: 'shrunk', id: m.id, error: 'decode' }); };
  img.src = m.src;
});
post({ type: 'ready' });
</script>
</body></html>`;
