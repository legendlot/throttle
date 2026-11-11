// Hiring C3 — offer letter rendering. ONE renderer for both the in-app preview (renderOfferText → JSON)
// and the issued PDF (renderOfferPdf → bytes, pdf-lib), so what the hiring manager previews is what the
// candidate gets. Pure apart from pdf-lib: no clock, no randomness — the same inputs give the same bytes
// (the PDF's dates are the issue date), which is what lets the stored file's SHA-256 be the record.
// Plan: docs/superpowers/plans/2026-11-11-podium-hiring-c3-offers.md §3 · tests: test/offer-render.test.mjs
//
// Template body = plain text. {{field}} merges a value; {{#field}}…{{/field}} keeps its content only when
// the field is truthy. Paragraphs are split on blank lines; a single newline is a line break. No HTML.
// An unknown field or an unclosed section is a render error — the worker refuses to issue such a letter.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const OFFER_FIELDS = [
  'candidate_name', 'issue_date', 'entity_name', 'fixed_annual', 'variable_annual', 'variable_label',
  'variable_phrase', 'variable_frequency', 'has_variable', 'start_date', 'designation', 'department',
  'has_department', 'location', 'probation_months', 'has_probation', 'signatory_name', 'signatory_phone',
  'offer_ref', 'revision', 'valid_until', 'stipend_monthly', 'internship_months', 'joining_bonus',
  'has_joining_bonus', 'retention_bonus', 'has_retention_bonus',
];
const FIELD_SET = new Set(OFFER_FIELDS);

export class TemplateError extends Error {
  constructor(detail) { super(`template_error: ${detail}`); this.code = 'template_error'; this.detail = detail; }
}

// ── Formatting ───────────────────────────────────────────────────────────────
// Indian digit grouping (5,40,000), integers only. Written out rather than Intl so the output can't
// drift with a runtime's ICU data.
export function fmtINR(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '';
  const v = Math.round(Number(n));
  const neg = v < 0;
  const s = String(Math.abs(v));
  let out = s;
  if (s.length > 3) {
    const head = s.slice(0, -3);
    out = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  }
  return (neg ? '-' : '') + out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
function ordinal(d) {
  const t = d % 100;
  if (t >= 11 && t <= 13) return `${d}th`;
  return `${d}${({ 1: 'st', 2: 'nd', 3: 'rd' })[d % 10] || 'th'}`;
}
// 'YYYY-MM-DD' → "29th July 2026" (string maths — no Date, no timezone).
export function fmtLetterDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return `${ordinal(Number(m[3]))} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

// ── Merge ────────────────────────────────────────────────────────────────────
export function offerFields({ offer = {}, signatory = null, candidate = null, entityName = null }) {
  const v = Number(offer.variable_annual || 0);
  const label = String(offer.variable_label || 'variable pay').trim();
  const prob = offer.probation_months == null ? 0 : Number(offer.probation_months);
  const jb = Number(offer.joining_bonus || 0);
  const rb = Number(offer.retention_bonus || 0);
  return {
    candidate_name: candidate?.full_name || offer.candidate_name || '',
    issue_date: fmtLetterDate(offer.issue_date),
    entity_name: entityName || '',
    fixed_annual: fmtINR(offer.fixed_annual),
    variable_annual: fmtINR(v),
    variable_label: label,
    variable_phrase: `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`,
    variable_frequency: String(offer.variable_frequency || 'half-yearly'),
    has_variable: v > 0,
    start_date: fmtLetterDate(offer.start_date),
    designation: offer.designation || '',
    department: offer.department_name || '',
    has_department: !!String(offer.department_name || '').trim(),
    location: offer.location || '',
    probation_months: prob > 0 ? String(prob) : '',
    has_probation: prob > 0,
    signatory_name: signatory?.display_name || '',
    signatory_phone: signatory?.phone || '',
    offer_ref: offer.offer_ref || '',
    revision: offer.revision != null ? String(offer.revision) : '',
    valid_until: fmtLetterDate(offer.valid_until),
    stipend_monthly: fmtINR(offer.stipend_monthly),
    internship_months: offer.internship_months != null ? String(offer.internship_months) : '',
    joining_bonus: fmtINR(jb),
    has_joining_bonus: jb > 0,
    retention_bonus: fmtINR(rb),
    has_retention_bonus: rb > 0,
  };
}

// body + fields → paragraphs (each an array of lines). Throws TemplateError.
export function mergeBody(body, fields) {
  let s = String(body ?? '').replace(/\r\n?/g, '\n');
  const SECTION = /\{\{#\s*([a-z_]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/;
  for (let guard = 0; guard < 200; guard++) {
    const m = s.match(SECTION);
    if (!m) break;
    if (!FIELD_SET.has(m[1])) throw new TemplateError(`unknown_field:${m[1]}`);
    s = s.slice(0, m.index) + (fields[m[1]] ? m[2] : '') + s.slice(m.index + m[0].length);
  }
  if (/\{\{\s*[#/]/.test(s)) throw new TemplateError('unclosed_section');
  s = s.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => {
    if (!FIELD_SET.has(k)) throw new TemplateError(`unknown_field:${k}`);
    const val = fields[k];
    return val == null || typeof val === 'boolean' ? '' : String(val);
  });
  if (/\{\{|\}\}/.test(s)) throw new TemplateError('bad_tag');
  return s.split(/\n[ \t]*\n/)
    .map(p => p.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean))
    .filter(lines => lines.length);
}

// Merge-field check for the template editor: every tag known, every section closed.
export function validateTemplateBody(body) {
  try { mergeBody(body, offerFields({ offer: SAMPLE_OFFER, signatory: SAMPLE_SIGNATORY, candidate: { full_name: 'Sample Candidate' }, entityName: 'Sample Entity' })); return null; }
  catch (e) { return e.detail || 'template_error'; }
}

// Synthetic sample data for template previews (never a real person or salary).
export const SAMPLE_OFFER = {
  offer_ref: 'OFR-2026-000', revision: 1, issue_date: '2026-01-05', valid_until: '2026-01-12',
  fixed_annual: 600000, variable_annual: 60000, variable_label: 'variable pay', variable_frequency: 'half-yearly',
  start_date: '2026-02-02', designation: 'Sample Designation', department_name: 'Sample Department',
  location: 'Bangalore', probation_months: 3, stipend_monthly: 20000, internship_months: 6,
  joining_bonus: 0, retention_bonus: 0,
};
export const SAMPLE_SIGNATORY = { display_name: 'Sample Signatory', phone: '+91 00000 00000', title: null };

// ── Structured content (preview + PDF share it) ──────────────────────────────
export function renderOfferText({ template, offer, annexure, signatory, candidate = null }) {
  const fields = offerFields({ offer, signatory, candidate, entityName: template?.entity_name });
  const paragraphs = mergeBody(template?.body, fields);
  return {
    title: template?.title || 'Offer of Employment',
    letterhead: {
      entity_name: template?.entity_name || '',
      address_lines: (template?.entity_address || []).filter(Boolean),
      phone: signatory?.phone || null,
    },
    paragraphs,
    closing: { salutation: 'Regards,', name: signatory?.display_name || '', title: signatory?.title || null },
    annexure: annexure ? annexureView(annexure, template) : null,
    footer: [offer?.offer_ref, offer?.revision != null ? `r${offer.revision}` : null, fmtLetterDate(offer?.issue_date)]
      .filter(Boolean).join(' · '),
  };
}

function annexureView(a, template) {
  const notes = [];
  if (a.mode === 'stipend') {
    return {
      heading: 'Annexure I: Stipend',
      columns: ['Particulars', 'Monthly', `Total (${a.months} months)`],
      rows: a.lines.map(l => ({ kind: l.kind, cells: [l.label, fmtINR(l.monthly), fmtINR(l.annual)] })),
      notes,
      deductions: [],
      in_hand: null,
    };
  }
  if (template?.footer_note) notes.push(template.footer_note);
  for (const n of a.notes || []) notes.push(n);
  return {
    heading: 'Annexure I: CTC Break Up',
    columns: ['Particulars', 'Annual', 'Monthly'],
    rows: a.lines.map(l => ({ kind: l.kind, cells: [l.label, fmtINR(l.annual), fmtINR(l.monthly)] })),
    notes,
    deductions: (a.deductions || []).map(d => ({ label: d.label, value: fmtINR(d.monthly) })),
    in_hand: { label: 'Estimated monthly in-hand', value: fmtINR(a.in_hand_monthly), note: a.in_hand_note || null },
  };
}

// ── PDF ──────────────────────────────────────────────────────────────────────
const PAGE = [595.28, 841.89];   // A4, points
const MX = 64, TOP = 56, BOTTOM = 64;
const INK = rgb(0.1, 0.1, 0.1), GREY = rgb(0.45, 0.45, 0.45), RULE = rgb(0.75, 0.75, 0.75);

// Standard Helvetica is WinAnsi — map what the letters use and drop anything it cannot draw.
function sanitizer(font) {
  const ok = new Set(font.getCharacterSet());
  return (t) => {
    const s = String(t ?? '').replace(/₹\s?/g, 'INR ').replace(/[   ]/g, ' ')
      .replace(/[​-‍⁠﻿]/g, '').replace(/→/g, '->');
    let out = '';
    for (const ch of s) out += ok.has(ch.codePointAt(0)) ? ch : '?';
    return out;
  };
}

function wrap(text, font, size, width) {
  const words = String(text).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width || !cur) cur = next;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Issue date 'YYYY-MM-DD' → a fixed Date (midnight IST) for the PDF's creation / modification dates.
function pdfDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date(Date.UTC(2000, 0, 1));
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - 5.5 * 3600 * 1000);
}

export async function renderOfferPdf({ template, offer, annexure, signatory, candidate = null }) {
  const view = renderOfferText({ template, offer, annexure, signatory, candidate });
  const doc = await PDFDocument.create({ updateMetadata: false });
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const clean = sanitizer(reg);
  const [W, H] = PAGE;
  const textW = W - 2 * MX;
  const pages = [];

  const right = (page, t, y, f, size, color = INK) => {
    const s = clean(t);
    page.drawText(s, { x: W - MX - f.widthOfTextAtSize(s, size), y, size, font: f, color });
  };
  const left = (page, t, x, y, f, size, color = INK) => page.drawText(clean(t), { x, y, size, font: f, color });

  function newPage() {
    const page = doc.addPage(PAGE);
    pages.push(page);
    let y = H - TOP;
    const lh = view.letterhead;
    if (lh.entity_name) { right(page, lh.entity_name, y, bold, 11); y -= 14; }
    for (const l of lh.address_lines) { right(page, l, y, reg, 9.5, GREY); y -= 12; }
    if (lh.phone) { right(page, lh.phone, y, reg, 9.5, GREY); y -= 12; }
    return { page, y: y - 22 };
  }

  // Page 1+ — the letter.
  let { page, y } = newPage();
  const tsz = 15;
  const title = clean(view.title);
  page.drawText(title, { x: (W - bold.widthOfTextAtSize(title, tsz)) / 2, y, size: tsz, font: bold, color: INK });
  y -= 30;
  const size = 10.5, lead = 14.5;
  const ensure = (need) => { if (y - need < BOTTOM) ({ page, y } = newPage()); };
  for (const para of view.paragraphs) {
    for (const line of para) {
      for (const l of wrap(clean(line), reg, size, textW)) {
        ensure(lead);
        left(page, l, MX, y, reg, size);
        y -= lead;
      }
    }
    y -= 8;
  }
  ensure(lead * 3);
  y -= 6;
  left(page, view.closing.salutation, MX, y, reg, size); y -= lead;
  if (view.closing.name) { left(page, view.closing.name, MX, y, bold, size); y -= lead; }
  if (view.closing.title) { left(page, view.closing.title, MX, y, reg, 9.5, GREY); y -= lead; }

  // Annexure page.
  if (view.annexure) {
    const a = view.annexure;
    ({ page, y } = newPage());
    left(page, a.heading, MX, y, bold, 12.5); y -= 26;
    const colR = [null, MX + 340, W - MX];   // right edges of the two figure columns
    const rowH = 17, fs = 10;
    const rightAt = (pg, t, xr, yy, f, s) => { const c = clean(t); pg.drawText(c, { x: xr - f.widthOfTextAtSize(c, s), y: yy, size: s, font: f, color: INK }); };
    const hdr = (cells) => {
      left(page, cells[0], MX, y, bold, fs);
      rightAt(page, cells[1], colR[1], y, bold, fs);
      rightAt(page, cells[2], colR[2], y, bold, fs);
      y -= 6;
      page.drawLine({ start: { x: MX, y }, end: { x: W - MX, y }, thickness: 0.6, color: RULE });
      y -= rowH - 6;
    };
    hdr(a.columns);
    for (const r of a.rows) {
      ensure(rowH);
      const f = r.kind === 'subtotal' || r.kind === 'total' ? bold : reg;
      if (r.kind === 'total') {
        page.drawLine({ start: { x: MX, y: y + rowH - 5 }, end: { x: W - MX, y: y + rowH - 5 }, thickness: 0.6, color: RULE });
      }
      left(page, r.cells[0], MX, y, f, fs);
      rightAt(page, r.cells[1], colR[1], y, f, fs);
      rightAt(page, r.cells[2], colR[2], y, f, fs);
      y -= rowH;
    }
    y -= 4;
    for (const n of a.notes) {
      for (const l of wrap(clean(n), reg, 9, textW)) { ensure(12); left(page, l, MX, y, reg, 9, GREY); y -= 12; }
    }
    if (a.deductions.length || a.in_hand) {
      y -= 16; ensure(rowH * (a.deductions.length + 3));
      left(page, 'Deductions and estimated monthly in-hand', MX, y, bold, 11); y -= 20;
      for (const d of a.deductions) {
        left(page, d.label, MX, y, reg, fs);
        rightAt(page, d.value, colR[2], y, reg, fs);
        y -= rowH;
      }
      if (a.in_hand) {
        page.drawLine({ start: { x: MX, y: y + rowH - 5 }, end: { x: W - MX, y: y + rowH - 5 }, thickness: 0.6, color: RULE });
        left(page, a.in_hand.label, MX, y, bold, fs);
        rightAt(page, a.in_hand.value, colR[2], y, bold, fs);
        y -= rowH;
        if (a.in_hand.note) { left(page, a.in_hand.note, MX, y, reg, 9, GREY); y -= 12; }
      }
    }
  }

  // Footer on every page.
  const foot = clean(view.footer);
  for (const p of pages) {
    if (foot) p.drawText(foot, { x: (W - reg.widthOfTextAtSize(foot, 8)) / 2, y: 30, size: 8, font: reg, color: GREY });
  }

  // Fixed metadata — no clock, no producer string with a version, so the bytes are reproducible.
  const when = pdfDate(offer?.issue_date);
  doc.setTitle(clean(`${view.title}${view.footer ? ` - ${view.footer}` : ''}`));
  if (view.letterhead.entity_name) doc.setAuthor(clean(view.letterhead.entity_name));
  doc.setCreator('Podium');
  doc.setProducer('Podium');
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  return doc.save({ useObjectStreams: false });
}

// SHA-256 hex of the bytes (WebCrypto — present in Workers and Node ≥ 18).
export async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
