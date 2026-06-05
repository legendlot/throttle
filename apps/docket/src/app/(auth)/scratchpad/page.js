'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Trash2, NotebookPen } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { Calculator } from '../../../components/Calculator.js';

// Private per-person scratchpad: notes list (left) + click-to-edit editor (right).
// Free text + inline [ ] checkboxes + live arithmetic. RULE-DOCKET-005.
export default function ScratchpadPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [notes, setNotes] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const saveTimer = useRef(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await docketopsGet('getScratchNotes', {}, session);
      const list = Array.isArray(r) ? r : [];
      setNotes(list);
      setActiveId(a => (a && list.some(n => n.id === a)) ? a : (list[0]?.id || null));
    } catch (e) { showToast(e.message || 'Failed to load notes', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  const active = notes.find(n => n.id === activeId) || null;

  function patchLocal(id, patch) { setNotes(ns => ns.map(n => n.id === id ? { ...n, ...patch } : n)); }
  async function persist(id, patch) {
    try { await docketopsPost('updateScratchNote', { id, ...patch }, session); }
    catch (e) { showToast(e.message || 'Save failed', 'error'); }
  }
  function onField(id, patch) {
    patchLocal(id, patch);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(id, patch), 600);
  }
  async function newNote() {
    try {
      const r = await docketopsPost('createScratchNote', { title: '', body: '' }, session);
      setNotes(ns => [{ ...r }, ...ns]); setActiveId(r.id);
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function del(id) {
    if (!window.confirm('Delete this note? This cannot be undone.')) return;
    try { await docketopsPost('deleteScratchNote', { id }, session); setNotes(ns => ns.filter(n => n.id !== id)); if (activeId === id) setActiveId(null); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  if (loading) return <Spinner />;
  return (
    <div>
      <h1 style={h1}>Scratchpad</h1>
      <p style={sub}>Your private notes — free text on the left, a calculator on the right (<strong>Tab</strong> to jump into it, <strong>Shift+Tab</strong> back). Only you can see these.</p>
      <div style={wrap}>
        <aside style={listPane}>
          <button className="dk-press" style={newBtn} onClick={newNote}><Plus size={14} /> New note</button>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {notes.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12, padding: 10 }}>No notes yet.</div>}
            {notes.map(n => (
              <div key={n.id} onClick={() => setActiveId(n.id)} style={noteRow(n.id === activeId)}>
                <NotebookPen size={13} style={{ color: n.id === activeId ? 'var(--docket-accent)' : 'var(--text-4)', flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.title?.trim() || firstLine(n.body) || 'Untitled'}</span>
              </div>
            ))}
          </div>
        </aside>
        <section style={editorPane}>
          {!active ? <div style={{ color: 'var(--text-3)', padding: 20 }}>Select or create a note.</div> : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input value={active.title || ''} onChange={e => onField(active.id, { title: e.target.value })} placeholder="Title…" style={titleInput} />
                <button className="dk-press" style={delBtn} title="Delete note" onClick={() => del(active.id)}><Trash2 size={15} /></button>
              </div>
              <div style={editorSplit}>
                <textarea key={active.id} defaultValue={active.body || ''}
                  onChange={(e) => onField(active.id, { body: e.target.value })}
                  placeholder="Write anything. Press Tab to jump to the calculator, Shift+Tab to come back."
                  spellCheck={false} style={noteTa} />
                <Calculator />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function firstLine(b) { return (b || '').split('\n').map(s => s.trim()).find(Boolean) || ''; }

const h1 = { fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' };
const sub = { fontSize: 13, color: 'var(--text-3)', marginTop: 4, marginBottom: 16, maxWidth: 680, lineHeight: 1.5 };
const kbd = { fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)', background: 'var(--surface-2)', borderRadius: 3, padding: '1px 5px' };
const wrap = { display: 'grid', gridTemplateColumns: '240px 1fr', gap: 14, alignItems: 'start' };
const listPane = { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '70vh', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 8 };
const editorPane = { minWidth: 0 };
const editorSplit = { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 300px', gap: 14, alignItems: 'start' };
const noteTa = { width: '100%', minHeight: 460, background: 'var(--surface)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14, fontSize: 14, lineHeight: 1.6, outline: 'none', fontFamily: 'var(--font-mono)', resize: 'vertical' };
const newBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'var(--accent-bg)', color: 'var(--docket-accent)', border: '1px solid var(--docket-accent)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontFamily: 'var(--font-cond)', fontSize: 12, fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' };
function noteRow(active) { return { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13, color: active ? 'var(--text-1)' : 'var(--text-2)', background: active ? 'var(--surface-2)' : 'transparent' }; }
const titleInput = { flex: 1, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 11px', fontFamily: 'var(--font-cond)', fontSize: 16, fontWeight: 700, outline: 'none' };
const delBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, background: 'var(--surface-2)', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' };
