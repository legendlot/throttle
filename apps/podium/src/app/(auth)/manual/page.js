'use client';
import { useMemo, useState } from 'react';
import { BookOpen, Download, Search, ChevronRight, ChevronDown } from 'lucide-react';
import manual from '../../../data/manual.json';

// Flatten parts → chapters with a running number + a plain-text summary derived
// from each chapter's html (no `summary` field in the data). Searchable by title
// AND summary, with the prototype's empty state. Click a chapter to expand its
// content inline; the real PDF stays one click away.
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

export default function ManualPage() {
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);

  const chapters = useMemo(() => {
    const out = [];
    let i = 0;
    for (const part of (manual.parts || [])) {
      for (const ch of (part.chapters || [])) {
        i += 1;
        const summary = stripHtml(ch.html).slice(0, 130);
        out.push({ id: ch.id, n: String(i).padStart(2, '0'), title: ch.title, part: part.part, summary: summary + (summary.length >= 130 ? '…' : ''), html: ch.html });
      }
    }
    return out;
  }, []);

  const mq = q.trim().toLowerCase();
  const filtered = mq ? chapters.filter(c => c.title.toLowerCase().includes(mq) || c.summary.toLowerCase().includes(mq) || (c.part || '').toLowerCase().includes(mq)) : chapters;

  return (
    <div style={{ maxWidth: 820 }}>
      {/* Header card */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: '18px 20px', marginBottom: 16 }}>
        <div style={{ width: 46, height: 46, borderRadius: 11, background: 'rgba(242,205,26,0.12)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
          <BookOpen size={22} color="var(--yellow)" strokeWidth={1.75} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{manual.title} {manual.title_accent}</div>
          <div style={{ fontSize: 12.5, color: 'var(--t2)' }}>Version <span className="num">{manual.version}</span>{manual.date ? <> · last updated <span className="num">{manual.date}</span></> : null}</div>
        </div>
        {manual.pdf && (
          <a href={manual.pdf} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--bg)', color: 'var(--t1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '8px 14px', fontFamily: 'var(--font-display)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            <Download size={14} strokeWidth={1.9} /> Download PDF
          </a>
        )}
      </div>

      {/* Search */}
      <label className="pd-input" style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 13px', marginBottom: 12 }}>
        <Search size={16} color="var(--t4)" strokeWidth={1.9} />
        <input data-search-primary value={q} onChange={e => setQ(e.target.value)} placeholder="Search the manual…"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--t1)', fontFamily: 'var(--font-ui)', fontSize: 13.5 }} />
      </label>

      {/* Chapter list */}
      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 11, overflow: 'hidden' }}>
        {filtered.map(c => {
          const expanded = openId === c.id;
          return (
            <div key={c.id} style={{ borderTop: '1px solid var(--hairline)' }}>
              <div className="pd-grid-row" onClick={() => setOpenId(expanded ? null : c.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 18px', cursor: 'pointer' }}>
                <span className="num" style={{ fontSize: 13, color: 'var(--yellow)', flex: 'none' }}>{c.n}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: 'var(--t-body)' }}>{c.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--t4)', marginTop: 2 }}>{c.summary}</div>
                </div>
                {expanded ? <ChevronDown size={15} color="var(--t4)" style={{ flex: 'none' }} /> : <ChevronRight size={15} color="var(--t4)" style={{ flex: 'none' }} />}
              </div>
              {expanded && (
                <div className="pd-manual-body" style={{ padding: '4px 18px 18px 52px', color: 'var(--t-body)', fontSize: 13.5, lineHeight: 1.6 }}
                  dangerouslySetInnerHTML={{ __html: c.html || '' }} />
              )}
            </div>
          );
        })}
        {filtered.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--t4)', fontSize: 13 }}>No chapters match that search.</div>}
      </div>
    </div>
  );
}
