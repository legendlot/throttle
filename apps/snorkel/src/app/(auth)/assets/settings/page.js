'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { PageHead, Panel, Badge, Btn } from '@/components/ui.js';

function ManagedList({ title, kind, session, showToast }) {
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
    <Panel title={title} count={rows.length} pad>
      <div className="ml-add">
        <input className="f-inp" placeholder={`New ${kind}…`} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} />
        <Btn kind="primary" onClick={add} disabled={busy || !newName.trim()}>Add</Btn>
      </div>
      {loading ? <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spinner /></div>
        : rows.length === 0 ? <div className="dim" style={{ fontSize: 12 }}>None yet.</div>
        : (
          <table className="dt">
            <thead><tr><th>Name</th><th>State</th><th className="num">Actions</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ opacity: r.is_active ? 1 : 0.55 }}>
                  <td>{r.name}</td>
                  <td><Badge label={r.is_active ? 'Active' : 'Inactive'} tone={r.is_active ? 'green' : 'gray'} dot /></td>
                  <td className="num"><span className="act-grp"><Btn onClick={() => rename(r)}>Rename</Btn><Btn onClick={() => toggle(r)}>{r.is_active ? 'Deactivate' : 'Activate'}</Btn></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Panel>
  );
}

export default function AssetSettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();

  if (perms && !perms.asset_manage) {
    return <div style={{ padding: 24, color: 'var(--text-3)' }}>Access restricted.</div>;
  }

  return (
    <div className="pg" style={{ maxWidth: 760 }}>
      <PageHead title="Categories & Locations" sub="Manage the picklists used across the asset register. Deactivate instead of deleting to preserve history." />
      <ManagedList title="Categories" kind="category" session={session} showToast={showToast} />
      <ManagedList title="Locations" kind="location" session={session} showToast={showToast} />
    </div>
  );
}
