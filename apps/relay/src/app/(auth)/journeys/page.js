'use client';
import { PageHead, Panel, EmptyState } from '@/components/ui.js';

export default function JourneysPage() {
  return (
    <div className="pg">
      <PageHead title="Journeys" sub="Multi-step automated flows triggered by customer events." />
      <Panel>
        <EmptyState icon="arrow-right" title="Coming in Phase 1" hint="Journey orchestration arrives in M6 — triggers, waits, branches, send steps." />
      </Panel>
    </div>
  );
}
