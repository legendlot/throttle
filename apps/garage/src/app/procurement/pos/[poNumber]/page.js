import Stub from '@/components/Stub';

export function generateStaticParams() {
  return [{ poNumber: 'sample' }];
}

export default function Page({ params }) {
  return <Stub title="Purchase Order Detail" route={`/procurement/pos/${params.poNumber}`} />;
}
