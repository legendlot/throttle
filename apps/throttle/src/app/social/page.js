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

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

  useEffect(() => { if (brandUser) loadStatic(); }, [brandUser]);
  useEffect(() => { if (brandUser) loadFeed();   }, [brandUser, currentMonth.year, currentMonth.month]);

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
      // Re-fetch the open post to refresh its variants list
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

  // Build calendar cells
  const { year, month } = currentMonth;
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  // Group posts by day-of-month
  const postsByDay = {};
  for (const p of feed) {
    if (!p.scheduled_date) continue;
    const dayNum = Number(p.scheduled_date.slice(8, 10));
    if (!postsByDay[dayNum]) postsByDay[dayNum] = [];
    postsByDay[dayNum].push(p);
  }

  return (
    <Layout>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 20, flexWrap: 'wrap', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={prevMonth} style={{
            background: 'transparent', border: '1px solid var(--b1)',
            color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 13,
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
            color: 'var(--t2)', fontFamily: 'var(--mono)', fontSize: 13,
            padding: '4px 10px', borderRadius: 4, cursor: 'pointer',
          }}>→</button>
          {loading && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)' }}>
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
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '.15em',
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
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)',
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
                    color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11,
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
                    fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t3)',
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
