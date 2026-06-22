'use client';
/* ════════════════════════════════════════════════════════════
   Tags admin (Phase 3) — curate the shared tag catalogue.
   Agents create tags inline while working; leads/admins rename,
   recolor, reorder, and archive here (updateTag = cs_ticket_admin).
   ════════════════════════════════════════════════════════════ */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import { Plus, Save, Tag as TagIcon } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';
import { TAG_PALETTE, TAG_COLOR_KEYS, TagChip } from '../../../../components/TagPicker.js';

export default function TagsAdminPage() {
  const { perms, session } = useAuth();
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [draft, setDraft] = useState({ name: '', color: 'slate' });
  const [creating, setCreating] = useState(false);

  async function load() {
    try {
      const d = await csopsGet('getTags', { all: '1' }, session);
      setTags(d?.tags || []);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (session) load(); /* eslint-disable-line */ }, [session]);

  function patch(id, p) { setTags(prev => prev.map(t => t.id === id ? { ...t, ...p } : t)); }

  async function save(t) {
    setSavingId(t.id);
    try {
      await csopsPost('updateTag', {
        id: t.id, name: t.name, color: t.color, is_active: t.is_active, sort_order: Number(t.sort_order) || 0,
      }, session);
      await load();
    } catch (e) { setError(e.message); }
    finally { setSavingId(null); }
  }

  async function create() {
    if (!draft.name.trim() || creating) return;
    setCreating(true);
    try {
      await csopsPost('createTag', { name: draft.name.trim(), color: draft.color }, session);
      setDraft({ name: '', color: 'slate' });
      await load();
    } catch (e) { setError(e.message); }
    finally { setCreating(false); }
  }

  if (!perms?.cs_ticket_admin) return <EmptyState icon="🔒" message="Admin permission required to curate tags." />;
  if (loading) return <Spinner />;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Tags</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--t3)', fontSize: 13 }}>
          One shared catalogue used on both tickets and conversations. Agents can create tags inline; archive (deactivate) instead of deleting.
        </p>
      </header>

      {error && (
        <div style={{ padding: '8px 12px', background: 'rgba(220,50,50,0.1)', border: '1px solid rgba(220,50,50,0.3)',
          borderRadius: 6, color: '#b91c1c', fontSize: 13, marginBottom: 16 }}>{error}</div>
      )}

      {/* Create */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 16,
        background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 8 }}>
        <TagIcon size={15} style={{ color: 'var(--t3)' }} />
        <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
          placeholder="New tag name…" onKeyDown={e => e.key === 'Enter' && create()}
          style={{ flex: 1, fontSize: 13, padding: '6px 9px', borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--surface-2)', color: 'var(--t1)' }} />
        <ColorPicker value={draft.color} onChange={c => setDraft(d => ({ ...d, color: c }))} />
        <button onClick={create} disabled={creating || !draft.name.trim()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: 'none',
            background: 'var(--accent)', color: '#1b1b1e', fontWeight: 600, fontSize: 12, cursor: 'pointer', opacity: (creating || !draft.name.trim()) ? 0.5 : 1 }}>
          <Plus size={13} /> Add
        </button>
      </div>

      {/* List */}
      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 8, overflow: 'hidden' }}>
        {tags.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 13 }}>No tags yet — add one above.</div>
        ) : tags.map(t => (
          <div key={t.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12,
            padding: '11px 14px', borderTop: '1px solid var(--border-1)', opacity: t.is_active ? 1 : 0.55 }}>
            <TagChip tag={t} />
            <input value={t.name} onChange={e => patch(t.id, { name: e.target.value })}
              style={{ width: 200, fontSize: 13, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--surface-2)', color: 'var(--t1)' }} />
            <ColorPicker value={t.color} onChange={c => patch(t.id, { color: c })} />
            <label style={{ fontSize: 12, color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              Order
              <input type="number" value={t.sort_order ?? 0} onChange={e => patch(t.id, { sort_order: e.target.value })}
                style={{ width: 56, fontSize: 12, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border-1)', background: 'var(--surface-2)', color: 'var(--t1)' }} />
            </label>
            <label style={{ fontSize: 12, color: 'var(--t3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <input type="checkbox" checked={!!t.is_active} onChange={e => patch(t.id, { is_active: e.target.checked })} />
              Active
            </label>
            <button onClick={() => save(t)} disabled={savingId === t.id}
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6,
                border: '1px solid var(--border-1)', background: 'var(--accent)', color: '#1b1b1e', fontWeight: 600, fontSize: 12, cursor: 'pointer', opacity: savingId === t.id ? 0.6 : 1 }}>
              <Save size={13} /> {savingId === t.id ? 'Saving…' : 'Save'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ColorPicker({ value, onChange }) {
  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      {TAG_COLOR_KEYS.map(k => (
        <button key={k} type="button" onClick={() => onChange(k)} title={k}
          style={{ width: 20, height: 20, borderRadius: '50%', background: TAG_PALETTE[k], cursor: 'pointer',
            border: value === k ? '2px solid var(--t1)' : '2px solid transparent' }} />
      ))}
    </div>
  );
}
