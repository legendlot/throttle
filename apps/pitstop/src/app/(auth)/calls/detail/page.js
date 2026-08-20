'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import { ArrowLeft, PhoneIncoming, PhoneOutgoing, ExternalLink, CheckCheck, FilePlus2, Play, AlertCircle } from 'lucide-react';
import { csopsGet, csopsPost } from '../../../../lib/csopsFetch.js';
import { CallStatusBadge } from '../../../../components/CallStatusBadge.js';

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtDuration(secs) {
  if (secs == null || secs <= 0) return '—';
  const m = Math.floor(secs / 60); const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function CallDetailPage() {
  const router = useRouter();
  const params = useSearchParams();
  const id = params.get('id');
  const { session } = useAuth();

  const [call, setCall] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    if (!id || !session) return;
    setLoading(true);
    try {
      const d = await csopsGet('getCall', { id }, session);
      setCall(d?.call || null);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); /* eslint-disable-line */ }, [id, session]);

  async function markCalledBack() {
    try { await csopsPost('markCalledBack', { call_id: id }, session); load(); }
    catch (e) { alert(e.message); }
  }

  function convert() {
    if (!call) return;
    const qs = new URLSearchParams({
      from_call: call.id,
      phone: call.customer_phone || '',
      name: call.customer_name || '',
    }).toString();
    router.push(`/new?${qs}`);
  }

  if (loading) return <Spinner />;
  if (error)   return <div style={{ padding: 20, color: '#dc2626' }}>{error}</div>;
  if (!call)   return <EmptyState icon="📞" message="Call not found." />;

  const ticketNo = call.ticket?.ticket_no;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <button onClick={() => router.back()} style={backBtn}>
        <ArrowLeft size={14} /> Back to calls
      </button>

      <header style={{ marginTop: 16, padding: 18, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 8 }}>
        <div style={{ display:'flex', alignItems:'center', gap: 12, marginBottom: 8 }}>
          {call.direction === 'incoming'
            ? <PhoneIncoming size={20} style={{ color: '#16a34a' }} />
            : <PhoneOutgoing size={20} style={{ color: '#4f46e5' }} />}
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>
            {call.customer_name || `Caller ${call.customer_phone}`}
          </h1>
          <CallStatusBadge status={call.status} />
        </div>
        <div style={{ display:'flex', gap: 24, fontSize: 12, color: 'var(--t3)' }}>
          <span><strong style={{ color: 'var(--t2)' }}>Phone:</strong> <code style={mono}>{call.customer_phone || '—'}</code></span>
          <span><strong style={{ color: 'var(--t2)' }}>Duration:</strong> <code style={mono}>{fmtDuration(call.duration_seconds)}</code></span>
          <span><strong style={{ color: 'var(--t2)' }}>Account:</strong> {call.myop_account?.name || '—'}</span>
          <span><strong style={{ color: 'var(--t2)' }}>Dept:</strong> {call.cs_department?.name || '—'}</span>
        </div>
      </header>

      <section style={{ marginTop: 20 }}>
        <h2 style={sectionH2}>Timeline</h2>
        <div style={cardWrap}>
          <TimelineRow label="Created" value={fmtDate(call.created_at)} />
          {call.started_at && <TimelineRow label="Answered" value={fmtDate(call.started_at)} />}
          {call.ended_at && <TimelineRow label="Ended" value={fmtDate(call.ended_at)} />}
          {call.called_back_at && <TimelineRow label="Called back" value={fmtDate(call.called_back_at)} />}
          {ticketNo && (
            <TimelineRow
              label="Ticket created"
              value={<Link href={`/queue/detail?ticket_no=${ticketNo}`} style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{ticketNo} <ExternalLink size={11} /></Link>}
            />
          )}
        </div>
      </section>

      <section style={{ marginTop: 20 }}>
        <h2 style={sectionH2}>Agent</h2>
        <div style={cardWrap}>
          <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{call.agent_name || <span style={{ color: 'var(--t3)' }}>— unassigned —</span>}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--t3)' }}>{call.agent_user_id || ''}</span>
          </div>
        </div>
      </section>

      <RecordingSection call={call} session={session} />

      <section style={{ marginTop: 24, display:'flex', gap: 10 }}>
        {!ticketNo && (
          <button onClick={convert} style={btnPrimary}>
            <FilePlus2 size={14} /> Create Ticket From Call
          </button>
        )}
        {(call.status === 'missed' || call.status === 'abandoned') && !call.called_back_at && (
          <button onClick={markCalledBack} style={btnSecondary}>
            <CheckCheck size={14} /> Mark Called Back
          </button>
        )}
      </section>
    </div>
  );
}

function TimelineRow({ label, value }) {
  return (
    <div style={{ padding: '10px 14px', display:'flex', justifyContent:'space-between', borderBottom: '1px solid var(--border-1)' }}>
      <span style={{ fontSize: 12, color:'var(--t3)' }}>{label}</span>
      <span style={{ fontSize: 13 }}>{value}</span>
    </div>
  );
}

const backBtn = { display:'inline-flex', alignItems:'center', gap: 6, background:'transparent', border:'none', color:'var(--t2)', cursor:'pointer', fontSize: 13 };
const sectionH2 = { margin: '0 0 8px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--t3)' };
const cardWrap = { background:'var(--surface-1)', border:'1px solid var(--border-1)', borderRadius:8, overflow:'hidden' };
/**
 * Recording playback.
 *
 * Recordings have NEVER played in Pitstop: recording_url is NULL on all 17,705
 * MyOperator rows and this section rendered the filename as inert text.
 *
 * ⚠️ Exotel's RecordingUrl is PRE-SIGNED and EXPIRES (5-60 min), so the stored column
 * cannot be rendered directly — a link saved at poll time is dead by the time an agent
 * clicks it. The worker resolves a fresh URL on demand; that is why this fetches on
 * click rather than on load (and why it does not prefetch for every row in a list).
 */
function RecordingSection({ call, session }) {
  const [state, setState] = useState({ status: 'idle' });

  // MyOperator only ever gave us a filename. Say so, rather than showing a play button
  // that cannot work.
  const legacy = call.provider && call.provider !== 'exotel';
  if (!call.recording_filename && !call.recording_url && legacy) return null;
  if (legacy) {
    return (
      <section style={{ marginTop: 20 }}>
        <h2 style={sectionH2}>Recording</h2>
        <div style={cardWrap}>
          <div style={{ padding: '12px 14px', display:'flex', alignItems:'center', gap: 9, color:'var(--t3)', fontSize: 12 }}>
            <AlertCircle size={13} />
            <span>Not available — MyOperator only sent a filename, never a playable recording.</span>
            {call.recording_filename && <code style={{ ...mono, fontSize: 11, marginLeft: 'auto' }}>{call.recording_filename}</code>}
          </div>
        </div>
      </section>
    );
  }

  async function load() {
    setState({ status: 'loading' });
    try {
      const r = await csopsGet('getCallRecording', { call_id: call.id }, session);
      setState(r?.playable ? { status: 'ready', url: r.url } : { status: 'none', reason: r?.reason });
    } catch (e) {
      setState({ status: 'error', reason: String(e.message || e) });
    }
  }

  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={sectionH2}>Recording</h2>
      <div style={cardWrap}>
        <div style={{ padding: '12px 14px' }}>
          {state.status === 'idle' && (
            <button onClick={load} style={btnSecondary}>
              <Play size={13} style={{ verticalAlign: -2, marginRight: 6 }} /> Load recording
            </button>
          )}
          {state.status === 'loading' && <span style={{ fontSize: 12, color: 'var(--t3)' }}>Fetching a fresh link…</span>}
          {state.status === 'ready' && (
            <>
              <audio controls preload="none" src={state.url} style={{ width: '100%' }}>
                Your browser cannot play this audio.
              </audio>
              <p style={{ margin: '7px 0 0', fontSize: 10.5, color: 'var(--t4)' }}>
                Link expires in about an hour — reload the page to get a new one.
              </p>
            </>
          )}
          {state.status === 'none' && (
            <span style={{ display:'inline-flex', alignItems:'center', gap: 8, fontSize: 12, color: 'var(--t3)' }}>
              <AlertCircle size={13} /> {state.reason || 'No recording for this call.'}
            </span>
          )}
          {state.status === 'error' && (
            <span style={{ display:'inline-flex', alignItems:'center', gap: 8, fontSize: 12, color: '#dc2626' }}>
              <AlertCircle size={13} /> {state.reason}
              <button onClick={load} style={{ ...btnSecondary, marginLeft: 8, padding: '3px 9px', fontSize: 11 }}>Retry</button>
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

const mono = { fontFamily: 'var(--font-mono)', fontSize: 12 };
const btnPrimary = { display:'inline-flex', alignItems:'center', gap:6, padding:'7px 14px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:6, fontWeight:600, cursor:'pointer', fontSize:13 };
const btnSecondary = { display:'inline-flex', alignItems:'center', gap: 6, padding:'7px 14px', background:'transparent', border:'1px solid var(--border-1)', borderRadius:6, color:'var(--t2)', cursor:'pointer', fontSize:13 };
