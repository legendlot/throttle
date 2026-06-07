'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Trash2, NotebookPen } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { Calculator } from '../../../components/Calculator.js';

// Private per-person scratchpad: notes list (left) + click-to-edit editor (right).
// Free text + a calculator. RULE-DOCKET-005. Visual refresh only — wiring unchanged.
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
    <div className="screen">
      <div className="screen-head"><p>Your private notes and a quick calculator. Only you can see these.</p></div>
      <div className="scratch">
        <aside className="note-list">
          <button className="btn-soft" onClick={newNote}><Plus size={15} /> New note</button>
          <div className="note-items">
            {notes.length === 0 && <div style={{ color: 'var(--text-3)', fontSize: 12, padding: 10 }}>No notes yet.</div>}
            {notes.map(n => (
              <div key={n.id} className={'note-item' + (n.id === activeId ? ' on' : '')} onClick={() => setActiveId(n.id)}>
                <NotebookPen className="ic" />
                <span className="lbl">{n.title?.trim() || firstLine(n.body) || 'Untitled'}</span>
              </div>
            ))}
          </div>
        </aside>
        <section style={{ minWidth: 0 }}>
          {!active ? <div style={{ color: 'var(--text-3)', padding: 20 }}>Select or create a note.</div> : (
            <>
              <div className="note-titlebar">
                <input className="note-title" placeholder="Title…" value={active.title || ''} onChange={e => onField(active.id, { title: e.target.value })} />
                <button className="dr-icon" title="Delete note" onClick={() => del(active.id)}><Trash2 size={15} /></button>
              </div>
              <div className="note-split">
                <textarea key={active.id} className="note-body" defaultValue={active.body || ''}
                  onChange={(e) => onField(active.id, { body: e.target.value })}
                  placeholder="Write anything. Press Tab to jump to the calculator, Shift+Tab to come back." spellCheck={false} />
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
