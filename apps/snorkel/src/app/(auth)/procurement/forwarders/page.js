'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';

const PO_SOURCES = ['China', 'India', 'USA', 'Germany', 'Taiwan', 'Vietnam', 'Bangladesh', 'Japan', 'South Korea', 'UK', 'Italy', 'Turkey', 'Other'];

const TONE_STYLES = {
  yellow: { bg: 'rgba(242,205,26,.12)', fg: '#f2cd1a', border: 'rgba(242,205,26,.2)' },
  green:  { bg: 'rgba(34,197,94,.12)',  fg: '#4ade80', border: 'rgba(34,197,94,.2)' },
  red:    { bg: 'rgba(222,42,42,.15)',  fg: '#ff7070', border: 'rgba(222,42,42,.25)' },
  blue:   { bg: 'rgba(33,60,226,.2)',   fg: '#7b93ff', border: 'rgba(33,60,226,.3)' },
  gray:   { bg: 'rgba(80,80,80,.2)',    fg: '#aaa',    border: 'rgba(80,80,80,.3)' },
};

function StatusBadge({ label, tone = 'gray' }) {
  const s = TONE_STYLES[tone] || TONE_STYLES.gray;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 6px', borderRadius: 2,
      fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '.04em',
      textTransform: 'uppercase',
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
    }}>{label}</span>
  );
}

const MODE_TONE = { Sea: 'blue', Air: 'yellow', Land: 'green' };
const MODE_COLOR = { Sea: '#7b93ff', Air: '#f2cd1a', Land: '#4ade80' };

const panelStyle       = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, marginBottom: 16 };
const panelHeaderStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--t2)' };
const panelBodyStyle   = { padding: '14px 16px' };
const tableThStyle     = { padding: '8px 10px', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', textAlign: 'left' };
const tableTdStyle     = { padding: '9px 10px', borderBottom: '1px solid rgba(42,42,42,.6)', fontSize: 12, whiteSpace: 'nowrap' };
const inputStyle       = { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px', fontSize: 12, color: 'var(--t1)', outline: 'none', fontFamily: 'inherit' };
const selectStyle      = { ...inputStyle, cursor: 'pointer' };
const labelStyle       = { fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, display: 'block' };
const btnPrimary       = { background: 'var(--yellow)', border: '1px solid var(--yellow)', borderRadius: 3, padding: '7px 16px', fontSize: 12, fontWeight: 700, color: '#000', cursor: 'pointer', fontFamily: 'var(--cond)', letterSpacing: '0.04em' };
const btnSecondary     = { background: 'transparent', border: '1px solid var(--border)', borderRadius: 3, padding: '6px 12px', fontSize: 11, color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--cond)' };

function modeCardStyle(active, mode) {
  const color = MODE_COLOR[mode] || 'var(--border)';
  return {
    background: active ? `${color}15` : 'var(--surface2)',
    border: `1px solid ${active ? color : 'var(--border)'}`,
    borderRadius: 4,
    padding: 14,
  };
}

export default function ForwardersPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  const [view, setView] = useState('list');
  const [forwarders, setForwarders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingCode, setEditingCode] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // form fields
  const [name, setName] = useState('');
  const [country, setCountry] = useState('India');
  const [location, setLocation] = useState('');
  const [trackingUrl, setTrackingUrl] = useState('');
  const [iata, setIata] = useState('');
  const [scac, setScac] = useState('');
  const [seaCheck, setSeaCheck] = useState(false);
  const [airCheck, setAirCheck] = useState(false);
  const [landCheck, setLandCheck] = useState(false);
  const [seaDays, setSeaDays] = useState('');
  const [airDays, setAirDays] = useState('');
  const [landDays, setLandDays] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [notes, setNotes] = useState('');

  const loadList = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const data = await garageFetch('getForwarders', {}, session);
      setForwarders(Array.isArray(data) ? data : []);
    } catch (e) {
      showToast(e.message || 'Failed to load forwarders', 'error');
    } finally {
      setLoading(false);
    }
  }, [session, showToast]);

  useEffect(() => {
    if (view === 'list') loadList();
  }, [view, loadList]);

  function resetForm() {
    setName(''); setCountry('India'); setLocation(''); setTrackingUrl('');
    setIata(''); setScac('');
    setSeaCheck(false); setAirCheck(false); setLandCheck(false);
    setSeaDays(''); setAirDays(''); setLandDays('');
    setContactName(''); setContactPhone(''); setContactEmail(''); setNotes('');
  }

  function startCreate() {
    resetForm();
    setEditingCode(null);
    setView('form');
  }

  async function startEdit(code) {
    setEditingCode(code);
    setView('form');
    try {
      const f = await garageFetch('getForwarder', { forwarder_code: code }, session);
      const fwd = f?.forwarder || f || {};
      setName(fwd.company_name || '');
      setCountry(fwd.country || 'India');
      setLocation(fwd.location || '');
      setTrackingUrl(fwd.tracking_url || '');
      setIata(fwd.iata_code || '');
      setScac(fwd.scac_code || '');
      const modes = Array.isArray(fwd.modes_supported) ? fwd.modes_supported : [];
      setSeaCheck(modes.includes('Sea'));
      setAirCheck(modes.includes('Air'));
      setLandCheck(modes.includes('Land'));
      setSeaDays(fwd.sea_days != null ? String(fwd.sea_days) : '');
      setAirDays(fwd.air_days != null ? String(fwd.air_days) : '');
      setLandDays(fwd.land_days != null ? String(fwd.land_days) : '');
      setContactName(fwd.contact_name || '');
      setContactPhone(fwd.contact_phone || '');
      setContactEmail(fwd.contact_email || '');
      setNotes(fwd.notes || '');
    } catch (e) {
      showToast(e.message || 'Failed to load forwarder', 'error');
    }
  }

  async function handleSave() {
    if (!name.trim()) { showToast('Company name required', 'error'); return; }
    const modes = [];
    if (seaCheck)  modes.push('Sea');
    if (airCheck)  modes.push('Air');
    if (landCheck) modes.push('Land');
    setSubmitting(true);
    try {
      const data = {
        company_name: name.trim(),
        country,
        location: location || null,
        modes_supported: modes,
        sea_days: seaDays ? parseInt(seaDays, 10) : null,
        air_days: airDays ? parseInt(airDays, 10) : null,
        land_days: landDays ? parseInt(landDays, 10) : null,
        iata_code: iata || null,
        scac_code: scac || null,
        tracking_url: trackingUrl || null,
        contact_name: contactName || null,
        contact_phone: contactPhone || null,
        contact_email: contactEmail || null,
        notes: notes || null,
      };
      const action = editingCode ? 'updateForwarder' : 'postForwarder';
      const payload = editingCode ? { forwarder_code: editingCode, ...data } : data;
      const res = await workerFetch(action, { data: payload }, session);
      const result = res.data || res;
      showToast(editingCode ? `${editingCode} updated` : `${result.forwarder_code} created`, 'success');
      setView('list');
      resetForm();
      setEditingCode(null);
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (perms && !perms.procurement_view) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  if (view === 'list') {
    return (
      <div style={{ color: 'var(--t1)' }}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
              Forwarders
            </h1>
            <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
              Freight forwarder master — drives expected-arrival calc on POs.
            </p>
          </div>
          {perms?.vendor_manage && (
            <button style={btnPrimary} onClick={startCreate}>+ New Forwarder</button>
          )}
        </div>

        <div style={panelStyle}>
          <div style={panelHeaderStyle}>
            <span>All Forwarders {forwarders.length > 0 && <span style={{ color: 'var(--t3)', marginLeft: 6, fontSize: 11 }}>({forwarders.length})</span>}</span>
            <button style={btnSecondary} onClick={loadList} disabled={loading}>↻ Refresh</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            {loading ? (
              <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
            ) : forwarders.length === 0 ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>No forwarders yet</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={tableThStyle}>Code</th>
                  <th style={tableThStyle}>Company</th>
                  <th style={tableThStyle}>Country</th>
                  <th style={tableThStyle}>Modes</th>
                  <th style={tableThStyle}>Sea</th>
                  <th style={tableThStyle}>Air</th>
                  <th style={tableThStyle}>Land</th>
                  <th style={tableThStyle}>IATA</th>
                  <th style={tableThStyle}>SCAC</th>
                  <th style={tableThStyle}>Contact</th>
                  <th style={tableThStyle}>Status</th>
                  <th style={{ ...tableThStyle, textAlign: 'right' }}></th>
                </tr></thead>
                <tbody>
                  {forwarders.map((f) => {
                    const modes = Array.isArray(f.modes_supported) ? f.modes_supported : [];
                    return (
                      <tr key={f.forwarder_code}>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>{f.forwarder_code}</td>
                        <td style={tableTdStyle}>{f.company_name}</td>
                        <td style={tableTdStyle}>{f.country || '—'}</td>
                        <td style={tableTdStyle}>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {modes.map((m) => <StatusBadge key={m} label={m} tone={MODE_TONE[m] || 'gray'} />)}
                          </div>
                        </td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: MODE_COLOR.Sea }}>{f.sea_days != null ? `${f.sea_days}d` : '—'}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: MODE_COLOR.Air }}>{f.air_days != null ? `${f.air_days}d` : '—'}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)', color: MODE_COLOR.Land }}>{f.land_days != null ? `${f.land_days}d` : '—'}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{f.iata_code || '—'}</td>
                        <td style={{ ...tableTdStyle, fontFamily: 'var(--mono)' }}>{f.scac_code || '—'}</td>
                        <td style={tableTdStyle}>{f.contact_name || '—'}</td>
                        <td style={tableTdStyle}><StatusBadge label={f.active ? 'Active' : 'Inactive'} tone={f.active ? 'green' : 'red'} /></td>
                        <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                          {perms?.vendor_manage && (
                            <button style={btnSecondary} onClick={() => startEdit(f.forwarder_code)}>Edit</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    );
  }

  // form view
  return (
    <div style={{ color: 'var(--t1)' }}>
      <div style={{ marginBottom: 12 }}>
        <button style={btnSecondary} onClick={() => { setView('list'); resetForm(); setEditingCode(null); }}>← Back to list</button>
      </div>
      <h2 style={{ fontFamily: 'var(--cond)', fontSize: 18, textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 12px' }}>
        {editingCode ? `Edit Forwarder — ${editingCode}` : 'New Forwarder'}
      </h2>

      <div style={{ ...panelStyle, maxWidth: 900 }}>
        <div style={panelHeaderStyle}><span>Forwarder Details</span></div>
        <div style={panelBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Company Name *" value={name} onChange={setName} disabled={submitting} />
            <SelectField label="Country" value={country} onChange={setCountry} options={PO_SOURCES} disabled={submitting} />
            <Field label="Location" value={location} onChange={setLocation} disabled={submitting} />
            <Field label="Tracking Portal URL" value={trackingUrl} onChange={setTrackingUrl} disabled={submitting} />
            <Field label="IATA Code" value={iata} onChange={setIata} disabled={submitting} />
            <Field label="SCAC Code" value={scac} onChange={setScac} disabled={submitting} />
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={labelStyle}>Shipping Modes &amp; Transit Times</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginTop: 6 }}>
              <ModeCard
                mode="Sea"
                icon="🚢"
                checked={seaCheck} onCheck={setSeaCheck}
                days={seaDays} onDays={setSeaDays}
                disabled={submitting}
              />
              <ModeCard
                mode="Air"
                icon="✈"
                checked={airCheck} onCheck={setAirCheck}
                days={airDays} onDays={setAirDays}
                disabled={submitting}
              />
              <ModeCard
                mode="Land"
                icon="🚛"
                checked={landCheck} onCheck={setLandCheck}
                days={landDays} onDays={setLandDays}
                disabled={submitting}
              />
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <div style={labelStyle}>Contact</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginTop: 6 }}>
              <Field label="Contact Name" value={contactName} onChange={setContactName} disabled={submitting} />
              <Field label="Contact Phone" value={contactPhone} onChange={setContactPhone} disabled={submitting} />
              <Field label="Contact Email" value={contactEmail} onChange={setContactEmail} disabled={submitting} />
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <span style={labelStyle}>Notes</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} disabled={submitting} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 12 }}>
            <button style={btnSecondary} onClick={() => { setView('list'); resetForm(); setEditingCode(null); }} disabled={submitting}>Cancel</button>
            <button
              style={{ ...btnPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
              onClick={handleSave}
              disabled={submitting}
            >
              {submitting ? 'Saving…' : 'Save Forwarder'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModeCard({ mode, icon, checked, onCheck, days, onDays, disabled }) {
  return (
    <div style={modeCardStyle(checked, mode)}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 8 }}>
        <input type="checkbox" checked={checked} onChange={(e) => onCheck(e.target.checked)} disabled={disabled} />
        <span style={{ fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13, color: MODE_COLOR[mode] }}>
          {icon} {mode.toUpperCase()}
        </span>
      </label>
      <span style={labelStyle}>Default Transit Days</span>
      <input
        type="number"
        min="0"
        value={days}
        onChange={(e) => onDays(e.target.value)}
        disabled={disabled || !checked}
        style={{ ...inputStyle, width: '100%', fontFamily: 'var(--mono)', opacity: checked ? 1 : 0.5 }}
        placeholder="0"
      />
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', disabled }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} style={{ ...inputStyle, width: '100%' }} disabled={disabled} />
    </div>
  );
}

function SelectField({ label, value, onChange, options, disabled }) {
  return (
    <div>
      <span style={labelStyle}>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ ...selectStyle, width: '100%' }} disabled={disabled}>
        {options.map((o) => (
          <option key={o} value={o}>{o || '—'}</option>
        ))}
      </select>
    </div>
  );
}
