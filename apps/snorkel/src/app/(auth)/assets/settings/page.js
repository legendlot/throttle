'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, inputStyle, tableThStyle, tableTdStyle,
  btnPrimary, btnSecondary, pageH1, pageSub, StatusBadge,
} from '@/lib/snorkelui';

function ManagedList({ title, kind, session, showToast }) {
  // kind: 'category' | 'location'
  const getAction    = kind === 'category' ? 'getAssetCategories'   : 'getAssetLocations';
  const createAction = kind === 'category' ? 'createAssetCategory'  : 'createAssetLocation';
  const updateAction = kind === 'category' ? 'updateAssetCategory'  : 'updateAssetLocation';

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const d = await garageFetch(getAction, { all: 1 }, session);
      setRows(Array.isArray(d) ? d : []);
    } catch (e) { showToast(e.message || 'Load failed', 'error'); }
    finally { setLoading(false); }
  }, [session, getAction, showToast]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const res = await workerFetch(createAction, { data: { name: newName.trim(), sort_order: rows.length + 1 } }, session);
      if (!res.ok) throw new Error(res.error || 'Add failed');
      setNewName(''); await load();
    } catch (e) { showToast(e.message || 'Add failed', 'error'); }
    finally { setBusy(false); }
  }
  async function rename(row) {
    const name = window.prompt('Rename:', row.name);
    if (!name || name.trim() === row.name) return;
    try {
      const res = await workerFetch(updateAction, { data: { id: row.id, name: name.trim() } }, session);
      if (!res.ok) throw new Error(res.error || 'Rename failed');
      await load();
    } catch (e) { showToast(e.message || 'Rename failed', 'error'); }
  }
  async function toggle(row) {
    try {
      const res = await workerFetch(updateAction, { data: { id: row.id, is_active: !row.is_active } }, session);
      if (!res.ok) throw new Error(res.error || 'Update failed');
      await load();
    } catch (e) { showToast(e.message || 'Update failed', 'error'); }
  }

  return (
    <div style={panelStyle}>
      <div style={panelHeaderStyle}><span>{title}</span></div>
      <div style={panelBodyStyle}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input style={{ ...inputStyle, flex: 1 }} placeholder={`New ${kind}…`} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} />
          <button style={btnPrimary} onClick={add} disabled={busy || !newName.trim()}>Add</button>
        </div>
        {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spinner /></div> : rows.length === 0 ? (
          <div style={{ color: 'var(--t3)', fontSize: 12 }}>None yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={tableThStyle}>Name</th><th style={tableThStyle}>State</th><th style={{ ...tableThStyle, textAlign: 'right' }}></th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={tableTdStyle}>{r.name}</td>
                  <td style={tableTdStyle}><StatusBadge label={r.is_active ? 'Active' : 'Inactive'} tone={r.is_active ? 'green' : 'gray'} /></td>
                  <td style={{ ...tableTdStyle, textAlign: 'right' }}>
                    <button style={btnSecondary} onClick={() => rename(r)}>Rename</button>
                    <button style={{ ...btnSecondary, marginLeft: 6 }} onClick={() => toggle(r)}>{r.is_active ? 'Deactivate' : 'Activate'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function AssetSettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  if (perms && !perms.asset_manage) {
    return <div style={{ padding: 24, color: 'var(--t3)' }}>Access restricted.</div>;
  }

  return (
    <div style={{ color: 'var(--t1)', maxWidth: 720 }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={pageH1}>Asset Categories &amp; Locations</h1>
        <p style={pageSub}>Manage the picklists used across the asset register. Deactivate instead of deleting to preserve history.</p>
      </div>
      <ManagedList title="Categories" kind="category" session={session} showToast={showToast} />
      <ManagedList title="Locations" kind="location" session={session} showToast={showToast} />
    </div>
  );
}
