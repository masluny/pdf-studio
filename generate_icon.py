"""
Take the ACTUAL video-editor icon (the one shown on the Mac desktop) and
recolor its palette: blue→pink, yellow→green. Save all Tauri icon formats.
"""

from PIL import Image
import colorsys
import os, subprocess, shutil

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
ICNS_SRC = os.path.join(SRC_DIR, "video_editor_icon_src.png")
DST_DIR = os.path.join(SRC_DIR, "src-tauri", "icons")


def recolor(img):
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 10:
                continue
            hue, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            hue_deg = hue * 360

            # Dark pixels: desaturate to remove any color tint from background
            if v < 0.25:
                gray = int(v * 255)
                px[x, y] = (gray, gray, gray, a)
                continue

            # Skip truly gray pixels
            if s < 0.05:
                continue

            # Recolor: blue/cyan/teal → pink, yellow/gold → green
            if 100 <= hue_deg <= 250:
                nr, ng, nb = colorsys.hsv_to_rgb(335 / 360, s, v)
                px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
            elif 15 <= hue_deg < 100:
                nr, ng, nb = colorsys.hsv_to_rgb(140 / 360, s, v)
                px[x, y] = (int(nr * 255), int(ng * 255), int(nb * 255), a)
    return img


if __name__ == "__main__":
    os.makedirs(DST_DIR, exist_ok=True)

    print("Loading video-editor icon…")
    original = Image.open(ICNS_SRC)
    print(f"  {original.size[0]}x{original.size[1]}")

    print("Recoloring…")
    master = recolor(original.copy())

    # Save preview
    preview = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon_preview.png")
    master.save(preview, "PNG")
    print(f"  Preview: {preview}")

    # Save all PNG sizes
    sizes = {
        "icon.png": 512, "32x32.png": 32, "64x64.png": 64,
        "128x128.png": 128, "128x128@2x.png": 256,
        "Square30x30Logo.png": 30, "Square44x44Logo.png": 44,
        "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
        "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
        "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
        "Square310x310Logo.png": 310, "StoreLogo.png": 50,
    }
    for name, sz in sizes.items():
        master.resize((sz, sz), Image.Resampling.LANCZOS).save(
            os.path.join(DST_DIR, name), "PNG")
        print(f"  ✓ {name}")

    # .ico
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_imgs = [master.resize((s, s), Image.Resampling.LANCZOS) for s in ico_sizes]
    ico_imgs[0].save(os.path.join(DST_DIR, "icon.ico"), format="ICO",
                     sizes=[(s, s) for s in ico_sizes], append_images=ico_imgs[1:])
    print("  ✓ icon.ico")

    # .icns
    iconset = os.path.join(DST_DIR, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    for name, sz in {"icon_16x16.png": 16, "icon_16x16@2x.png": 32,
                      "icon_32x32.png": 32, "icon_32x32@2x.png": 64,
                      "icon_128x128.png": 128, "icon_128x128@2x.png": 256,
                      "icon_256x256.png": 256, "icon_256x256@2x.png": 512,
                      "icon_512x512.png": 512, "icon_512x512@2x.png": 1024}.items():
        master.resize((sz, sz), Image.Resampling.LANCZOS).save(
            os.path.join(iconset, name), "PNG")
    try:
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o",
                         os.path.join(DST_DIR, "icon.icns")], check=True)
        print("  ✓ icon.icns")
    except Exception as e:
        print(f"  ⚠ .icns: {e}")
    shutil.rmtree(iconset, ignore_errors=True)

    print("✅ Done!")
