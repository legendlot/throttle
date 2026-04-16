'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Layout from '@/components/Layout';
import RequestStatusBadge from '@/components/RequestStatusBadge';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import { REQUEST_TYPES, getRequestType } from '@/lib/requestTypes';

export default function ApprovalQueuePage() {
  const { session, brandUser } = useAuth();
  const router = useRouter();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [action, setAction] = useState(null); // 'approve' | 'reject' | 'info'
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [focusTextarea, setFocusTextarea] = useState(false);
  const [hoveredCard, setHoveredCard] = useState(null);
  const [hoveredBtn, setHoveredBtn] = useState(null);

  const isApprover = brandUser?.role === 'admin' || brandUser?.role === 'lead';

  useEffect(() => {
    if (!isApprover) { router.replace('/requests/'); return; }
    loadQueue();
  }, [brandUser]);

  async function loadQueue() {
    setLoading(true);
    const { data, error } = await supabase
      .from('requests')
      .select('*, request_products(product_code, product_notes)')
      .eq('status', 'pending')
      .order('created_at', { ascending: true }); // oldest first

    if (!error) setRequests(data || []);
    setLoading(false);
  }

  function getTypeLabel(typeId) {
    const t = getRequestType(typeId);
    return t ? `${t.icon} ${t.label}` : typeId;
  }

  function isBrandInitiative(typeId) {
    return typeId === 'brand_initiative';
  }

  async function handleDecision() {
    if (!selected || !action) return;
    if ((action === 'reject' || action === 'info') && !note.trim()) {
      setError('A note is required when rejecting or requesting more info');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const actionMap = {
        approve: 'approveRequest',
        reject: 'rejectRequest',
        info: 'requestMoreInfo',
      };

      await workerFetch(actionMap[action], {
        request_id: selected.id,
        note: note.trim(),
      }, session?.access_token);

      // Remove from queue
      setRequests(prev => prev.filter(r => r.id !== selected.id));
      setSelected(null);
      setAction(null);
      setNote('');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!isApprover) return null;

  return (
    <Layout>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <button
              onClick={() => router.push('/requests/')}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--t3)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
                marginBottom: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              ← All Requests
            </button>
            <h1 style={{
              fontFamily: 'var(--head)',
              fontWeight: 900,
              fontSize: 18,
              letterSpacing: '.2em',
              textTransform: 'uppercase',
              color: 'var(--text)',
              margin: 0,
            }}>
              Approval Queue
            </h1>
            <p style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--t3)',
              marginTop: 4,
            }}>
              {requests.length} request{requests.length !== 1 ? 's' : ''} pending review
            </p>
          </div>
        </div>

        {loading ? (
          <div style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: 'var(--t3)',
            paddingTop: 48,
            paddingBottom: 48,
            textAlign: 'center',
          }}>
            Loading...
          </div>
        ) : requests.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 80, paddingBottom: 80 }}>
            <p style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--t3)',
            }}>
              Queue is clear — nothing pending review
            </p>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: '2fr 3fr',
            gap: 16,
          }}>
            {/* Queue list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {requests.map(req => {
                const isSelected = selected?.id === req.id;
                const isHovered = hoveredCard === req.id;
                return (
                  <button
                    key={req.id}
                    onClick={() => { setSelected(req); setAction(null); setNote(''); setError(null); }}
                    onMouseEnter={() => setHoveredCard(req.id)}
                    onMouseLeave={() => setHoveredCard(null)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      background: 'var(--s1)',
                      border: isSelected
                        ? '1px solid var(--b3)'
                        : isHovered
                          ? '1px solid var(--b2)'
                          : '1px solid var(--b1)',
                      borderRadius: 6,
                      padding: 12,
                      cursor: 'pointer',
                      transition: 'border-color 0.15s',
                    }}
                  >
                    <div style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--t3)',
                      marginBottom: 4,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}>
                      {getTypeLabel(req.type)}
                      {isBrandInitiative(req.type) && (
                        <span style={{
                          background: 'rgba(242,205,26,0.12)',
                          color: '#F2CD1A',
                          fontFamily: 'var(--mono)',
                          fontSize: 9,
                          padding: '1px 6px',
                          borderRadius: 3,
                          fontWeight: 600,
                        }}>
                          Brand
                        </span>
                      )}
                    </div>
                    <div style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 12,
                      color: 'var(--text)',
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {req.title}
                    </div>
                    <div style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 10,
                      color: 'var(--t3)',
                      marginTop: 4,
                    }}>
                      {new Date(req.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                      })}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Detail panel */}
            <div>
              {!selected ? (
                <div style={{
                  background: 'var(--s1)',
                  border: '1px solid var(--b1)',
                  borderRadius: 6,
                  padding: 24,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                  <p style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 12,
                    color: 'var(--t3)',
                  }}>
                    Select a request to review
                  </p>
                </div>
              ) : (
                <div style={{
                  background: 'var(--s1)',
                  border: '1px solid var(--b1)',
                  borderRadius: 6,
                  padding: 20,
                }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    marginBottom: 16,
                  }}>
                    <div>
                      <span style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 11,
                        color: 'var(--t2)',
                        background: 'var(--s3)',
                        padding: '2px 8px',
                        borderRadius: 4,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                      }}>
                        {getTypeLabel(selected.type)}
                        {isBrandInitiative(selected.type) && (
                          <span style={{
                            background: 'rgba(242,205,26,0.12)',
                            color: '#F2CD1A',
                            fontFamily: 'var(--mono)',
                            fontSize: 9,
                            padding: '1px 6px',
                            borderRadius: 3,
                            fontWeight: 600,
                          }}>
                            Brand
                          </span>
                        )}
                      </span>
                      <h2 style={{
                        fontFamily: 'var(--mono)',
                        color: 'var(--text)',
                        fontWeight: 600,
                        fontSize: 14,
                        marginTop: 8,
                      }}>
                        {selected.title}
                      </h2>
                    </div>
                    <RequestStatusBadge status={selected.status} />
                  </div>

                  {/* Product context */}
                  {selected.is_product_scoped && selected.request_products?.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <p style={{
                        fontFamily: 'var(--head)',
                        fontSize: 9,
                        letterSpacing: '.25em',
                        textTransform: 'uppercase',
                        color: 'var(--t3)',
                        marginBottom: 8,
                      }}>
                        Products
                      </p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        {selected.request_products.map(rp => (
                          <div key={rp.product_code} style={{
                            background: 'var(--s3)',
                            borderRadius: 4,
                            padding: '4px 8px',
                          }}>
                            <span style={{
                              fontFamily: 'var(--mono)',
                              fontSize: 11,
                              color: 'var(--t2)',
                            }}>
                              {rp.product_code}
                            </span>
                            {rp.product_notes && (
                              <span style={{
                                fontFamily: 'var(--mono)',
                                fontSize: 11,
                                color: 'var(--t3)',
                                marginLeft: 8,
                              }}>
                                — {rp.product_notes}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Template data */}
                  <div style={{ marginBottom: 20 }}>
                    <p style={{
                      fontFamily: 'var(--head)',
                      fontSize: 9,
                      letterSpacing: '.25em',
                      textTransform: 'uppercase',
                      color: 'var(--t3)',
                      marginBottom: 8,
                    }}>
                      Details
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {Object.entries(selected.template_data || {}).map(([key, value]) => (
                        value ? (
                          <div key={key} style={{ display: 'flex', gap: 8 }}>
                            <span style={{
                              fontFamily: 'var(--mono)',
                              fontSize: 11,
                              color: 'var(--t3)',
                              width: 128,
                              flexShrink: 0,
                              textTransform: 'capitalize',
                            }}>
                              {key.replace(/_/g, ' ')}
                            </span>
                            <span style={{
                              fontFamily: 'var(--mono)',
                              fontSize: 11,
                              color: 'var(--t2)',
                              flex: 1,
                            }}>
                              {Array.isArray(value) ? value.join(', ') : String(value)}
                            </span>
                          </div>
                        ) : null
                      ))}
                    </div>
                  </div>

                  {/* Decision */}
                  <div style={{
                    borderTop: '1px solid var(--b1)',
                    paddingTop: 16,
                  }}>
                    <p style={{
                      fontFamily: 'var(--head)',
                      fontSize: 9,
                      letterSpacing: '.25em',
                      textTransform: 'uppercase',
                      color: 'var(--t3)',
                      marginBottom: 12,
                    }}>
                      Decision
                    </p>

                    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                      {[
                        {
                          value: 'approve',
                          label: 'Approve',
                          border: '1px solid rgba(34,197,94,0.4)',
                          color: 'var(--green)',
                        },
                        {
                          value: 'reject',
                          label: 'Reject',
                          border: '1px solid rgba(222,42,42,0.4)',
                          color: 'var(--red)',
                        },
                        {
                          value: 'info',
                          label: 'Need Info',
                          border: '1px solid rgba(33,60,226,0.4)',
                          color: '#213CE2',
                        },
                      ].map(btn => (
                        <button
                          key={btn.value}
                          onClick={() => { setAction(btn.value); setNote(''); setError(null); }}
                          onMouseEnter={() => setHoveredBtn(btn.value)}
                          onMouseLeave={() => setHoveredBtn(null)}
                          style={{
                            flex: 1,
                            padding: '8px 0',
                            fontFamily: 'var(--mono)',
                            fontSize: 11,
                            fontWeight: 500,
                            borderRadius: 6,
                            border: btn.border,
                            color: btn.color,
                            background: 'transparent',
                            cursor: 'pointer',
                            transition: 'opacity 0.15s',
                            opacity: action === btn.value
                              ? 1
                              : hoveredBtn === btn.value
                                ? 0.8
                                : 0.5,
                          }}
                        >
                          {btn.label}
                        </button>
                      ))}
                    </div>

                    {action && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <textarea
                          value={note}
                          onChange={e => setNote(e.target.value)}
                          onFocus={() => setFocusTextarea(true)}
                          onBlur={() => setFocusTextarea(false)}
                          placeholder={
                            action === 'approve'
                              ? 'Optional note for the team...'
                              : action === 'reject'
                              ? 'Reason for rejection (required)...'
                              : 'What information is needed? (required)...'
                          }
                          style={{
                            width: '100%',
                            background: 'var(--s2)',
                            border: focusTextarea
                              ? '1px solid var(--yellow)'
                              : '1px solid var(--b2)',
                            borderRadius: 6,
                            padding: '8px 12px',
                            fontFamily: 'var(--mono)',
                            fontSize: 12,
                            color: 'var(--text)',
                            outline: 'none',
                            resize: 'none',
                            height: 80,
                            boxSizing: 'border-box',
                          }}
                        />

                        {error && (
                          <p style={{
                            fontFamily: 'var(--mono)',
                            fontSize: 11,
                            color: 'var(--red)',
                            margin: 0,
                          }}>
                            {error}
                          </p>
                        )}

                        <button
                          onClick={handleDecision}
                          disabled={submitting}
                          style={{
                            width: '100%',
                            background: '#F2CD1A',
                            color: '#080808',
                            fontFamily: 'var(--head)',
                            fontWeight: 700,
                            fontSize: 11,
                            letterSpacing: '.15em',
                            textTransform: 'uppercase',
                            padding: '10px 0',
                            borderRadius: 6,
                            border: 'none',
                            cursor: submitting ? 'default' : 'pointer',
                            opacity: submitting ? 0.5 : 1,
                            transition: 'opacity 0.15s',
                          }}
                        >
                          {submitting ? 'Submitting...' : `Confirm ${
                            action === 'approve' ? 'Approval' :
                            action === 'reject' ? 'Rejection' : 'Info Request'
                          }`}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
