'use client';
import { useEffect, useState } from 'react';
import { workerFetch } from '@throttle/db';

export const VALID_CONTENT_TYPES = {
  instagram: ['photo', 'carousel', 'reel', 'story'],
  linkedin:  ['post', 'article', 'video'],
  youtube:   ['video', 'short'],
};

const STATUS_COLORS = {
  idea:      '#888',
  draft:     'var(--t3)',
  approved:  '#2eb86a',
  published: '#0a66c2',
  cancelled: '#e04040',
};

function StatusPill({ status }) {
  return (
    <span style={{
      fontFamily: 'var(--mono)',
      fontSize: 9,
      letterSpacing: '.12em',
      textTransform: 'uppercase',
      padding: '2px 8px',
      borderRadius: 3,
      color: '#fff',
      background: STATUS_COLORS[status] ?? '#666',
      whiteSpace: 'nowrap',
    }}>
      {status}
    </span>
  );
}

function ChannelDot({ color, size = 8 }) {
  return (
    <span style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: color ?? '#888',
      flexShrink: 0,
      display: 'inline-block',
    }} />
  );
}

const PANEL_STYLE = {
  position: 'fixed',
  top: 48,
  right: 0,
  bottom: 0,
  width: 480,
  background: 'var(--s1)',
  borderLeft: '1px solid var(--b1)',
  zIndex: 60,
  overflowY: 'auto',
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

const OVERLAY_STYLE = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  zIndex: 55,
};

const LABEL_STYLE = {
  fontFamily: 'var(--head)',
  fontSize: 9,
  letterSpacing: '.25em',
  textTransform: 'uppercase',
  color: 'var(--t3)',
  marginBottom: 4,
};

const VALUE_STYLE = {
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--text)',
};

const INPUT_STYLE = {
  width: '100%',
  background: 'var(--s2)',
  border: '1px solid var(--b1)',
  borderRadius: 4,
  padding: '6px 10px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--text)',
  outline: 'none',
  boxSizing: 'border-box',
};

const PRIMARY_BUTTON = {
  background: '#F2CD1A',
  color: '#080808',
  fontFamily: 'var(--head)',
  fontWeight: 700,
  fontSize: 11,
  letterSpacing: '.15em',
  textTransform: 'uppercase',
  border: 'none',
  borderRadius: 4,
  padding: '8px 14px',
  cursor: 'pointer',
};

const GHOST_BUTTON = {
  background: 'transparent',
  color: 'var(--t2)',
  fontFamily: 'var(--mono)',
  fontSize: 11,
  letterSpacing: '.08em',
  border: '1px solid var(--b1)',
  borderRadius: 4,
  padding: '6px 10px',
  cursor: 'pointer',
};

// ── Platform previews ─────────────────────────────────────────────────────────

function InstagramPreview({ caption, handle }) {
  return (
    <div style={{
      border: '1px solid #dbdbdb', borderRadius: 8,
      background: '#fff', maxWidth: 340, fontFamily: '-apple-system, sans-serif',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', gap: 10 }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%', background: '#E4405F',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 13, fontWeight: 700,
        }}>L</div>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#000' }}>
          {handle?.replace('@', '') ?? 'legendoftoys'}
        </span>
      </div>
      <div style={{
        width: '100%', height: 180, background: '#f0f0f0',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#aaa', fontSize: 13,
      }}>
        Image / Video
      </div>
      <div style={{ padding: '10px 12px' }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: '#000' }}>
          {handle?.replace('@', '') ?? 'legendoftoys'}&nbsp;
        </span>
        <span style={{ fontSize: 13, color: '#000', whiteSpace: 'pre-wrap' }}>
          {caption
            ? caption.slice(0, 125) + (caption.length > 125 ? '… more' : '')
            : <span style={{ color: '#aaa' }}>Caption will appear here…</span>
          }
        </span>
      </div>
    </div>
  );
}

function LinkedInPreview({ caption, handle }) {
  return (
    <div style={{
      border: '1px solid #e0e0e0', borderRadius: 8,
      background: '#fff', maxWidth: 380, fontFamily: '-apple-system, sans-serif',
      overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 10 }}>
        <div style={{
          width: 40, height: 40, borderRadius: '50%', background: '#0A66C2',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#fff', fontSize: 16, fontWeight: 700,
        }}>L</div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#000' }}>Legend of Toys</div>
          <div style={{ fontSize: 12, color: '#666' }}>
            @{handle?.replace('@', '') ?? 'legendoftoys'} · Just now
          </div>
        </div>
      </div>
      <div style={{
        padding: '0 16px 12px', fontSize: 14, color: '#000',
        whiteSpace: 'pre-wrap', lineHeight: 1.5,
      }}>
        {caption
          ? caption.slice(0, 700) + (caption.length > 700 ? '… see more' : '')
          : <span style={{ color: '#aaa' }}>Post content will appear here…</span>
        }
      </div>
      <div style={{
        width: '100%', height: 160, background: '#f0f0f0',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#aaa', fontSize: 13,
      }}>
        Image / Video
      </div>
      <div style={{
        padding: '8px 16px', fontSize: 12, color: '#666',
        borderTop: '1px solid #e0e0e0', marginTop: 4,
      }}>
        👍 Like · 💬 Comment · ↗ Share
      </div>
    </div>
  );
}

function YouTubePreview({ caption, contentType, handle }) {
  return (
    <div style={{
      border: '1px solid #e0e0e0', borderRadius: 8,
      background: '#fff', maxWidth: 340, fontFamily: '-apple-system, sans-serif',
      overflow: 'hidden',
    }}>
      <div style={{
        width: '100%', height: 190, background: '#0f0f0f',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        color: '#fff', gap: 8,
      }}>
        <div style={{
          width: 48, height: 48, background: '#FF0000', borderRadius: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22,
        }}>▶</div>
        <span style={{ fontSize: 12, color: '#aaa' }}>
          {contentType === 'short' ? 'YouTube Short' : 'YouTube Video'}
        </span>
      </div>
      <div style={{ padding: '10px 12px' }}>
        <div style={{
          fontWeight: 600, fontSize: 13, color: '#000',
          lineHeight: 1.4, marginBottom: 4,
        }}>
          {caption
            ? caption.slice(0, 100) + (caption.length > 100 ? '…' : '')
            : <span style={{ color: '#aaa' }}>Video title / description…</span>
          }
        </div>
        <div style={{ fontSize: 12, color: '#606060' }}>
          @{handle?.replace('@', '') ?? 'legendoftoys'} · 0 views · Just now
        </div>
      </div>
    </div>
  );
}

export function PlatformPreview({ platform, contentType, caption, handle }) {
  if (platform === 'instagram') return <InstagramPreview caption={caption} handle={handle} />;
  if (platform === 'linkedin')  return <LinkedInPreview  caption={caption} handle={handle} />;
  if (platform === 'youtube')   return <YouTubePreview   caption={caption} contentType={contentType} handle={handle} />;
  return null;
}

// ── PostDetailPanel ───────────────────────────────────────────────────────────

const STATUS_FLOW = ['idea', 'draft', 'approved', 'published'];

function nextStatusFor(status, role) {
  const idx = STATUS_FLOW.indexOf(status);
  if (idx < 0 || idx >= STATUS_FLOW.length - 1) return null;
  const next = STATUS_FLOW[idx + 1];
  if (next === 'approved' && !['lead', 'admin'].includes(role)) return null;
  return next;
}

export function PostDetailPanel({ post, role, onClose, onEdit, onStatusChange, onPublishVariant, onDelete }) {
  if (!post) return null;
  const canEdit = role !== 'requester';
  const canDelete = ['lead', 'admin'].includes(role);
  const next = canEdit ? nextStatusFor(post.status, role) : null;

  return (
    <>
      <div style={OVERLAY_STYLE} onClick={onClose} />
      <div style={PANEL_STYLE}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <button onClick={onClose} style={{
            ...GHOST_BUTTON,
            padding: '4px 8px',
            fontSize: 14,
          }}>×</button>
          <h2 style={{
            flex: 1, margin: 0,
            fontFamily: 'var(--mono)', fontSize: 15, fontWeight: 600,
            color: 'var(--text)', lineHeight: 1.3,
          }}>
            {post.title}
          </h2>
          {canEdit && (
            <button onClick={() => onEdit(post)} style={GHOST_BUTTON}>Edit</button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <StatusPill status={post.status} />
          {next && (
            <button onClick={() => onStatusChange(post.id, next)} style={GHOST_BUTTON}>
              → {next}
            </button>
          )}
          {canEdit && post.status !== 'cancelled' && (
            <button onClick={() => onStatusChange(post.id, 'cancelled')} style={{
              ...GHOST_BUTTON,
              color: '#e04040',
              borderColor: 'rgba(224,64,64,0.4)',
            }}>Cancel post</button>
          )}
        </div>

        <Field label="Scheduled">
          <span style={VALUE_STYLE}>
            {post.scheduled_date}{post.scheduled_time ? ` · ${post.scheduled_time.slice(0, 5)}` : ''}
          </span>
        </Field>

        <Field label="Campaign">
          <span style={VALUE_STYLE}>{post.campaign?.name ?? post.campaign_name ?? '—'}</span>
        </Field>

        <Field label="Linked task">
          <span style={VALUE_STYLE}>
            {post.linked_task
              ? `${post.linked_task.title} (${post.linked_task.stage ?? post.linked_task.status ?? '—'})`
              : '—'}
          </span>
        </Field>

        <Field label="Product">
          <span style={VALUE_STYLE}>{post.product_code ?? '—'}</span>
        </Field>

        <Field label="Notes">
          <span style={{ ...VALUE_STYLE, whiteSpace: 'pre-wrap' }}>{post.notes ?? '—'}</span>
        </Field>

        <div style={{
          borderTop: '1px solid var(--b1)', paddingTop: 14,
          fontFamily: 'var(--head)', fontSize: 10, letterSpacing: '.25em',
          textTransform: 'uppercase', color: 'var(--t3)',
        }}>
          Channel Variants
        </div>
        {(post.variants ?? []).map(v => (
          <div key={v.id} style={{
            background: 'var(--s2)',
            border: '1px solid var(--b1)',
            borderRadius: 6,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <ChannelDot color={v.channel?.color} />
              <span style={{ ...VALUE_STYLE, fontWeight: 600 }}>{v.channel?.name ?? '—'}</span>
              <span style={{
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--t2)',
                background: 'var(--s3)', padding: '2px 6px', borderRadius: 3,
                letterSpacing: '.08em',
              }}>
                {v.content_type}
              </span>
              <StatusPill status={v.status} />
              {canEdit && v.status !== 'published' && (
                <button
                  onClick={() => onPublishVariant(v.id)}
                  style={{ ...GHOST_BUTTON, marginLeft: 'auto' }}
                >
                  Mark Published
                </button>
              )}
            </div>
            {v.caption_draft && (
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--t2)',
                whiteSpace: 'pre-wrap', lineHeight: 1.5,
              }}>
                {v.caption_draft}
              </div>
            )}
            {v.asset_url && (
              <a href={v.asset_url} target="_blank" rel="noreferrer" style={{
                fontFamily: 'var(--mono)', fontSize: 11, color: '#F2CD1A',
                wordBreak: 'break-all',
              }}>
                {v.asset_url}
              </a>
            )}
          </div>
        ))}

        {canDelete && (
          <div style={{ borderTop: '1px solid var(--b1)', paddingTop: 14, marginTop: 'auto' }}>
            <button
              onClick={() => {
                if (confirm(`Delete post "${post.title}"? This cannot be undone.`)) {
                  onDelete(post.id);
                }
              }}
              style={{
                ...GHOST_BUTTON,
                color: '#e04040',
                borderColor: 'rgba(224,64,64,0.4)',
              }}
            >
              Delete post
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div style={LABEL_STYLE}>{label}</div>
      {children}
    </div>
  );
}

// ── CreateEditPanel ───────────────────────────────────────────────────────────

function emptyVariant() {
  return { channel_id: '', content_type: '', caption_draft: '', asset_url: '' };
}

function postToForm(post) {
  return {
    title: post.title ?? '',
    scheduled_date: post.scheduled_date ?? '',
    scheduled_time: post.scheduled_time ? post.scheduled_time.slice(0, 5) : '',
    status: post.status ?? 'draft',
    campaign_id: post.campaign_id ?? '',
    task_id: post.task_id ?? '',
    product_code: post.product_code ?? '',
    notes: post.notes ?? '',
    variants: (post.variants ?? []).map(v => ({
      channel_id: v.channel_id,
      content_type: v.content_type,
      caption_draft: v.caption_draft ?? '',
      asset_url: v.asset_url ?? '',
    })),
  };
}

export function CreateEditPanel({ channels, campaigns, prefillDate, editPost, role, session, onClose, onSaved }) {
  const isEdit = !!editPost;
  const canApprove = ['lead', 'admin'].includes(role);

  const [form, setForm] = useState(() => isEdit
    ? postToForm(editPost)
    : {
        title: '',
        scheduled_date: prefillDate ?? '',
        scheduled_time: '',
        status: 'draft',
        campaign_id: '',
        task_id: '',
        product_code: '',
        notes: '',
        variants: [emptyVariant()],
      });

  const [previewOpen, setPreviewOpen] = useState({}); // index → bool
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  function update(field, value) {
    setForm(f => ({ ...f, [field]: value }));
  }

  function updateVariant(idx, field, value) {
    setForm(f => {
      const variants = f.variants.slice();
      variants[idx] = { ...variants[idx], [field]: value };
      // If channel changed, clear content_type so the user re-picks
      if (field === 'channel_id') variants[idx].content_type = '';
      return { ...f, variants };
    });
  }

  function addVariant() {
    setForm(f => ({ ...f, variants: [...f.variants, emptyVariant()] }));
  }

  function removeVariant(idx) {
    setForm(f => ({ ...f, variants: f.variants.filter((_, i) => i !== idx) }));
  }

  function togglePreview(idx) {
    setPreviewOpen(p => ({ ...p, [idx]: !p[idx] }));
  }

  const channelById = Object.fromEntries((channels ?? []).map(c => [c.id, c]));

  function validate() {
    if (!form.title.trim()) return 'Title is required';
    if (!form.scheduled_date) return 'Date is required';
    if (form.variants.length === 0) return 'At least one variant is required';
    for (const [i, v] of form.variants.entries()) {
      if (!v.channel_id) return `Variant ${i + 1}: pick a channel`;
      if (!v.content_type) return `Variant ${i + 1}: pick a content type`;
    }
    // Reject duplicate channels (DB has UNIQUE post_id+channel_id)
    const channelIds = form.variants.map(v => v.channel_id);
    if (new Set(channelIds).size !== channelIds.length) {
      return 'Each channel can only appear once per post';
    }
    return null;
  }

  async function handleSubmit() {
    const e = validate();
    if (e) { setError(e); return; }
    setError(null);
    setSubmitting(true);
    try {
      const variants = form.variants.map(v => ({
        channel_id: v.channel_id,
        content_type: v.content_type,
        caption_draft: v.caption_draft || null,
        asset_url:     v.asset_url     || null,
      }));
      const basePayload = {
        title: form.title.trim(),
        scheduled_date: form.scheduled_date,
        scheduled_time: form.scheduled_time || null,
        status:       form.status,
        campaign_id:  form.campaign_id || null,
        task_id:      form.task_id     || null,
        product_code: form.product_code || null,
        notes:        form.notes        || null,
      };
      if (isEdit) {
        await workerFetch('updateSocialPost', { post_id: editPost.id, ...basePayload, variants }, session);
      } else {
        await workerFetch('createSocialPost', { ...basePayload, variants }, session);
      }
      onSaved();
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div style={OVERLAY_STYLE} onClick={onClose} />
      <div style={PANEL_STYLE}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={onClose} style={{ ...GHOST_BUTTON, padding: '4px 8px', fontSize: 14 }}>×</button>
          <h2 style={{
            margin: 0, fontFamily: 'var(--head)', fontSize: 13,
            letterSpacing: '.2em', textTransform: 'uppercase', color: 'var(--text)',
          }}>
            {isEdit ? 'Edit Post' : 'New Post'}
          </h2>
        </div>

        <Field label="Title *">
          <input type="text" value={form.title} onChange={e => update('title', e.target.value)} style={INPUT_STYLE} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Date *">
            <input type="date" value={form.scheduled_date} onChange={e => update('scheduled_date', e.target.value)} style={INPUT_STYLE} />
          </Field>
          <Field label="Time">
            <input type="time" value={form.scheduled_time} onChange={e => update('scheduled_time', e.target.value)} style={INPUT_STYLE} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Status">
            <select value={form.status} onChange={e => update('status', e.target.value)} style={INPUT_STYLE}>
              <option value="idea">idea</option>
              <option value="draft">draft</option>
              {canApprove && <option value="approved">approved</option>}
              <option value="cancelled">cancelled</option>
            </select>
          </Field>
          <Field label="Campaign">
            <select value={form.campaign_id} onChange={e => update('campaign_id', e.target.value)} style={INPUT_STYLE}>
              <option value="">— none —</option>
              {(campaigns ?? []).map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Linked task (UUID)">
            <input
              type="text"
              value={form.task_id}
              onChange={e => update('task_id', e.target.value)}
              placeholder="optional"
              style={INPUT_STYLE}
            />
          </Field>
          <Field label="Product code">
            <input
              type="text"
              value={form.product_code}
              onChange={e => update('product_code', e.target.value)}
              placeholder="optional"
              style={INPUT_STYLE}
            />
          </Field>
        </div>

        <Field label="Notes">
          <textarea
            value={form.notes}
            onChange={e => update('notes', e.target.value)}
            rows={3}
            style={{ ...INPUT_STYLE, resize: 'vertical', fontFamily: 'var(--mono)' }}
          />
        </Field>

        <div style={{
          borderTop: '1px solid var(--b1)', paddingTop: 14,
          fontFamily: 'var(--head)', fontSize: 10, letterSpacing: '.25em',
          textTransform: 'uppercase', color: 'var(--t3)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span>Channel Variants</span>
          <button onClick={addVariant} style={GHOST_BUTTON}>+ Add Channel</button>
        </div>

        {form.variants.map((v, idx) => {
          const channel = channelById[v.channel_id];
          const platform = channel?.platform;
          const typeOptions = platform ? VALID_CONTENT_TYPES[platform] ?? [] : [];
          return (
            <div key={idx} style={{
              background: 'var(--s2)',
              border: '1px solid var(--b1)',
              borderRadius: 6,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'end' }}>
                <Field label="Channel">
                  <select value={v.channel_id} onChange={e => updateVariant(idx, 'channel_id', e.target.value)} style={INPUT_STYLE}>
                    <option value="">— pick —</option>
                    {(channels ?? []).map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Content type">
                  <select
                    value={v.content_type}
                    onChange={e => updateVariant(idx, 'content_type', e.target.value)}
                    disabled={!platform}
                    style={{ ...INPUT_STYLE, opacity: platform ? 1 : 0.5 }}
                  >
                    <option value="">— pick —</option>
                    {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Field>
                <button
                  onClick={() => removeVariant(idx)}
                  style={{ ...GHOST_BUTTON, color: '#e04040', borderColor: 'rgba(224,64,64,0.4)' }}
                  title="Remove this variant"
                >
                  ×
                </button>
              </div>

              <Field label="Caption">
                <textarea
                  value={v.caption_draft}
                  onChange={e => updateVariant(idx, 'caption_draft', e.target.value)}
                  rows={3}
                  style={{ ...INPUT_STYLE, resize: 'vertical', fontFamily: 'var(--mono)' }}
                />
              </Field>

              <Field label="Asset URL">
                <input
                  type="text"
                  value={v.asset_url}
                  onChange={e => updateVariant(idx, 'asset_url', e.target.value)}
                  placeholder="optional"
                  style={INPUT_STYLE}
                />
              </Field>

              {platform && (
                <button onClick={() => togglePreview(idx)} style={GHOST_BUTTON}>
                  {previewOpen[idx] ? '▲ Hide preview' : '▼ Preview'}
                </button>
              )}
              {previewOpen[idx] && platform && (
                <div style={{ marginTop: 6 }}>
                  <PlatformPreview
                    platform={platform}
                    contentType={v.content_type}
                    caption={v.caption_draft}
                    handle={channel?.handle}
                  />
                </div>
              )}
            </div>
          );
        })}

        {error && (
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11, color: '#e04040',
            background: 'rgba(222,42,42,0.08)', padding: '8px 10px',
            border: '1px solid rgba(222,42,42,0.3)', borderRadius: 4,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 'auto' }}>
          <button onClick={onClose} style={GHOST_BUTTON} disabled={submitting}>Cancel</button>
          <button onClick={handleSubmit} style={{ ...PRIMARY_BUTTON, opacity: submitting ? 0.5 : 1 }} disabled={submitting}>
            {submitting ? 'Saving…' : (isEdit ? 'Save changes' : 'Create post')}
          </button>
        </div>
      </div>
    </>
  );
}
