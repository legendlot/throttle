'use client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { workerFetch } from '@throttle/db';

export default function FeedbackPage() {
  return <Suspense fallback={null}><FeedbackPageInner /></Suspense>;
}

function FeedbackPageInner() {
  const searchParams = useSearchParams();
  const requestId = searchParams.get('id');
  const router = useRouter();
  const { session, brandUser } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [feedback, setFeedback] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!session || !requestId) return;
    workerFetch('getRequestDelivery', { request_id: requestId }, session.access_token)
      .then(d => {
        setData(d);
        const initial = {};
        for (const t of d.tasks || []) {
          initial[t.id] = { verdict: 'accepted', comment: '', reference_links: [] };
        }
        setFeedback(initial);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [session, requestId]);

  function setVerdict(taskId, verdict) {
    setFeedback(f => ({ ...f, [taskId]: { ...f[taskId], verdict } }));
  }
  function setComment(taskId, comment) {
    setFeedback(f => ({ ...f, [taskId]: { ...f[taskId], comment } }));
  }
  function setRefLink(taskId, value) {
    setFeedback(f => ({ ...f, [taskId]: { ...f[taskId], reference_links: value ? [value] : [] } }));
  }

  async function handleSubmit() {
    const deliveredTasks = (data?.tasks || []).filter(t => t.stage === 'delivered');
    if (!deliveredTasks.length) return;

    setSubmitting(true);
    setError(null);
    try {
      const feedback_items = deliveredTasks.map(t => ({
        task_id: t.id,
        verdict: feedback[t.id]?.verdict || 'accepted',
        comment: feedback[t.id]?.comment || '',
        reference_links: feedback[t.id]?.reference_links || [],
      }));
      await workerFetch('submitBatchFeedback', { request_id: requestId, feedback_items }, session.access_token);
      setSubmitted(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!requestId) return <div style={{ padding: 40, fontFamily: 'var(--mono)', color: '#DE2A2A' }}>Missing request id.</div>;
  if (loading) return <div style={{ padding: 40, fontFamily: 'var(--mono)', color: 'var(--t3)' }}>Loading...</div>;
  if (error)   return <div style={{ padding: 40, fontFamily: 'var(--mono)', color: '#DE2A2A' }}>{error}</div>;
  if (!data)   return null;

  const deliveredTasks = (data.tasks || []).filter(t => t.stage === 'delivered');
  const otherTasks     = (data.tasks || []).filter(t => t.stage !== 'delivered');

  if (submitted) {
    return (
      <div style={{ padding: 40, maxWidth: 680, margin: '0 auto' }}>
        <p style={{ fontFamily: 'var(--head)', fontSize: 24, color: 'var(--text)', margin: '0 0 8px' }}>FEEDBACK SUBMITTED</p>
        <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t2)', marginBottom: 24 }}>The brand team has been notified.</p>
        <button onClick={() => router.push('/requests/')} style={{ background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 4, padding: '8px 16px', fontFamily: 'var(--head)', fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', cursor: 'pointer' }}>
          Back to My Requests
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 40, maxWidth: 720, margin: '0 auto' }}>
      <button onClick={() => router.push('/requests/')} style={{ background: 'none', border: 'none', color: 'var(--t3)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer', marginBottom: 24, padding: 0 }}>← Back</button>

      <p style={{ fontFamily: 'var(--head)', fontSize: 22, color: 'var(--text)', margin: '0 0 4px', letterSpacing: '.05em', textTransform: 'uppercase' }}>{data.request.title}</p>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginBottom: 32 }}>Review the deliverables below and let us know what&apos;s good and what needs revision.</p>

      {deliveredTasks.length === 0 && (
        <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t3)' }}>No deliverables are awaiting your feedback right now.</p>
      )}

      {deliveredTasks.map(task => {
        const fb = feedback[task.id] || {};
        const isIteration = fb.verdict === 'iteration_requested';
        const autoCloseDate = task.auto_close_at ? new Date(task.auto_close_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;

        return (
          <div key={task.id} style={{ background: 'var(--s1)', border: `1px solid ${isIteration ? '#f59e0b' : 'var(--b1)'}`, borderRadius: 6, padding: 20, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <p style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text)', margin: 0, fontWeight: 600 }}>{task.title}</p>
              {autoCloseDate && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', whiteSpace: 'nowrap', marginLeft: 12 }}>Auto-accepts {autoCloseDate}</span>
              )}
            </div>

            {task.delivery_message && (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)', background: 'var(--s2)', padding: '8px 12px', borderRadius: 4, marginBottom: 12 }}>
                💬 {task.delivery_message}
              </p>
            )}

            {task.attachments?.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                {task.attachments.map((a, i) => (
                  <a key={i} href={a.url} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 11, color: '#F2CD1A', textDecoration: 'none', marginRight: 12 }}>
                    🔗 {a.label || 'View Deliverable'}
                  </a>
                ))}
              </div>
            )}

            {task.latest_feedback?.verdict === 'iteration_requested' && (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', marginBottom: 12 }}>
                ↩ Previous feedback: {task.latest_feedback.comment || '(no comment)'}
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, marginBottom: isIteration ? 12 : 0 }}>
              <button
                onClick={() => setVerdict(task.id, 'accepted')}
                style={{ flex: 1, padding: '8px 0', borderRadius: 4, border: `1px solid ${fb.verdict === 'accepted' ? '#30D158' : 'var(--b2)'}`, background: fb.verdict === 'accepted' ? 'rgba(48,209,88,0.12)' : 'var(--s2)', color: fb.verdict === 'accepted' ? '#30D158' : 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}
              >
                ✓ Looks good
              </button>
              <button
                onClick={() => setVerdict(task.id, 'iteration_requested')}
                style={{ flex: 1, padding: '8px 0', borderRadius: 4, border: `1px solid ${isIteration ? '#f59e0b' : 'var(--b2)'}`, background: isIteration ? 'rgba(245,158,11,0.12)' : 'var(--s2)', color: isIteration ? '#f59e0b' : 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer' }}
              >
                ↩ Needs revision
              </button>
            </div>

            {isIteration && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
                <textarea
                  value={fb.comment}
                  onChange={e => setComment(task.id, e.target.value)}
                  placeholder="What needs to change? Be specific."
                  style={{ width: '100%', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '8px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, resize: 'none', height: 72, outline: 'none', boxSizing: 'border-box' }}
                />
                <input
                  type="url"
                  value={fb.reference_links?.[0] || ''}
                  onChange={e => setRefLink(task.id, e.target.value)}
                  placeholder="Reference link or screenshot URL (optional)"
                  style={{ width: '100%', background: 'var(--s2)', border: '1px solid var(--b2)', borderRadius: 4, padding: '7px 10px', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11, outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
            )}
          </div>
        );
      })}

      {otherTasks.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 10 }}>Other tasks in this request</p>
          {otherTasks.map(t => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--s1)', borderRadius: 4, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--t2)' }}>{t.title}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{t.stage.replace(/_/g, ' ')}</span>
            </div>
          ))}
        </div>
      )}

      {deliveredTasks.length > 0 && (
        <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--b1)' }}>
          {error && <p style={{ fontFamily: 'var(--mono)', fontSize: 12, color: '#DE2A2A', marginBottom: 12 }}>{error}</p>}
          <button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ background: '#F2CD1A', color: '#080808', border: 'none', borderRadius: 4, padding: '10px 24px', fontFamily: 'var(--head)', fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', cursor: 'pointer', opacity: submitting ? 0.6 : 1 }}
          >
            {submitting ? 'Submitting...' : 'Submit Feedback'}
          </button>
        </div>
      )}
    </div>
  );
}
