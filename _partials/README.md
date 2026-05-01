# Shared partials

This folder holds the source-of-truth markup for site-wide UI blocks
(footer today; nav coming next). Editing one file here updates every
page on the site that opts in via marker comments.

## How it works

A page opts into a partial by wrapping its current markup with marker
comments:

```html
<!-- @@PJL:footer-START -->
<footer class="footer">...current footer markup...</footer>
<!-- @@PJL:footer-END -->
```

After editing `_partials/footer.html`, run:

```sh
npm run build
```

That walks every `*.html` at the project root and replaces everything
between matching START/END markers with the latest partial content.
Files without markers are left alone.

To verify the site is in sync (e.g., as a pre-push check):

```sh
npm run build:check
```

Exits non-zero if any file would change — useful in CI or as a sanity
check before cherry-picking to main.

## What's in here

- `footer.html` — site-wide footer (5 columns: brand / services /
  service areas / company / contact). Includes the Innisfil link and
  links every page back to all 14 service-area pages, which is the
  single biggest internal-linking SEO improvement on the site.

## Editing rules

1. **Don't edit the markup between markers in a page directly** — it
   gets clobbered on the next `npm run build`. Edit `_partials/`
   instead.
2. **Run `npm run build` after editing a partial** before committing.
   The check script will catch you if you forget.
3. **One marker pair per partial per page**, in order. Markers must
   match exactly (`<!-- @@PJL:footer-START -->` / `-END -->`).
