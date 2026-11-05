import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { EvidenceRecord, TokenRef } from '../domain/contracts.js';
import type { AdvisoryMetric } from '../domain/advisory-contracts.js';
import { canonicalSocialUrl, socialAccount } from '../domain/social.js';
import { ADVISORY_ORIGIN_CATEGORY, ADVISORY_SEMANTIC_WIRE, validateAdvisorySemanticWire, type AdvisorySemantic, type AdvisorySemanticWire } from './advisory-semantic.js';
import { callerHistoryRequests, callerHistorySelectionHash, decodeCallerHistory, type CallerHistory, type CallerHistorySelection, type CallerSourceLayer } from './advisory-caller-history.js';

/**
 * Advisory-only historical caller measures over a fixed X status corpus.
 * - callerSeedFromEvidence: freezes the corpus from the retained fixed-query attention post sample before any caller read.
 * - replayCallerHistory: offline replay of the frozen seed, exact receipts and optional reviewed classification.
 * - deriveCallerHistoryMetrics: S07/S09/A23, plus A21 under the v3 origin rubric, over current-revision bodies; S11 is not derivable from one search-ranked sample.
 * - supersedingCallerMetrics: historical values fill only metrics the current 24h corpus left unmeasured.
 */
export const CALLER_SEED_METHOD = 'attention-post-sample-14d-v1' as const;
export const CALLER_SELECTION_ID = 'advisory-callers-selection' as const;
export const CALLER_MEASURE_METHOD = 'historical-caller-sample-v1' as const;
const PERIOD_MS = 14 * 86_400_000, MAX_POSTS = 32;
const STATUS = /^https:[/][/]x[.]com[/][a-z0-9_]{1,15}[/]status[/][1-9][0-9]{0,19}$/;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
function fail(code: string): never { throw new Error(code); }

/** The caller arithmetic consumes only four reviewed fields; hosted semantic packets structurally retain their historical contract. */
export type CallerClassification = {token:TokenRef;method:AdvisorySemantic['method']|'recorded-caller-fields-v1';sources:Array<Pick<AdvisorySemantic['sources'][number],'id'|'binding'|'event'|'category'|'topic'|'citations'|'complete'|'accepted'>>};
export type CallerSeed = { selection: CallerHistorySelection; raw: string; evidenceIds: string[] } | { selection: null; code: string };
type Resolved = { raw: Record<string, string>; times: Record<string, string>; requests: Record<string, unknown>; ids: string[] };

/** Seeds come only from the retained attention scope; undated statuses are kept and dated by the official read. */
export function callerSeedFromEvidence(token: TokenRef, evidence: EvidenceRecord[], rawArtifacts: Record<string, string>, frozenAt: string): CallerSeed {
  const none = (code: string): CallerSeed => ({ selection: null, code });
  const end = time(frozenAt), scopeRecord = evidence.find(e => e.id === 'attention-scope' && e.sourceId === 'attention-collector' && e.sourceType === 'SAMPLE_SCOPE' && e.accessMode === 'LOCAL_DERIVED');
  const scopeRaw = scopeRecord ? rawArtifacts[scopeRecord.id] : undefined;
  if (end === null) return none('CALLER_SEED_CLOCK_INVALID');
  if (!scopeRecord || typeof scopeRaw !== 'string') return none('CALLER_SEED_SCOPE_MISSING');
  if (evidence.filter(e => e.id === 'attention-scope').length !== 1) return none('CALLER_SEED_SCOPE_INVALID');
  if (Date.parse(scopeRecord.availableAt) > end) return none('CALLER_SEED_CLOCK_ORDER');
  let scope: any;
  try { scope = JSON.parse(scopeRaw); } catch { return none('CALLER_SEED_SCOPE_INVALID'); }
  const queries: unknown = scope?.queries, ids: unknown = scope?.postSampleSourceIds;
  if (!Array.isArray(queries) || !queries.every(q => typeof q === 'string') || !Array.isArray(ids) || !ids.every(id => typeof id === 'string')) return none('CALLER_SEED_SCOPE_INVALID');
  const start = end - PERIOD_MS, posts: CallerHistorySelection['posts'] = [], excluded: Array<{ seedSourceId: string; reason: string }> = [], statuses = new Set<string>();
  for (const id of ids as string[]) {
    const record = evidence.find(e => e.id === id && e.sourceId === 'tinyfish-fetch' && e.sourceType === 'WEB_PAGE');
    if (!record || evidence.filter(e => e.id === id).length !== 1 || typeof rawArtifacts[id] !== 'string' || Date.parse(record.availableAt) > end) return none('CALLER_SEED_SOURCE_MISSING');
    if (record.scope.kind !== 'POST') { excluded.push({ seedSourceId: id, reason: 'NOT_POST' }); continue; }
    const url = typeof record.scope.url === 'string' ? canonicalSocialUrl(record.scope.url) : '';
    if (!STATUS.test(url)) { excluded.push({ seedSourceId: id, reason: 'NOT_X_STATUS' }); continue; }
    const published = record.scope.publishedAt ?? null, at = time(published);
    if (published !== null && at === null) return none('CALLER_SEED_SOURCE_INVALID');
    if (at !== null && (at < start || at >= end)) { excluded.push({ seedSourceId: id, reason: 'OUTSIDE_PERIOD' }); continue; }
    const status = url.split('/')[5]!;
    if (statuses.has(status)) { excluded.push({ seedSourceId: id, reason: 'DUPLICATE_STATUS' }); continue; }
    statuses.add(status); posts.push({ seedSourceId: id, url });
  }
  if (!posts.length) return none('CALLER_SEED_EMPTY');
  // The cap is a refusal, never a truncation that would choose a convenient subset.
  if (posts.length > MAX_POSTS) return none('CALLER_SEED_OVER_CAP');
  const selection: CallerHistorySelection = { schemaVersion: 1, token: { chain: token.chain, address: token.address }, period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    frozenAt, sourceScopeHash: sha(scopeRaw), queries: queries as string[], posts };
  try { callerHistorySelectionHash(selection); } catch { return none('CALLER_SEED_SCOPE_INVALID'); }
  return { selection, raw: JSON.stringify({ method: CALLER_SEED_METHOD, selection, excluded }), evidenceIds: ['attention-scope', ...posts.map(post => post.seedSourceId)] };
}

/** Offline replay: the seed is recomputed from retained attention evidence and must equal the frozen selection byte for byte. */
export function replayCallerHistory(token: TokenRef, cutoff: string, evidence: EvidenceRecord[], rawArtifacts: Record<string, string>, callers: Resolved, selectionId: string, semantic: Resolved | null, wire: AdvisorySemanticWire = ADVISORY_SEMANTIC_WIRE): AdvisoryMetric[] {
  const record = evidence.find(e => e.id === selectionId && e.sourceId === 'advisory-collector' && e.sourceType === 'SAMPLE_SCOPE' && e.accessMode === 'LOCAL_DERIVED');
  if (selectionId !== CALLER_SELECTION_ID || !record || evidence.filter(e => e.id === selectionId).length !== 1 || record.adapterVersion !== 'live-v1' || record.contentHash !== sha(rawArtifacts[record.id] ?? '') || record.availableAt !== record.retrievedAt || Date.parse(record.availableAt) > Date.parse(cutoff) || record.scope.method !== CALLER_SEED_METHOD) fail('ADVISORY_PROOF_INVALID');
  const seed = callerSeedFromEvidence(token, evidence, rawArtifacts, record.availableAt);
  if (seed.selection === null) fail('ADVISORY_PROOF_INVALID');
  if (seed.raw !== rawArtifacts[record.id]) fail('ADVISORY_PROOF_INVALID');
  const expected = callerHistoryRequests(seed.selection), keys = Object.keys(expected).sort();
  if (JSON.stringify(Object.keys(callers.requests).sort()) !== JSON.stringify(keys) || keys.some(key => JSON.stringify(callers.requests[key]) !== JSON.stringify(expected[key]))) fail('ADVISORY_PROOF_INVALID');
  for (const key of keys) {
    let receipt: any = null;
    try { receipt = JSON.parse(callers.raw[key] ?? ''); } catch { /* A non-JSON receipt cannot bind its evidence clock. */ }
    if (receipt?.retrievedAt !== callers.times[key]) fail('ADVISORY_PROOF_INVALID');
  }
  const history = decodeCallerHistory(seed.selection, callers.raw);
  if (semantic && !history.socialInput.sources.length) fail('ADVISORY_PROOF_INVALID');
  let qualified: AdvisorySemantic | null = null;
  if (semantic) { try { qualified = validateAdvisorySemanticWire(history.socialInput, semantic.raw, token, wire); } catch { /* Invalid or failed classification cannot supply a measured metric. */ } }
  return deriveCallerHistoryMetrics(token, cutoff, history, qualified, [record.id, ...seed.evidenceIds, ...callers.ids, ...(semantic?.ids ?? [])]);
}

/** Reviewed whole-body classifications over the fixed historical sample; roles are structural X metadata, never model labels. */
export function deriveCallerHistoryMetrics(token: TokenRef, cutoff: string, history: CallerHistory, semantic: CallerClassification | null, evidenceIds: string[]): AdvisoryMetric[] {
  const read = history.socialInput, ids = [...new Set(evidenceIds)], metrics: AdvisoryMetric[] = [];
  const scope = { kind: 'HISTORICAL_FIXED_ATTENTION_SAMPLE', seedMethod: CALLER_SEED_METHOD, adapter: history.method, trust: history.trust, period: history.period, frozenAt: history.frozenAt, analysisCutoff: history.analysisCutoff,
    selectionHash: history.selectionHash, sourceScopeHash: history.sourceScopeHash, queries: read.queries, sourceIds: read.targetPostIds,
    excluded: history.layers.filter(l => l.failure).map(l => ({ seedSourceId: l.seedSourceId, statusId: l.statusId, code: l.failure })), limitations: history.limitations,
    meaning: 'Statuses returned by the retained fixed attention queries and dated inside the frozen 14-day period, read after freezing as their current revisions; not a platform census, the original call text, reach or unique people.' };
  const set = (id: string, known: boolean, data: object, reason: string, unit: string) => metrics.push({ id, quality: known ? 'KNOWN' : 'MISSING', unit, data: { method: CALLER_MEASURE_METHOD, scope, ...data }, evidenceIds: ids, reasonCode: reason });
  const layers = new Map(history.layers.map(l => [l.sourceId, l]));
  const timely = Date.parse(history.analysisCutoff) <= Date.parse(cutoff) && read.sources.every(s => Date.parse(s.availableAt) <= Date.parse(cutoff));
  const structural = read.sources.every(s => { const l = layers.get(s.id); return !!l && l.bodyComplete && !!l.role && !!l.edit && l.publishedAt === s.publishedAt; });
  const valid = !!semantic && semantic.token.chain === token.chain && semantic.token.address === token.address && semantic.sources.length === read.sources.length && semantic.sources.every(c => read.sources.some(s => s.id === c.id) && c.complete && c.accepted);
  const rows = read.sources.map(source => ({ source, layer: layers.get(source.id)!, claim: semantic?.sources.find(c => c.id === source.id) }));
  const bindingComplete = rows.every(r => r.claim?.binding === 'EXACT_CONTRACT' || r.claim?.binding === 'UNRELATED');
  const blocked = !timely ? 'HISTORICAL_SAMPLE_AFTER_CUTOFF' : !read.sources.length ? 'HISTORICAL_SAMPLE_EMPTY' : !history.complete || !read.sampleComplete ? 'HISTORICAL_BODIES_INCOMPLETE' : !structural ? 'HISTORICAL_STRUCTURE_INCOMPLETE'
    : !semantic ? 'HISTORICAL_CLASSIFICATION_UNAVAILABLE' : !valid ? 'HISTORICAL_CLASSIFICATION_REJECTED' : !bindingComplete ? 'HISTORICAL_BINDING_UNRESOLVED' : null;
  const measured = blocked === null, eligible = measured ? rows.filter(r => r.claim!.binding === 'EXACT_CONTRACT') : [];
  const eventComplete = measured && eligible.every(r => r.claim!.event !== 'UNCLEAR');
  const role = (l: CallerSourceLayer) => l.role!.quote || l.role!.reply ? 'COMMENTARY' : 'ORIGINAL';
  const events = eligible.filter(r => r.claim!.event === 'FORWARD_CALL').map(({ source, layer, claim }) => ({ sourceId: source.id, url: source.url, statusId: layer.statusId, publishedAt: source.publishedAt, timePrecision: layer.timePrecision,
    authorId: source.authorId, contract: token.address, role: role(layer), quoteStatusId: layer.role!.quoteStatusId, replyToStatusId: layer.role!.replyToStatusId,
    edit: { state: layer.edit!.state, predecessors: layer.edit!.predecessors }, mintLocation: layer.mintLocation, bodySha256: layer.receipts.fxtwitter.bodySha256, classification: claim!.event, citations: claim!.citations }));
  set('S07', eventComplete, { events, classifications: eligible.map(r => ({ sourceId: r.source.id, event: r.claim!.event, role: role(r.layer) })),
    editCoverage: 'Current revision at retrieval only; predecessor bodies are unobserved and predecessor times are status-id creation times.' }, eventComplete ? 'HISTORICAL_CALL_EVENTS_CLASSIFIED' : blocked ?? 'HISTORICAL_EVENT_UNCLEAR', 'scoped-record');
  const counts = new Map<string, number>();
  for (const event of events) if (event.authorId) counts.set(event.authorId, (counts.get(event.authorId) ?? 0) + 1);
  const callerCounts = [...counts].sort(([a, n], [b, m]) => m - n || a.localeCompare(b));
  const callersKnown = eventComplete && events.length > 0 && events.every(event => !!event.authorId && socialAccount(event.url) === event.authorId);
  set('S09', callersKnown, { events, callEvents: events.length, callerCounts,
    top1Share: callersKnown ? new Decimal(callerCounts[0]![1]).div(events.length).toFixed() : null,
    top5Share: callersKnown ? new Decimal(callerCounts.slice(0, 5).reduce((n, [, count]) => n + count, 0)).div(events.length).toFixed() : null, propagationShare: null, reach: null,
    meaning: 'Observed forward-call event shares by public account inside the fixed historical sample; not unique people, followers or propagation reach.' },
    !eventComplete ? blocked ?? 'HISTORICAL_EVENT_UNCLEAR' : !events.length ? 'HISTORICAL_CALL_DENOMINATOR_ZERO' : callersKnown ? 'HISTORICAL_CALLER_CONCENTRATION_OBSERVED' : 'HISTORICAL_CALLER_ATTRIBUTION_UNAVAILABLE', 'fraction-vector');
  const classified = eligible.filter(r => r.claim!.topic !== 'UNKNOWN'), numerator = classified.filter(r => r.claim!.topic === 'PRICE_CHART').length;
  const fractionKnown = measured && eligible.length > 0 && classified.length === eligible.length;
  set('A23', fractionKnown, { eligible: eligible.length, classified: classified.length, unclassified: eligible.length - classified.length, numerator, fraction: fractionKnown ? new Decimal(numerator).div(classified.length).toFixed() : null },
    fractionKnown ? 'HISTORICAL_CLASSIFIED_FRACTION_OBSERVED' : blocked ?? (!eligible.length ? 'HISTORICAL_CLASSIFIED_FRACTION_DENOMINATOR_ZERO' : 'HISTORICAL_CLASSIFIED_FRACTION_INCOMPLETE'), 'fraction');
  // A21 exists only for the v3 origin rubric; legacy v2 categories conflated news with external origin and never become a historical value.
  if (semantic?.method === 'advisory-source-classification-v3' || semantic?.method === 'recorded-caller-fields-v1') {
    const categorized = eligible.filter(r => r.claim!.category !== 'UNKNOWN'), external = categorized.filter(r => r.claim!.category === 'EXTERNAL');
    const originKnown = measured && eligible.length > 0 && categorized.length === eligible.length;
    set('A21', originKnown, { ...ADVISORY_ORIGIN_CATEGORY, eligible: eligible.length, classified: categorized.length, unclassified: eligible.length - categorized.length, numerator: external.length,
      fraction: originKnown ? new Decimal(external.length).div(categorized.length).toFixed() : null, categories: eligible.map(r => ({ sourceId: r.source.id, category: r.claim!.category })),
      external: external.map(r => ({ sourceId: r.source.id, statusId: r.layer.statusId, authorId: r.source.authorId, citations: r.claim!.citations })) },
      originKnown ? 'HISTORICAL_CLASSIFIED_FRACTION_OBSERVED' : blocked ?? (!eligible.length ? 'HISTORICAL_CLASSIFIED_FRACTION_DENOMINATOR_ZERO' : 'HISTORICAL_CLASSIFIED_FRACTION_INCOMPLETE'), 'fraction');
  }
  return metrics;
}

/** Current 24h measurements keep precedence; a historical value enters only where the current metric is not KNOWN. */
export function supersedingCallerMetrics(current: AdvisoryMetric[], historical: AdvisoryMetric[]): AdvisoryMetric[] {
  return historical.filter(metric => metric.quality === 'KNOWN' && !current.some(m => m.id === metric.id && m.quality === 'KNOWN'));
}
