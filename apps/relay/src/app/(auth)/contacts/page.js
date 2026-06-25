'use client';
import { PageHead, Panel, EmptyState } from '@/components/ui.js';

export default function ContactsPage() {
  return (
    <div className="pg">
      <PageHead title="Contacts" sub="The unified profile substrate — identities, identifiers, consent." />
      <Panel>
        <EmptyState icon="inbox" title="Coming in Phase 1" hint="Contact explorer lands in M2 — profiles, merged identifiers, event timeline, consent state." />
      </Panel>
    </div>
  );
}
