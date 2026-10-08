'use client';
import { STAGE_LABELS, STAGE_PALETTE } from '../../../../../lib/stages.js';
import { UGC_STAGE_LABELS, UGC_STAGE_PALETTE } from '../../../../../lib/ugcStages.js';
import { Card } from './shared.js';

const fmtStamp = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const actionLabel = (a) => {
  const s = String(a || '').replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '—';
};

export function HistoryCard({ data }) {
  const ugc = data.engagement?.engagement_type === 'ugc';
  const labels = ugc ? UGC_STAGE_LABELS : STAGE_LABELS;
  const palette = ugc ? UGC_STAGE_PALETTE : STAGE_PALETTE;
  const L = (s) => labels[s] || s;
  return (
    <Card title="History" className="ig-up" style={{ animationDelay: '120ms' }}>
      {data.history.length === 0 ? <div style={{ color: 'var(--text-4)', fontSize: 14 }}>No history yet.</div> : (
        <div>
          {data.history.map(h => {
            const moved = h.stage_from && h.stage_to && h.stage_from !== h.stage_to;
            // A plain stage move reads "Shipped → Delivered"; any other action keeps its name and
            // the stage(s) it touched, so nothing the old table showed is lost.
            const text = h.action === 'advance_stage' && moved
              ? `${L(h.stage_from)} → ${L(h.stage_to)}`
              : [actionLabel(h.action), moved ? `${L(h.stage_from)} → ${L(h.stage_to)}` : (h.stage_to || h.stage_from ? L(h.stage_to || h.stage_from) : null)].filter(Boolean).join(' · ');
            const dot = (palette[h.stage_to] || palette[h.stage_from])?.fg || 'var(--text-4)';
            return (
              <div key={h.id} className="ig-fade" style={{ display: 'grid', gridTemplateColumns: '14px minmax(0,1fr) auto', gap: 10, padding: '7px 0', alignItems: 'start' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 6, background: dot }} />
                <span style={{ fontSize: 14, lineHeight: 1.4, overflowWrap: 'anywhere' }}>
                  {text}
                  {h.actor_name && <span style={{ color: 'var(--text-3)' }}> · by {h.actor_name}</span>}
                  {h.note && <span style={{ display: 'block', fontSize: 13, color: 'var(--text-3)', whiteSpace: 'pre-wrap' }}>{h.note}</span>}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-4)', whiteSpace: 'nowrap', marginTop: 3 }}>{fmtStamp(h.created_at)}</span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
