'use client';
import PaymentList from './PaymentList.js';

export default function MyPaymentRequestsPage() {
  return (
    <PaymentList
      scope="mine"
      title="My Payment Requests"
      sub="Every request you've raised, and where it has got to — no need to ask."
      showNewCta
      emptyHint="Raise one from New Payment Request."
    />
  );
}
