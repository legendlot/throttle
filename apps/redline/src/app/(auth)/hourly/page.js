'use client';
import { useState, useCallback } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { Spinner } from '@throttle/ui';
import { todayStr } from '@throttle/domain';
import { useAutoRefresh } from '../../../hooks/useAutoRefresh.js';
import { useRefreshState } from '../layout.js';

function fmt(n) { return n != null ? Number(n).toLocaleString('en-IN') : '0'; }

const LINE_ORDER  = ['L1', 'L2', 'L3'];
const LINE_COLORS = { L1: 'var(--yellow)', L2: 'var(--blue)', L3: 'var(--green)' };
const LINE_RGB    = { L1: '242,205,26',    L2: '33,60,226',   L3: '34,197,94'   };
const SHIFT_START = 9;
const SHIFT_END   = 18;

function HourlyProductionChart({ hourlyData, countField }) {
  if (!hourlyData || !hourlyData.length) {
    return (
      <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
        No data for selected date
      </div>
    );
  }

  const byLine = {};
  hourlyData.forEach(r => {
    if (!byLine[r.line]) byLine[r.line] = {};
    byLine[r.line][r.hour] = (byLine[r.line][r.hour] || 0) + (Number(r[countField]) || 0);
  });

  const nowIST     = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const currentHr  = nowIST.getHours();
  const maxDataHour = Math.max(SHIFT_END, ...hourlyData.map(r => Number(r.hour) || 0));
  const shiftHours  = Array.from({ length: maxDataHour - SHIFT_START + 1 }, (_, i) => i + SHIFT_START);
  const CELL_H = 56;

  const activeLines = LINE_ORDER.filter(l => byLine[l]);

  if (!activeLines.length) {
    return (
      <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--t3)', fontSize: 12 }}>
        No line data
      </div>
    );
  }

  return (
    <div>
      {activeLines.map((line, li) => {
        const data         = byLine[line] || {};
        const totalActual  = Object.values(data).reduce((s, v) => s + v, 0);
        const maxHourCount = Math.max(1, ...Object.values(data));
        const rgb          = LINE_RGB[line];
        const isLast       = li === activeLines.length - 1;

        return (
          <div key={line} style={{ padding: '12px 0', borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: LINE_COLORS[line], flexShrink: 0 }} />
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t1)' }}>{line}</span>
              </div>
              <span style={{ fontSize: 10, color: 'var(--t2)', fontFamily: 'var(--mono)' }}>
                {fmt(totalActual)} total
              </span>
            </div>

            <div style={{ display: 'flex', gap: 3 }}>
              {shiftHours.map(h => {
                const count     = data[h] || 0;
                const isFuture  = h > currentHr;
                const isOT      = h > SHIFT_END;
                const fillPct   = isFuture ? 0 : Math.min((count / maxHourCount) * 100, 100);
                const fillColor = (isFuture || count === 0)
                  ? 'transparent'
                  : `rgba(${rgb}, 0.55)`;
                const cellBorder = isFuture
                  ? `rgba(${rgb},.12)`
                  : `rgba(${rgb},.3)`;
                const numColor = fillPct > 45
                  ? '#fff'
                  : (isFuture ? 'var(--t3)' : LINE_COLORS[line]);
                const fontSize = count > 999 ? '8px' : count > 99 ? '9px' : '11px';

                return (
                  <div key={h} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                    <div style={{
                      width: '100%', height: CELL_H,
                      border: `1px solid ${cellBorder}`,
                      borderRadius: 3,
                      background: 'var(--surface3)',
                      position: 'relative', overflow: 'hidden',
                    }}>
                      <div style={{
                        position: 'absolute', bottom: 0, left: 0, right: 0,
                        height: `${fillPct}%`,
                        background: fillColor,
                        transition: 'height .3s',
                      }} />
                      <div style={{
                        position: 'absolute', inset: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize, fontWeight: 700, color: numColor,
                        fontFamily: 'var(--mono)', zIndex: 1,
                      }}>
                        {!isFuture && count > 0 ? fmt(count) : ''}
                      </div>
                    </div>
                    <div style={{ fontSize: 7, color: 'var(--t3)' }}>
                      {h}{isOT ? '⁺' : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Section({ label, total, children }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          padding: '10px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontFamily: 'var(--cond)', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)' }}>
            {label}
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>
            {fmt(total)}
          </span>
        </div>
        <div style={{ padding: '0 16px' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

export default function HourlyPage() {
  const { session }                     = useAuth();
  const { setRefreshing, setLastRefreshed } = useRefreshState();
  const [date,       setDate]       = useState(() => todayStr());
  const [hourlyData, setHourlyData] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);

  const loadData = useCallback(async () => {
    if (!session) return;
    setRefreshing(true);
    try {
      const data = await garageFetch('getHourlyProduction', { date }, session);
      setHourlyData(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e) {
      setError(e.message || 'Failed to load hourly data');
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLastRefreshed(
        new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
          hour12: true, timeZone: 'Asia/Kolkata',
        })
      );
    }
  }, [session, date, setRefreshing, setLastRefreshed]);

  useAutoRefresh(loadData, 30000, !session);

  const inwTotal    = hourlyData.reduce((s, r) => s + (Number(r.inw_count)     || 0), 0);
  const qcPassTotal = hourlyData.reduce((s, r) => s + (Number(r.qc_pass_count) || 0), 0);
  const pkgTotal    = hourlyData.reduce((s, r) => s + (Number(r.pkg_count)     || 0), 0);

  const dateInputStyle = {
    background: 'var(--surface2)', color: 'var(--t1)',
    border: '1px solid var(--border)', padding: '4px 8px',
    borderRadius: 3, fontFamily: 'var(--mono)', fontSize: 12,
  };
  const btnStyle = {
    padding: '4px 10px', background: 'transparent',
    border: '1px solid var(--border)', borderRadius: 3,
    color: 'var(--t2)', fontSize: 11, cursor: 'pointer',
    fontFamily: 'var(--mono)', letterSpacing: '0.04em',
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
        <Spinner />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <input
          type="date"
          style={dateInputStyle}
          value={date}
          onChange={e => setDate(e.target.value)}
        />
        <button style={btnStyle} onClick={() => setDate(todayStr())}>Today</button>
      </div>

      {error && (
        <div style={{ background: 'rgba(222,42,42,.1)', border: '1px solid rgba(222,42,42,.25)', borderRadius: 4, padding: '10px 14px', fontSize: 12, color: 'var(--red)', marginBottom: 16 }}>
          {error}
        </div>
      )}

      <Section label="Inward" total={inwTotal}>
        <HourlyProductionChart hourlyData={hourlyData} countField="inw_count" />
      </Section>

      <Section label="QC Pass" total={qcPassTotal}>
        <HourlyProductionChart hourlyData={hourlyData} countField="qc_pass_count" />
      </Section>

      <Section label="Packaging" total={pkgTotal}>
        <HourlyProductionChart hourlyData={hourlyData} countField="pkg_count" />
      </Section>
    </div>
  );
}
