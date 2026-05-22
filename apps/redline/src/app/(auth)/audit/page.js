'use client'
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@throttle/auth'
import { workerFetch } from '@throttle/db'

// ── Constants ────────────────────────────────────────────────────────────────

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
  critical: { dot: 'bg-red-400',    pill: 'bg-red-900/30 text-red-400 border-red-900',    btn: 'bg-red-900/30 text-red-400 border-red-700',    label: '🔴 Critical' },
  high:     { dot: 'bg-orange-400', pill: 'bg-orange-900/30 text-orange-400 border-orange-900', btn: 'bg-orange-900/30 text-orange-400 border-orange-700', label: '🟠 High'     },
  medium:   { dot: 'bg-yellow-400', pill: 'bg-yellow-900/30 text-yellow-400 border-yellow-900', btn: 'bg-yellow-900/30 text-yellow-400 border-yellow-700', label: '🟡 Medium'   },
  low:      { dot: 'bg-green-400',  pill: 'bg-green-900/30 text-green-400 border-green-900',  btn: 'bg-green-900/30 text-green-400 border-green-700',  label: '🟢 Low'      },
}

const STATUS_STYLES = {
  open:      'bg-indigo-900/30 text-indigo-400 border border-indigo-900',
  resolved:  'bg-green-900/30 text-green-400 border border-green-900',
  confirmed: 'bg-sky-900/30 text-sky-400 border border-sky-900',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg w-[480px] p-5">
        <h2 className="text-xs font-bold text-yellow-400 uppercase tracking-widest mb-4">
          Add Finding — R{roundNumber}
        </h2>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Line *</label>
            <select className="w-full bg-zinc-950 border border-zinc-700 text-zinc-200 text-xs px-2 py-2 rounded"
              value={form.line} onChange={e => set('line', e.target.value)}>
              <option value="">— select —</option>
              {LINES.map(l => <option key={l}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Category *</label>
            <select className="w-full bg-zinc-950 border border-zinc-700 text-zinc-200 text-xs px-2 py-2 rounded"
              value={form.category} onChange={e => set('category', e.target.value)}>
              <option value="">— select —</option>
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div className="mb-3">
          <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Severity *</label>
          <div className="grid grid-cols-4 gap-2">
            {Object.entries(SEV).map(([k, s]) => (
              <button key={k} onClick={() => set('severity', k)}
                className={`border text-xs py-2 rounded transition-colors ${
                  form.severity === k ? `${s.btn} border` : 'border-zinc-700 bg-zinc-950 text-zinc-500'
                }`}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-3">
          <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Description *</label>
          <textarea className="w-full bg-zinc-950 border border-zinc-700 text-zinc-200 text-xs px-2 py-2 rounded resize-none h-16"
            placeholder="What did you observe?"
            value={form.description} onChange={e => set('description', e.target.value)} />
        </div>

        <div className="mb-4">
          <label className="block text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Action Required</label>
          <select className="w-full bg-zinc-950 border border-zinc-700 text-zinc-200 text-xs px-2 py-2 rounded"
            value={form.action_required} onChange={e => set('action_required', e.target.value)}>
            {ACTIONS_REQUIRED.map(a => <option key={a}>{a}</option>)}
          </select>
        </div>

        {formErr && <p className="text-red-400 text-xs mb-3">{formErr}</p>}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose}
            className="border border-zinc-700 text-zinc-500 text-xs px-3 py-2 rounded">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="bg-yellow-400 text-black font-bold text-xs px-4 py-2 rounded disabled:opacity-50">
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
      <div className="flex items-center gap-3 mb-4">
        <input type="date" value={date} onChange={e => setDate(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 text-zinc-300 text-xs px-2 py-1.5 rounded" />
        <button onClick={handleNewRound}
          className="bg-yellow-400 text-black font-bold text-xs px-3 py-1.5 rounded">
          + Start New Round
        </button>
      </div>

      <div className="flex gap-3 mb-4">
        {[
          { val: rounds.length, lbl: 'Rounds today' },
          { val: critOpen,      lbl: 'Critical open', cls: 'text-red-400' },
          { val: highOpen,      lbl: 'High open',     cls: 'text-orange-400' },
          { val: totalFindings, lbl: 'Total findings' },
          { val: confirmed,     lbl: 'Confirmed',     cls: 'text-green-400' },
        ].map(({ val, lbl, cls }) => (
          <div key={lbl} className="bg-zinc-900 border border-zinc-800 rounded-md px-3 py-2">
            <div className={`text-xl font-bold ${cls || 'text-yellow-400'}`}>{val}</div>
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mt-0.5">{lbl}</div>
          </div>
        ))}
      </div>

      {rounds.length === 0 && (
        <p className="text-zinc-600 text-xs italic">No rounds for this date. Start one above.</p>
      )}

      {rounds.map(round => {
        const isActive   = !round.completed_at
        const isExpanded = expanded.has(round.id)
        const findings   = roundFindings[round.id] || []

        return (
          <div key={round.id} className="bg-zinc-900 border border-zinc-800 rounded-md mb-2 overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none"
              onClick={() => toggleExpand(round.id)}>
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${
                isActive ? 'bg-yellow-400 text-black' : 'bg-zinc-700 text-zinc-400'}`}>
                R{round.round_number}
              </span>
              <span className="text-zinc-500 text-[11px]">
                {fmtTime(round.started_at)}
                {round.completed_at ? ` – ${fmtTime(round.completed_at)}` : ''}
              </span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide ${
                isActive ? 'bg-green-900/30 text-green-400 border border-green-900'
                         : 'bg-zinc-800 text-zinc-500 border border-zinc-700'}`}>
                {isActive ? 'Active' : 'Closed'}
              </span>
              <div className="flex gap-1.5 ml-auto">
                {['critical', 'high', 'medium', 'low'].map(sev => {
                  const count = round[`${sev}_open`] || 0
                  if (!count) return null
                  return (
                    <span key={sev} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${SEV[sev].pill}`}>
                      {count} {sev.charAt(0).toUpperCase() + sev.slice(1)}
                    </span>
                  )
                })}
              </div>
              <span className="text-zinc-600 text-[11px] ml-2">{isExpanded ? '▲' : '▼'}</span>
            </div>

            {isExpanded && (
              <div className="border-t border-zinc-800">
                {loadingRound[round.id] ? (
                  <p className="text-zinc-600 text-xs italic px-4 py-3">Loading…</p>
                ) : findings.length === 0 ? (
                  <p className="text-zinc-600 text-xs italic px-4 py-3">No findings yet.</p>
                ) : (
                  findings.map(f => (
                    <div key={f.id} className="px-3 py-2 border-b border-zinc-800 last:border-0">
                      <div className="flex items-start gap-2">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${SEV[f.severity]?.dot}`} />
                        <span className="text-[10px] font-bold bg-blue-900/20 text-blue-400 border border-blue-900 px-1.5 py-0.5 rounded flex-shrink-0">{f.line}</span>
                        <span className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded flex-shrink-0 max-w-[160px] truncate">{f.category}</span>
                        <span className="flex-1 text-xs text-zinc-300 leading-snug">{f.description}</span>
                        {f.is_repeat && (
                          <span className="text-[10px] bg-amber-900/20 text-amber-400 border border-amber-900 px-1.5 py-0.5 rounded flex-shrink-0">↻ Repeat</span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide flex-shrink-0 ${STATUS_STYLES[f.status]}`}>{f.status}</span>
                      </div>
                      {f.resolution_note && (
                        <div className="mt-1.5 ml-4 pl-2 border-l-2 border-green-700 text-xs text-zinc-400">
                          <span className="text-green-500 font-semibold">Resolution: </span>{f.resolution_note}
                        </div>
                      )}
                    </div>
                  ))
                )}
                {isActive && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-zinc-950/50">
                    <button onClick={() => setAddModal({ roundId: round.id, roundNumber: round.round_number })}
                      className="border border-dashed border-yellow-600 text-yellow-400 text-[11px] px-3 py-1 rounded">
                      + Add Finding
                    </button>
                    <button onClick={() => handleCloseRound(round.id)} disabled={closingId === round.id}
                      className="ml-auto border border-zinc-700 text-zinc-500 text-[11px] px-3 py-1 rounded disabled:opacity-50">
                      {closingId === round.id ? 'Closing…' : 'Close Round'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <p className="text-zinc-600 text-[11px] italic mt-2">
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

  return (
    <div>
      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 mb-4">
        {[
          { key: 'line',     label: 'Line',     opts: LINES },
          { key: 'status',   label: 'Status',   opts: ['open', 'resolved', 'confirmed'] },
          { key: 'severity', label: 'Severity', opts: ['critical', 'high', 'medium', 'low'] },
        ].map(({ key, label, opts }) => (
          <select key={key}
            className="bg-zinc-900 border border-zinc-700 text-zinc-300 text-xs px-2 py-1.5 rounded"
            value={filters[key]} onChange={e => setFilter(key, e.target.value)}>
            <option value="">All {label}s</option>
            {opts.map(o => <option key={o} value={o}>{o.charAt(0).toUpperCase() + o.slice(1)}</option>)}
          </select>
        ))}
        <select
          className="bg-zinc-900 border border-zinc-700 text-zinc-300 text-xs px-2 py-1.5 rounded min-w-[180px]"
          value={filters.category} onChange={e => setFilter('category', e.target.value)}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="date" className="bg-zinc-900 border border-zinc-700 text-zinc-300 text-xs px-2 py-1.5 rounded"
          value={filters.from_date} onChange={e => setFilter('from_date', e.target.value)} />
        <input type="date" className="bg-zinc-900 border border-zinc-700 text-zinc-300 text-xs px-2 py-1.5 rounded"
          value={filters.to_date} onChange={e => setFilter('to_date', e.target.value)} />
      </div>

      {/* Per-line scorecards */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {['L1', 'L2', 'L3', 'All'].map(line => {
          const sc = scorecard(line)
          const openTotal = sc.critical + sc.high + sc.medium + sc.low
          const overdueAge = sc.oldest ? (Date.now() - sc.oldest) / 3600000 : 0
          const hasOverdue = sc.oldest && (
            sc.critical > 0 || sc.high > 0 ? overdueAge > 24 : overdueAge > 48
          )
          return (
            <div key={line} className={`bg-zinc-900 border rounded-md p-3 ${hasOverdue ? 'border-red-900' : 'border-zinc-800'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-zinc-300">{line}</span>
                {sc.oldest && (
                  <span className={`text-[10px] ${hasOverdue ? 'text-red-400' : 'text-zinc-500'}`}>
                    {ageLabel(new Date(sc.oldest))} oldest
                  </span>
                )}
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {[['critical', sc.critical], ['high', sc.high], ['medium', sc.medium], ['low', sc.low]].map(([sev, cnt]) =>
                  cnt > 0 ? (
                    <span key={sev} className={`text-[10px] px-1.5 py-0.5 rounded border ${SEV[sev].pill}`}>{cnt}</span>
                  ) : null
                )}
                {openTotal === 0 && <span className="text-zinc-600 text-[10px]">✓ Clear</span>}
              </div>
            </div>
          )
        })}
      </div>

      {/* Findings table */}
      {loading ? (
        <p className="text-zinc-600 text-xs italic">Loading findings…</p>
      ) : findings.length === 0 ? (
        <p className="text-zinc-600 text-xs italic">No findings match the current filters.</p>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-md overflow-hidden mb-6">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800">
                {['Sev', 'Line', 'Category · Description', 'Round', 'Age', 'Status', 'Action'].map(h => (
                  <th key={h} className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider px-3 py-2 text-left whitespace-nowrap">{h}</th>
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
                    <tr key={f.id} className={`border-b border-zinc-800 ${dimmed ? 'opacity-40' : ''}`}>
                      <td className="px-3 py-2.5">
                        <span className={`w-2 h-2 rounded-full inline-block ${SEV[f.severity]?.dot || 'bg-zinc-500'}`} />
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="text-[10px] font-bold bg-blue-900/20 text-blue-400 border border-blue-900 px-1.5 py-0.5 rounded">{f.line}</span>
                      </td>
                      <td className="px-3 py-2.5 max-w-xs">
                        <div className="text-[10px] text-zinc-500 mb-0.5 truncate">{f.category}</div>
                        <div className="text-zinc-300 leading-snug">{f.description}</div>
                        {f.is_repeat && (
                          <span className="text-[10px] bg-amber-900/20 text-amber-400 border border-amber-900 px-1 py-0.5 rounded mt-1 inline-block">
                            ↻ {f.recurrence_count > 1 ? `${f.recurrence_count}× in 30d` : 'Repeat'}
                          </span>
                        )}
                        {f.resolution_note && (
                          <div className="mt-1.5 pl-2 border-l-2 border-green-700 text-[11px] text-zinc-400">
                            <span className="text-green-500 font-semibold">Resolution: </span>{f.resolution_note}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-zinc-500 whitespace-nowrap">R{f.round_number}</td>
                      <td className={`px-3 py-2.5 whitespace-nowrap ${overdue ? 'text-red-400 font-semibold' : 'text-zinc-500'}`}>
                        {ageLabel(f.created_at)}
                      </td>
                      <td className="px-3 py-2.5">
                        {f.status === 'confirmed'
                          ? <span className="text-zinc-500 text-[10px]">Closed</span>
                          : <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide ${STATUS_STYLES[f.status]}`}>{f.status}</span>
                        }
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-col gap-1">
                          {f.status === 'open' && canManageFloor && !isRoundAuditor && (
                            <button
                              onClick={() => setResolveOpen(s => { const n = new Set(s); n.add(f.id); return n })}
                              className="text-[10px] border border-green-800 text-green-400 px-2 py-0.5 rounded hover:bg-green-900/20 whitespace-nowrap">
                              Mark Resolved
                            </button>
                          )}
                          {f.status === 'resolved' && (isRoundAuditor || isSuperAdmin) && (
                            <button onClick={() => handleConfirm(f.id)} disabled={saving[f.id]}
                              className="text-[10px] border border-sky-800 text-sky-400 px-2 py-0.5 rounded hover:bg-sky-900/20 disabled:opacity-50 whitespace-nowrap">
                              {saving[f.id] ? '…' : '✓ Confirm Fixed'}
                            </button>
                          )}
                          {f.status === 'resolved' && (isRoundAuditor || canManageFloor) && (
                            <button onClick={() => handleReopen(f.id)} disabled={saving[f.id]}
                              className="text-[10px] border border-zinc-700 text-zinc-400 px-2 py-0.5 rounded hover:bg-zinc-800 disabled:opacity-50 whitespace-nowrap">
                              {saving[f.id] ? '…' : 'Reopen'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {resolveFormOpen && (
                      <tr key={`resolve-${f.id}`} className="border-b border-zinc-800 bg-zinc-950/60">
                        <td colSpan={7} className="px-4 py-3">
                          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
                            What was done to fix this? (required)
                          </p>
                          <textarea
                            className="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs px-2 py-1.5 rounded resize-none h-14 mb-2"
                            placeholder="Describe the resolution…"
                            value={resolveDraft[f.id] || ''}
                            onChange={e => setResolveDraft(d => ({ ...d, [f.id]: e.target.value }))} />
                          <div className="flex gap-2">
                            <button onClick={() => handleResolve(f.id)} disabled={saving[f.id]}
                              className="bg-green-700 text-white text-[10px] font-bold px-3 py-1 rounded disabled:opacity-50">
                              {saving[f.id] ? 'Saving…' : 'Save Resolution'}
                            </button>
                            <button onClick={() => {
                              setResolveOpen(s => { const n = new Set(s); n.delete(f.id); return n })
                              setResolveDraft(d => { const n = { ...d }; delete n[f.id]; return n })
                            }} className="border border-zinc-700 text-zinc-500 text-[10px] px-3 py-1 rounded">
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
        <div className="bg-zinc-900 border border-zinc-800 rounded-md p-4">
          <h3 className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
            Repeat Offenders — Last 30 Days
          </h3>
          <div className="space-y-2">
            {repeatOffenders.map((o, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="text-yellow-400 font-bold text-sm w-6 flex-shrink-0">{o.occurrence_count}×</span>
                <span className="text-[10px] font-bold bg-blue-900/20 text-blue-400 border border-blue-900 px-1.5 py-0.5 rounded flex-shrink-0">{o.line}</span>
                <span className="text-xs text-zinc-300 flex-1 truncate">{o.category}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                  o.has_active
                    ? 'bg-orange-900/30 text-orange-400 border border-orange-900'
                    : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
                }`}>{o.has_active ? 'Active' : 'Resolved'}</span>
                <span className="text-[10px] text-zinc-600 flex-shrink-0">
                  {new Date(o.last_raised_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </span>
              </div>
            ))}
          </div>
        </div>
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
    <div className="min-h-screen bg-zinc-950 text-zinc-200 text-sm font-mono">
      <div className="bg-zinc-900 border-b border-zinc-800 px-5 py-3 flex items-center gap-4">
        <span className="text-yellow-400 font-bold text-sm uppercase tracking-widest">QC Audit</span>
        <div className="flex">
          {['log', 'tracker'].map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-[11px] uppercase tracking-widest border-b-2 transition-colors ${
                tab === t
                  ? 'border-yellow-400 text-yellow-400'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}>
              {t}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 py-4 max-w-5xl">
        {tab === 'log' ? (
          loading ? (
            <p className="text-zinc-600 text-xs italic">Loading…</p>
          ) : (
            <LogTab
              date={date} setDate={d => { setDate(d) }}
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
