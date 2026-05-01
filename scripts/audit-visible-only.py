"""Find prices in TRULY-VISIBLE HTML body. Strips scripts, meta, comments, existing tokens."""
import re
import os

SKIP = {"pricing.html", "diagnose.html", "accessibility-statement.html",
        "privacy-policy.html", "terms-of-service.html", "sitemap.html", "quote-legacy.html"}

PRICE_RE = re.compile(
    r"\$(?:95|68|74\.95|135|285|120|90|145|595|750|1,195|345|435|187|454\.85|829\.70|679\.80|304\.95|379\.90|754\.75|575|585|549|749|175)\b"
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
total = 0
report = []
for f in sorted(os.listdir(ROOT)):
    if not f.endswith(".html") or f in SKIP:
        continue
    path = os.path.join(ROOT, f)
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        t = fh.read()
    # Strip
    t = re.sub(r"<script[\s\S]*?</script>", "", t, flags=re.IGNORECASE)
    t = re.sub(r"<style[\s\S]*?</style>", "", t, flags=re.IGNORECASE)
    t = re.sub(r"<meta[^>]*>", "", t, flags=re.IGNORECASE)
    t = re.sub(r"<title>[^<]*</title>", "", t, flags=re.IGNORECASE)
    t = re.sub(r"<!--[\s\S]*?-->", "", t)
    t = re.sub(r'<span\s+data-price[^>]*>[^<]*</span>', "", t, flags=re.IGNORECASE)
    t = re.sub(r'<span\s+data-pjl-quote-formula[^>]*>[^<]*</span>', "", t, flags=re.IGNORECASE)
    matches = PRICE_RE.findall(t)
    if matches:
        # Show 80 chars of context for each match
        contexts = []
        s = t
        for m in set(matches):
            idx = s.find(m)
            if idx >= 0:
                start = max(0, idx - 50)
                end = min(len(s), idx + len(m) + 30)
                ctx = s[start:end].replace("\n", " ").strip()
                contexts.append(f"  {m}: ...{ctx}...")
        report.append((f, len(matches), contexts))
        total += len(matches)

for f, n, contexts in report:
    print(f"\n{f} — {n} visible-body matches:")
    for c in contexts[:5]:
        print(c)
print(f"\n=== TOTAL visible-body unconverted: {total} ===")
