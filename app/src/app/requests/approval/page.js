'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Layout from '@/components/Layout';
import RequestStatusBadge from '@/components/RequestStatusBadge';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { workerFetch } from '@/lib/worker';
import { REQUEST_TYPES } from '@/lib/requestTypes';

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

  function getTypeLabel(value) {
    return REQUEST_TYPES.find(t => t.value === value)?.label || value;
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
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <button
              onClick={() => router.push('/requests/')}
              className="text-zinc-600 text-sm hover:text-zinc-400 mb-3 flex items-center gap-1"
            >
              ← All Requests
            </button>
            <h1 className="text-2xl font-bold text-white">Approval Queue</h1>
            <p className="text-zinc-500 text-sm mt-1">
              {requests.length} request{requests.length !== 1 ? 's' : ''} pending review
            </p>
          </div>
        </div>

        {loading ? (
          <div className="text-zinc-600 text-sm py-12 text-center">Loading...</div>
        ) : requests.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-zinc-600 text-sm">Queue is clear — nothing pending review</p>
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-4">
            {/* Queue list */}
            <div className="col-span-2 space-y-2">
              {requests.map(req => (
                <button
                  key={req.id}
                  onClick={() => { setSelected(req); setAction(null); setNote(''); setError(null); }}
                  className={`w-full text-left bg-zinc-900 border rounded-xl p-3 transition-colors ${
                    selected?.id === req.id
                      ? 'border-zinc-500'
                      : 'border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <div className="text-xs text-zinc-600 mb-1">{getTypeLabel(req.type)}</div>
                  <div className="text-sm text-zinc-200 font-medium truncate">{req.title}</div>
                  <div className="text-xs text-zinc-700 mt-1">
                    {new Date(req.created_at).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
                    })}
                  </div>
                </button>
              ))}
            </div>

            {/* Detail panel */}
            <div className="col-span-3">
              {!selected ? (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 h-full flex items-center justify-center">
                  <p className="text-zinc-600 text-sm">Select a request to review</p>
                </div>
              ) : (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <span className="text-xs text-zinc-600 bg-zinc-800 px-2 py-0.5 rounded">
                        {getTypeLabel(selected.type)}
                      </span>
                      <h2 className="text-white font-semibold mt-2">{selected.title}</h2>
                    </div>
                    <RequestStatusBadge status={selected.status} />
                  </div>

                  {/* Product context */}
                  {selected.is_product_scoped && selected.request_products?.length > 0 && (
                    <div className="mb-4">
                      <p className="text-xs text-zinc-600 uppercase tracking-widest mb-2">Products</p>
                      <div className="flex flex-wrap gap-2">
                        {selected.request_products.map(rp => (
                          <div key={rp.product_code} className="bg-zinc-800 rounded px-2 py-1">
                            <span className="text-xs text-zinc-300">{rp.product_code}</span>
                            {rp.product_notes && (
                              <span className="text-xs text-zinc-600 ml-2">— {rp.product_notes}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Template data */}
                  <div className="mb-5">
                    <p className="text-xs text-zinc-600 uppercase tracking-widest mb-2">Details</p>
                    <div className="space-y-2">
                      {Object.entries(selected.template_data || {}).map(([key, value]) => (
                        value ? (
                          <div key={key} className="flex gap-2">
                            <span className="text-xs text-zinc-600 w-32 flex-shrink-0 capitalize">
                              {key.replace(/_/g, ' ')}
                            </span>
                            <span className="text-xs text-zinc-300 flex-1">
                              {Array.isArray(value) ? value.join(', ') : String(value)}
                            </span>
                          </div>
                        ) : null
                      ))}
                    </div>
                  </div>

                  {/* Decision */}
                  <div className="border-t border-zinc-800 pt-4">
                    <p className="text-xs text-zinc-600 uppercase tracking-widest mb-3">Decision</p>

                    <div className="flex gap-2 mb-3">
                      {[
                        { value: 'approve', label: 'Approve', cls: 'border-green-700 text-green-400 hover:bg-green-950' },
                        { value: 'reject',  label: 'Reject',  cls: 'border-red-700 text-red-400 hover:bg-red-950' },
                        { value: 'info',    label: 'Need Info', cls: 'border-blue-700 text-blue-400 hover:bg-blue-950' },
                      ].map(btn => (
                        <button
                          key={btn.value}
                          onClick={() => { setAction(btn.value); setNote(''); setError(null); }}
                          className={`flex-1 py-2 text-xs font-medium rounded-lg border transition-colors ${btn.cls} ${
                            action === btn.value ? 'opacity-100' : 'opacity-50 hover:opacity-80'
                          }`}
                        >
                          {btn.label}
                        </button>
                      ))}
                    </div>

                    {action && (
                      <div className="space-y-3">
                        <textarea
                          value={note}
                          onChange={e => setNote(e.target.value)}
                          placeholder={
                            action === 'approve'
                              ? 'Optional note for the team...'
                              : action === 'reject'
                              ? 'Reason for rejection (required)...'
                              : 'What information is needed? (required)...'
                          }
                          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-none h-20"
                        />

                        {error && (
                          <p className="text-red-400 text-xs">{error}</p>
                        )}

                        <button
                          onClick={handleDecision}
                          disabled={submitting}
                          className="w-full bg-white text-black font-semibold py-2.5 rounded-lg text-sm hover:bg-zinc-100 transition-colors disabled:opacity-50"
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
