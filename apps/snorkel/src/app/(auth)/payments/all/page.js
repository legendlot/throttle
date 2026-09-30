'use client';
import PaymentList from '../PaymentList.js';

// Read-only list of every payment request, any requester, any status (Prarthi #bugs 1790749240).
// No bulkAction: approving / paying stays on Approvals and the Finance Queue.
export default function AllPaymentRequestsPage() {
  return (
    <PaymentList
      scope="all"
      title="All Payment Requests"
      sub="Every request raised by anyone, and where it has got to. View only — open one to see its invoice."
      emptyHint="No payment requests yet."
    />
  );
}
