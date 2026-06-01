'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { EmptyState, Spinner } from '@throttle/ui';
import { ArrowLeft, PhoneIncoming, PhoneOutgoing, ExternalLink, CheckCheck, FilePlus2 } from 'lucide-react';
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

  const [resolving, setResolving] = useState(false);
  async function resolveRecording() {
    setResolving(true);
    try {
      const d = await csopsPost('resolveCallRecording', { call_id: id }, session);
      if (d?.recording_url) load();
      else alert(d?.message || 'Could not resolve recording yet.');
    } catch (e) { alert(e.message); }
    finally { setResolving(false); }
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

      {call.recording_filename && (
        <section style={{ marginTop: 20 }}>
          <h2 style={sectionH2}>Recording</h2>
          <div style={cardWrap}>
            <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <code style={{ ...mono, fontSize: 12 }}>{call.recording_filename}</code>
              {call.recording_url ? (
                <a href={call.recording_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 12 }}>
                  Open <ExternalLink size={11} />
                </a>
              ) : (
                <button onClick={resolveRecording} disabled={resolving}
                  style={{ fontSize: 11, color: 'var(--accent)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 10px', cursor: resolving ? 'wait' : 'pointer', fontFamily: 'var(--font-mono)' }}>
                  {resolving ? 'Resolving…' : 'Resolve recording'}
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      <section style={{ marginTop: 24, display:'flex', gap: 10 }}>
        {!ticketNo && (
          <button onClick={convert} style={btnPrimary}>
            <FilePlus2 size={14} /> Create Ticket From Call
          </button>
        )}
        {!ticketNo && call.status === 'missed' && !call.called_back_at && (
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
const mono = { fontFamily: 'var(--font-mono)', fontSize: 12 };
const btnPrimary = { display:'inline-flex', alignItems:'center', gap:6, padding:'7px 14px', background:'var(--accent)', color:'#fff', border:'none', borderRadius:6, fontWeight:600, cursor:'pointer', fontSize:13 };
const btnSecondary = { display:'inline-flex', alignItems:'center', gap: 6, padding:'7px 14px', background:'transparent', border:'1px solid var(--border-1)', borderRadius:6, color:'var(--t2)', cursor:'pointer', fontSize:13 };
