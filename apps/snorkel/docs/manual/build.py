#!/usr/bin/env python3
"""
Redline Operations Manual — build pipeline.

  python3 build.py            # build the PDF into ./Redline-Operations-Manual.pdf
  python3 build.py --html     # also keep the intermediate full HTML for inspection

What it does:
  1. Reads manual.json (ordered parts -> chapters) + assets/theme.css.
  2. Assembles one self-contained HTML document (cover + TOC + part dividers + chapters).
     Chapters with a "file" load that fragment; the rest render a styled stub from "summary".
  3. Renders to PDF with headless Chrome (full CSS, web fonts, page breaks).
  4. Measures the real page each chapter lands on (hidden sentinels), rebuilds the TOC with
     page numbers, and re-renders.
  5. Stamps a footer (title - version - page N) on every page except the cover, and adds a
     clickable PDF outline (bookmarks) for parts and chapters.

Self-bootstrapping: if pypdf / reportlab are missing it re-execs inside ./.venv.
"""
import os, sys, json, html, subprocess, tempfile, shutil, re

HERE = os.path.dirname(os.path.abspath(__file__))

# ── venv bootstrap ────────────────────────────────────────────────
def _ensure_venv():
    try:
        import pypdf, reportlab  # noqa
        return
    except ImportError:
        pass
    if os.environ.get("_RL_MANUAL_VENV") == "1":
        sys.exit("✖ venv is active but pypdf/reportlab are still missing — delete .venv and retry.")
    venv = os.path.join(HERE, ".venv")
    py = os.path.join(venv, "bin", "python")
    if not os.path.exists(py):
        print("· creating venv + installing pypdf, reportlab …")
        subprocess.check_call([sys.executable, "-m", "venv", venv])
        subprocess.check_call([py, "-m", "pip", "install", "-q", "--upgrade", "pip"])
        subprocess.check_call([py, "-m", "pip", "install", "-q", "pypdf", "reportlab"])
    os.environ["_RL_MANUAL_VENV"] = "1"
    os.execv(py, [py, os.path.abspath(__file__)] + sys.argv[1:])

_ensure_venv()

from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

# ── Chrome discovery ──────────────────────────────────────────────
def find_chrome():
    cands = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        shutil.which("google-chrome"), shutil.which("chromium"),
        shutil.which("chromium-browser"), shutil.which("chrome"),
    ]
    for c in cands:
        if c and os.path.exists(c):
            return c
    sys.exit("✖ Could not find Chrome/Chromium for PDF rendering.")

CHROME = find_chrome()
ESC = lambda s: html.escape(str(s), quote=True)
def tok(cid): return "PGMK" + re.sub(r"[^A-Za-z0-9]", "", str(cid)) + "END"

# ── HTML assembly ─────────────────────────────────────────────────
def role_badges(cfg, ids):
    out = []
    for r in ids:
        meta = cfg["roles"].get(r)
        if meta:
            out.append(f'<span class="role {r}">{ESC(meta["label"])}</span>')
    return "".join(out)

def chapter_html(cfg, part, ch):
    crumb = f'{ESC(part["part"])}<span class="sep">/</span>{ESC(ch["title"])}'
    route = f'<span class="ch-route">{ESC(ch["route"])}</span>' if ch.get("route") else ""
    badges = role_badges(cfg, ch.get("roles", []))
    head = (
        f'<div class="chapter"><span class="pgmark">{tok(ch["id"])}</span>'
        f'<div class="ch-head"><div class="ch-crumb">{crumb}</div>'
        f'<h1>{ESC(ch["title"])}</h1>'
        f'<div class="ch-meta">{route}{badges}</div></div>'
    )
    if ch.get("file"):
        with open(os.path.join(HERE, "content", ch["file"]), encoding="utf-8") as f:
            body = f.read()
    else:
        body = (
            f'<p class="lead">{ESC(ch.get("summary",""))}</p>'
            f'<div class="stub"><span class="stub-tag">Documentation in progress</span>'
            f'<p>This chapter is part of the manual&rsquo;s outline and will be written out in '
            f'full in an upcoming revision, following the same depth as the QC and Dispatch '
            f'Pipeline chapters.</p>'
            f'<p style="margin-top:3mm"><strong>Who uses it:</strong> {badges or "&mdash;"}</p></div>'
        )
    return head + body + "</div>"

def toc_html(cfg, page_of):
    rows = ['<div class="toc"><h2>Contents</h2><div class="toc-rule"></div>']
    for part in cfg["parts"]:
        rows.append(f'<div class="toc-part">{ESC(part["part"])}</div>')
        for ch in part["chapters"]:
            pg = page_of.get(ch["id"], "")
            route = f'<span class="t-route">{ESC(ch["route"])}</span>' if ch.get("route") else ""
            rows.append(
                f'<a href="#{ESC(ch["id"])}"><span class="t-title">{ESC(ch["title"])}{route}</span>'
                f'<span class="t-dots"></span><span class="t-page">{pg}</span></a>'
            )
    rows.append("</div>")
    return "".join(rows)

def part_divider(cfg, idx, part):
    return (
        f'<div class="part-divider"><span class="pgmark">{tok("part-"+str(idx))}</span>'
        f'<div class="pd-num">PART {idx}</div><h2>{ESC(part["part"])}</h2>'
        f'<div class="pd-sub">{ESC(part.get("subtitle",""))}</div></div>'
    )

def cover_html(cfg):
    badges = role_badges(cfg, list(cfg["roles"].keys()))
    return (
        '<div class="cover">'
        f'<div class="kicker">{ESC(cfg["owner"])} &middot; Internal</div>'
        f'<h1>{ESC(cfg["title"])}<br><span class="red">{ESC(cfg["title_accent"])}</span></h1>'
        f'<div class="sub">{ESC(cfg["subtitle"])}</div>'
        f'<div class="badge-strip">{badges}</div>'
        '<div class="meta">'
        f'<div>Version<b>{ESC(cfg["version"])}</b></div>'
        f'<div>Updated<b>{ESC(cfg["date"])}</b></div>'
        f'<div>Application<b>{ESC(cfg["app_url"])}</b></div>'
        '</div></div>'
    )

def assemble(cfg, css, page_of):
    parts_html = []
    for i, part in enumerate(cfg["parts"], start=1):
        parts_html.append(part_divider(cfg, i, part))
        for ch in part["chapters"]:
            parts_html.append(chapter_html(cfg, part, ch))
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        f'<title>{ESC(cfg["title"])} {ESC(cfg["title_accent"])}</title>'
        f'<style>{css}</style></head><body>'
        + cover_html(cfg) + toc_html(cfg, page_of) + "".join(parts_html)
        + '</body></html>'
    )

# ── Chrome render ─────────────────────────────────────────────────
def render(html_str, out_pdf):
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "manual.html")
        with open(src, "w", encoding="utf-8") as f:
            f.write(html_str)
        subprocess.check_call([
            CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
            "--no-sandbox", "--run-all-compositor-stages-before-draw",
            "--virtual-time-budget=8000",
            f"--print-to-pdf={out_pdf}", "file://" + src,
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

# ── measure which page each sentinel lands on ─────────────────────
def measure(pdf_path, cfg):
    reader = PdfReader(pdf_path)
    page_of_ch, page_of_part = {}, {}
    targets_ch = {ch["id"]: tok(ch["id"]) for p in cfg["parts"] for ch in p["chapters"]}
    targets_part = {i: tok("part-" + str(i)) for i, _ in enumerate(cfg["parts"], start=1)}
    for i, page in enumerate(reader.pages, start=1):
        flat = (page.extract_text() or "").replace(" ", "").replace("\n", "")
        for cid, t in targets_ch.items():
            if cid not in page_of_ch and t in flat:
                page_of_ch[cid] = i
        for pi, t in targets_part.items():
            if pi not in page_of_part and t in flat:
                page_of_part[pi] = i
    return page_of_ch, page_of_part, len(reader.pages)

# ── footer overlay + bookmarks ────────────────────────────────────
def finalize(rendered_pdf, out_pdf, cfg, page_of_ch, page_of_part):
    reader = PdfReader(rendered_pdf)
    n = len(reader.pages)
    foot = f'{cfg["title"]} {cfg["title_accent"]}'
    ver = f'v{cfg["version"]}'

    overlay_path = rendered_pdf + ".overlay.pdf"
    box = reader.pages[0].mediabox
    W, H = float(box.width), float(box.height)
    c = canvas.Canvas(overlay_path, pagesize=(W, H))
    grey = HexColor("#767c86"); rule = HexColor("#c9cdd5"); red = HexColor("#DE2A2A")
    m = 26 * 72 / 25.4  # 26mm side margin, matches @page in theme.css
    for i in range(n):
        if i > 0:  # skip cover
            y = 36
            c.setStrokeColor(rule); c.setLineWidth(0.5); c.line(m, y + 12, W - m, y + 12)
            c.setFillColor(red); c.rect(m, y + 11, 22, 2.2, fill=1, stroke=0)
            c.setFont("Courier", 7.5); c.setFillColor(grey)
            c.drawString(m, y, foot.upper())
            c.drawCentredString(W / 2, y, ver)
            c.drawRightString(W - m, y, f"PAGE {i + 1}")
        c.showPage()
    c.save()

    overlay = PdfReader(overlay_path)
    writer = PdfWriter()
    for i, page in enumerate(reader.pages):
        page.merge_page(overlay.pages[i])
        writer.add_page(page)

    # bookmarks: parts (top level) -> chapters (nested)
    for pi, part in enumerate(cfg["parts"], start=1):
        ppg = page_of_part.get(pi, 1)
        parent = writer.add_outline_item(part["part"], ppg - 1)
        for ch in part["chapters"]:
            writer.add_outline_item(ch["title"], page_of_ch.get(ch["id"], ppg) - 1, parent=parent)

    writer.add_metadata({
        "/Title": f'{cfg["title"]} {cfg["title_accent"]}',
        "/Author": cfg["owner"],
        "/Subject": f'Redline self-serve manual v{cfg["version"]}',
    })
    with open(out_pdf, "wb") as f:
        writer.write(f)
    os.remove(overlay_path)
    return n

# ── main ──────────────────────────────────────────────────────────
def main():
    keep_html = "--html" in sys.argv
    with open(os.path.join(HERE, "manual.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    with open(os.path.join(HERE, "assets", "theme.css"), encoding="utf-8") as f:
        css = f.read()

    out_pdf = os.path.join(HERE, f"{cfg['title']}-Operations-Manual.pdf")
    with tempfile.TemporaryDirectory() as td:
        # Pass A — render with empty TOC numbers, measure pages
        passA = os.path.join(td, "passA.pdf")
        render(assemble(cfg, css, {}), passA)
        page_of_ch, page_of_part, _ = measure(passA, cfg)
        # Pass B — render with real TOC page numbers (TOC height is unchanged, so the
        # measured pages still hold)
        full_html = assemble(cfg, css, page_of_ch)
        if keep_html:
            with open(os.path.join(HERE, "manual.debug.html"), "w", encoding="utf-8") as f:
                f.write(full_html)
        passB = os.path.join(td, "passB.pdf")
        render(full_html, passB)
        n = finalize(passB, out_pdf, cfg, page_of_ch, page_of_part)

    chapters = sum(len(p["chapters"]) for p in cfg["parts"])
    print(f"✓ {os.path.relpath(out_pdf, HERE)}  —  {n} pages, "
          f"{len(cfg['parts'])} parts, {chapters} chapters  (v{cfg['version']})")

if __name__ == "__main__":
    main()
