'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Plus, ArrowLeft, Check, Pencil } from 'lucide-react';
import { PageHead, Panel, Badge, Btn } from '@/components/ui.js';

const CHANNELS = ['email', 'sms', 'whatsapp'];
const STATUSES = ['draft', 'pending', 'active', 'disabled'];

const STATUS_TONE = { active: 'green', pending: 'yellow', draft: 'gray', disabled: 'red' };

function emptyRow() {
  return { id: null, channel: 'email', address: '', purpose: '', provider: '', status: 'draft', credentials_ref: '', metadata: {} };
}

export default function SendersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('list');
  const [row, setRow] = useState(emptyRow());
  const [metaText, setMetaText] = useState('{}');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('getSenderIdentities', {}, session);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load senders', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function startNew() { setRow(emptyRow()); setMetaText('{}'); setView('form'); }
  function startEdit(r) {
    setRow({ ...emptyRow(), ...r, metadata: r.metadata || {} });
    setMetaText(JSON.stringify(r.metadata || {}, null, 2));
    setView('form');
  }
  function set(k, v) { setRow((r) => ({ ...r, [k]: v })); }

  async function save() {
    if (!row.address.trim()) { showToast('Address required', 'error'); return; }
    let meta = {};
    try { meta = metaText.trim() ? JSON.parse(metaText) : {}; }
    catch { showToast('Metadata must be valid JSON', 'error'); return; }
    setSaving(true);
    try {
      const payload = {
        channel: row.channel, address: row.address.trim(), purpose: row.purpose || null,
        provider: row.provider || null, status: row.status, credentials_ref: row.credentials_ref || null,
        metadata: meta,
      };
      if (row.id) payload.id = row.id;
      await workerFetch('saveSenderIdentity', payload, session);
      showToast(row.id ? 'Sender updated' : 'Sender created', 'success');
      setView('list'); load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  if (perms && !perms.connector_channel_manage) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Channel-manage permission required.</div>;

  if (view === 'form') {
    return (
      <div className="pg">
        <div className="po-head">
          <div className="po-head-l">
            <Btn onClick={() => setView('list')}><ArrowLeft size={14} /> Back to senders</Btn>
            <span className="po-head-no" style={{ fontSize: 18 }}>{row.id ? row.address : 'New Sender Identity'}</span>
          </div>
          <div className="po-head-r"><Btn kind="primary" onClick={save} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save sender'}</Btn></div>
        </div>

        <Panel title="Identity" pad>
          <div className="form-grid">
            <div className="ff"><div className="kv-k">Channel</div>
              <select className="f-inp" value={row.channel} onChange={(e) => set('channel', e.target.value)} disabled={saving}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="ff"><div className="kv-k">Status</div>
              <select className="f-inp" value={row.status} onChange={(e) => set('status', e.target.value)} disabled={saving}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="ff"><div className="kv-k">Address</div>
              <input className="f-inp mono" value={row.address} onChange={(e) => set('address', e.target.value)} placeholder="hello@legendoftoys.com / +91… / WABA id" disabled={saving} />
            </div>
            <div className="ff"><div className="kv-k">Provider</div>
              <input className="f-inp" value={row.provider || ''} onChange={(e) => set('provider', e.target.value)} placeholder="resend / msg91 / meta" disabled={saving} />
            </div>
            <div className="ff"><div className="kv-k">Purpose</div>
              <input className="f-inp" value={row.purpose || ''} onChange={(e) => set('purpose', e.target.value)} placeholder="transactional / marketing" disabled={saving} />
            </div>
            <div className="ff"><div className="kv-k">Credentials ref</div>
              <input className="f-inp mono" value={row.credentials_ref || ''} onChange={(e) => set('credentials_ref', e.target.value)} placeholder="secret name / vault ref" disabled={saving} />
            </div>
            <div className="ff ff-full"><div className="kv-k">Metadata (JSON)</div>
              <textarea className="f-inp mono" rows={5} value={metaText} onChange={(e) => setMetaText(e.target.value)} disabled={saving} />
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="pg">
      <PageHead title="Sender Identities" sub="From-addresses and channel senders. Email rows show DNS verification state."
        actions={<Btn kind="primary" onClick={startNew}><Plus size={14} /> New sender</Btn>} />
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : (
          <Panel title="Senders" count={rows.length}>
            {rows.length === 0
              ? <div style={{ padding: 24, color: 'var(--text-3)' }}>No sender identities yet.</div>
              : (
                <div className="table-scroll">
                <table className="dt">
                  <thead><tr><th>Channel</th><th>Address</th><th>Provider</th><th>Status</th><th>DNS</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const dns = r.channel === 'email' ? (r.metadata?.dns_verified ? 'verified' : 'unverified') : '—';
                      return (
                        <tr key={r.id}>
                          <td><Badge label={r.channel} tone="blue" /></td>
                          <td className="mono">{r.address}</td>
                          <td className="dim">{r.provider || '—'}</td>
                          <td><Badge label={r.status} tone={STATUS_TONE[r.status] || 'gray'} /></td>
                          <td>{r.channel === 'email' ? <Badge label={dns} tone={r.metadata?.dns_verified ? 'green' : 'yellow'} /> : <span className="dim">—</span>}</td>
                          <td><Btn onClick={() => startEdit(r)}><Pencil size={14} /> Edit</Btn></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              )}
          </Panel>
        )}
    </div>
  );
}
