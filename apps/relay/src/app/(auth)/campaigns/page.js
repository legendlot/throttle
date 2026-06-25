'use client';
import { PageHead, Panel, EmptyState } from '@/components/ui.js';

export default function CampaignsPage() {
  return (
    <div className="pg">
      <PageHead title="Campaigns" sub="One-shot broadcasts across email, SMS, and WhatsApp." />
      <Panel>
        <EmptyState icon="send" title="Coming in Phase 1" hint="Campaign builder lands in M4 — audience pick, channel, schedule, approval." />
      </Panel>
    </div>
  );
}
