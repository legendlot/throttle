// TODO: TD-005 — wire production_runs gate from G-W7
'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { EmptyState } from '@throttle/ui';
import { FreshRunForm } from '../../../components/production-runs/FreshRunForm.js';
import { RepairRunForm } from '../../../components/production-runs/RepairRunForm.js';
import { RunsTable } from '../../../components/production-runs/RunsTable.js';
import { RunDetailPanel } from '../../../components/production-runs/RunDetailPanel.js';
import { RepairRunDetailPanel } from '../../../components/production-runs/RepairRunDetailPanel.js';

const panel = { backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4 };
const panelHdr = {
  padding: '10px 16px', borderBottom: '1px solid var(--border)',
  fontFamily: 'var(--cond)', fontWeight: 700, fontSize: 13,
  textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t2)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
};

function modeBtnStyle(active) {
  return {
    background: active ? 'var(--yellow)' : 'var(--surface2)',
    color: active ? '#000' : 'var(--t3)',
    border: active ? '1px solid var(--yellow)' : '1px solid var(--border)',
    borderRadius: 4, padding: '5px 12px',
    fontFamily: 'var(--mono)', fontSize: 11,
    textTransform: 'uppercase', letterSpacing: 1,
    cursor: 'pointer', fontWeight: active ? 700 : 500,
  };
}

export default function ProductionRunsPage() {
  const { session, perms } = useAuth();
  const [runMode, setRunMode] = useState('fresh');
  const [runs, setRuns] = useState([]);
  const [repairRuns, setRepairRuns] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState(null);
  const [filterStatus, setFilterStatus] = useState('');
  const [activePanel, setActivePanel] = useState(null);

  async function loadRuns() {
    if (!session) return;
    setListLoading(true);
    setListError(null);
    try {
      const params = filterStatus ? { status: filterStatus } : {};
      const [freshData, repairData] = await Promise.all([
        garageFetch('getProductionRuns', params, session),
        garageFetch('getRepairRunsDash', {}, session),
      ]);
      setRuns(Array.isArray(freshData) ? freshData : []);
      setRepairRuns(Array.isArray(repairData) ? repairData : []);
    } catch (e) {
      setListError(e.message || 'Failed to load runs');
    } finally {
      setListLoading(false);
    }
  }

  useEffect(() => {
    loadRuns();
  }, [session, filterStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activePanel) return;
    const t = setTimeout(() => {
      document.getElementById('pr-detail-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
    return () => clearTimeout(t);
  }, [activePanel]);

  function handleSelectRun(run) {
    setActivePanel({ type: 'run', runNo: run.run_no });
  }
  function handleSelectRepairRun(run) {
    setActivePanel({ type: 'repair', runId: run.id, runNo: run.run_no });
  }
  function handleRunChange(runNo) {
    loadRuns();
    if (runNo) setActivePanel({ type: 'run', runNo });
  }
  function handleRepairRunChange() {
    loadRuns();
    setActivePanel(null);
  }

  return (
    <div style={{ padding: '16px 24px', color: 'var(--t1)' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontFamily: 'var(--cond)', fontSize: 28, fontWeight: 900, textTransform: 'uppercase', letterSpacing: '0.03em', margin: 0 }}>
          Production Runs
        </h1>
        <p style={{ color: 'var(--t3)', fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)' }}>
          Plan and submit multi-variant production runs — store issues against the consolidated pick list.
        </p>
      </div>

      {listError && (
        <div style={{ marginBottom: 16 }}>
          <EmptyState message={listError} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1.05fr 0.95fr', gap: 16, alignItems: 'start' }}>
        <div>
          <div style={{ ...panel, marginBottom: 0 }}>
            <div style={panelHdr}>
              <span>New Run</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={modeBtnStyle(runMode === 'fresh')} onClick={() => setRunMode('fresh')}>Fresh</button>
                <button style={modeBtnStyle(runMode === 'repair')} onClick={() => setRunMode('repair')}>Repair</button>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 8 }}>
            {runMode === 'fresh'
              ? <FreshRunForm session={session} onSuccess={loadRuns} />
              : <RepairRunForm session={session} onSuccess={loadRuns} />}
          </div>
        </div>

        <RunsTable
          runs={runs}
          repairRuns={repairRuns}
          loading={listLoading}
          filterStatus={filterStatus}
          onFilterChange={setFilterStatus}
          onRefresh={loadRuns}
          onSelectRun={handleSelectRun}
          onSelectRepairRun={handleSelectRepairRun}
        />
      </div>

      {activePanel?.type === 'run' && (
        <RunDetailPanel
          runNo={activePanel.runNo}
          onClose={() => setActivePanel(null)}
          onRunChange={handleRunChange}
          session={session}
          perms={perms}
        />
      )}
      {activePanel?.type === 'repair' && (
        <RepairRunDetailPanel
          runId={activePanel.runId}
          runNo={activePanel.runNo}
          onClose={() => setActivePanel(null)}
          onRunChange={handleRepairRunChange}
          session={session}
        />
      )}
    </div>
  );
}
