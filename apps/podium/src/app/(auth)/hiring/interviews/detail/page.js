'use client';
// One interview, as a panelist sees it (O2, D5): the candidate summary, the CV-tier documents, the JD the
// interview ran against, the scorecard form, and the others' feedback once yours is in (D4).
import { useEffect, useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { Spinner, useToast } from '@throttle/ui';
import { ArrowLeft, Download, Lock, Video } from 'lucide-react';
import { podiumopsGet } from '../../../../../lib/podiumopsFetch.js';
import { fmtDate } from '../../../../../lib/format.js';
import { Card, KV, Note, backBtn, ghostBtn, iconBtn, muted } from '../../../../../components/HiringBits.js';
import { FeedbackForm, FeedbackView, FeedbackStateBadge, InterviewStatusBadge, interviewWhen } from '../../../../../components/InterviewBits.js';
import { CANDIDATE_DOC_TYPES, hiringError, labelFrom, fmtDateTime } from '../../../../../lib/hiring.js';

function PanelInterviewInner() {
  const { session } = useAuth();
  const router = useRouter();
  const id = useSearchParams().get('id');
  const { showToast } = useToast();
  const [data, setData] = useState(null);

  const load = useCallback(() => {
    if (!session || !id) return;
    podiumopsGet('getPanelInterview', { id }, session).then(setData).catch(() => setData(false));
  }, [session, id]);
  useEffect(() => { load(); }, [load]);

  if (data === false) return <div style={{ color: 'var(--text-3)' }}>Not found, or you are not on this interview&apos;s panel.</div>;
  if (!data) return <Spinner />;

  const iv = data.interview || {};
  const c = data.candidate || {};
  const o = data.opening || {};
  const me = data.me || {};
  const others = (data.panel || []).filter(p => !p.is_me);

  async function open(params) {
    try { const r = await podiumopsGet('getPanelDocUrl', { interview_id: iv.id, ...params }, session); window.open(r.url, '_blank'); }
    catch (e) { showToast(hiringError(e, 'Could not open'), 'error'); }
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      <button onClick={() => router.push('/hiring/interviews')} style={backBtn}><ArrowLeft size={15} /> My interviews</button>
      <header style={{ margin: '10px 0 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ fontFamily: 'var(--font-cond)', fontSize: 24, fontWeight: 700, letterSpacing: '0.03em' }}>{c.full_name}</h1>
          <InterviewStatusBadge status={iv.status} />
          <FeedbackStateBadge state={me.state} />
        </div>
        <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
          <span style={{ color: 'var(--podium-accent)', fontWeight: 600 }}>{c.candidate_code}</span>
          {' · '}{iv.round_name} for {o.designation}{o.opening_code ? ` (${o.opening_code})` : ''}{o.department ? ` · ${o.department}` : ''}
        </div>
        <div style={{ color: 'var(--text-2)', fontSize: 12.5, marginTop: 2 }}>
          {interviewWhen(iv)}
          {iv.meet_url && (
            <a href={iv.meet_url} target="_blank" rel="noreferrer"
              style={{ marginLeft: 10, display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--podium-accent)' }}><Video size={12} /> Join Meet</a>
          )}
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 14, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 14 }}>
          <Card title="Candidate">
            <KV k="Current title" v={c.current_title} />
            <KV k="Current employer" v={c.current_employer} />
            <KV k="Experience" v={c.total_experience_years != null ? `${Number(c.total_experience_years)} yrs` : null} />
            <KV k="Location" v={c.location} />
            <KV k="Skills" v={(c.skills || []).join(', ')} />
            <KV k="Education" v={c.education} />
            <KV k="LinkedIn" v={c.linkedin_url ? <a href={c.linkedin_url} target="_blank" rel="noreferrer" style={{ color: 'var(--podium-accent)' }}>profile</a> : null} />
          </Card>
          <Card title={`Documents (${(data.documents || []).length})`}>
            {(data.documents || []).length === 0 ? <div style={muted}>No CV uploaded yet.</div> : data.documents.map(d => (
              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title || d.file_name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{labelFrom(CANDIDATE_DOC_TYPES, d.doc_type)} · {fmtDate(d.uploaded_at)}</div>
                </div>
                <button onClick={() => open({ document_id: d.id })} style={iconBtn} title="Open"><Download size={14} /></button>
              </div>
            ))}
          </Card>
          <Card title={data.jd ? `JD · v${data.jd.version}` : 'JD'}>
            {!data.jd ? <div style={muted}>No JD.</div> : <>
              {data.jd.jd_text && <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.55, maxHeight: 320, overflowY: 'auto' }}>{data.jd.jd_text}</div>}
              {data.jd.has_file && <button onClick={() => open({ jd: '1' })} style={{ ...ghostBtn, marginTop: data.jd.jd_text ? 10 : 0 }}><Download size={13} /> {data.jd.file_name || 'Download JD'}</button>}
              <div style={{ ...muted, marginTop: 6 }}>The JD this interview was scheduled against.</div>
            </>}
          </Card>
        </div>

        <div style={{ display: 'grid', gap: 14 }}>
          <Card title="Your feedback" right={me.due_at && !me.submitted_at ? <span style={muted}>due {fmtDateTime(me.due_at)}</span> : null}>
            {me.submitted_at ? <>
              <div style={{ ...muted, marginBottom: 4 }}>Submitted {fmtDateTime(me.submitted_at)}. Feedback cannot be edited.</div>
              <FeedbackView feedback={me.feedback} scorecard={iv.scorecard} />
            </> : data.can_submit ? (
              <FeedbackForm interviewId={iv.id} scorecard={iv.scorecard} session={session} onSubmitted={load} />
            ) : (
              <div style={muted}>{iv.status === 'no_show' ? 'The candidate did not attend. No feedback is needed.' : 'You can submit feedback once the interview time has passed.'}</div>
            )}
            {!me.submitted_at && (iv.scorecard || []).length > 0 && !data.can_submit && (
              <div style={{ marginTop: 8 }}>
                <div style={{ ...muted, marginBottom: 4 }}>Scorecard (each scored 1 to 5):</div>
                {(iv.scorecard || []).map(s => <div key={s.key} style={{ fontSize: 13, padding: '2px 0' }}>{s.label}</div>)}
              </div>
            )}
          </Card>
          <Card title={`Other interviewers (${others.length})`}>
            {!me.submitted_at && others.length > 0 && <Note tone="info"><Lock size={13} /> Their feedback shows once you submit yours.</Note>}
            {others.length === 0 ? <div style={muted}>You are the only interviewer.</div> : others.map(p => (
              <div key={p.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                  <span>{p.name || 'Interviewer'}</span>
                  <FeedbackStateBadge state={p.state} />
                  {p.submitted_at && <span style={muted}>{fmtDateTime(p.submitted_at)}</span>}
                </div>
                <FeedbackView feedback={p.feedback} scorecard={iv.scorecard} />
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

export default function PanelInterviewPage() {
  return <Suspense fallback={<Spinner />}><PanelInterviewInner /></Suspense>;
}
