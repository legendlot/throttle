'use client';
import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch, workerFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { Check } from 'lucide-react';
import { PageHead, Panel, Btn } from '@/components/ui.js';

const FIELDS = [
  { key: 'approval_required_marketing', label: 'Require approval for marketing sends', type: 'toggle',
    hint: 'When on, marketing campaigns above the audience threshold need an approver.' },
  { key: 'approval_audience_threshold', label: 'Approval audience threshold', type: 'number',
    hint: 'Marketing sends to more than this many contacts require approval.' },
  { key: 'frequency_cap_per_day', label: 'Frequency cap (messages / day)', type: 'number',
    hint: 'Max messages a single contact can receive within the window.' },
  { key: 'frequency_cap_window_hours', label: 'Frequency cap window (hours)', type: 'number',
    hint: 'Rolling window the per-day cap is measured over.' },
  { key: 'quiet_hours_start', label: 'Quiet hours start (HH:MM)', type: 'text',
    hint: 'No sends after this local time.' },
  { key: 'quiet_hours_end', label: 'Quiet hours end (HH:MM)', type: 'text',
    hint: 'Sends resume from this local time.' },
  { key: 'attribution_window_days', label: 'Attribution window (days)', type: 'number',
    hint: 'Conversions within this window after a send are attributed to it.' },
];

export default function SettingsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const s = await garageFetch('getRelaySettings', {}, session);
      setForm(s || {});
    } catch (e) { showToast(e.message || 'Failed to load settings', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function save() {
    setSaving(true);
    try {
      const payload = {};
      FIELDS.forEach((f) => {
        const v = form[f.key];
        if (f.type === 'number') payload[f.key] = v === '' || v == null ? null : Number(v);
        else if (f.type === 'toggle') payload[f.key] = !!v;
        else payload[f.key] = v ?? null;
      });
      await workerFetch('saveRelaySettings', payload, session);
      showToast('Settings saved', 'success');
      load();
    } catch (e) { showToast(e.message || 'Save failed', 'error'); }
    finally { setSaving(false); }
  }

  if (perms && !perms.relay_super_admin) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Super-admin only.</div>;

  return (
    <div className="pg">
      <PageHead title="Approval & Caps" sub="Global guardrails for sends — approval thresholds, frequency caps, quiet hours, attribution." />
      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : (
          <Panel title="Send governance" pad>
            <div className="perm-list">
              {FIELDS.map((f) => (
                <div className="perm-row" key={f.key}>
                  <div className="perm-l"><span className="perm-lbl">{f.label}</span><span className="perm-key">{f.hint}</span></div>
                  {f.type === 'toggle' ? (
                    <button className={`tgl ${form[f.key] ? 'on' : ''}`} onClick={() => set(f.key, !form[f.key])} disabled={saving}>
                      <span className="tgl-knob" /><span className="tgl-txt">{form[f.key] ? 'ON' : 'OFF'}</span>
                    </button>
                  ) : (
                    <input
                      className={`f-inp ${f.type === 'number' ? 'mono' : ''}`}
                      style={{ width: 160 }}
                      type={f.type === 'number' ? 'number' : 'text'}
                      value={form[f.key] ?? ''}
                      onChange={(e) => set(f.key, e.target.value)}
                      disabled={saving}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className="form-foot">
              <Btn kind="primary" onClick={save} disabled={saving}><Check size={14} /> {saving ? 'Saving…' : 'Save settings'}</Btn>
            </div>
          </Panel>
        )}
    </div>
  );
}
