'use client';
// Cross-campaign experiment log (T10-T14 UI, S272). The whole point of this screen: a test's
// result is written down ONCE, at the moment someone recorded a learning on VariantResults.js's
// "Record what we learned" panel — this table renders that FROZEN verdict_snapshot, never a live
// recompute, so a decision made here can never silently disagree with what someone already acted
// on. An in-flight test with no learning yet still belongs in the log — it is not hidden, its
// verdict column just reads "Not yet decided".
//
// Governing constraint: the team reads this log without Claude. Every number and word here is
// either straight off the campaign_experiments row or the ab-stats.js verdict frozen inside it —
// nothing recomputed, nothing guessed.
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner, useToast } from '@throttle/ui';
import { AlertTriangle } from 'lucide-react';
import { PageHead, Panel, Badge, EmptyState, Stamp } from '@/components/ui.js';
import { fmtDateTime } from '@/components/format.js';
import { STATE_META } from '../campaigns/VariantResults.js';

const fmtPct = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);

// 'undecided' is synthetic — there is no such ab-stats.js state. It stands for "no verdict_snapshot
// yet", i.e. nobody has recorded a learning on this experiment (VariantResults.js's panel).
const FILTERS = [
  { value: 'all', label: 'All verdicts' },
  ...Object.entries(STATE_META).map(([value, m]) => ({ value, label: m.label })),
  { value: 'undecided', label: 'Not yet decided' },
];

export default function ExperimentsPage() {
  const { session, perms } = useAuth();
  const { showToast } = useToast();
  const router = useRouter();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const r = await garageFetch('listExperiments', {}, session);
      setRows(Array.isArray(r) ? r : []);
    } catch (e) { showToast(e.message || 'Failed to load the experiment log', 'error'); }
    finally { setLoading(false); }
  }, [session, showToast]);
  useEffect(() => { load(); }, [load]);

  if (perms && !perms.relay_view) return <div style={{ padding: 24, color: 'var(--text-3)' }}>Relay access required.</div>;

  const shown = filter === 'all' ? rows : rows.filter((r) => {
    const state = r.verdict_snapshot?.verdict?.state;
    return filter === 'undecided' ? !state : state === filter;
  });

  return (
    <div className="pg">
      <PageHead title="Experiment log" sub="Every A/B test ever run, across every campaign — what was hypothesised, what was decided, and when." />

      {/* Statistical-literacy note, permanently at the top — this is exactly the data a false
          positive hides inside, and it is the one place across Relay someone scans many results
          side by side looking for a pattern. */}
      <div className="info-bar" style={{ background: 'rgba(242,205,26,.07)', borderColor: 'var(--accent-bd)' }}>
        <AlertTriangle size={16} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
        <span>Run enough tests and roughly one in twenty will show a &quot;winner&quot; by chance
          alone. Treat a single result as a hint; treat a result you have reproduced as a finding.</span>
      </div>

      {loading ? <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}><Spinner /></div>
        : rows.length === 0
          ? <Panel><EmptyState icon="search-x" title="No experiments yet"
              hint="Add a second version to a campaign — the A/B test setup panel on its detail page — and it shows up here the moment it exists." /></Panel>
          : (
            <Panel
              title="Experiments"
              count={rows.length}
              action={
                <select className="f-inp" style={{ width: 200 }} value={filter}
                  onChange={(e) => setFilter(e.target.value)} aria-label="Filter by verdict">
                  {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              }>
              <div className="table-scroll">
              <table className="dt">
                <thead><tr>
                  <th>Started</th><th>Campaign</th><th>Hypothesis</th><th>Arms</th>
                  <th className="num">Audience</th><th>Verdict</th><th>Learning</th>
                </tr></thead>
                <tbody>
                  {shown.map((r) => {
                    // The verdict/arms shown here are the FROZEN snapshot (verdict_snapshot.verdict),
                    // recorded the moment a learning was saved — never recomputed live. See the file
                    // banner above and VariantResults.js's snapshot-vs-live divergence note.
                    const snap = r.verdict_snapshot?.verdict || null;
                    const arms = Array.isArray(snap?.arms) ? snap.arms : [];
                    const audience = arms.length ? arms.reduce((a, x) => a + (Number(x.assigned) || 0), 0) : null;
                    const meta = snap ? (STATE_META[snap.state] || { label: snap.state, tone: 'gray' }) : null;
                    const camp = r.campaign;
                    return (
                      <tr key={r.campaign_id} className={camp ? 'row-click' : ''}
                        onClick={camp ? () => router.push(`/campaigns?open=${r.campaign_id}`) : undefined}>
                        <td className="dim"><Stamp value={r.created_at} /></td>
                        <td>
                          {camp
                            ? <div style={{ fontWeight: 600, color: 'var(--t1)' }}>{camp.name}</div>
                            : <span className="dim">Campaign deleted</span>}
                          {camp && <div className="mono dim" style={{ fontSize: 10.5, marginTop: 2 }}>{camp.channel} · {camp.purpose}</div>}
                        </td>
                        <td style={{ maxWidth: 260 }}>{r.hypothesis || <span className="dim">—</span>}</td>
                        <td className="mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                          {arms.length
                            ? arms.map((a) => `${a.label} ${fmtPct(a.readRate)}`).join(' · ')
                            : <span className="dim">—</span>}
                        </td>
                        <td className="num mono">{audience != null ? audience.toLocaleString('en-IN') : <span className="dim">—</span>}</td>
                        <td>
                          {meta
                            ? <Badge label={`${meta.label}${snap.winner ? ` — ${snap.winner}` : ''}`} tone={meta.tone} dot />
                            : <Badge label="Not yet decided" tone="gray" />}
                        </td>
                        <td style={{ maxWidth: 280 }}>{r.learning || <span className="dim">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              {shown.length === 0 && (
                <div className="tw-note" style={{ margin: '10px 16px' }}>No experiments match this filter.</div>
              )}
            </Panel>
          )}
    </div>
  );
}
