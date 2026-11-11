'use client';
// J2 — policies (L4: ships empty; HR co-creates them later). Upload a PDF to publish a new policy, or a new version
// of one: the old version is retired and its acknowledgements stay valid for it only, so everyone re-acknowledges.
// Gates: HR / admin (the worker's getPolicies / createPolicyUploadUrl / savePolicy / setPolicyActive).
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { FileText, UploadCloud } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { EMPLOYMENT_TYPES, fmtDate } from '../../../../lib/format.js';
import { obError } from '../../../../lib/onboarding.js';
import { Card, F, ToneBadge, signedUpload, inp, primaryBtn, ghostBtn, muted } from '../../../../components/HiringBits.js';

const smallBtn = { ...ghostBtn, padding: '4px 10px', fontSize: 11 };

export default function PoliciesPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [d, setD] = useState(null);
  const [title, setTitle] = useState('');
  const [applies, setApplies] = useState([]);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!session) return;
    podiumopsGet('getPolicies', {}, session).then(setD).catch(() => setD(false));
  }, [session]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.podium_hr) return <div style={{ color: 'var(--t3)' }}>Requires podium_hr.</div>;
  if (d === false) return <div style={{ color: 'var(--t3)' }}>Could not load policies.</div>;
  if (!d) return <Spinner />;

  async function publish() {
    if (!title.trim() || !file) { showToast('A title and a PDF are needed', 'error'); return; }
    setBusy(true);
    try {
      const meta = await signedUpload('createPolicyUploadUrl', { file_size: file.size }, file, session);
      await podiumopsPost('savePolicy', { title: title.trim(), storage_path: meta.storage_path, applies_to: applies }, session);
      showToast('Published', 'success'); setTitle(''); setFile(null); setApplies([]); load();
    } catch (e) { showToast(obError(e), 'error'); }
    finally { setBusy(false); }
  }
  async function open(p) {
    try { const r = await podiumopsGet('getPolicyFile', { policy_id: p.id }, session); window.open(r.url, '_blank', 'noopener'); }
    catch (e) { showToast(obError(e), 'error'); }
  }
  async function setActive(p, active) {
    try { await podiumopsPost('setPolicyActive', { id: p.id, active }, session); showToast(active ? 'Active again' : 'Withdrawn', 'success'); load(); }
    catch (e) { showToast(obError(e), 'error'); }
  }
  const titles = [...new Set(d.policies.map(p => p.title))];

  return (
    <div style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><UploadCloud size={13} /> Publish a policy or a new version</span>}>
        <F label="Title (an existing title publishes its next version)">
          <input style={{ ...inp, fontFamily: 'var(--font-ui)' }} list="policy-titles" value={title} onChange={e => setTitle(e.target.value)} />
          <datalist id="policy-titles">{titles.map(t => <option key={t} value={t} />)}</datalist>
        </F>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10, fontSize: 12 }}>
          <span style={muted}>Applies to:</span>
          {EMPLOYMENT_TYPES.map(t => (
            <label key={t.id} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
              <input type="checkbox" checked={applies.includes(t.id)} onChange={e => setApplies(a => e.target.checked ? [...a, t.id] : a.filter(x => x !== t.id))} />{t.label}
            </label>
          ))}
          {!applies.length && <span style={muted}>(none ticked = everyone)</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="file" accept=".pdf" onChange={e => setFile(e.target.files?.[0] || null)} style={{ fontSize: 12, color: 'var(--text-2)' }} />
          <button style={primaryBtn} disabled={busy} onClick={publish}><UploadCloud size={13} /> {busy ? 'Publishing…' : 'Publish'}</button>
        </div>
      </Card>

      <Card title={`Policies (${d.policies.length})`}>
        {!d.policies.length ? <div style={muted}>No policies yet. They are co-created with HR and published here.</div> : d.policies.map(p => (
          <div key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '6px 0', borderTop: '1px solid var(--border)', opacity: p.active ? 1 : 0.6 }}>
            <span style={{ flex: 1 }}><b>{p.title}</b> <span style={muted}>v{p.version} · {fmtDate(p.published_at)} · {(p.applies_to || []).length ? p.applies_to.join(', ') : 'everyone'} · {p.acknowledgements} acknowledged</span></span>
            <ToneBadge tone={p.active ? 'ok' : 'neutral'} label={p.active ? 'Active' : 'Retired'} />
            <button style={smallBtn} onClick={() => open(p)}><FileText size={11} /> Open</button>
            <button style={smallBtn} onClick={() => setActive(p, !p.active)}>{p.active ? 'Withdraw' : 'Reactivate'}</button>
          </div>
        ))}
      </Card>
    </div>
  );
}
