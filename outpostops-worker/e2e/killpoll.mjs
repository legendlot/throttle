// Polls a signed /v/me from A2 every 2 s; prints the first refusal and the first recovery with timestamps.
import { call } from './lib.mjs';
const phase = process.argv[2] || 'kill';            // 'kill' = wait for refusal, 'unkill' = wait for recovery
const t0 = Date.now(); let n = 0;
while (Date.now() - t0 < 240_000) {
  const r = await call('A2', 'GET', '/v/me'); n++;
  const refused = r.status === 403;
  if ((phase === 'kill' && refused) || (phase === 'unkill' && r.ok)) {
    console.log(`${phase === 'kill' ? 'REFUSED' : 'RECOVERED'} after ${((Date.now() - t0) / 1000).toFixed(1)} s from poll start (poll ${n}) status=${r.status} error=${r.error} at ${new Date().toISOString()}`);
    process.exit(0);
  }
  await new Promise(res => setTimeout(res, 2000));
}
console.log('TIMEOUT'); process.exit(1);
