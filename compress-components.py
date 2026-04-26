"""
Smart compressor for the sprinkler component photos.

Strategy:
  - PNG with meaningful alpha channel  -> stay PNG, optimize
  - PNG with no alpha (RGB)            -> convert to JPG (huge savings,
                                          no visible diff for photos)
  - JPEG (regardless of extension)     -> stay JPG, re-encode at q=85

When a file's format changes, the old file is removed and the new file
is written with the correct extension. Caller is responsible for
updating any HTML that references the old filename.
"""

from PIL import Image
from pathlib import Path

MAX_EDGE = 1200
JPG_QUALITY = 85
HERE = Path(__file__).parent

TARGETS = [
    "hunter-hpc-400.png",
    "hunter-pgv-valve.png",
    "hunter-pgp-rotor.png",
    "hunter-pro-spray.png",
    "rainbird-mpr-nozzle.png",   # actually a JPEG inside, will normalize
    "rainbird-xfd-dripline.png",
]

def human(n):
    for unit in ("B", "KB", "MB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}GB"

def has_meaningful_alpha(img):
    """True if the alpha channel has any non-fully-opaque pixels."""
    if img.mode != "RGBA":
        return False
    alpha = img.split()[-1]
    return alpha.getextrema()[0] < 255  # min alpha < 255 means real transparency

results = []
total_before = 0
total_after = 0

for name in TARGETS:
    src = HERE / name
    if not src.exists():
        print(f"  X MISSING: {name}")
        continue

    before = src.stat().st_size
    total_before += before

    img = Image.open(src)
    actual_format = img.format  # PIL detects from headers, not extension
    w, h = img.size

    # Resize if oversized
    if max(w, h) > MAX_EDGE:
        scale = MAX_EDGE / max(w, h)
        img = img.resize((round(w * scale), round(h * scale)), Image.LANCZOS)

    # Decide output format
    keep_png = (img.mode == "RGBA" and has_meaningful_alpha(img))

    if keep_png:
        # Real transparency -> stay PNG
        out = src.with_suffix(".png")
        img.save(out, format="PNG", optimize=True)
    else:
        # RGB photo -> JPG
        if img.mode != "RGB":
            img = img.convert("RGB")
        out = src.with_suffix(".jpg")
        img.save(out, format="JPEG", quality=JPG_QUALITY, optimize=True, progressive=True)
        # Remove the source if its name differs (e.g., .png -> .jpg)
        if src != out and src.exists():
            src.unlink()

    after = out.stat().st_size
    total_after += after
    pct = 100 * (1 - after / before)
    rename_note = f"  [renamed to {out.name}]" if out.name != name else ""
    print(f"  {name:<32} {human(before):>9} -> {human(after):>9}  (-{pct:.0f}%){rename_note}")
    results.append((name, out.name))

print()
print(f"  TOTAL: {human(total_before)} -> {human(total_after)}  "
      f"(-{100 * (1 - total_after / total_before):.0f}%)")
print()
print("Filename map (old -> new):")
for old, new in results:
    if old != new:
        print(f"  {old}  ->  {new}")
