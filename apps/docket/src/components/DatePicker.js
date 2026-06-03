'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// Dark, keyboard-friendly date+time picker — an inline panel (the parent positions
// it, e.g. inside a popover). Replaces the native datetime-local control, which
// renders light and ignores clicks on the dark theme.
//
// Props:
//   value     — ISO string | null (the current deadline)
//   onChange  — (iso: string) => void; fires when a day is picked or the time changes
//   autoFocus — focus the selected/today cell on mount (for keyboard flow)
//
// Keyboard: ←/→ ±1 day, ↑/↓ ±1 week, PageUp/PageDown ±1 month, Enter/Space select,
// then Tab moves into the time selects. Clicking a day locks it immediately.

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function DatePicker({ value, onChange, autoFocus = false }) {
  const initial = useMemo(() => {
    const d = value ? new Date(value) : null;
    return d && !isNaN(d) ? d : null;
  }, [value]);

  const today = useMemo(() => new Date(), []);
  // The day currently selected (drives the highlight + composed output).
  const [sel, setSel] = useState(initial);
  // The day the keyboard cursor is on (roving focus); defaults to selection or today.
  const [cursor, setCursor] = useState(initial || today);
  // The month being displayed.
  const [view, setView] = useState({ y: (initial || today).getFullYear(), m: (initial || today).getMonth() });
  // Time of day — defaults to 18:00 when no deadline yet.
  const [hour, setHour] = useState(initial ? initial.getHours() : 18);
  const [minute, setMinute] = useState(initial ? Math.floor(initial.getMinutes() / 5) * 5 : 0);

  const gridRef = useRef(null);
  const focusedDayRef = useRef(null);

  useEffect(() => { if (autoFocus && focusedDayRef.current) focusedDayRef.current.focus(); }, [autoFocus]);

  function emit(day, h, mi) {
    if (!day) return;
    const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi, 0, 0);
    onChange?.(d.toISOString());
  }

  function pick(day) {
    setSel(day);
    setCursor(day);
    setView({ y: day.getFullYear(), m: day.getMonth() });
    emit(day, hour, minute);
  }

  function setTime(h, mi) {
    setHour(h); setMinute(mi);
    emit(sel || cursor, h, mi);
  }

  function moveCursor(deltaDays) {
    const next = new Date(cursor);
    next.setDate(next.getDate() + deltaDays);
    setCursor(next);
    setView({ y: next.getFullYear(), m: next.getMonth() });
  }
  function moveMonth(delta) {
    const m = view.m + delta;
    const y = view.y + Math.floor(m / 12);
    setView({ y, m: ((m % 12) + 12) % 12 });
  }

  function onGridKeyDown(e) {
    switch (e.key) {
      case 'ArrowLeft':  e.preventDefault(); moveCursor(-1); break;
      case 'ArrowRight': e.preventDefault(); moveCursor(1); break;
      case 'ArrowUp':    e.preventDefault(); moveCursor(-7); break;
      case 'ArrowDown':  e.preventDefault(); moveCursor(7); break;
      case 'PageUp':     e.preventDefault(); moveMonth(-1); break;
      case 'PageDown':   e.preventDefault(); moveMonth(1); break;
      case 'Enter':
      case ' ':          e.preventDefault(); pick(new Date(cursor)); break;
      default: break;
    }
  }

  // Re-focus the cursor day button whenever the cursor moves via keyboard.
  useEffect(() => {
    if (focusedDayRef.current && gridRef.current && gridRef.current.contains(document.activeElement)) {
      focusedDayRef.current.focus();
    }
  }, [cursor]);

  // Build the 6-week grid for the displayed month.
  const cells = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay()); // back up to the Sunday on/before the 1st
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [view]);

  return (
    <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
      <div style={header}>
        <button type="button" style={navBtn} onClick={() => moveMonth(-1)} title="Previous month" tabIndex={-1}><ChevronLeft size={15} /></button>
        <span style={monthLabel}>{MONTHS[view.m]} {view.y}</span>
        <button type="button" style={navBtn} onClick={() => moveMonth(1)} title="Next month" tabIndex={-1}><ChevronRight size={15} /></button>
      </div>

      <div style={dow}>{WEEKDAYS.map((d, i) => <span key={i} style={dowCell}>{d}</span>)}</div>

      <div ref={gridRef} style={grid} role="grid" onKeyDown={onGridKeyDown}>
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === view.m;
          const isSel = sameDay(d, sel);
          const isCursor = sameDay(d, cursor);
          const isToday = sameDay(d, today);
          return (
            <button
              key={i}
              type="button"
              ref={isCursor ? focusedDayRef : null}
              tabIndex={isCursor ? 0 : -1}
              onClick={() => pick(new Date(d))}
              className="dk-day"
              style={{
                ...dayCell,
                color: isSel ? 'var(--accent-fg)' : (inMonth ? 'var(--text-1)' : 'var(--text-4)'),
                // Selected gets an inline accent fill; non-selected omit background so
                // the CSS .dk-day:hover rule can apply (inline styles beat :hover).
                ...(isSel ? { background: 'var(--docket-accent)' } : null),
                fontWeight: isSel || isToday ? 700 : 400,
                boxShadow: isToday && !isSel ? 'inset 0 0 0 1px var(--border-2)' : 'none',
              }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      <div style={timeRow}>
        <span style={timeLabel}>Time</span>
        <select value={hour} onChange={(e) => setTime(Number(e.target.value), minute)} style={timeSelect} aria-label="Hour">
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{pad(h)}</option>)}
        </select>
        <span style={{ color: 'var(--text-3)' }}>:</span>
        <select value={minute} onChange={(e) => setTime(hour, Number(e.target.value))} style={timeSelect} aria-label="Minute">
          {Array.from({ length: 12 }, (_, i) => i * 5).map((mi) => <option key={mi} value={mi}>{pad(mi)}</option>)}
        </select>
        <button type="button" className="dk-press" style={eodBtn} onClick={() => setTime(23, 55)} title="End of day">EOD</button>
      </div>
    </div>
  );
}

const panel = { background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-md)', padding: 10, width: 248, fontFamily: 'var(--font-mono)' };
const header = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };
const monthLabel = { fontFamily: 'var(--font-cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.03em', color: 'var(--text-1)', textTransform: 'uppercase' };
const navBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
const dow = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', marginBottom: 2 };
const dowCell = { textAlign: 'center', fontSize: 9, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '2px 0' };
const grid = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 };
const dayCell = { aspectRatio: '1 / 1', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontFamily: 'var(--font-mono)' };
const timeRow = { display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)' };
const timeLabel = { fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 'auto' };
const timeSelect = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '3px 4px', fontSize: 12, fontFamily: 'var(--font-mono)', outline: 'none', cursor: 'pointer' };
const eodBtn = { background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '3px 8px', fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-cond)', textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer' };

export default DatePicker;
