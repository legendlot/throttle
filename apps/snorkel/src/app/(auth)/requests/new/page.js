'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast, Combobox } from '@throttle/ui';
import { Send, Plus, Trash2 } from 'lucide-react';
import { PageHead, Panel, Btn } from '@/components/ui.js';

function money(n) {
  return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function FormField({ label, children, full }) {
  return <div className={`ff ${full ? 'ff-full' : ''}`}><label className="kv-k">{label}</label>{children}</div>;
}

export default function NewRequestPage() {
  const { session, userId } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();

  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [category, setCategory] = useState('');
  const [suggestedVendor, setSuggestedVendor] = useState('');
  const [estCost, setEstCost] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [urgency, setUrgency] = useState('Normal');
  const [neededBy, setNeededBy] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Line items (S340). The requester picks a part and gives a qty; the tax rate shown
  // here is ADVISORY ONLY — the worker re-resolves hsn_code/gst_percent from the part
  // master at insert and ignores whatever we send, so nothing typed or stale on this
  // screen can land a wrong rate on a line (reference/decisions.md §PO request lines).
  const [lines, setLines] = useState([]);
  const [items, setItems] = useState(null);
  const [itemsLoading, setItemsLoading] = useState(false);

  // Keyed on userId, never on the session object — onAuthStateChange re-fires on tab
  // switch and a real token refresh lands ~hourly, and this page holds unsaved input
  // (CORE.md useAuth rule). getRequestItemOptions is unguarded on purpose: this form is
  // open to any @legendoftoys.com login, not just Snorkel users.
  const loadItems = useCallback(async () => {
    if (!session) return;
    setItemsLoading(true);
    try {
      const res = await garageFetch('getRequestItemOptions', {}, session);
      setItems(Array.isArray(res) ? res : (res?.data || []));
    } catch {
      setItems([]);   // a failed load must not block the form — free-text lines still work
    } finally {
      setItemsLoading(false);
    }
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadItems(); }, [loadItems]);

  const itemOptions = useMemo(() => (items || []).map((it) => ({
    value: it.part_code,
    label: it.part_code,
    hint: [it.part_name, it.product].filter(Boolean).join(' · '),
    part_name: it.part_name,
    hsn_code: it.hsn_code,
    gst_percent: it.gst_percent,
  })), [items]);

  function addLine() {
    setLines((prev) => [...prev, {
      part_code: '', description: '', qty: '', unit: 'pcs',
      unit_price: '', hsn_code: null, gst_percent: null,
    }]);
  }
  function updateLine(i, field, value) {
    setLines((prev) => prev.map((l, j) => (j === i ? { ...l, [field]: value } : l)));
  }
  function removeLine(i) {
    setLines((prev) => prev.filter((_, j) => j !== i));
  }
  // Picking a part fills the description and the advisory rate in one move.
  function selectPart(i, opt) {
    setLines((prev) => prev.map((l, j) => (j === i ? {
      ...l,
      part_code: opt?.value || '',
      description: l.description || opt?.part_name || opt?.value || '',
      hsn_code: opt?.hsn_code ?? null,
      gst_percent: opt?.gst_percent ?? null,
    } : l)));
  }

  // Totals as you type — the thing that actually kills the parallel sheet. Tax is an
  // ESTIMATE and is labelled as one: a line with no resolved rate contributes 0 rather
  // than silently guessing 18%.
  const totals = useMemo(() => {
    let taxable = 0, tax = 0;
    for (const l of lines) {
      const v = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
      taxable += v;
      tax += v * ((Number(l.gst_percent) || 0) / 100);
    }
    return { taxable, tax, grand: taxable + tax };
  }, [lines]);

  const unpricedLines = lines.filter(l => (Number(l.qty) > 0) && !(Number(l.unit_price) > 0)).length;

  async function submit() {
    if (!title.trim()) { showToast('Title required', 'error'); return; }
    if (!details.trim()) { showToast('Say why you need this', 'error'); return; }
    // Validate lines here so the requester is told which row is wrong, rather than
    // getting the worker's generic rejection after a round trip.
    const filled = lines.filter(l => l.part_code || l.description.trim() || l.qty !== '');
    for (let i = 0; i < filled.length; i++) {
      const l = filled[i];
      if (!(Number(l.qty) > 0)) { showToast(`Line ${i + 1}: quantity must be more than zero`, 'error'); return; }
      if (!l.part_code && !l.description.trim()) { showToast(`Line ${i + 1}: pick an item or describe it`, 'error'); return; }
    }
    setSubmitting(true);
    try {
      const res = await workerFetch('postRequest', {
        data: {
          title: title.trim(), details: details.trim(),
          category: category.trim() || null,
          suggested_vendor: suggestedVendor.trim() || null,
          // estimated_cost is DERIVED by the worker once lines exist; this typed value
          // is only used for a prose-only request.
          estimated_cost: estCost !== '' ? Number(estCost) : null,
          currency, urgency,
          needed_by: neededBy || null,
          notes: notes.trim() || null,
          // hsn_code / gst_percent are deliberately NOT sent — the worker resolves them
          // from the part master and ignores anything we supply.
          lines: filled.map(l => ({
            part_code: l.part_code || null,
            description: l.description.trim() || l.part_code,
            qty: Number(l.qty),
            unit: l.unit || 'pcs',
            unit_price: l.unit_price !== '' ? Number(l.unit_price) : null,
          })),
        },
      }, session);
      const result = res.data || res;
      showToast(`${result.request_no} submitted`, 'success');
      router.push(`/requests/detail?request_no=${encodeURIComponent(result.request_no)}`);
    } catch (e) {
      showToast(e.message || 'Failed to submit request', 'error');
      setSubmitting(false);
    }
  }

  return (
    <div className="pg" style={{ maxWidth: 760 }}>
      <PageHead title="New PO Request" sub="Tell procurement what you need. The more context, the faster they can raise a PO." />
      <Panel title="Request details" pad>
        <div className="form-grid">
          <FormField label="Title" full><input className="f-inp" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. 20× ceiling fans for the new floor" disabled={submitting} /></FormField>
          <FormField label="Why do you need it?" full><textarea className="f-inp" rows="3" value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Context procurement can act on — what it is for, specs, links, any deadline behind the date below. List the items themselves below, not here." disabled={submitting} /></FormField>
          <FormField label="Category"><input className="f-inp" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Office / Consumable / Component / Machine…" disabled={submitting} /></FormField>
          <FormField label="Suggested vendor (optional)"><input className="f-inp" value={suggestedVendor} onChange={(e) => setSuggestedVendor(e.target.value)} disabled={submitting} /></FormField>
          {lines.length === 0 && (
            <FormField label="Estimated cost"><input className="f-inp mono" type="number" min="0" value={estCost} onChange={(e) => setEstCost(e.target.value)} placeholder="0" disabled={submitting} /></FormField>
          )}
          <FormField label="Currency">
            <select className="sel f-inp" value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={submitting}>
              <option>INR</option><option>USD</option><option>CNY</option><option>EUR</option>
            </select>
          </FormField>
          <FormField label="Urgency">
            <select className="sel f-inp" value={urgency} onChange={(e) => setUrgency(e.target.value)} disabled={submitting}>
              <option>Low</option><option>Normal</option><option>High</option><option>Urgent</option>
            </select>
          </FormField>
          <FormField label="Needed by"><input className="f-inp mono" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} disabled={submitting} /></FormField>
          <FormField label="Notes (optional)" full><input className="f-inp" value={notes} onChange={(e) => setNotes(e.target.value)} disabled={submitting} /></FormField>
        </div>
      </Panel>

      <Panel title="Items" pad>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 10 }}>
          Add a row per item. Pick a part code where one exists and the tax rate fills in
          by itself — you never need to enter HSN or GST. Anything without a code is fine:
          procurement confirms the rate for those.
        </div>

        {lines.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl" style={{ width: '100%', minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ minWidth: 210 }}>Item</th>
                  <th style={{ minWidth: 180 }}>Description</th>
                  <th className="num" style={{ width: 90 }}>Qty</th>
                  <th style={{ width: 80 }}>Unit</th>
                  <th className="num" style={{ width: 110 }}>Est. price</th>
                  <th className="num" style={{ width: 90 }}>Tax</th>
                  <th className="num" style={{ width: 110 }}>Line total</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const lineVal = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
                  return (
                    <tr key={i}>
                      <td>
                        {/* portal is REQUIRED inside a table cell — without it the dropdown
                            is clipped by the scroll container (CORE.md, PATTERN-160). */}
                        <Combobox
                          value={l.part_code || ''}
                          options={itemOptions}
                          onChange={(_, opt) => selectPart(i, opt)}
                          placeholder={itemsLoading ? 'Loading parts…' : 'Search part code / name…'}
                          loading={itemsLoading}
                          inputStyle={{ fontFamily: 'var(--mono)' }}
                          commitOnTab
                          portal
                        />
                      </td>
                      <td><input className="f-inp" value={l.description} onChange={(e) => updateLine(i, 'description', e.target.value)} placeholder="What is it?" disabled={submitting} /></td>
                      <td><input className="f-inp mono num" type="number" min="0" step="any" value={l.qty} onChange={(e) => updateLine(i, 'qty', e.target.value)} disabled={submitting} /></td>
                      <td><input className="f-inp" value={l.unit} onChange={(e) => updateLine(i, 'unit', e.target.value)} disabled={submitting} /></td>
                      <td><input className="f-inp mono num" type="number" min="0" step="any" value={l.unit_price} onChange={(e) => updateLine(i, 'unit_price', e.target.value)} placeholder="—" disabled={submitting} /></td>
                      <td className="num mono" style={{ color: 'var(--t3)' }}>
                        {l.gst_percent != null
                          ? `${l.gst_percent}%`
                          : <span title="Procurement will confirm the rate for this item">—</span>}
                      </td>
                      <td className="num mono">{lineVal ? money(lineVal) : '—'}</td>
                      <td>
                        <button type="button" onClick={() => removeLine(i)} disabled={submitting}
                          title="Remove line"
                          style={{ background: 'none', border: 'none', color: 'var(--red-fg)', cursor: 'pointer', padding: 4 }}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <Btn onClick={addLine} disabled={submitting}><Plus size={14} /> Add item</Btn>
          {lines.length > 0 && (
            <div style={{ fontSize: 12, minWidth: 240 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                <span>Subtotal</span><b className="mono">{money(totals.taxable)}</b>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', color: 'var(--t3)' }}>
                <span>Estimated tax</span><b className="mono">{money(totals.tax)}</b>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', marginTop: 4, borderTop: '1px solid var(--line)', fontSize: 14 }}>
                <span><b>Estimated total</b></span><b className="mono">{currency} {money(totals.grand)}</b>
              </div>
              {unpricedLines > 0 && (
                <div style={{ color: 'var(--t3)', marginTop: 6 }}>
                  {unpricedLines} item{unpricedLines === 1 ? '' : 's'} with no price — the total excludes {unpricedLines === 1 ? 'it' : 'them'}.
                </div>
              )}
              <div style={{ color: 'var(--t3)', marginTop: 6 }}>
                An estimate, not a quote. Procurement prices the PO.
              </div>
            </div>
          )}
        </div>

        <div className="form-foot">
          <Btn onClick={() => router.push('/requests')} disabled={submitting}>Cancel</Btn>
          <Btn kind="primary" onClick={submit} disabled={submitting}><Send size={14} /> {submitting ? 'Submitting…' : 'Submit request'}</Btn>
        </div>
      </Panel>
    </div>
  );
}
