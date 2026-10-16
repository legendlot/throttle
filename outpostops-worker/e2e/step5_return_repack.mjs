import { state, check, done, call, pack } from './lib.mjs';
const r = await pack('A1', 25, 'LOT-00522512', 'LOT-00522524');
check('returned unit (return_vendor) re-packs with the same stickers', r.ok, r);
const rw = await pack('A1', 25, 'LOT-00522513', 'LOT-00522525');
check('reworked-at-LOT unit cannot be re-packed by the vendor', !rw.ok, rw);
state.packs.returnedCtn = r.data?.carton?.ctn_no;
done();
