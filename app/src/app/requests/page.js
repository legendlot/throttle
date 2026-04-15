'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Layout from '@/components/Layout';
import RequestStatusBadge from '@/components/RequestStatusBadge';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { REQUEST_TYPES } from '@/lib/requestTypes';

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
    if (filter !== 'all') {
      query = query.eq('status', filter);
    }

    const { data, error } = await query;
    if (!error) setRequests(data || []);
    setLoading(false);
  }

  function getTypeLabel(value) {
    return REQUEST_TYPES.find(t => t.value === value)?.label || value;
  }

  const filters = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'approved', label: 'Approved' },
    { value: 'rejected', label: 'Rejected' },
    { value: 'info_needed', label: 'Info Needed' },
  ];

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white">
              {isApprover ? 'All Requests' : 'My Requests'}
            </h1>
            <p className="text-zinc-500 text-sm mt-1">
              {isApprover
                ? 'All incoming requests from your team'
                : 'Track the status of your submitted requests'}
            </p>
          </div>
          <div className="flex gap-3">
            {isApprover && (
              <button
                onClick={() => router.push('/requests/approval/')}
                className="bg-zinc-800 text-zinc-200 font-medium px-4 py-2 rounded-lg text-sm hover:bg-zinc-700 transition-colors"
              >
                Approval Queue
              </button>
            )}
            <button
              onClick={() => router.push('/requests/new/')}
              className="bg-white text-black font-semibold px-4 py-2 rounded-lg text-sm hover:bg-zinc-100 transition-colors"
            >
              + New Request
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex gap-2 mb-5">
          {filters.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                filter === f.value
                  ? 'bg-white text-black border-white'
                  : 'text-zinc-500 border-zinc-700 hover:border-zinc-500'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Request list */}
        {loading ? (
          <div className="text-zinc-600 text-sm py-12 text-center">Loading...</div>
        ) : requests.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-zinc-600 text-sm mb-4">No requests yet</p>
            <button
              onClick={() => router.push('/requests/new/')}
              className="text-zinc-400 text-sm hover:text-white transition-colors"
            >
              Submit your first request →
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {requests.map(req => (
              <div
                key={req.id}
                className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs text-zinc-600 bg-zinc-800 px-2 py-0.5 rounded">
                        {getTypeLabel(req.type)}
                      </span>
                      {req.is_product_scoped && (
                        <span className="text-xs text-zinc-600">
                          {req.request_products?.length} product{req.request_products?.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                    <p className="text-zinc-100 font-medium text-sm truncate">{req.title}</p>
                    {req.review_note && (
                      <p className="text-zinc-600 text-xs mt-1 line-clamp-1">
                        Note: {req.review_note}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <RequestStatusBadge status={req.status} />
                    <span className="text-zinc-700 text-xs">
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
