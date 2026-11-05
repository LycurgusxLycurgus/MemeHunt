import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { EvidenceRecord } from '../src/domain/contracts.js';
import { callerSeedFromEvidence, CALLER_SELECTION_ID, CALLER_SEED_METHOD } from '../src/providers/advisory-caller-measures.js';
import { collectCallerHistory } from '../src/providers/advisory-caller-history.js';
import { decodeRecordedCallerCapture, deriveRecordedCallerMetrics, recordedCallerProposalPrompt, recordedCallerReviewPrompt, RECORDED_CALLER_METHOD, type RecordedCallerCapture } from '../src/providers/advisory-recorded-callers.js';
const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const at = (s: number) => `2026-10-12T00:00:${String(s).padStart(2, '0')}.000Z`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const POST_AT = '2026-10-11T12:00:00.000Z', id = String(((BigInt(Date.parse(POST_AT)) - 1288834974657n) << 22n) + 1n), url = `https://x.com/alpha/status/${id}`;
const rec = (id: string, sourceId: string, sourceType: string, accessMode: EvidenceRecord['accessMode'], scope: Record<string, unknown>, raw: string): EvidenceRecord => ({ id, sourceId, sourceType, accessMode, scope, retrievedAt: at(0), availableAt: at(0), contentHash: sha(raw), adapterVersion: 'live-v1' });
/** Constructed complete public-receipt fixture; never represented as actual model/provider evidence. */
async function fixture(two = false): Promise<RecordedCallerCapture> {
  const text = `Early entry Ca: ${token.address}`, rawArtifacts: Record<string, string> = {
    'attention-scope': JSON.stringify({ queries: [`${token.address} site:x.com`], postSampleSourceIds: ['attention-page-1'] }), 'attention-page-1': text,
  };
  const evidence = [rec('attention-scope', 'attention-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: 'comparison-scope-v2' }, rawArtifacts['attention-scope']!), rec('attention-page-1', 'tinyfish-fetch', 'WEB_PAGE', 'FREE_ACCOUNT', { kind: 'POST', url, publishedAt: POST_AT }, text)];
  if (two) {
    const id2 = String(BigInt(id) + 1n), url2 = `https://x.com/beta/status/${id2}`;
    rawArtifacts['attention-scope'] = JSON.stringify({ queries: [`${token.address} site:x.com`], postSampleSourceIds: ['attention-page-1', 'attention-page-2'] });
    evidence[0]!.contentHash = sha(rawArtifacts['attention-scope']!);
    rawArtifacts['attention-page-2'] = text;
    evidence.push(rec('attention-page-2', 'tinyfish-fetch', 'WEB_PAGE', 'FREE_ACCOUNT', { kind: 'POST', url: url2, publishedAt: POST_AT }, text));
  }
  const seed = callerSeedFromEvidence(token, evidence, rawArtifacts, at(0)); assert.ok(seed.selection);
  rawArtifacts[CALLER_SELECTION_ID] = seed.raw; evidence.push(rec(CALLER_SELECTION_ID, 'advisory-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: CALLER_SEED_METHOD }, seed.raw));
  const payloads = {
    oembed: { url, author_url: 'https://twitter.com/alpha' },
    syndication: { __typename: 'Tweet', id_str: id, created_at: POST_AT, text, user: { screen_name: 'alpha' }, edit_control: { edit_tweet_ids: [id], editable_until_msecs: String(Date.parse(POST_AT) + 3600000) }, isEdited: false, isStaleEdit: false },
    fxtwitter: { code: 200, message: 'OK', tweet: { id, text, raw_text: { text, facets: [] }, author: { screen_name: 'alpha' }, created_timestamp: Date.parse(POST_AT) / 1000, is_note_tweet: false, replying_to_status: null, reposted_by: null } },
  };
  const collected = await collectCallerHistory(seed.selection, (async (input: unknown) => { const u = String(input); let body = JSON.stringify(payloads[u.includes('oembed') ? 'oembed' : u.includes('syndication') ? 'syndication' : 'fxtwitter']); if (u.includes(String(BigInt(id) + 1n))) body = body.replaceAll(id, String(BigInt(id) + 1n)).replaceAll('alpha', 'beta'); return new Response(body); }) as typeof fetch, () => at(5));
  return { method: RECORDED_CALLER_METHOD, token, seed: { evidence, rawArtifacts }, callers: { requests: collected.requests, rawArtifacts: collected.rawArtifacts, times: Object.fromEntries(Object.keys(collected.rawArtifacts).map(k => [k, at(5)])) }, qualification: null };
}
function classified(c: RecordedCallerCapture, patch: Record<string, unknown> = {}, accept = true): RecordedCallerCapture {
  const d = decodeRecordedCallerCapture(JSON.stringify(c), token, at(30));
  assert.equal(d.history.complete, true);
  const proposalPrompt = recordedCallerProposalPrompt(d), catalog = JSON.parse(proposalPrompt).sources;
  const proposalResponse = JSON.stringify({ sources: catalog.map((s: any) => ({ id: s.id, binding: 'EXACT_CONTRACT', event: 'FORWARD_CALL', category: 'CRYPTO_CALLER', topic: 'PRICE_CHART', citations: [{ sourceId: s.id, spanId: s.spans.find((p: any) => p.text.includes(token.address)).id }], rationale: 'Synthetic fixture classification only.', ...patch })) });
  const reviewPrompt = recordedCallerReviewPrompt(d, proposalResponse), reviewResponse = JSON.stringify({ sources: catalog.map((s: any) => ({ id: s.id, complete: true, binding: accept, event: accept, category: accept, topic: accept })) });
  const pass = (executor: 'CODEX' | 'CLAUDE_CODE', prompt: string, response: string, start: number, finish: number) => ({ prompt, response, execution: { executor, executionId: `synthetic-${executor}`, modelId: null, modelIdSource: 'UNREPORTED' as const, tools: 'NONE' as const, freshSession: true as const, startedAt: at(start), finishedAt: at(finish), promptSha256: sha(prompt), responseSha256: sha(response) } });
  return { ...c, qualification: { proposal: pass('CODEX', proposalPrompt, proposalResponse, 6, 10), review: pass('CLAUDE_CODE', reviewPrompt, reviewResponse, 11, 15) } };
}
const metrics = (c: RecordedCallerCapture) => deriveRecordedCallerMetrics(JSON.stringify(c), token, at(30), ['outer-capture']);
test('complete retained caller import yields only four independently classified rows with outer evidence and explicit trust', async () => {
  const c = classified(await fixture()), rows = metrics(c);
  assert.deepEqual(rows.map(r => r.id).sort(), ['A21', 'A23', 'S07', 'S09']);
  assert.ok(rows.every(r => r.quality === 'KNOWN'));
  for (const r of rows) { assert.deepEqual(r.evidenceIds, ['outer-capture']); assert.match(JSON.stringify(r.data), /USER_IMPORT/); }
  assert.equal(decodeRecordedCallerCapture(JSON.stringify(c)).availableAt, at(15));
});
test('preview null qualification and rejected classification remain missing; no call denominator becomes an observed zero fraction', async () => {
  const c = await fixture(); assert.ok(metrics(c).every(r => r.quality === 'MISSING'));
  assert.ok(metrics(classified(c, {}, false)).every(r => r.quality === 'MISSING'));
  const rows = metrics(classified(c, { event: 'NEWS' }));
  assert.equal(rows.find(r => r.id === 'S07')!.quality, 'KNOWN'); assert.equal(rows.find(r => r.id === 'S09')!.reasonCode, 'HISTORICAL_CALL_DENOMINATOR_ZERO');
  assert.equal((rows.find(r => r.id === 'S09')!.data as any).top1Share, null);
});
test('strict seed hashes, ownership, unique membership and exact requests/receipt clocks cannot be forged through cache fields', async () => {
  const original = await fixture();
  for (const change of [
    (c: RecordedCallerCapture) => { c.seed.rawArtifacts['attention-page-1'] += 'x'; },
    (c: RecordedCallerCapture) => { c.seed.evidence[1]!.accessMode = 'USER_IMPORT'; },
    (c: RecordedCallerCapture) => { c.seed.evidence.push(c.seed.evidence[1]!); },
    (c: RecordedCallerCapture) => { c.seed.rawArtifacts.extra = 'orphan'; },
    (c: RecordedCallerCapture) => { const k = Object.keys(c.callers.requests)[0]!; c.callers.requests[k]!.url += '?x'; },
    (c: RecordedCallerCapture) => { c.callers.times[Object.keys(c.callers.times)[0]!] = at(4); },
  ]) { const c = structuredClone(original); change(c); assert.throws(() => decodeRecordedCallerCapture(JSON.stringify(c), token, at(30)), /RECORDED_CALLER_/); }
  assert.throws(() => decodeRecordedCallerCapture(JSON.stringify(original), { ...token, address: 'other' }, at(30)), /TOKEN/);
  assert.throws(() => decodeRecordedCallerCapture(JSON.stringify(original), token, at(4)), /RECEIPT_BINDING/);
});
test('prompt bytes, output hashes, different executor/session and actual execution chronology are mandatory', async () => {
  const original = classified(await fixture());
  for (const change of [
    (c: RecordedCallerCapture) => { c.qualification!.proposal.prompt += ' '; },
    (c: RecordedCallerCapture) => { c.qualification!.review.execution.responseSha256 = '0'.repeat(64); },
    (c: RecordedCallerCapture) => { c.qualification!.review.execution.executor = 'CODEX'; },
    (c: RecordedCallerCapture) => { c.qualification!.review.execution.executionId = c.qualification!.proposal.execution.executionId; },
    (c: RecordedCallerCapture) => { c.qualification!.review.execution.startedAt = at(9); },
    (c: RecordedCallerCapture) => { c.qualification!.proposal.execution.startedAt = at(4); },
    (c: RecordedCallerCapture) => { c.qualification!.review.execution.finishedAt = at(31); },
  ]) { const c = structuredClone(original); change(c); assert.throws(() => decodeRecordedCallerCapture(JSON.stringify(c), token, at(30)), /RECORDED_CALLER_/); }
});
test('own-source citation membership and raw JSON schemas reject bad semantics without mutating actual output', async () => {
  const c = classified(await fixture(), { citations: [{ sourceId: 'invented', spanId: 'invented' }] });
  assert.ok(metrics(c).every(r => r.quality === 'MISSING')); assert.match(JSON.stringify(metrics(c)), /RECORDED_CALLER_CITATION_INVALID/);
  const invalid = classified(await fixture(), { extraneous: true }); assert.ok(metrics(invalid).every(r => r.quality === 'MISSING'));
});

test('field-local review rejection blocks only the affected measurements', async () => {
  const original = classified(await fixture());
  for (const [field, missing] of [
    ['event', ['S07', 'S09']], ['category', ['A21']], ['topic', ['A23']],
    ['binding', ['S07', 'S09', 'A21', 'A23']], ['complete', ['S07', 'S09', 'A21', 'A23']],
  ] as const) {
    const c = structuredClone(original), r = c.qualification!.review, value = JSON.parse(r.response);
    value.sources[0][field] = false; r.response = JSON.stringify(value); r.execution.responseSha256 = sha(r.response);
    for (const row of metrics(c)) assert.equal(row.quality, (missing as readonly string[]).includes(row.id) ? 'MISSING' : 'KNOWN', `${field}:${row.id}`);
  }
});
test('narrow schema excludes unrelated broad fields, old repair captures and cross-protocol envelopes', async () => {
  const original = await fixture();
  for (const field of ['artifact', 'theme', 'paidDisclosure', 'incentives']) assert.ok(metrics(classified(original, { [field]: field })).every(m => m.quality === 'MISSING'));
  assert.throws(() => decodeRecordedCallerCapture(JSON.stringify({ ...original, method: 'recorded-caller-capture-v1' })), /SCHEMA/);
  assert.throws(() => decodeRecordedCallerCapture(JSON.stringify({ ...original, previousQualification: {} })), /SCHEMA/);
  const c = classified(original), p = c.qualification!.proposal;
  p.response = JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: p.response }] } }] }); p.execution.responseSha256 = sha(p.response);
  const preview = decodeRecordedCallerCapture(JSON.stringify({ ...c, qualification: null }));
  c.qualification!.review.prompt = recordedCallerReviewPrompt(preview, p.response); c.qualification!.review.execution.promptSha256 = sha(c.qualification!.review.prompt);
  assert.ok(metrics(c).every(m => m.quality === 'MISSING'));
});
test('all sources remain members even when only one field is disputed', async () => {
  const c = classified(await fixture(true)), r = c.qualification!.review, value = JSON.parse(r.response);
  value.sources.pop(); r.response = JSON.stringify(value); r.execution.responseSha256 = sha(r.response);
  assert.ok(metrics(c).every(m => m.quality === 'MISSING'));
});
