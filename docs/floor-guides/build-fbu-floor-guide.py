#!/usr/bin/env python3
"""
Regenerate the team-facing FBU / Outsourced floor guide (A4, 3 perspectives).

Style matches the prior v2 (cover + intro callout + "two kinds of run" table +
three numbered perspective blocks with coloured BEFORE/NOW/STEPS chips + a
"difference" line + footer). Content updated for the FBU run-model refinement
(S180): production DECLARES the run format at create; the store issues it 1:1 or
REJECTS the run (no flip); FBU surfaced + defaulted at run-create; outsourced
cars come back through normal Receiving by linking the run (auto-close), not a
separate button.

Run:  python3 build-fbu-floor-guide.py
Out:  FBU-Outsourced-Floor-Guide.pdf  (same directory)
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, PageBreak,
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "FBU-Outsourced-Floor-Guide.pdf")

# ── Palette (matches v2) ───────────────────────────────────────────────
NAVY     = HexColor("#26303f")   # dark header band
GOLD     = HexColor("#f4b400")   # accent rule + number badge
SLATE    = HexColor("#4b5b6b")   # YOUR ROLE / YOUR STEPS chip
RED      = HexColor("#9b3534")   # BEFORE chip
GREEN    = HexColor("#2e7d4f")   # NOW chip
CALLOUT  = HexColor("#f4f5f6")   # intro / table background
LINE     = HexColor("#e2e5e9")   # row separators
INK      = HexColor("#2b2b2b")   # body text
MUTE     = HexColor("#6b7280")   # subtitle / footer

styles = getSampleStyleSheet()
def st(name, **kw):
    base = kw.pop("parent", styles["Normal"])
    return ParagraphStyle(name, parent=base, **kw)

S_TITLE   = st("t",  fontName="Helvetica-Bold", fontSize=24, leading=28, textColor=INK)
S_SUB     = st("su", fontName="Helvetica",      fontSize=10, leading=14, textColor=MUTE)
S_BODY    = st("b",  fontName="Helvetica",      fontSize=10, leading=15, textColor=INK)
S_STEP    = st("sp", fontName="Helvetica",      fontSize=10, leading=15, textColor=INK, spaceAfter=6)
S_DIFF    = st("d",  fontName="Helvetica",      fontSize=10, leading=14, textColor=INK)
S_MINIHD  = st("mh", fontName="Helvetica-Bold", fontSize=12, leading=16, textColor=INK)
S_CHIP    = st("ch", fontName="Helvetica-Bold", fontSize=9,  leading=11, textColor=white)
S_BANDNUM = st("bn", fontName="Helvetica-Bold", fontSize=22, leading=22, textColor=GOLD)
S_BANDT   = st("bt", fontName="Helvetica-Bold", fontSize=14, leading=16, textColor=white)
S_BANDS   = st("bs", fontName="Helvetica",      fontSize=9,  leading=12, textColor=HexColor("#c7cdd6"))
S_TBLLBL  = st("tl", fontName="Helvetica-Bold", fontSize=9,  leading=12, textColor=SLATE)
S_TBLVAL  = st("tv", fontName="Helvetica",      fontSize=9.5,leading=13, textColor=INK)
S_FOOT    = st("ft", fontName="Helvetica-Oblique", fontSize=8.5, leading=12, textColor=MUTE)

CONTENT_W = A4[0] - 36 * mm   # left+right margins of 18mm


def b(t):  # bold inline
    return f"<b>{t}</b>"


def chip_rows(rows):
    """rows = [(label, color, [Paragraph|str ...]), ...] → a Table with coloured label chips."""
    data = []
    styl = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]
    for i, (label, color, body) in enumerate(rows):
        chip = Table([[Paragraph(label, S_CHIP)]], colWidths=[26 * mm])
        chip.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), color),
            ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
            ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]))
        body_flow = [Paragraph(x, S_STEP) if isinstance(x, str) else x for x in body]
        data.append([chip, body_flow])
        styl.append(("LINEBELOW", (0, i), (-1, i), 0.5, LINE))
    t = Table(data, colWidths=[30 * mm, CONTENT_W - 30 * mm])
    t.setStyle(TableStyle(styl))
    return t


def band(num, title, subtitle):
    inner = Table(
        [[Paragraph(str(num), S_BANDNUM),
          [Paragraph(title, S_BANDT), Paragraph(subtitle, S_BANDS)]]],
        colWidths=[12 * mm, CONTENT_W - 12 * mm],
    )
    inner.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (0, 0), 12), ("LEFTPADDING", (1, 0), (1, 0), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
    ]))
    return inner


def difference(text):
    return Paragraph(f'<font color="#2e7d4f">■</font> {b("The difference:")} {text}', S_DIFF)


def perspective(num, title, subtitle, role, before, now, steps, diff):
    flow = [band(num, title, subtitle), Spacer(1, 4)]
    flow.append(chip_rows([
        ("YOUR ROLE",  SLATE, [Paragraph(role, S_BODY)]),
        ("BEFORE",     RED,   [Paragraph(before, S_BODY)]),
        ("NOW",        GREEN, [Paragraph(now, S_BODY)]),
        ("YOUR STEPS", SLATE, [Paragraph(s, S_STEP) for s in steps]),
    ]))
    flow.append(Spacer(1, 6))
    flow.append(difference(diff))
    return flow


def build():
    doc = SimpleDocTemplate(
        OUT, pagesize=A4,
        leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=14 * mm,
        title="Built Cars & Outsourced Builds — Floor Guide",
    )
    story = []

    # ── Cover / intro ──────────────────────────────────────────────
    story.append(Paragraph("Built Cars &amp; Outsourced Builds", S_TITLE))
    story.append(Paragraph(
        "What's changing on the floor — a plain-language guide for the "
        f"{b('Store team')}, the in-house {b('Production team')}, and the {b('Outsourced team')}",
        S_SUB))
    story.append(Spacer(1, 4))
    story.append(HRFlowable(width="100%", thickness=2, color=GOLD, spaceBefore=2, spaceAfter=10))

    intro = [
        Paragraph(
            "Our cars are built in different ways — from loose parts (CKD), from part-built "
            "bundles (SKD), or as fully built cars (FBU), whether made in-house or returned by an "
            f"outside vendor. To keep the floor simple, {b('the Production team now says up front how a run will be built')}, "
            "and the Store simply issues exactly that.", S_BODY),
        Spacer(1, 6),
        Paragraph(
            f"A built car sits in {b('normal stock with its own name')} (e.g. “Rift — Car”), like a motor "
            "or a wheel. Who does what doesn't change — Production decides and requests; the Store "
            "inwards, stores and issues. Here's the full flow and what changes for each team.", S_BODY),
    ]
    box = Table([[intro]], colWidths=[CONTENT_W])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CALLOUT),
        ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    story.append(box)
    story.append(Spacer(1, 12))

    # ── Two kinds of run ───────────────────────────────────────────
    story.append(Paragraph("The two kinds of run — and who leads each", S_MINIHD))
    story.append(Spacer(1, 4))
    runs = Table([
        [Paragraph("IN-HOUSE RUN", S_TBLLBL),
         Paragraph(f"{b('Led by the Production team.')}<br/>"
                   "Production picks the format (CKD / SKD / FBU) and requests the run → "
                   "Store issues exactly that → Production builds → Dispatch", S_TBLVAL)],
        [Paragraph("OUTSOURCED RUN", S_TBLLBL),
         Paragraph(f"{b('Led by the Outsourced team; the in-house team finishes.')}<br/>"
                   "Outsourced requests → Store issues build materials → Outsourced sends to vendor → "
                   "built cars come back → Store receives them in Receiving &amp; links the run → "
                   "Production requests a finishing run (FBU) → Store issues → Production finishes → Dispatch",
                   S_TBLVAL)],
    ], colWidths=[34 * mm, CONTENT_W - 34 * mm])
    runs.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CALLOUT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 12), ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("LINEBELOW", (0, 0), (-1, 0), 4, white),
    ]))
    story.append(runs)
    story.append(Spacer(1, 8))
    story.append(Paragraph(
        f"{b('Remember:')} Production decides and requests the runs — including how each run is built. "
        "The Store acts on those requests: it issues exactly what the run asks for, or "
        f"{b('rejects the run')} if stock can't match — it never changes the run itself.", S_BODY))
    story.append(PageBreak())

    # ── 1 · Store Team ─────────────────────────────────────────────
    story += perspective(
        1, "Store Team",
        "You inward all material, store it, and issue exactly what each run asks for",
        role="You receive everything that comes in, keep it in stock, and issue it when a "
             f"production team asks. {b('You act on requests — you don’t decide the runs or how they’re built.')}",
        before="Built cars sat in a separate “built-units” list that didn't match stock; you also "
               f"{b('chose at issue time')} whether to give loose parts or built cars, and vendor returns were "
               "scanned one-by-one at “Ext Inwarding”.",
        now=f"Built cars are {b('normal stock with a part name')} (e.g. “Rift — Car”). The run already says "
            "how it's built, so you just issue exactly that — no choosing. Vendor returns come in through "
            "normal Receiving.",
        steps=[
            f"{b('1. Inwarding a shipment:')} open it in Receiving and pick what {b('physically arrived')} — "
            "Parts/CKD (loose parts), SKD (part-built bundles), or FBU (fully built cars). If it doesn't match "
            "what was ordered you'll see a short warning — note it, tell your supervisor, carry on (what arrived "
            "is what counts). Count and raise the GRN; built cars add into normal stock.",
            f"{b('2. Receiving vendor-built cars:')} when the Outsourced team's cars come back, create the "
            f"shipment in Receiving, declare {b('FBU')}, and {b('link the outsourced run')} from the list. Count and "
            "raise the GRN — the cars go into normal stock and the outsourced run "
            f"{b('closes itself')} when fully received. No counting pool, no Ext Inwarding, no separate button.",
            f"{b('3. Issuing a run:')} issue {b('exactly what the run asks for')} — the run's format decides the pick "
            "list (loose parts for a CKD build, the built car for an FBU / finishing run). If you can't fulfil "
            f"what the run asks for, {b('reject the run')} and ask Production to raise it again to match what's in "
            "stock. You don't switch a run between parts and built cars — that's Production's call.",
        ],
        diff="You no longer choose parts-vs-built or scan returns one-by-one. The run tells you what to "
             "issue; you issue it 1:1 or reject it. Built cars are received, stored and issued like any normal part.",
    )
    story.append(Spacer(1, 16))

    # ── 2 · Production Team ────────────────────────────────────────
    story += perspective(
        2, "Production Team (in-house)",
        "You decide and request the runs — including how they're built — then build and dispatch",
        role="You own production. You decide the run, choose how it's built, request the material from "
             "the store, build, and dispatch — for both fresh builds and finishing the cars that come back from a vendor.",
        before="Building from built cars used a special “built-unit” mode, and the "
               f"{b('store')} decided at issue time whether to give you parts or built cars.",
        now=f"When you create a run you {b('pick its format')} — CKD (loose parts), SKD (part-built bundles), or "
            f"FBU (fully built cars). The store then issues exactly that. If built cars are in stock, the screen "
            f"shows it and {b('defaults the run to FBU')} — “finish these first”.",
        steps=[
            f"{b('1. Fresh / regular run:')} create the run, {b('pick the format')} (CKD / SKD / FBU) — it's required — "
            "then build → QC → pack → dispatch. If built cars are in stock the form says so and pre-selects "
            "FBU; change it if you mean to build from loose parts.",
            f"{b('2. Finishing a vendor-built car:')} once the store has received the built cars into stock, create a "
            f"{b('Fresh run with format FBU')} → the store issues the built car plus the finishing kit (battery, "
            "packaging, etc.) → you finish and pack → dispatch. A “finishing run” is just a Fresh FBU "
            "run — no special mode.",
        ],
        diff="You set the format when you create the run, and built cars are “finish first”. There's no "
             "special built-unit mode, and the store no longer decides — it issues exactly what your run asked for.",
    )
    story.append(Spacer(1, 16))

    # ── 3 · Outsourced Team ────────────────────────────────────────
    story += perspective(
        3, "Outsourced Team",
        "You coordinate the vendor build and bring the finished cars back to the store",
        role="You lead outsourced builds: get build materials issued, send them to the vendor, monitor, and "
             f"bring the built cars back to the store. {b('You hand over to the store — the in-house team finishes the product.')}",
        before="An outsourced job was one confusing run with a two-step “build then finish”, a separate "
               "counting pool, and one-by-one scanning at Ext Inwarding. Runs got stuck and cars were miscounted.",
        now="Your part is clean and linear: request → send → monitor → bring back. The cars come back "
            f"through {b('normal Receiving')} (the store links them to your run, which then closes itself). The "
            "in-house team finishes them as a normal FBU run.",
        steps=[
            f"{b('1.')} Create the outsourced run (pick the vendor) and {b('request the build materials')} — the "
            "coloured car parts, not the finishing kit. The store issues them to you.",
            f"{b('2.')} {b('Send the materials to the vendor')} and monitor the build.",
            f"{b('3.')} When the built cars come back, take them to the store. They receive them in Receiving, "
            f"declare {b('FBU')} and {b('link your run')} — the cars go into stock and your run closes when fully "
            "received. No pool, no scanning, no separate button.",
            f"{b('4. You’re done there.')} The in-house Production team then creates a finishing run "
            "(Fresh, FBU) to turn the built cars into finished, dispatchable units.",
        ],
        diff="No two-step build/finish on your run, no counting pool, no Ext Inwarding. The cars come back "
             "through normal Receiving linked to your run, which closes itself; the in-house team finishes them.",
    )
    story.append(Spacer(1, 16))
    story.append(HRFlowable(width="100%", thickness=1, color=GOLD, spaceBefore=2, spaceAfter=8))
    story.append(Paragraph(
        f"{b('This change is live.')} Production decides and requests — including the run's format; the Store "
        "issues exactly that, or rejects the run if stock can't match; built cars are now just normal stock. "
        "Any questions — please ask your supervisor.  ·  Legend of Toys", S_FOOT))

    doc.build(story)
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    build()
