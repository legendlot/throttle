'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, Trash2, NotebookPen, ChevronLeft, Calculator as CalcIcon } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../../lib/docketopsFetch.js';
import { Calculator } from '../../../components/Calculator.js';
import { createSaveQueue } from '../../../lib/saveQueue.js';
import { Button, IconButton, EmptyState } from '../../../components/ui/index.js';

const CALC_KEY = 'docket.scratch.calc';

// Private per-person scratchpad: notes list (240px column) + full-width editor + a
// calculator docked right (collapsible, remembered per browser). RULE-DOCKET-005.
// P7 layout only — the list/create/update/delete wiring and the 600ms save are unchanged.
// ≤767px it drills down: the list, then a note with a back button.
export default function ScratchpadPage() {
  const { session } = useAuth();
  const { showToast } = useToast();
  const [notes, setNotes] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(true);
  const live = useRef({});
  // Per-note merged + debounced saves (lib/saveQueue.js): the old single shared timer dropped
  // a body edit when the title changed within 600ms, or another note's edit on a switch.
  const queue = useRef(null);
  if (!queue.current) queue.current = createSaveQueue((id, patch) => live.current.persist(id, patch), 600);
  // Flush every pending save when the tab hides, the page unloads, or this page unmounts
  // (the visibilitychange path is the reliable one; beforeunload is best-effort).
  useEffect(() => {
    const flushAll = () => queue.current.flushAll();
    const onVis = () => { if (document.visibilityState === 'hidden') flushAll(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('beforeunload', flushAll);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('beforeunload', flushAll); flushAll(); };
  }, []);
  const [drill, setDrill] = useState(false);      // phone: true = the editor, false = the list
  const [calcOpen, setCalcOpen] = useState(true);
  useEffect(() => { try { if (localStorage.getItem(CALC_KEY) === '0') setCalcOpen(false); } catch {} }, []);
  function toggleCalc() {
    setCalcOpen(o => { try { localStorage.setItem(CALC_KEY, o ? '0' : '1'); } catch {} return !o; });
  }
  function openNote(id) { if (activeId && activeId !== id) queue.current.flush(activeId); setActiveId(id); setDrill(true); }

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
  // Same call + payload shape as before: updateScratchNote { id, ...fields } (now possibly
  // title AND body together — the worker applies whichever fields are present).
  function onField(id, patch) {
    patchLocal(id, patch);
    queue.current.push(id, patch);
  }
  live.current = { persist };
  async function newNote() {
    try {
      const r = await docketopsPost('createScratchNote', { title: '', body: '' }, session);
      setNotes(ns => [{ ...r }, ...ns]); openNote(r.id);
    } catch (e) { showToast(e.message || 'Failed', 'error'); }
  }
  async function del(id) {
    if (!window.confirm('Delete this note? This cannot be undone.')) return;
    // Drop its pending save: an update landing after the delete would only error.
    queue.current.drop(id);
    try { await docketopsPost('deleteScratchNote', { id }, session); setNotes(ns => ns.filter(n => n.id !== id)); if (activeId === id) { setActiveId(null); setDrill(false); } }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
  }

  if (loading) return <Spinner />;
  return (
    <div className={'screen scratch-screen' + (drill && active ? ' drill' : '')}>
      <div className={'scratch' + (calcOpen ? ' calc-on' : '')}>
        <aside className="note-list" aria-label="Notes">
          <div className="note-list-head">
            <span className="note-list-h">Notes <span className="note-count">{notes.length}</span></span>
            <IconButton icon={Plus} size="sm" label="New note" onClick={newNote} />
          </div>
          <div className="note-items">
            {notes.length === 0 && <div className="note-none">No notes yet.</div>}
            {notes.map(n => (
              <button key={n.id} type="button" className={'note-item' + (n.id === activeId ? ' on' : '')} aria-current={n.id === activeId ? 'true' : undefined} onClick={() => openNote(n.id)}>
                <NotebookPen className="ic" size={14} aria-hidden />
                <span className="lbl">{n.title?.trim() || firstLine(n.body) || 'Untitled'}</span>
              </button>
            ))}
          </div>
          <p className="note-priv">Private — only you can see these.</p>
        </aside>
        <section className="note-editor">
          {!active ? (
            <EmptyState icon={NotebookPen} title={notes.length ? 'Select a note' : 'No notes yet'}
              body="Your private notes and a quick calculator. Only you can see these."
              action={<Button variant="primary" size="sm" icon={Plus} onClick={newNote}>New note</Button>} />
          ) : (
            <>
              <div className="note-titlebar">
                <Button className="note-back" variant="ghost" size="sm" icon={ChevronLeft} onClick={() => setDrill(false)}>Notes</Button>
                <input className="note-title" placeholder="Title…" aria-label="Note title" value={active.title || ''} onChange={e => onField(active.id, { title: e.target.value })} />
                <IconButton icon={CalcIcon} size="sm" label={calcOpen ? 'Hide calculator' : 'Show calculator'} active={calcOpen} onClick={toggleCalc} />
                <IconButton icon={Trash2} size="sm" label="Delete note" onClick={() => del(active.id)} />
              </div>
              <textarea key={active.id} className="note-body" defaultValue={active.body || ''} aria-label="Note"
                onChange={(e) => onField(active.id, { body: e.target.value })}
                placeholder={calcOpen ? 'Write anything. Press Tab to jump to the calculator, Shift+Tab to come back.' : 'Write anything.'} spellCheck={false} />
            </>
          )}
        </section>
        {calcOpen && active && <aside className="note-calc" aria-label="Calculator"><Calculator /></aside>}
      </div>
    </div>
  );
}

function firstLine(b) { return (b || '').split('\n').map(s => s.trim()).find(Boolean) || ''; }
