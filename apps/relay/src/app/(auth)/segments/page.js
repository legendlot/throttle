'use client';
import { PageHead, Panel, EmptyState } from '@/components/ui.js';

export default function SegmentsPage() {
  return (
    <div className="pg">
      <PageHead title="Segments" sub="Reusable audience definitions over the contact substrate." />
      <Panel>
        <EmptyState icon="users" title="Coming in Phase 1" hint="Segment builder lands in M3 — rule groups over profiles, identifiers, and events." />
      </Panel>
    </div>
  );
}
