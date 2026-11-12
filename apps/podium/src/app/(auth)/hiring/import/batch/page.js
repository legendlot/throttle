'use client';
// C4 — one import batch: drop CVs → they upload (3 at a time) → AI reads each (3 at a time, resumable) →
// HR checks the fields and accepts / attaches / skips. Plan: docs/superpowers/plans/2026-11-12-podium-c4-cv-import.md
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { supabase } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, UploadCloud, CheckCheck, Trash2 } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../../lib/podiumopsFetch.js';
import { Card, Note, ghostBtn, primaryBtn, dangerBtn, backBtn, muted } from '../../../../../components/HiringBits.js';
import { FilterChip } from '../../../../../components/ui.js';
import { SOURCES, MAX_UPLOAD_BYTES } from '../../../../../lib/hiring.js';
import { AiSpendLine, CvItemCard, draftOf, draftPayload, errText } from '../../../../../components/CvImportBits.js';

const DOC_BUCKET = 'podium-documents';
const ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.webp';
const CONCURRENCY = 3;
const RETRY_MS = 8000;
const normEmail = (s) => String(s || '').trim().toLowerCase() || null;
const normPhone = (s) => String(s || '').replace(/\D/g, '').slice(-10) || null;

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}

export default function CvImportBatchPage() {
  return <Suspense fallback={<Spinner />}><BatchInner /></Suspense>;
}

function BatchInner() {
  const id = useSearchParams().get('id');
  const { session } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [items, setItems] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [uploading, setUploading] = useState({ total: 0, done: 0, failed: [] });
  const [busyIds, setBusyIds] = useState({});
  const [tab, setTab] = useState('review');
  const [drag, setDrag] = useState(false);
  const inflight = useRef(new Set());
  const coolUntil = useRef({});
  const [tick, setTick] = useState(0);

  const upsertItem = useCallback((it) => {
    setItems(prev => {
      const i = prev.findIndex(x => x.id === it.id);
      if (i < 0) return [...prev, it];
      const next = prev.slice(); next[i] = it; return next;
    });
    // Seed the draft the first time the fields arrive; never clobber HR's edits.
    setDrafts(prev => (prev[it.id] && prev[it.id].__seeded === it.status) || !['extracted', 'needs_manual'].includes(it.status) || prev[it.id]?.__edited
      ? prev : { ...prev, [it.id]: { ...draftOf(it), __seeded: it.status } });
  }, []);

  // Fresh duplicate answers (per item, from read / save) are merged in, so the check never goes stale.
  const mergeDupes = useCallback((dp) => {
    if (!dp) return;
    setData(d => {
      if (!d) return d;
      const byId = new Map((d.duplicates || []).map(m => [m.id, m]));
      for (const m of dp.matches || []) byId.set(m.id, m);
      return { ...d, duplicates: [...byId.values()], hidden_keys: [...new Set([...(d.hidden_keys || []), ...(dp.hidden_keys || [])])] };
    });
  }, []);

  const load = useCallback(async () => {
    if (!session || !id) return;
    try {
      const d = await podiumopsGet('getCvImport', { id }, session);
      setData(d);
      setItems([]); d.items.forEach(upsertItem);
    } catch (e) { showToast(errText(e), 'error'); setData({ error: true }); }
  }, [session, id, upsertItem, showToast]);
  useEffect(() => { load(); }, [load]);

  // ── Reading runner: any `uploaded` item, ≤3 at a time, with a cool-down after a transient failure ──
  useEffect(() => {
    if (!session) return;
    const now = Date.now();
    const stale = (it) => it.status === 'extracting' && now - Date.parse(it.updated_at || 0) > 5 * 60 * 1000;   // a tab that died mid-read
    const ready = items.filter(it => (it.status === 'uploaded' || stale(it)) && !inflight.current.has(it.id) && !(coolUntil.current[it.id] > now));
    const room = CONCURRENCY - inflight.current.size;
    for (const it of ready.slice(0, Math.max(0, room))) {
      inflight.current.add(it.id);
      upsertItem({ ...it, status: 'extracting' });
      podiumopsPost('cvImportExtract', { item_id: it.id }, session)
        .then(r => {
          if (r.retry || r.busy) coolUntil.current[it.id] = Date.now() + RETRY_MS;
          upsertItem(r.item);
          mergeDupes(r.duplicates);
        })
        .catch(e => { coolUntil.current[it.id] = Date.now() + RETRY_MS; upsertItem({ ...it, last_error: errText(e) }); })
        .finally(() => { inflight.current.delete(it.id); setTick(t => t + 1); });
    }
    // Re-check later: items cooling down, and reads another tab started (picked up once they go stale).
    const waiting = items.some(it => (it.status === 'uploaded' && coolUntil.current[it.id] > now) || (it.status === 'extracting' && !inflight.current.has(it.id)));
    if (waiting) { const t = setTimeout(() => setTick(x => x + 1), 30000); return () => clearTimeout(t); }
  }, [items, session, tick, upsertItem, mergeDupes]);

  async function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const tooBig = files.filter(f => f.size > MAX_UPLOAD_BYTES);
    const ok = files.filter(f => f.size <= MAX_UPLOAD_BYTES && f.size > 0);
    setUploading({ total: ok.length, done: 0, failed: tooBig.map(f => `${f.name} (over 15 MB)`) });
    await pool(ok, CONCURRENCY, async (file) => {
      try {
        const m = await podiumopsPost('cvImportUploadUrl', { import_id: id, file_name: file.name, file_size: file.size }, session);
        if (!m.token) throw new Error('no upload token');
        const { error } = await supabase.storage.from(DOC_BUCKET).uploadToSignedUrl(m.storage_path, m.token, file);
        if (error) throw error;
        const it = await podiumopsPost('cvImportFileDone', { import_id: id, storage_path: m.storage_path, file_name: file.name }, session);
        upsertItem(it);
        setUploading(u => ({ ...u, done: u.done + 1 }));
      } catch (e) {
        setUploading(u => ({ ...u, done: u.done + 1, failed: [...u.failed, `${file.name} (${errText(e)})`] }));
      }
    });
  }

  const dupesBy = useMemo(() => {
    const byEmail = {}, byPhone = {};
    for (const d of data?.duplicates || []) {
      if (d.email_norm) (byEmail[d.email_norm] ||= []).push(d);
      if (d.phone_norm) (byPhone[d.phone_norm] ||= []).push(d);
    }
    return { byEmail, byPhone };
  }, [data]);

  function matchesFor(draft) {
    const out = new Map();
    for (const m of dupesBy.byEmail[normEmail(draft?.email)] || []) out.set(m.id, m);
    for (const m of dupesBy.byPhone[normPhone(draft?.phone)] || []) out.set(m.id, m);
    return [...out.values()];
  }
  // Someone the caller can't see has this email / phone (they learn that, not who).
  const hiddenFor = (draft) => { const k = new Set(data?.hidden_keys || []); return k.has(normEmail(draft?.email)) || k.has(normPhone(draft?.phone)); };
  function batchDupeFor(it, draft) {
    const e = normEmail(draft?.email), p = normPhone(draft?.phone);
    const other = items.find(o => o.id !== it.id && o.status !== 'skipped' && (
      (it.sha256 && o.sha256 === it.sha256) ||
      (e && normEmail(drafts[o.id]?.email ?? o.final?.email ?? o.extracted?.fields?.email) === e) ||
      (p && p.length >= 10 && normPhone(drafts[o.id]?.phone ?? o.final?.phone ?? o.extracted?.fields?.phone) === p)));
    return other ? other.file_name : null;
  }

  async function act(it, fn) {
    setBusyIds(b => ({ ...b, [it.id]: true }));
    try { await fn(); } catch (e) { showToast(errText(e), 'error'); }
    finally { setBusyIds(b => { const n = { ...b }; delete n[it.id]; return n; }); }
  }
  const payload = (it) => { const { __seeded, __edited, ...d } = drafts[it.id] || draftOf(it); return draftPayload(d); };
  const accept = (it, candidateId, { ask = true } = {}) => act(it, async () => {
    const body = { item_id: it.id, draft: payload(it), candidate_id: candidateId || undefined };
    try {
      upsertItem(await podiumopsPost('cvImportAccept', body, session));
    } catch (e) {
      // The server's duplicate guard: confirm once, then force. Bulk accept never forces.
      if (e?.body?.error === 'duplicate' && ask && window.confirm(`${e.body.message}\n\nCreate a new candidate anyway?`)) {
        upsertItem(await podiumopsPost('cvImportAccept', { ...body, force: true }, session));
      } else { await load(); throw e; }
    }
  });
  const save = (it) => act(it, async () => {
    const r = await podiumopsPost('cvImportSaveItem', { item_id: it.id, draft: payload(it) }, session);
    upsertItem(r.item); mergeDupes(r.duplicates); showToast('Saved', 'success');
  });
  const skip = (it) => act(it, async () => upsertItem(await podiumopsPost('cvImportSkip', { item_id: it.id }, session)));
  const open = (it) => act(it, async () => {
    const d = await podiumopsGet('getCvImportFileUrl', { item_id: it.id }, session);
    window.open(d.url, '_blank', 'noopener');
  });

  const clean = items.filter(it => it.status === 'extracted' && !it.warnings?.length && !matchesFor(drafts[it.id]).length
    && !hiddenFor(drafts[it.id]) && !batchDupeFor(it, drafts[it.id]) && String(drafts[it.id]?.full_name || '').trim());
  async function acceptClean() {
    for (const it of [...clean]) await accept(it, undefined, { ask: false });
  }
  async function discard() {
    if (!window.confirm('Delete every CV in this batch that hasn\'t been accepted? Accepted candidates stay.')) return;
    try { await podiumopsPost('discardCvImport', { import_id: id }, session); router.push('/hiring/import'); }
    catch (e) { showToast(errText(e), 'error'); }
  }

  if (!data) return <Spinner />;
  if (data.error) return <div style={{ padding: 20 }}><button onClick={() => router.push('/hiring/import')} style={backBtn}><ArrowLeft size={13} /> Imports</button></div>;

  const count = (s) => items.filter(it => (Array.isArray(s) ? s : [s]).includes(it.status)).length;
  const TABS = [
    { id: 'review', label: `To review (${count(['extracted', 'needs_manual'])})`, st: ['extracted', 'needs_manual'] },
    { id: 'reading', label: `Reading (${count(['uploaded', 'extracting'])})`, st: ['uploaded', 'extracting'] },
    { id: 'accepted', label: `Accepted (${count(['accepted', 'accepting'])})`, st: ['accepted', 'accepting'] },
    { id: 'skipped', label: `Skipped (${count('skipped')})`, st: ['skipped'] },
    { id: 'all', label: `All (${items.length})`, st: null },
  ];
  const shown = items.filter(it => { const t = TABS.find(x => x.id === tab); return !t?.st || t.st.includes(it.status); });
  const openIsLive = data.opening.status === 'open';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={() => router.push('/hiring/import')} style={backBtn}><ArrowLeft size={13} /> Imports</button>
        <span style={{ fontSize: 18, fontWeight: 700 }}>{data.opening.designation}</span>
        <span style={muted}>{data.opening.opening_code} · {SOURCES.find(s => s.id === data.import.source)?.label || data.import.source}{data.import.source_detail ? ` · ${data.import.source_detail}` : ''}</span>
        <span style={{ flex: 1 }} />
        <AiSpendLine spend={data.spend} ready={data.ai_ready} />
      </div>
      {!openIsLive && <Note>This opening is no longer open — CVs can still be read, but accepting needs an open opening.</Note>}

      <Card title="Add CVs">
        <label onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '22px 12px', cursor: 'pointer',
            border: `1.5px dashed ${drag ? 'var(--podium-accent)' : 'var(--border)'}`, borderRadius: 'var(--radius-md)', background: drag ? 'var(--surface-2)' : 'transparent' }}>
          <UploadCloud size={22} />
          <span style={{ fontSize: 13 }}>Drop CVs here, or click to pick (PDF, Word, image · up to 15 MB each · 100 per batch)</span>
          <input type="file" multiple accept={ACCEPT} style={{ display: 'none' }} onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        {uploading.total > 0 && uploading.done < uploading.total && <div style={{ ...muted, marginTop: 8 }}>Uploading {uploading.done} of {uploading.total}…</div>}
        {!!uploading.failed.length && <div style={{ marginTop: 8 }}><Note>Not uploaded: {uploading.failed.join('; ')}</Note></div>}
      </Card>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {TABS.map(t => <FilterChip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</FilterChip>)}
        <span style={{ flex: 1 }} />
        {!!clean.length && openIsLive && <button onClick={acceptClean} style={primaryBtn} title="No warnings, no duplicates, name present"><CheckCheck size={13} /> Accept {clean.length} clean</button>}
        <button onClick={discard} style={dangerBtn}><Trash2 size={13} /> Discard batch</button>
      </div>

      {!shown.length ? <div style={muted}>Nothing here.</div> : shown.map(it => (
        <CvItemCard key={it.id} item={it} draft={drafts[it.id]} canSeeSalary={data.can_see_salary}
          onDraft={d => setDrafts(p => ({ ...p, [it.id]: { ...d, __edited: true } }))}
          matches={matchesFor(drafts[it.id])} hiddenMatch={hiddenFor(drafts[it.id])} batchDupe={batchDupeFor(it, drafts[it.id])} busy={!!busyIds[it.id]}
          onOpen={() => open(it)} onSave={() => save(it)} onAccept={() => accept(it)} onAttach={cid => accept(it, cid)} onSkip={() => skip(it)} />
      ))}
    </div>
  );
}
