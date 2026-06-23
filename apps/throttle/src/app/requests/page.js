'use client';
/* Requests — creative intake. Filterable list + approval queue + intake
   pulse rail. Click a request → drawer; approve / hold / reject update
   status live (worker: approveRequest / requestMoreInfo / rejectRequest)
   and fire a toast. Ported from requests.jsx; seed fallback. */
import React, { useState, useEffect } from 'react';
import { useAuth } from '@throttle/auth';
import { AppShell } from '@/components/throttle/AppShell';
import { Icon, Sparkline } from '@/components/throttle/Icon';
import { Card, Pill, ProductTag, PrimaryBtn } from '@/components/throttle/ui';
import { toast } from '@/components/throttle/ToastHost';
import { REQ_STATUS, REQUESTS } from '@/lib/throttleData';
import { fetchUsers, fetchRequests, actOnRequest, reqTypeOf } from '@/lib/throttleApi';

const fireNewReq = () => window.dispatchEvent(new CustomEvent('throttle:newreq'));

function ReqCard({ r, onOpen, onAct }) {
  const t = reqTypeOf(r.type);
  const st = REQ_STATUS[r.status] || { label: r.status, tone: 'info' };
  const ageColor = r.ageTone === 'bad' ? 'var(--bad-fg)' : r.ageTone === 'warn' ? 'var(--warn-fg)' : 'var(--t3)';
  return (
    <div onClick={() => onOpen(r)} className="t-card t-card-hover" style={{ background: 'var(--card-bg)', border: '1px solid var(--card-bd)',
      borderRadius: 'var(--card-radius)', boxShadow: 'var(--card-shadow)', padding: '14px 16px', cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 13 }}>
        <span style={{ width: 36, height: 36, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)', border: '1px solid var(--border-2)',
          display: 'grid', placeItems: 'center', color: 'var(--yellow)', flexShrink: 0 }}><Icon name={t.icon} size={17} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--t3)' }}>{t.label}</span>
            <span className="num" style={{ fontSize: 10.5, color: 'var(--t4)' }}>{r.id}</span>
            {r.items && <span style={{ fontSize: 10.5, color: 'var(--t4)' }}>· {r.items} deliverables</span>}
          </div>
          <div style={{ fontSize: 14, color: 'var(--t1)', fontWeight: 500, marginBottom: 8 }}>{r.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--t3)' }}>
              <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--surface-3)', border: '1px solid var(--border-2)',
                display: 'grid', placeItems: 'center', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 9.5, color: 'var(--t2)' }}>{r.wi}</span>
              {r.who}</span>
            {r.products.map(p => <ProductTag key={p} code={p} />)}
            {r.note && <span style={{ fontSize: 11.5, color: 'var(--t4)', fontStyle: 'italic' }}>“{r.note}”</span>}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, flexShrink: 0 }}>
          <Pill tone={st.tone} dot>{st.label}</Pill>
          <span className="num" style={{ fontSize: 11, color: 'var(--t4)' }}>{r.date} · <span style={{ color: ageColor }}>{r.age}</span></span>
          {r.status === 'pending' && (
            <div style={{ display: 'flex', gap: 6, marginTop: 2 }} onClick={e => e.stopPropagation()}>
              <button onClick={() => onAct(r.id, 'approved')} className="t-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 'var(--r-sm)',
                background: 'var(--ok-bg)', border: '1px solid var(--ok-bd)', color: 'var(--ok-fg)', cursor: 'pointer', fontFamily: 'var(--font-display)',
                fontWeight: 700, fontSize: 10, letterSpacing: '0.06em' }}><Icon name="check" size={13} />APPROVE</button>
              <button onClick={() => onAct(r.id, 'info_needed')} className="t-btn" style={{ padding: '5px 10px', borderRadius: 'var(--r-sm)', background: 'transparent', border: '1px solid var(--border-2)',
                color: 'var(--t3)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 10, letterSpacing: '0.06em' }}>HOLD</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RequestDrawer({ req, onClose, onAct, meId }) {
  useEffect(() => {
    if (!req) return;
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, onClose]);
  if (!req) return null;
  const canEditOwn = meId && req.requester_id === meId && (req.status === 'pending' || req.status === 'info_needed');
  const t = reqTypeOf(req.type);
  const st = REQ_STATUS[req.status] || { label: req.status, tone: 'info' };
  const meta = [
    ['Type', t.label], ['Requester', req.who], ['Filed', req.date],
    ['Deliverables', req.items ? String(req.items) : '—'],
  ];
  return (
    <div onClick={onClose} className="t-drawer-back" style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(8,8,10,0.55)', display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} className="t-drawer-panel" style={{ width: 'min(460px, 94vw)', height: '100%', background: 'var(--surface)',
        borderLeft: '1px solid var(--border-2)', boxShadow: 'var(--shadow-pop)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <span className="num" style={{ fontSize: 12, color: 'var(--yellow)', fontWeight: 600 }}>{req.id}</span>
          <Pill tone={st.tone} dot>{st.label}</Pill>
          <button onClick={onClose} className="t-iconbtn" style={{ marginLeft: 'auto', width: 30, height: 30 }}><Icon name="x" size={15} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 18px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ width: 38, height: 38, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)', border: '1px solid var(--border-2)', display: 'grid', placeItems: 'center', color: 'var(--yellow)', flexShrink: 0 }}><Icon name={t.icon} size={18} /></span>
            <h2 style={{ fontFamily: 'var(--font-ui)', fontWeight: 600, fontSize: 18, color: 'var(--t1)', lineHeight: 1.3, margin: 0 }}>{req.title}</h2>
          </div>
          {req.products.length > 0 && <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>{req.products.map(p => <ProductTag key={p} code={p} size="lg" />)}</div>}
          {canEditOwn && (
            <button
              onClick={() => { window.dispatchEvent(new CustomEvent('throttle:editreq', { detail: { id: req._id || req.id, type: req.type, title: req.title, products: req.products, template_data: req.template_data } })); onClose(); }}
              className="t-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 13px', marginBottom: 16, borderRadius: 'var(--r-sm)', background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--t1)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              <Icon name="type" size={13} />Edit request
            </button>
          )}
          {req.note && <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 'var(--r-sm)', background: 'var(--info-bg)', border: '1px solid var(--info-bd)', color: 'var(--info-fg)', fontSize: 12.5, marginBottom: 16 }}><Icon name="alert" size={15} style={{ flexShrink: 0, marginTop: 1 }} />{req.note}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 16px', marginBottom: 20 }}>
            {meta.map(([k, v]) => (
              <div key={k}><div className="eyebrow" style={{ padding: 0, marginBottom: 5 }}>{k}</div>
                <div style={{ fontSize: 13.5, color: 'var(--t1)' }}>{v}</div></div>
            ))}
          </div>

          <div className="eyebrow" style={{ padding: 0, marginBottom: 6 }}>Brief</div>
          {(req.brief && (req.brief.notes || req.brief.fields.length > 0 || req.brief.reference)) ? (
            <div style={{ margin: '0 0 20px' }}>
              {req.brief.notes && (
                <p style={{ fontSize: 13.5, color: 'var(--t2)', lineHeight: 1.6, margin: '0 0 10px', whiteSpace: 'pre-wrap' }}>{req.brief.notes}</p>
              )}
              {req.brief.fields.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 }}>
                  {req.brief.fields.map(f => (
                    <div key={f.label} style={{ display: 'flex', gap: 12 }}>
                      <span style={{ color: 'var(--t4)', minWidth: 120 }}>{f.label}</span>
                      <span style={{ color: 'var(--t2)', flex: 1 }}>{f.value}</span>
                    </div>
                  ))}
                </div>
              )}
              {req.brief.reference && (/^https?:\/\//i.test(req.brief.reference)
                ? <a href={req.brief.reference} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 12.5, color: 'var(--yellow)', textDecoration: 'none' }}>
                    <Icon name="link" size={13} />Reference</a>
                : <p style={{ fontSize: 13, color: 'var(--t4)', margin: '10px 0 0' }}>Reference: <span style={{ color: 'var(--t2)' }}>{req.brief.reference}</span></p>)}
            </div>
          ) : (
            <p style={{ fontSize: 13, color: 'var(--t4)', fontStyle: 'italic', margin: '0 0 20px' }}>No brief provided.</p>
          )}

          <div className="eyebrow" style={{ padding: 0, marginBottom: 10 }}>What happens on approve</div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {['Tasks created on the board in Backlog', 'Requester notified it’s in production', 'Shows up in the next sprint planning'].map((s, i) => (
              <li key={i} style={{ display: 'flex', gap: 11, alignItems: 'center', fontSize: 13, color: 'var(--t2)' }}>
                <span className="num" style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--surface-2)', border: '1px solid var(--border-2)', display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--yellow)', flexShrink: 0 }}>{i + 1}</span>{s}</li>
            ))}
          </ol>
        </div>

        {(req.status === 'pending' || req.status === 'info_needed') && (
          <div style={{ display: 'flex', gap: 10, padding: '14px 18px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
            <button onClick={() => { onAct(req.id, 'approved'); onClose(); }} className="t-btn" style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '11px', borderRadius: 'var(--r-sm)', background: 'var(--yellow)', color: '#15140b', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}><Icon name="check" size={14} />Approve</button>
            {req.status === 'pending' && <button onClick={() => { onAct(req.id, 'info_needed'); onClose(); }} className="t-btn" style={{ padding: '11px 15px', borderRadius: 'var(--r-sm)', background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Hold</button>}
            <button onClick={() => { onAct(req.id, 'rejected'); onClose(); }} className="t-btn" style={{ padding: '11px 15px', borderRadius: 'var(--r-sm)', background: 'transparent', border: '1px solid var(--border-2)', color: 'var(--bad-fg)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 11.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Reject</button>
          </div>
        )}
      </div>
    </div>
  );
}

function RequestsScreen() {
  const { session, brandUser } = useAuth();
  const FILTERS = [
    { v: 'needs', label: 'Needs Action' }, { v: 'all', label: 'All' },
    { v: 'pending', label: 'Pending' }, { v: 'approved', label: 'Approved' },
    { v: 'info_needed', label: 'Info Needed' }, { v: 'rejected', label: 'Rejected' },
  ];
  const [filter, setFilter] = useState('needs');
  // Logged in → real data or empty; seed only in the no-session dev preview.
  const [reqs, setReqs] = useState(session ? [] : REQUESTS);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const usersRes = await fetchUsers(session);
      const data = await fetchRequests(session, usersRes?.byId || {});
      if (cancelled) return;
      setReqs(data || []);
    })();
    return () => { cancelled = true; };
  }, [session]);

  const act = async (id, status) => {
    const prev = reqs;
    setReqs(p => p.map(r => r.id === id ? { ...r, status, ageTone: 'ok' } : r));
    setSelected(s => s && s.id === id ? { ...s, status } : s);
    const msg = status === 'approved' ? `${typeof id === 'string' ? id.slice(0, 8) : id} approved. Tasks queued to the board.`
      : status === 'info_needed' ? `Held. Requester asked for more info.`
      : status === 'rejected' ? `Request rejected.` : `Request updated.`;
    toast(msg, status === 'approved' ? 'ok' : status === 'rejected' ? 'bad' : 'info',
      status === 'approved' ? 'check' : status === 'rejected' ? 'x' : 'clock');
    if (session) {
      try { await actOnRequest(session, id, status); }
      catch (e) { setReqs(prev); toast('Action failed: ' + (e.message || 'not allowed'), 'bad', 'alert'); }
    }
  };

  const list = reqs.filter(r => {
    if (filter === 'all') return true;
    if (filter === 'needs') return r.status === 'pending' || r.status === 'info_needed';
    return r.status === filter;
  });
  const pending = reqs.filter(r => r.status === 'pending');
  const typeCounts = {};
  reqs.forEach(r => { typeCounts[r.type] = (typeCounts[r.type] || 0) + 1; });
  const topTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div style={{ maxWidth: 1240, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
        <div>
          <span className="eyebrow" style={{ padding: 0 }}>Intake · {reqs.length} this sprint</span>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 24, letterSpacing: '0.01em', color: 'var(--t1)', margin: '7px 0 0' }}>Requests</h1>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <PrimaryBtn icon="check" kind="ghost" onClick={() => { setFilter('pending'); }}>Approval queue · {pending.length}</PrimaryBtn>
          <PrimaryBtn icon="plus" onClick={fireNewReq}>New request</PrimaryBtn>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 7, marginBottom: 18, flexWrap: 'wrap' }}>
        {FILTERS.map(f => (
          <button key={f.v} onClick={() => setFilter(f.v)} className="t-chip" data-on={filter === f.v}>{f.label}
            {f.v === 'needs' && <span className="num" style={{ marginLeft: 6, color: 'inherit', opacity: 0.7 }}>{reqs.filter(r => r.status === 'pending' || r.status === 'info_needed').length}</span>}
          </button>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 18, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          {list.length === 0 && <Card><p style={{ color: 'var(--t3)', fontSize: 13, textAlign: 'center', margin: '24px 0' }}>Nothing here. Clean queue.</p></Card>}
          {list.map(r => <ReqCard key={r.id} r={r} onOpen={setSelected} onAct={act} />)}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'sticky', top: 0 }}>
          <Card pad={0}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '13px 15px', borderBottom: '1px solid var(--border)' }}>
              <Icon name="clock" size={15} style={{ color: 'var(--yellow)' }} /><span className="t-h3">Awaiting you</span>
              <Pill tone="warn" dot>{pending.length}</Pill>
            </div>
            <div style={{ padding: '4px 0' }}>
              {pending.length === 0 && <div style={{ padding: '16px', textAlign: 'center', color: 'var(--t4)', fontSize: 12.5 }}>All clear.</div>}
              {pending.map((r, i) => (
                <div key={r.id} onClick={() => setSelected(r)} className="t-row" style={{ padding: '10px 15px', borderTop: i ? '1px solid var(--border)' : 'none', cursor: 'pointer' }}>
                  <div style={{ fontSize: 12.5, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</div>
                  <div className="num" style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 2 }}>{reqTypeOf(r.type).label} · {r.who} · {r.age}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="eyebrow" style={{ padding: 0, marginBottom: 12 }}>Intake by type</div>
            {topTypes.map(([type, n]) => {
              const max = topTypes[0][1];
              return (
                <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
                  <Icon name={reqTypeOf(type).icon} size={14} style={{ color: 'var(--t3)' }} />
                  <span style={{ flex: 1, fontSize: 12, color: 'var(--t2)' }}>{reqTypeOf(type).label}</span>
                  <div style={{ width: 60, height: 6, borderRadius: 3, background: 'var(--bg-2)', overflow: 'hidden' }}>
                    <div style={{ width: `${(n / max) * 100}%`, height: '100%', background: 'var(--yellow)' }} /></div>
                  <span className="num" style={{ fontSize: 12, color: 'var(--t1)', fontWeight: 600, width: 14, textAlign: 'right' }}>{n}</span>
                </div>
              );
            })}
          </Card>

          <Card style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div><div className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 26, color: 'var(--t1)', lineHeight: 1 }}>9h</div>
              <div className="eyebrow" style={{ padding: 0, marginTop: 5 }}>Avg approval time</div></div>
            <Sparkline data={[14, 12, 11, 13, 10, 9, 9]} color="var(--ok-fg)" w={70} h={30} fill />
          </Card>
        </div>
      </div>

      <RequestDrawer req={selected} onClose={() => setSelected(null)} onAct={act} meId={brandUser?.id} />
    </div>
  );
}

export default function RequestsPage() {
  return <AppShell route="requests"><RequestsScreen /></AppShell>;
}
