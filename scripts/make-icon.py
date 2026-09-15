# Regenerate the app icon (app-icon.png, 1024x1024) and the Tauri icon set.
# Requires the project .venv (pymupdf). Usage:
#   .venv\Scripts\python scripts\make-icon.py
#   npx tauri icon app-icon.png -o src-tauri/icons
import pymupdf

doc = pymupdf.open()
page = doc.new_page(width=1024, height=1024)
# deep-green rounded square, gold chat bubble with tail, paper-white "WC"
page.draw_rect(pymupdf.Rect(64, 64, 960, 960), color=None, fill=(0.09, 0.27, 0.18), radius=0.22)
page.draw_rect(pymupdf.Rect(212, 262, 812, 700), color=None, fill=(0.78, 0.54, 0.18), radius=0.32)
page.draw_polyline([(330, 668), (300, 800), (470, 690)], color=None, fill=(0.78, 0.54, 0.18), width=0)
page.insert_textbox(pymupdf.Rect(212, 290, 812, 690), "WC", fontname="hebo", fontsize=280,
                    color=(0.97, 0.95, 0.89), align=pymupdf.TEXT_ALIGN_CENTER)
pix = page.get_pixmap()
pix.save("app-icon.png")
print("saved app-icon.png", pix.width, pix.height)
