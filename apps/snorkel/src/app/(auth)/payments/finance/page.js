'use client';
import PaymentList from '../PaymentList.js';

export default function FinanceQueuePage() {
  return (
    <PaymentList
      scope="finance"
      title="Finance Queue"
      sub="Approved and unpaid. Select several, add the UTR, and mark them paid together."
      bulkAction="markPaymentPaid"
      bulkLabel="Mark paid"
      emptyHint="Nothing approved is waiting to be paid."
    />
  );
}
