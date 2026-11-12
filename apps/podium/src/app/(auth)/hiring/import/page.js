'use client';
// C4 — bulk CV import: batches + start a new one. Plan: docs/superpowers/plans/2026-11-12-podium-c4-cv-import.md
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, Combobox } from '@throttle/ui';
import { ArrowLeft, UploadCloud } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { Card, F, Row, Note, inp, primaryBtn, backBtn, muted } from '../../../../components/HiringBits.js';
import { SOURCES, listOf, hiringError, fmtDateTime } from '../../../../lib/hiring.js';
import { AiSpendLine, errText } from '../../../../components/CvImportBits.js';

export default function CvImportsPage() {
  const { session } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [openings, setOpenings] = useState([]);
  const [form, setForm] = useState({ opening_id: '', source: 'linkedin', source_detail: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    podiumopsGet('getCvImports', {}, session).then(setData).catch(e => { setData({ imports: [] }); showToast(hiringError(e, 'Failed to load'), 'error'); });
    podiumopsGet('getOpenings', {}, session).then(d => setOpenings(listOf(d, 'openings').filter(o => o.status === 'open'))).catch(() => {});
  }, [session, showToast]);

  async function start() {
    if (!form.opening_id) { showToast('Pick an opening', 'error'); return; }
    setBusy(true);
    try {
      const imp = await podiumopsPost('createCvImport', form, session);
      router.push(`/hiring/import/batch/?id=${imp.id}`);
    } catch (e) { showToast(errText(e), 'error'); setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 980 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => router.push('/hiring')} style={backBtn}><ArrowLeft size={13} /> Candidates</button>
        <span style={{ fontSize: 18, fontWeight: 700 }}>Import CVs</span>
        <span style={{ flex: 1 }} />
        {data?.spend && <AiSpendLine spend={data.spend} ready={data.ai_ready} />}
      </div>

      <Card title="New batch">
        <div style={{ ...muted, marginBottom: 10 }}>
          Drop up to 100 CVs for one opening. AI reads each one and fills the fields; you check them and press Accept.
          Nobody is added until you accept them.
        </div>
        <Row>
          <F label="Opening (open, with a JD)" style={{ flex: 2, minWidth: 260 }}>
            <Combobox value={form.opening_id} onChange={v => setForm(f => ({ ...f, opening_id: v }))} inputStyle={inp}
              placeholder="Pick an opening" options={openings.map(o => ({ value: o.id, label: o.designation, hint: o.opening_code }))} />
          </F>
          <F label="Source" style={{ flex: 1, minWidth: 150 }}>
            <select value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} style={inp}>
              {SOURCES.filter(s => s.id !== 'referral').map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </F>
          <F label="Detail (optional)" style={{ flex: 1, minWidth: 160 }}>
            <input value={form.source_detail} onChange={e => setForm(f => ({ ...f, source_detail: e.target.value }))} placeholder="e.g. LinkedIn job post" style={inp} />
          </F>
        </Row>
        <div style={{ marginTop: 12 }}>
          <button onClick={start} disabled={busy} style={primaryBtn}><UploadCloud size={14} /> {busy ? 'Starting…' : 'Start batch'}</button>
        </div>
        {!openings.length && <div style={{ marginTop: 10 }}><Note>No open openings you can add candidates to. An opening needs a JD and must be open.</Note></div>}
      </Card>

      <Card title="Batches">
        {!data ? <Spinner /> : !data.imports?.length ? <div style={muted}>No batches yet. Batches untouched for 7 days are cleared (accepted candidates stay).</div> : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {data.imports.map(b => {
              const n = b.counts || {};
              const total = Object.values(n).reduce((a, v) => a + v, 0);
              const toReview = (n.extracted || 0) + (n.needs_manual || 0);
              const pending = (n.uploaded || 0) + (n.extracting || 0);
              return (
                <button key={b.id} onClick={() => router.push(`/hiring/import/batch/?id=${b.id}`)} style={batchRow}>
                  <span style={{ flex: 2, textAlign: 'left' }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>{b.opening.designation} <span style={muted}>{b.opening.opening_code}</span></div>
                    <div style={muted}>{SOURCES.find(s => s.id === b.source)?.label || b.source}{b.source_detail ? ` · ${b.source_detail}` : ''} · {fmtDateTime(b.created_at)}</div>
                  </span>
                  <span style={{ flex: 2, textAlign: 'right', fontSize: 12, color: 'var(--text-2)' }}>
                    {total} CV{total === 1 ? '' : 's'} · {n.accepted || 0} accepted{toReview ? ` · ${toReview} to review` : ''}{pending ? ` · ${pending} reading` : ''}{n.skipped ? ` · ${n.skipped} skipped` : ''}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

const batchRow = { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 4px', background: 'transparent', border: 'none',
  borderBottom: '1px solid var(--border)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, width: '100%' };
