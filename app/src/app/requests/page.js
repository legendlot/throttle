'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Layout from '@/components/Layout';
import RequestStatusBadge from '@/components/RequestStatusBadge';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { REQUEST_TYPES, getRequestType } from '@/lib/requestTypes';

export default function RequestsPage() {
  const { session, brandUser } = useAuth();
  const router = useRouter();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const isApprover = brandUser?.role === 'admin' || brandUser?.role === 'lead';

  useEffect(() => {
    if (!brandUser) return;
    loadRequests();
  }, [brandUser, filter]);

  async function loadRequests() {
    setLoading(true);
    let query = supabase
      .from('requests')
      .select('*, request_products(product_code, product_notes)')
      .order('created_at', { ascending: false });

    // Requesters only see their own — RLS enforces this
    // Admins/leads see all — RLS enforces this too
    if (filter === 'needs_action') {
      query = query.eq('status', 'info_needed').eq('requester_id', brandUser.id);
    } else if (filter !== 'all') {
      query = query.eq('status', filter);
    }

    const { data, error } = await query;
    if (!error) setRequests(data || []);
    setLoading(false);
  }

  function getTypeLabel(typeId) {
    const t = getRequestType(typeId);
    return t ? `${t.icon} ${t.label}` : typeId;
  }

  const filters = [
    { value: 'needs_action', label: 'Needs Action' },
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'info_needed', label: 'Info Needed' },
  ];

  return (
    <Layout>
      <div style={{ maxWidth: 896, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div>
            <h1 style={{
              fontFamily: 'var(--head)',
              fontWeight: 900,
              fontSize: 18,
              letterSpacing: '.2em',
              textTransform: 'uppercase',
              color: 'var(--text)',
              margin: 0
            }}>
              {isApprover ? 'All Requests' : 'My Requests'}
            </h1>
            <p style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--t3)',
              marginTop: 4,
              marginBottom: 0
            }}>
              {isApprover
                ? 'All incoming requests from your team'
                : 'Track the status of your submitted requests'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            {isApprover && (
              <button
                onClick={() => router.push('/requests/approval/')}
                style={{
                  background: 'transparent',
                  color: 'var(--t2)',
                  border: '1px solid var(--b2)',
                  borderRadius: 6,
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  letterSpacing: '.08em',
                  padding: '8px 16px',
                  cursor: 'pointer'
                }}
              >
                Approval Queue
              </button>
            )}
            <button
              onClick={() => router.push('/requests/new/')}
              style={{
                background: '#F2CD1A',
                color: '#080808',
                border: 'none',
                borderRadius: 6,
                fontFamily: 'var(--head)',
                fontWeight: 700,
                fontSize: 11,
                letterSpacing: '.15em',
                textTransform: 'uppercase',
                padding: '8px 16px',
                cursor: 'pointer'
              }}
            >
              + New Request
            </button>
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {filters.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                padding: '6px 12px',
                borderRadius: 20,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                background: filter === f.value ? 'rgba(242,205,26,0.12)' : 'transparent',
                color: filter === f.value ? '#F2CD1A' : 'var(--t3)',
                border: filter === f.value ? '1px solid #F2CD1A' : '1px solid var(--b2)'
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Request list */}
        {loading ? (
          <div style={{
            color: 'var(--t3)',
            fontFamily: 'var(--mono)',
            fontSize: 12,
            padding: '48px 0',
            textAlign: 'center'
          }}>Loading...</div>
        ) : requests.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px 0' }}>
            <p style={{
              color: 'var(--t3)',
              fontFamily: 'var(--mono)',
              fontSize: 12,
              marginBottom: 16
            }}>No requests yet</p>
            <button
              onClick={() => router.push('/requests/new/')}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--t2)',
                fontFamily: 'var(--mono)',
                fontSize: 12,
                cursor: 'pointer'
              }}
            >
              Submit your first request →
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {requests.map(req => (
              <div
                key={req.id}
                style={{
                  background: 'var(--s1)',
                  border: '1px solid var(--b1)',
                  borderRadius: 6,
                  padding: 16
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{
                        fontFamily: 'var(--mono)',
                        fontSize: 9,
                        background: 'var(--s3)',
                        color: 'var(--t3)',
                        padding: '2px 7px',
                        borderRadius: 3
                      }}>
                        {getTypeLabel(req.type)}
                      </span>
                      {req.is_product_scoped && (
                        <span style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 11,
                          color: 'var(--t3)'
                        }}>
                          {req.request_products?.length} product{req.request_products?.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <p style={{
                      fontFamily: 'var(--mono)',
                      color: 'var(--text)',
                      fontWeight: 500,
                      fontSize: 13,
                      margin: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}>{req.title}</p>
                    {req.review_note && (
                      <p style={{
                        fontFamily: 'var(--mono)',
                        color: 'var(--t3)',
                        fontSize: 11,
                        marginTop: 4,
                        marginBottom: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}>
                        Note: {req.review_note}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                    <RequestStatusBadge status={req.status} />
                    {req.requester_id === brandUser?.id && req.status === 'info_needed' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); router.push(`/requests/new/?prefill=${req.id}`); }}
                        style={{
                          background: 'rgba(242,205,26,0.12)',
                          color: '#F2CD1A',
                          border: '1px solid rgba(242,205,26,0.3)',
                          borderRadius: 4,
                          padding: '3px 10px',
                          fontFamily: 'var(--mono)',
                          fontSize: 10,
                          cursor: 'pointer',
                        }}
                      >
                        Update & Resubmit
                      </button>
                    )}
                    {req.requester_id === brandUser?.id && req.status === 'rejected' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); router.push(`/requests/new/?prefill=${req.id}`); }}
                        style={{
                          background: 'var(--s2)',
                          color: 'var(--t2)',
                          border: '1px solid var(--b2)',
                          borderRadius: 4,
                          padding: '3px 10px',
                          fontFamily: 'var(--mono)',
                          fontSize: 10,
                          cursor: 'pointer',
                        }}
                      >
                        Resubmit
                      </button>
                    )}
                    <span style={{
                      fontFamily: 'var(--mono)',
                      color: 'var(--t3)',
                      fontSize: 11
                    }}>
                      {new Date(req.created_at).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short'
                      })}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
