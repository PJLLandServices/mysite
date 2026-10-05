#!/usr/bin/env node
// scripts/test-photo-canvas.mjs
//
// The two photo canvases (pjl-field/src/photo-canvas.mjs) run in a REAL
// browser engine (Playwright's Chromium), driven the way the app drives
// them: the same messages in, the same messages out, strokes drawn with a
// pointer. The photo is one 4032×3024 JPEG from the website's own files
// (landscape-lighting-hero.jpg), re-encoded at the app's picker quality.
// It is iPhone-sized but carries no camera data, so it is not proven to be
// an iPhone photo, and it is not from Patrick's phone. A real photograph,
// not a synthetic one: a stand-in until the device check measures real
// captures.
//
//   EDITOR  loads a full-size photo; pen, arrow, circle and text each add
//           a mark; undo and reset; export is a JPEG capped at 2400 px with
//           the marks in it; a photo that will not decode says so.
//   SHRINK  a full-size photo comes back at 2400 px and smaller; a small
//           one, an undecodable one and one that would not get smaller
//           come back "keep the original". Prints the upload for a
//           12-photo closing, before and after.
//
// NOT in build:check: CI installs no browser, and a check that skips
// itself proves nothing. Run it on any change to photo-canvas.mjs:
//   node scripts/test-photo-canvas.mjs
// It is the closest a machine gets to the phone. It does not replace the
// device check on Patrick's phone (WebKit there, not Chromium; the
// phone's memory, not this machine's).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const { chromium } = await import("playwright");
const { EDITOR_HTML, SHRINK_HTML, MAX_EDGE } = await import(pathToFileURL(path.join(ROOT, "pjl-field/src/photo-canvas.mjs")).href);

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
const launch = () => {
  const fallback = "/opt/pw-browsers/chromium";
  return chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : fs.existsSync(fallback) ? { executablePath: fallback } : {});
};

const original = fs.readFileSync(path.join(ROOT, "landscape-lighting-hero.jpg"));
const meta = await sharp(original).metadata();
const atQuality = async (q) => sharp(original).jpeg({ quality: q }).toBuffer();
const dataUrl = (buf, type = "image/jpeg") => `data:${type};base64,${buf.toString("base64")}`;
const fromDataUrl = (u) => Buffer.from(u.slice(u.indexOf(",") + 1), "base64");

// A page the way the WebView hosts it: messages out through
// window.ReactNativeWebView, messages in as 'message' events.
async function host(browser, html, viewport = { width: 390, height: 600 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  // What react-native-webview injects, put in front of the page's script.
  const shim = "<script>window.__out = []; window.ReactNativeWebView = { postMessage: function (m) { window.__out.push(JSON.parse(m)); } };</script>";
  await page.setContent(html.replace("<script>", shim + "<script>"));
  const send = (m) => page.evaluate((x) => window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(x) })), m);
  const next = async (type, timeout = 20000) => {
    const h = await page.waitForFunction((t) => {
      const i = window.__out.findIndex((m) => m.type === t);
      if (i < 0) return null;
      return window.__out.splice(i, 1)[0];
    }, type, { timeout, polling: 50 });
    return h.jsonValue();
  };
  return { page, send, next, errors };
}

const browser = await launch();
try {
  ok(meta.width === 4032 && meta.height === 3024, `setup: a 4032×3024 photograph (${meta.width}×${meta.height})`);
  ok(!/https?:\/\//.test(EDITOR_HTML) && !/https?:\/\//.test(SHRINK_HTML), "both pages are self-contained: nothing loads from the network");

  // ---- EDITOR -------------------------------------------------------------
  {
    const e = await host(browser, EDITOR_HTML);
    await e.next("ready");
    const q55 = await atQuality(55);
    await e.send({ type: "load", src: dataUrl(q55) });
    const loaded = await e.next("loaded");
    ok(loaded.width === 4032 && loaded.height === 3024, `editor: the full-size photo loads (${loaded.width}×${loaded.height})`);
    // The photo is fitted to a 390×600 screen: 390 wide, centred.
    const drag = async (x1, y1, x2, y2) => {
      await e.page.mouse.move(x1, y1); await e.page.mouse.down();
      for (let i = 1; i <= 6; i++) await e.page.mouse.move(x1 + (x2 - x1) * i / 6, y1 + (y2 - y1) * i / 6);
      await e.page.mouse.up();
      return e.next("marks");
    };
    await e.send({ type: "tool", tool: "pen", color: "#E5322D", width: "thick" });
    let m = await drag(60, 250, 200, 320);
    ok(m.count === 1, "editor: the pen adds a mark");
    await e.send({ type: "tool", tool: "arrow" });
    m = await drag(300, 200, 220, 280);
    await e.send({ type: "tool", tool: "circle", color: "#FFD60A", width: "thin" });
    m = await drag(120, 330, 260, 400);
    ok(m.count === 3, `editor: arrow and circle add marks (${m.count})`);
    await e.send({ type: "tool", tool: "text", color: "#FFFFFF" });
    await e.page.mouse.click(100, 230);
    const tap = await e.next("textAt");
    ok(tap.at.x > 0 && tap.at.x < 4032 && tap.at.y > 0 && tap.at.y < 3024, `editor: a text tap is in the photo's own pixels (${Math.round(tap.at.x)}, ${Math.round(tap.at.y)})`);
    await e.send({ type: "text", at: tap.at, text: "Broken head" });
    m = await e.next("marks");
    ok(m.count === 4, "editor: the label is placed");
    await e.send({ type: "undo" });
    ok((await e.next("marks")).count === 3, "editor: undo takes back one mark");
    await e.send({ type: "reset" });
    ok((await e.next("marks")).count === 0, "editor: reset goes back to the clean photo");
    await e.send({ type: "export" });
    const plain = await e.next("exported");
    await e.send({ type: "tool", tool: "pen", color: "#E5322D", width: "thick" });
    await drag(60, 250, 200, 320);
    await e.send({ type: "tool", tool: "circle" });
    await drag(120, 330, 260, 400);
    const t0 = Date.now();
    await e.send({ type: "export" });
    const marked = await e.next("exported");
    const exportMs = Date.now() - t0;
    const out = await sharp(fromDataUrl(marked.data)).metadata();
    ok(marked.data.startsWith("data:image/jpeg;base64,") && out.format === "jpeg", "editor: export is a JPEG");
    ok(Math.max(out.width, out.height) === MAX_EDGE && out.width === 2400 && out.height === 1800, `editor: export is capped at 2400 px, shape kept (${out.width}×${out.height})`);
    // The marks are in the saved photo: it has the pen's red where the
    // clean export has almost none.
    const reds = async (u) => {
      const { data, info } = await sharp(fromDataUrl(u)).raw().toBuffer({ resolveWithObject: true });
      let n = 0;
      for (let i = 0; i < data.length; i += info.channels) if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) n++;
      return n;
    };
    const [a, b] = [await reds(plain.data), await reds(marked.data)];
    ok(b > a + 2000, `editor: the marks are in the saved photo (red pixels ${a} → ${b})`);
    console.log(`editor: export ${out.width}×${out.height}, ${mb(fromDataUrl(marked.data).length)}, ${exportMs} ms (this machine)`);
    await e.send({ type: "load", src: "data:image/jpeg;base64,bm90IGEgcGhvdG8=" });
    ok(Boolean(await e.next("loadError")), "editor: a photo that will not decode says so");
    ok(e.errors.length === 0, `editor: no page errors (${e.errors.join("; ")})`);
    await e.page.close();
  }

  // ---- SHRINK -------------------------------------------------------------
  {
    const s = await host(browser, SHRINK_HTML, { width: 10, height: 10 });
    await s.next("ready");
    const shrink = async (buf, id, type) => { await s.send({ type: "shrink", id, src: dataUrl(buf, type), bytes: buf.length }); return s.next("shrunk"); };
    const rows = [];
    // 80: the picker's quality when shrinking is on (photos.js); 40: when
    // it is off, so a photo that gets here anyway is still handled.
    for (const q of [80, 40]) {
      const input = await atQuality(q);
      const t0 = Date.now();
      const r = await shrink(input, `q${q}`);
      const ms = Date.now() - t0;
      const outBuf = r.data ? fromDataUrl(r.data) : input;
      const outMeta = await sharp(outBuf).metadata();
      rows.push({ q, input: input.length, output: outBuf.length, ms, w: outMeta.width, h: outMeta.height });
      ok(r.id === `q${q}` && !r.error && !r.same, `shrink: a full-size photo at picker quality 0.${q} is resized`);
      ok(outMeta.width === 2400 && outMeta.height === 1800, `shrink: to 2400×1800 (${outMeta.width}×${outMeta.height})`);
      ok(outBuf.length < input.length, `shrink: and smaller (${mb(input.length)} → ${mb(outBuf.length)})`);
    }
    const small = await sharp(original).resize(1200).jpeg({ quality: 70 }).toBuffer();
    ok((await shrink(small, "small")).same === true, "shrink: a photo already under 2400 px is kept as it is");
    const r = await shrink(Buffer.from("not a photo"), "bad");
    ok(r.error === "decode", "shrink: a photo the page cannot decode is kept as it is (error, original goes up)");
    // A tiny-but-large-dimension photo that would only grow: keep it.
    // Busy detail saved at a very low quality: re-saving it at 0.75, even
    // smaller, comes out bigger.
    const flat = await sharp({ create: { width: 4032, height: 3024, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 70 } } }).jpeg({ quality: 5 }).toBuffer();
    ok((await shrink(flat, "flat")).same === true, "shrink: when the result would not be smaller, the original is kept");
    ok(s.errors.length === 0, `shrink: no page errors (${s.errors.join("; ")})`);

    console.log("\nThe upload for a 12-photo closing (this ONE photo, counted 12 times — not 12 captures):");
    for (const row of rows) {
      console.log(`  picker quality 0.${row.q}: ${mb(row.input * 12)} full size → ${mb(row.output * 12)} shrunk (${Math.round(row.output / row.input * 100)}%), ${row.ms} ms per photo here`);
    }
    const before = (await atQuality(55)).length, now = (await atQuality(40)).length, shrunk = rows.find((r) => r.q === 80).output;
    console.log(`  today on main (0.55, full size): ${mb(before * 12)} · #378 (0.40, full size): ${mb(now * 12)} · shrinking on (0.80 → 2400 px @ 0.75): ${mb(shrunk * 12)}`);
    ok(shrunk < now, `shrink: with shrinking on, a photo uploads smaller than the 0.40 full-size photo (${mb(shrunk)} vs ${mb(now)})`);
    await s.page.close();
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL: crashed: ${err?.stack || err}`);
} finally {
  await browser.close();
}
console.log(`photo-canvas: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
