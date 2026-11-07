import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquisitionPurposeMethod,
  criterionPurpose,
  offeredReceiptRefs,
  projectAcquisition,
  receiptEligible,
  renderPurposeReceipt,
  sharedPurpose,
  socialPurpose,
  type AcquisitionFacts,
} from '../src/domain/acquisition-purpose.js';
import { attentionOperationFacts, type AttentionRead, type AttentionSource } from '../src/providers/attention.js';
import { acquisitionEvidenceMethod } from '../src/providers/acquisition-evidence.js';
import { decodeFirecrawlArtifact, type FirecrawlRequest } from '../src/providers/firecrawl.js';
import { purposeReceiptSpans } from '../src/providers/acquisition-evidence.js';
import { sharedClaimSchema } from '../src/domain/shared.js';
import { purposeSharedAliases } from '../src/providers/shared-model.js';

const TOKEN = { chain: 'solana', address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' } as const;
const OTHER_TOKEN = { chain: 'solana', address: 'So11111111111111111111111111111111111111112' } as const;
const AVAILABLE_AT = '2026-10-31T11:55:00.000Z';
const CUTOFF = '2026-10-31T12:00:00.000Z';
const PAGE_URL = 'https://public.example/river-lantern';
const POST_URL = 'https://x.com/river_lantern/status/100';
const BLOCKED_URL = 'https://retired.example/river-lantern';

type Target = AcquisitionFacts['targets'][number];

function readTarget(requestedUrl: string, sourceId: string, options: Partial<Target> = {}): Target {
  return {
    requestedUrl,
    necessary: true,
    sourceId,
    finalUrl: requestedUrl,
    recoveredBySourceId: null,
    plannedRungs: ['tinyfish'],
    attempts: [{ artifactId: 'fetch-1', resultIndex: 0, provider: 'tinyfish', rung: 'tinyfish', kind: 'READ', code: null }],
    budgetExhausted: false,
    planKnown: true,
    ...options,
  };
}

function targetFailure(requestedUrl: string, options: Partial<Target> = {}): Target {
  return {
    requestedUrl,
    necessary: true,
    sourceId: null,
    finalUrl: null,
    recoveredBySourceId: null,
    plannedRungs: ['tinyfish', 'firecrawl'],
    attempts: [{ artifactId: 'fetch-2', resultIndex: 0, provider: 'tinyfish', rung: 'tinyfish', kind: 'TARGET_FAILURE', code: '404' }],
    budgetExhausted: true,
    planKnown: true,
    ...options,
  };
}

function baseFacts(overrides: Partial<AcquisitionFacts> = {}): AcquisitionFacts {
  return {
    group: 'PUBLIC_ENTRY',
    token: TOKEN,
    availableAt: AVAILABLE_AT,
    searches: [
      { id: 'exact-token', required: true, outcome: 'RESULTS', artifactId: 'search-exact-response' },
      { id: 'post-search', required: true, outcome: 'RESULTS', artifactId: 'search-post-response' },
      { id: 'empty-search', required: true, outcome: 'NO_RESULTS', artifactId: 'search-empty-response' },
    ],
    targets: [
      readTarget(PAGE_URL, 'attention-page-1'),
      readTarget(POST_URL, 'attention-page-2', { plannedRungs: ['tinyfish', 'firecrawl'] }),
      targetFailure(BLOCKED_URL),
    ],
    samples: [{ id: 'current-posts', searchIds: ['post-search'], candidateUrls: [POST_URL], dropped: false }],
    fresh: true,
    aborted: false,
    ...overrides,
  };
}

function projectedTarget(requestedUrl: string, projection = projectAcquisition(baseFacts())) {
  const target = projection.targets.find(row => row.requestedUrl === requestedUrl);
  assert.ok(target, `projection omitted ${requestedUrl}`);
  return target;
}

test('projection separates accounted acquisition from a complete measured post sample', () => {
  const projection = projectAcquisition(baseFacts());

  assert.equal(projection.method, acquisitionPurposeMethod);
  assert.equal(projection.accounted, true, 'a necessary target with a fully evidenced target-local block is accounted');
  assert.deepEqual(projection.gaps, []);
  assert.equal(projectedTarget(PAGE_URL, projection).state, 'READ');
  assert.equal(projectedTarget(POST_URL, projection).state, 'READ');
  assert.equal(projectedTarget(BLOCKED_URL, projection).state, 'TARGET_BLOCKED');
  assert.deepEqual(projection.samples[0], {
    id: 'current-posts', sampleComplete: true, searchIds: ['post-search'], candidateUrls: [POST_URL], gaps: [],
  }, 'an unrelated blocked target does not make a fully acquired candidate-post sample incomplete');
});

test('target states require owned attempts and complete planned ladders', () => {
  const plannedButNeverAttempted = targetFailure('https://public.example/never-read', {
    attempts: [], budgetExhausted: true,
  });
  const missingPlan = targetFailure('https://public.example/no-plan', {
    attempts: [], budgetExhausted: true, planKnown: false,
  });
  const unfinishedLadder = targetFailure('https://public.example/unfinished-ladder', { budgetExhausted: false });
  const providerFailure: Target = {
    ...targetFailure('https://public.example/provider-failed'),
    plannedRungs: ['tinyfish'],
    attempts: [{ artifactId: 'fetch-503', resultIndex: null, provider: 'tinyfish', rung: 'tinyfish', kind: 'PROVIDER_FAILURE', code: 'HTTP_503' }],
    budgetExhausted: false,
  };
  const projection = projectAcquisition(baseFacts({
    targets: [plannedButNeverAttempted, missingPlan, unfinishedLadder, providerFailure],
  }));

  assert.equal(projectedTarget(plannedButNeverAttempted.requestedUrl, projection).state, 'UNATTEMPTED',
    'budget exhaustion with zero target failures cannot prove target blocking');
  assert.equal(projectedTarget(missingPlan.requestedUrl, projection).state, 'UNREAD',
    'a missing plan is unknown unless a separately owned body was actually read');
  assert.equal(projectedTarget(unfinishedLadder.requestedUrl, projection).state, 'UNREAD',
    'one target failure does not close a ladder with budget remaining');
  assert.equal(projectedTarget(providerFailure.requestedUrl, projection).state, 'PROVIDER_FAILED');
  assert.equal(projection.accounted, false);
  assert.ok(projection.gaps.includes(`TARGET:${providerFailure.requestedUrl}:PROVIDER_FAILED`));
});

test('a recovered body stays bound to its exact requested URL and recovery owner', () => {
  const apex = 'https://dubblepad.fun/';
  const www = 'https://www.dubblepad.fun/';
  const recoveredUrl = 'https://ipfs.io/ipfs/QmSyntheticMetadata';
  const projection = projectAcquisition(baseFacts({
    targets: [
      readTarget(apex, 'attention-page-9', {
        finalUrl: www,
        attempts: [{ artifactId: 'attention-fetch-1-retry-1', resultIndex: 0, provider: 'tinyfish', rung: 'tinyfish', kind: 'READ', code: null }],
      }),
      readTarget(recoveredUrl, 'attention-origin-page-16', {
        finalUrl: 'https://gateway.example/ipfs/QmSyntheticMetadata',
        recoveredBySourceId: 'attention-origin-page-15',
        plannedRungs: ['tinyfish', 'firecrawl'],
        attempts: [{ artifactId: 'attention-origin-fetch-1', resultIndex: 0, provider: 'firecrawl', rung: 'firecrawl', kind: 'READ', code: null }],
      }),
      {
        requestedUrl: www, necessary: false, sourceId: null, finalUrl: null, recoveredBySourceId: null,
        plannedRungs: ['tinyfish'], attempts: [], budgetExhausted: false, planKnown: true,
      },
    ],
  }));

  const observedRedirect = projectedTarget(apex, projection);
  assert.equal(observedRedirect.state, 'READ');
  assert.equal(observedRedirect.finalUrl, www, 'the redirect is retained as an observation for this exact request');
  assert.equal(projectedTarget(www, projection).state, 'UNATTEMPTED',
    'a final URL is not a general alias for a separately unrequested URL');
  const recovered = projectedTarget(recoveredUrl, projection);
  assert.equal(recovered.state, 'READ');
  assert.equal(recovered.sourceId, 'attention-origin-page-16');
  assert.equal(recovered.recoveredBySourceId, 'attention-origin-page-15',
    'the projection preserves the producer-verified recovery parent instead of substituting URL similarity');
});

test('Attention purpose reconstructs origin, recovery, and ordinary fetch receipts from their owned HTTP namespaces', () => {
  const originUrl = 'https://origin.example/identity';
  const recoveryUrl = 'https://recovery.example/context';
  const ordinaryUrl = 'https://ordinary.example/entry';
  const sources: AttentionSource[] = [
    { id: 'origin-source', url: originUrl, text: 'The retained source describes an Origin_Page and its public details.',
      publishedAt: null, authorId: null, availableAt: AVAILABLE_AT, kind: 'PAGE' },
    { id: 'recovery-source', url: recoveryUrl, text: 'The retained recovery source has exact complete text.',
      publishedAt: null, authorId: null, availableAt: AVAILABLE_AT, kind: 'PAGE' },
    { id: 'ordinary-source', url: ordinaryUrl, text: 'The retained ordinary source has exact complete text.',
      publishedAt: null, authorId: null, availableAt: AVAILABLE_AT, kind: 'PAGE' },
  ];
  const searchRows = [
    { id: 'attention-search-1', query: `"${TOKEN.address}" exact token`, purpose: 'EXACT_TOKEN',
      artifactId: 'attention-search-1-response', status: 200, availableAt: AVAILABLE_AT, required: true },
    { id: 'attention-search-2', query: `"${TOKEN.address}" social posts`, purpose: 'SOCIAL',
      artifactId: 'attention-search-2-response', status: 200, availableAt: AVAILABLE_AT, required: true },
  ];
  const rawArtifacts: Record<string, string> = {
    'attention-acquisition-purpose-plan': JSON.stringify({
      method: acquisitionPurposeMethod, group: 'PUBLIC_ENTRY', token: TOKEN, availableAt: AVAILABLE_AT,
      fallbackEnabled: false, plannedRungs: ['tinyfish', 'tinyfish-retry'], caps: { scrapes: 2, searches: 1 }, skips: [],
    }),
    'attention-acquisition-ledger': JSON.stringify({
      method: acquisitionEvidenceMethod, token: TOKEN, start: AVAILABLE_AT, end: AVAILABLE_AT, searches: searchRows,
    }),
    'attention-search-1-response': JSON.stringify({ results: [] }),
    'attention-search-2-response': JSON.stringify({ results: [] }),
    'attention-origin-fetch-1': JSON.stringify({
      results: [{ url: originUrl, final_url: originUrl, text: 'The retained source describes an Origin\\_Page and its public details.' }], errors: [],
    }),
    'attention-recovery-fetch-1': JSON.stringify({
      results: [{ url: recoveryUrl, final_url: recoveryUrl, text: sources[1]!.text }], errors: [],
    }),
    'attention-fetch-2': JSON.stringify({
      results: [{ url: ordinaryUrl, final_url: ordinaryUrl, text: sources[2]!.text }], errors: [],
    }),
    'criterion-fetch-requests': JSON.stringify({ method: 'criterion-fetch-requests-v1', requests: [
      { artifactId: 'attention-origin-fetch-1', urls: [originUrl] },
      { artifactId: 'attention-recovery-fetch-1', urls: [recoveryUrl] },
      { artifactId: 'attention-fetch-2', urls: [ordinaryUrl] },
    ], omissions: [] }),
    'criterion-origin-http': JSON.stringify({ method: 'criterion-origin-http-v1', artifactId: 'attention-origin-fetch-1', status: 200 }),
    'attention-recovery-http-outcomes': JSON.stringify({ method: 'fetch-http-outcomes-v1', outcomes: [
      { artifactId: 'attention-fetch-1', status: 200 },
    ] }),
    'attention-http-outcomes': JSON.stringify({ method: 'fetch-http-outcomes-v1', outcomes: [
      { artifactId: 'attention-fetch-2', status: 200 },
    ] }),
  };
  const read: AttentionRead = {
    sources, rawArtifacts, queries: [], complete: true, codes: [], start: AVAILABLE_AT, end: AVAILABLE_AT,
    sourceBindings: [
      { sourceId: 'origin-source', producerArtifactId: 'attention-origin-fetch-1', resultIndex: 0,
        requestedUrl: originUrl, transform: 'ORIGIN_UNDERSCORE_V1' },
      { sourceId: 'recovery-source', producerArtifactId: 'attention-recovery-fetch-1', resultIndex: 0,
        requestedUrl: recoveryUrl, transform: 'IDENTITY' },
      { sourceId: 'ordinary-source', producerArtifactId: 'attention-fetch-2', resultIndex: 0,
        requestedUrl: ordinaryUrl, transform: 'IDENTITY' },
    ],
  };

  const facts = attentionOperationFacts(read, TOKEN, CUTOFF);
  for (const url of [originUrl, recoveryUrl, ordinaryUrl]) {
    const target = facts.targets.find(row => row.requestedUrl === url);
    assert.ok(target);
    assert.equal(target.planKnown, true);
    assert.equal(target.attempts[0]?.kind, 'READ', `${url} is admitted from its own response and HTTP namespace`);
  }
  const projection = projectAcquisition(facts);
  assert.deepEqual(projection.targets.map(target => target.state), ['READ', 'READ', 'READ']);
});

test('Firecrawl HTTP 200 target 404 is target-blocked while API HTTP 500 stays provider-failed', () => {
  const targetUrl = 'https://public.example/blocked-page';
  const firecrawlRequest: FirecrawlRequest = { operation: 'SCRAPE', url: targetUrl, at: AVAILABLE_AT };
  const firecrawl = (targetStatus: number, outerStatus: number) => decodeFirecrawlArtifact(firecrawlRequest, JSON.stringify({
    success: true,
    data: { markdown: '', metadata: { statusCode: targetStatus, url: targetUrl, sourceURL: targetUrl } },
  }), outerStatus);
  const makeRead = (targetStatus: number, outerStatus: number): AttentionRead => {
    const result = firecrawl(targetStatus, outerStatus);
    return {
      sources: [], queries: [], complete: true, codes: [], start: AVAILABLE_AT, end: AVAILABLE_AT,
      rawArtifacts: {
        'attention-acquisition-purpose-plan': JSON.stringify({
          method: acquisitionPurposeMethod, group: 'PUBLIC_ENTRY', token: TOKEN, availableAt: AVAILABLE_AT,
          fallbackEnabled: true, plannedRungs: ['tinyfish', 'tinyfish-retry', 'firecrawl'],
          caps: { scrapes: 2, searches: 1 }, skips: [],
        }),
        'attention-acquisition-ledger': JSON.stringify({
          method: acquisitionEvidenceMethod, token: TOKEN, start: AVAILABLE_AT, end: AVAILABLE_AT, searches: [
            { id: 'attention-search-1', query: `"${TOKEN.address}" exact token`, purpose: 'EXACT_TOKEN',
              artifactId: 'attention-search-1-response', status: 200, availableAt: AVAILABLE_AT, required: true },
            { id: 'attention-search-2', query: `"${TOKEN.address}" social posts`, purpose: 'SOCIAL',
              artifactId: 'attention-search-2-response', status: 200, availableAt: AVAILABLE_AT, required: true },
          ],
        }),
        'attention-search-1-response': JSON.stringify({ results: [] }),
        'attention-search-2-response': JSON.stringify({ results: [] }),
        'attention-fetch-1': JSON.stringify({ results: [], errors: [{ url: targetUrl, status: 404, error: 'page_not_found' }] }),
        'attention-http-outcomes': JSON.stringify({ method: 'fetch-http-outcomes-v1', outcomes: [
          { artifactId: 'attention-fetch-1', status: 200 },
        ] }),
        'criterion-fetch-requests': JSON.stringify({ method: 'criterion-fetch-requests-v1',
          requests: [{ artifactId: 'attention-fetch-1', urls: [targetUrl] }],
          omissions: [{ url: targetUrl, purpose: 'EXACT_TOKEN' }] }),
        'firecrawl-scrape-1-request': JSON.stringify({
          method: 'firecrawl-native-operation-v1', request: result.request, status: result.status,
          code: result.code ?? null, httpStatus: result.httpStatus ?? null,
        }),
      },
    };
  };

  const targetHttp404 = firecrawl(404, 200);
  assert.equal(targetHttp404.status, 'UNAVAILABLE');
  assert.equal(targetHttp404.httpStatus, 200, 'the Firecrawl API successfully returned target metadata');
  assert.equal(targetHttp404.code, 'FIRECRAWL_TARGET_HTTP_404');
  const blocked = projectAcquisition(attentionOperationFacts(makeRead(404, 200), TOKEN, CUTOFF));
  assert.equal(blocked.targets.find(target => target.requestedUrl === targetUrl)?.state, 'TARGET_BLOCKED');

  const apiHttp500 = firecrawl(200, 500);
  assert.equal(apiHttp500.status, 'UNAVAILABLE');
  assert.equal(apiHttp500.httpStatus, 500);
  assert.equal(apiHttp500.code, 'FIRECRAWL_HTTP_500');
  const failed = projectAcquisition(attentionOperationFacts(makeRead(200, 500), TOKEN, CUTOFF));
  assert.equal(failed.targets.find(target => target.requestedUrl === targetUrl)?.state, 'PROVIDER_FAILED');
});

test('sample completeness needs a fresh, non-aborted search with a retained response artifact', async t => {
  const scenarios: Array<{ name: string; facts: AcquisitionFacts; gap: string }> = [
    { name: 'stale acquisition', facts: baseFacts({ fresh: false }), gap: 'STALE' },
    { name: 'aborted acquisition', facts: baseFacts({ aborted: true }), gap: 'ABORTED' },
    { name: 'no feeding searches', facts: baseFacts({ samples: [{ id: 'current-posts', searchIds: [], candidateUrls: [POST_URL], dropped: false }] }), gap: 'NO_SEARCHES' },
    {
      name: 'successful search without its response artifact',
      facts: baseFacts({ searches: [
        { id: 'post-search', required: true, outcome: 'RESULTS', artifactId: null },
      ] }),
      gap: 'SEARCH:post-search:RESULTS',
    },
    { name: 'a candidate dropped by a cap', facts: baseFacts({ samples: [{ id: 'current-posts', searchIds: ['post-search'], candidateUrls: [POST_URL], dropped: true }] }), gap: 'DROPPED' },
  ];

  for (const scenario of scenarios) await t.test(scenario.name, () => {
    const projection = projectAcquisition(scenario.facts);
    assert.equal(projection.samples[0]?.sampleComplete, false);
    assert.ok(projection.samples[0]?.gaps.includes(scenario.gap), JSON.stringify(projection.samples[0]?.gaps));
  });
});

test('a provider failure remains unresolved and supplies no bounded-support receipt', () => {
  const failedTarget = targetFailure(BLOCKED_URL, {
    plannedRungs: ['tinyfish'],
    attempts: [{ artifactId: 'fetch-503', resultIndex: null, provider: 'tinyfish', rung: 'tinyfish', kind: 'PROVIDER_FAILURE', code: 'HTTP_503' }],
    budgetExhausted: false,
  });
  const projection = projectAcquisition(baseFacts({ targets: [readTarget(PAGE_URL, 'attention-page-1'), readTarget(POST_URL, 'attention-page-2'), failedTarget] }));
  const failedFact = renderPurposeReceipt(projection).facts.find(fact => fact.id === `target:${BLOCKED_URL}`);
  assert.ok(failedFact);
  const receipt = renderPurposeReceipt(projection);
  const ref = { sourceId: 'acquisition-attention-scope', quote: receipt.text.slice(failedFact.start, failedFact.end), start: failedFact.start, end: failedFact.end };

  assert.equal(projectedTarget(BLOCKED_URL, projection).state, 'PROVIDER_FAILED');
  assert.equal(projection.accounted, false);
  assert.deepEqual(offeredReceiptRefs(projection, 'BOUNDED_SUPPORT', TOKEN, CUTOFF), [],
    'a provider failure cannot be converted to evidence of inadequate public support');
  assert.equal(receiptEligible(projection, ref, 'BOUNDED_SUPPORT', TOKEN, CUTOFF), false);
  assert.equal(receiptEligible(projection, ref, 'UNRESOLVED_CONTEXT', TOKEN, CUTOFF), true,
    'the owned failure may be cited as unresolved operational context only');
});

test('purpose filtering enforces criterion, Social, and Shared outcome semantics', () => {
  assert.equal(criterionPurpose('SUPPORTED', 'ATT-01'), 'BOUNDED_MEASUREMENT');
  assert.equal(criterionPurpose('CONTRADICTED', 'ADV-03'), 'BOUNDED_MEASUREMENT');
  assert.equal(criterionPurpose('INSUFFICIENT', 'NAR-01'), 'BOUNDED_SUPPORT');
  assert.equal(criterionPurpose('SUPPORTED', 'NAR-01'), 'BODY_FACT');
  assert.equal(criterionPurpose('CONTRADICTED', 'NAR-01'), 'FACTUAL_CONFLICT');
  assert.equal(criterionPurpose(null, 'NAR-01'), 'UNRESOLVED_CONTEXT');

  assert.equal(socialPurpose('CONTRADICTED', 'PUBLIC_SUPPORT_INADEQUATE'), 'BOUNDED_SUPPORT');
  assert.equal(socialPurpose('CONTRADICTED', 'FACTUAL_COUNTEREVIDENCE'), 'FACTUAL_CONFLICT');
  assert.equal(socialPurpose('SUPPORTED'), 'BODY_FACT');
  assert.equal(socialPurpose('UNRESOLVED'), 'UNRESOLVED_CONTEXT');

  assert.equal(sharedPurpose('CONFLICT', 'SUPPORTED', 'BODY_FACT'), 'FACTUAL_CONFLICT');
  assert.equal(sharedPurpose('UNCLEAR', 'UNRESOLVED', 'BODY_FACT'), 'UNRESOLVED_CONTEXT');
  assert.equal(sharedPurpose('CLEAR', 'INSUFFICIENT', 'BOUNDED_SUPPORT_DECISION'), 'BOUNDED_SUPPORT');
  assert.equal(sharedPurpose('CLEAR', 'SUPPORTED', 'BOUNDED_MEASUREMENT'), 'BOUNDED_MEASUREMENT');
  assert.equal(sharedPurpose('CLEAR', 'SUPPORTED', 'BODY_FACT'), 'BODY_FACT');
});

test('receipt purposes bind to the right scope, token, freshness, and exact single-purpose spans', () => {
  const projection = projectAcquisition(baseFacts());
  const supportRefs = offeredReceiptRefs(projection, 'BOUNDED_SUPPORT', TOKEN, CUTOFF);
  const measurementRefs = offeredReceiptRefs(projection, 'BOUNDED_MEASUREMENT', TOKEN, CUTOFF);
  const support = supportRefs.find(ref => ref.factId === 'search:empty-search');
  const targetBlock = supportRefs.find(ref => ref.factId === `target:${BLOCKED_URL}`);
  const sample = measurementRefs.find(ref => ref.factId === 'sample:current-posts');
  assert.ok(support && targetBlock && sample);
  assert.equal(support.sourceId, 'acquisition-attention-scope');
  assert.equal(targetBlock.sourceId, 'acquisition-attention-scope');
  assert.equal(measurementRefs.some(ref => ref.factId === 'sample:current-posts'), true);
  assert.equal(supportRefs.some(ref => ref.factId === 'sample:current-posts'), false);
  assert.equal(receiptEligible(projection, support, 'BOUNDED_SUPPORT', TOKEN, CUTOFF), true);
  assert.equal(receiptEligible(projection, sample, 'BOUNDED_MEASUREMENT', TOKEN, CUTOFF), true);
  assert.equal(receiptEligible(projection, support, 'BODY_FACT', TOKEN, CUTOFF), false);
  assert.equal(receiptEligible(projection, support, 'FACTUAL_CONFLICT', TOKEN, CUTOFF), false);

  const receipt = renderPurposeReceipt(projection);
  const readFact = receipt.facts.find(fact => fact.id === `target:${PAGE_URL}`)!;
  const mixedQuote = receipt.text.slice(support.start, readFact.end);
  assert.equal(receiptEligible(projection, {
    sourceId: support.sourceId, quote: mixedQuote, start: support.start, end: readFact.end,
  }, 'BOUNDED_SUPPORT', TOKEN, CUTOFF), false,
  'a span crossing from a NO_RESULTS fact into a READ target cannot inherit bounded-support eligibility');

  assert.equal(receiptEligible(projection, { ...support, quote: `${support.quote} altered` }, 'BOUNDED_SUPPORT', TOKEN, CUTOFF), false);
  assert.equal(receiptEligible(projection, { ...support, sourceId: 'acquisition-social-scope' }, 'BOUNDED_SUPPORT', TOKEN, CUTOFF), false);
  assert.equal(receiptEligible(projection, support, 'BOUNDED_SUPPORT', OTHER_TOKEN, CUTOFF), false);
  assert.equal(receiptEligible(projection, support, 'BOUNDED_SUPPORT', TOKEN, '2026-10-31T12:10:01.000Z'), false,
    'a receipt older than the existing fifteen-minute freshness limit is not citable');
  assert.equal(receiptEligible(projection, support, 'BOUNDED_SUPPORT', TOKEN, '2026-10-31T11:54:59.000Z'), false,
    'a future-dated receipt is not citable');

  const socialProjection = projectAcquisition(baseFacts({ group: 'SOCIAL_ENTRY' }));
  const socialRef = offeredReceiptRefs(socialProjection, 'BOUNDED_SUPPORT', TOKEN, CUTOFF)[0];
  assert.ok(socialRef);
  assert.equal(socialRef.sourceId, 'acquisition-social-scope');
  assert.equal(receiptEligible(socialProjection, support, 'BOUNDED_SUPPORT', TOKEN, CUTOFF), false,
    'an Attention scope receipt cannot be replayed as Social acquisition evidence');
});

test('large measured-sample receipt offers exact shared citation chunks within the source-span limit', () => {
  for (const count of [20, 64]) {
    const candidateUrls = Array.from({ length: count }, (_, index) =>
      `https://sample-${index + 1}.example/public/research/evidence/retained-post/long-reference-${index + 1}`);
    const projection = projectAcquisition(baseFacts({
      searches: [{ id: 'sample-search', required: true, outcome: 'NO_RESULTS', artifactId: 'sample-search-response' }],
      targets: candidateUrls.map((url, index) => readTarget(url, `sample-source-${index + 1}`)),
      samples: [{ id: 'posts', searchIds: ['sample-search'], candidateUrls, dropped: false }],
    }));
    const receipt = renderPurposeReceipt(projection);
    const fact = receipt.facts.find(row => row.id === 'sample:posts')!;
    const sourceId = 'acquisition-attention-scope';
    const catalog = purposeReceiptSpans(projection);
    const catalogChunks = catalog.filter(span => span.factId === fact.id);
    const offered = offeredReceiptRefs(projection, 'BOUNDED_MEASUREMENT', TOKEN, CUTOFF)
      .filter(ref => ref.factId === fact.id);

    assert.ok(catalogChunks.length > 1, `${count} source references split at the existing 1,000-character quote limit`);
    assert.ok(catalogChunks.every(span => span.text.length <= 1_000));
    assert.equal(catalogChunks[0]!.start, fact.start);
    assert.equal(catalogChunks.at(-1)!.end, fact.end);
    assert.ok(catalogChunks.slice(1).every((span, index) => span.start === catalogChunks[index]!.end),
      'the exact source ranges are contiguous with no omitted or duplicated characters');
    assert.equal(catalogChunks.map(span => span.text).join(''), receipt.text.slice(fact.start, fact.end),
      'chunking preserves the complete measured-sample fact exactly');
    assert.deepEqual(offered.map(({ sourceId: offeredSource, start, end, quote }) => ({ sourceId: offeredSource, start, end, text: quote })),
      catalogChunks.map(({ start, end, text }) => ({ sourceId, start, end, text })),
    'the eligibility offers and Shared citation catalog expose the same exact owned chunks');
    for (const chunk of offered) {
      assert.equal(receipt.text.slice(chunk.start, chunk.end), chunk.quote);
      assert.equal(receiptEligible(projection, chunk, 'BOUNDED_MEASUREMENT', TOKEN, CUTOFF), true);
    }

    const receiptSource = {
      id: sourceId, kind: 'ACQUISITION_RECEIPT' as const, token: TOKEN, operation: 'ACQUISITION_SCOPE' as const,
      artifactIds: ['sample-search-response'], availableAt: AVAILABLE_AT, text: receipt.text,
    };
    const purpose = { token: TOKEN, cutoff: CUTOFF, projections: [projection] };
    const claim = sharedClaimSchema.parse({
      id: 'criterion:ATT-01', statement: `The complete bounded sample contains ${count} retained references.`,
      supportBasis: 'BOUNDED_MEASUREMENT', citations: offered.map(ref => ({ sourceId: ref.sourceId, quote: ref.quote })),
      criterionReviewContext: {
        method: 'criterion-review-v1', criterionId: 'ATT-01', outcome: 'SUPPORTED', basis: 'BOUNDED_MEASUREMENT',
        question: 'Is the measured public sample complete?', requiredSupport: ['sample completeness'], missingSupport: [],
        premises: [], suppliedSourceIds: [sourceId],
        measured: { posts: count, authors: count, previous: 0, current: count, complete: true },
      },
    });
    const eligibleAliases = purposeSharedAliases([claim], [receiptSource], purpose)[claim.id]!.CLEAR;
    const expectedAliases = catalogChunks.map(span => `s${String(catalog.indexOf(span) + 1).padStart(4, '0')}`);
    assert.deepEqual(eligibleAliases, expectedAliases,
      'a generated marked Shared measurement claim admits the same measurement-only receipt chunks');
  }
});
