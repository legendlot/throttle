#!/usr/bin/env python3
"""
build-manual-web.py — wire a system manual into its app as an in-app page.

For each named app it:
  1. Reads apps/<app>/docs/manual/manual.json + content/*.html.
  2. Assembles one data file apps/<app>/src/data/manual.json with the chapter
     HTML inlined (so the in-app <Manual> viewer can import it directly).
  3. Copies the built PDF into apps/<app>/public/manual/ so the "Download PDF"
     button can serve it (static export publishes public/ at the site root).

The same manual.json spine drives BOTH the PDF (docs/manual/build.py) and this
in-app page — single source of truth.

Usage:
  python3 scripts/build-manual-web.py garage redline ignition pitstop podium snorkel docket
  python3 scripts/build-manual-web.py --all
"""
import os, sys, json, glob, shutil, html as _html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 05_Throttle/
APPS = os.path.join(ROOT, "apps")

ALL_APPS = ["garage", "redline", "ignition", "pitstop", "podium", "snorkel", "docket", "throttle", "manifest"]


def stub_html(ch, roles):
    """Mirror docs/manual build.py's styled stub for chapters with no content file."""
    badges = "".join(
        f'<span class="role">{_html.escape(roles[r]["label"])}</span>'
        for r in ch.get("roles", []) if r in roles
    )
    lead = _html.escape(ch.get("summary", "")) if ch.get("summary") else ""
    return (
        (f'<p class="lead">{lead}</p>' if lead else "")
        + '<div class="stub"><span class="stub-tag">Documentation in progress</span>'
        '<p>This chapter is part of the manual&rsquo;s outline and will be written out '
        'in full in an upcoming revision.</p>'
        + (f'<p style="margin-top:14px"><strong>Who uses it:</strong> {badges}</p>' if badges else "")
        + '</div>'
    )


def build(app):
    mdir = os.path.join(APPS, app, "docs", "manual")
    cfg_path = os.path.join(mdir, "manual.json")
    if not os.path.exists(cfg_path):
        print(f"  ✖ {app}: no docs/manual/manual.json — skipped")
        return False
    with open(cfg_path, encoding="utf-8") as f:
        cfg = json.load(f)

    roles = cfg.get("roles", {})
    parts_out = []
    n_ch = n_stub = 0
    for part in cfg.get("parts", []):
        chapters = []
        for ch in part.get("chapters", []):
            n_ch += 1
            if ch.get("file"):
                fp = os.path.join(mdir, "content", ch["file"])
                if os.path.exists(fp):
                    with open(fp, encoding="utf-8") as cf:
                        body = cf.read()
                else:
                    body = stub_html(ch, roles); n_stub += 1
            else:
                body = stub_html(ch, roles); n_stub += 1
            chapters.append({
                "id": ch["id"], "title": ch["title"],
                "route": ch.get("route", ""), "roles": ch.get("roles", []),
                "html": body,
            })
        parts_out.append({
            "part": part["part"], "subtitle": part.get("subtitle", ""),
            "chapters": chapters,
        })

    # locate the built PDF and publish it under public/manual/
    pdfs = glob.glob(os.path.join(mdir, "*.pdf"))
    pdf_web = ""
    if pdfs:
        pdf_src = pdfs[0]
        pub_dir = os.path.join(APPS, app, "public", "manual")
        os.makedirs(pub_dir, exist_ok=True)
        fname = os.path.basename(pdf_src)
        shutil.copy2(pdf_src, os.path.join(pub_dir, fname))
        pdf_web = f"/manual/{fname}"
    else:
        print(f"  ! {app}: no built PDF in docs/manual — run build.py there first")

    data = {
        "title": cfg.get("title", app.title()),
        "title_accent": cfg.get("title_accent", "Operations Manual"),
        "subtitle": cfg.get("subtitle", ""),
        "version": cfg.get("version", "1.0.0"),
        "date": cfg.get("date", ""),
        "app_url": cfg.get("app_url", ""),
        "owner": cfg.get("owner", "Legend of Toys"),
        "pdf": pdf_web,
        "roles": roles,
        "parts": parts_out,
    }
    out_dir = os.path.join(APPS, app, "src", "data")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "manual.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=0, separators=(",", ":"))
    rel = os.path.relpath(out_path, ROOT)
    print(f"  ✓ {app}: {n_ch} chapters ({n_stub} stub) → {rel}" + (f"  +PDF" if pdf_web else ""))
    return True


def main():
    args = sys.argv[1:]
    if not args or "--all" in args:
        apps = ALL_APPS
    else:
        apps = args
    print(f"build-manual-web → {', '.join(apps)}")
    for app in apps:
        build(app)


if __name__ == "__main__":
    main()
