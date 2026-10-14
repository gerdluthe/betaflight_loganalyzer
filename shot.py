import sys, asyncio
from playwright.sync_api import sync_playwright
log = sys.argv[1]; w = int(sys.argv[2]); tag = sys.argv[3]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"]); pg = b.new_page(viewport={"width": w, "height": 900})
    pg.on("console", lambda m: print("CONSOLE", m.type, m.text[:300]) if m.type in ("error", "warning") else None)
    pg.on("pageerror", lambda e: print("PAGEERR", str(e)[:400]))
    pg.goto("file:///tmp/claude-0/web/dist_index.html")
    pg.set_input_files("#file", log)
    pg.wait_for_selector("#tabs button", timeout=120000)
    names = pg.eval_on_selector_all("#tabs button", "e=>e.map(x=>x.textContent)")
    print(names)
    for i, n in enumerate(names):
        pg.click(f"#tabs button[data-i='{i}']"); pg.wait_for_timeout(500)
        pg.screenshot(path=f"/tmp/claude-0/web/s_{tag}_{i}.png", full_page=True)
    b.close()
