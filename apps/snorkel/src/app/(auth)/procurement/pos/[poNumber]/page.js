import PODetailClient from './PODetailClient.js';

export function generateStaticParams() {
  return [{ poNumber: 'sample' }];
}

export default function Page() {
  return <PODetailClient />;
}
