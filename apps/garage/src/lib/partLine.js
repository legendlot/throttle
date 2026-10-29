'use client';
import { useState, useEffect, useCallback } from 'react';
import { Chip } from '@throttle/ui';

// LOT Cars · LOT Build · Common — which line a stock part belongs to (Kaushik, #bugs
// 1793020805.494419). Every part lands in exactly one of the three.
//
// Classified on the PART CODE first, not on product_master.category, for two reasons:
//  · No Garage read exposes product_master.category (getProductCatalogue, getProductMeta,
//    getProductDirectory all omit it), and this screen must not need a worker change.
//  · `LB-` is LOT Build's own part-code namespace (RULE-LOTBUILD-001), so it is the more
//    exact signal: measured 2026-10-29 it matched all 90 parts of 'L.O.T Build' products,
//    none of the Cars ones, and it also catches what the category join would misfile —
//    the Build-only raw materials minted product='Universal' (LB-WD-PINE-3, LB-AC-SHEET-01,
//    LB-UNV-PP-01 …) and DIY Drone Brushless V1, which has no product_master row.
//    Pine wood is Build-only, so it is NOT "Common" in Kaushik's sense (shared with cars).
//
// Common = cross-product parts: product='' in stock_ledger (RULE-003; material_master says
// 'Universal' for the same parts) or a UNV-/HW- code. Everything else is LOT Cars, including
// car products not yet in product_master (Claw, Drift 1, Ripper, Truck 1, High Speed 1).
// ⚠️ A future L.O.T DIY part (Bracey, none exist today) would read as LOT Cars here.

export const PART_LINES = [
  { key: 'all',    label: 'All' },
  { key: 'cars',   label: 'LOT Cars' },
  { key: 'build',  label: 'LOT Build' },
  { key: 'common', label: 'Common' },
];
const LINE_KEYS = new Set(PART_LINES.map(l => l.key));

export function partLine(row) {
  const code = String(row?.part_code || '').toUpperCase();
  if (code.startsWith('LB-')) return 'build';
  const product = String(row?.product || '').trim();
  if (!product || product === 'Universal' || /^(UNV|HW)-/.test(code)) return 'common';
  return 'cars';
}

export function inPartLine(row, line) {
  return !line || line === 'all' || partLine(row) === line;
}

export function countPartLines(rows) {
  const c = { all: 0, cars: 0, build: 0, common: 0 };
  (rows || []).forEach(r => { c.all++; c[partLine(r)]++; });
  return c;
}

// Remembered per viewer (and per screen) in localStorage. Defaults to 'all' so nothing
// changes for anyone who never touches the switch. Storage can throw (private mode,
// quota) — the switch must still work, it just stops remembering.
export function usePartLine(screen, userId) {
  const storageKey = `g-part-line:${screen}:${userId || 'anon'}`;
  const [line, setLineState] = useState('all');
  useEffect(() => {
    try {
      const v = localStorage.getItem(storageKey);
      setLineState(LINE_KEYS.has(v) ? v : 'all');
    } catch (_) { /* storage unavailable — keep the default */ }
  }, [storageKey]);
  const setLine = useCallback((v) => {
    const next = LINE_KEYS.has(v) ? v : 'all';
    setLineState(next);
    try { localStorage.setItem(storageKey, next); } catch (_) { /* not remembered */ }
  }, [storageKey]);
  return [line, setLine];
}

export function PartLineSwitch({ value, onChange, counts, pill, style }) {
  return (
    <div role="group" aria-label="Product line" style={{ display: 'flex', gap: 7, flexWrap: 'wrap', ...style }}>
      {PART_LINES.map(l => (
        <Chip key={l.key} pill={pill} active={value === l.key} onClick={() => onChange(l.key)} count={counts ? counts[l.key] : undefined}>{l.label}</Chip>
      ))}
    </div>
  );
}
