'use client';
import { useEffect, useState } from 'react';
import Layout from '@/components/Layout';
import { useAuth } from '@throttle/auth';
import { workerFetch, getValidSession } from '@throttle/db';
import { useToast } from '@/lib/toast';
import { PostDetailPanel, CreateEditPanel } from './SocialPanels';

const STATUS_DOT_COLORS = {
  idea:      '#888',
  draft:     'var(--t3)',
  approved:  '#2eb86a',
  published: '#0a66c2',
  cancelled: '#e04040',
};

const CAMPAIGN_STATUS_COLOR = {
  active:    '#213CE2',
  completed: '#2eb86a',
  archived:  'var(--t3)',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const EMPTY_CAMPAIGN_FORM = {
  name: '', description: '', start_date: '', end_date: '', status: 'active',
};

function pad2(n) { return String(n).padStart(2, '0'); }

function isoDate(y, m, d) {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

function StatusDot({ status }) {
  return (
    <span style={{
      width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
      background: STATUS_DOT_COLORS[status] ?? '#888',
      marginLeft: 'auto',
    }} title={status} />
  );
}

export default function SocialPage() {
  const { session, brandUser } = useAuth();
  const toast = useToast();

  const [activeTab, setActiveTab] = useState('calendar'); // 'calendar' | 'campaigns' | 'monitor'

  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });
  const [feed, setFeed]           = useState([]);
  const [channels, setChannels]   = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading]     = useState(true);

  const [selectedPost, setSelectedPost] = useState(null);
  const [showCreate, setShowCreate]     = useState(false);
  const [editPost, setEditPost]         = useState(null);
  const [prefillDate, setPrefillDate]   = useState('');

  // Campaigns tab
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [showCampaignForm, setShowCampaignForm] = useState(false);
  const [editingCampaign, setEditingCampaign]   = useState(null);
  const [campaignForm, setCampaignForm]         = useState(EMPTY_CAMPAIGN_FORM);
  const [campaignSaving, setCampaignSaving]     = useState(false);

  // Monitor tab
  const [monitorData, setMonitorData]       = useState(null);
  const [monitorLoading, setMonitorLoading] = useState(false);

  const role = brandUser?.role;
  const canEdit = role && role !== 'requester';

  async function loadFeed() {
    if (!session) return;
    await getValidSession();
    const { year, month } = currentMonth;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const from_date = isoDate(year, month, 1);
    const to_date   = isoDate(year, month, daysInMonth);
    setLoading(true);
    try {
      const res = await workerFetch('getSocialFeed', { from_date, to_date }, session);
      setFeed(res.feed ?? []);
    } catch (err) {
      toast?.error?.(`Failed to load feed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadStatic() {
    if (!session) return;
    await getValidSession();
    try {
      const [chRes, cpRes] = await Promise.all([
        workerFetch('getChannels',  {}, session),
        workerFetch('getCampaigns', {}, session),
      ]);
      setChannels(chRes.channels ?? []);
      setCampaigns(cpRes.campaigns ?? []);
    } catch (err) {
      toast?.error?.(`Failed to load channels/campaigns: ${err.message}`);
    }
  }

  async function loadCampaigns() {
    if (!session) return;
    setCampaignsLoading(true);
    try {
      const res = await workerFetch('getCampaigns', {}, session);
      setCampaigns(res.campaigns ?? []);
    } catch (err) {
      toast?.error?.(`Failed to load campaigns: ${err.message}`);
    } finally {
      setCampaignsLoading(false);
    }
  }

  async function loadMonitor() {
    if (!session) return;
    setMonitorLoading(true);
    try {
      const res = await workerFetch('getSocialMonitoring', {}, session);
      setMonitorData(res);
    } catch (err) {
      toast?.error?.(`Failed to load monitor: ${err.message}`);
    } finally {
      setMonitorLoading(false);
    }
  }

  useEffect(() => { if (brandUser) loadStatic(); }, [brandUser]);
  useEffect(() => { if (brandUser) loadFeed();   }, [brandUser, currentMonth.year, currentMonth.month]);
  useEffect(() => {
    if (!brandUser) return;
    if (activeTab === 'monitor' && !monitorData) loadMonitor();
  }, [activeTab, brandUser]);

  function prevMonth() {
    setCurrentMonth(({ year, month }) =>
      month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 });
  }
  function nextMonth() {
    setCurrentMonth(({ year, month }) =>
      month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 });
  }

  function openCreate(forDate) {
    if (!canEdit) return;
    setPrefillDate(forDate || '');
    setEditPost(null);
    setShowCreate(true);
  }

  async function handleStatusChange(post_id, status) {
    try {
      await workerFetch('updatePostStatus', { post_id, status }, session);
      toast?.success?.(`Status → ${status}`);
      setSelectedPost(null);
      await loadFeed();
    } catch (err) {
      toast?.error?.(err.message);
    }
  }

  async function handlePublishVariant(variant_id) {
    try {
      await workerFetch('publishVariant', { variant_id }, session);
      toast?.success?.('Variant published');
      if (selectedPost) {
        const refreshed = await workerFetch('getSocialPost', { post_id: selectedPost.id }, session);
        setSelectedPost(refreshed.post);
      }
      await loadFeed();
    } catch (err) {
      toast?.error?.(err.message);
    }
  }

  async function handleDelete(post_id) {
    try {
      await workerFetch('deleteSocialPost', { post_id }, session);
      toast?.success?.('Post deleted');
      setSelectedPost(null);
      await loadFeed();
    } catch (err) {
      toast?.error?.(err.message);
    }
  }

  function handleEdit(post) {
    setSelectedPost(null);
    setEditPost(post);
    setShowCreate(true);
  }

  async function handleSaved() {
    setShowCreate(false);
    setEditPost(null);
    setPrefillDate('');
    toast?.success?.('Saved');
    await loadFeed();
  }

  function startNewCampaign() {
    setEditingCampaign(null);
    setCampaignForm(EMPTY_CAMPAIGN_FORM);
    setShowCampaignForm(true);
  }

  function startEditCampaign(c) {
    setEditingCampaign(c);
    setCampaignForm({
      name: c.name ?? '',
      description: c.description ?? '',
      start_date: c.start_date ?? '',
      end_date: c.end_date ?? '',
      status: c.status ?? 'active',
    });
    setShowCampaignForm(true);
  }

  async function handleSaveCampaign() {
    if (!campaignForm.name.trim()) return;
    setCampaignSaving(true);
    try {
      const body = editingCampaign
        ? { campaign_id: editingCampaign.id, ...campaignForm }
        : campaignForm;
      const action = editingCampaign ? 'updateCampaign' : 'createCampaign';
      await workerFetch(action, body, session);
      toast?.success?.(editingCampaign ? 'Campaign updated' : 'Campaign created');
      setShowCampaignForm(false);
      setEditingCampaign(null);
      setCampaignForm(EMPTY_CAMPAIGN_FORM);
      await loadCampaigns();
    } catch (err) {
      toast?.error?.(err.message);
    } finally {
      setCampaignSaving(false);
    }
  }

  // Build calendar cells
  const { year, month } = currentMonth;
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const postsByDay = {};
  for (const p of feed) {
    if (!p.scheduled_date) continue;
    const dayNum = Number(p.scheduled_date.slice(8, 10));
    if (!postsByDay[dayNum]) postsByDay[dayNum] = [];
    postsByDay[dayNum].push(p);
  }

  const atRiskCount = monitorData?.at_risk?.length ?? 0;

  return (
    <Layout>
      {/* Tab strip */}
      <div style={{
        display: 'flex', gap: 2, marginBottom: 20,
        borderBottom: '1px solid var(--b1)',
      }}>
        {[
          { key: 'calendar',  label: 'Calendar'  },
          { key: 'campaigns', label: 'Campaigns' },
          { key: 'monitor',   label: 'Monitor'   },
        ].map(tab => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '10px 16px', fontSize: 11, fontFamily: 'var(--head)',
                fontWeight: 700, letterSpacing: '.15em', textTransform: 'uppercase',
                color: active ? 'var(--text)' : 'var(--t3)',
                borderBottom: active ? '2px solid #F2CD1A' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {tab.label}
              {tab.key === 'monitor' && atRiskCount > 0 && (
                <span style={{
                  marginLeft: 6, background: '#e04040', color: '#fff',
                  fontSize: 11, padding: '1px 6px', borderRadius: 8,
                  verticalAlign: 'middle', letterSpacing: 0, fontWeight: 600,
                }}>
                  {atRiskCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {activeTab === 'calendar' && (
        <>
          {/* Top bar */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 20, flexWrap: 'wrap', gap: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button onClick={prevMonth} style={{
                background: 'transparent', border: '1px solid var(--b1)',
                color: 'var(--t2)', fontFamily: 'var(--sans)', fontSize: 13,
                padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
              }}>←</button>
              <h1 style={{
                margin: 0, fontFamily: 'var(--head)', fontSize: 16, fontWeight: 900,
                letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)',
              }}>
                {MONTH_NAMES[month]} {year}
              </h1>
              <button onClick={nextMonth} style={{
                background: 'transparent', border: '1px solid var(--b1)',
                color: 'var(--t2)', fontFamily: 'var(--sans)', fontSize: 13,
                padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
              }}>→</button>
              {loading && (
                <span style={{ fontFamily: 'var(--sans)', fontSize: 10, color: 'var(--t3)' }}>
                  loading…
                </span>
              )}
            </div>

            {canEdit && (
              <button onClick={() => openCreate('')} style={{
                background: '#F2CD1A', color: '#080808',
                fontFamily: 'var(--head)', fontWeight: 700, fontSize: 11,
                letterSpacing: '.15em', textTransform: 'uppercase',
                border: 'none', borderRadius: 4, padding: '8px 14px', cursor: 'pointer',
              }}>
                + New Post
              </button>
            )}
          </div>

          {/* Calendar grid */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)',
            gap: 1, background: 'var(--b1)',
            border: '1px solid var(--b1)', borderRadius: 6, overflow: 'hidden',
          }}>
            {DOW_NAMES.map(d => (
              <div key={d} style={{
                background: 'var(--s2)',
                fontFamily: 'var(--sans)', fontSize: 10, letterSpacing: '.15em',
                textTransform: 'uppercase', color: 'var(--t3)',
                padding: '6px 10px', textAlign: 'center',
              }}>
                {d}
              </div>
            ))}
            {cells.map((dayNum, idx) => {
              if (dayNum === null) {
                return <div key={`empty-${idx}`} style={{ background: 'var(--bg)', minHeight: 96 }} />;
              }
              const isoForDay = isoDate(year, month, dayNum);
              const posts = postsByDay[dayNum] ?? [];
              return (
                <div
                  key={isoForDay}
                  onClick={() => posts.length === 0 && openCreate(isoForDay)}
                  style={{
                    background: 'var(--s1)',
                    minHeight: 96,
                    padding: 6,
                    cursor: canEdit && posts.length === 0 ? 'pointer' : 'default',
                    display: 'flex', flexDirection: 'column', gap: 3,
                  }}
                >
                  <div style={{
                    fontFamily: 'var(--sans)', fontSize: 10, color: 'var(--t2)',
                    letterSpacing: '.08em', marginBottom: 2,
                  }}>
                    {dayNum}
                  </div>
                  {posts.map(post => (
                    <div
                      key={post.id}
                      onClick={(e) => { e.stopPropagation(); setSelectedPost(post); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '3px 6px', borderRadius: 4,
                        background: 'var(--s3)', cursor: 'pointer',
                        fontSize: 11,
                      }}
                      title={post.title}
                    >
                      {(post.variants ?? []).slice(0, 3).map(v => (
                        <span key={v.id} style={{
                          width: 6, height: 6, borderRadius: '50%',
                          background: v.channel?.color ?? '#888', flexShrink: 0,
                        }} />
                      ))}
                      <span style={{
                        color: 'var(--text)', fontFamily: 'var(--sans)', fontSize: 11,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        flex: 1, minWidth: 0,
                      }}>
                        {post.title}
                      </span>
                      <StatusDot status={post.status} />
                    </div>
                  ))}
                  {posts.length > 0 && canEdit && (
                    <button
                      onClick={(e) => { e.stopPropagation(); openCreate(isoForDay); }}
                      style={{
                        fontFamily: 'var(--sans)', fontSize: 10, color: 'var(--t3)',
                        background: 'transparent', border: 'none', cursor: 'pointer',
                        padding: '2px 0', textAlign: 'left', letterSpacing: '.05em',
                      }}
                    >
                      + add
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {activeTab === 'campaigns' && (
        <CampaignsTab
          campaigns={campaigns}
          loading={campaignsLoading}
          canEdit={canEdit}
          showForm={showCampaignForm}
          editingCampaign={editingCampaign}
          form={campaignForm}
          setForm={setCampaignForm}
          saving={campaignSaving}
          onNew={startNewCampaign}
          onEdit={startEditCampaign}
          onSave={handleSaveCampaign}
          onCancel={() => { setShowCampaignForm(false); setEditingCampaign(null); }}
          onReload={loadCampaigns}
        />
      )}

      {activeTab === 'monitor' && (
        <MonitorTab data={monitorData} loading={monitorLoading} onReload={loadMonitor} />
      )}

      {selectedPost && (
        <PostDetailPanel
          post={selectedPost}
          role={role}
          onClose={() => setSelectedPost(null)}
          onEdit={handleEdit}
          onStatusChange={handleStatusChange}
          onPublishVariant={handlePublishVariant}
          onDelete={handleDelete}
        />
      )}

      {showCreate && (
        <CreateEditPanel
          channels={channels}
          campaigns={campaigns}
          prefillDate={prefillDate}
          editPost={editPost}
          role={role}
          session={session}
          onClose={() => { setShowCreate(false); setEditPost(null); setPrefillDate(''); }}
          onSaved={handleSaved}
        />
      )}
    </Layout>
  );
}

// ── CampaignsTab ─────────────────────────────────────────────────────────────

function CampaignsTab({
  campaigns, loading, canEdit,
  showForm, editingCampaign, form, setForm, saving,
  onNew, onEdit, onSave, onCancel, onReload,
}) {
  return (
    <div>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 16,
      }}>
        <span style={{ fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--t3)' }}>
          {campaigns.length} campaign{campaigns.length === 1 ? '' : 's'}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onReload} style={{
            background: 'transparent', border: '1px solid var(--b1)',
            color: 'var(--t2)', fontFamily: 'var(--sans)', fontSize: 11,
            padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
          }}>
            ↻ Refresh
          </button>
          {canEdit && (
            <button onClick={onNew} style={{
              background: '#F2CD1A', color: '#080808',
              fontFamily: 'var(--head)', fontWeight: 700, fontSize: 11,
              letterSpacing: '.15em', textTransform: 'uppercase',
              border: 'none', borderRadius: 4, padding: '8px 14px', cursor: 'pointer',
            }}>
              + New Campaign
            </button>
          )}
        </div>
      </div>

      {showForm && (
        <div style={{
          background: 'var(--s1)', border: '1px solid var(--b1)',
          borderRadius: 6, padding: 16, marginBottom: 16,
        }}>
          <div style={{
            fontFamily: 'var(--head)', fontSize: 11, fontWeight: 700,
            letterSpacing: '.2em', textTransform: 'uppercase',
            color: 'var(--text)', marginBottom: 14,
          }}>
            {editingCampaign ? 'Edit Campaign' : 'New Campaign'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <CampaignField label="Name *" full>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Campaign name"
                style={CAMPAIGN_INPUT_STYLE}
              />
            </CampaignField>
            <CampaignField label="Description" full>
              <textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                rows={2}
                placeholder="Optional description"
                style={{ ...CAMPAIGN_INPUT_STYLE, resize: 'vertical', fontFamily: 'var(--sans)' }}
              />
            </CampaignField>
            <CampaignField label="Start date">
              <input
                type="date"
                value={form.start_date}
                onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                style={CAMPAIGN_INPUT_STYLE}
              />
            </CampaignField>
            <CampaignField label="End date">
              <input
                type="date"
                value={form.end_date}
                onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                style={CAMPAIGN_INPUT_STYLE}
              />
            </CampaignField>
            {editingCampaign && (
              <CampaignField label="Status">
                <select
                  value={form.status}
                  onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                  style={CAMPAIGN_INPUT_STYLE}
                >
                  <option value="active">active</option>
                  <option value="completed">completed</option>
                  <option value="archived">archived</option>
                </select>
              </CampaignField>
            )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button onClick={onCancel} style={{
              background: 'transparent', border: '1px solid var(--b1)',
              color: 'var(--t2)', fontFamily: 'var(--sans)', fontSize: 12,
              padding: '6px 14px', borderRadius: 4, cursor: 'pointer',
            }}>
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving || !form.name.trim()}
              style={{
                background: '#F2CD1A', color: '#080808',
                fontFamily: 'var(--head)', fontWeight: 700, fontSize: 11,
                letterSpacing: '.15em', textTransform: 'uppercase',
                border: 'none', borderRadius: 4, padding: '7px 14px',
                cursor: saving || !form.name.trim() ? 'not-allowed' : 'pointer',
                opacity: saving || !form.name.trim() ? 0.5 : 1,
              }}
            >
              {saving ? 'Saving…' : (editingCampaign ? 'Update' : 'Create')}
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div style={{ color: 'var(--t3)', fontFamily: 'var(--sans)', fontSize: 12, padding: '20px 0' }}>
          loading…
        </div>
      )}
      {!loading && campaigns.length === 0 && (
        <div style={{
          color: 'var(--t3)', fontFamily: 'var(--sans)', fontSize: 12,
          padding: '40px 0', textAlign: 'center',
        }}>
          No campaigns yet
        </div>
      )}
      {!loading && campaigns.map(c => (
        <div key={c.id} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 14px', background: 'var(--s1)',
          border: '1px solid var(--b1)', borderRadius: 6, marginBottom: 6,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>
              {c.name}
            </div>
            {c.description && (
              <div style={{
                fontSize: 12, color: 'var(--t3)', marginTop: 2,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {c.description}
              </div>
            )}
            {(c.start_date || c.end_date) && (
              <div style={{
                fontFamily: 'var(--sans)', fontSize: 10, color: 'var(--t3)',
                marginTop: 4, letterSpacing: '.05em',
              }}>
                {c.start_date || '—'} → {c.end_date || 'ongoing'}
              </div>
            )}
          </div>
          <span style={{
            fontFamily: 'var(--sans)', fontSize: 10,
            padding: '2px 8px', borderRadius: 3,
            background: CAMPAIGN_STATUS_COLOR[c.status] ?? 'var(--b1)',
            color: '#fff', textTransform: 'uppercase', letterSpacing: '.1em',
            whiteSpace: 'nowrap',
          }}>
            {c.status}
          </span>
          {canEdit && (
            <button
              onClick={() => onEdit(c)}
              style={{
                background: 'transparent', border: '1px solid var(--b1)',
                color: 'var(--t2)', fontFamily: 'var(--sans)', fontSize: 11,
                padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
              }}
            >
              Edit
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

const CAMPAIGN_INPUT_STYLE = {
  width: '100%', boxSizing: 'border-box',
  padding: '7px 10px', background: 'var(--s2)',
  border: '1px solid var(--b1)', borderRadius: 4,
  color: 'var(--text)', fontSize: 12, fontFamily: 'var(--sans)',
  outline: 'none',
};

function CampaignField({ label, children, full }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <label style={{
        display: 'block', fontFamily: 'var(--sans)', fontSize: 10,
        color: 'var(--t3)', letterSpacing: '.1em', textTransform: 'uppercase',
        marginBottom: 4,
      }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ── MonitorTab ───────────────────────────────────────────────────────────────

function MonitorTab({ data, loading, onReload }) {
  if (loading && !data) {
    return (
      <div style={{ color: 'var(--t3)', fontFamily: 'var(--sans)', fontSize: 12, padding: '20px 0' }}>
        loading…
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <button onClick={onReload} style={{
          background: '#F2CD1A', color: '#080808',
          fontFamily: 'var(--head)', fontWeight: 700, fontSize: 11,
          letterSpacing: '.15em', textTransform: 'uppercase',
          border: 'none', borderRadius: 4, padding: '8px 14px', cursor: 'pointer',
        }}>
          Load Monitor
        </button>
      </div>
    );
  }

  const overdue      = data.at_risk.filter(p => p.is_overdue);
  const missingAsset = data.at_risk.filter(p => !p.is_overdue && p.is_missing_asset);

  const fmtWeek = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  return (
    <div>
      {/* At-risk section */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{
            fontFamily: 'var(--head)', fontSize: 11, fontWeight: 700,
            letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)',
          }}>
            At Risk
          </span>
          {data.at_risk.length > 0
            ? <span style={{
                background: '#e04040', color: '#fff',
                fontFamily: 'var(--sans)', fontSize: 10,
                padding: '2px 7px', borderRadius: 8, letterSpacing: '.05em',
              }}>{data.at_risk.length}</span>
            : <span style={{
                background: '#2eb86a22', color: '#2eb86a',
                fontFamily: 'var(--sans)', fontSize: 10,
                padding: '2px 7px', borderRadius: 8, letterSpacing: '.05em',
              }}>All clear</span>
          }
          <button onClick={onReload} style={{
            marginLeft: 'auto', background: 'transparent', border: '1px solid var(--b1)',
            color: 'var(--t2)', fontFamily: 'var(--sans)', fontSize: 11,
            padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
          }}>
            ↻ Refresh
          </button>
        </div>

        {data.at_risk.length === 0 && (
          <div style={{
            color: 'var(--t3)', fontFamily: 'var(--sans)', fontSize: 12,
            padding: '16px 0',
          }}>
            No at-risk posts — you&apos;re on track ✓
          </div>
        )}

        {overdue.length > 0 && (
          <>
            <div style={{
              fontFamily: 'var(--sans)', fontSize: 10, color: '#e04040',
              letterSpacing: '.1em', textTransform: 'uppercase',
              marginBottom: 6,
            }}>
              Overdue ({overdue.length})
            </div>
            {overdue.map(p => <PostRow key={p.id} post={p} accentColor="#e04040" />)}
          </>
        )}

        {missingAsset.length > 0 && (
          <div style={{ marginTop: overdue.length ? 16 : 0 }}>
            <div style={{
              fontFamily: 'var(--sans)', fontSize: 10, color: '#F2CD1A',
              letterSpacing: '.1em', textTransform: 'uppercase',
              marginBottom: 6,
            }}>
              Missing assets — due within 24h ({missingAsset.length})
            </div>
            {missingAsset.map(p => <PostRow key={p.id} post={p} accentColor="#F2CD1A" />)}
          </div>
        )}
      </div>

      {/* Cadence section */}
      <div>
        <div style={{
          fontFamily: 'var(--head)', fontSize: 11, fontWeight: 700,
          letterSpacing: '.2em', textTransform: 'uppercase',
          color: 'var(--text)', marginBottom: 12,
        }}>
          Historical Cadence — Last 8 Weeks
        </div>

        {data.cadence.length === 0 && (
          <div style={{ color: 'var(--t3)', fontFamily: 'var(--sans)', fontSize: 12 }}>
            No published posts yet
          </div>
        )}

        {data.cadence.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
              <thead>
                <tr>
                  <th style={CADENCE_TH_STYLE_LEFT}>Channel</th>
                  {data.weeks.map(w => (
                    <th key={w} style={CADENCE_TH_STYLE}>
                      {fmtWeek(w)}
                    </th>
                  ))}
                  <th style={CADENCE_TH_STYLE}>Total</th>
                </tr>
              </thead>
              <tbody>
                {data.cadence.map(ch => {
                  const total = ch.weeks.reduce((s, w) => s + w.count, 0);
                  return (
                    <tr key={ch.channel_id}>
                      <td style={CADENCE_TD_STYLE_LEFT}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            width: 8, height: 8, borderRadius: '50%',
                            background: ch.color, display: 'inline-block',
                          }} />
                          <span style={{ color: 'var(--text)' }}>{ch.channel_name}</span>
                        </span>
                      </td>
                      {ch.weeks.map(w => (
                        <td key={w.week} style={{
                          ...CADENCE_TD_STYLE,
                          color: w.count > 0 ? 'var(--text)' : 'var(--t3)',
                          fontWeight: w.count > 0 ? 600 : 400,
                        }}>
                          {w.count > 0 ? w.count : '·'}
                        </td>
                      ))}
                      <td style={{
                        ...CADENCE_TD_STYLE,
                        color: total > 0 ? '#F2CD1A' : 'var(--t3)', fontWeight: 700,
                      }}>
                        {total}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

const CADENCE_TH_STYLE_LEFT = {
  textAlign: 'left', padding: '6px 12px 6px 0',
  fontFamily: 'var(--sans)', fontSize: 10, color: 'var(--t3)',
  letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 400,
  borderBottom: '1px solid var(--b1)', whiteSpace: 'nowrap',
};
const CADENCE_TH_STYLE = {
  textAlign: 'center', padding: '6px 8px',
  fontFamily: 'var(--sans)', fontSize: 10, color: 'var(--t3)',
  letterSpacing: '.1em', textTransform: 'uppercase', fontWeight: 400,
  borderBottom: '1px solid var(--b1)', whiteSpace: 'nowrap', minWidth: 52,
};
const CADENCE_TD_STYLE_LEFT = {
  padding: '8px 12px 8px 0', borderBottom: '1px solid var(--b1)',
  whiteSpace: 'nowrap', fontFamily: 'var(--sans)',
};
const CADENCE_TD_STYLE = {
  textAlign: 'center', padding: '8px',
  borderBottom: '1px solid var(--b1)', fontFamily: 'var(--sans)',
};

function PostRow({ post, accentColor }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      padding: '10px 14px', background: 'var(--s1)',
      border: '1px solid var(--b1)', borderTop: `2px solid ${accentColor}`,
      borderRadius: 4, marginBottom: 6,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>
          {post.title}
        </div>
        <div style={{
          fontFamily: 'var(--sans)', fontSize: 11, color: 'var(--t3)',
          marginTop: 3, letterSpacing: '.05em',
        }}>
          {post.scheduled_date}
          {post.is_overdue && (
            <span style={{ marginLeft: 8, color: '#e04040', fontWeight: 600 }}>
              OVERDUE
            </span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        {(post.variants ?? []).map(v => (
          <span
            key={v.id}
            title={v.asset_url ? 'Asset uploaded' : 'No asset'}
            style={{
              width: 20, height: 20, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700,
              background: v.asset_url ? '#2eb86a22' : '#e0404022',
              color: v.asset_url ? '#2eb86a' : '#e04040',
            }}
          >
            {v.asset_url ? '✓' : '✗'}
          </span>
        ))}
        {(!post.variants || post.variants.length === 0) && (
          <span style={{ fontFamily: 'var(--sans)', fontSize: 10, color: 'var(--t3)' }}>
            no variants
          </span>
        )}
      </div>
    </div>
  );
}
