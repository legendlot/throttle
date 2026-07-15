// Mould master (Snorkel mould procurement) — fetch helpers.
// Order-by-mould / receive-by-part: a mould produces N part codes at a fixed qty_per_shot;
// a PO line is one mould (qty = shots), and receiving explodes it into the part codes.
import { garageFetch, workerFetch } from '@throttle/db';

export function listMoulds(session) {
  return garageFetch('getMoulds', {}, session);
}
export function getMould(mould_no, session) {
  return garageFetch('getMould', { mould_no }, session);
}
export function createMould(data, session) {
  return workerFetch('createMould', { data }, session);
}
export function updateMould(data, session) {
  return workerFetch('updateMould', { data }, session);
}
export function setMouldParts(mould_no, parts, session) {
  return workerFetch('setMouldParts', { data: { mould_no, parts } }, session);
}
