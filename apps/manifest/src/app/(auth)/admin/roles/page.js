'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { useToast } from '@throttle/ui';
import {
  panelStyle, panelHeaderStyle, panelBodyStyle, pageH1, pageSub, btnPrimary, btnSecondary, inputStyle, labelStyle, selectStyle, StatusBadge, titleCase,
} from '../../../../lib/manifestui.js';

const LOT_KEYS = ['manifest_view','order_manage','shipment_manage','charge_manage','payment_record','drawdown_manage','fx_manage','cost_view','doc_manage','china_po_sync','manifest_admin'];
const SF_KEYS  = ['manifest_view','sf_order_update','sf_evidence_upload','sf_drawdown_raise','sf_vendor_payment_record','sf_running_account_view'];

export default function RolesPage() {
  const { session } = useAuth();
  const toast = useToast();
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newRole, setNewRole] = useState({ role_key: '', label: '', party: 'LOT' });

  async function load() { const d = await garageFetch('getRoles', {}, session); setRoles(d || []); setLoading(false); }
  useEffect(() => { if (session) load(); }, [session]);

  async function toggle(role, key) {
    const perms = { ...(role.permissions || {}) };
    perms[key] = !perms[key];
    const r = await workerFetch('saveRole', { data: { role_key: role.role_key, label: role.label, description: role.description, party: role.party, permissions: perms } }, session);
    if (r.ok) load(); else toast.error(r.error);
  }
  async function create() {
    if (!newRole.role_key) { toast.error('role_key required'); return; }
    const r = await workerFetch('saveRole', { data: { ...newRole, permissions: { manifest_view: true } } }, session);
    if (r.ok) { toast.success('Role created'); setNewRole({ role_key: '', label: '', party: 'LOT' }); load(); } else toast.error(r.error);
  }

  return (
    <div>
      <div style={{ marginBottom: 16 }}><h1 style={pageH1}>Roles & Permissions</h1><div style={pageSub}>Manifest permission layer · LOT vs SF party (SF roles never get cost_view)</div></div>

      <div style={panelStyle}>
        <div style={panelHeaderStyle}><span>New role</span></div>
        <div style={{ ...panelBodyStyle, display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
          <div><label style={labelStyle}>Key</label><input style={inputStyle} value={newRole.role_key} onChange={e => setNewRole(s => ({ ...s, role_key: e.target.value.replace(/[^a-z0-9_]/g, '') }))} placeholder="sf_logistics" /></div>
          <div><label style={labelStyle}>Label</label><input style={inputStyle} value={newRole.label} onChange={e => setNewRole(s => ({ ...s, label: e.target.value }))} /></div>
          <div><label style={labelStyle}>Party</label><select style={selectStyle} value={newRole.party} onChange={e => setNewRole(s => ({ ...s, party: e.target.value }))}><option value="LOT">LOT</option><option value="SF">SF</option></select></div>
          <button style={btnPrimary} onClick={create}>Create</button>
        </div>
      </div>

      {loading && <div style={{ color: 'var(--t3)' }}>Loading…</div>}
      {roles.map(role => {
        const keys = role.party === 'SF' ? SF_KEYS : LOT_KEYS;
        return (
          <div key={role.role_key} style={panelStyle}>
            <div style={panelHeaderStyle}>
              <span>{role.label} <span style={{ color: 'var(--t3)', fontWeight: 400 }}>· {role.role_key}</span></span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <StatusBadge label={role.party} tone={role.party === 'SF' ? 'blue' : 'yellow'} />
                {role.is_system && <StatusBadge label="system" tone="gray" />}
              </span>
            </div>
            <div style={{ ...panelBodyStyle, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {keys.map(k => {
                const on = !!role.permissions?.[k];
                return (
                  <button key={k} onClick={() => !role.is_system && toggle(role, k)} disabled={role.is_system}
                    style={{
                      padding: '5px 10px', borderRadius: 3, fontSize: 11, fontFamily: 'var(--mono)', cursor: role.is_system ? 'not-allowed' : 'pointer',
                      background: on ? 'rgba(34,197,94,.15)' : 'var(--surface2)', color: on ? '#4ade80' : 'var(--t3)',
                      border: `1px solid ${on ? 'rgba(34,197,94,.3)' : 'var(--border)'}`,
                    }}>{on ? '✓ ' : ''}{k}</button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
