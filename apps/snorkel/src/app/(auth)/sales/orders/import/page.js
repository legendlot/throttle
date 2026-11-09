'use client';
// Import PO (Harsh #bugs 1793871854.409349): one channel PO file → the ordinary New Order form,
// pre-filled. The file is read IN THE BROWSER (lib/poImport — fixed parsers per buyer layout),
// previewSalesOrderImport resolves partner + products without writing anything, and Save is the
// same createSalesOrder the New Order page uses. Phase 1: Zepto PDF, Swiggy Instamart (Scootsy)
// PDF, Flipkart xlsx. Rate = the PO's unit base cost ex-GST.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { pageH1, pageSub, panelStyle, panelHeaderStyle, panelBodyStyle, btnPrimary, btnSecondary, tableThStyle, tableTdStyle } from '@/lib/snorkelui';
import { inr } from '@/lib/sales';
import { extractFile } from '@/lib/poImport/extract.js';
import { parsePurchaseOrder } from '@/lib/poImport/index.js';
import { initialFromPreview, IMPORT_CHANNEL_LABEL } from '@/lib/poImport/form.js';
import OrderForm from '../OrderForm';

const CHANNEL_LABEL = IMPORT_CHANNEL_LABEL;
const bad = { color: '#ff7070' };

export default function ImportOrderPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [partners, setPartners] = useState([]);
  const [channels, setChannels] = useState([]);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(null);          // progress text while reading / matching
  const [error, setError] = useState(null);        // could not read / not supported
  const [po, setPo] = useState(null);              // parsed neutral shape
  const [preview, setPreview] = useState(null);
  const [pickInForm, setPickInForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [dupConfirmed, setDupConfirmed] = useState(false);   // "import it again as a separate order"
  const [saveDupOf, setSaveDupOf] = useState(null);          // a duplicate only the SAVE-time check saw

  useEffect(() => {
    if (!session) return;
    garageFetch('getSalesPartners', { active: '1' }, session).then(d => setPartners(Array.isArray(d) ? d : [])).catch(() => {});
    garageFetch('getSalesChannels', {}, session).then(d => setChannels(Array.isArray(d) ? d : [])).catch(() => {});
  }, [session]);

  if (perms && !perms.sales_order_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  function reset() { setError(null); setPo(null); setPreview(null); setPickInForm(false); setDupConfirmed(false); setSaveDupOf(null); }

  async function runPreview(parsed, partnerId) {
    setBusy('Matching the partner and products…');
    setDupConfirmed(false);
    setSaveDupOf(null);
    try {
      const res = await workerFetch('previewSalesOrderImport', { data: { ...parsed, partner_id: partnerId || null } }, session);
      setPreview(res.data);
      setFormKey(k => k + 1);
    } catch (e) {
      setError(e.message || 'Could not match this PO');
    } finally { setBusy(null); }
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';                    // the same file can be chosen again after a fix
    if (!file) return;
    reset();
    setFileName(file.name);
    setBusy('Reading the PO…');
    let parsed;
    try {
      parsed = parsePurchaseOrder(await extractFile(file));
    } catch (err) {
      setBusy(null);
      setError(err.message || 'Could not read this file');
      return;
    }
    if (parsed.error) { setBusy(null); setError(parsed.error); return; }
    setPo(parsed);
    await runPreview(parsed, null);
  }

  async function submit(data) {
    if (!data.partner_id) { showToast('Select a partner', 'error'); return; }
    if (!data.lines.length) { showToast('Add at least one line', 'error'); return; }
    setSaving(true);
    try {
      const res = await workerFetch('createSalesOrder', { data }, session);
      const r = res.data || {};
      const gaps = r.hsn_gaps || [];
      if (gaps.length) showToast(`Order ${r.order_no} created — but no HSN on file for ${gaps.join(', ')}; the GST shown is the form default, not a looked-up rate. Fix the catalogue before invoicing.`, 'error');
      else showToast(`Order ${r.order_no} created from PO ${data.partner_po_ref || ''}`.trim(), 'success');
      if (r.sku_learn_error) showToast(`Order saved, but the new code matches could not be remembered (${r.sku_learn_error}) — they will need picking again next time.`, 'error');
      else if (r.sku_learned?.length) showToast(`${r.sku_learned.length} new PO code match${r.sku_learned.length === 1 ? '' : 'es'} saved — the next PO with ${r.sku_learned.length === 1 ? 'that code' : 'those codes'} fills in on its own.`, 'success');
      const odd = (r.sku_skipped || []).filter(s => !/already mapped/.test(s.reason || ''));
      if (odd.length) showToast(`Not remembered: ${odd.map(s => `${s.channel_sku} (${s.reason})`).join(', ')}`, 'error');
      router.push(`/sales/orders/detail?id=${encodeURIComponent(r.id)}`);
    } catch (e) {
      // 409 = the save-time check found this PO on an order the preview did not (another import
      // landed meanwhile, or the partner was picked in the form): ask for the same confirmation.
      if (e.status === 409) {
        setSaveDupOf((e.message.match(/SO-\d+/g) || ['an existing order']));
        setDupConfirmed(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      showToast(e.message || 'Create failed', 'error');
      setSaving(false);
    }
  }

  const pv = preview;
  const resolved = pv?.partner?.status === 'matched' ? pv.partner.partner : null;
  const showForm = pv && (resolved || pickInForm);
  const warnings = [...(po?.warnings || []), ...(pv?.warnings || [])];
  const dupFor = id => (pv?.existing_orders || []).filter(o => o.partner_id === id);
  const duplicateOf = saveDupOf || pv?.duplicate_of || [];
  const dupLabel = saveDupOf ? saveDupOf.join(', ')
    : (pv?.duplicate_orders || []).map(o => `${o.order_no} (${o.status}${o.partner_name ? `, ${o.partner_name}` : ''})`).join(', ');
  const built = showForm ? initialFromPreview(pv, resolved, todayStr()) : null;   // on pending quantities the PO total no longer applies → importInfo hides that line

  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>Import PO</h1>
        <p style={pageSub}>Zepto or Swiggy Instamart PDF · Flipkart xlsx → a draft order to check and save.</p>
      </div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>PO file</span></div>
        <div style={{ ...panelBodyStyle, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ ...btnPrimary, display: 'inline-block', opacity: busy ? 0.6 : 1 }}>
            {fileName ? 'Choose another file' : 'Choose PO file'}
            <input type="file" accept=".pdf,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFile} disabled={!!busy || saving} style={{ display: 'none' }} />
          </label>
          {fileName && <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>{fileName}</span>}
          {busy && <span style={{ fontSize: 12, color: 'var(--t3)' }}>{busy}</span>}
          <button style={btnSecondary} onClick={() => router.push('/sales/orders')}>Back to orders</button>
        </div>
        {error && <div style={{ ...panelBodyStyle, paddingTop: 0, fontSize: 13, ...bad }}>{error}</div>}
      </div>

      {pv && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>{CHANNEL_LABEL[pv.channel_key] || pv.channel_key} PO {pv.po.po_no || ''}</span></div>
          <div style={{ ...panelBodyStyle, fontSize: 12, color: 'var(--t2)', display: 'grid', gap: 6 }}>
            <div>
              PO date <b>{pv.po.po_date || '—'}</b> · delivery <b>{pv.po.delivery_date || '—'}</b> · expires <b>{pv.po.expiry_date || '—'}</b>
              {' · '}ships to GSTIN <span style={{ fontFamily: 'var(--mono)' }}>{pv.po.ship_to_gstin || '—'}</span>
            </div>
            {pv.po.ship_to_address && <div style={{ color: 'var(--t3)' }}>{pv.po.ship_to_address}</div>}
            <div>
              {pv.lines.length} line{pv.lines.length === 1 ? '' : 's'} · {pv.lines.length - pv.unmatched} matched
              {pv.unmatched > 0 && <b style={bad}> · {pv.unmatched} need a product picked</b>}
              {' · '}PO taxable {pv.checksum.po_total_taxable != null ? inr(pv.checksum.po_total_taxable) : '—'}
            </div>
            {!pv.checksum.ok && pv.checksum.message && <div style={bad}>{pv.checksum.message}</div>}
            {warnings.map((w, i) => <div key={i} style={{ color: 'var(--yellow)' }}>{w}</div>)}
          </div>
        </div>
      )}

      {pv && !resolved && !pickInForm && (
        <div style={panelStyle}>
          <div style={panelHeaderStyle}><span>Which partner is this PO from?</span></div>
          <div style={{ ...panelBodyStyle, fontSize: 12 }}>
            <div style={{ marginBottom: 10, color: 'var(--t2)' }}>
              {pv.partner.reason}. {pv.partner.status === 'none'
                ? 'Pick the right partner below, or add the new one from Sales → Partners and import the file again.'
                : 'Pick the right one:'}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>{['Code', 'Partner', 'City', 'GSTIN', 'PIN', ''].map(h => <th key={h} style={tableThStyle}>{h}</th>)}</tr></thead>
              <tbody>
                {pv.partner.candidates.map(c => {
                  const dup = dupFor(c.id);
                  return (
                    <tr key={c.id}>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{c.partner_code}</td>
                      <td style={{ ...tableTdStyle, whiteSpace: 'normal' }}>{c.name}{dup.length > 0 && <b style={bad}> · already on {dup.map(o => o.order_no).join(', ')}</b>}</td>
                      <td style={tableTdStyle}>{c.city || '—'}</td>
                      <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{c.gstin || '—'}</td>
                      <td style={tableTdStyle}>{c.pin_match ? 'matches PO' : '—'}</td>
                      <td style={tableTdStyle}><button style={btnSecondary} disabled={!!busy} onClick={() => runPreview(po, c.id)}>Use this partner</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ marginTop: 10 }}>
              <button style={btnSecondary} onClick={() => { setPickInForm(true); setFormKey(k => k + 1); }}>Choose the partner in the order form instead</button>
            </div>
          </div>
        </div>
      )}

      {showForm && duplicateOf.length > 0 && (
        <div style={{ ...panelStyle, borderColor: '#ff7070' }}>
          <div style={{ ...panelBodyStyle, fontSize: 13 }}>
            <div style={{ ...bad, marginBottom: 8 }}>
              <b>This PO is already on {dupLabel}</b> — import it again as a separate order?
              <span style={{ color: 'var(--t3)' }}> Fine when one PO is split across orders; otherwise open the existing order instead.</span>
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={dupConfirmed} onChange={e => setDupConfirmed(e.target.checked)} />
              Yes — import it again as a separate order
            </label>
          </div>
        </div>
      )}

      {built?.usedPending && (
        <div style={{ ...panelStyle, ...panelBodyStyle, fontSize: 12, color: 'var(--yellow)' }}>
          Quantities are set to what the PO still has <b>pending</b>, because it is already on an order.
          {built.skippedPending.length > 0 && ` Left off (nothing pending): ${built.skippedPending.map(l => `${l.channel_code || l.ean} — ${l.title || ''} (${l.qty} ordered)`).join('; ')}.`}
        </div>
      )}

      {showForm && (
        <OrderForm
          key={formKey}
          partners={partners}
          channels={channels}
          initial={built.initial}
          importInfo={{ channel_key: pv.channel_key, po_no: pv.po.po_no, po_total_taxable: built.usedPending ? null : pv.checksum.po_total_taxable,
            duplicateOf, duplicateConfirmed: dupConfirmed }}
          saving={saving}
          onSubmit={submit}
          onCancel={() => router.push('/sales/orders')}
        />
      )}
    </div>
  );
}
