'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast, useListNav } from '@throttle/ui';
import { Modal } from '../../../components/ui/Modal.js';
import { Card, ProgressBar, budgetTone, Typeahead } from '../../../components/ui/index.js';
import { matchRows } from '../../../lib/typeahead.js';

const campaignFields = c => [c.name, c.campaign_no, c.status];
import { Plus, Trash2 } from 'lucide-react';
import { ignitionopsGet, ignitionopsPost } from '../../../lib/ignitionopsFetch.js';

function inr(n) { return n == null || isNaN(n) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`; }

export default function CampaignsPage() {
  const { session, perms } = useAuth();
  const { showToast: toast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [q, setQ] = useState('');
  const canManage = !!perms?.ignition_manage;
  const shown = matchRows(rows, q, campaignFields);
  const { focusedIdx, setFocusedIdx } = useListNav(shown.length, (i) => {
    const c = shown[i]; if (c) router.push(`/campaigns/detail/?id=${c.id}`);
  });

  const [delTarget, setDelTarget] = useState(null);

  function load() {
    if (!session) return;
    setLoading(true);
    ignitionopsGet('getCampaigns', {}, session)
      .then(r => setRows(r.campaigns || []))
      .catch(e => toast(e.message, 'error'))
      .finally(() => setLoading(false));
  }
  useEffect(load, [session]);

  async function doDelete(c) {
    try {
      await ignitionopsPost('deleteCampaign', { campaign_id: c.id }, session);
      toast(`Deleted ${c.campaign_no}`, 'success');
      setDelTarget(null);
      load();
    } catch (e) {
      const m = e.message || '';
      const linked = m.match(/campaign_has_(\d+)_linked_engagements/);
      if (linked) toast(`Can't delete — ${linked[1]} deal(s) still linked. Detach them first.`, 'error');
      else toast(m, 'error');
      setDelTarget(null);
    }
  }

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: 'var(--text-4)', textTransform: 'uppercase' }}>
            Lists · budgeted groups of deals
          </div>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 32, fontWeight: 700, marginTop: 6 }}>
            Campaigns
          </h1>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
            Multi-video deal groupings. Each campaign rolls up its linked engagements.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typeahead
            placeholder="Search campaign name or number…"
            value={q}
            onChange={setQ}
            quiet
            debounceMs={0}
            refreshKey={rows}
            width={280}
            fetchResults={async (text) => matchRows(rows, text, campaignFields).slice(0, 6).map(c => ({
              id: c.id,
              href: `/campaigns/detail/?id=${encodeURIComponent(c.id)}`,
              primary: c.name || c.campaign_no,
              secondary: c.name ? c.campaign_no : '',
              meta: c.status ? <StatusPill status={c.status} /> : null,
            }))}
            onPick={it => router.push(it.href)}
            onSubmit={() => {}}
          />
        {canManage && (
          <button onClick={() => setShowNew(true)} style={btnPrimary}>
            <Plus size={16} strokeWidth={2.5} style={{ marginRight: 6, verticalAlign: '-3px' }} />New campaign
          </button>
        )}
        </div>
      </header>

      {loading ? <Spinner /> : shown.length === 0 ? (
        <Card style={{ color: 'var(--text-3)', textAlign: 'center', fontSize: 13 }}>
          {rows.length ? <>No campaign matches &ldquo;{q.trim()}&rdquo;</> : 'No campaigns yet.'}
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: 12 }}>
          {shown.map((c, i) => {
            const budget = c.budget_amount != null ? Number(c.budget_amount) : null;
            const spend = Number(c.rollup?.spend) || 0;
            const pct = budget > 0 ? (spend / budget) * 100 : null;
            const tone = pct != null ? budgetTone(pct) : 'var(--text-3)';
            const go = () => router.push(`/campaigns/detail/?id=${c.id}`);
            return (
              <Card key={c.id} hover role="button" tabIndex={-1} onClick={go}
                onMouseEnter={() => setFocusedIdx(i)}
                className={`ig-row${focusedIdx === i ? ' ig-row-focus' : ''}`}
                style={{ display: 'flex', flexDirection: 'column', gap: 14, cursor: 'pointer', position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent-hi)', fontWeight: 600 }}>{c.campaign_no}</div>
                    <div style={{ fontFamily: 'var(--font-cond)', fontSize: 19, fontWeight: 700, marginTop: 2, overflowWrap: 'anywhere' }}>{c.name || '—'}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }} onClick={(ev) => ev.stopPropagation()}>
                    <StatusPill status={c.status} />
                    {canManage && (
                      <button
                        onClick={() => setDelTarget(c)}
                        title="Delete campaign"
                        style={{ padding: '4px 8px', background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
                      ><Trash2 size={13} /></button>
                    )}
                  </div>
                </div>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, marginBottom: 6 }}>
                    <span style={{ color: 'var(--text-3)' }}>
                      Consumed <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', fontWeight: 700 }}>{inr(c.rollup?.spend)}</span>
                      {budget != null && <> of {inr(budget)}</>}
                    </span>
                    {pct != null && <span style={{ fontFamily: 'var(--font-mono)', color: tone }}>{Math.round(pct)}%</span>}
                  </div>
                  {/* No budget set → no bar and no remaining (null must never read as ₹0 / fully spent). */}
                  {pct != null && <ProgressBar pct={pct} color={tone} delay={300 + Math.min(i, 12) * 50} />}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, paddingTop: 12, borderTop: '1px solid var(--row-divider)' }}>
                  <CardStat label="Posted" value={c.rollup?.posted_count ?? 0} sub={`/${c.rollup?.linked_count ?? 0}`} />
                  <CardStat label="Organic views" value={Number(c.rollup?.views || 0).toLocaleString('en-IN')} />
                  <CardStat label="Orders" value={Number(c.rollup?.orders || 0).toLocaleString('en-IN')} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {!loading && rows.length > 0 && <SpendVsBudget rows={rows} />}

      {showNew && (
        <NewCampaignModal
          session={session}
          onClose={() => setShowNew(false)}
          onCreated={(c) => { setShowNew(false); toast(`Created ${c.campaign_no}`, 'success'); router.push(`/campaigns/detail/?id=${c.id}`); }}
        />
      )}

      {delTarget && (
        <Modal open title={`Delete ${delTarget.campaign_no}?`} onClose={() => setDelTarget(null)}>
          <div style={{ minWidth: 340, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
              Campaigns with linked deals can&apos;t be deleted — detach the deals first.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setDelTarget(null)} style={btnGhost}>Cancel</button>
              <button onClick={() => doDelete(delTarget)} style={{ ...btnPrimary, height: 36, background: 'var(--state-error-fg)', color: '#0a0a0a' }}>Delete</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Cross-campaign spend vs budget (#1). Budget = budget_amount (agreed_total is a LEGACY
// column from the dormant per-influencer construct — do not reintroduce it as a second budget);
// spend/videos/views/
// orders from the per-campaign rollup the worker already returns.
function SpendVsBudget({ rows }) {
  const totals = rows.reduce((a, c) => {
    a.budget += Number(c.budget_amount) || 0;
    a.spend += Number(c.rollup?.spend) || 0;
    a.videos += Number(c.rollup?.linked_count) || 0;
    a.posted += Number(c.rollup?.posted_count) || 0;
    a.views += Number(c.rollup?.views) || 0;          // organic (views − paid, S373)
    a.paid += Number(c.rollup?.paid_views) || 0;
    a.orders += Number(c.rollup?.orders) || 0;
    return a;
  }, { budget: 0, spend: 0, videos: 0, posted: 0, views: 0, paid: 0, orders: 0 });

  return (
    <section style={{ marginTop: 24 }}>
      <h2 style={{ fontFamily: 'var(--font-cond)', fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
        Spend vs Budget
      </h2>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12 }}>Cross-campaign spend against agreed budget.</div>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-card)', overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ background: 'var(--surface-2)', textAlign: 'left' }}>
            <th style={th}>Campaign</th><th style={thR}>Budget</th><th style={thR}>Spend</th>
            <th style={thR}>Δ</th><th style={thR}>Videos</th><th style={thR}>Posted</th>
            <th style={thR}>Organic views</th><th style={thR}>Orders</th>
          </tr></thead>
          <tbody>
            {rows.map(c => {
              const budget = Number(c.budget_amount) || 0;
              const spend = Number(c.rollup?.spend) || 0;
              const delta = budget - spend;
              const over = budget > 0 && spend > budget;
              return (
                <tr key={c.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={td}><span style={{ color: 'var(--accent-hi)', fontWeight: 600 }}>{c.campaign_no}</span></td>
                  <td style={tdR}>{c.budget_amount != null ? inr(budget) : '—'}</td>
                  <td style={tdR}>{inr(spend)}</td>
                  <td style={{ ...tdR, color: c.budget_amount == null ? 'var(--text-3)' : over ? 'var(--state-error-fg)' : 'var(--state-success-fg)' }}>
                    {c.budget_amount == null ? '—' : (over ? `-${inr(-delta)}` : inr(delta))}
                  </td>
                  <td style={tdR}>{c.rollup?.linked_count ?? 0}</td>
                  <td style={tdR}>{c.rollup?.posted_count ?? 0}</td>
                  <td style={tdR}>
                    {Number(c.rollup?.views || 0).toLocaleString('en-IN')}
                    {Number(c.rollup?.paid_views) > 0 && <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 400 }}>+ {Number(c.rollup.paid_views).toLocaleString('en-IN')} paid</div>}
                  </td>
                  <td style={tdR}>{Number(c.rollup?.orders || 0).toLocaleString('en-IN')}</td>
                </tr>
              );
            })}
            <tr style={{ borderTop: '2px solid var(--border-2)', fontWeight: 700 }}>
              <td style={td}>Total</td>
              <td style={tdR}>{inr(totals.budget)}</td>
              <td style={tdR}>{inr(totals.spend)}</td>
              <td style={{ ...tdR, color: totals.spend > totals.budget ? 'var(--state-error-fg)' : 'var(--state-success-fg)' }}>
                {totals.spend > totals.budget ? `-${inr(totals.spend - totals.budget)}` : inr(totals.budget - totals.spend)}
              </td>
              <td style={tdR}>{totals.videos}</td>
              <td style={tdR}>{totals.posted}</td>
              <td style={tdR}>
                {totals.views.toLocaleString('en-IN')}
                {totals.paid > 0 && <div style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 400 }}>+ {totals.paid.toLocaleString('en-IN')} paid</div>}
              </td>
              <td style={tdR}>{totals.orders.toLocaleString('en-IN')}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StatusPill({ status }) {
  const map = {
    active: ['var(--state-success-fg)', 'var(--state-success-bg)'],
    completed: ['#8ea2ff', 'rgba(33,60,226,.22)'],
    cancelled: ['var(--text-3)', 'var(--chip-neutral)'],
  };
  const [fg, bg] = map[status] || ['var(--text-2)', 'var(--chip-neutral)'];
  return <span style={{ color: fg, background: bg, fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 99, textTransform: 'capitalize' }}>{status}</span>;
}

function CardStat({ label, value, sub }) {
  return (
    <div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700 }}>
        {value}{sub && <span style={{ color: 'var(--text-4)', fontSize: 13 }}>{sub}</span>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-4)' }}>{label}</div>
    </div>
  );
}

function NewCampaignModal({ session, onClose, onCreated }) {
  const { showToast: toast } = useToast();
  // A marketing campaign spans influencers (Reann #3) — no influencer picker, and the video
  // count is DERIVED from linked deals rather than declared up front.
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim()) { toast('Give the campaign a name', 'error'); return; }
    setBusy(true);
    try {
      const c = await ignitionopsPost('createCampaign', {
        name: name.trim(),
        budget_amount: budget === '' ? null : Number(budget),
      }, session);
      onCreated(c);
    } catch (e) { toast(e.message, 'error'); }
    finally { setBusy(false); }
  }

  return (
    <Modal open title="New Campaign" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 360 }}>
        <Field label="Campaign name">
          <input autoFocus placeholder="e.g. Independence Day" value={name}
            onChange={e => setName(e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Budget (₹)">
          <input type="number" min={0} value={budget} placeholder="optional"
            onChange={e => setBudget(e.target.value)} style={inputStyle} />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={submit} disabled={busy || !name.trim()}
            style={{ ...btnGhost, background: 'var(--accent)', color: '#0a0a0a', borderColor: 'var(--accent)', opacity: busy || !name.trim() ? 0.6 : 1 }}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const th = { padding: '10px 12px', fontSize: 11, color: 'var(--text-3)', letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 600 };
const thR = { ...th, textAlign: 'right' };
const td = { padding: '10px 12px' };
const tdR = { padding: '10px 12px', textAlign: 'right' };
const inputStyle = { background: 'var(--surface-2)', color: 'var(--text-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-ctl)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 13, width: '100%', boxSizing: 'border-box' };
const btnPrimary = { height: 42, padding: '0 16px', background: 'var(--text-1)', color: 'var(--bg)', border: 'none', borderRadius: 'var(--r-btn)', fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center' };
const btnGhost = { padding: '8px 16px', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.06em' };
