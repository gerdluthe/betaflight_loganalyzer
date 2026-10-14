# Screenshots je Reiter (Test): python3 shot.py <log.bbl> <breite> <tag>   -> shots/<tag>_<i>.png
# Vorher: python3 build.py   (benoetigt: pip install playwright; playwright install chromium)
import os, sys
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__))
log = sys.argv[1]; w = int(sys.argv[2]); tag = sys.argv[3]; out = os.path.join(HERE, 'shots'); os.makedirs(out, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"]); pg = b.new_page(viewport={"width": w, "height": 900})
    pg.on("console", lambda m: print("CONSOLE", m.type, m.text[:300]) if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: print("PAGEERR", str(e)[:400]))
    pg.goto("file://" + os.path.join(HERE, 'dist_index.html'))
    pg.set_input_files("#file", log)
    pg.wait_for_selector("#tabs button", timeout=180000)
    names = pg.eval_on_selector_all("#tabs button", "e=>e.map(x=>x.textContent)")
    print(names)
    for i, n in enumerate(names):
        pg.click(f"#tabs button[data-i='{i}']"); pg.wait_for_timeout(500)
        pg.screenshot(path=os.path.join(out, f"{tag}_{i}.png"), full_page=True)
    b.close()
