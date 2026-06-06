'use client';
import Layout from '@/components/Layout';
import { Manual } from '@throttle/ui';
import manual from '../../data/manual.json';

export default function ManualPage() {
  // Throttle's top-nav shell is 52px; bleed past <main>'s 24px/20px padding and
  // give the viewer a fixed viewport-height container (it manages its own scroll).
  return (
    <Layout>
      <div style={{ height: 'calc(100dvh - 52px)', margin: '-24px -20px' }}>
        <Manual manual={manual} bleed={false} />
      </div>
    </Layout>
  );
}
