'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { salesGet, salesPost, istToday } from '../../../lib/api.js';

// Quick-commerce + other report-fed channels.
export default function UploadsPage() {
  const { session, perms } = useAuth();
  const canUpload = !!(perms?.sales_upload || perms?.salesops_admin);
  const toast = useToast();
  const [channels, setChannels] = useState([]);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ channel_id: '', from: istToday(), to: istToday(), sku: 'sku', units: 'units', gross: 'gross', date: 'date' });
  const [file, setFile] = useState(null);

  const load = () => {
    if (!session) return;
    setLoading(true);
    Promise.all([salesGet('getBootstrap', {}, session), salesGet('getUploadBatches', {}, session)])
      .then(([b, u]) => {
        // report-fed channels = adapter qc_upload
        setChannels((b?.connectors || []).filter(c => c.adapter_kind === 'qc_upload'));
        setBatches(u?.rows || []);
      }).finally(() => setLoading(false));
  };
  useEffect(load, [session]);

  const submit = async () => {
    if (!form.channel_id) { toast?.showToast?.('Pick a channel', 'error'); return; }
    if (!file) { toast?.showToast?.('Choose a CSV file', 'error'); return; }
    setBusy(true);
    try {
      const csv_text = await file.text();
      const r = await salesPost('uploadReport', {
        channel_id: form.channel_id, file_name: file.name, mime_type: file.type || 'text/csv',
        report_period_from: form.from, report_period_to: form.to, csv_text,
        column_map: { sku: form.sku, units: form.units, gross: form.gross, date: form.date },
      }, session);
      toast?.showToast?.(`Parsed ${r.rows_total} rows · ${r.rows_unmapped || 0} unmapped`, 'success');
      setFile(null); load();
    } catch (e) { toast?.showToast?.(e.message, 'error'); }
    finally { setBusy(false); }
  };

  if (loading) return <Spinner />;
  const chName = Object.fromEntries(channels.map(c => [c.channel_id, c.name]));
  return (
    <div className="so-page" style={{ gap: 22, maxWidth: 900 }}>
      <section className="so-card">
        <h2 className="so-h2">Upload a sales report</h2>
        <p className="so-sub" style={{ margin: '4px 0 16px', maxWidth: '68ch' }}>
          For Quick-Commerce (Zepto / Blinkit / Instamart) and other report-fed channels. CSV export from the seller portal.
          Re-uploading for the same date range replaces the prior data (no double-count).
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
          <Field label="Channel">
            <select className="so-select" value={form.channel_id} onChange={e => setForm(f => ({ ...f, channel_id: e.target.value }))}>
              <option value="">— select —</option>
              {channels.map(c => <option key={c.channel_id} value={c.channel_id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Period from"><input className="so-input" type="date" value={form.from} onChange={e => setForm(f => ({ ...f, from: e.target.value }))} /></Field>
          <Field label="Period to"><input className="so-input" type="date" value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))} /></Field>
        </div>
        <div style={{ marginTop: 14, fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 8 }}>Column names in your CSV header</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 12 }}>
          <Field label="SKU column"><input className="so-input" value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))} /></Field>
          <Field label="Units column"><input className="so-input" value={form.units} onChange={e => setForm(f => ({ ...f, units: e.target.value }))} /></Field>
          <Field label="Gross ₹ column"><input className="so-input" value={form.gross} onChange={e => setForm(f => ({ ...f, gross: e.target.value }))} /></Field>
          <Field label="Date column (opt)"><input className="so-input" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></Field>
        </div>
        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 14 }}>
          <input type="file" accept=".csv,text/csv" onChange={e => setFile(e.target.files?.[0] || null)} style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }} />
          <button className="so-btn" disabled={!canUpload || busy} onClick={submit}>{busy ? 'Uploading…' : 'Upload + parse'}</button>
        </div>
      </section>

      <section>
        <h2 className="so-h2" style={{ marginBottom: 12 }}>Upload history</h2>
        <div className="so-card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="so-table">
            <thead><tr><th>Uploaded</th><th>Channel</th><th>File</th><th>Period</th><th>Status</th><th className="so-num">Rows</th><th className="so-num">Unmapped</th></tr></thead>
            <tbody>
              {batches.map(b => (
                <tr key={b.id}>
                  <td>{b.uploaded_at ? new Date(b.uploaded_at).toLocaleString('en-IN') : '—'}</td>
                  <td>{chName[b.channel_id] || '—'}</td>
                  <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.file_name || '—'}</td>
                  <td>{b.report_period_from || '?'} → {b.report_period_to || '?'}</td>
                  <td><span style={{ color: b.status === 'mapped' ? 'var(--green)' : b.status === 'error' ? 'var(--red)' : 'var(--amber)' }}>{b.status}</span></td>
                  <td className="so-num">{b.rows_total ?? '—'}</td>
                  <td className="so-num">{b.rows_unmapped ?? '—'}</td>
                </tr>
              ))}
              {batches.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--t3)' }}>No uploads yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)' }}>{label}</span>
      {children}
    </label>
  );
}
