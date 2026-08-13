# Vendored pdf.js — PINNED

| | |
|---|---|
| **Package** | `pdfjs-dist` (Mozilla pdf.js) |
| **Version** | **4.10.38** — pinned. Do not bump without re-reading the note below. |
| **Build** | `legacy/` (wider browser-compat target than the default build) |
| **Upstream tarball** | `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz` |
| **Tarball sha1** | `3ee698003790dc266cc8b55c0e662ccb9ae18f53` (matches the npm registry `dist.shasum`) |
| **Licence** | Apache-2.0 (notice retained inline at the top of each file) |

## Files

| File | sha256 | Source path in tarball |
|---|---|---|
| `pdf.min.mjs` | `44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72` | `package/legacy/build/pdf.min.mjs` |
| `pdf.worker.min.mjs` | `bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d` | `package/legacy/build/pdf.worker.min.mjs` |

Both are byte-identical to upstream — nothing was patched. Re-verify with:

```
curl -sS -o /tmp/pdfjs.tgz https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-4.10.38.tgz
tar xzOf /tmp/pdfjs.tgz package/legacy/build/pdf.min.mjs | sha256sum
tar xzOf /tmp/pdfjs.tgz package/legacy/build/pdf.worker.min.mjs | sha256sum
```

## Why this is vendored and not an npm dependency (DEV-02)

This is the **first vendored front-end library in the codebase** — a conscious
architectural deviation, accepted 2026-08-13.

- It is **never loaded on the server**. `server.js` and `lib/` do not require it.
  It executes only in the browser, only inside the Sprinkler System Builder's
  site-plan upload dialog, and only to rasterize a PDF page to a canvas.
- It is **not in `package.json` dependencies** because nothing installs or
  imports it at runtime. It is a static asset, served like any image.
- **No build step.** These are prebuilt files served verbatim. "Code written is
  code shipped" still holds.
- The alternative — rasterizing PDFs server-side — needs a native binary
  (poppler / ghostscript) on the Render Starter instance. That was judged
  materially worse than two static files.

## How it is served and loaded

- Served at `/crm/vendor/pdfjs/pdf.min.mjs` and `/crm/vendor/pdfjs/pdf.worker.min.mjs`
  via the existing `/crm/` static branch in `resolveStaticTarget` (`server.js`),
  which already resolves nested subpaths through the same sandboxed
  `path.normalize` + prefix check as every other static file. The resolver was
  **not** modified for this.
- `.mjs` is registered in `MIME_TYPES` (`server.js`) as `text/javascript` so the
  browser will accept both the dynamic `import()` and the module worker.
- Loaded **lazily** by `sitebuilder.html` — `import()`ed the first time the
  upload dialog is opened, so the builder's initial paint is unaffected.
