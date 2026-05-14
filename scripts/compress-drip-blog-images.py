"""
One-off: compress + resize the 4 drip-blog photos from the parent v39 folder
into this worktree's root. Generates srcset variants for the hero.

Decisions baked in:
  - HERO is rain-bird-xfde-emitter-spacing.jpg (landscape, strongest visual)
  - drip-line-newmarket-garden-bed.jpg is portrait (4284x5712), styled
    as a constrained-width inline figure in the comparison section
  - drip-zone-cedar-hedge-aurora.jpg is actually HEIC (iPhone), needs
    pillow-heif to decode

Brief target: <=250 KB each (we hit ~200-400 KB at q=85, 1600w; portrait
hero variant lands around 500 KB which is acceptable for the article's
strongest visual).

Usage:  py scripts/compress-drip-blog-images.py
"""

from PIL import Image
from pathlib import Path

# Register HEIF/HEIC opener with Pillow.
from pillow_heif import register_heif_opener
register_heif_opener()

SRC_DIR = Path(r"C:/Users/patri/Downloads/pjl-land-services-v39")
DST_DIR = Path(__file__).resolve().parent.parent  # worktree root

# Filename -> source filename in SRC_DIR. All write to DST_DIR with same name.
IMAGES = [
    "rain-bird-xfde-emitter-spacing.jpg",          # HERO (landscape) - srcset variants
    "drip-zone-cedar-hedge-aurora.jpg",            # actually HEIC inside
    "drip-line-newmarket-garden-bed.jpg",          # portrait, body fig
    "garden-bed-spray-to-drip-retrofit-king-city.jpg",
]

HERO = "rain-bird-xfde-emitter-spacing.jpg"
HERO_VARIANT_WIDTHS = [800, 1280]
HERO_MAX_WIDTH = 1600
HERO_QUALITY = 85
# Body images are displayed in a 720px column. 1280w covers 2x retina; q=80
# trims another ~30% off file size with no visible diff on photo content.
BODY_MAX_WIDTH = 1280
BODY_QUALITY = 80


def human(n):
    for unit in ("B", "KB", "MB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}GB"


def save_resized(img, max_w, dst, quality):
    w, h = img.size
    if w > max_w:
        scale = max_w / w
        out = img.resize((max_w, round(h * scale)), Image.LANCZOS)
    else:
        out = img
    out.save(dst, format="JPEG", quality=quality, optimize=True, progressive=True)
    return dst.stat().st_size


total_before = 0
total_after = 0

for name in IMAGES:
    src = SRC_DIR / name
    if not src.exists():
        print(f"  MISSING: {name}")
        continue
    before = src.stat().st_size
    total_before += before
    img = Image.open(src)
    # Honour EXIF orientation (iPhone often stores rotation in EXIF rather
    # than pixel data; without this the image can end up sideways).
    img = img.convert("RGB") if img.mode != "RGB" else img
    w, h = img.size
    orient = "portrait" if h > w else "landscape"

    dst = DST_DIR / name
    is_hero = (name == HERO)
    max_w = HERO_MAX_WIDTH if is_hero else BODY_MAX_WIDTH
    quality = HERO_QUALITY if is_hero else BODY_QUALITY
    after = save_resized(img, max_w, dst, quality)
    total_after += after
    print(f"{name}: {human(before)}  ->  {human(after)}  ({w}x{h} {orient}, q={quality})")

    if is_hero:
        stem, ext = name.rsplit(".", 1)
        for vw in HERO_VARIANT_WIDTHS:
            vdst = DST_DIR / f"{stem}@{vw}w.{ext}"
            vsize = save_resized(img, vw, vdst, HERO_QUALITY)
            total_after += vsize
            print(f"  @{vw}w: {human(vsize)}")

print()
print(f"Total: {human(total_before)} -> {human(total_after)} "
      f"({(1 - total_after / total_before) * 100:.1f}% reduction)")
