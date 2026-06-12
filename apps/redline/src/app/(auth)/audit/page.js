'use client'
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@throttle/auth'
import { workerFetch } from '@throttle/db'
import { Panel, StatusBadge, useEscapeClose } from '@throttle/ui'
import { FilterChip } from '../../../components/kit/index.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const LINES = ['L1', 'L2', 'L3', 'D1', 'D2', 'Store', 'Other']

const CATEGORIES = [
  'QC Pass — Damage',
  'QC Pass — Missing Part',
  'QC Pass — Wrong/Missing Sticker',
  'Assembly — Torque Issue',
  'Assembly — Wrong/Missing Part',
  'Packing — Wrong Method',
  'Packing — Missing Label',
  'SOP Deviation',
  'Physical Damage — Handling',
  'Housekeeping',
  'Material / Tooling',
  'Other',
]

const ACTIONS_REQUIRED = [
  'Need to verify QC on visual inspection',
  'Need to ensure before process start',
  'Need to ensure before packing',
  'Need to train operator',
  'Need to follow SOP / instruction',
  'Need to communicate to vendor',
  'Other',
]

const SEV = {
  critical: {
    dot:   'var(--red)',
    badge: { background: 'var(--bad-bg)', color: 'var(--bad-fg)',  border: '1px solid var(--bad-bd)' },
    btn:   { background: 'var(--bad-bg)', color: 'var(--bad-fg)',  border: '1px solid var(--bad-bd)' },
    label: 'Critical',
  },
  high: {
    dot:   'var(--orange)',
    badge: { background: 'rgba(249,115,22,0.12)', color: 'var(--orange)', border: '1px solid rgba(249,115,22,0.3)' },
    btn:   { background: 'rgba(249,115,22,0.12)', color: 'var(--orange)', border: '1px solid rgba(249,115,22,0.4)' },
    label: 'High',
  },
  medium: {
    dot:   'var(--amber)',
    badge: { background: 'var(--warn-bg)',  color: 'var(--warn-fg)', border: '1px solid var(--warn-bd)' },
    btn:   { background: 'var(--warn-bg)',  color: 'var(--warn-fg)', border: '1px solid var(--warn-bd)' },
    label: 'Medium',
  },
  low: {
    dot:   'var(--green)',
    badge: { background: 'var(--ok-bg)',  color: 'var(--ok-fg)',  border: '1px solid var(--ok-bd)' },
    btn:   { background: 'var(--ok-bg)',  color: 'var(--ok-fg)',  border: '1px solid var(--ok-bd)' },
    label: 'Low',
  },
}

const STATUS_BADGE = {
  open:      { background: 'rgba(99,102,241,0.12)', color: '#818cf8', border: '1px solid rgba(99,102,241,0.3)' },
  resolved:  { background: 'rgba(34,197,94,0.12)',  color: 'var(--green)', border: '1px solid rgba(34,197,94,0.3)' },
  confirmed: { background: 'rgba(56,189,248,0.12)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.3)' },
}

// ── Style constants ───────────────────────────────────────────────────────────

const S = {
  input:    { background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'var(--font-ui)' },
  select:   { background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'var(--font-ui)', cursor: 'pointer' },
  textarea: { background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--t1)', outline: 'none', fontFamily: 'var(--font-ui)', resize: 'none', width: '100%' },
  label:    { fontFamily: 'var(--font-display)', fontSize: 10, fontWeight: 600, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.16em', marginBottom: 6, display: 'block' },
  btnYellow:{ padding: '8px 14px', background: 'var(--yellow)', color: '#1a1a1a', border: '1px solid var(--yellow)', borderRadius: 'var(--r-sm)', fontFamily: 'var(--font-display)', fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', cursor: 'pointer' },
  btnGhost: { padding: '8px 14px', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)', color: 'var(--t2)', fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' },
  card:     { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' },
  badge:    { fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase', letterSpacing: '0.06em' },
  lineBadge:{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: 'rgba(33,60,226,0.18)', color: '#6882ff', border: '1px solid rgba(33,60,226,0.35)', flexShrink: 0 },
}

// Map severity to StatusBadge variant
const SEV_VARIANT = { critical: 'error', high: 'error', medium: 'warning', low: 'success' }
const SEV_LABEL   = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }
const STATUS_VARIANT = { open: 'info', resolved: 'success', confirmed: 'info' }

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function fmtTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function ageLabel(createdAt) {
  const hrs = (Date.now() - new Date(createdAt).getTime()) / 3600000
  if (hrs < 1) return '< 1h'
  if (hrs < 24) return `${Math.floor(hrs)}h`
  return `${Math.floor(hrs / 24)}d ${Math.floor(hrs % 24)}h`
}

function isOverdue(createdAt, severity) {
  const hrs = (Date.now() - new Date(createdAt).getTime()) / 3600000
  return severity === 'critical' || severity === 'high' ? hrs > 24 : hrs > 48
}

// ── AddFindingModal ───────────────────────────────────────────────────────────

function AddFindingModal({ roundId, roundNumber, session, onClose, onSaved }) {
  const [form, setForm] = useState({
    line: '', category: '', severity: '', description: '', action_required: ACTIONS_REQUIRED[0],
  })
  const [saving, setSaving] = useState(false)
  const [formErr, setFormErr] = useState('')

  useEscapeClose(true, onClose)

  function set(k, v) { setForm(f => ({ ...f, [k]: v })) }

  async function handleSave() {
    if (!form.line || !form.category || !form.severity || !form.description.trim()) {
      setFormErr('Line, Category, Severity, and Description are all required.')
      return
    }
    setSaving(true)
    setFormErr('')
    try {
      const { ok, data } = await workerFetch('addAuditFinding', {
        data: { round_id: roundId, ...form, description: form.description.trim() },
      }, session)
      if (!ok) throw new Error(data?.error || 'Save failed')
      onSaved()
      onClose()
    } catch (e) {
      setFormErr(e.message)
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 6, width: 480, padding: 20 }}>
        <h2 style={{ margin: '0 0 16px 0', fontFamily: 'var(--cond)', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--yellow)' }}>
          Add Finding — R{roundNumber}
        </h2>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={S.label}>Line *</label>
            <select style={{ ...S.select, width: '100%' }} value={form.line} onChange={e => set('line', e.target.value)}>
              <option value="">— select —</option>
              {LINES.map(l => <option key={l}>{l}</option>)}
            </select>
          </div>
          <div>
            <label style={S.label}>Category *</label>
            <select style={{ ...S.select, width: '100%' }} value={form.category} onChange={e => set('category', e.target.value)}>
              <option value="">— select —</option>
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>Severity *</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            {Object.entries(SEV).map(([k, s]) => (
              <button key={k} onClick={() => set('severity', k)}
                style={{
                  ...s.btn,
                  fontSize: 10, padding: '7px 4px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
                  fontWeight: form.severity === k ? 700 : 400,
                  opacity: form.severity && form.severity !== k ? 0.45 : 1,
                }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>Description *</label>
          <textarea style={{ ...S.textarea, height: 64 }}
            placeholder="What did you observe?"
            value={form.description} onChange={e => set('description', e.target.value)} />
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={S.label}>Action Required</label>
          <select style={{ ...S.select, width: '100%' }} value={form.action_required} onChange={e => set('action_required', e.target.value)}>
            {ACTIONS_REQUIRED.map(a => <option key={a}>{a}</option>)}
          </select>
        </div>

        {formErr && <p style={{ color: 'var(--red)', fontSize: 11, marginBottom: 12 }}>{formErr}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={S.btnGhost}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={{ ...S.btnYellow, opacity: saving ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Save Finding'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── LogTab ────────────────────────────────────────────────────────────────────

function LogTab({ date, setDate, rounds, session, userId, perms, onRefresh }) {
  const [expanded, setExpanded]           = useState(new Set())
  const [roundFindings, setRoundFindings] = useState({})
  const [loadingRound, setLoadingRound]   = useState({})
  const [addModal, setAddModal]           = useState(null)
  const [closingId, setClosingId]         = useState(null)

  useEffect(() => {
    const active = rounds.find(r => !r.completed_at)
    if (active) setExpanded(new Set([active.id]))
  }, [rounds])

  async function toggleExpand(roundId) {
    const next = new Set(expanded)
    if (next.has(roundId)) {
      next.delete(roundId)
    } else {
      next.add(roundId)
      if (!roundFindings[roundId]) {
        setLoadingRound(p => ({ ...p, [roundId]: true }))
        const { data } = await workerFetch('getAuditRoundDetail', { data: { round_id: roundId } }, session)
        setRoundFindings(p => ({ ...p, [roundId]: data?.findings || [] }))
        setLoadingRound(p => ({ ...p, [roundId]: false }))
      }
    }
    setExpanded(next)
  }

  async function handleNewRound() {
    const { ok, data } = await workerFetch('createAuditRound', { data: { round_date: date } }, session)
    if (!ok) { alert(data?.error || 'Failed to start round'); return }
    await onRefresh()
    if (data?.round?.id) setExpanded(new Set([data.round.id]))
  }

  async function handleCloseRound(roundId) {
    setClosingId(roundId)
    const { ok, data } = await workerFetch('closeAuditRound', { data: { round_id: roundId } }, session)
    if (!ok) alert(data?.error || 'Failed to close round')
    else await onRefresh()
    setClosingId(null)
  }

  async function handleFindingSaved(roundId) {
    setRoundFindings(p => { const n = { ...p }; delete n[roundId]; return n })
    setLoadingRound(p => ({ ...p, [roundId]: true }))
    const { data } = await workerFetch('getAuditRoundDetail', { data: { round_id: roundId } }, session)
    setRoundFindings(p => ({ ...p, [roundId]: data?.findings || [] }))
    setLoadingRound(p => ({ ...p, [roundId]: false }))
    onRefresh()
  }

  const totalFindings = rounds.reduce((s, r) => s + (r.total || 0), 0)
  const critOpen      = rounds.reduce((s, r) => s + (r.critical_open || 0), 0)
  const highOpen      = rounds.reduce((s, r) => s + (r.high_open || 0), 0)
  const confirmed     = rounds.reduce((s, r) => s + (r.confirmed_count || 0), 0)

  return (
    <div>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} style={S.input} />
        <button onClick={handleNewRound} style={S.btnYellow}>+ Start New Round</button>
      </div>

      {/* Day summary strip */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        {[
          { val: rounds.length, lbl: 'Rounds today',   color: 'var(--yellow)' },
          { val: critOpen,      lbl: 'Critical open',  color: 'var(--red)'    },
          { val: highOpen,      lbl: 'High open',      color: 'var(--orange)' },
          { val: totalFindings, lbl: 'Total findings', color: 'var(--yellow)' },
          { val: confirmed,     lbl: 'Confirmed',      color: 'var(--green)'  },
        ].map(({ val, lbl, color }) => (
          <div key={lbl} style={{ ...S.card, padding: '11px 15px', borderLeft: `3px solid ${color}` }}>
            <div className="num" style={{ fontSize: 24, fontWeight: 700, color: 'var(--t1)', lineHeight: 1 }}>{val}</div>
            <div className="eyebrow" style={{ marginTop: 5 }}>{lbl}</div>
          </div>
        ))}
      </div>

      {/* Empty state */}
      {rounds.length === 0 && (
        <p style={{ color: 'var(--t3)', fontSize: 12, fontStyle: 'italic' }}>No rounds for this date. Start one above.</p>
      )}

      {/* Round cards */}
      {rounds.map(round => {
        const isActive   = !round.completed_at
        const isExpanded = expanded.has(round.id)
        const findings   = roundFindings[round.id] || []

        return (
          <div key={round.id} style={{ ...S.card, marginBottom: 6, overflow: 'hidden' }}>
            {/* Round card header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', cursor: 'pointer', userSelect: 'none' }}
              onClick={() => toggleExpand(round.id)}>
              <span style={{
                fontFamily: 'var(--cond)', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 3,
                background: isActive ? 'var(--yellow)' : 'var(--surface3)',
                color: isActive ? '#000' : 'var(--t2)',
              }}>
                R{round.round_number}
              </span>
              <span style={{ fontSize: 11, color: 'var(--t2)' }}>
                {fmtTime(round.started_at)}
                {round.completed_at ? ` – ${fmtTime(round.completed_at)}` : ''}
              </span>
              {isActive
                ? <StatusBadge variant="success" icon="●">Active</StatusBadge>
                : <StatusBadge variant="neutral">Closed</StatusBadge>}
              <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                {['critical', 'high', 'medium', 'low'].map(sev => {
                  const count = round[`${sev}_open`] || 0
                  if (!count) return null
                  return (
                    <StatusBadge key={sev} variant={SEV_VARIANT[sev]}>
                      {count} {SEV_LABEL[sev]}
                    </StatusBadge>
                  )
                })}
              </div>
              <span style={{ fontSize: 10, color: 'var(--t3)', marginLeft: 6 }}>{isExpanded ? '▲' : '▼'}</span>
            </div>

            {/* Expanded content */}
            {isExpanded && (
              <div style={{ borderTop: '1px solid var(--border)' }}>
                {loadingRound[round.id] ? (
                  <p style={{ color: 'var(--t3)', fontSize: 11, fontStyle: 'italic', padding: '12px 16px' }}>Loading…</p>
                ) : findings.length === 0 ? (
                  <p style={{ color: 'var(--t3)', fontSize: 11, fontStyle: 'italic', padding: '12px 16px' }}>No findings yet.</p>
                ) : (
                  findings.map(f => (
                    <div key={f.id} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV[f.severity]?.dot || 'var(--t3)', flexShrink: 0, marginTop: 4 }} />
                        <span style={S.lineBadge}>{f.line}</span>
                        <span style={{ fontSize: 10, background: 'var(--surface2)', color: 'var(--t2)', padding: '2px 6px', borderRadius: 3, flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.category}</span>
                        <span style={{ flex: 1, fontSize: 12, color: 'var(--t1)', lineHeight: 1.4 }}>{f.description}</span>
                        {f.is_repeat && (
                          <StatusBadge variant="warning" icon="↻">Repeat</StatusBadge>
                        )}
                        <StatusBadge variant={STATUS_VARIANT[f.status] || 'neutral'}>{f.status}</StatusBadge>
                      </div>
                      {f.resolution_note && (
                        <div style={{ marginTop: 6, marginLeft: 16, paddingLeft: 8, borderLeft: '2px solid var(--green)', fontSize: 11, color: 'var(--t2)' }}>
                          <span style={{ color: 'var(--green)', fontWeight: 700 }}>Resolution: </span>{f.resolution_note}
                        </div>
                      )}
                    </div>
                  ))
                )}
                {/* Active round footer */}
                {isActive && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--surface2)' }}>
                    <button onClick={() => setAddModal({ roundId: round.id, roundNumber: round.round_number })}
                      style={{ background: 'transparent', border: '1px dashed rgba(242,205,26,0.5)', color: 'var(--yellow)', fontSize: 11, padding: '4px 12px', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit' }}>
                      + Add Finding
                    </button>
                    <button onClick={() => handleCloseRound(round.id)} disabled={closingId === round.id}
                      style={{ ...S.btnGhost, marginLeft: 'auto', opacity: closingId === round.id ? 0.5 : 1 }}>
                      {closingId === round.id ? 'Closing…' : 'Close Round'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <p style={{ color: 'var(--t3)', fontSize: 10, fontStyle: 'italic', marginTop: 8 }}>
        Closed rounds expand on click. Findings inside can still be resolved and confirmed.
      </p>

      {addModal && (
        <AddFindingModal
          roundId={addModal.roundId}
          roundNumber={addModal.roundNumber}
          session={session}
          onClose={() => setAddModal(null)}
          onSaved={() => handleFindingSaved(addModal.roundId)}
        />
      )}
    </div>
  )
}

// ── TrackerTab ────────────────────────────────────────────────────────────────

function TrackerTab({ session, userId, perms }) {
  const [findings, setFindings]               = useState([])
  const [repeatOffenders, setRepeatOffenders] = useState([])
  const [loading, setLoading]                 = useState(true)
  const [filters, setFilters]                 = useState({
    line: '', status: '', category: '', severity: '', from_date: '', to_date: '',
  })
  const [resolveOpen, setResolveOpen]   = useState(new Set())
  const [resolveDraft, setResolveDraft] = useState({})
  const [saving, setSaving]             = useState({})

  const canManageFloor = perms?.users_manage || perms?.production_view || perms?.procurement_approve
  const isSuperAdmin   = perms?.super_admin

  const load = useCallback(async () => {
    setLoading(true)
    const [fRes, rRes] = await Promise.all([
      workerFetch('getAuditFindings', { data: filters }, session),
      workerFetch('getRepeatOffenders', { data: {} }, session),
    ])
    setFindings(fRes.data?.findings || [])
    setRepeatOffenders(rRes.data?.offenders || [])
    setLoading(false)
  }, [filters, session])

  useEffect(() => { load() }, [load])

  function setFilter(k, v) { setFilters(f => ({ ...f, [k]: v })) }

  function scorecard(line) {
    const subset = line === 'All' ? findings : findings.filter(f => f.line === line)
    const open   = subset.filter(f => f.status === 'open')
    const oldest = open.length ? Math.min(...open.map(f => new Date(f.created_at).getTime())) : null
    return {
      critical: open.filter(f => f.severity === 'critical').length,
      high:     open.filter(f => f.severity === 'high').length,
      medium:   open.filter(f => f.severity === 'medium').length,
      low:      open.filter(f => f.severity === 'low').length,
      oldest,
    }
  }

  async function handleResolve(findingId) {
    const note = (resolveDraft[findingId] || '').trim()
    if (!note) { alert('Resolution note is required — describe what was done to fix this.'); return }
    setSaving(s => ({ ...s, [findingId]: true }))
    const { ok, data } = await workerFetch('resolveAuditFinding', {
      data: { finding_id: findingId, resolution_note: note },
    }, session)
    setSaving(s => ({ ...s, [findingId]: false }))
    if (!ok) { alert(data?.error || 'Failed to resolve'); return }
    setResolveOpen(s => { const n = new Set(s); n.delete(findingId); return n })
    setResolveDraft(d => { const n = { ...d }; delete n[findingId]; return n })
    load()
  }

  async function handleConfirm(findingId) {
    setSaving(s => ({ ...s, [findingId]: true }))
    const { ok, data } = await workerFetch('confirmAuditFinding', { data: { finding_id: findingId } }, session)
    setSaving(s => ({ ...s, [findingId]: false }))
    if (!ok) alert(data?.error || 'Failed to confirm')
    else load()
  }

  async function handleReopen(findingId) {
    setSaving(s => ({ ...s, [findingId]: true }))
    const { ok, data } = await workerFetch('reopenAuditFinding', { data: { finding_id: findingId } }, session)
    setSaving(s => ({ ...s, [findingId]: false }))
    if (!ok) alert(data?.error || 'Failed to reopen')
    else load()
  }

  const thStyle = { fontSize: 9, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '8px 12px', textAlign: 'left', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' }
  const tdStyle = { padding: '10px 12px', verticalAlign: 'top', borderBottom: '1px solid var(--border)' }

  return (
    <div>
      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'line',     label: 'Line',     opts: LINES },
          { key: 'status',   label: 'Status',   opts: ['open', 'resolved', 'confirmed'] },
          { key: 'severity', label: 'Severity', opts: ['critical', 'high', 'medium', 'low'] },
        ].map(({ key, label, opts }) => (
          <select key={key} style={S.select} value={filters[key]} onChange={e => setFilter(key, e.target.value)}>
            <option value="">All {label}s</option>
            {opts.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
          </select>
        ))}
        <select style={{ ...S.select, minWidth: 180 }} value={filters.category} onChange={e => setFilter('category', e.target.value)}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="date" style={S.input} value={filters.from_date} onChange={e => setFilter('from_date', e.target.value)} />
        <input type="date" style={S.input} value={filters.to_date}   onChange={e => setFilter('to_date',   e.target.value)} />
      </div>

      {/* Per-line scorecards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        {['L1', 'L2', 'L3', 'All'].map(line => {
          const sc = scorecard(line)
          const openTotal  = sc.critical + sc.high + sc.medium + sc.low
          const overdueAge = sc.oldest ? (Date.now() - sc.oldest) / 3600000 : 0
          const hasOverdue = sc.oldest && (sc.critical > 0 || sc.high > 0 ? overdueAge > 24 : overdueAge > 48)
          return (
            <div key={line} style={{ ...S.card, padding: 12, borderColor: hasOverdue ? 'rgba(222,42,42,0.5)' : 'var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontFamily: 'var(--cond)', fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{line}</span>
                {sc.oldest && (
                  <span style={{ fontSize: 10, color: hasOverdue ? 'var(--red)' : 'var(--t3)' }}>
                    {ageLabel(new Date(sc.oldest))} oldest
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {[['critical', sc.critical], ['high', sc.high], ['medium', sc.medium], ['low', sc.low]].map(([sev, cnt]) =>
                  cnt > 0 ? (
                    <StatusBadge key={sev} variant={SEV_VARIANT[sev]}>{cnt}</StatusBadge>
                  ) : null
                )}
                {openTotal === 0 && <span style={{ fontSize: 10, color: 'var(--t3)' }}>✓ Clear</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* Findings table */}
      {loading ? (
        <p style={{ color: 'var(--t3)', fontSize: 12, fontStyle: 'italic' }}>Loading findings…</p>
      ) : findings.length === 0 ? (
        <p style={{ color: 'var(--t3)', fontSize: 12, fontStyle: 'italic' }}>No findings match the current filters.</p>
      ) : (
        <div style={{ ...S.card, overflow: 'hidden', marginBottom: 24 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                {['Sev', 'Line', 'Category · Description', 'Round', 'Age', 'Status', 'Action'].map(h => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {findings.map(f => {
                const isRoundAuditor  = f.round_auditor_id === userId
                const overdue         = f.status === 'open' && isOverdue(f.created_at, f.severity)
                const dimmed          = f.status === 'confirmed'
                const resolveFormOpen = resolveOpen.has(f.id)

                return (
                  <>
                    <tr key={f.id} style={{ opacity: dimmed ? 0.4 : 1 }}>
                      <td style={tdStyle}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: SEV[f.severity]?.dot || 'var(--t3)', display: 'inline-block' }} />
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                        <span style={S.lineBadge}>{f.line}</span>
                      </td>
                      <td style={{ ...tdStyle, maxWidth: 320 }}>
                        <div style={{ fontSize: 10, color: 'var(--t3)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.category}</div>
                        <div style={{ color: 'var(--t1)', lineHeight: 1.4 }}>{f.description}</div>
                        {f.is_repeat && (
                          <div style={{ marginTop: 4, display: 'inline-block' }}>
                            <StatusBadge variant="warning" icon="↻">
                              {f.recurrence_count > 1 ? `${f.recurrence_count}× in 30d` : 'Repeat'}
                            </StatusBadge>
                          </div>
                        )}
                        {f.resolution_note && (
                          <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--green)', fontSize: 11, color: 'var(--t2)' }}>
                            <span style={{ color: 'var(--green)', fontWeight: 700 }}>Resolution: </span>{f.resolution_note}
                          </div>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--t2)', whiteSpace: 'nowrap' }}>R{f.round_number}</td>
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap', color: overdue ? 'var(--red)' : 'var(--t2)', fontWeight: overdue ? 700 : 400 }}>
                        {ageLabel(f.created_at)}
                      </td>
                      <td style={tdStyle}>
                        {f.status === 'confirmed'
                          ? <StatusBadge variant="neutral">Closed</StatusBadge>
                          : <StatusBadge variant={STATUS_VARIANT[f.status] || 'neutral'}>{f.status}</StatusBadge>
                        }
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {f.status === 'open' && canManageFloor && !isRoundAuditor && (
                            <button
                              onClick={() => setResolveOpen(s => { const n = new Set(s); n.add(f.id); return n })}
                              style={{ ...S.badge, ...{ background: 'rgba(34,197,94,0.1)', color: 'var(--green)', border: '1px solid rgba(34,197,94,0.3)' }, padding: '4px 8px', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                              Mark Resolved
                            </button>
                          )}
                          {f.status === 'resolved' && (isRoundAuditor || isSuperAdmin) && (
                            <button onClick={() => handleConfirm(f.id)} disabled={saving[f.id]}
                              style={{ ...S.badge, background: 'rgba(56,189,248,0.1)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.3)', padding: '4px 8px', cursor: 'pointer', fontFamily: 'inherit', opacity: saving[f.id] ? 0.5 : 1, whiteSpace: 'nowrap' }}>
                              {saving[f.id] ? '…' : '✓ Confirm Fixed'}
                            </button>
                          )}
                          {f.status === 'resolved' && (isRoundAuditor || canManageFloor) && (
                            <button onClick={() => handleReopen(f.id)} disabled={saving[f.id]}
                              style={{ ...S.badge, background: 'transparent', color: 'var(--t2)', border: '1px solid var(--border)', padding: '4px 8px', cursor: 'pointer', fontFamily: 'inherit', opacity: saving[f.id] ? 0.5 : 1, whiteSpace: 'nowrap' }}>
                              {saving[f.id] ? '…' : 'Reopen'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {resolveFormOpen && (
                      <tr key={`resolve-${f.id}`}>
                        <td colSpan={7} style={{ padding: '12px 16px', background: 'var(--surface2)', borderBottom: '1px solid var(--border)' }}>
                          <p style={{ ...S.label, marginBottom: 6 }}>What was done to fix this? (required)</p>
                          <textarea style={{ ...S.textarea, height: 56, marginBottom: 8 }}
                            placeholder="Describe the resolution…"
                            value={resolveDraft[f.id] || ''}
                            onChange={e => setResolveDraft(d => ({ ...d, [f.id]: e.target.value }))} />
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button onClick={() => handleResolve(f.id)} disabled={saving[f.id]}
                              style={{ background: 'var(--green)', color: '#000', fontWeight: 700, fontSize: 11, padding: '5px 12px', border: 'none', borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit', opacity: saving[f.id] ? 0.5 : 1 }}>
                              {saving[f.id] ? 'Saving…' : 'Save Resolution'}
                            </button>
                            <button onClick={() => {
                              setResolveOpen(s => { const n = new Set(s); n.delete(f.id); return n })
                              setResolveDraft(d => { const n = { ...d }; delete n[f.id]; return n })
                            }} style={S.btnGhost}>
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Repeat Offenders panel */}
      {repeatOffenders.length > 0 && (
        <Panel header="Repeat Offenders — Last 30 Days">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {repeatOffenders.map((o, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontFamily: 'var(--cond)', fontSize: 18, fontWeight: 800, color: 'var(--yellow)', width: 28, flexShrink: 0 }}>{o.occurrence_count}×</span>
                <span style={S.lineBadge}>{o.line}</span>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.category}</span>
                {o.has_active
                  ? <StatusBadge variant="warning">Active</StatusBadge>
                  : <StatusBadge variant="neutral">Resolved</StatusBadge>}
                <span style={{ fontSize: 10, color: 'var(--t3)', flexShrink: 0 }}>
                  {new Date(o.last_raised_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}

// ── AuditPage ─────────────────────────────────────────────────────────────────

export default function AuditPage() {
  const { session, user, perms } = useAuth()
  const userId = user?.id

  const [tab, setTab]         = useState('log')
  const [date, setDate]       = useState(todayIST())
  const [rounds, setRounds]   = useState([])
  const [loading, setLoading] = useState(true)

  const loadRounds = useCallback(async () => {
    if (!session) return
    setLoading(true)
    const { data } = await workerFetch('getAuditRounds', { data: { date } }, session)
    setRounds(data?.rounds || [])
    setLoading(false)
  }, [date, session])

  useEffect(() => { loadRounds() }, [loadRounds])

  return (
    <div style={{ color: 'var(--t1)', fontFamily: 'var(--font-ui)' }}>
      {/* tab bar — topbar already titles this screen "Audit" */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {[['log', 'Inspection Log'], ['tracker', 'Findings Tracker']].map(([t, lbl]) => (
          <FilterChip key={t} active={tab === t} onClick={() => setTab(t)}>{lbl}</FilterChip>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ maxWidth: 1100 }}>
        {tab === 'log' ? (
          loading ? (
            <p style={{ color: 'var(--t3)', fontSize: 12, fontStyle: 'italic' }}>Loading…</p>
          ) : (
            <LogTab
              date={date} setDate={d => setDate(d)}
              rounds={rounds}
              session={session} userId={userId} perms={perms}
              onRefresh={loadRounds}
            />
          )
        ) : (
          <TrackerTab session={session} userId={userId} perms={perms} />
        )}
      </div>
    </div>
  )
}
