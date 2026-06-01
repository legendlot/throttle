'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { Lock, ShieldCheck, ExternalLink } from 'lucide-react';
import { podiumopsGet, podiumopsPost } from '../../../../lib/podiumopsFetch.js';

export default function SettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (session) podiumopsGet('getSettings', {}, session).then(setS).catch(() => setS(false)); }, [session]);

  if (perms && !perms.podium_admin) return <div style={{ color: 'var(--text-3)' }}>Requires podium_admin.</div>;
  if (s === false) return <div style={{ color: 'var(--text-3)' }}>Could not load settings.</div>;
  if (!s) return <Spinner />;

  async function save(patch) {
    setBusy(true);
    try { const r = await podiumopsPost('updateSettings', patch, session); setS(r); showToast('Saved', 'success'); }
    catch (e) { showToast(e.message || 'Failed', 'error'); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 16 }}>Settings</h1>

      <div style={card}>
        <div style={cardTitle}><Lock size={14} /> Salary Vault</div>
        <p style={p}>
          When OFF (default for v1), Podium records increment % and one-time bonus amounts only — absolute
          base-salary / CTC figures are never stored. Turn this ON <strong>only after</strong> the Phase&nbsp;5
          security hardening (Cloudflare Access SSO in front of the site and worker) is live.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
          <input type="checkbox" checked={!!s.comp_vault_enabled} disabled={busy} onChange={e => save({ comp_vault_enabled: e.target.checked })} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>{s.comp_vault_enabled ? 'Enabled — absolute CTC allowed' : 'Disabled — % and bonuses only'}</span>
        </label>
      </div>

      <div style={{ ...card, marginTop: 14 }}>
        <div style={cardTitle}><ShieldCheck size={14} /> Appraisal Eligibility</div>
        <p style={p}>Minimum tenure (days, as of cycle end) before someone is eligible for an appraisal.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input type="number" defaultValue={s.min_tenure_days} disabled={busy}
            onBlur={e => { const v = Math.round(Number(e.target.value)); if (v !== s.min_tenure_days) save({ min_tenure_days: v }); }}
            style={{ width: 110, background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px 10px', fontFamily: 'var(--font-mono)', fontSize: 13 }} />
          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>days</span>
        </div>
      </div>

      <div style={{ ...card, marginTop: 14 }}>
        <div style={cardTitle}>Permissions</div>
        <p style={p}>
          Podium permissions (<code>podium_admin</code>, <code>podium_hr</code>, <code>podium_comp</code>,
          <code> podium_view</code>) are managed centrally with all LOT roles in Garage.
        </p>
        <a href="https://garage.legendoftoys.com/users" target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--podium-green)', fontSize: 13, marginTop: 4 }}>
          Open Garage → Users <ExternalLink size={13} />
        </a>
      </div>
    </div>
  );
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px 18px' };
const cardTitle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-1)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 8 };
const p = { fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 };
