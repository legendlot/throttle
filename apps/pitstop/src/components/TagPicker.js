'use client';
/* ════════════════════════════════════════════════════════════
   TagPicker (Phase 3) — colored tag chips + add/remove popover.
   Shared catalogue (cs_tags); any cs_ticket_manage agent can create
   inline; lead/admin curate. Used on the ticket detail + inbox thread.
   value = [{id,name,color}]; onSave(tagIds[]) persists (parent calls
   setTicketTags / setThreadTags then reloads).
   ════════════════════════════════════════════════════════════ */
import { useEffect, useState } from 'react';
import { X, Plus, Check, Search } from 'lucide-react';
import { csopsGet, csopsPost } from '../lib/csopsFetch.js';

export const TAG_PALETTE = {
  slate: '#94a3b8', red: '#f87171', orange: '#fb923c', amber: '#fbbf24', green: '#4ade80',
  teal: '#2dd4bf', blue: '#60a5fa', violet: '#a78bfa', pink: '#f472b6',
};
export const TAG_COLOR_KEYS = Object.keys(TAG_PALETTE);
export const tagColor = (k) => TAG_PALETTE[k] || TAG_PALETTE.slate;

export function TagChip({ tag, onRemove, small }) {
  const c = tagColor(tag.color);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: small ? 10 : 11, fontWeight: 600,
      padding: small ? '1px 7px' : '2px 9px', borderRadius: 999, background: c + '22', color: c, border: `1px solid ${c}55`, whiteSpace: 'nowrap' }}>
      {tag.name}
      {onRemove && (
        <button onClick={(e) => { e.stopPropagation(); onRemove(tag); }} title="Remove tag"
          style={{ cursor: 'pointer', border: 'none', background: 'transparent', color: c, display: 'grid', placeItems: 'center', padding: 0 }}>
          <X size={small ? 9 : 11} />
        </button>
      )}
    </span>
  );
}

export default function TagPicker({ session, value = [], onSave, canManage = false, canCreate = false, small = false }) {
  const [open, setOpen] = useState(false);
  const [catalogue, setCatalogue] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = new Set(value.map(t => t.id));

  useEffect(() => {
    if (!open || !session) return;
    csopsGet('getTags', {}, session).then(d => setCatalogue(d?.tags || [])).catch(() => {});
  }, [open, session]);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  async function toggle(tag) {
    const ids = selected.has(tag.id)
      ? value.filter(t => t.id !== tag.id).map(t => t.id)
      : [...value.map(t => t.id), tag.id];
    await onSave(ids);
  }
  async function remove(tag) { await onSave(value.filter(t => t.id !== tag.id).map(t => t.id)); }

  async function createAndAdd() {
    const name = q.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const color = TAG_COLOR_KEYS[catalogue.length % TAG_COLOR_KEYS.length];
      const r = await csopsPost('createTag', { name, color }, session);
      const tag = r?.tag;
      if (tag) { setCatalogue(c => [...c, tag]); await onSave([...value.map(t => t.id), tag.id]); }
      setQ('');
    } catch { /* best-effort */ } finally { setBusy(false); }
  }

  const ql = q.trim().toLowerCase();
  const filtered = ql ? catalogue.filter(t => t.name.toLowerCase().includes(ql)) : catalogue;
  const exact = catalogue.some(t => t.name.toLowerCase() === ql);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
      {value.map(t => <TagChip key={t.id} tag={t} onRemove={canManage ? remove : null} small={small} />)}
      {!canManage && value.length === 0 && <span style={{ fontSize: 11, color: 'var(--t4)' }}>—</span>}
      {canManage && (
        <div style={{ position: 'relative' }}>
          <button onClick={() => setOpen(o => !o)} title="Add tag"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: small ? 10 : 11, fontWeight: 600,
              padding: small ? '1px 7px' : '2px 9px', borderRadius: 999, border: '1px dashed var(--border-1, var(--border))',
              background: 'transparent', color: 'var(--t3)' }}>
            <Plus size={small ? 10 : 11} /> Tag
          </button>
          {open && (
            <div style={{ position: 'absolute', top: '125%', left: 0, zIndex: 60, width: 240,
              background: 'var(--surface-1, var(--surface))', border: '1px solid var(--border-1, var(--border))',
              borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.28)', padding: 8 }}>
              <div style={{ position: 'relative', marginBottom: 6 }}>
                <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--t4)' }} />
                <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search or create…"
                  onKeyDown={e => { if (e.key === 'Enter' && canCreate && q.trim() && !exact) createAndAdd(); }}
                  style={{ width: '100%', fontSize: 12, padding: '5px 8px 5px 24px', borderRadius: 6,
                    border: '1px solid var(--border-1, var(--border))', background: 'var(--surface-2, transparent)', color: 'var(--t1)' }} />
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                {filtered.map(t => {
                  const on = selected.has(t.id); const c = tagColor(t.color);
                  return (
                    <button key={t.id} onClick={() => toggle(t)}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', cursor: 'pointer',
                        border: 'none', background: on ? 'var(--surface-2)' : 'transparent', borderRadius: 6, padding: '6px 8px' }}>
                      <span style={{ width: 9, height: 9, borderRadius: '50%', background: c, flexShrink: 0 }} />
                      <span style={{ flex: 1, fontSize: 12.5, color: 'var(--t1)' }}>{t.name}</span>
                      {on && <Check size={12} style={{ color: 'var(--accent)' }} />}
                    </button>
                  );
                })}
                {canCreate && q.trim() && !exact && (
                  <button onClick={createAndAdd} disabled={busy}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', cursor: 'pointer',
                      border: 'none', background: 'transparent', borderRadius: 6, padding: '6px 8px', color: 'var(--accent)', fontSize: 12.5, fontWeight: 600 }}>
                    <Plus size={12} /> Create “{q.trim()}”
                  </button>
                )}
                {!filtered.length && !(canCreate && q.trim()) && (
                  <div style={{ fontSize: 12, color: 'var(--t3)', padding: 8 }}>No tags yet.</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
