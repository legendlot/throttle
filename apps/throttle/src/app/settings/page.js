'use client';
/* Settings — Team · Workflow (ageing) · Request types · Notifications.
   Team roster + ageing thresholds are live (brand.users + getAgeingConfig);
   type visibility + notification toggles are local state (as in the
   prototype). Ported from settings.jsx; seed fallback. */
import React, { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { AppShell } from '@/components/throttle/AppShell';
import { Icon } from '@/components/throttle/Icon';
import { Card, Pill, Avatar } from '@/components/throttle/ui';
import { TEAM, REQ_TYPES, initialsOf } from '@/lib/throttleData';
import { fetchUsers, fetchAgeingConfig } from '@/lib/throttleApi';

const AGEING_SEED = [
  { stage: 'In Progress', warn: 48, crit: 96 },
  { stage: 'In Review',   warn: 24, crit: 48 },
  { stage: 'Ext. Blocked',warn: 24, crit: 72 },
  { stage: 'Approved',    warn: 24, crit: 48 },
  { stage: 'Delivered',   warn: 48, crit: 120 },
];
const STAGE_LABEL = { in_progress: 'In Progress', in_review: 'In Review', ext_blocked: 'Ext. Blocked', approved: 'Approved', delivered: 'Delivered' };
const ROLE_TONE = { admin: 'bad', lead: 'brand', member: 'info', requester: 'ok' };

function Toggle({ on, onClick }) {
  return (
    <button onClick={onClick} style={{ width: 38, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer', padding: 2,
      background: on ? 'var(--yellow)' : 'var(--surface-3)', transition: 'background .15s', position: 'relative', flexShrink: 0 }}>
      <span style={{ display: 'block', width: 18, height: 18, borderRadius: '50%', background: on ? '#15140b' : 'var(--t3)',
        transform: on ? 'translateX(16px)' : 'translateX(0)', transition: 'transform .15s' }} />
    </button>
  );
}

function SettingsScreen() {
  const { session } = useAuth();
  const TABS = [{ v: 'team', label: 'Team' }, { v: 'workflow', label: 'Workflow' }, { v: 'types', label: 'Request Types' }, { v: 'notify', label: 'Notifications' }];
  const [tab, setTab] = useState('team');
  const [team, setTeam] = useState(TEAM);
  const [ageing, setAgeing] = useState(AGEING_SEED);
  const [visible, setVisible] = useState(Object.fromEntries(Object.keys(REQ_TYPES).map(k => [k, k !== 'brand_initiative'])));
  const [notify, setNotify] = useState({ reviews: true, blocked: true, delivered: false, daily: true });

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const usersRes = await fetchUsers(session);
      if (!cancelled && usersRes?.list?.length) {
        const order = { admin: 0, lead: 1, member: 2, requester: 3 };
        setTeam(usersRes.list.slice().sort((a, b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name)));
      }
      const cfg = await fetchAgeingConfig(session);
      if (!cancelled && cfg?.length) {
        const rows = cfg.filter(c => STAGE_LABEL[c.stage]).map(c => ({ stage: STAGE_LABEL[c.stage], warn: c.warning_hours ?? '—', crit: c.critical_hours ?? '—' }));
        if (rows.length) setAgeing(rows);
      }
    })();
    return () => { cancelled = true; };
  }, [session]);

  const inputStyle = { width: 64, background: 'var(--bg-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
    color: 'var(--t1)', fontFamily: 'var(--font-mono)', fontSize: 13, padding: '6px 8px', textAlign: 'center' };

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div>
        <span className="eyebrow" style={{ padding: 0 }}>Admin</span>
        <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '0.01em', color: 'var(--t1)', margin: '7px 0 0' }}>Settings</h1>
      </div>

      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)' }}>
        {TABS.map(t => (
          <button key={t.v} onClick={() => setTab(t.v)} style={{ padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer',
            fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: tab === t.v ? 'var(--t1)' : 'var(--t3)', borderBottom: `2px solid ${tab === t.v ? 'var(--yellow)' : 'transparent'}`, marginBottom: -1 }}>
            {t.label}</button>
        ))}
      </div>

      {tab === 'team' && (
        <Card pad={0}>
          {team.map((u, i) => (
            <div key={u.id} className="t-row" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <Avatar id={typeof u.id === 'string' && u.id.startsWith('u') ? u.id : undefined} name={u.name} initial={u.initial || initialsOf(u.name)} size={32} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, color: 'var(--t1)', fontWeight: 600 }}>{u.name}</div>
                <div className="num" style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 1 }}>{u.email || u.name.toLowerCase().replace(/\s+/g, '.') + '@legendoftoys.com'}</div>
              </div>
              <span style={{ fontSize: 12, color: 'var(--t3)', width: 120 }}>{u.discipline || '—'}</span>
              <Pill tone={ROLE_TONE[u.role] || 'info'}>{u.role}</Pill>
              <button className="t-iconbtn" style={{ width: 30, height: 30 }}><Icon name="dots" size={15} /></button>
            </div>
          ))}
          <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)' }}>
            <button className="t-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', borderRadius: 'var(--r-sm)',
              background: 'transparent', border: '1px dashed var(--border-2)', color: 'var(--t3)', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 13 }}>
              <Icon name="plus" size={15} />Invite teammate</button>
          </div>
        </Card>
      )}

      {tab === 'workflow' && (
        <Card pad={0}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <span className="t-h3">Ageing thresholds</span>
            <p style={{ fontSize: 12.5, color: 'var(--t3)', margin: '5px 0 0' }}>Hours before a task in each stage turns amber, then red.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0', padding: '4px 18px 14px' }}>
            <div className="eyebrow" style={{ padding: '12px 0 8px' }}>Stage</div>
            <div className="eyebrow" style={{ padding: '12px 18px 8px', textAlign: 'center' }}>Warn (h)</div>
            <div className="eyebrow" style={{ padding: '12px 0 8px', textAlign: 'center' }}>Critical (h)</div>
            {ageing.map((a) => (
              <React.Fragment key={a.stage}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 0', borderTop: '1px solid var(--border)', fontSize: 13.5, color: 'var(--t1)' }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--warn-fg)' }} />{a.stage}</div>
                <div style={{ display: 'grid', placeItems: 'center', padding: '10px 18px', borderTop: '1px solid var(--border)' }}><input defaultValue={a.warn} style={inputStyle} /></div>
                <div style={{ display: 'grid', placeItems: 'center', padding: '10px 0', borderTop: '1px solid var(--border)' }}><input defaultValue={a.crit} style={inputStyle} /></div>
              </React.Fragment>
            ))}
          </div>
        </Card>
      )}

      {tab === 'types' && (
        <Card pad={0}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <span className="t-h3">Request types</span>
            <p style={{ fontSize: 12.5, color: 'var(--t3)', margin: '5px 0 0' }}>Which intake types are open to requesters.</p>
          </div>
          {Object.entries(REQ_TYPES).map(([k, t], i) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '12px 18px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <span style={{ width: 32, height: 32, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)', border: '1px solid var(--border-2)',
                display: 'grid', placeItems: 'center', color: visible[k] ? 'var(--yellow)' : 'var(--t4)' }}><Icon name={t.icon} size={16} /></span>
              <span style={{ flex: 1, fontSize: 14, color: visible[k] ? 'var(--t1)' : 'var(--t4)', fontWeight: 500 }}>{t.label}</span>
              {k === 'brand_initiative' && <span style={{ fontSize: 11, color: 'var(--t4)' }}>brand team only</span>}
              <Toggle on={visible[k]} onClick={() => setVisible(v => ({ ...v, [k]: !v[k] }))} />
            </div>
          ))}
        </Card>
      )}

      {tab === 'notify' && (
        <Card pad={0}>
          {[['reviews', 'Work submitted for my review', 'When a designer moves a task to In Review'],
            ['blocked', 'Tasks blocked over threshold', 'When something sits in Ext. Blocked too long'],
            ['delivered', 'Delivered, awaiting feedback', 'When a requester hasn’t closed the loop'],
            ['daily', 'Daily sprint digest', 'A morning summary of the active sprint']].map(([k, label, sub], i) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', borderTop: i ? '1px solid var(--border)' : 'none' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, color: 'var(--t1)', fontWeight: 500 }}>{label}</div>
                <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>
              </div>
              <Toggle on={notify[k]} onClick={() => setNotify(n => ({ ...n, [k]: !n[k] }))} />
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

export default function SettingsPage() {
  return <AppShell route="settings"><SettingsScreen /></AppShell>;
}
