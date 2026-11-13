'use client';
// F8 P2 — the Records tab of /checklist (spec 2026-11-11-docket-checklists-v2.md §3.3): every record the caller
// can see (the worker scopes by space), with progress bars, filtered by template / product / status / owner,
// and + New record (a record template, a title, an optional product and the space it lives in). A row opens
// the Record page (/checklist/record?id=).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { Plus, Check, ClipboardCheck } from 'lucide-react';
import { docketopsGet, docketopsPost } from '../lib/docketopsFetch.js';
import { progressPct, RECORD_STATUS, recordErrorText } from '../lib/records.js';
import { Button, EmptyState } from './ui/index.js';

const STATUS_OPTS = [{ value: '', label: 'Open + complete' }, { value: 'open', label: 'Open' }, { value: 'complete', label: 'Complete' },
  { value: 'archived', label: 'Archived' }, { value: 'all', label: 'All' }];

export function ProgressBar({ progress }) {
  const pct = progressPct(progress);
  return (
    <span className="rc-bar" title={progress?.label}>
      <span className="rc-bar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

export function ChecklistRecords({ session, employees = [], me }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [rows, setRows] = useState(null);
  const [filters, setFilters] = useState({ template_id: '', product: '', status: '', owner_employee_id: '' });
  const [templates, setTemplates] = useState([]);
  const [products, setProducts] = useState([]);
  const [spaces, setSpaces] = useState([]);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    Promise.all([
      docketopsGet('getChecklistTemplates', {}, session).catch(() => []),
      docketopsGet('getChecklistProducts', {}, session).catch(() => []),
      docketopsGet('getSpaces', {}, session).catch(() => []),
    ]).then(([t, p, s]) => { setTemplates((t || []).filter(x => x.kind === 'record' && x.is_active !== false)); setProducts(p || []); setSpaces(s || []); });
  }, [session]);

  const load = useCallback(async () => {
    if (!session) return;
    try { setRows(await docketopsGet('getChecklistRecords', filters, session) || []); }
    catch (e) { showToast(e.message || 'Failed to load records', 'error'); setRows([]); }
  }, [session, filters, showToast]);
  useEffect(() => { load(); }, [load]);

  const general = spaces.find(s => !s.is_private);
  function openNew() { setDraft({ template_id: templates[0]?.id || '', title: '', product: '', space_id: general?.id || '', owner_employee_id: me?.employee_id || '' }); }
  async function create() {
    if (!draft.template_id || !draft.title.trim()) return;
    setBusy(true);
    try {
      const res = await docketopsPost('createChecklistRecord', { template_id: draft.template_id, title: draft.title.trim(), product: draft.product || null,
        space_id: draft.space_id || null, owner_employee_id: draft.owner_employee_id || null }, session);
      setDraft(null); showToast('Record created', 'success');
      if (res?.id) router.push(`/checklist/record/?id=${res.id}`); else load();
    } catch (e) { showToast(recordErrorText(e), 'error'); } finally { setBusy(false); }
  }

  const set = (k) => (v) => setFilters(f => ({ ...f, [k]: v || '' }));
  const tmplOpts = useMemo(() => [{ value: '', label: 'Any template' }, ...templates.map(t => ({ value: t.id, label: t.name }))], [templates]);
  const prodOpts = useMemo(() => products.map(p => ({ value: p, label: p })), [products]);
  const empOpts = useMemo(() => employees.map(e => ({ value: e.id, label: e.full_name })), [employees]);

  return (
    <div className="rc-wrap">
      <div className="cl-head">
        <p className="cl-lede">A record is a copy of a checklist for one product or launch. Tick each item once; the record finishes itself when every item is done or N/A.</p>
        {!draft && <Button variant="primary" size="sm" icon={Plus} disabled={!templates.length} title={templates.length ? '' : 'Create a record template under Manage first'} onClick={openNew}>New record</Button>}
      </div>

      {draft && (
        <div className="cl-create">
          <input className="cl-input" autoFocus placeholder="Title, e.g. Launch: Badger" value={draft.title} maxLength={200}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') create(); }} />
          <div className="cl-create-grid">
            <label className="cl-field"><span>Template</span><Combobox value={draft.template_id} allowClear={false} style={{ width: '100%' }}
              options={templates.map(t => ({ value: t.id, label: t.name }))} onChange={v => setDraft(d => ({ ...d, template_id: v || '' }))} /></label>
            <label className="cl-field"><span>Product (optional)</span><Combobox value={draft.product} allowClear placeholder="Not in the catalog yet" style={{ width: '100%' }}
              options={prodOpts} onChange={v => setDraft(d => ({ ...d, product: v || '' }))} /></label>
            <label className="cl-field"><span>Space</span><Combobox value={draft.space_id} allowClear={false} style={{ width: '100%' }}
              options={spaces.map(s => ({ value: s.id, label: s.name }))} onChange={v => setDraft(d => ({ ...d, space_id: v || '' }))} /></label>
            <label className="cl-field"><span>Owner</span><Combobox value={draft.owner_employee_id} allowClear style={{ width: '100%' }}
              options={empOpts} onChange={v => setDraft(d => ({ ...d, owner_employee_id: v || '' }))} /></label>
          </div>
          <small className="cl-hint">Who can see it follows the space, exactly like a task. Anyone who can see it can tick it.</small>
          <div className="cl-create-actions"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" icon={Check} loading={busy} disabled={busy || !draft.template_id || !draft.title.trim()} onClick={create}>Create</Button></div>
        </div>
      )}

      <div className="rc-filters">
        <Combobox value={filters.template_id} allowClear style={{ width: 190 }} options={tmplOpts} onChange={set('template_id')} />
        <Combobox value={filters.product} allowClear placeholder="Any product" style={{ width: 170 }} options={prodOpts} onChange={set('product')} />
        <Combobox value={filters.status} allowClear={false} style={{ width: 160 }} options={STATUS_OPTS} onChange={set('status')} />
        <Combobox value={filters.owner_employee_id} allowClear placeholder="Any owner" style={{ width: 170 }} options={empOpts} onChange={set('owner_employee_id')} />
      </div>

      {rows === null ? <Spinner /> : rows.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="No records" body={templates.length ? 'Start one with + New record.' : 'Create a record template under Manage (kind: Record), then start a record from it.'} />
      ) : (
        <ul className="cl-rows">
          {rows.map(r => (
            <li key={r.id} className={'cl-item rc-row' + (r.status === 'complete' ? ' done' : '')}>
              <ClipboardCheck className="cl-row-ic" size={14} aria-hidden />
              <button className="cl-item-title" onClick={() => router.push(`/checklist/record/?id=${r.id}`)}>{r.title}</button>
              <span className="cl-item-meta">
                {r.product && <span className="cl-team">{r.product}</span>}
                {r.template_name && <span className="cl-sub">{r.template_name}</span>}
                {r.owner_name && <span className="cl-sub">{r.owner_name}</span>}
                {r.space_name && <span className="cl-sub">{r.space_name}</span>}
                <span className="rc-status" style={{ color: RECORD_STATUS[r.status]?.color }}>{RECORD_STATUS[r.status]?.label || r.status}</span>
                <ProgressBar progress={r.progress} />
                <span className="rc-prog">{r.progress?.label}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
export default ChecklistRecords;
