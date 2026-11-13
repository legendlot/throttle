'use client';
// F8 P2 — TaskView's Checklists strip, under Dependencies (spec 2026-11-11-docket-checklists-v2.md §3.3):
// each linked record reads "Launch: Badger · 6/11 (1 N/A) →" and opens the Record page; a record in a space
// the viewer can't open is only a count (getTask.checklists_hidden — the F7 wording). + Link checklist searches
// records (getChecklistRecords q=, the same scope as the Records tab) → linkTaskChecklist; ✕ unlinks. Both need
// edit rights on the task (as dependencies); unlinking also works on an abandoned task, linking doesn't. The
// worker refuses a record outside the task's space unless it is in General (link_cross_space).
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@throttle/ui';
import { Plus, X, EyeOff, ClipboardCheck, Loader2 } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../../lib/docketopsFetch.js';
import { hiddenChecklistsText, progressLabel, recordErrorText } from '../../lib/records.js';
import { Popover } from '../ui/index.js';

export function ChecklistSearch({ exclude = [], session, onPick }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState({ rows: [], status: 'idle' });
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  const reqRef = useRef(0);
  useEffect(() => { const t = setTimeout(() => inputRef.current?.focus(), 0); return () => clearTimeout(t); }, []);
  useEffect(() => {
    const id = ++reqRef.current;
    setRes(r => ({ ...r, status: 'loading' }));
    const t = setTimeout(() => {
      docketopsGet('getChecklistRecords', { q: q.trim(), limit: 20 }, session)
        .then(rows => { if (reqRef.current === id) setRes({ rows: Array.isArray(rows) ? rows : [], status: 'done' }); })
        .catch(() => { if (reqRef.current === id) setRes({ rows: [], status: 'error' }); });
    }, 180);
    return () => clearTimeout(t);
  }, [q, session]);
  const skip = new Set(exclude);
  const rows = res.rows.filter(r => !skip.has(r.id));
  useEffect(() => { setActive(0); }, [res.rows]);
  const cur = Math.min(active, Math.max(0, rows.length - 1));
  async function pick(r) { if (!r || saving) return; setSaving(true); try { await onPick(r); } finally { setSaving(false); } }
  const empty = res.status === 'loading' && !rows.length ? 'Searching…' : res.status === 'error' ? 'Search failed. Try again.' : !rows.length ? 'No matching records' : null;
  return (
    <div className="dp-search">
      <div className="ui-menu-label">Link a record checklist</div>
      <input ref={inputRef} className="menu-search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search records by title or product…"
        aria-label="Search records" disabled={saving}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, rows.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(rows[cur]); }
        }} />
      <div className="dp-results" role="listbox" aria-label="Records">
        {rows.map((r, i) => (
          <button key={r.id} type="button" role="option" aria-selected={i === cur} className={'dp-res' + (i === cur ? ' on' : '')}
            onMouseEnter={() => setActive(i)} onClick={() => pick(r)} disabled={saving}>
            <ClipboardCheck size={13} aria-hidden />
            <span className="dp-ttl">{r.title}</span>
            <span className="dp-own">{r.progress?.label}</span>
            {r.space_name && <span className="dp-own">{r.space_name}</span>}
          </button>
        ))}
        {empty && <div className="dp-empty">{empty}</div>}
      </div>
    </div>
  );
}

export function ChecklistLinkFlow({ open, anchorRef, task, session, onClose, onLinked }) {
  const { showToast } = useToast();
  return (
    <Popover anchorRef={anchorRef} open={open} onClose={onClose} width={360} className="tv-pop dp-pick">
      {open && <ChecklistSearch session={session} exclude={(task.checklists || []).map(c => c.record_id)}
        onPick={async (r) => {
          try {
            await docketopsPost('linkTaskChecklist', { task_id: task.id, record_id: r.id }, session);
            showToast(`Linked ${r.title}`, 'success'); onClose?.(); await onLinked?.();
          } catch (e) { showToast(recordErrorText(e), 'error'); }
        }} />}
    </Popover>
  );
}

export function ChecklistsStrip({ task, canLink, canUnlink = canLink, session, onChange }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [busyId, setBusyId] = useState(null);
  const [linking, setLinking] = useState(false);
  const addRef = useRef(null);
  const list = task.checklists || [];
  const hidden = Number(task.checklists_hidden) || 0;
  async function unlink(c) {
    setBusyId(c.record_id);
    try { await docketopsPost('unlinkTaskChecklist', { task_id: task.id, record_id: c.record_id }, session); await onChange?.(); }
    catch (e) { showToast(recordErrorText(e), 'error'); }
    finally { setBusyId(null); }
  }
  return (
    <section className="dp-strip" aria-label="Checklists">
      <div className="dp-head">
        <span className="tv-sh dp-sh">Checklists</span>
        {canLink && <button ref={addRef} type="button" className="tv-add dp-add" onClick={() => setLinking(true)}><Plus size={12} /> Link checklist</button>}
      </div>
      <div className="dp-groups">
        {list.map(c => (
          <div key={c.record_id} className={'dp-row' + (c.status === 'complete' ? ' cleared' : '')}>
            <button type="button" className="dp-open" onClick={() => router.push(`/checklist/record/?id=${c.record_id}`)} title="Open the record">
              <ClipboardCheck size={13} aria-hidden />
              <span className="dp-ttl">{c.title} · {c.label || progressLabel({ done: c.done, na: c.na, total: c.total })} →</span>
            </button>
            {canUnlink && (
              <button type="button" className="dp-x" aria-label={`Unlink ${c.title}`} title="Unlink" disabled={busyId === c.record_id} onClick={() => unlink(c)}>
                {busyId === c.record_id ? <Loader2 size={12} className="ui-spin" /> : <X size={12} />}
              </button>
            )}
          </div>
        ))}
        {hidden > 0 && <div className="dp-row dp-hidden"><EyeOff size={12} aria-hidden />{hiddenChecklistsText(hidden)}</div>}
        {task.checklists_failed && <div className="dp-row dp-hidden">Couldn’t load checklists — reload to try again</div>}
      </div>
      <ChecklistLinkFlow open={linking} anchorRef={addRef} task={task} session={session} onClose={() => setLinking(false)} onLinked={onChange} />
    </section>
  );
}
