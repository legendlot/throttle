'use client';
import { PageHead, Panel, EmptyState } from '@/components/ui.js';

export default function AnalyticsPage() {
  return (
    <div className="pg">
      <PageHead title="Analytics" sub="Delivery, engagement, and attribution across channels." />
      <Panel>
        <EmptyState icon="bar-chart-3" title="Coming in Phase 1" hint="Reporting lands in M7 — sends, opens, clicks, conversions within the attribution window." />
      </Panel>
    </div>
  );
}
