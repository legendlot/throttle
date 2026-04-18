import Stub from '@/components/Stub';

export function generateStaticParams() {
  return [{ shipmentId: 'sample' }];
}

export default function Page({ params }) {
  return <Stub title="Receiving Detail" route={`/receiving/${params.shipmentId}`} />;
}
