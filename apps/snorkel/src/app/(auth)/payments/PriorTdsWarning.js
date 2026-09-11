'use client';
import { fmtDateShort } from '@/components/format.js';
import { money } from './PaymentList.js';

// Amber note beside the TDS rate input on BOTH Mark-paid surfaces (finance queue card + the
// detail page's modal). `prior` is the worker's `prior_tds` — OTHER requests on the same invoice
// that already carry a deduction (snorkelops priorTdsFor). TDS is computed on the full
// invoice_total, so a rate on a second tranche deducts it again (PAY-0010 shape). Warning only:
// the correct base is open with Finance, so nothing here blocks or changes the amount.
// Renders nothing when there is no prior deduction — the common case must look as before.
export default function PriorTdsWarning({ prior, currency, style }) {
  if (!prior?.length) return null;
  return (
    <div style={{
      padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
      background: 'var(--warn-bg, #fff7ed)', border: '1px solid var(--warn-br, #fdba74)',
      color: 'var(--warn-fg, #9a3412)', ...style,
    }}>
      <strong>TDS already deducted on this invoice:</strong>
      {prior.map(p => (
        <div key={p.request_no}>
          {p.request_no} · {p.tds_amount != null ? money(p.tds_amount, currency) : 'amount not recorded'}
          {p.tds_rate != null ? ` (${Number(p.tds_rate)}%)` : ''}
          {p.paid_at ? ` · paid ${fmtDateShort(p.paid_at)}` : ''}
        </div>
      ))}
      Entering a rate here deducts TDS again on the full invoice value.
    </div>
  );
}
