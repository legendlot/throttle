'use client';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Banner, Card, Modal } from '../../../../components/ui/index.js';
import { ignitionopsGet, ignitionopsPost } from '../../../../lib/ignitionopsFetch.js';

// The contract wording (Reann #1). Reann owns these words, and nothing in the code supplies them:
// until this page publishes, nothing can send and nothing is locked.
const ctl = { width: '100%', boxSizing: 'border-box', background: 'var(--input)', color: 'var(--text-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-ctl)', padding: '10px 12px', fontFamily: 'var(--font-ui)', fontSize: 14, lineHeight: 1.5 };
const lbl = { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-3)', marginBottom: 6 };
const ghostBtn = { height: 40, padding: '0 16px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border-3)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600 };
const primaryBtn = { height: 40, padding: '0 18px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 700 };
const fmt = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export default function AdminContractPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const canAdmin = !!perms?.ignition_admin;
  const [data, setData] = useState(null);
  const [f, setF] = useState({ subject: '', dos_and_donts: '', terms: '' });
  const [saved, setSaved] = useState({ subject: '', dos_and_donts: '', terms: '' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const take = useCallback((settings) => {
    const next = { subject: settings?.subject || '', dos_and_donts: settings?.dos_and_donts || '', terms: settings?.terms || '' };
    setF(next); setSaved(next);
  }, []);

  useEffect(() => {
    if (!session || !canAdmin) { setLoading(false); return; }
    ignitionopsGet('getContractSettings', {}, session)
      .then(d => { setData(d); take(d.settings); })
      .catch(e => showToast(e.message, 'error'))
      .finally(() => setLoading(false));
  }, [session, canAdmin, showToast, take]);

  if (!canAdmin) return <div style={{ padding: 16, color: 'var(--text-3)' }}>Admin only.</div>;
  if (loading) return <div style={{ padding: 40, display: 'flex', justifyContent: 'center' }}><Spinner /></div>;

  const dirty = f.subject !== saved.subject || f.dos_and_donts !== saved.dos_and_donts || f.terms !== saved.terms;
  const filled = f.dos_and_donts.trim() && f.terms.trim();
  const published = !!data?.published;
  const set = (k) => (e) => { const v = e.target.value; setF(x => ({ ...x, [k]: v })); };

  async function persist() {
    const r = await ignitionopsPost('saveContractSettings', f, session);
    setData(d => ({ ...d, settings: r.settings, published: r.published }));
    take(r.settings);
  }
  async function save() {
    setBusy(true);
    try { await persist(); showToast('Saved', 'success'); }
    catch (e) { showToast(e.message, 'error'); }
    finally { setBusy(false); }
  }
  async function publish() {
    setBusy(true);
    try {
      if (dirty) await persist();
      const r = await ignitionopsPost('publishContractSettings', {}, session);
      setData(d => ({ ...d, settings: r.settings, published: true }));
      setConfirm(false);
      showToast('Published. Sending and the Shipping lock are on.', 'success');
    } catch (e) { showToast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  const off = busy;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820 }}>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 26, fontWeight: 700, margin: '8px 0 0' }}>Contract wording</h1>

      {published
        ? <Banner tone="success" lead="Published.">Sending and the Shipping lock are on, since {fmt(data.settings.published_at)}. Saving a change here applies to the next contract anyone opens; contracts already sent keep the words they went out with.</Banner>
        : <Banner tone="warning" lead="Not published.">Nothing can be sent and nothing is locked until you publish.</Banner>}

      {data?.mailbox?.ok
        ? <Banner tone="info" lead="partners@ is reachable.">Mail goes out as {data.mailbox.address}.</Banner>
        : <Banner tone="error" lead="partners@legendoftoys.com cannot be reached.">{data?.mailbox?.error || 'No answer from the mail service.'} Contracts will fail to send until this clears.</Banner>}

      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={lbl}>Subject</label>
            <input value={f.subject} onChange={set('subject')} style={ctl} placeholder="Your Legend of Toys collaboration" />
          </div>
          <div>
            <label style={lbl}>Dos and don&apos;ts</label>
            <textarea value={f.dos_and_donts} onChange={set('dos_and_donts')} rows={10} style={{ ...ctl, resize: 'vertical' }} />
          </div>
          <div>
            <label style={lbl}>Terms</label>
            <textarea value={f.terms} onChange={set('terms')} rows={14} style={{ ...ctl, resize: 'vertical' }} />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" onClick={save} disabled={off || !dirty} className="ig-ghost-btn" style={{ ...ghostBtn, cursor: off || !dirty ? 'not-allowed' : 'pointer', opacity: off || !dirty ? 0.5 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
            {!published && (
              <button type="button" onClick={() => setConfirm(true)} disabled={off || !filled} className={off || !filled ? undefined : 'ig-cta'} style={{ ...primaryBtn, cursor: off || !filled ? 'not-allowed' : 'pointer', opacity: off || !filled ? 0.5 : 1 }}>Publish</button>
            )}
          </div>
        </div>
      </Card>

      {confirm && (
        <Modal open title="Publish this wording?" onClose={() => setConfirm(false)} onConfirm={publish} confirmLabel="Publish" loading={busy}>
          <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.5 }}>
            Publishing turns on sending and the Shipping lock. From then on, a video deal that came under the lock
            cannot move to Shipped or past it until the creator accepts or someone records it by hand.
          </div>
        </Modal>
      )}
    </div>
  );
}
