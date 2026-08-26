'use client';
/* ════════════════════════════════════════════════════════════
   Canned responses admin (Pruthvi, #bugs 2026-08-26).

   The backend for this has existed since S162 — create, update, and
   is_active=false as a soft delete. What did not exist was anywhere to
   USE the update: the only surface was the composer popover, which can
   create and insert but never edit or remove. So a response with a typo
   in it, or one naming a process that changed, stayed in every agent's
   list permanently.

   Deliberately mirrors /admin/tags: same load → edit-in-place → Save
   shape, same soft-delete-with-confirm. Nothing here is a new mechanism.
   ════════════════════════════════════════════════════════════ */
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import { FileText, Plus, Save, Trash2, Undo2 } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';

const inp = {
  width: '100%', padding: '6px 8px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-2)', background: 'var(--surface-2)',
  color: 'var(--t1)', fontSize: 12, fontFamily: 'inherit',
};
const btn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px',
  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-2)',
  background: 'transparent', color: 'var(--t2)', fontSize: 12, cursor: 'pointer',
};

export default function CannedAdminPage() {
  const { perms, session } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [draft, setDraft] = useState({ title: '', body: '' });
  const [creating, setCreating] = useState(false);

  // `all: '1'` so archived rows are listed too — otherwise archiving one hides it from the
  // only screen that could bring it back.
  async function load() {
    try {
      const d = await csopsGet('getCannedResponses', { all: '1' }, session);
      setRows(Array.isArray(d) ? d : (d?.canned || []));
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (session) load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [session]);

  function patch(id, p) { setRows(prev => prev.map(r => r.id === id ? { ...r, ...p } : r)); }

  async function save(r) {
    if (!r.title?.trim() || !r.body?.trim()) { setError('Title and message are both required'); return; }
    setSavingId(r.id);
    try {
      await csopsPost('updateCannedResponse', {
        id: r.id, title: r.title.trim(), body: r.body.trim(),
        is_active: r.is_active, sort_order: Number(r.sort_order) || 0,
      }, session);
      await load();
    } catch (e) { setError(e.message); }
    finally { setSavingId(null); }
  }

  // Soft delete, matching the backend. A response may already be sitting in an agent's
  // half-typed reply, and hard-deleting rows that live in other people's screens is how you
  // get a blank insert.
  async function setActive(r, active) {
    setSavingId(r.id);
    try {
      await csopsPost('updateCannedResponse', { id: r.id, is_active: active }, session);
      setConfirmId(null);
      await load();
    } catch (e) { setError(e.message); }
    finally { setSavingId(null); }
  }

  async function create() {
    if (!draft.title.trim() || !draft.body.trim() || creating) return;
    setCreating(true);
    try {
      await csopsPost('createCannedResponse', { title: draft.title.trim(), body: draft.body.trim() }, session);
      setDraft({ title: '', body: '' });
      await load();
    } catch (e) { setError(e.message); }
    finally { setCreating(false); }
  }

  if (!perms?.cs_ticket_manage) {
    return <EmptyState icon={FileText} title="No access" body="You need conversation-management permission to edit canned responses." />;
  }
  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner /></div>;

  const live = rows.filter(r => r.is_active !== false);
  const archived = rows.filter(r => r.is_active === false);

  return (
    <div style={{ display: 'grid', gap: 'var(--gap)' }}>
      {error && (
        <div style={{ padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--bad-bg)', color: 'var(--bad-fg)', fontSize: 12 }}>
          {error}
        </div>
      )}

      <section style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--t1)' }}>New response</div>
        <div style={{ display: 'grid', gap: 8 }}>
          <input style={inp} placeholder="Short title — this is what agents search for"
                 value={draft.title} onChange={(e) => setDraft(d => ({ ...d, title: e.target.value }))} />
          <textarea style={{ ...inp, minHeight: 70, resize: 'vertical' }} placeholder="The message agents will send"
                    value={draft.body} onChange={(e) => setDraft(d => ({ ...d, body: e.target.value }))} />
          <div>
            <button style={{ ...btn, borderColor: 'var(--accent-bd)', color: 'var(--accent)' }}
                    onClick={create} disabled={creating || !draft.title.trim() || !draft.body.trim()}>
              <Plus size={13} /> {creating ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      </section>

      {!live.length && !archived.length && (
        <EmptyState icon={FileText} title="No canned responses yet" body="Add one above, or create them inline from the reply box." />
      )}

      {live.map(r => (
        <section key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12, display: 'grid', gap: 8 }}>
          <input style={inp} value={r.title || ''} onChange={(e) => patch(r.id, { title: e.target.value })} />
          <textarea style={{ ...inp, minHeight: 70, resize: 'vertical' }} value={r.body || ''}
                    onChange={(e) => patch(r.id, { body: e.target.value })} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ fontSize: 11, color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 4 }}>
              Order
              <input style={{ ...inp, width: 64 }} type="number" value={r.sort_order ?? 0}
                     onChange={(e) => patch(r.id, { sort_order: e.target.value })} />
            </label>
            <button style={btn} onClick={() => save(r)} disabled={savingId === r.id}>
              <Save size={13} /> {savingId === r.id ? 'Saving…' : 'Save'}
            </button>
            {confirmId === r.id ? (
              <>
                <span style={{ fontSize: 11, color: 'var(--t3)' }}>Remove from every agent&rsquo;s list?</span>
                <button style={{ ...btn, borderColor: 'var(--bad-fg)', color: 'var(--bad-fg)' }}
                        onClick={() => setActive(r, false)} disabled={savingId === r.id}>Yes, remove</button>
                <button style={btn} onClick={() => setConfirmId(null)}>Cancel</button>
              </>
            ) : (
              <button style={{ ...btn, marginLeft: 'auto', color: 'var(--bad-fg)', borderColor: 'var(--border-2)' }}
                      onClick={() => setConfirmId(r.id)}>
                <Trash2 size={13} /> Remove
              </button>
            )}
          </div>
        </section>
      ))}

      {archived.length > 0 && (
        <section style={{ border: '1px dashed var(--border-2)', borderRadius: 'var(--radius)', padding: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--t3)' }}>
            Removed ({archived.length}) — kept so they can be brought back
          </div>
          {archived.map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--t2)' }}>{r.title}</div>
                <div style={{ fontSize: 11, color: 'var(--t4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.body}</div>
              </div>
              <button style={btn} onClick={() => setActive(r, true)} disabled={savingId === r.id}>
                <Undo2 size={13} /> Restore
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
