'use client';
import StageBadge from '../../../../../components/StageBadge.js';
import DealTypeBadge from '../../../../../components/DealTypeBadge.js';
import OpenPitstopButton from '../../../../../components/OpenPitstopButton.js';
import { CompletenessPill } from './CompletenessPill.js';
import { BriefPreviewButton } from './BriefPreviewButton.js';

export function DetailHeader({ e, inf, data, completeness, session, reload, setAdvOpen, canManage, setDelOpen }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ color: '#FF6B00', fontWeight: 700, fontSize: 18 }}>{e.engagement_no}</span>
      <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 22, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {inf.channel_name || inf.influencer_code || '—'}
      </h1>
      {/* Reann #4 — handle link, so the deal view can reach the channel in one click. */}
      {inf.channel_link ? (
        <a href={inf.channel_link} target="_blank" rel="noopener noreferrer"
          title={inf.channel_link}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: '#FF6B00', textDecoration: 'none', borderBottom: '1px dotted #FF6B00' }}>
          {inf.channel_platform ? `${inf.channel_platform} ↗` : 'channel ↗'}
        </a>
      ) : null}
      {inf.influencer_code && (
        <a href={`/influencers/detail?id=${inf.id}`}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)', textDecoration: 'none' }}>
          {inf.influencer_code}
        </a>
      )}
      <StageBadge stage={e.stage} size="lg" />
      <DealTypeBadge dealType={e.deal_type} />
      {/* Complete is DERIVED, never a stage — `live` is still terminal (S214 ⑤). Nothing renders
          before the deal is live: an unposted deal has no numbers to be missing. The pill carries
          real text rather than an aria-label on a bare glyph (S346 review). */}
      <CompletenessPill completeness={completeness} />
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        <BriefPreviewButton engagementId={e.id} session={session} />
        <OpenPitstopButton engagement={e} onLinked={reload} />
        <button
          onClick={() => setAdvOpen(true)}
          disabled={data.allowed_next.length === 0}
          style={{
            padding: '6px 14px', background: '#FF6B00', color: '#fff',
            border: 'none', borderRadius: 'var(--radius-sm)',
            fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            cursor: data.allowed_next.length === 0 ? 'not-allowed' : 'pointer',
            opacity: data.allowed_next.length === 0 ? 0.5 : 1,
          }}
        >Advance →</button>
        {canManage && (
          <button
            onClick={() => setDelOpen(true)}
            style={{
              padding: '6px 14px', background: 'transparent', color: 'var(--state-error-fg)',
              border: '1px solid var(--state-error-fg)', borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer',
            }}
          >Delete</button>
        )}
      </div>
    </div>
  );
}
