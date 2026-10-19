// /v/pack request shape (O3; O12 S428: the work order is optional). Pure — no I/O — so it is unit-tested.
// With no order the car sticker names the SKU and the bench sends its packaging type; the request hash then covers the
// packaging. An order's request hash is unchanged from before O12 (a retried key across the deploy still replays).
export const PACK_TYPES = ['ecom', 'retail', 'export'];

export function packRequest(body) {
  const b = body || {};
  const noOrder = b.work_order_id == null || b.work_order_id === '';
  const v = b.work_order_id;
  const woId = noOrder ? null
    : (typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^\d{1,15}$/.test(v)) ? Number(v) : NaN;
  if (!noOrder && !(woId > 0)) return { error: 'work_order_id must be an order id' };
  if (noOrder && !PACK_TYPES.includes(b.pack_type)) return { error: 'choose the packaging (ecom, retail or export)' };
  if (typeof b.car_upc !== 'string' || typeof b.remote_upc !== 'string') return { error: 'car_upc and remote_upc required' };
  return {
    woId,
    packType: noOrder ? b.pack_type : null,
    hashed: noOrder ? { work_order_id: null, pack_type: b.pack_type, car_upc: b.car_upc, remote_upc: b.remote_upc }
                    : { work_order_id: woId, car_upc: b.car_upc, remote_upc: b.remote_upc },
  };
}

// The two unique indexes that mean "another first-pack opened this bench's carton a moment ago — retry the same key".
export const OPEN_CARTON_RACE_RE = /cartons_one_open_per_bench_(order|sku)/;
