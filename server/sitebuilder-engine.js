/* ══════════════ System Builder — the calculation engine ══════════════

   Given a design — the areas drawn, the heads and nozzles chosen, the GPM
   ceiling, the routing off the site plan — this works out how many valves
   the job needs, how the heads fall onto them, how much flow each one
   carries, what goes in the parts list and what the materials cost.

   That is ALL it does. There is nothing here that talks to the network,
   the DOM, or a stored record:

       no fetch, no PATCH, nothing saved to a project
       no quote created, no proposal section written
       no reading of form fields, no innerHTML

   Those are the money-facing side effects, and they stay where they were,
   in the page. The reason to keep the line that sharp is that a
   calculation can be re-run a hundred times while you decide; a PATCH that
   rewrites a quote cannot. Anything that can be safely re-run lives here;
   anything that changes a record does not.

   LIFTED, NOT REWRITTEN (2026-09-21)

   Every function below was moved out of server/sitebuilder.html verbatim.
   The formulas were not touched. What changed is only how the engine gets
   the handful of things it used to reach out and take for itself:

       plan()             read the GPM ceiling and the spacing factor out
       -> computePlan()   of two <input> fields. They are arguments now.
       computeZonePlan()  read `areas`, `routing` and `valveGroupModes` as
                          page globals. It takes a design object now.
       buildBOM()         read LAST_PLANS, LAST_ZONES, a form field, and
                          called measuredLateralsBySize() — which walks the
                          routed site-plan sheets. All passed in; the sheet
                          walking stays in the page, because measuring a
                          drawing is not calculating.
       areaMaterialCents()read the loaded price list off a global. Passed in.

   Same Math.max, same parseFloat fallbacks, same arithmetic in the same
   order. Pinned by scripts/fixtures/system-design-golden.json, which was
   recorded from the OLD in-page engine before any of this moved, and which
   the extracted engine reproduces field for field, to the cent.

   Runs unchanged in the browser (as `SystemDesignEngine`) and in Node.   */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SystemDesignEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
"use strict";

// ───── Inputs the engine used to read out of the page ─────────────────
//
// `num(id)` was `parseFloat(el(id).value) || 0`. The parse and the || 0
// are kept exactly, so a blank field still means zero and the callers
// downstream see what they always saw.
const rawNum = (v) => parseFloat(v) || 0;

// The design, in the shape every entry point wants it. Tolerant of a
// half-filled object so a caller can ask for a plan without a site plan,
// a routing or a valve-group map.
function normalizeCtx(ctx) {
  ctx = ctx || {};
  return {
    plans: ctx.plans || [],
    areas: ctx.areas || [],
    routing: ctx.routing || {},
    valveGroupModes: ctx.valveGroupModes || {}
  };
}

// The plan computed for a given area, out of a list of {area, plan}.
// Identity is the area OBJECT, same as the page's own mpPlanFor().
function planFor(plans, a) { const e = (plans || []).find((x) => x.area === a); return e ? e.plan : null; }

// How a shared drip valve group is built in the ground. The page keeps the
// map; the rule that reads it lives here, once, so the page and the engine
// can never answer differently for the same group.
function valveGroupMode(modes, g) { return (g && (modes || {})[String(g)] === 'station') ? 'station' : 'shared'; }

/* ==== Head catalogs - manufacturer performance data ====
   HARD RULE: a zone never mixes head families. Rotor / spray / strip /
   drip each run on their own valves (different precipitation rates). The
   builder enforces this structurally - one family per area, zones split
   per-area. See the family partition note in compute().               */

// Hunter PGP / PGP-Ultra / I-20 gear rotor - FIXED GPM at any arc.
// Values read from Hunter's official PGP-ADJ cutsheet (CA-Cutsheet-PGP-EM)
// at 3.0 bar (~44 PSI, mid of Hunter's 1.7-4.5 bar recommended range),
// converted from metric (m x 3.281 = ft; m3/hr x 4.403 = US GPM).
// Three racks: red standard #1-#12 (ships on PGP-ADJ, 25deg), blue
// standard #1.5-#8.0 (PGP-ADJ-B / rack P/N 665300), grey low-angle (13deg).
const PGP_NOZZLES = {
  // Blue standard
  b15:{label:"#1.5 blue",     rack:"blue", r:32, g:1.5},
  b20:{label:"#2.0 blue",     rack:"blue", r:34, g:1.9},
  b25:{label:"#2.5 blue",     rack:"blue", r:35, g:2.4},
  b30:{label:"#3.0 blue",     rack:"blue", r:38, g:3.0},
  b40:{label:"#4.0 blue",     rack:"blue", r:40, g:4.0},
  b50:{label:"#5.0 blue",     rack:"blue", r:42, g:5.0},
  b60:{label:"#6.0 blue",     rack:"blue", r:43, g:6.0},
  b80:{label:"#8.0 blue",     rack:"blue", r:44, g:8.0},
  // Grey low-angle
  g20:{label:"2.0 low-angle", rack:"grey", r:27, g:2.0},
  g25:{label:"2.5 low-angle", rack:"grey", r:32, g:2.6},
  g35:{label:"3.5 low-angle", rack:"grey", r:33, g:3.3},
  g45:{label:"4.5 low-angle", rack:"grey", r:34, g:4.1},
  // Red standard (factory rack on PGP-ADJ)
  r1: {label:"#1 red",  rack:"red", r:29, g:0.7},
  r2: {label:"#2 red",  rack:"red", r:30, g:0.8},
  r3: {label:"#3 red",  rack:"red", r:31, g:1.1},
  r4: {label:"#4 red",  rack:"red", r:33, g:1.5},
  r5: {label:"#5 red",  rack:"red", r:36, g:1.9},
  r6: {label:"#6 red",  rack:"red", r:36, g:2.5},
  r7: {label:"#7 red",  rack:"red", r:38, g:3.2},
  r8: {label:"#8 red",  rack:"red", r:39, g:3.8},
  r9: {label:"#9 red",  rack:"red", r:41, g:4.6},
  r10:{label:"#10 red", rack:"red", r:44, g:6.3},
  r11:{label:"#11 red", rack:"red", r:46, g:8.4},
  r12:{label:"#12 red", rack:"red", r:47, g:11.0}
};
// Grouped <optgroup> options for the rotor nozzle selector.

// ───── Catalogs, families, tree constants, area normalization ────────
const MP_NOZZLES = {
  mp1000:{label:"MP1000", r:14, g:0.75},
  mp2000:{label:"MP2000", r:21, g:1.70},
  mp3000:{label:"MP3000", r:30, g:4.27}
};
// Rain Bird MPR fixed spray nozzles - matched precip @30 PSI. Radius by
// series; flow by pattern (q/h/f = 90/180/360). Pro-Spray body is PRS30.
const SPRAY_SERIES = {
  s8: {label:"8 ft",  r:8,  q:0.26, h:0.52, f:1.05},
  s10:{label:"10 ft", r:10, q:0.39, h:0.79, f:1.58},
  s12:{label:"12 ft", r:12, q:0.65, h:1.30, f:2.60},
  s15:{label:"15 ft", r:15, q:0.92, h:1.85, f:3.70}
};
// Pop-up body - good / better / best. Hydraulically identical; height +
// SKU drive the BOM. Inventory: Pro-Spray 4"/6"/12" PRS30.
const SPRAY_BODIES = {
  b4: {label:'4" pop (good)',  sku:"HSPROS04PRS30"},
  b6: {label:'6" pop (better)',sku:"HSPROS06SIPRS30"},
  b12:{label:'12" pop (best)', sku:"HSPROS12SIPRS30"}
};
// Rain Bird 15-series strip nozzles @30 PSI - rectangle W x L + GPM.
const STRIP_NOZZLES = {
  cst:{label:"15 CST - centre strip", w:4, len:30, g:1.21, cover:"both"},
  sst:{label:"15 SST - side strip",   w:4, len:30, g:1.21, cover:"side"},
  est:{label:"15 EST - end strip",    w:4, len:15, g:0.61, cover:"end"},
  lcs:{label:"15 LCS - left corner",  w:4, len:15, g:0.49, cover:"corner"},
  rcs:{label:"15 RCS - right corner", w:4, len:15, g:0.49, cover:"corner"},
  s9: {label:"9 SST - side strip",    w:9, len:18, g:1.73, cover:"side"}
};
// Dripline - area-wide, 12" emitter + row spacing. Inventory products.
const DRIP_PRODUCTS = {
  xf09:{label:'XF Dripline 0.9 GPH - 12" (XFDE)', gph:0.9, emitterIn:12, sku:"XFDE912250", rollFt:250, roll2:{sku:"XFDE912500", ft:500}},
  ld08:{label:'Landscape 0.8 GPH - 12" (LDQ)',    gph:0.8, emitterIn:12, sku:"LDQ0812100", rollFt:100}
};
const FAMILIES = {
  rotor:{label:"Gear rotor - Hunter PGP",        kind:"rotor"},
  mp:   {label:"MP Rotator",                     kind:"rotor"},
  spray:{label:"Pop-up spray - Pro-Spray + RB",  kind:"spray"},
  strip:{label:"Strip nozzle (narrow area)",     kind:"strip"},
  drip: {label:"Drip line (area-wide)",          kind:"drip"},
  trees:{label:"Trees (root watering)",          kind:"trees"}
};
const FAMILY_ORDER = ["rotor","mp","spray","strip","drip","trees"];
// Tree root watering. Ring = double dripline loops at the base; RWS = Rain
// Bird Root Watering System units (2 per tree). Flow numbers below drive
// zone sizing (RWS bubbler flow is nominal — confirm per install).
const TREE_RWS_SKU = "RWSMBC1402";        // Rain Bird RWS 18" (2 per tree)
const TREE_RWS_GPM_PER_UNIT = 0.5;        // nominal bubbler flow
const TREE_RING_DEFAULT_DIA = 4;          // ft, outer ring; inner = half

// Legacy v1 head keys -> v2 family selection (migrate old saved designs).
const LEGACY_HEAD_MAP = {
  pgp4:["rotor","rotorNoz","b40"], pgp2:["rotor","rotorNoz","b20"], pgp15:["rotor","rotorNoz","b15"],
  mp2000:["mp","mpNoz","mp2000"], mp3000:["mp","mpNoz","mp3000"],
  spray15:["spray","spraySeries","s15"], cst:["strip","stripNoz","cst"], drip:["drip","dripProduct","xf09"]
};

function familyDefaults(a){
  if(a.family==="rotor" && !a.rotorNoz) a.rotorNoz="b40";
  if(a.family==="mp"    && !a.mpNoz)    a.mpNoz="mp2000";
  if(a.family==="spray"){ if(!a.sprayBody) a.sprayBody="b4"; if(!a.spraySeries) a.spraySeries="s12"; }
  if(a.family==="strip"){ if(!a.stripNoz) a.stripNoz="sst"; if(!a.stripBody) a.stripBody="b4"; }
  if(a.family==="drip"){ if(!a.dripProduct) a.dripProduct="xf09"; if(a.overagePct==null) a.overagePct=10; if(a.dripRowIn==null) a.dripRowIn=18; if(!a.dripDir) a.dripDir="auto"; }
  if(a.family==="trees"){ if(!a.dripProduct) a.dripProduct="xf09"; if(a.overagePct==null) a.overagePct=10; if(!Array.isArray(a.trees)) a.trees=[]; }
}
// Stable identity, minted once and then carried in the saved design.
// Array position is NOT identity: deleting area 1 renumbers everything
// after it, and anything remembered by index would then point at the wrong
// area. Valve-box assignments are remembered, so they need a real id.
const mintId = p => p + Math.random().toString(36).slice(2,10).padEnd(8,'0');

// Normalize an area (migrate legacy head key, fill family defaults).
function ensureArea(a){
  if(!a.aid) a.aid = mintId('a_');
  if(!a.family){ const m = LEGACY_HEAD_MAP[a.head] || ["rotor","rotorNoz","b40"]; a.family=m[0]; a[m[1]]=m[2]; }
  if(!FAMILIES[a.family]) a.family="rotor";
  delete a.head; delete a.r; delete a.g;   // drop legacy v1 fields once migrated
  familyDefaults(a);
  return a;
}
// Resolve an area's effective head spec (radius/flow/kind) from selections.
function headSpec(a){
  ensureArea(a);
  if(a.family==="rotor"){ const n=PGP_NOZZLES[a.rotorNoz]||PGP_NOZZLES.b40; return {family:"rotor",kind:"rotor",matched:false,r:n.r,g:n.g,noz:n,label:"Hunter PGP "+n.label}; }
  if(a.family==="mp"){    const n=MP_NOZZLES[a.mpNoz]||MP_NOZZLES.mp2000; return {family:"mp",kind:"rotor",matched:true,r:n.r,g:n.g,noz:n,label:"Hunter "+n.label}; }
  if(a.family==="spray"){ const s=SPRAY_SERIES[a.spraySeries]||SPRAY_SERIES.s12; const b=SPRAY_BODIES[a.sprayBody]||SPRAY_BODIES.b4; return {family:"spray",kind:"spray",matched:true,r:s.r,g:s.f,series:s,body:b,label:b.label.split(" ")[0]+' Pro-Spray, RB '+s.label}; }
  if(a.family==="strip"){ const s=STRIP_NOZZLES[a.stripNoz]||STRIP_NOZZLES.sst; const b=SPRAY_BODIES[a.stripBody]||SPRAY_BODIES.b4; return {family:"strip",kind:"strip",matched:false,r:s.len/2,g:s.g,strip:s,body:b,label:"RB "+s.label}; }
  if(a.family==="trees"){ const d=DRIP_PRODUCTS[a.dripProduct]||DRIP_PRODUCTS.xf09; return {family:"trees",kind:"trees",matched:false,r:0,g:0,drip:d,label:"Tree root watering"}; }
  const d=DRIP_PRODUCTS[a.dripProduct]||DRIP_PRODUCTS.xf09; return {family:"drip",kind:"drip",matched:false,r:0,g:0,drip:d,label:d.label};
}

// One hand-placed head's radius + flow, from family + nozzle + arc (deg).
// Spray/MP are matched precip (flow scales with arc); rotor is fixed GPM.
function loHeadSpec(family, noz, arc){
  if(family==="spray"){ const s=SPRAY_SERIES[noz]||SPRAY_SERIES.s12; return {r:s.r, gpm:s.f*(arc/360), matched:true, label:s.label}; }
  if(family==="mp"){    const m=MP_NOZZLES[noz]||MP_NOZZLES.mp2000; return {r:m.r, gpm:m.g*(arc/360), matched:true, label:m.label}; }
  const n=PGP_NOZZLES[noz]||PGP_NOZZLES.b40; return {r:n.r, gpm:n.g, matched:false, label:n.label};
}
function loNozzles(family){ return family==="spray"?SPRAY_SERIES : family==="mp"?MP_NOZZLES : PGP_NOZZLES; }
function loManualCapable(family){ return family==="rotor"||family==="mp"||family==="spray"; }

// A NEW DESIGN STARTS EMPTY. It used to be seeded with four areas copied
// from one real residential job (851 Norsan Ct), which meant every fresh
// project — including a commercial tender — opened pre-filled with another
// customer's front yard, side strips and backyard. Those areas are
// indistinguishable from real ones once saved, so they flowed into the zone
// count, the BOM and the quote as if they belonged to the job. Removed
// 2026-08-15. Start from "+ Add area" instead; nothing to notice and delete.
function newArea(){ return {name:"New Area", mode:"rect", L:40, W:30, sqft:1200, avgW:30, family:"spray", sprayBody:"b4", spraySeries:"s12"}; }

// ───── Polygon geometry ──────────────────────────────────────────────
function polyArea(poly){ let s=0; for(let i=0;i<poly.length;i++){ const a=poly[i], b=poly[(i+1)%poly.length]; s+=a.x*b.y-b.x*a.y; } return Math.abs(s)/2; }
function polyPerim(poly){ let p=0; for(let i=0;i<poly.length;i++){ const a=poly[i], b=poly[(i+1)%poly.length]; p+=Math.hypot(b.x-a.x,b.y-a.y); } return p; }
function polyBBox(poly){ const xs=poly.map(p=>p.x), ys=poly.map(p=>p.y); return {minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}; }
function pointInPoly(x,y,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
    if(((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/((yj-yi)||1e-9)+xi)) inside=!inside;
  }
  return inside;
}
function validPoly(a){ return a.mode==='custom' && Array.isArray(a.poly) && a.poly.length>=3; }
function circlePoly(cx,cy,r,n){ n=n||48; const p=[]; for(let i=0;i<n;i++){ const t=i/n*2*Math.PI; p.push({x:cx+r*Math.cos(t), y:cy+r*Math.sin(t)}); } return p; }

// ---- Drip run layout -------------------------------------------------
//
// Which way does the dripline run through each part of a bed?
//
// NOTE: isRectilinear / rectifyPoly / rectDecompose used to live here. They
// decided drip run direction by cutting the outline into rectangles, which
// required every edge to sit on an axis. That holds for a shape drawn on the
// 1 ft grid and essentially never for a bed traced off a real drawing, so
// traced L and T beds silently lost their per-leg runs. Replaced by the
// local-chord layout in dripRunSegments() (see plan()), which works on any
// outline and needs no such gate. Removed 2026-08-15 rather than left
// sitting unused — a dead decomposition that looks live is what made the
// original defect hard to see.

// Decide LOCALLY instead. At any point in the bed the dripline should run
// whichever way the bed is longer there — that is what an installer does,
// and it is well defined for any outline. Walk rows across the bed; for each
// chord of the outline, keep the spans where this direction wins locally.
// Then do the same for columns. The result follows each leg of an L or T and
// handles chamfers, curves and diagonals with no special cases.
//
// DRAWING ONLY. Square footage, dripline footage and every number that
// reaches a bid are untouched by any of this.
const DRIP_MAX_SCANLINES = 400;   // guard against a huge area with fine rows

// Chords of the polygon along one axis at a fixed coordinate.
// axis 'h' -> horizontal chords at y = at; 'v' -> vertical chords at x = at.
function polyChords(poly, at, axis){
  const hits=[];
  for(let i=0;i<poly.length;i++){
    const A=poly[i], B=poly[(i+1)%poly.length];
    const a = axis==='h' ? A.y : A.x;
    const b = axis==='h' ? B.y : B.x;
    if((a>at)!==(b>at)){
      const t=(at-a)/((b-a)||1e-9);
      hits.push(axis==='h' ? A.x+(B.x-A.x)*t : A.y+(B.y-A.y)*t);
    }
  }
  hits.sort((p,q)=>p-q);
  const out=[];
  for(let k=0;k+1<hits.length;k+=2){ if(hits[k+1]-hits[k] > 1e-6) out.push([hits[k], hits[k+1]]); }
  return out;
}

// Length of the chord through (px,py) along `axis`, or 0 if outside.
function chordThrough(poly, px, py, axis){
  const iv=polyChords(poly, axis==='h'?py:px, axis);
  const v = axis==='h' ? px : py;
  for(const [a,b] of iv){ if(v>=a-1e-9 && v<=b+1e-9) return b-a; }
  return 0;
}

// A convex bed has no legs to follow, so local direction has nothing to add
// and would just produce a pinwheel of alternating runs. Rectangles, circles
// and angled quadrilaterals get one direction across the whole bed, the way
// they would actually be installed. An L or T is not convex, so it still
// gets the local treatment. Tolerant of the small reflex wobbles a traced
// outline picks up along a straight edge.
function isConvexish(poly, tolFrac = 0.02){
  if(poly.length < 4) return true;
  let pos=0, neg=0, total=0;
  for(let i=0;i<poly.length;i++){
    const A=poly[i], B=poly[(i+1)%poly.length], C=poly[(i+2)%poly.length];
    const cross=(B.x-A.x)*(C.y-B.y)-(B.y-A.y)*(C.x-B.x);
    total+=Math.abs(cross);
    if(cross>0) pos+=cross; else neg-=cross;
  }
  if(total<=0) return true;
  return Math.min(pos,neg)/total <= tolFrac;
}

// Actual dripline run segments, in area-local feet.
//
// Each chord is classified ALONG ITS LENGTH, not just at its midpoint. A
// midpoint-only test collapses on a round bed — only the diameter row
// survives — because every perpendicular chord through the middle is the
// full diameter. Sampling along the chord and keeping the maximal winning
// spans gives every point exactly one direction: full coverage, nothing
// drawn twice.
function dripRunSegments(poly, rowFt){
  if(!Array.isArray(poly) || poly.length<3) return [];
  const row=Math.max(0.25, rowFt||1);
  const bb=polyBBox(poly);
  const segs=[];
  const convex=isConvexish(poly);
  const globalDir=(bb.maxX-bb.minX) >= (bb.maxY-bb.minY) ? 'h' : 'v';
  const scan=(axis)=>{
    const acrossMin= axis==='h' ? bb.minY : bb.minX;
    const acrossMax= axis==='h' ? bb.maxY : bb.maxX;
    const n=Math.min(DRIP_MAX_SCANLINES, Math.max(1, Math.floor((acrossMax-acrossMin)/row)));
    const d=(acrossMax-acrossMin)/n;
    for(let i=0;i<n;i++){
      const at=acrossMin+(i+0.5)*d;
      for(const [a,b] of polyChords(poly, at, axis)){
        const steps=Math.min(60, Math.max(2, Math.ceil((b-a)/(row/2))));
        const st=(b-a)/steps;
        let spanStart=null;
        for(let k=0;k<=steps;k++){
          const v=a+k*st;
          const px = axis==='h' ? v : at;
          const py = axis==='h' ? at : v;
          let wins;
          if(convex){ wins = (axis===globalDir); }
          else {
            const mine = chordThrough(poly,px,py,axis);
            const other= chordThrough(poly,px,py, axis==='h'?'v':'h');
            // Ties go to horizontal so a square patch picks one, not both.
            wins = axis==='h' ? (mine >= other) : (mine > other);
          }
          if(wins && spanStart===null) spanStart=v;
          if((!wins || k===steps) && spanStart!==null){
            const end = wins ? v : a+(k-1)*st;
            if(end-spanStart > row*0.4){
              segs.push(axis==='h'
                ? {x0:spanStart, y0:at, x1:end, y1:at, dir:'h'}
                : {x0:at, y0:spanStart, x1:at, y1:end, dir:'v'});
            }
            spanStart=null;
          }
        }
      }
    }
  };
  scan('h'); scan('v');
  return segs;
}

function isCircle(a){ return a.mode==='custom' && a.shapeKind==='circle' && a.circle && a.circle.r>0; }
// Sector (pie slice): centre + arc a0..a0+sweep. 90=quarter, 180=half-disk.
function sectorPoly(cx,cy,r,a0,sweep,n){
  n=n||Math.max(10, Math.round(sweep/6));
  const p=[{x:cx,y:cy}], sw=sweep*Math.PI/180;
  for(let i=0;i<=n;i++){ const t=a0+sw*i/n; p.push({x:cx+r*Math.cos(t), y:cy+r*Math.sin(t)}); }
  return p;
}
function isSector(a){ return a.mode==='custom' && a.shapeKind==='sector' && a.arc && a.arc.r>0; }
// Bounding box of the shape PLUS any trees (which may sit outside it), so the
// drawing frame spans everything. Returns min/max in absolute ft.
function combinedExtent(gm, trees){
  let minX, minY, maxX, maxY;
  if(gm.poly){ minX=gm.bb.minX; minY=gm.bb.minY; maxX=gm.bb.maxX; maxY=gm.bb.maxY; }
  else { minX=0; minY=0; maxX=gm.L; maxY=gm.W; }
  (trees||[]).forEach(t=>{ const r=(t.dia||TREE_RING_DEFAULT_DIA)/2+1; minX=Math.min(minX,t.x-r); minY=Math.min(minY,t.y-r); maxX=Math.max(maxX,t.x+r); maxY=Math.max(maxY,t.y+r); });
  return {minX,minY,maxX,maxY};
}

// ───── geom() — an area's working dimensions and square footage ──────
function geom(a){
  if(isSector(a)){
    const c=a.arc, poly=sectorPoly(c.cx,c.cy,c.r,c.a0,c.sweep), bb=polyBBox(poly);
    return {L:Math.max(bb.maxX-bb.minX,1), W:Math.max(bb.maxY-bb.minY,1), sqft:(c.sweep/360)*Math.PI*c.r*c.r, poly, bb};
  }
  if(isCircle(a)){
    const c=a.circle, poly=circlePoly(c.cx,c.cy,c.r);
    return {L:2*c.r, W:2*c.r, sqft:Math.PI*c.r*c.r, poly, bb:polyBBox(poly)};
  }
  if(validPoly(a)){
    const bb=polyBBox(a.poly);
    const L=Math.max(bb.maxX-bb.minX,1), W=Math.max(bb.maxY-bb.minY,1);
    return {L,W,sqft:Math.max(polyArea(a.poly),1),poly:a.poly,bb};
  }
  if(a.mode==='custom'){ return {L:1,W:1,sqft:0,noShape:true}; }   // custom mode, nothing drawn yet
  if(a.mode==='rect'){ const L=Math.max(a.L,1),W=Math.max(a.W,1); return {L,W,sqft:L*W}; }
  const W=Math.max(a.avgW,1); return {L:Math.max(a.sqft/W,1),W,sqft:a.sqft};
}


// Greedy-pack heads into zones by the GPM ceiling (insertion order).
/* Split an area's heads across valves.

   Filling each valve to the ceiling and starting a new one when it
   overflows uses the FEWEST valves, which is the thing that costs money —
   but it leaves whatever is left over stranded on the last one. Ten equal
   heads under a four-head ceiling came out 4 / 4 / 2: a valve doing half
   the work of its neighbours, watering unevenly and needing its own run
   time, for no reason other than the order the heads happened to be in.

   So: work out the fewest valves the greedy fill would use, then spread
   the heads as evenly as the ceiling allows across exactly that many. The
   valve count never changes, so nothing on the bid moves.

   Two constraints the balancing must respect:

     Heads keep their ORDER, and that order is spatial — the auto layout
     walks the shape, and a hand-placed layout is in the order it was
     drawn. Balancing by shuffling heads between valves would scatter a
     zone across the property and send its lateral zig-zagging; balancing
     by choosing where to CUT the sequence keeps every zone a contiguous
     run of the lawn.

     A single head heavier than the ceiling still gets its own valve —
     it cannot be split, and that is the one case where a zone is allowed
     over the ceiling. Same as the greedy fill always did.

   Evenness is measured on GPM, not head count, because GPM is what the
   valve actually has to carry. With one nozzle type throughout they are
   the same thing.                                                        */

// Is a run of heads a legal zone? Anything up to the ceiling, plus the
// single-head escape hatch above.
function pzZoneOk(sum, count, cap){ return count === 1 || sum <= cap + 0.001; }

// Fewest valves, by the original greedy fill. This is the number the BOM,
// the quote and the valve-box plan are all built on, so the balancing pass
// below is not allowed to change it.
function pzMinZones(gpm, cap){
  let k = 1, acc = 0;
  for(const g of gpm){ if(acc > 0 && acc + g > cap + 0.001){ k++; acc = 0; } acc += g; }
  return k;
}

// Where to cut the sequence into exactly k runs so the runs come out as
// close to equal as the ceiling allows. Exact, by dynamic programming over
// cut positions, scoring squared distance from the ideal share — minimising
// the WORST zone alone is not enough (4/4/2 and 4/3/3 both peak at 4, and
// only one of them is what you want).
function pzBalancedCuts(gpm, cap, k){
  const n = gpm.length;
  const pre = new Array(n + 1).fill(0);
  for(let i = 0; i < n; i++) pre[i + 1] = pre[i] + gpm[i];
  const target = pre[n] / k;
  const INF = Infinity;
  // dp[j][i] — best score for the first i heads in j zones.
  let prev = new Array(n + 1).fill(INF), cur;
  const from = [];                       // back-pointers, one row per zone
  prev[0] = 0;
  for(let j = 1; j <= k; j++){
    cur = new Array(n + 1).fill(INF);
    const back = new Array(n + 1).fill(-1);
    for(let i = j; i <= n; i++){
      for(let sIdx = j - 1; sIdx < i; sIdx++){
        if(prev[sIdx] === INF) continue;
        const sum = pre[i] - pre[sIdx];
        if(!pzZoneOk(sum, i - sIdx, cap)) continue;
        const d = sum - target;
        const score = prev[sIdx] + d * d;
        if(score < cur[i]){ cur[i] = score; back[i] = sIdx; }
      }
    }
    from.push(back);
    prev = cur;
  }
  if(prev[n] === INF) return null;       // no exact-k split — caller falls back
  const cuts = [];
  let i = n;
  for(let j = k; j >= 1; j--){ const sIdx = from[j - 1][i]; cuts.unshift(sIdx); i = sIdx; }
  return cuts;                            // cuts[j] = first head index of zone j
}

// The DP is O(k·n²). Per-area head counts are tens, so it is microseconds —
// but a pathological area should degrade to the old fill rather than hang
// the page on every keystroke.
const PZ_BALANCE_BUDGET = 3e6;

function packZones(heads, ceiling){
  const n = heads.length;
  if(!n) return {zones: 0, zoneGPM: [], over: []};
  const cap = Math.max(ceiling, 0.001);
  // Heads given a zone by hand keep it. Zone numbers are compacted so the
  // valves come out 1, 2, 3 whatever was typed, and any head left on Auto
  // is packed under the ceiling into zones AFTER the hand-picked ones. A
  // hand-picked zone may exceed the ceiling — that is reported (`over`),
  // not silently re-split, because the split was the whole point.
  if(heads.some(h => Number.isInteger(h.manualZone))){
    const picked = [...new Set(heads.filter(h => Number.isInteger(h.manualZone)).map(h => h.manualZone))].sort((a,b)=>a-b);
    const map = new Map(picked.map((z,i) => [z,i]));
    const rest = [];
    heads.forEach(h => { if(map.has(h.manualZone)) h.zone = map.get(h.manualZone); else rest.push(h); });
    if(rest.length){ packZones(rest, ceiling); rest.forEach(h => { h.zone += picked.length; }); }
    const zones = heads.reduce((m, hd) => Math.max(m, hd.zone), 0) + 1;
    const zoneGPM = new Array(zones).fill(0);
    heads.forEach(hd => { zoneGPM[hd.zone] += hd.gpm || 0; });
    const over = zoneGPM.map((g,i) => g > cap + 0.001 ? i : -1).filter(i => i >= 0);
    return {zones, zoneGPM, over};
  }
  const gpm = heads.map(hd => hd.gpm || 0);
  const k = pzMinZones(gpm, cap);

  let cuts = null;
  if(k > 1 && k * n * n <= PZ_BALANCE_BUDGET) cuts = pzBalancedCuts(gpm, cap, k);

  if(cuts){
    let j = 0;
    for(let i = 0; i < n; i++){
      while(j + 1 < k && i >= cuts[j + 1]) j++;
      heads[i].zone = j;
    }
  } else {
    // Original greedy fill — one valve at a time, up to the ceiling.
    let z = 0, acc = 0;
    heads.forEach(hd => { if(acc > 0 && acc + hd.gpm > cap + 0.001){ z++; acc = 0; } hd.zone = z; acc += hd.gpm; });
  }

  const zones = heads.reduce((m, hd) => Math.max(m, hd.zone), 0) + 1;
  const zoneGPM = new Array(zones).fill(0);
  heads.forEach(hd => { zoneGPM[hd.zone] += hd.gpm; });
  return {zones, zoneGPM, over: []};
}

function computePlan(a, inputs){
  ensureArea(a);
  const h=headSpec(a), gm=geom(a);
  // Was: num('ceiling') and el('spacingFactor').value — the two form fields
  // this used to reach into. Same Math.max, same parseFloat fallback, same
  // values; only where they come from has changed.
  const ceiling=Math.max(rawNum(inputs && inputs.ceiling),0.1), sf=parseFloat(inputs && inputs.spacingFactor)||1;
  if(gm.noShape && h.family!=='trees'){ return {family:h.family,kind:h.kind,matched:h.matched,noShape:true,L:1,W:1,sqft:0,heads:[],zones:0,zoneGPM:[],arcCount:{90:0,180:0,360:0},totalGPM:0}; }

  // ---- Drip: area-wide dripline ----
  // Row spacing = distance between parallel tube runs (dripRowIn, default
  // 18"). Emitter spacing = emitters along the tube (product.emitterIn,
  // 12"). These are different: fewer runs at 18" than 12".
  if(h.kind==='drip'){
    const d=h.drip;
    const rowFt=Math.max(parseFloat(a.dripRowIn)||18,1)/12;  // between-run spacing
    const emitFt=Math.max(d.emitterIn,1)/12;                 // emitter spacing along tube
    const overage=1+((parseFloat(a.overagePct)||0)/100);
    // Area-wide drip line.
    const areaDripFt=(gm.sqft/rowFt)*overage;
    const areaGPM=(areaDripFt/emitFt)*d.gph/60;
    // Trees can live in the SAME zone (both are drip / same precip regime),
    // and may sit inside OR outside the drawn shape.
    const trees=Array.isArray(a.trees)?a.trees:[];
    const ext=combinedExtent(gm, trees);
    const orig={x:ext.minX, y:ext.minY};
    const extL=Math.max(ext.maxX-ext.minX,1), extW=Math.max(ext.maxY-ext.minY,1);
    let treeTube=0, rwsUnits=0, ringTrees=0, rwsTrees=0, treeFlow=0;
    trees.forEach(t=>{
      if(t.type==='rws'){ rwsTrees++; rwsUnits+=2; treeFlow+=2*TREE_RWS_GPM_PER_UNIT; }
      else { ringTrees++; const D=t.dia||TREE_RING_DEFAULT_DIA; const loop=Math.PI*D+Math.PI*(D/2); treeTube+=loop; treeFlow+=(loop/emitFt)*d.gph/60; }
    });
    const treeTubeFt=treeTube*overage;
    const dripLengthFt=areaDripFt+treeTubeFt;
    const emitters=Math.round(dripLengthFt/emitFt);
    const totalGPM=areaGPM+treeFlow;
    const totalGPH=totalGPM*60;
    const zones=Math.max(1, Math.ceil(totalGPM/ceiling - 1e-6));
    const zoneGPM=new Array(zones).fill(totalGPM/zones);
    const dPoly = gm.poly ? gm.poly.map(p=>({x:p.x-orig.x, y:p.y-orig.y})) : null;
    const treesOut = trees.map(t=>({x:t.x-orig.x, y:t.y-orig.y, type:t.type||'ring', dia:t.dia||TREE_RING_DEFAULT_DIA}));
    // Run direction for the area drip (unchanged): long-axis / per-region / arc.
    const forced = (a.dripDir==='h'||a.dripDir==='v');
    let dripRuns=null, dripDir, arcShape=null;
    if(isSector(a) && !forced){
      const c=a.arc; arcShape={cx:c.cx-orig.x, cy:c.cy-orig.y, r:c.r, a0:c.a0, sweep:c.sweep};
      dripDir='arc';
    }
    else if(forced){ dripDir=a.dripDir; }
    else if(dPoly){
      // Local run direction — works on ANY traced outline, no tidiness gate.
      dripRuns = dripRunSegments(dPoly, rowFt);
      const dirs=new Set(dripRuns.map(r=>r.dir));
      dripDir = dirs.size>1 ? 'mixed' : (dirs.size===1 ? [...dirs][0] : (gm.L>=gm.W?'h':'v'));
    } else {
      dripDir = gm.L>=gm.W?'h':'v';
    }
    return {family:"drip",kind:"drip",matched:false,L:extL,W:extW,sqft:gm.sqft,heads:[],zones,zoneGPM,
      product:d,dripLengthFt,areaDripFt,treeTubeFt,emitters,totalGPH,totalGPM,rowFt,dripDir,dripRuns,arcShape,
      treeCount:trees.length,ringTrees,rwsTrees,rwsUnits,treesOut,poly:dPoly};
  }

  // ---- Trees: individual root watering (double drip ring or RWS units) ----
  if(h.kind==='trees'){
    const d=h.drip, emitFt=Math.max(d.emitterIn,1)/12;
    const trees=Array.isArray(a.trees)?a.trees:[];
    const ext=combinedExtent(gm, trees);
    const orig={x:ext.minX, y:ext.minY};
    const extL=Math.max(ext.maxX-ext.minX,1), extW=Math.max(ext.maxY-ext.minY,1);
    let tube=0, rwsUnits=0, ringTrees=0, rwsTrees=0, flow=0;
    trees.forEach(t=>{
      if(t.type==='rws'){ rwsTrees++; rwsUnits+=2; flow+=2*TREE_RWS_GPM_PER_UNIT; }
      else { ringTrees++; const D=t.dia||TREE_RING_DEFAULT_DIA; const loop=Math.PI*D+Math.PI*(D/2); tube+=loop; flow+=(loop/emitFt)*d.gph/60; }
    });
    const overage=1+((parseFloat(a.overagePct)||0)/100);
    const tubeFt=tube*overage;
    const emitters=Math.round(tubeFt/emitFt);
    const totalGPM=flow;
    const zones = trees.length? Math.max(1, Math.ceil(totalGPM/ceiling - 1e-6)) : 0;
    const zoneGPM = zones? new Array(zones).fill(totalGPM/zones) : [];
    const outTrees = trees.map(t=>({x:t.x-orig.x, y:t.y-orig.y, type:t.type||'ring', dia:t.dia||TREE_RING_DEFAULT_DIA}));
    const dPoly = gm.poly ? gm.poly.map(p=>({x:p.x-orig.x, y:p.y-orig.y})) : null;
    return {family:"trees",kind:"trees",matched:false,L:extL,W:extW,sqft:gm.sqft,heads:[],zones,zoneGPM,
      product:d,treeCount:trees.length,ringTrees,rwsTrees,rwsUnits,tubeFt,emitters,totalGPM,treesOut:outTrees,poly:dPoly};
  }

  let heads=[];

  // ---- Manual layout: hand-placed heads (rotor / mp / spray) ----
  if(a.layout==='manual' && Array.isArray(a.manualHeads) && a.manualHeads.length && loManualCapable(h.family)){
    const orig = gm.poly ? {x:gm.bb.minX, y:gm.bb.minY} : {x:0, y:0};
    a.manualHeads.forEach(mh=>{
      const spec=loHeadSpec(h.family, mh.noz, mh.arc);
      // Radius may be reduced per head; flow deliberately is NOT (see the
      // flow-model note by LO_MIN_ARC — budgeting full flow is the
      // conservative side of a valve-sizing decision).
      const pct=loRadiusPct(mh);
      const hd={xft:mh.x-orig.x, yft:mh.y-orig.y, arc:mh.arc, dir:mh.dir||0, gpm:spec.gpm, r:spec.r*pct, nz:spec.label};
      if(Number.isInteger(mh.zone)) hd.manualZone=mh.zone;
      heads.push(hd);
    });
    const pk=packZones(heads,ceiling);
    // Arcs are free-form now, so bucket before counting. The buckets are the
    // SAME thresholds the BOM uses to pick a nozzle SKU below, which is what
    // keeps a 137-degree head from falling out of the parts list and out of
    // the material cost. arcCount is read by the zone legend and by
    // areaMaterialCents; an unbucketed key would be silently ignored by both.
    const arcBucket = (deg) => deg<=90 ? 90 : deg<=180 ? 180 : deg<=270 ? 270 : 360;
    const arcCount={90:0,180:0,270:0,360:0};
    heads.forEach(hd=>{ arcCount[arcBucket(hd.arc)]++; });
    // Mixing arcs on a gear-rotor zone is a genuine precip mismatch (a PGP
    // flows the same GPM at any arc, so a narrow head lays down far more
    // water per sq ft). Compare to the nearest 15 degrees so a free arc of
    // 179 vs 180 doesn't cry wolf while 90 vs 180 still does.
    const zoneMixArc=Array.from({length:pk.zones},()=>new Set());
    heads.forEach(hd=>zoneMixArc[hd.zone].add(Math.round(hd.arc/15)*15));
    const mixedRotor = h.family==='rotor' && zoneMixArc.some(x=>x.size>1);
    const outPoly = gm.poly ? gm.poly.map(p=>({x:p.x-orig.x, y:p.y-orig.y})) : null;
    return {family:h.family,kind:h.kind,matched:h.matched,manual:true,L:gm.L,W:gm.W,sqft:gm.sqft,heads,zones:pk.zones,zoneGPM:pk.zoneGPM,
      overZones:pk.over||[], handZoned:heads.some(x=>Number.isInteger(x.manualZone)),
      arcCount,mixedRotor,body:h.body,series:h.series,noz:h.noz,poly:outPoly,orig,totalGPM:heads.reduce((t,x)=>t+x.gpm,0)};
  }

  // ---- Strip: single run of strip nozzles along the length ----
  if(h.kind==="strip"){
    const s=h.strip, per=Math.max(s.len,1);
    const n=Math.max(1, Math.round(gm.L/per));
    for(let i=0;i<n;i++) heads.push({xft:(i+0.5)*(gm.L/n), yft:gm.W/2, arc:180, dir:-Math.PI/2, gpm:h.g, r:h.r});
    const pk=packZones(heads,ceiling);
    return {family:"strip",kind:"strip",matched:false,L:gm.L,W:gm.W,sqft:gm.sqft,heads,zones:pk.zones,zoneGPM:pk.zoneGPM,
      strip:s,body:h.body,arcCount:{90:0,180:n,360:0},totalGPM:heads.reduce((t,x)=>t+x.gpm,0)};
  }

  // ---- Rotor / spray: arc-aware head placement ----
  const sp=Math.max(h.r*sf,1);
  let outPoly=null, autoOrig={x:0,y:0};
  if(gm.poly){
    // Custom shape: sample a fine interior grid, then greedily thin to ~sp
    // spacing (farthest-point) so even narrow strips (an L's 5ft leg) get a
    // head row. Arc by how many orthogonal neighbours fall outside the shape
    // (works on concave outlines); direction points inward.
    const bb=gm.bb;
    const spanMax=Math.max(bb.maxX-bb.minX, bb.maxY-bb.minY);
    const fine=Math.max(sp/4, spanMax/80, 1);
    const cand=[];
    for(let x=bb.minX+fine/2; x<bb.maxX; x+=fine) for(let y=bb.minY+fine/2; y<bb.maxY; y+=fine){
      if(pointInPoly(x,y,gm.poly)) cand.push({x,y});
    }
    const chosen=[]; const minD2=Math.pow(0.72*sp,2);
    for(const c of cand){ let ok=true; for(const q of chosen){ if((c.x-q.x)*(c.x-q.x)+(c.y-q.y)*(c.y-q.y)<minD2){ ok=false; break; } } if(ok) chosen.push(c); }
    if(!chosen.length && cand.length) chosen.push(cand[Math.floor(cand.length/2)]);
    chosen.forEach(pt=>{
      const nbrs=[[sp,0],[-sp,0],[0,sp],[0,-sp]];
      let outside=0, vx=0, vy=0;
      nbrs.forEach(([dx,dy])=>{ if(!pointInPoly(pt.x+dx,pt.y+dy,gm.poly)){ outside++; vx-=dx; vy-=dy; } });
      const arc = outside>=2?90 : outside===1?180 : 360;
      const dir = arc===360?0:Math.atan2(vy,vx);
      const gpm = h.matched? h.g*(arc/360) : h.g;
      heads.push({xft:pt.x-bb.minX, yft:pt.y-bb.minY, arc, dir, gpm, r:h.r});
    });
    outPoly = gm.poly.map(p=>({x:p.x-bb.minX, y:p.y-bb.minY}));
    autoOrig = {x:bb.minX, y:bb.minY};
  } else {
    // Rectangle grid: corners=90, edges=180, interior=360.
    const nx=Math.max(2,Math.round(gm.L/sp)+1), ny=Math.max(2,Math.round(gm.W/sp)+1);
    for(let i=0;i<nx;i++)for(let j=0;j<ny;j++){
      const oL=i===0,oR=i===nx-1,oT=j===0,oB=j===ny-1;
      const nb=(oL||oR?1:0)+(oT||oB?1:0);
      const arc=nb===2?90:nb===1?180:360;
      const dx=oL?1:oR?-1:0, dy=oT?1:oB?-1:0;
      const dir=(arc===360)?0:Math.atan2(dy,dx);
      const gpm=h.matched? h.g*(arc/360) : h.g;
      heads.push({xft:i*(gm.L/(nx-1)),yft:j*(gm.W/(ny-1)),arc,dir,gpm,r:h.r});
    }
  }
  const pk=packZones(heads,ceiling);
  const zoneMixArc=Array.from({length:pk.zones},()=>new Set());
  heads.forEach(hd=>zoneMixArc[hd.zone].add(hd.arc));
  const arcCount={90:0,180:0,360:0}; heads.forEach(hd=>arcCount[hd.arc]++);
  const mixedRotor = h.family==="rotor" && !h.matched && zoneMixArc.some(x=>x.size>1);
  return {family:h.family,kind:h.kind,matched:h.matched,L:gm.L,W:gm.W,sqft:gm.sqft,heads,zones:pk.zones,zoneGPM:pk.zoneGPM,
    arcCount,mixedRotor,body:h.body,series:h.series,noz:h.noz,poly:outPoly,orig:autoOrig,totalGPM:heads.reduce((t,x)=>t+x.gpm,0)};
}

/* ════════════ Zones as a design decision, not an accumulator ════════════

   A zone is ONE VALVE. Until now it was whatever fell out of packZones()
   walking heads in click order inside a single area, which meant a valve
   could never serve more than one area — so twelve traced drip beds became
   twelve valves, twelve zone line items and a twenty-station controller,
   when together they draw 20.5 GPM and belong on two.

   `area.valveGroup` is the fix: give several drip beds the same group name
   and they share a valve. The beds are packed onto as few valves as the GPM
   ceiling allows, which is a real hydraulic limit, not a preference.

   What stays per BED rather than per valve: the Xeri pressure regulator.
   Each bed gets its own (Patrick's spec — one valve, a regulator on each),
   so grouping must NOT collapse the regulator count. Getting that wrong
   would under-spec the install while the quote got cheaper, which is the
   worst direction for an error to run.

   An area with no valveGroup behaves exactly as before.                  */
function computeZonePlan(ctx){
  const { plans, areas, routing, valveGroupModes } = normalizeCtx(ctx);
  const ceiling = Math.max(rawNum(ctx && ctx.ceiling), 0.1);
  const zones = [];
  const groups = new Map();

  plans.forEach(({area, plan}) => {
    if(plan.noShape) return;
    const g = (plan.family === 'drip' && area.valveGroup) ? String(area.valveGroup) : null;
    if(g){
      if(!groups.has(g)) groups.set(g, []);
      groups.get(g).push({area, plan});
      return;
    }
    // Ungrouped: exactly the zones this area computed for itself.
    for(let z=0; z<plan.zones; z++){
      zones.push({
        name: area.name || 'Area',
        family: plan.family,
        gpm: plan.zoneGPM[z] || 0,
        dripFt: plan.family === 'drip' ? (plan.dripLengthFt||0)/Math.max(plan.zones,1) : 0,
        headCount: (plan.heads||[]).filter(h => h.zone === z).length,
        members: [area.name || 'Area'],
        // Which area, and which of ITS zones — so the master plan can colour
        // each head and each bed by the valve it actually runs on.
        parts: [{ areaIdx: areas.indexOf(area), localZone: z }],
        // Stable across a recompute, unlike the index into this array, so a
        // hand-assigned valve box survives adding an area or nudging the
        // GPM ceiling.
        key: 'z:' + (area.aid||'?') + ':' + z,
        grouped: false
      });
    }
  });

  // Grouped drip beds: pack onto as few valves as the ceiling allows.
  // Largest bed first so a big one never strands a valve that could have
  // carried it.
  groups.forEach((list, g) => {
    const beds = list.slice().sort((a,b) => b.plan.totalGPM - a.plan.totalGPM);
    const bins = [];
    beds.forEach(b => {
      let bin = bins.find(x => x.gpm + b.plan.totalGPM <= ceiling + 0.001);
      if(!bin){ bin = {gpm:0, dripFt:0, beds:[]}; bins.push(bin); }
      bin.gpm    += b.plan.totalGPM;
      bin.dripFt += b.plan.dripLengthFt || 0;
      bin.beds.push(b);
    });
    bins.forEach((bin, i) => {
      if(valveGroupMode(valveGroupModes, g)==='station' && bin.beds.length > 1){
        // One valve per VALVE BOX, all on one station. Beds fed from the
        // same box share a valve and one lateral; beds you put in another
        // box get their own valve there. The bin is still the GPM unit —
        // these valves open together, so their flows add up. A bed with no
        // box yet (sheet not routed) stays a valve of its own, as before.
        const stationName = bins.length > 1 ? `${g} — station ${i+1} of ${bins.length}` : g;
        const sg = 'g:' + g + ':' + i;
        const byBox = new Map();
        bin.beds.forEach(b => {
          const bedKey = sg + ':' + (b.area.aid||'?');
          const box = bedBoxFor(b.area, bedKey, routing);
          const bk = box ? box.pageId + '|' + box.id : 'bed|' + bedKey;
          if(!byBox.has(bk)) byBox.set(bk, { box, beds: [], bedKeys: [] });
          byBox.get(bk).beds.push(b); byBox.get(bk).bedKeys.push(bedKey);
        });
        byBox.forEach(v => {
          const names = v.beds.map(b => b.area.name || 'Area');
          const label = v.box ? ('M' + (v.box.idx+1) + (v.beds.length===1 ? ' · ' + names[0] : ' · ' + v.beds.length + ' beds')) : names[0];
          zones.push({
            name: `${stationName} · ${label}`,
            family: 'drip',
            gpm: v.beds.reduce((t,b) => t + b.plan.totalGPM, 0),
            dripFt: v.beds.reduce((t,b) => t + (b.plan.dripLengthFt || 0), 0),
            headCount: 0,
            members: names,
            parts: v.beds.map(b => ({ areaIdx: areas.indexOf(b.area), localZone: 0 })),
            // Keyed by the box, so the valve survives beds joining or
            // leaving it. Box assignments are still stored per BED
            // (`bedKeys`), which is what lets a bed move between valves.
            key: v.box ? sg + ':@' + v.box.id : v.bedKeys[0],
            bedKeys: v.bedKeys,
            boxId: v.box ? v.box.id : null,
            boxPage: v.box ? v.box.pageId : null,
            grouped: true,
            stationGroup: sg,
            stationName
          });
        });
        return;
      }
      zones.push({
        name: bins.length > 1 ? `${g} — valve ${i+1} of ${bins.length}` : g,
        family: 'drip',
        gpm: bin.gpm,
        dripFt: bin.dripFt,
        headCount: 0,
        members: bin.beds.map(b => b.area.name || 'Area'),
        parts: bin.beds.map(b => ({ areaIdx: areas.indexOf(b.area), localZone: 0 })),
        key: 'g:' + g + ':' + i,
        grouped: true
      });
    });
  });
  return applyValveSplits(zones, { plans, areas, routing, valveGroupModes });
}

/* ════════════ One station, two valves: the driveway split ════════════

   A zone is one valve — except when the lateral would have to cross a
   driveway to reach the far heads, where it is cheaper to put a SECOND
   valve in a box on the far side and land both valve wires on the same
   controller terminal. Both valves open together, so hydraulically it is
   still one zone (one station, one GPM figure, one line on the quote), but
   physically it is two valves, two laterals, and one more conductor.

   The decision is drawn on the master plan: a line across the driveway,
   stored per sheet as `routing[page].splits[zoneKey] = {ax,ay,bx,by}` in
   sheet feet. Heads are sorted onto side A or B of that line by which way
   they fall from it, so nudging a head never silently changes the split.
   Each half becomes its own entry in LAST_ZONES — so a half can be pinned
   to its own box, gets its own lateral tree, and is counted as a valve
   everywhere hardware is counted. Whether the two halves also share a
   CONTROLLER STATION is the split's own stored `shareStation` flag, not a
   property of splitting: shared means one station carrying both valves'
   flow (quote lines, controller size and the cycle see one zone, as they
   always did), separate means two stations with their own run times.

   Only a single-area sprinkler zone can be split: a drip bed has no heads
   to sort, and a shared drip group is already several beds on one valve.  */
function applyValveSplits(zones, ctx){
  const { plans, areas, routing } = normalizeCtx(ctx);
  const out=[];
  let station=0;
  const groupStation=new Map();     // stationGroup -> station number
  zones.forEach(z => {
    if(z.stationGroup){
      // Several valves, one station (a shared drip group in 'station' mode).
      if(!groupStation.has(z.stationGroup)) groupStation.set(z.stationGroup, station++);
      z.station = groupStation.get(z.stationGroup);
      out.push(z);
      return;
    }
    z.station = station;
    const sp = splitFor(z, ctx);
    if(!sp){ out.push(z); station++; return; }
    const pt = z.parts[0], a = areas[pt.areaIdx], p = planFor(plans, a);
    // A tree zone splits on its trees — each is a point the lateral runs
    // to, exactly like a head — so one long boulevard can be two valves in
    // two boxes without a pipe running the length of the job.
    const isTrees = a.family === 'trees';
    const hs = isTrees ? mpTreesOf(a) : mpHeadsOf(a, p).filter(h => (h.zone||0) === pt.localZone);
    const A = hs.filter(h => headHalf(sp, h) === 'A');
    const B = hs.filter(h => headHalf(sp, h) === 'B');
    if(!A.length || !B.length){ out.push(z); station++; return; }   // line misses the zone — no split
    const gpmOf = list => list.reduce((t,h)=>t+(h.gpm||0),0);
    // If heads carry no per-head flow, share the zone's flow by head count.
    // Trees always carry flow, but the zone's figure includes overage, so
    // the halves take their SHARE of the zone rather than the raw sum.
    const gA = gpmOf(A), gB = gpmOf(B);
    const share = (g, n) => (gA+gB)>0 ? (isTrees ? z.gpm*g/(gA+gB) : g) : z.gpm*n/hs.length;
    const gpmA = share(gA, A.length), gpmB = share(gB, B.length);
    // ONE STATION OR TWO — the decision that is now stored, not assumed.
    //
    // Both valves on one terminal is a real wiring choice: they open
    // together, so the station carries the sum of the two halves. Two
    // terminals is the other real choice, and it is the one people expect
    // by default — a driveway split usually exists because the two halves
    // want their own run times, not only their own box.
    //
    // Which it is used to be neither asked nor stored: every split was
    // wired as one station. A design saved under that rule therefore says
    // nothing about what was actually installed, so the page's
    // restoreRouting() migrates it to shareStation:true — preserving its
    // station count, its proposal, its controller and its run times
    // exactly — and marks it `legacy` so it is reviewed rather than
    // silently believed.
    //
    // A split drawn from now on stores shareStation:false at the moment
    // it is drawn. Absent-and-not-legacy means false, so a blob that
    // somehow lost the flag gets the new default rather than the old one.
    const shared = sp.shareStation === true;
    const stationA = station++;
    const stationB = shared ? stationA : station++;
    out.push(Object.assign({}, z, { name: z.name+' · A', half:'A', headCount:isTrees?0:A.length, treeCount:isTrees?A.length:0, gpm:gpmA, stationGpm:shared?z.gpm:gpmA, station:stationA, shareStation:shared, legacyShare:sp.legacy===true, key:z.key }));
    out.push(Object.assign({}, z, { name: z.name+' · B', half:'B', headCount:isTrees?0:B.length, treeCount:isTrees?B.length:0, gpm:gpmB, stationGpm:shared?z.gpm:gpmB, station:stationB, shareStation:shared, legacyShare:sp.legacy===true, key:z.key+'#B' }));
  });
  return out;
}
// Which valve box a grouped bed is fed from: the box it was put in by hand
// (`routing[page].pins[bedKey]`), else the nearest box on its sheet. Null
// when its sheet has no boxes yet.
function bedBoxFor(area, bedKey, routing){
  const pg = area && area.planRef && area.planRef.pageId;
  const r = pg && (routing||{})[pg];
  if(!r || !(r.manifolds||[]).length) return null;
  const pin = (r.pins||{})[bedKey];
  let idx = pin ? manifoldIdxById(r, pin) : -1;
  if(idx < 0){
    if(!validPoly(area)) return null;
    const c = polyCentroid(area.poly);
    let bd = Infinity;
    r.manifolds.forEach((m,i) => { const d = Math.hypot(m.x-c.x, m.y-c.y); if(d < bd){ bd = d; idx = i; } });
  }
  const m = r.manifolds[idx];
  if(!m) return null;
  if(!m.id) m.id = mintId('m_');
  return { pageId: pg, id: m.id, idx };
}
// The split line drawn for this zone on the sheet its area is traced on.
function splitFor(z, ctx){
  const { areas, routing } = normalizeCtx(ctx);
  if(!z || z.grouped || !z.key || !(z.parts||[]).length || z.parts.length!==1) return null;
  const a = areas[z.parts[0].areaIdx];
  if(!a || !a.planRef || !a.planRef.pageId) return null;
  if(a.family==='drip') return null;               // trees split like heads: by which side each tree falls
  const r = routing[a.planRef.pageId];
  const sp = r && r.splits && r.splits[baseKey(z.key)];
  return (sp && [sp.ax,sp.ay,sp.bx,sp.by].every(Number.isFinite)) ? sp : null;
}
/* ════════ What a STORED split means — the one place that decides ════════

   A saved split may or may not carry `shareStation`, and what its absence
   means depends on the blob's version: before version 9 the builder could
   only wire a split's two valves to ONE station, so a flagless split in a
   version-8 design means SHARED and wants reviewing; from version 9 the
   flag is always written, so a flagless split means the new default.

   This lives here, once, because it has more than one reader. The page
   applies it in restoreRouting() when a project is opened. The split-zone
   audit applies it when it reads saved projects straight off disk, without
   a page. When the rule lived only in the page, the audit read raw stored
   routing and — once applyValveSplits() started honouring the flag — began
   reporting every version-8 design as already separated, with a station
   count that no one would ever see on screen. Two copies of a state test
   drift; this one drifted within a day of existing.                      */
function splitStationRule(sp, version){
  const legacyShared = !(Number(version) >= 9);
  const hasFlag = sp && typeof sp.shareStation === 'boolean';
  return {
    shareStation: hasFlag ? sp.shareStation : legacyShared,
    legacy: (!hasFlag && legacyShared) || (sp && sp.legacy === true)
  };
}
// Apply that rule across a whole stored `routing` blob, returning a copy.
// A reader that has no page (the audit) uses this to see what the builder
// would show; the page migrates in place through restoreRouting() instead.
function migrateRoutingSplits(routing, version){
  const out = JSON.parse(JSON.stringify(routing || {}));
  Object.keys(out).forEach(pageId => {
    const r = out[pageId];
    if(!r || typeof r !== 'object' || !r.splits) return;
    Object.keys(r.splits).forEach(k => {
      const sp = r.splits[k]; if(!sp) return;
      const { shareStation, legacy } = splitStationRule(sp, version);
      sp.shareStation = shareStation;
      if(legacy) sp.legacy = true; else delete sp.legacy;
    });
  });
  return out;
}
function baseKey(key){ return String(key||'').replace(/#B$/, ''); }
// Which side of the split line a point falls on. Side A is the left of
// A→B; a point exactly on the line counts as A so nothing is ever lost.
function headHalf(sp, h){
  const cross = (sp.bx-sp.ax)*(h.y-sp.ay) - (sp.by-sp.ay)*(h.x-sp.ax);
  return cross < 0 ? 'B' : 'A';
}
// Does this zone entry feed this head? Same area-zone, and — when the zone
// is split — the same side of the line.
function zoneFeedsHead(z, pt, h, ctx){
  if((h.zone||0) !== pt.localZone) return false;
  if(!z.half) return true;
  const sp = splitFor(z, ctx);
  return !sp || headHalf(sp, h) === z.half;
}
// Heads this zone entry actually feeds in area `a` (sheet feet).
function mpZoneHeads(z, pt, a, p, ctx){
  return mpHeadsOf(a,p).filter(h => zoneFeedsHead(z, pt, h, ctx));
}
// Stations: the controller's view. Two split halves are one station only
// when their split says shareStation — applyValveSplits has already
// decided, and every reader here just groups by the `station` it set.
function stationCount(zones){ return (zones||[]).reduce((m,z)=>Math.max(m,(z.station||0)+1), 0); }
function stationZones(zones){
  const by=[];
  (zones||[]).forEach(z=>{ const s=z.station||0;
    if(!by[s]) by[s]={station:s, name:baseName(z), family:z.family, grouped:z.grouped, members:[], dripFt:0, headCount:0, gpm:0, valves:0};
    const e=by[s]; e.dripFt+=z.dripFt||0; e.headCount+=z.headCount||0; e.gpm+=z.gpm||0; e.valves++;
    (z.members||[]).forEach(m=>{ if(!e.members.includes(m)) e.members.push(m); }); });
  return by.filter(Boolean);
}
function baseName(z){ if(z.stationName) return z.stationName; return z.half ? z.name.replace(/ · [AB]$/, '') : z.name; }
// Peak flow the mainline has to carry: one STATION at a time. A SHARED
// split station opens both its valves together, so its two halves sum here;
// a separated split is two stations and each stands on its own.
function peakStationGPM(zones){ const s=stationZones(zones); return s.length ? Math.max(...s.map(x=>x.gpm)) : 0; }

// Global zone index for (area, its own zone number) — the master plan uses
// it to colour every head and bed by the valve it runs on.
// Pass the head itself when you have one: a split zone has two entries for
// the same (area, zone) and only the head's position says which valve.
function zoneIndexOf(zones, areaIdx, localZone, head, ctx){
  for(let i=0;i<(zones||[]).length;i++){
    const z=zones[i], parts=z.parts||[];
    if(!parts.some(pt => pt.areaIdx===areaIdx && pt.localZone===localZone)) continue;
    if(head && z.half){ const sp=splitFor(z, ctx); if(sp && headHalf(sp, head)!==z.half) continue; }
    return i;
  }
  return -1;
}

// Which valve group an area sits on, and every group currently in use.
function valveGroupsInUse(areas){
  const seen = [];
  (areas||[]).forEach(a => {
    if(a && a.family === 'drip' && a.valveGroup && !seen.includes(a.valveGroup)) seen.push(a.valveGroup);
  });
  return seen;
}

// ───── Odds and ends the maths needs ─────────────────────────────────
function manifoldIdxById(r, id){ return (r.manifolds||[]).findIndex(m=>m && m.id===id); }

// Every head of an area in SHEET feet, hand-placed or auto-laid-out alike,
// each carrying the zone packZones actually assigned it.
//
// This deliberately reads plan.heads rather than area.manualHeads. The
// layout editor never writes a `zone` onto a hand-placed head — zones are
// worked out downstream by packZones — so colouring off manualHeads put
// every head of a three-valve lawn in one colour, and auto-laid-out areas
// (no manualHeads at all) drew no heads whatsoever.
function mpHeadsOf(a, p){
  if(!p || !Array.isArray(p.heads) || !p.heads.length) return [];
  // No plan.poly means the head coordinates were computed in the area's own
  // rectangle frame, not the sheet's, so they cannot honestly be placed.
  if(!p.poly || !p.orig) return [];
  const o=p.orig;
  const base=headSpec(a);
  return p.heads.map(h=>({x:o.x+h.xft, y:o.y+h.yft, arc:h.arc, dir:h.dir||0,
                          zone:h.zone||0, r:h.r, gpm:h.gpm, nz:h.nz||base.label, family:a.family}));
}

/* Trees are POINTS, not an area. A tree zone often has no bed outline at
   all — just trees marked on the tender — so the lateral has to run to each
   tree and tee, exactly like a bed cluster. `a.trees` is already stored in
   the area's own frame, which IS sheet feet once the area is traced, so the
   positions need no transform (same deal as heads).

   Flow per tree mirrors computePlan's tree model: an RWS pair is two
   bubblers, a ring is its loop length of dripline at the product's rate. */
function mpTreesOf(a){
  const list=Array.isArray(a && a.trees)?a.trees:[];
  if(!list.length) return [];
  const d=DRIP_PRODUCTS[a.dripProduct]||DRIP_PRODUCTS.xf09, emitFt=Math.max(d.emitterIn,1)/12;
  return list.map((t,i)=>{
    const type=t.type||'ring', dia=t.dia||TREE_RING_DEFAULT_DIA;
    let gpm;
    if(type==='rws') gpm=2*TREE_RWS_GPM_PER_UNIT;
    else { const loop=Math.PI*dia+Math.PI*(dia/2); gpm=(loop/emitFt)*d.gph/60; }
    return {x:t.x, y:t.y, type, dia, gpm, idx:i};
  });
}

/* Lateral pipe as it is actually bought: the catalog roll for each size.
   1" comes on a 300 ft roll, not 400 — so switching a zone from 3/4" to 1"
   changes both the count and the price per roll, which is exactly why the
   BOM cannot go on ordering everything as 3/4". */
const LATERAL_ROLL = {
  '3/4"':   {sku:'POPO75400',  ft:400},
  '1"':     {sku:'POPO100300', ft:300},
  '1-1/4"': {sku:'POPO125300', ft:300},
  '1-1/2"': {sku:'POPO150250', ft:250},
  '2"':     {sku:'POPO200200', ft:200}
};

// ───── Per-head radius reduction ─────────────────────────────────────
const LO_MIN_ARC = 30;      // degrees — narrower than this is not a sprinkler
const LO_MIN_RPCT = 0.3;    // 30% of nominal throw, per the field request
const TWO_PI = Math.PI*2;

function loRadiusPct(hd){
  const v = Number(hd && hd.rPct);
  if(!Number.isFinite(v)) return 1;                 // absent = full throw (every pre-existing head)
  return Math.max(LO_MIN_RPCT, Math.min(1, v));
}

function polyCentroid(poly){ let x=0,y=0; poly.forEach(p=>{x+=p.x;y+=p.y;}); return {x:x/poly.length, y:y/poly.length}; }

const MANIFOLD_PER_BOX = 4;   // valves grouped per manifold box (typical)

function seriesSize(key){ return {s8:'8',s10:'10',s12:'12',s15:'15'}[key]||'12'; }

// Install-material SKUs (Patrick's defaults; all editable in the interactive BOM).
const BOM_SKU = {
  swingArm:'SJ506',        // swing joint / swing arm, 1 per head
  saddle:'DS75C',          // saddle tee, 1 per head
  gearClamp:'SC6712',      // SS gear clamp
  reducingEll:'1407130',   // poly reducing (combo) end elbow 1×0.5
  manifoldEll:'408010',    // 1" 90° ell (sch-80 substitute) for manifold
  manifoldTee:'405010',    // 1" tee (sch-80 substitute) for manifold
  nipple1x2:'210020',      // 1"×2" nipple, 2 per manifold tee
  maleAdapter:'1436010',   // poly 1" male adapter, 1 per zone (valve → lateral)
  boxJumbo:'VB10151089',   // jumbo = 12" deep square std valve box (4 valves)
  box10:'VB111011',        // 10" round (3 valves)
  box6:'DUVB60'            // 6" round (≤2 valves)
};

// Per-zone (per-area) material cost — a single rolled-up $ for one area's
// heads/pipe + its zone valve & fittings kit. Uses the SAME materials as the
// BOM so the per-area totals stay consistent with the material list / quote.
// Prices come from the loaded catalog (0 until it's fetched).
const partCentsIn = (parts, sku) => { const p=(parts||{})[sku]; return p&&p.priceCents!=null?p.priceCents:0; };
function areaMaterialCents(area, p, opts){
  const parts = (opts && opts.parts) || {};
  const partCents = sku => partCentsIn(parts, sku);
  if(!p || p.noShape) return 0;
  const z=p.zones||0;
  const headFam = (p.family==='rotor'||p.family==='mp'||p.family==='spray'||p.family==='strip');
  const nHeads = headFam ? (p.manual?(area.manualHeads||[]).length:(p.heads?p.heads.length:0)) : 0;
  let c=0;
  if(nHeads){
    if(p.family==='rotor') c+=partCents('HSPGPADJ')*nHeads;
    else if(p.family==='mp') c+=partCents('HSPROS04PRS30')*nHeads;
    else if(p.family==='spray'){ c+=partCents((SPRAY_BODIES[area.sprayBody]||SPRAY_BODIES.b4).sku)*nHeads;
      const sz=seriesSize(area.spraySeries); if(p.arcCount){ c+=partCents('RBN'+sz+'Q')*(p.arcCount[90]||0)+partCents('RBN'+sz+'H')*(p.arcCount[180]||0); } }
    else if(p.family==='strip'){ c+=partCents((SPRAY_BODIES[area.stripBody]||SPRAY_BODIES.b4).sku)*nHeads;
      const m={cst:'RBN15CST',sst:'RBN15SST'}[area.stripNoz]; if(m) c+=partCents(m)*nHeads; }
    c+=(partCents(BOM_SKU.swingArm)+partCents(BOM_SKU.saddle)+partCents(BOM_SKU.gearClamp))*nHeads;   // swing arm + saddle + clamp / head
  }
  if(p.family==='drip'||p.family==='trees'){
    const ft=(p.family==='drip'?p.dripLengthFt:p.tubeFt)||0, d=p.product;
    if(d && ft>0) c+=Math.round(partCents(d.sku)/(d.rollFt||250)*ft);       // dripline at linear-ft cost
    c+=partCents('RBDPSIM30X075')*z;                                        // pressure reg / zone
    if(p.family==='drip') c+=partCents('RBDXFFTEE')*Math.max(1,Math.round(ft/50))+partCents('RBDXFELB')*Math.max(2,Math.round(ft/40))+partCents('RBDXFFCOUP')*Math.max(1,Math.round(ft/250));
    else if(p.ringTrees>0) c+=partCents('RBDXFFTEE')*p.ringTrees+partCents('RBDXFELB')*p.ringTrees*2;
    if(p.rwsUnits>0) c+=partCents(TREE_RWS_SKU)*p.rwsUnits;
  }
  // Per-zone valve kit: valve + 2 reducing ells + 2 manifold ells + tee + 2 nipples + male adapter + clamp
  c+=z*( partCents('PGV100G') + partCents(BOM_SKU.reducingEll)*2 + partCents(BOM_SKU.manifoldEll)*2 + partCents(BOM_SKU.manifoldTee) + partCents(BOM_SKU.nipple1x2)*2 + partCents(BOM_SKU.maleAdapter) + partCents(BOM_SKU.gearClamp) );
  // Lateral pipe estimate for this area
  if(p.kind!=='drip' && nHeads){ const sf=parseFloat(opts && opts.spacingFactor)||1, lat=nHeads*Math.max(headSpec(area).r*sf,1)*0.6; c+=Math.round(partCents('POPO75400')/400*lat); }
  return Math.round(c);
}

// Aggregate the parts list from the current plans.
function buildBOM(opts){
  const plans = (opts && opts.plans) || [];
  const zoneList = (opts && opts.zones) || [];
  const parts = (opts && opts.parts) || {};
  // Measured lateral footage comes from walking the routed site-plan
  // sheets, which is drawing, not calculation — so the page measures and
  // hands the RESULT in. Absent, the head-count estimate runs, exactly as
  // it did before any sheet was routed.
  const latM = (opts && opts.laterals) || { measured:false, bySize:{}, totalFt:0 };
  const cat={}, non=[];
  const add=(sku,qty)=>{ qty=Math.round(qty); if(sku && qty>0) cat[sku]=(cat[sku]||0)+qty; };
  const addNon=(label,qty)=>{ qty=Math.round(qty); if(qty>0) non.push({label,qty}); };
  const sf=parseFloat(opts && opts.spacingFactor)||1;
  // Per-valve hardware (valve, manifold fittings, box, wire, controller
  // sizing) is counted from the design-level zone plan. Per-bed hardware —
  // notably the Xeri pressure regulator — is still counted per area below,
  // because grouping beds onto one valve does NOT remove their regulators.
  let totalZones=zoneList.length, totalHeads=0, lateralFt=0;      // VALVES — a split zone is two
  let lateralBySize={}, lateralMeasured=false;
  const totalStations=stationCount(zoneList);                     // what the controller is sized on
  // Drip tube is bought for the WHOLE system, not per zone: accumulate all
  // footage by product, then buy rolls once (see roll math after the loop).
  const dripFt={};
  const accDrip=(d,ft)=>{ if(!d||!(ft>0)) return; const k=d.sku; (dripFt[k]||(dripFt[k]={d,ft:0})).ft+=ft; };

  plans.forEach(({area,plan:p})=>{
    if(p.noShape) return;                 // custom area with nothing drawn yet
    const isHeadFam=(p.family==='rotor'||p.family==='mp'||p.family==='spray'||p.family==='strip');
    if(isHeadFam) totalHeads += p.manual ? (area.manualHeads||[]).length : (p.heads?p.heads.length:0);
    if(p.kind!=='drip' && p.heads.length){
      lateralFt += p.heads.length * Math.max(headSpec(area).r*sf,1) * 0.6;  // rough trunk+branch
    }
    // Manual layout: count each hand-placed head's own nozzle + arc.
    if(p.manual){
      const heads=area.manualHeads||[];
      if(p.family==='rotor'){ add('HSPGPADJ', heads.length); }
      else if(p.family==='mp'){ add('HSPROS04PRS30', heads.length); addNon('MP Rotator nozzle (various)', heads.length); }
      else if(p.family==='spray'){
        add((SPRAY_BODIES[area.sprayBody]||SPRAY_BODIES.b4).sku, heads.length);
        heads.forEach(mh=>{ const sz=seriesSize(mh.noz), a=mh.arc;
          if(a<=90){ parts['RBN'+sz+'Q']?add('RBN'+sz+'Q',1):addNon('RB nozzle '+sz+'Q',1); }
          else if(a<=180){ parts['RBN'+sz+'H']?add('RBN'+sz+'H',1):addNon('RB nozzle '+sz+'H',1); }
          else if(a<=270){ addNon('RB nozzle '+sz+'T (three-quarter - not stocked)',1); }
          else { addNon('RB nozzle '+sz+'F (full circle - not stocked)',1); }
        });
      }
      return;
    }
    if(p.family==='rotor'){ add('HSPGPADJ', p.heads.length); }
    else if(p.family==='mp'){ add('HSPROS04PRS30', p.heads.length); addNon('MP Rotator nozzle - '+((MP_NOZZLES[area.mpNoz]||{}).label||''), p.heads.length); }
    else if(p.family==='spray'){
      add((SPRAY_BODIES[area.sprayBody]||SPRAY_BODIES.b4).sku, p.heads.length);
      const sz=seriesSize(area.spraySeries);
      if(parts['RBN'+sz+'Q']) add('RBN'+sz+'Q', p.arcCount[90]); else addNon('RB nozzle '+sz+'Q', p.arcCount[90]);
      if(parts['RBN'+sz+'H']) add('RBN'+sz+'H', p.arcCount[180]); else addNon('RB nozzle '+sz+'H', p.arcCount[180]);
      addNon('RB nozzle '+sz+'F (full circle - not stocked)', p.arcCount[360]);
    }
    else if(p.family==='strip'){
      add((SPRAY_BODIES[area.stripBody]||SPRAY_BODIES.b4).sku, p.heads.length);
      const map={cst:'RBN15CST', sst:'RBN15SST'};
      const sku=map[area.stripNoz];
      if(sku && parts[sku]) add(sku, p.heads.length);
      else addNon('RB '+((STRIP_NOZZLES[area.stripNoz]||{}).label||area.stripNoz)+' (not stocked)', p.heads.length);
    }
    else if(p.family==='drip'){
      accDrip(p.product, p.dripLengthFt);                             // area drip + tree ring tube (rolled system-wide)
      // One pressure regulator PER BED. A bed sharing a valve still needs
      // its own; only a bed big enough to need several valves of its own
      // takes more than one.
      add('RBDPSIM30X075', area.valveGroup ? 1 : p.zones);
      add('RBDXFFTEE', Math.max(1,Math.round(p.dripLengthFt/50))+(p.ringTrees||0));  // +1 tap tee / ring tree
      add('RBDXFELB',  Math.max(2,Math.round(p.dripLengthFt/40)));
      add('RBDXFFCOUP',Math.max(1,Math.round(p.dripLengthFt/250)));
      add('CTISDRIPSTAPLES25', Math.max(1,Math.ceil((p.dripLengthFt/3)/25)));
      if(p.rwsUnits>0) add(TREE_RWS_SKU, p.rwsUnits);                 // RWS trees in the drip zone
    }
    else if(p.family==='trees'){
      if(p.rwsUnits>0) add(TREE_RWS_SKU, p.rwsUnits);                 // 2 RWS units per RWS tree
      if(p.ringTrees>0){
        accDrip(p.product, p.tubeFt);                                // tree-ring tube (rolled system-wide)
        add('RBDXFFTEE', p.ringTrees);                               // ~1 tee per tree tap
        add('RBDXFELB',  p.ringTrees*2);                             // ring bends
        add('CTISDRIPSTAPLES25', Math.max(1,Math.ceil((p.tubeFt/2)/25)));
      }
      add('RBDPSIM30X075', p.zones);                                 // pressure reg / zone
    }
  });

  // Drip rolls, system-wide. Buy 500 ft rolls for the bulk; a leftover of
  // 200 ft or more rounds UP to another 500 (Patrick's rule) rather than a
  // 250 ft roll — only a small top-up (<200 ft) takes a 250.
  const DRIP_ROLL500_MIN = 200;
  Object.values(dripFt).forEach(({d,ft})=>{
    ft=Math.ceil(ft); if(ft<=0) return;
    if(d.roll2){
      let n500=Math.floor(ft/d.roll2.ft), rem=ft-n500*d.roll2.ft;
      if(rem>=DRIP_ROLL500_MIN){ n500+=1; rem=0; }
      if(n500>0) add(d.roll2.sku, n500);
      if(rem>0) add(d.sku, Math.ceil(rem/d.rollFt));
    } else {
      add(d.sku, Math.ceil(ft/d.rollFt));
    }
  });

  // ── Per-head install materials (rotor/spray/mp/strip heads only) ──
  add(BOM_SKU.swingArm, totalHeads);          // 1 swing arm / head
  add(BOM_SKU.saddle,   totalHeads);          // 1 saddle tee / head

  // ── Valves, manifold fittings & boxes ──
  add('PGV100G', totalZones);                 // 1" valve / zone
  add(BOM_SKU.reducingEll, 2*totalZones);     // ≥2 reducing end elbows / zone
  add(BOM_SKU.manifoldEll, 2*totalZones);     // 2× 1" ells / valve (manifold)
  add(BOM_SKU.manifoldTee, totalZones);       // 1× 1" tee / valve (manifold)
  add(BOM_SKU.nipple1x2,   2*totalZones);     // 2× 1"×2" nipple / manifold tee
  add(BOM_SKU.maleAdapter, totalZones);       // 1× 1" male adapter / zone

  // Manifolds group up to MANIFOLD_PER_BOX valves; box size = valves in it.
  const manifoldSizes=[]; { let r=totalZones; while(r>0){ manifoldSizes.push(Math.min(MANIFOLD_PER_BOX,r)); r-=MANIFOLD_PER_BOX; } }
  const nManifolds=manifoldSizes.length;
  manifoldSizes.forEach(sz=>{
    add(sz>=4?BOM_SKU.boxJumbo : sz===3?BOM_SKU.box10 : BOM_SKU.box6, 1);
  });
  // Gear clamps: 1/head + 1/zone + 2/manifold (mainline)
  add(BOM_SKU.gearClamp, totalHeads + totalZones + 2*nManifolds);

  // Lateral pipe. Measured off the master plan when the design has been
  // routed — each zone's own size, rounded up to whole catalog rolls. With
  // nothing routed yet it falls back to the old head-count estimate, all
  // 3/4", exactly as before.
  if(latM.measured){
    lateralFt = latM.totalFt;
    lateralBySize = latM.bySize;
    lateralMeasured = true;
    Object.keys(latM.bySize).forEach(size=>{
      const roll=LATERAL_ROLL[size]; if(!roll) return;
      add(roll.sku, Math.ceil(latM.bySize[size]/roll.ft));
    });
  } else if(lateralFt>0){
    lateralBySize = {'3/4"': lateralFt};
    add('POPO75400', Math.ceil(lateralFt/400));                       // 3/4" lateral (estimate)
  }

  if(totalStations>0){
    if(totalStations<=4) add('HCX2400',1);
    else if(totalStations<=6) add('HCX2600',1);
    else if(totalStations<=8) add('HCX2800',1);
    else if(totalStations<=14) add('HCX21400',1);
    else { add('HCHPC400',1); const ext=Math.ceil((totalStations-6)/9); add('HCPCM900',ext); }
  }

  const lines=Object.entries(cat).map(([sku,qty])=>{
    const pt=parts[sku];
    return {sku, desc:pt?pt.description:sku, qty, priceCents:pt?pt.priceCents:null, unit:pt?pt.unit:'each'};
  }).sort((a,b)=>a.sku.localeCompare(b.sku));
  non.forEach(n=>lines.push({sku:'-', desc:n.label, qty:n.qty, priceCents:null, unit:'each'}));
  const subtotalCents=lines.reduce((s,l)=>s+(l.priceCents!=null?l.priceCents*l.qty:0),0);
  return {lines, subtotalCents, lateralFt:Math.ceil(lateralFt), lateralBySize, lateralMeasured};
}

// ───── What the page (and anything else) may use ──────────────────────
return {
  // Entry points.
  computePlan, computeZonePlan, buildBOM, areaMaterialCents,

  // Catalogs — manufacturer performance data and Patrick's default SKUs.
  PGP_NOZZLES, MP_NOZZLES, SPRAY_SERIES, SPRAY_BODIES, STRIP_NOZZLES,
  DRIP_PRODUCTS, FAMILIES, FAMILY_ORDER, LEGACY_HEAD_MAP,
  TREE_RWS_SKU, TREE_RWS_GPM_PER_UNIT, TREE_RING_DEFAULT_DIA,
  BOM_SKU, LATERAL_ROLL, MANIFOLD_PER_BOX,
  LO_MIN_ARC, LO_MIN_RPCT, TWO_PI, PZ_BALANCE_BUDGET, DRIP_MAX_SCANLINES,

  // Areas: normalization, head specs, defaults.
  familyDefaults, ensureArea, headSpec, loHeadSpec, loNozzles,
  loManualCapable, loRadiusPct, newArea, mintId, seriesSize,

  // Geometry.
  polyArea, polyPerim, polyBBox, polyCentroid, pointInPoly, validPoly,
  circlePoly, sectorPoly, isCircle, isSector, combinedExtent, geom,
  polyChords, chordThrough, isConvexish, dripRunSegments,

  // Zone packing.
  pzZoneOk, pzMinZones, pzBalancedCuts, packZones,

  // The design-level zone plan.
  applyValveSplits, bedBoxFor, splitFor, baseKey, baseName, headHalf,
  splitStationRule, migrateRoutingSplits,
  zoneFeedsHead, mpZoneHeads, zoneIndexOf, valveGroupsInUse,
  stationCount, stationZones, peakStationGPM,
  manifoldIdxById, mpHeadsOf, mpTreesOf,
  valveGroupMode, planFor, partCentsIn
};
});
