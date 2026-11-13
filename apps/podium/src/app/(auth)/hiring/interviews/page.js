'use client';
// My interviews (O2, D9): the caller's own panel seats. Cancelled interviews are dropped by the worker.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { CalendarClock, Video } from 'lucide-react';
import { podiumopsGet } from '../../../../lib/podiumopsFetch.js';
import { FilterChip } from '../../../../components/ui.js';
import { muted } from '../../../../components/HiringBits.js';
import { FeedbackStateBadge, InterviewStatusBadge, interviewWhen } from '../../../../components/InterviewBits.js';
import { hiringError, fmtDateTime } from '../../../../lib/hiring.js';

const TABS = [
  { id: 'owed',     label: 'Feedback owed' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'done',     label: 'Done' },
];

export default function MyInterviewsPage() {
  const { session } = useAuth();
  const router = useRouter();
  const { showToast } = useToast();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(null);

  useEffect(() => {
    if (!session) return;
    podiumopsGet('getMyInterviews', {}, session)
      .then(d => { setData(d); setTab(t => t || (d.owed?.length ? 'owed' : 'upcoming')); })
      .catch(e => { setData({ upcoming: [], owed: [], done: [], overdue_count: 0 }); showToast(hiringError(e, 'Failed to load interviews'), 'error'); });
  }, [session, showToast]);

  if (!data) return <Spinner />;
  const rows = data[tab || 'upcoming'] || [];

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <FilterChip key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label} ({(data[t.id] || []).length}){t.id === 'owed' && data.overdue_count ? `, ${data.overdue_count} overdue` : ''}
          </FilterChip>
        ))}
      </div>
      {rows.length === 0 ? (
        <div style={{ ...muted, padding: '24px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
          <CalendarClock size={15} /> {tab === 'owed' ? 'No feedback owed.' : tab === 'done' ? 'Nothing here yet.' : 'No upcoming interviews.'}
        </div>
      ) : rows.map(r => (
        <div key={r.panel_id} onClick={() => router.push(`/hiring/interviews/detail/?id=${r.interview_id}`)}
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderTop: '1px solid var(--border)', cursor: 'pointer', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>
              {r.candidate?.full_name || r.candidate?.candidate_code || 'Candidate'}
              <span style={{ color: 'var(--podium-accent)', fontWeight: 600, marginLeft: 8, fontSize: 12 }}>{r.candidate?.candidate_code}</span>
            </div>
            <div style={{ ...muted, fontSize: 11.5 }}>
              {r.round_name} · {r.opening?.designation || ''}{r.opening?.opening_code ? ` (${r.opening.opening_code})` : ''}
              {r.candidate?.current_title && ` · ${r.candidate.current_title}`}{r.candidate?.current_employer && ` @ ${r.candidate.current_employer}`}
            </div>
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-2)', flex: '1 1 220px' }}>
            {interviewWhen(r)}
            {r.status === 'scheduled' && r.meet_url && (
              <a href={r.meet_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                style={{ marginLeft: 8, display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--podium-accent)' }}><Video size={12} /> Join</a>
            )}
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, minWidth: 130 }}>
            {r.status !== 'scheduled' && r.status !== 'completed' ? <InterviewStatusBadge status={r.status} /> : <FeedbackStateBadge state={r.state} />}
            {(r.state === 'pending' || r.state === 'overdue') && <span style={{ ...muted, fontSize: 10.5 }}>due {fmtDateTime(r.due_at)}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
