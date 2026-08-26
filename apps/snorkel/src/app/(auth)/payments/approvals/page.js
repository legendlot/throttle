'use client';
import PaymentList from '../PaymentList.js';

export default function PaymentApprovalsPage() {
  return (
    <PaymentList
      scope="approvals"
      title="Approvals"
      sub="Requests at or above the approval threshold. Select several to approve in one go."
      bulkAction="approvePaymentRequests"
      bulkLabel="Approve selected"
      emptyHint="Nothing is waiting on you."
    />
  );
}
