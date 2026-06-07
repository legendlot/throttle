// TODO: TD-005 — wire production_runs gate from G-W7
'use client';
import { useEffect, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@throttle/auth';
import { garageFetch } from '@throttle/db';
import { EmptyState } from '@throttle/ui';
import { RunsTable } from '../../../components/production-runs/RunsTable.js';
import { RunDetailPanel } from '../../../components/production-runs/RunDetailPanel.js';
import { RepairRunDetailPanel } from '../../../components/production-runs/RepairRunDetailPanel.js';

// Runs are now REQUESTED in Redline (New Run / Request). This Garage screen is the
// store-side VIEW + MANAGE surface: pick lists, receipt confirmation, reject/complete,
// and the outsourced Send-to-Vendor / Receive / Issue Finish Parts steps. No create path
// lives here any more (run-request consolidation, RULE-RUN-001).

export default function ProductionRunsPage() {
  const { session, perms } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
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

  // Deep-link: /production-runs?run=RUN-069 opens the run panel.
  // Used by the Issue Queue Recent Issues "RUN" link.
  useEffect(() => {
    const runNo = searchParams?.get('run');
    if (!runNo) return;
    setActivePanel({ type: 'run', runNo });
    // Strip the param so back-nav and refresh behave correctly
    router.replace(pathname, { scroll: false });
  }, [searchParams, pathname, router]);

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
          View and manage runs, confirm receipts, and run the outsourced send / receive / finish steps. Runs are requested in Redline (New Run / Request).
        </p>
      </div>

      {listError && (
        <div style={{ marginBottom: 16 }}>
          <EmptyState message={listError} />
        </div>
      )}

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
