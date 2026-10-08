'use client';
import { StagePill } from '../../../../../components/ui/StagePill.js';
import { DealPill } from '../../../../../components/ui/DealPill.js';
import { Avatar } from '../../../../../components/ui/Avatar.js';
import OpenPitstopButton from '../../../../../components/OpenPitstopButton.js';
import { CompletenessPill } from './CompletenessPill.js';
import { BriefPreviewButton } from './BriefPreviewButton.js';

const primaryBtnLg = { height: 40, padding: '0 18px', background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 700 };
const dangerGhostLg = { height: 40, padding: '0 14px', background: 'transparent', color: 'var(--state-error-fg)', border: '1px solid rgba(255,123,123,.4)', borderRadius: 'var(--r-ctl)', fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, cursor: 'pointer' };

export function DetailHeader({ e, inf, data, completeness, session, reload, setAdvOpen, canManage, setDelOpen }) {
  const displayName = inf.channel_name || inf.influencer_code || '—';
  const noNext = data.allowed_next.length === 0;
  return (
    <div className="ig-up" style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      <Avatar name={displayName} seed={inf.id || displayName} size={56} square />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: 'var(--accent-hi)' }}>{e.engagement_no}</span>
          {inf.influencer_code && (
            <a href={`/influencers/detail?id=${inf.id}`}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-4)', textDecoration: 'none' }}>
              {inf.influencer_code}
            </a>
          )}
          {/* Reann #4 — handle link, so the deal view can reach the channel in one click. */}
          {inf.channel_link ? (
            <a href={inf.channel_link} target="_blank" rel="noopener noreferrer"
              title={inf.channel_link}
              style={{ fontSize: 12, color: 'var(--accent-hi)', textDecoration: 'none', borderBottom: '1px dotted var(--accent-hi)' }}>
              {inf.channel_platform ? `${inf.channel_platform} ↗` : 'channel ↗'}
            </a>
          ) : null}
        </div>
        <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 30, fontWeight: 700, lineHeight: 1.1, margin: 0, overflowWrap: 'anywhere' }}>
          {displayName}
        </h1>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <StagePill stage={e.stage} ugc={e.engagement_type === 'ugc'} size="lg" />
        <DealPill type={e.deal_type} />
        {/* Complete is DERIVED, never a stage — `live` is still terminal (S214 ⑤). Nothing renders
            before the deal is live: an unposted deal has no numbers to be missing. The pill carries
            real text rather than an aria-label on a bare glyph (S346 review). */}
        <CompletenessPill completeness={completeness} />
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <BriefPreviewButton engagementId={e.id} session={session} />
        <OpenPitstopButton engagement={e} onLinked={reload} />
        <button
          type="button"
          onClick={() => setAdvOpen(true)}
          disabled={noNext}
          className={noNext ? undefined : 'ig-cta'}
          style={{ ...primaryBtnLg, cursor: noNext ? 'not-allowed' : 'pointer', opacity: noNext ? 0.5 : 1 }}
        >Advance →</button>
        {canManage && (
          <button type="button" onClick={() => setDelOpen(true)} className="ig-ghost-btn" style={dangerGhostLg}>Delete</button>
        )}
      </div>
    </div>
  );
}
