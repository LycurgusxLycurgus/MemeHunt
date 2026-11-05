import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeRecordedCallerCapture, deriveRecordedCallerMetrics, recordedCallerProposalPrompt, recordedCallerReviewPrompt, RECORDED_CALLER_METHOD, type RecordedCallerCapture } from '../src/providers/advisory-recorded-callers.js';
import { decodeRecordedIncentiveCapture, deriveRecordedIncentiveMetrics, recordedIncentiveProposalPrompt, recordedIncentiveReviewPrompt, RECORDED_INCENTIVE_LIMIT, RECORDED_INCENTIVE_METHOD, type RecordedIncentiveCapture } from '../src/providers/advisory-recorded-incentives.js';
import { token, at, sha, POST_AT, id, HOLD, source, outer, pass, span, classify } from './recorded-incentive-fixtures.js';
const s08 = (c: RecordedIncentiveCapture) => { const rows = deriveRecordedIncentiveMetrics(JSON.stringify(c), token, at(30), ['outer-incentive']); assert.equal(rows.length, 1); return rows[0]!; };
const decodes = (c: RecordedIncentiveCapture, code: RegExp, cutoff = at(30)) => assert.throws(() => decodeRecordedIncentiveCapture(JSON.stringify(c), token, cutoff), code);

test('reviewed explicit incentive yields only S08 with outer evidence, retained clocks, author, body trust and nested audit', async () => {
  const raw = JSON.stringify(await source()), m = s08(classify(raw)), data = m.data as any;
  assert.equal(m.id, 'S08'); assert.equal(m.quality, 'KNOWN'); assert.equal(m.reasonCode, 'HISTORICAL_PUBLIC_INCENTIVES_OBSERVED');
  assert.deepEqual(m.evidenceIds, ['outer-incentive']);
  const claim = data.incentives[0];
  assert.equal(claim.category, 'PUBLIC_HOLDINGS'); assert.equal(claim.publishedAt, POST_AT); assert.equal(claim.retrievedAt, at(5)); assert.equal(claim.authorId, 'x.com:alpha');
  assert.match(claim.bodyTrust, /OFFICIAL_PREFIX_FX_FULLTEXT_V1/); assert.ok(claim.citations[0].quote.includes('hold'));
  assert.equal(data.hiddenCompensation, null); assert.equal(data.organic, null); assert.equal(data.paidActivity, null);
  assert.deepEqual(data.scope.period, { start: '2026-09-28T00:00:00.000Z', end: at(0) });
  assert.ok(data.recordedClassification.nestedAudit.seedEvidenceIds.includes('attention-page-1')); assert.ok(!m.evidenceIds.includes('attention-page-1'));
  assert.match(JSON.stringify(data), /USER_IMPORT/);
});
test('zero observed is a scoped KNOWN observation; unreviewed, rejected, incomplete or vacuous inspection stays MISSING', async () => {
  const raw = JSON.stringify(await source());
  const none = s08(classify(raw, () => ({ incentives: [] })));
  assert.equal(none.quality, 'KNOWN'); assert.equal(none.reasonCode, 'HISTORICAL_PUBLIC_INCENTIVES_NONE_IN_INSPECTED_TEXT'); assert.deepEqual((none.data as any).incentives, []);
  assert.equal((none.data as any).inspected.length, 1); assert.equal((none.data as any).hiddenCompensation, null);
  for (const [c, reason] of [
    [outer(raw), 'RECORDED_INCENTIVE_CLASSIFICATION_UNAVAILABLE'],
    [classify(raw, () => ({}), { incentives: false }), 'HISTORICAL_INCENTIVES_REJECTED'],
    [classify(raw, () => ({ incentives: [] }), { incentives: false }), 'HISTORICAL_INCENTIVES_REJECTED'],
    [classify(raw, () => ({}), { complete: false }), 'HISTORICAL_INSPECTION_INCOMPLETE'],
    [classify(raw, () => ({}), { binding: false }), 'HISTORICAL_BINDING_UNRESOLVED'],
    [classify(raw, () => ({ binding: 'UNCLEAR', incentives: [] })), 'HISTORICAL_BINDING_UNRESOLVED'],
    [classify(raw, () => ({ binding: 'UNRELATED', bindingCitations: [], incentives: [] })), 'HISTORICAL_INCENTIVE_DENOMINATOR_ZERO'],
  ] as const) { const m = s08(c); assert.equal(m.quality, 'MISSING'); assert.equal(m.reasonCode, reason); assert.deepEqual((m.data as any).incentives, []); }
});
test('imported nested trust: SOURCE-ONLY required, exact source bytes bound, caller fields never inherited, protocols disjoint', async () => {
  const n = await source(), raw = JSON.stringify(n);
  const d = decodeRecordedCallerCapture(raw, token, at(30));
  const p = recordedCallerProposalPrompt(d), cat = JSON.parse(p).sources;
  const pr = JSON.stringify({ sources: cat.map((s: any) => ({ id: s.id, binding: 'EXACT_CONTRACT', event: 'FORWARD_CALL', category: 'CRYPTO_CALLER', topic: 'PRICE_CHART', citations: [span(s)], rationale: 'Synthetic fixture classification only.' })) });
  const rr = JSON.stringify({ sources: cat.map((s: any) => ({ id: s.id, complete: true, binding: true, event: true, category: true, topic: true })) });
  const qualified = JSON.stringify({ ...n, qualification: { proposal: pass('CODEX', p, pr, 6, 10), review: pass('CLAUDE_CODE', recordedCallerReviewPrompt(d, pr), rr, 11, 15) } });
  decodes(outer(qualified), /SOURCE_NOT_SOURCE_ONLY/);
  const stale = classify(raw); stale.sourceCapture = raw.replace('attention-page-1', 'unknown-page'); decodes(stale, /SOURCE_INVALID/);
  for (const bad of [{ ...outer(raw), method: 'recorded-incentive-capture-v0' }, { ...outer(raw), sourceCapture: raw.replace('recorded-caller-capture-v2', 'recorded-caller-capture-v1') }, { ...outer(raw), previousQualification: {} }])
    decodes(bad as RecordedIncentiveCapture, /SCHEMA/);
  decodes(outer('x'.repeat(RECORDED_INCENTIVE_LIMIT)), /SIZE_OR_UTF8/);
  // The frozen four-field protocol is unaffected and refuses the new envelope.
  assert.ok(deriveRecordedCallerMetrics(raw, token, at(30), ['outer-caller']).every(m => m.quality === 'MISSING'));
  assert.throws(() => deriveRecordedCallerMetrics(JSON.stringify(classify(raw)), token, at(30), ['outer']), /RECORDED_CALLER_SCHEMA/);
});
test('token, seed, request, receipt body and timestamp tampering reject before any measurement', async () => {
  const original = await source(), c = classify(JSON.stringify(original));
  assert.throws(() => decodeRecordedIncentiveCapture(JSON.stringify(c), { ...token, address: 'other' }, at(30)), /RECORDED_INCENTIVE_TOKEN/);
  decodes({ ...c, token: { ...token, address: 'other' } }, /RECORDED_INCENTIVE_TOKEN/);
  for (const [change, code] of [
    [(n: RecordedCallerCapture) => { n.seed.rawArtifacts['attention-page-1'] += 'x'; }, /SOURCE_INVALID:RECORDED_CALLER_SEED_RECORD/],
    [(n: RecordedCallerCapture) => { const k = Object.keys(n.callers.requests)[0]!; n.callers.requests[k]!.url += '?x'; }, /SOURCE_INVALID:RECORDED_CALLER_REQUEST_BINDING/],
    [(n: RecordedCallerCapture) => { n.callers.times[Object.keys(n.callers.times)[0]!] = at(4); }, /SOURCE_INVALID:RECORDED_CALLER_RECEIPT_BINDING/],
    [(n: RecordedCallerCapture) => { const k = Object.keys(n.callers.rawArtifacts).find(k => k.endsWith(':fxtwitter'))!, r = JSON.parse(n.callers.rawArtifacts[k]!); r.body = r.body.replaceAll('hold', 'held'); n.callers.rawArtifacts[k] = JSON.stringify(r); }, /PROMPT_BINDING/],
  ] as const) { const n = structuredClone(original); change(n); decodes(outer(JSON.stringify(n), c.qualification), code); }
  decodes(c, /SOURCE_INVALID:RECORDED_CALLER_RECEIPT_BINDING/, at(4));
  decodes(c, /RECORDED_INCENTIVE_CLOCK/, 'not-a-time');
});
test('prompt bytes, output hashes, distinct executors and actual chronology up to the fresh cutoff are mandatory', async () => {
  const original = classify(JSON.stringify(await source()));
  for (const [change, code] of [
    [(c: RecordedIncentiveCapture) => { c.qualification!.proposal.prompt += ' '; }, /PROMPT_BINDING/],
    [(c: RecordedIncentiveCapture) => { c.qualification!.review.execution.responseSha256 = '0'.repeat(64); }, /EXECUTION_BINDING/],
    [(c: RecordedIncentiveCapture) => { c.qualification!.proposal.execution.startedAt = at(4); }, /EXECUTION_BINDING/],
    [(c: RecordedIncentiveCapture) => { c.qualification!.review.execution.finishedAt = at(31); }, /EXECUTION_BINDING/],
    [(c: RecordedIncentiveCapture) => { c.qualification!.review.execution.executor = 'CODEX'; }, /INDEPENDENCE/],
    [(c: RecordedIncentiveCapture) => { c.qualification!.review.execution.executionId = c.qualification!.proposal.execution.executionId; }, /INDEPENDENCE/],
    [(c: RecordedIncentiveCapture) => { c.qualification!.review.execution.startedAt = at(9); }, /INDEPENDENCE/],
    [(c: RecordedIncentiveCapture) => { (c.qualification!.review.execution as any).tools = 'WEB'; }, /SCHEMA/],
    [(c: RecordedIncentiveCapture) => { c.qualification!.review.execution.modelId = 'claude-opus-5-5'; }, /SCHEMA/],
  ] as const) { const c = structuredClone(original); change(c); decodes(c, code); }
  assert.equal(decodeRecordedIncentiveCapture(JSON.stringify(original), token, at(15)).availableAt, at(15));
  decodes(original, /EXECUTION_BINDING/, at(14));
});
test('selector, binding, category, scope, forbidden-field and membership defects are MISSING, never forced KNOWN', async () => {
  const raw = JSON.stringify(await source()), two = JSON.stringify(await source(HOLD, true));
  const other = (s: any) => ({ sourceId: s.id === 'caller-' + id ? 'caller-' + String(BigInt(id) + 1n) : 'caller-' + id, spanId: '' });
  for (const [c, reason] of [
    [classify(raw, () => ({ incentives: [{ category: 'PUBLIC_HOLDINGS', citations: [{ sourceId: 'invented', spanId: 'invented' }] }] })), 'RECORDED_INCENTIVE_CITATION_INVALID'],
    [classify(two, s => { const o = other(s); return { incentives: [{ category: 'COMPENSATION', citations: [{ sourceId: o.sourceId, spanId: `${o.sourceId}:span:0` }] }] }; }), 'RECORDED_INCENTIVE_CITATION_INVALID'],
    [classify(raw, s => ({ incentives: [{ category: 'AFFILIATION', citations: [span(s)] }, { category: 'AFFILIATION', citations: [span(s)] }] })), 'RECORDED_INCENTIVE_INCENTIVE_DUPLICATE'],
    [classify(raw, () => ({ binding: 'UNRELATED' })), 'RECORDED_INCENTIVE_INCENTIVE_SCOPE'],
    [classify(raw, () => ({ incentives: [{ category: 'HIDDEN_PAYMENT', citations: [] }] })), 'RECORDED_INCENTIVE_CLASSIFICATION_SCHEMA'],
    [classify(two, () => ({}), {}, r => r.slice(1)), 'RECORDED_INCENTIVE_CLASSIFICATION_MEMBERSHIP'],
    [classify(two, () => ({}), {}, r => [r[0], r[0]]), 'RECORDED_INCENTIVE_CLASSIFICATION_MEMBERSHIP'],
  ] as const) { const m = s08(c); assert.equal(m.quality, 'MISSING'); assert.equal(m.reasonCode, reason); }
  for (const field of ['event', 'category', 'topic', 'artifact', 'theme', 'paidDisclosure', 'persistence'])
    assert.equal(s08(classify(raw, () => ({ [field]: 'X' }))).reasonCode, 'RECORDED_INCENTIVE_CLASSIFICATION_SCHEMA');
  const unbound = JSON.stringify(await source('Disclosure: I hold a bag of this coin.'));
  assert.equal(s08(classify(unbound)).reasonCode, 'RECORDED_INCENTIVE_BINDING_INVALID');
});
