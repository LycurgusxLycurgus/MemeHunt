import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EvidenceRecord } from '../src/domain/contracts.js';
import { callerSeedFromEvidence, CALLER_SELECTION_ID, CALLER_SEED_METHOD } from '../src/providers/advisory-caller-measures.js';
import { collectCallerHistory } from '../src/providers/advisory-caller-history.js';
import { RECORDED_CALLER_METHOD, type RecordedCallerCapture } from '../src/providers/advisory-recorded-callers.js';
import { decodeRecordedIncentiveCapture, recordedIncentiveProposalPrompt, recordedIncentiveReviewPrompt, RECORDED_INCENTIVE_METHOD, type RecordedIncentiveCapture } from '../src/providers/advisory-recorded-incentives.js';
const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const at = (s: number) => `2026-10-12T00:00:${String(s).padStart(2, '0')}.000Z`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const POST_AT = '2026-10-11T12:00:00.000Z', id = String(((BigInt(Date.parse(POST_AT)) - 1288834974657n) << 22n) + 1n), url = `https://x.com/alpha/status/${id}`;
const HOLD = `Disclosure: I hold a bag of this. Ca: ${token.address}`;
const rec = (id: string, sourceId: string, sourceType: string, accessMode: EvidenceRecord['accessMode'], scope: Record<string, unknown>, raw: string): EvidenceRecord => ({ id, sourceId, sourceType, accessMode, scope, retrievedAt: at(0), availableAt: at(0), contentHash: sha(raw), adapterVersion: 'live-v1' });
/** Constructed SOURCE-ONLY caller capture (same construction as the frozen caller test); never actual provider or model evidence. */
async function source(text = HOLD, two = false): Promise<RecordedCallerCapture> {
  const ids = two ? ['attention-page-1', 'attention-page-2'] : ['attention-page-1'];
  const rawArtifacts: Record<string, string> = { 'attention-scope': JSON.stringify({ queries: [`${token.address} site:x.com`], postSampleSourceIds: ids }) };
  const evidence = [rec('attention-scope', 'attention-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: 'comparison-scope-v2' }, rawArtifacts['attention-scope']!)];
  ids.forEach((page, i) => { rawArtifacts[page] = text; evidence.push(rec(page, 'tinyfish-fetch', 'WEB_PAGE', 'FREE_ACCOUNT', { kind: 'POST', url: i ? `https://x.com/beta/status/${BigInt(id) + 1n}` : url, publishedAt: POST_AT }, text)); });
  const seed = callerSeedFromEvidence(token, evidence, rawArtifacts, at(0)); assert.ok(seed.selection);
  rawArtifacts[CALLER_SELECTION_ID] = seed.raw; evidence.push(rec(CALLER_SELECTION_ID, 'advisory-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: CALLER_SEED_METHOD }, seed.raw));
  const payloads = {
    oembed: { url, author_url: 'https://twitter.com/alpha' },
    syndication: { __typename: 'Tweet', id_str: id, created_at: POST_AT, text, user: { screen_name: 'alpha' }, edit_control: { edit_tweet_ids: [id], editable_until_msecs: String(Date.parse(POST_AT) + 3600000) }, isEdited: false, isStaleEdit: false },
    fxtwitter: { code: 200, message: 'OK', tweet: { id, text, raw_text: { text, facets: [] }, author: { screen_name: 'alpha' }, created_timestamp: Date.parse(POST_AT) / 1000, is_note_tweet: false, replying_to_status: null, reposted_by: null } },
  };
  const id2 = String(BigInt(id) + 1n);
  const collected = await collectCallerHistory(seed.selection, (async (input: unknown) => { const u = String(input); let body = JSON.stringify(payloads[u.includes('oembed') ? 'oembed' : u.includes('syndication') ? 'syndication' : 'fxtwitter']); if (u.includes(id2)) body = body.replaceAll(id, id2).replaceAll('alpha', 'beta'); return new Response(body); }) as typeof fetch, () => at(5));
  return { method: RECORDED_CALLER_METHOD, token, seed: { evidence, rawArtifacts }, callers: { requests: collected.requests, rawArtifacts: collected.rawArtifacts, times: Object.fromEntries(Object.keys(collected.rawArtifacts).map(k => [k, at(5)])) }, qualification: null };
}
const outer = (raw: string, qualification: RecordedIncentiveCapture['qualification'] = null): RecordedIncentiveCapture => ({ method: RECORDED_INCENTIVE_METHOD, token, sourceCapture: raw, qualification });
const pass = (executor: 'CODEX' | 'CLAUDE_CODE', prompt: string, response: string, start: number, finish: number) => ({ prompt, response, execution: { executor, executionId: `synthetic-${executor}`, modelId: null, modelIdSource: 'UNREPORTED' as const, tools: 'NONE' as const, freshSession: true as const, startedAt: at(start), finishedAt: at(finish), promptSha256: sha(prompt), responseSha256: sha(response) } });
const span = (s: any) => ({ sourceId: s.id, spanId: (s.spans.find((p: any) => p.text.includes(token.address)) ?? s.spans[0]).id });
function classify(raw: string, patch: (s: any, i: number) => Record<string, unknown> = () => ({}), review: Record<string, boolean> = {}, rows?: (r: any[]) => any[]): RecordedIncentiveCapture {
  const h = decodeRecordedIncentiveCapture(JSON.stringify(outer(raw)), token, at(30)).history, proposalPrompt = recordedIncentiveProposalPrompt(h), catalog = JSON.parse(proposalPrompt).sources;
  const proposalResponse = JSON.stringify({ sources: catalog.map((s: any, i: number) => ({ id: s.id, binding: 'EXACT_CONTRACT', bindingCitations: [span(s)], incentives: [{ category: 'PUBLIC_HOLDINGS', citations: [span(s)] }], rationale: 'Synthetic fixture classification only.', ...patch(s, i) })) });
  const reviewRows = catalog.map((s: any) => ({ id: s.id, complete: true, binding: true, incentives: true, ...review }));
  const reviewResponse = JSON.stringify({ sources: rows ? rows(reviewRows) : reviewRows });
  return outer(raw, { proposal: pass('CODEX', proposalPrompt, proposalResponse, 6, 10), review: pass('CLAUDE_CODE', recordedIncentiveReviewPrompt(h, proposalResponse), reviewResponse, 11, 15) });
}

export { token, at, sha, POST_AT, id, HOLD, source, outer, pass, span, classify };
