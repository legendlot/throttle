'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Lock, ShieldCheck, ExternalLink, Building2, ClipboardCheck } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';
import { LEGAL_ENTITIES } from '../../../../lib/format.js';

export default function SettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (session) podiumopsGet('getSettings', {}, session).then(setS).catch(() => setS(false)); }, [session]);

  if (perms && !perms.podium_admin) return <div style={{ color: 'var(--t3)' }}>Requires podium_admin.</div>;
  if (s === false) return <div style={{ color: 'var(--t3)' }}>Could not load settings.</div>;
  if (!s) return <Spinner />;

  async function save(patch) {
    setBusy(true);
    try { const r = await podiumopsPost('updateSettings', patch, session); setS(r); showToast('Saved', 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Organisation (read-only — these are fixed in the data model, not editable settings) */}
      <div style={card}>
        <div style={cardTitle}><Building2 size={14} /> Organisation</div>
        <Row label="Legal entities" value={LEGAL_ENTITIES.join(' · ')} />
        <Row label="Fiscal year start" value="1 April" last />
      </div>

      {/* Salary Vault (persisted) */}
      <div style={card}>
        <div style={cardTitle}><Lock size={14} /> Salary Vault</div>
        <p style={p}>
          When OFF (default for v1), Podium records increment % and one-time bonus amounts only — absolute
          base-salary / CTC figures are never stored. Turn this ON <strong>only after</strong> the Phase&nbsp;5
          security hardening (Cloudflare Access SSO in front of the site and worker) is live.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <input type="checkbox" checked={!!s.comp_vault_enabled} disabled={busy} onChange={e => save({ comp_vault_enabled: e.target.checked })} />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--t1)' }}>{s.comp_vault_enabled ? 'Enabled — absolute CTC allowed' : 'Disabled — % and bonuses only'}</span>
        </label>
      </div>

      {/* Appraisals (eligibility persisted; anchors are fixed) */}
      <div style={card}>
        <div style={cardTitle}><ClipboardCheck size={14} /> Appraisals</div>
        <Row label="Cycle anchors" value="Apr 1 · Oct 1" sub="6-month windows" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontSize: 13.5, color: 'var(--t1)' }}>Eligibility cutoff</div>
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>Minimum tenure (days, as of cycle end) before eligible.</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="number" defaultValue={s.min_tenure_days} disabled={busy}
              onBlur={e => { const v = Math.round(Number(e.target.value)); if (v !== s.min_tenure_days) save({ min_tenure_days: v }); }}
              className="pd-input"
              style={{ width: 100, background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 10px', fontFamily: 'var(--font-num)', fontSize: 13, outline: 'none' }} />
            <span style={{ color: 'var(--t3)', fontSize: 12 }}>days</span>
          </div>
        </div>
      </div>

      {/* Permissions (links) */}
      <div style={card}>
        <div style={cardTitle}><ShieldCheck size={14} /> Permissions</div>
        <p style={p}>
          Podium runs its <strong>own</strong> permission layer (<code className="num">podium_view</code>, <code className="num">podium_hr</code>,
          <code className="num"> podium_comp</code>, <code className="num">podium_admin</code>) — managed here in Podium, not in Garage. Define
          custom roles on <strong>Permissions</strong>, then assign them to people on <strong>Users</strong>.
          Anyone with no assigned role gets self-only access.
        </p>
        <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
          <a href="/admin/roles" style={link}>Permissions <ExternalLink size={13} /></a>
          <a href="/admin/users" style={link}>Users <ExternalLink size={13} /></a>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, sub, last }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <div>
        <div style={{ fontSize: 13.5, color: 'var(--t1)' }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--t3)' }}>{sub}</div>}
      </div>
      <span className="num" style={{ fontSize: 12.5, color: 'var(--t2)' }}>{value}</span>
    </div>
  );
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px' };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-display)', fontSize: 11, color: 'var(--t2)', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 12 };
const p = { fontSize: 13, color: 'var(--t2)', lineHeight: 1.6 };
const link = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--yellow)', fontSize: 13 };
