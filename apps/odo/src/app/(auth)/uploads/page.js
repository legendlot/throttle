'use client';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { UploadCloud, CheckCircle2 } from 'lucide-react';
import { salesGet, salesPost, istToday } from '../../../lib/api.js';
import { FAMILIES, familyOf } from '../../../lib/families.js';
import { PageHead, PanelHead, Pill, Swatch, Nil } from '../../../components/prism.js';
import { STATUS } from '../../../lib/hues.js';

// Batch status is semantic — mapped/ok green, error red, anything mid-flight amber.
const BATCH_TONE = { mapped: STATUS.good, ok: STATUS.good, error: STATUS.bad, failed: STATUS.bad };
const batchTone = (s) => BATCH_TONE[s] || STATUS.warn;

// What a good file looks like — and what the parser actually does with it. Stated once, here, so
// the failure modes stop being a support thread. Keep this honest to gridToQcRows/parseSheetDate.
const EXPECTS = [
  ['One row per SKU per day', 'Odo aggregates — don’t pre-roll to weeks or months.'],
  ['A channel SKU column', 'Whatever the channel calls it. Mapping resolves it to a variant.'],
  ['Units and gross value', 'Gross tax-inclusive, net of discounts. Those are the only two numbers read — no GST or discount column is taken off this form.'],
  ['A date column, ISO for safety', 'YYYY-MM-DD is read exactly. Slash and dash dates are assumed day-first and guessed when that’s impossible — 03/04 becomes 3 April, never 4 March.'],
  ['Unreadable dates are stamped, not rejected', 'A row whose date Odo can’t parse is silently dated with your “Period to” value. Nothing is dropped, so check the parsed dates before trusting a load.'],
  ['Re-uploads replace, they don’t merge', 'The same channel + period wipes the prior load first. A bad parse therefore overwrites a good one — re-upload deliberately.'],
];

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
  const [dlvFile, setDlvFile] = useState(null);
  const [dlvBusy, setDlvBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);

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

  // The picker enforces CSV via `accept`; a drop bypasses that entirely. An .xlsx dropped here
  // would be read as text and POSTed as csv_text — and since ingest wipes the channel+period
  // first, that garbage load would REPLACE a good one. So the same check runs on both paths.
  const isCsv = (f) => /\.csv$/i.test(f?.name || '') || /(csv|comma-separated-values)/i.test(f?.type || '');
  const takeFile = (f) => {
    if (!f) return;
    if (!isCsv(f)) { toast?.showToast?.('CSV only — export the report as .csv from the seller portal', 'error'); return; }
    setFile(f);
  };

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

  // Delhivery freight invoice. No channel picker on purpose — the file names its own invoice in
  // `serial_number`, and the month is derived from each row's pickup date, not from anything picked
  // here (one invoice can span two months).
  const submitDelhivery = async () => {
    if (!dlvFile) return;
    setDlvBusy(true);
    try {
      const csv_text = await dlvFile.text();
      const r = await salesPost('uploadDelhiveryInvoice', { csv_text }, session);
      toast?.showToast?.(
        `${r.invoices?.join(', ')} · ${r.rows_staged} shipments · ₹${Number(r.csv_total).toLocaleString('en-IN')} · ${r.months_written} month(s) written`,
        'success');
      setDlvFile(null); load();
    } catch (e) { toast?.showToast?.(e.message, 'error'); }
    finally { setDlvBusy(false); }
  };

  if (loading) return <Spinner />;
  const chName = Object.fromEntries(channels.map(c => [c.channel_id, c.name]));
  const famColor = (id) => FAMILIES[familyOf(chName[id] || '')].color;

  return (
    <div className="so-page" style={{ maxWidth: 1180 }}>
      <PageHead title="Uploads" sub="Drop a channel sales report for any feed that has no live connector yet" />

      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* ── the upload itself ── */}
        <div className="so-card">
          <PanelHead title="Upload a sales report" />
          <p className="so-sub" style={{ margin: '-4px 0 14px', maxWidth: '68ch' }}>
            For Quick-Commerce (Zepto / Blinkit / Instamart) and other report-fed channels. CSV export from the seller portal.
            Re-uploading for the same date range replaces the prior data (no double-count).
          </p>

          {/* The drop zone is a real <button>: tab-reachable, Enter/Space open the picker natively,
              and it takes the global :focus-visible ring. The hidden <input type=file> is its
              SIBLING, not a child — an interactive element inside a button is invalid HTML. */}
          <button
            type="button"
            aria-label={file ? `Selected ${file.name}. Choose a different CSV file` : 'Choose a CSV file, or drop one here'}
            onDragOver={e => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); takeFile(e.dataTransfer?.files?.[0]); }}
            onClick={() => fileRef.current?.click()}
            style={{
              display: 'block', width: '100%', font: 'inherit',
              border: `2px dashed ${drag ? 'var(--accent)' : 'var(--accent-bd)'}`,
              background: 'linear-gradient(160deg, rgba(242,205,26,.07), transparent 70%)',
              borderRadius: 'var(--r-xl)', padding: '30px 20px', textAlign: 'center', cursor: 'pointer',
              transition: 'border-color .14s',
            }}>
            <UploadCloud size={32} strokeWidth={1.5} color="var(--accent)" />
            <div style={{ fontFamily: 'var(--cond)', fontSize: 15, fontWeight: 600, color: 'var(--t1)', marginTop: 10 }}>
              {file ? 'Ready to ingest' : 'Drop a .csv here'}
            </div>
            <div className="so-sub" style={{ fontSize: 12.5, marginTop: 5 }}>
              {file
                ? <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2-cell)' }}>{file.name}</span>
                : <>or <span style={{ color: 'var(--accent)', fontWeight: 600 }}>browse your files</span></>}
            </div>
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" tabIndex={-1} aria-hidden="true"
            onChange={e => { const f = e.target.files?.[0]; if (f) takeFile(f); else setFile(null); }}
            style={{ display: 'none' }} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12, marginTop: 16 }}>
            <Field label="Channel">
              <select className="so-select" value={form.channel_id} onChange={e => setForm(f => ({ ...f, channel_id: e.target.value }))}>
                <option value="">— select —</option>
                {channels.map(c => <option key={c.channel_id} value={c.channel_id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Period from"><input className="so-input" type="date" value={form.from} onChange={e => setForm(f => ({ ...f, from: e.target.value }))} /></Field>
            <Field label="Period to"><input className="so-input" type="date" value={form.to} onChange={e => setForm(f => ({ ...f, to: e.target.value }))} /></Field>
          </div>

          <div className="so-eyebrow" style={{ margin: '14px 0 8px' }}>Column names in your CSV header</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 12 }}>
            <Field label="SKU column"><input className="so-input" value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))} /></Field>
            <Field label="Units column"><input className="so-input" value={form.units} onChange={e => setForm(f => ({ ...f, units: e.target.value }))} /></Field>
            <Field label="Gross ₹ column"><input className="so-input" value={form.gross} onChange={e => setForm(f => ({ ...f, gross: e.target.value }))} /></Field>
            <Field label="Date column (opt)"><input className="so-input" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></Field>
          </div>

          <button className="so-btn" disabled={!canUpload || busy} onClick={submit}
            style={{ width: '100%', marginTop: 16, padding: 11, fontSize: 13.5, fontWeight: 700, borderRadius: 'var(--r-md)' }}>
            {busy ? 'Uploading…' : 'Upload & ingest'}
          </button>

          {/* ── Delhivery freight invoice (S325) ──────────────────────────────
              A DIFFERENT shape from the sales report above and deliberately its own control:
              this file is COST, one row per shipment, and it feeds the /pnl logistics line —
              it is not a sales report and must never go through the channel picker. */}
          <div style={{ borderTop: '1px solid var(--line)', margin: '18px 0 0', paddingTop: 16 }}>
            <div className="so-eyebrow" style={{ marginBottom: 6 }}>Delhivery freight invoice</div>
            <p className="so-sub" style={{ margin: '0 0 10px', maxWidth: '68ch' }}>
              Delhivery One → Finances → Invoices → <b>Download</b>. One row per shipment; this is what
              puts D2C shipping cost on the P&amp;L. Re-uploading the same invoice is a no-op, so it is
              safe to repeat. <b>Upload the “Domestic” invoice</b> — the <code>EPVASH…</code> file is
              SMS billing and is rejected.
            </p>
            <input type="file" accept=".csv,text/csv" disabled={!canUpload || dlvBusy}
              onChange={(e) => setDlvFile(e.target.files?.[0] || null)}
              style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t2)' }} />
            <button className="so-btn" disabled={!canUpload || dlvBusy || !dlvFile} onClick={submitDelhivery}
              style={{ width: '100%', marginTop: 12, padding: 10, fontSize: 13, fontWeight: 700, borderRadius: 'var(--r-md)' }}>
              {dlvBusy ? 'Ingesting…' : 'Upload freight invoice'}
            </button>
          </div>
        </div>

        {/* ── the contract ── */}
        <div className="so-card">
          <PanelHead title="What Odo expects" />
          {EXPECTS.map(([t, d], i) => (
            <div key={t} style={{ display: 'flex', gap: 11, padding: '9px 0', borderBottom: i === EXPECTS.length - 1 ? 'none' : '1px solid var(--border-table)' }}>
              <CheckCircle2 size={17} strokeWidth={1.75} color="var(--green-fg)" style={{ flex: 'none', marginTop: 1 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 12.5, color: 'var(--t1)', fontWeight: 500 }}>{t}</div>
                <div style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--t3)', marginTop: 2, lineHeight: 1.45 }}>{d}</div>
              </div>
            </div>
          ))}
          <p style={{ fontFamily: 'var(--ui)', fontSize: 11.5, color: 'var(--t3)', marginTop: 12, lineHeight: 1.55 }}>
            Rows whose SKU isn’t in the map land in <a href="/mapping" style={{ color: 'var(--accent)', fontWeight: 600 }}>Mapping</a> as unmapped —
            they hold their revenue out of rollups until you point them at a variant.
          </p>
        </div>
      </div>

      <div className="so-card flush">
        <PanelHead title="Upload history" style={{ marginBottom: 0 }} />
        <div style={{ overflowX: 'auto' }}>
          <table className="so-table">
            <thead><tr><th>Uploaded</th><th>Channel</th><th>File</th><th>Period</th><th>Status</th><th className="so-num">Rows</th><th className="so-num">Unmapped</th></tr></thead>
            <tbody>
              {batches.map(b => {
                const cname = chName[b.channel_id];
                const unmapped = Number(b.rows_unmapped) || 0;
                return (
                  <tr key={b.id}>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--t2-cell)', whiteSpace: 'nowrap' }}>{b.uploaded_at ? new Date(b.uploaded_at).toLocaleString('en-IN') : '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {cname
                        ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Swatch color={famColor(b.channel_id)} />{cname}</span>
                        : <Nil />}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.file_name || <Nil />}</td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>{b.report_period_from || '?'} → {b.report_period_to || '?'}</td>
                    <td><Pill color={batchTone(b.status)} dot style={{ borderRadius: 'var(--r-pill)' }}>{b.status}</Pill></td>
                    <td className="so-num">{b.rows_total ?? '—'}</td>
                    <td className="so-num" style={{ color: b.rows_unmapped == null ? undefined : (unmapped ? 'var(--amber)' : 'var(--t5)') }}>{b.rows_unmapped ?? '—'}</td>
                  </tr>
                );
              })}
              {batches.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--t3)' }}>No uploads yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span className="so-eyebrow" style={{ letterSpacing: '0.08em' }}>{label}</span>
      {children}
    </label>
  );
}
