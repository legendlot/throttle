// Hiring O1 — the pure offer-link rules in src/offerlink.js (token, name match, D6 live link, D7 link state, MIME,
// bank validator, document paths) + the certificate page. Synthetic names and no figures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import {
  newLinkToken, hashLinkToken, linkTokenShapeOk, normName, namesMatch, firstName, DECLINE_REASONS, isLinkLive, linkState,
  linkDbErrorCode, buildOfferMime, encodeHeaderWords, offerSubject, offerMessageId, renderOfferEmail, renderConfirmationEmail,
  renderAlertEmail, OFFER_BUTTON, LINK_DOC_TYPES, LINK_DOC_TYPE_KEYS, candidateLinkDocPath, checkCandidateLinkDocPath,
  validateCandidateBank, maskAccount, certificateLines, istStamp, PREPARING_NOTICE, renderOfferCopyEmail, renderConfirmationCopyEmail,
  MAIL_KINDS, splitOfferRecipients, threadKindsFor, reconcileDue, reconcileDecision, RECONCILE_GAP_MS, newPathNonce, acceptedPdfPath,
} from '../src/offerlink.js';
import { appendCertificatePage } from '../src/offer-render.js';
import { CANDIDATE_DOC_TYPES } from '../src/hiring.js';
const SQL = readFileSync(new URL('../migrations/0012_offer_link.sql', import.meta.url), 'utf8');

const CID = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

// ── token ──
test('a link token is 43 base64url chars of 32 random bytes; only its sha256 hex is stored', async () => {
  const a = newLinkToken(), b = newLinkToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(linkTokenShapeOk(a), true);
  for (const bad of [null, '', 'short', a + 'x', a.slice(0, 42), a.slice(0, 42) + '=', a.slice(0, 42) + '/']) assert.equal(linkTokenShapeOk(bad), false, String(bad));
  const h = await hashLinkToken(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, await hashLinkToken(a));
  assert.notEqual(h, await hashLinkToken(b));
  // sha256('abc') — the known vector, so the hash is plain SHA-256 (the SQL check expects 64 hex).
  assert.equal(await hashLinkToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// ── name match ──
test('names match ignoring case, spacing and width; anything else is refused', () => {
  assert.equal(normName('Asha  K'), 'ashak');
  assert.equal(namesMatch('asha k', 'Asha  K'), true);
  assert.equal(namesMatch('ASHAK', 'Asha K'), true);
  assert.equal(namesMatch('  Asha\tK ', 'Asha K'), true);
  assert.equal(namesMatch('Ａｓｈａ Ｋ', 'Asha K'), true);   // full-width (NFKC)
  assert.equal(namesMatch('Asha', 'Asha K'), false);
  assert.equal(namesMatch('Asha Kx', 'Asha K'), false);
  assert.equal(namesMatch('', 'Asha K'), false);
  assert.equal(namesMatch('   ', ''), false);
  assert.equal(namesMatch('Asha K', null), false);
  assert.equal(firstName('  Asha K Test '), 'Asha');
});

// ── D6 ──
test('one live link per revision: the newest non-failed offer mail, not revoked', () => {
  const t0 = '2026-11-10T05:00:00Z', t1 = '2026-11-11T05:00:00Z';
  const a = { id: 'a', offer_id: 'o1', kind: 'offer', status: 'sent', created_at: t0, link_revoked_at: null };
  const b = { id: 'b', offer_id: 'o1', kind: 'offer', status: 'sent', created_at: t1, link_revoked_at: null };
  assert.equal(isLinkLive(a, [a]), true);
  assert.equal(isLinkLive(a, [a, b]), false, 'a resend kills the older link');
  assert.equal(isLinkLive(b, [a, b]), true);
  assert.equal(isLinkLive(a, [a, { ...b, status: 'failed' }]), true, 'a failed resend leaves the previous link working');
  assert.equal(isLinkLive(a, [a, { ...b, status: 'unknown' }]), false);
  assert.equal(isLinkLive(a, [a, { ...b, kind: 'confirmation' }]), true, 'a confirmation is not a link');
  assert.equal(isLinkLive(a, [a, { ...b, offer_id: 'o2' }]), true, 'another revision\'s mail does not touch this link');
  assert.equal(isLinkLive({ ...a, link_revoked_at: t1 }, [a]), false);
  assert.equal(isLinkLive({ ...a, status: 'failed' }, [a]), false);
  for (const s of ['sending', 'unknown']) assert.equal(isLinkLive({ ...a, status: s }, [a]), true, s);
  assert.equal(isLinkLive({ ...a, kind: 'alert' }, [a]), false);
  assert.equal(isLinkLive(null, []), false);
  // The SQL twin keeps the same three statuses and the "no newer" rule.
  assert.match(SQL, /e\.status in \('sending', 'sent', 'unknown'\)/);
  assert.match(SQL, /n\.created_at > e\.created_at/);
});

// ── D7 ──
test('linkState: respond until valid_until, documents until start + 7, notices otherwise', () => {
  const o = { status: 'sent', valid_until: '2026-11-20', start_date: '2026-12-01' };
  assert.deepEqual(linkState({ offer: o, today: '2026-11-19' }), { mode: 'respond', notice: null });
  assert.equal(linkState({ offer: o, today: '2026-11-20' }).mode, 'respond', 'the valid_until day itself still responds');
  const ex = linkState({ offer: o, today: '2026-11-21', ownerFirst: 'Ravi' });
  assert.equal(ex.mode, 'notice');
  assert.equal(ex.notice, 'This offer has expired — contact Ravi.');
  const acc = { ...o, status: 'accepted' };
  assert.equal(linkState({ offer: acc, today: '2026-12-01' }).mode, 'documents');
  assert.equal(linkState({ offer: acc, today: '2026-12-08' }).mode, 'documents', 'start + 7 = still documents');
  assert.equal(linkState({ offer: acc, today: '2026-12-09' }).mode, 'notice', 'start + 8 = notice');
  assert.equal(linkState({ offer: acc, today: '2026-12-09', startPlus7: '2026-12-10' }).mode, 'documents', 'startPlus7 is honoured');
  assert.equal(linkState({ offer: { ...o, status: 'superseded' }, today: '2026-11-19' }).notice, 'This offer has been replaced — check your latest email.');
  assert.equal(linkState({ offer: { ...o, status: 'expired' }, today: '2026-11-19', ownerFirst: 'Ravi' }).notice, 'This offer has expired — contact Ravi.');
  for (const s of ['withdrawn', 'declined']) {
    assert.equal(linkState({ offer: { ...o, status: s }, today: '2026-11-19', ownerFirst: 'Ravi' }).notice,
      'This offer is no longer open — contact Ravi.', s);
  }
  for (const s of ['draft', 'ready', 'pending_approval']) assert.equal(linkState({ offer: { ...o, status: s }, today: '2026-11-19' }).mode, 'notice', s);
  assert.equal(linkState({ offer: { ...o, status: 'ready' }, today: '2026-11-19' }).notice, PREPARING_NOTICE);
  assert.equal(PREPARING_NOTICE, 'Your offer is being prepared — please try again in a few minutes.');
  // A notice never carries the letter, the name or the terms.
  assert.deepEqual(Object.keys(linkState({ offer: { ...o, status: 'withdrawn' }, today: '2026-11-19' })).sort(), ['mode', 'notice']);
});

test('the 0012 RPC raises map to codes', () => {
  assert.equal(linkDbErrorCode({ message: 'podium_headcount_full' }), 'headcount_full');
  assert.equal(linkDbErrorCode({ message: 'podium_link_dead' }), 'link_dead');
  assert.equal(linkDbErrorCode({ message: 'stale' }), 'stale');
  assert.equal(linkDbErrorCode({ code: '23505', message: 'dup' }), 'conflict');
  assert.equal(linkDbErrorCode({ message: 'something else' }), null);
  for (const code of ['offer_not_found', 'offer_not_open', 'offer_expired', 'link_dead', 'headcount_full', 'join_date_mismatch',
    'pdf_changed', 'opening_closed', 'bad_kind', 'bad_reason', 'text_required', 'text_too_long', 'question_cap', 'upload_cap']) {
    assert.ok(SQL.includes(`'podium_${code}'`), code);
  }
});

// ── MIME ──
const BASE = { from: 'owner@legendoftoys.com', fromName: 'Test Owner', to: 'cand@example.com', cc: ['hr@legendoftoys.com'],
  subject: offerSubject('Designer'), text: 'Hello', html: '<p>Hello</p>', messageId: offerMessageId('11111111-2222-4333-8444-555555555555') };

test('MIME: headers, threading, a base64 attachment wrapped at 76', () => {
  const bytes = new Uint8Array(500).map((_, i) => i % 256);
  const m = buildOfferMime({ ...BASE, inReplyTo: '<podium-offer-x@legendoftoys.com>',
    attachments: [{ filename: 'OFR-2026-001-r1.pdf', mime: 'application/pdf', bytes }] }, 'B');
  assert.ok(m.raw, m.error);
  const [head, body] = m.raw.split('\r\n\r\n');
  assert.match(head, /^From: "Test Owner" <owner@legendoftoys\.com>\r\n/);
  assert.match(head, /\r\nTo: cand@example\.com\r\n/);
  assert.match(head, /\r\nCc: hr@legendoftoys\.com\r\n/);
  assert.match(head, /\r\nMessage-ID: <podium-offer-11111111-2222-4333-8444-555555555555@legendoftoys\.com>\r\n/);
  assert.match(head, /\r\nIn-Reply-To: <podium-offer-x@legendoftoys\.com>\r\nReferences: <podium-offer-x@legendoftoys\.com>\r\n/);
  assert.match(head, /Content-Type: multipart\/mixed; boundary="B"/);
  assert.match(head, /Subject: =\?UTF-8\?B\?/, 'the em dash subject is RFC 2047 encoded');
  assert.ok(m.raw.includes('Content-Type: multipart/alternative; boundary="B_alt"'));
  assert.ok(m.raw.includes('--B_alt--'));
  assert.ok(m.raw.endsWith('--B--'));
  assert.ok(m.raw.includes('Content-Disposition: attachment; filename="OFR-2026-001-r1.pdf"; filename*=UTF-8\'\'OFR-2026-001-r1.pdf'));
  const att = m.raw.split('filename*=UTF-8\'\'OFR-2026-001-r1.pdf\r\n\r\n')[1].split('\r\n--B--')[0];
  for (const line of att.split('\r\n')) assert.ok(line.length <= 76, 'base64 lines ≤ 76');
  const round = Uint8Array.from(Buffer.from(att.replace(/\r\n/g, ''), 'base64'));
  assert.deepEqual([...round], [...bytes]);
  assert.ok(body.length > 0);
  // No threading headers without a parent.
  assert.doesNotMatch(buildOfferMime(BASE, 'B').raw, /In-Reply-To|References/);
});

test('MIME: CRLF injection and extra recipients are refused', () => {
  assert.ok(buildOfferMime({ ...BASE, to: 'cand@example.com\r\nBcc: evil@example.com' }, 'B').error);
  assert.ok(buildOfferMime({ ...BASE, to: 'cand@example.com, evil@example.com' }, 'B').error);
  assert.ok(buildOfferMime({ ...BASE, to: 'Cand <cand@example.com>' }, 'B').error);
  assert.ok(buildOfferMime({ ...BASE, cc: ['hr@legendoftoys.com, evil@example.com'] }, 'B').error);
  assert.ok(buildOfferMime({ ...BASE, cc: Array.from({ length: 21 }, (_, i) => `a${i}@example.com`) }, 'B').error);
  assert.ok(buildOfferMime({ ...BASE, from: 'owner@legendoftoys.com\nBcc: x@example.com' }, 'B').error);
  assert.ok(buildOfferMime({ ...BASE, messageId: '<x@y>\r\nBcc: x@example.com' }, 'B').error);
  assert.ok(buildOfferMime({ ...BASE, inReplyTo: 'not-an-id' }, 'B').error);
  // A CR/LF in the subject or the display name is flattened, never a new header.
  const m = buildOfferMime({ ...BASE, subject: 'Offer\r\nBcc: evil@example.com', fromName: 'A "B"\r\nBcc: x' }, 'B');
  assert.ok(m.raw);
  const head = m.raw.split('\r\n\r\n')[0];
  assert.doesNotMatch(head, /\r\nBcc:/i);
  assert.match(head, /^From: "A B Bcc: x" <owner@legendoftoys\.com>/);
  // Non-ASCII filenames get an ASCII-safe filename= plus RFC 2231 filename*.
  const n = buildOfferMime({ ...BASE, attachments: [{ filename: 'Offre é"x.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) }] }, 'B');
  assert.match(n.raw, /filename="Offre e_x\.pdf"; filename\*=UTF-8''Offre%20%C3%A9%22x\.pdf/);
  assert.equal(encodeHeaderWords('plain'), 'plain');
});

test('email bodies: the button, no figures, html escaped', () => {
  const e = renderOfferEmail({ candidateFirst: 'Asha', designation: 'Designer <b>', startDate: '2026-12-01', validUntil: '2026-11-20',
    link: 'https://podium.legendoftoys.com/offer/?t=abc', ownerName: 'Test Owner' });
  assert.ok(e.text.includes(OFFER_BUTTON));
  assert.equal(OFFER_BUTTON, 'View and respond to your offer');
  assert.ok(e.text.includes('https://podium.legendoftoys.com/offer/?t=abc'));
  assert.ok(e.text.includes('1st December 2026'));
  assert.ok(e.html.includes('Designer &lt;b&gt;'));
  assert.ok(!e.html.includes('<b>'));
  assert.doesNotMatch(e.text, /INR|₹|\d{2},\d{3}/);
  assert.match(renderOfferEmail({ candidateFirst: 'Asha', designation: 'D', link: 'x', revised: true }).text, /revised offer/);
  // The confirmation never carries a link, whatever it is handed (A).
  const c = renderConfirmationEmail({ candidateFirst: 'Asha', designation: 'Designer', joinDate: '2026-12-01', link: 'https://x/offer/?t=a' });
  assert.ok(c.text.includes('your acceptance of the role of Designer is recorded'));
  assert.ok(c.text.includes('returning to the link in our original offer email'));
  assert.doesNotMatch(c.text + c.html, /\?t=|href=/);
  const a = renderAlertEmail({ kind: 'decline', candidateName: 'Asha K', offerRef: 'OFR-2026-001', revision: 2, reason: 'another_offer',
    text: 'Thanks <script>', appUrl: 'https://podium.legendoftoys.com/hiring/offer/?id=x' });
  assert.ok(a.text.includes('Asha K declined the offer (OFR-2026-001 r2).'));
  assert.ok(a.text.includes(DECLINE_REASONS.another_offer));
  assert.ok(a.html.includes('&lt;script&gt;'));
  assert.ok(renderAlertEmail({ kind: 'accept_blocked', offerRef: 'OFR-2026-001', revision: 1 }).text.includes('Nothing was accepted'));
  assert.equal(offerSubject('Designer'), 'Offer — Designer — Legend of Toys');
});

// ── bank ──
test('bank validator: 9–18 digits, matching confirmation, J2 IFSC, a name', () => {
  const ok = validateCandidateBank({ account_number: '1234 5678 9012', account_number_confirm: '123456789012', ifsc: ' abcd0123456 ',
    account_name: '  Asha   K ', bank_name: 'Test Bank' });
  assert.deepEqual(ok, { ok: true, clean: { bank_account_number: '123456789012', bank_ifsc: 'ABCD0123456', bank_account_name: 'Asha K', bank_name: 'Test Bank' } });
  assert.equal(validateCandidateBank({ account_number: '12345678', account_number_confirm: '12345678', ifsc: 'ABCD0123456', account_name: 'A' }).errors.account_number !== undefined, true);
  assert.ok(validateCandidateBank({ account_number: '1234567890123456789', account_number_confirm: '1234567890123456789', ifsc: 'ABCD0123456', account_name: 'A' }).errors.account_number);
  assert.ok(validateCandidateBank({ account_number: '123456789', account_number_confirm: '123456780', ifsc: 'ABCD0123456', account_name: 'A' }).errors.account_number_confirm);
  assert.ok(validateCandidateBank({ account_number: '123456789', account_number_confirm: '123456789', ifsc: 'ABCD1123456', account_name: 'A' }).errors.ifsc);
  assert.ok(validateCandidateBank({ account_number: '123456789', account_number_confirm: '123456789', ifsc: 'ABCD0123456', account_name: ' ' }).errors.account_name);
  assert.ok(validateCandidateBank({ account_number: '123456789', account_number_confirm: '123456789', ifsc: 'ABCD0123456', account_name: 'x'.repeat(121) }).errors.account_name);
  assert.equal(validateCandidateBank({}).ok, false);
  assert.equal(validateCandidateBank({ account_number: '123456789', account_number_confirm: '123456789', ifsc: 'ABCD0123456', account_name: 'A' }).clean.bank_name, null);
  assert.equal(maskAccount('123456789012'), 'XXXXXX9012');
  assert.equal(maskAccount(null), null);
  // Same CHECK regexes as employee_private (0011).
  assert.ok(SQL.includes("bank_account_number ~ '^[0-9]{9,18}$'"));
  assert.ok(SQL.includes("bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'"));
});

// ── document paths ──
test('link document paths: minted shape only — another candidate, ".." and other types are refused', () => {
  const p = candidateLinkDocPath(CID, 'pan', '../My PAN (1).pdf', 1700000000000);
  assert.equal(p, `candidates/${CID}/link/pan/1700000000000-My_PAN_1_.pdf`);
  assert.equal(checkCandidateLinkDocPath(p, CID), null);
  assert.equal(checkCandidateLinkDocPath(p, CID, 'pan'), null);
  assert.equal(checkCandidateLinkDocPath(p, CID, 'bank'), 'bad_storage_path', 'doc type must match');
  assert.equal(checkCandidateLinkDocPath(p, OTHER), 'bad_storage_path', 'another candidate');
  assert.equal(checkCandidateLinkDocPath(`candidates/${CID}/link/pan/../../${OTHER}/link/pan/1-a.pdf`, CID), 'bad_storage_path');
  assert.equal(checkCandidateLinkDocPath(`candidates/${CID}/link/pan/1-..pdf`, CID), 'bad_storage_path');
  assert.equal(checkCandidateLinkDocPath(`candidates/${CID}/link/pan/1-%2e%2e.pdf`, CID), 'bad_storage_path');
  assert.equal(checkCandidateLinkDocPath(`candidates/${CID}/link/cv/1-a.pdf`, CID), 'bad_storage_path', 'not a link doc type');
  assert.equal(checkCandidateLinkDocPath(`candidates/${CID}/pan/1_a.pdf`, CID), 'bad_storage_path', 'a staff path');
  assert.equal(checkCandidateLinkDocPath(`candidates/${CID}/link/pan/1-a.pdf/x`, CID), 'bad_storage_path');
  assert.equal(checkCandidateLinkDocPath(null, CID), 'bad_storage_path');
  assert.equal(checkCandidateLinkDocPath(p, 'not-a-uuid'), 'bad_storage_path');
  // Every link doc type is a candidate_documents type (the CHECK), and the five required ones are flagged.
  for (const t of LINK_DOC_TYPE_KEYS) assert.ok(CANDIDATE_DOC_TYPES.includes(t), t);
  assert.deepEqual(LINK_DOC_TYPES.filter(t => t.required).map(t => t.doc_type).sort(), ['address_proof', 'bank', 'id_proof', 'pan', 'photo']);
});

// ── certificate ──
test('the certificate page is appended to the issued PDF, which is left intact', async () => {
  const src = await PDFDocument.create();
  src.addPage([595.28, 841.89]); src.addPage([595.28, 841.89]);
  const issued = await src.save();
  const lines = certificateLines({ offerRef: 'OFR-2026-001', revision: 1, candidateName: 'Asha K', typedName: 'asha k',
    acceptedAtIst: istStamp('2026-11-12T08:35:00Z'), joinDate: '2026-12-01', ip: '203.0.113.9',
    userAgent: 'Mozilla/5.0 ' + 'X'.repeat(400), pdfSha256: 'a'.repeat(64), tokenHashPrefix: 'abcdef012345' });
  assert.ok(lines.some(l => l.includes('OFR-2026-001 revision 1')));
  assert.ok(lines.some(l => l === `SHA-256 of the issued offer letter file (stored separately): ${'a'.repeat(64)}`));
  assert.ok(lines.some(l => l.includes('1st December 2026')));
  assert.equal(istStamp('2026-11-12T08:35:00Z'), '12 Nov 2026, 14:05:00 IST');
  const out = await appendCertificatePage(issued, lines);
  const doc = await PDFDocument.load(out);
  assert.equal(doc.getPageCount(), 3);
});

// ── A: recipients + copies ──
test('A: the link mail goes To the candidate only; the CC list gets the link-free copy', () => {
  const r = splitOfferRecipients({ to: ' Cand@Example.com ', cc: ['hr@legendoftoys.com', 'OWNER@legendoftoys.com', 'cand@example.com',
    'mgr@legendoftoys.com', 'hr@legendoftoys.com', ''], sender: 'owner@legendoftoys.com' });
  assert.deepEqual(r.candidate, { to: 'cand@example.com', cc: [] });
  assert.deepEqual(r.copy, { to: 'owner@legendoftoys.com', cc: ['hr@legendoftoys.com', 'mgr@legendoftoys.com'] },
    'deduped; the candidate and the sender never on the copy CC');
  assert.equal(splitOfferRecipients({ to: 'c@example.com', cc: ['owner@legendoftoys.com'], sender: 'owner@legendoftoys.com' }).copy, null);
  assert.equal(splitOfferRecipients({ to: 'c@example.com', sender: 'owner@legendoftoys.com' }).copy, null);
  // The copy bodies carry the staff URL and the candidate's address, never a token link.
  const oc = renderOfferCopyEmail({ candidateName: 'Asha K', candidateEmail: 'cand@example.com', designation: 'Designer',
    startDate: '2026-12-01', validUntil: '2026-11-20', staffUrl: 'https://podium.legendoftoys.com/hiring/offer/?id=x' });
  assert.ok(oc.text.includes('went to Asha K at cand@example.com'));
  assert.ok(oc.text.includes('https://podium.legendoftoys.com/hiring/offer/?id=x'));
  assert.doesNotMatch(oc.text + oc.html, /\/offer\/\?t=/);
  const cc = renderConfirmationCopyEmail({ candidateName: 'Asha K', candidateEmail: 'cand@example.com', designation: 'Designer',
    joinDate: '2026-12-01', staffUrl: 'https://podium.legendoftoys.com/hiring/offer/?id=x' });
  assert.ok(cc.text.includes('the confirmation went to cand@example.com'));
  assert.doesNotMatch(cc.text + cc.html, /\/offer\/\?t=/);
  // The kind CHECK has exactly the five kinds; only an offer row carries a token.
  assert.ok(SQL.includes(`check (kind in (${MAIL_KINDS.map(k => `'${k}'`).join(', ')}))`));
  assert.ok(SQL.includes("check (kind <> 'offer' or token_hash is not null)"));
  assert.ok(SQL.includes("check (kind = 'offer' or token_hash is null)"));
});

test('M: candidate mails thread on candidate mails only; copies on copies, else the candidate thread', () => {
  assert.deepEqual(threadKindsFor('offer'), [['offer', 'confirmation']]);
  assert.deepEqual(threadKindsFor('confirmation'), [['offer', 'confirmation']]);
  for (const k of ['offer_copy', 'confirmation_copy', 'alert']) {
    assert.deepEqual(threadKindsFor(k), [['offer_copy', 'confirmation_copy', 'alert'], ['offer', 'confirmation']], k);
  }
});

test('C / D / G: the claim, the one confirmation and the one blocked acceptance are partial unique indexes', () => {
  assert.match(SQL, /offer_emails_one_pending on podium\.offer_emails\(offer_id\)\s+where kind = 'offer' and status in \('sending', 'unknown'\)/);
  assert.match(SQL, /offer_emails_one_confirmation on podium\.offer_emails\(offer_id\)\s+where kind = 'confirmation' and status in \('sending', 'unknown', 'sent'\)/);
  assert.match(SQL, /offer_responses_one_blocked on podium\.offer_responses\(offer_id\) where kind = 'accept_blocked'/);
  // J + K: lock order offer → application → opening; `today` falls back to the IST date.
  const acc = SQL.slice(SQL.indexOf('function podium.offer_link_accept'), SQL.indexOf('function podium.offer_link_respond'));
  assert.ok(acc.indexOf('from podium.offers where id') < acc.indexOf('from podium.applications where id'));
  assert.ok(acc.indexOf('from podium.applications where id') < acc.indexOf('from podium.openings where id'));
  assert.equal((SQL.match(/coalesce\(nullif\(p->>'today', ''\)::date, \(now\(\) at time zone 'Asia\/Kolkata'\)::date\)/g) || []).length, 2);
  // E: reservations, counted under the offer lock; the bucket cap.
  assert.ok(SQL.includes('create table podium.offer_link_uploads'));
  assert.match(SQL, /select count\(\*\) into v_n from podium\.offer_link_uploads where offer_id = v_o\.id;\s+if v_n >= 30/);
  assert.ok(SQL.includes("update storage.buckets set file_size_limit = 15728640 where id = 'podium-documents' and file_size_limit is null;"));
});

// ── I: reconcile ──
test('I: unknown → failed only after two misses at least 2 minutes apart; a hit → sent', () => {
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  const row = { id: 'e', status: 'unknown', created_at: new Date(t0).toISOString(), reconcile_misses: 0, last_reconciled_at: null };
  assert.equal(reconcileDue(row, t0 + 30000), false, 'too fresh');
  assert.equal(reconcileDue(row, t0 + 60000), true);
  assert.equal(reconcileDue({ ...row, status: 'sending' }, t0 + 60000), false, 'a sending row waits 2 minutes');
  assert.equal(reconcileDue({ ...row, status: 'sending' }, t0 + 120000), true);
  assert.equal(reconcileDue({ ...row, status: 'sent' }, t0 + 999999), false);
  const miss1 = reconcileDecision(row, { found: false }, t0 + 60000);
  assert.deepEqual({ status: miss1.status, n: miss1.reconcile_misses }, { status: 'unknown', n: 1 }, 'first miss is not a failure');
  const after1 = { ...row, ...miss1 };
  assert.equal(reconcileDue(after1, t0 + 60000 + RECONCILE_GAP_MS - 1), false, 'the second look waits the gap');
  assert.equal(reconcileDue(after1, t0 + 60000 + RECONCILE_GAP_MS), true);
  assert.equal(reconcileDecision(after1, { found: false }, t0 + 60000 + 1000).status, 'unknown', 'two misses too close together');
  const miss2 = reconcileDecision(after1, { found: false }, t0 + 60000 + RECONCILE_GAP_MS);
  assert.equal(miss2.status, 'failed');
  assert.equal(miss2.reconcile_misses, 2);
  const hit = reconcileDecision(after1, { found: true, id: 'g1', threadId: 't1' }, t0 + 200000);
  assert.deepEqual([hit.status, hit.gmail_message_id, hit.gmail_thread_id, hit.sent_at], ['sent', 'g1', 't1', row.created_at]);
  // A stale 'sending' row's first miss becomes 'unknown', never straight to failed.
  assert.equal(reconcileDecision({ ...row, status: 'sending' }, { found: false }, t0 + 120000).status, 'unknown');
});

// ── B: the accepted PDF path ──
test('B: the accepted PDF path carries a per-attempt 8-hex nonce', () => {
  const a = newPathNonce(), b = newPathNonce();
  assert.match(a, /^[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  const p = acceptedPdfPath(OTHER, 'OFR-2026-001', 2, 'f'.repeat(64), 'deadbeef');
  assert.equal(p, `offers/${OTHER}/OFR-2026-001-r2-accepted-ffffffffffff-deadbeef.pdf`);
  assert.notEqual(acceptedPdfPath(OTHER, 'OFR-2026-001', 2, 'f'.repeat(64), a), acceptedPdfPath(OTHER, 'OFR-2026-001', 2, 'f'.repeat(64), b),
    'the same bytes in two attempts never share an object');
  for (const bad of [null, '', 'xyz', 'DEADBEEF', 'deadbeef0', '../aaaaa']) assert.throws(() => acceptedPdfPath(OTHER, 'OFR-2026-001', 2, 'f', bad), String(bad));
});
