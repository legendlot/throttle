'use client';
import { PageHead, Panel, EmptyState } from '@/components/ui.js';

export default function TemplatesPage() {
  return (
    <div className="pg">
      <PageHead title="Templates" sub="Channel-specific message templates with merge variables." />
      <Panel>
        <EmptyState icon="file-text" title="Coming in Phase 1" hint="Template editor lands in M4 — email HTML, SMS body, WhatsApp template registration." />
      </Panel>
    </div>
  );
}
