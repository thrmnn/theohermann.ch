#!/usr/bin/env python3
"""Typeset the opening of the demo's written account and capture public/how/account-{page,thumb}.jpg.

usage: make-account-page.py <demo checkout>   (reads docs/finding-confidently-wrong.md)
"""
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parent.parent
DEMO = Path(sys.argv[1])
WORK = Path("/mnt/c/wsl-scratch/tmp/claude-1000/-home-theo-Perso/85010332-80e3-48c5-9c8e-a97a312ba9a3/scratchpad/account")
PORT = 8151

md = (DEMO / "docs/finding-confidently-wrong.md").read_text()
md = md[:md.index("## What the detectors caught")]
md = re.sub(r"\[([^\]]+)\]\([^)]+\)(?<!\.png\))", r"\1", md)  # links read as text in a picture
body = markdown.markdown(md, extensions=["tables"])
(WORK / "figures").mkdir(parents=True, exist_ok=True)
shutil.copy2(DEMO / "docs/figures/stata-confidently-wrong.png", WORK / "figures")
(WORK / "fonts").mkdir(exist_ok=True)
for f in (ROOT / "public/fonts").iterdir():
    shutil.copy2(f, WORK / "fonts")
(WORK / "account.html").write_text(f"""<!doctype html><html><head><meta charset="utf-8">
<style>
@font-face {{ font-family: 'Space Grotesk'; src: url(fonts/space-grotesk-latin.woff2) format('woff2'); font-weight: 300 700; }}
@font-face {{ font-family: 'JetBrains Mono'; src: url(fonts/jetbrains-mono-latin.woff2) format('woff2'); }}
html {{ background: #fff; }}
body {{ margin: 0; width: 794px; padding: 64px 72px; box-sizing: border-box; color: #111; font: 13.5px/1.55 'Space Grotesk', sans-serif; }}
h1 {{ font-size: 25px; line-height: 1.2; letter-spacing: -0.01em; margin: 0 0 18px; }}
h2 {{ font-size: 15.5px; margin: 22px 0 8px; }}
p, ul {{ margin: 0 0 10px; }} ul {{ padding-left: 18px; }}
code {{ font: 11.5px 'JetBrains Mono', monospace; }}
table {{ border-collapse: collapse; width: 100%; font-size: 11.5px; margin: 6px 0 12px; }}
th, td {{ border-bottom: 1px solid #ccc; padding: 5px 6px; text-align: left; vertical-align: top; }}
img {{ width: 100%; display: block; margin: 8px 0; }}
</style></head><body>{body}</body></html>
""")

out = ROOT / "public/how"
out.mkdir(parents=True, exist_ok=True)
srv = subprocess.Popen(["node", "/home/theo/Perso/site-review/harness/srv.mjs", str(WORK), str(PORT)])
try:
    time.sleep(1)
    subprocess.run(["node", str(ROOT / "scripts/capture-account-page.mjs"), f"http://127.0.0.1:{PORT}", str(WORK), str(out)], check=True)
finally:
    srv.terminate()
