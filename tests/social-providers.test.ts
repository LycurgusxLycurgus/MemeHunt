import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSocialAcquisitionScope, collectSocialSources } from '../src/providers/social.js';
import { buildAttentionAcquisitionScope, collectAttentionSources, entryEvidenceScope } from '../src/providers/attention.js';
import { acquisitionEvidenceMethod } from '../src/providers/acquisition-evidence.js';
import { deriveSocial } from '../src/domain/social.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { explainChecks, renderSnapshot } from '../src/app/report.js';
import type { EntrySnapshot, FeatureResult } from '../src/domain/contracts.js';
import type { AttentionRead, AttentionSource } from '../src/providers/attention.js';
import { completeFixtureEntryFeatures, illustrativeUncalibratedProfile } from '../examples/fixtures.js';
import { SOCIAL_AVAILABLE, SOCIAL_CUTOFF, SOCIAL_END, SOCIAL_START, SOCIAL_TOKEN } from './social-fixtures.js';

const POST: AttentionSource = {
  id: 'target-post', url: 'https://x.com/alice/status/100', text: `${SOCIAL_TOKEN.address} has a public note.`,
  publishedAt: '2026-10-03T10:00:00.000Z', authorId: 'x.com:alice', availableAt: SOCIAL_AVAILABLE, kind: 'POST',
};

function attention(sources: AttentionSource[], overrides: Partial<AttentionRead> = {}): AttentionRead {
  return {
    sources, rawArtifacts: {}, queries: ['synthetic original target query'], complete: true, postSampleComplete: true,
    codes: [], start: SOCIAL_START, end: SOCIAL_END, postSampleSourceIds: [POST.id],
    ...overrides,
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

const METADATA_URI = 'https://ipfs.io/ipfs/QmSyntheticTokenMetadata/token.json';

const PRIVATE_ERROR_MARKER = 'social-private-error-marker-7a9d';

function socialReport(read: Awaited<ReturnType<typeof collectSocialSources>>) {
  const { rawArtifacts, ...socialInput } = read;
  assert.ok(rawArtifacts, 'collector receipts are retained before the production input boundary');
  const social = deriveSocial(socialInput, null, null, SOCIAL_TOKEN, SOCIAL_CUTOFF, ['social-collection-test']);
  const socialFeatures = new Map(social.assessments.flatMap(row => row.projection ? [[row.id, row.projection] as const] : []));
  const features: FeatureResult[] = completeFixtureEntryFeatures().map(feature => socialFeatures.get(feature.id) ?? feature);
  const result = evaluateEntry(features, illustrativeUncalibratedProfile, SOCIAL_CUTOFF, 'QUALIFIED_V4', social.facts);
  const snapshot: EntrySnapshot = {
    id: 'social-collection-test-snapshot', caseId: 'social-collection-test-case', checklistKind: 'ENTRY',
    token: SOCIAL_TOKEN, cutoff: SOCIAL_CUTOFF, analysisKind: 'FIXTURE', features, evidence: [], result,
    hash: 'a'.repeat(64),
    details: {
      version: 1, profile: illustrativeUncalibratedProfile, thesis: null, baseline: social.assessments,
      origins: {}, stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null }, social: social.facts,
    },
  };
  return { social, result, snapshot, rows: explainChecks(snapshot), rendered: renderSnapshot(snapshot) };
}

test('social collection carries the fresh outcome marker into its canonical read and acquisition receipt', async () => {
  const freshAttention = attention([POST], {
    outcomeBasisMethod: 'entry-outcome-basis-v1', discoveryUrls: [], postSampleSourceIds: [POST.id],
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.search.tinyfish.ai/')) return response({ results: [], errors: [] });
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const urls = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
      return response({ results: urls.map(item => ({ url: item, final_url: item, text: `Public account record for ${SOCIAL_TOKEN.address}.` })), errors: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, freshAttention, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  const receipt = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as { read: { outcomeBasisMethod?: string } };
  assert.equal(read.outcomeBasisMethod, 'entry-outcome-basis-v1');
  assert.equal(receipt.read.outcomeBasisMethod, 'entry-outcome-basis-v1',
    'the self-contained acquisition receipt carries the marker needed to validate the next model stage');

  const legacy = await collectSocialSources(SOCIAL_TOKEN, attention([POST], {
    discoveryUrls: [], postSampleSourceIds: [POST.id],
  }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  assert.equal(legacy.outcomeBasisMethod, undefined);
  const legacyReceipt = JSON.parse(legacy.rawArtifacts['social-acquisition-scope']!) as { read: { outcomeBasisMethod?: string } };
  assert.equal(legacyReceipt.read.outcomeBasisMethod, undefined, 'unmarked historical attention reads stay unmarked through the producer');
});

test('fresh empty discovery retains successful Attention and Social searches as separate receipt-only evidence', async t => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.startsWith('https://api.search.tinyfish.ai/')) {
      calls.push(new URL(url).searchParams.get('query') ?? '');
      return response({ results: [], errors: [] });
    }
    throw new Error(`A zero-result discovery must not fetch an invented page: ${url}`);
  };
  const collectedAttention = await collectAttentionSources(
    SOCIAL_TOKEN, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE,
    undefined, [], undefined, 'public-support-v2', undefined, acquisitionEvidenceMethod,
  );
  collectedAttention.acquisitionDiscovery = { metadataState: 'NOT_APPLICABLE', dexArtifactId: 'dex-discovery' };
  collectedAttention.rawArtifacts['dex-discovery'] = JSON.stringify([]);
  collectedAttention.acquisitionScope = buildAttentionAcquisitionScope(collectedAttention, SOCIAL_TOKEN, SOCIAL_CUTOFF);
  for (const receipt of collectedAttention.acquisitionScope.evidence) collectedAttention.rawArtifacts[receipt.id] = receipt.text;
  assert.equal(collectedAttention.sources.length, 0);
  assert.equal(collectedAttention.acquisitionScope.complete, true,
    `a completed zero-result exact-token/social search is a complete acquisition scope: ${collectedAttention.acquisitionScope.blockers.join(', ')}`);
  assert.equal(entryEvidenceScope(collectedAttention, SOCIAL_TOKEN, SOCIAL_CUTOFF).complete, true,
    'the marked public scope uses the canonical receipt facade to clear only its empty-source and inapplicable-comparison gates');

  const collectedSocial = await collectSocialSources(
    SOCIAL_TOKEN, collectedAttention, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE,
  );
  collectedSocial.acquisitionScope = buildSocialAcquisitionScope(
    collectedAttention, collectedSocial, collectedSocial.rawArtifacts, SOCIAL_TOKEN, SOCIAL_CUTOFF,
  );
  for (const receipt of collectedSocial.acquisitionScope.evidence) collectedSocial.rawArtifacts[receipt.id] = receipt.text;

  assert.equal(calls.length, 3, 'two exact Attention searches and one required Social search ran');
  assert.equal(collectedSocial.sources.length, 0, 'no PAGE or POST is fabricated from a receipt');
  assert.equal(collectedSocial.acquisitionScope.complete, true,
    `the required Social search and source accounting complete honestly: ${collectedSocial.acquisitionScope.blockers.join(', ')}`);
  assert.equal(collectedSocial.acquisitionScope.sourceIds.length, 0);
  assert.deepEqual(collectedSocial.acquisitionScope.requiredEvidenceIds, ['acquisition-social-scope']);
  assert.ok(collectedSocial.acquisitionScope.evidence[0]!.artifactIds.includes('social-acquisition-social-search-1-response'));
  assert.equal(collectedSocial.acquisitionScope.evidence[0]!.availableAt, SOCIAL_AVAILABLE,
    'receipt time is the actual retained ledger end and stays stable when rebuilt at a later review cutoff');

  const later = buildSocialAcquisitionScope(
    collectedAttention, collectedSocial, collectedSocial.rawArtifacts, SOCIAL_TOKEN, SOCIAL_CUTOFF,
  );
  assert.deepEqual(later.evidence, collectedSocial.acquisitionScope.evidence,
    'canonical receipt contents do not refresh merely because a later qualification cutoff is used');

  const forged = { ...collectedSocial.rawArtifacts };
  const requestId = 'social-acquisition-social-search-1-request';
  const request = JSON.parse(forged[requestId]!) as Record<string, unknown>;
  request.query = 'unrelated query';
  forged[requestId] = JSON.stringify(request);
  const rejected = buildSocialAcquisitionScope(collectedAttention, collectedSocial, forged, SOCIAL_TOKEN, SOCIAL_CUTOFF);
  assert.equal(rejected.complete, false, 'a rehashed descriptor cannot substitute a different actual query');
  assert.ok(rejected.blockers.includes('ACQUISITION_QUERY_BINDING_INVALID'));

  const unavailableSearch: typeof fetch = async input => {
    const query = new URL(String(input)).searchParams.get('query') ?? '';
    return query.includes('narrative origin catalyst')
      ? response({ error: 'unavailable' }, 503)
      : response({ results: [], errors: [] });
  };
  const interruptedAttention = await collectAttentionSources(
    SOCIAL_TOKEN, 'synthetic-provider-key', unavailableSearch, () => SOCIAL_AVAILABLE,
    undefined, [], undefined, 'public-support-v2', undefined, acquisitionEvidenceMethod,
  );
  interruptedAttention.acquisitionDiscovery = { metadataState: 'NOT_APPLICABLE', dexArtifactId: 'dex-discovery' };
  interruptedAttention.rawArtifacts['dex-discovery'] = JSON.stringify([]);
  interruptedAttention.acquisitionScope = buildAttentionAcquisitionScope(interruptedAttention, SOCIAL_TOKEN, SOCIAL_CUTOFF);
  assert.equal(entryEvidenceScope(interruptedAttention, SOCIAL_TOKEN, SOCIAL_CUTOFF).complete, false,
    'one failed required exact-token query remains a public-entry blocker despite a successful zero-result sibling');
  assert.ok(entryEvidenceScope(interruptedAttention, SOCIAL_TOKEN, SOCIAL_CUTOFF).blockers.some(code => /503|INCOMPLETE/.test(code)));

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(SOCIAL_AVAILABLE) });
  let failedSearchAttempts = 0;
  const failedFetcher: typeof fetch = async input => {
    const url = String(input);
    if (url.startsWith('https://api.search.tinyfish.ai/')) {
      failedSearchAttempts++;
      throw new TypeError(`private transport failure ${PRIVATE_ERROR_MARKER}`);
    }
    throw new Error(`Unexpected provider: ${url}`);
  };
  const pending = collectSocialSources(
    SOCIAL_TOKEN, collectedAttention, 'synthetic-provider-key', failedFetcher, () => SOCIAL_AVAILABLE,
  );
  const failedSocial = await exhaustThreeReadAttempts(t, pending);
  assert.equal(failedSearchAttempts, 3, 'the existing bounded Social retry handles one required failed query');
  const failedLedger = JSON.parse(failedSocial.rawArtifacts['social-acquisition-ledger']!) as { searches: Array<{ id: string; status: number }> };
  assert.equal(failedLedger.searches.some(row => row.id === 'social-search-1'), false,
    'a statusless failure never creates a Search result row');
  assert.ok(failedSocial.rawArtifacts['social-acquisition-social-search-1-attempt'],
    'the actual failed request, safe code and time remain linked outside the status-bearing ledger');
  const interrupted = buildSocialAcquisitionScope(collectedAttention, failedSocial, failedSocial.rawArtifacts, SOCIAL_TOKEN, SOCIAL_CUTOFF);
  assert.equal(interrupted.complete, false);
  assert.ok(interrupted.blockers.includes('ACQUISITION_SOCIAL_COLLECTION_INCOMPLETE'));
  assert.doesNotMatch(JSON.stringify(failedSocial.rawArtifacts), new RegExp(PRIVATE_ERROR_MARKER));
});

function assertUnknownIdentity(read: Awaited<ReturnType<typeof collectSocialSources>>, expectedCode: string, expectedKind?: 'INFRA') {
  const { result, rows, rendered, snapshot } = socialReport(read);
  const identity = rows.find(row => row.checkId === 'SOC-01');
  assert.equal(identity?.status, 'UNKNOWN', 'an incomplete identity scope cannot become a policy PASS or FAIL');
  if (expectedKind) assert.equal(identity?.unknownKind, expectedKind);
  else assert.notEqual(identity?.unknownKind, 'INFRA', 'a non-transport collection failure cannot be reported as infrastructure');
  assert.ok(identity?.causes.some(cause => cause.code === expectedCode), `SOC-01 retains ${expectedCode}`);
  assert.equal(result.classification, 'INSUFFICIENT_DATA');
  if (expectedKind) assert.match(rendered, new RegExp(`UNKNOWN \\(${expectedKind}\\)\\s+SOC-01`));
  else assert.doesNotMatch(rendered, /UNKNOWN \(INFRA\)\s+SOC-01/);
  const detail = renderSnapshot(snapshot, { check: 'SOC-01' });
  if (expectedKind) assert.match(detail, new RegExp(`SOC-01 .* UNKNOWN \\(${expectedKind}\\)`));
  else assert.doesNotMatch(detail, /SOC-01 .* UNKNOWN \(INFRA\)/);
  assert.match(detail, new RegExp(expectedCode));
  assert.doesNotMatch(JSON.stringify(read.rawArtifacts) + rendered + detail, new RegExp(PRIVATE_ERROR_MARKER));
}

async function flushSocialRetryMicrotasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

async function exhaustThreeReadAttempts<T>(t: { mock: { timers: { tick: (milliseconds: number) => void } } }, pending: Promise<T>): Promise<T> {
  await flushSocialRetryMicrotasks();
  t.mock.timers.tick(1000);
  await flushSocialRetryMicrotasks();
  t.mock.timers.tick(2000);
  await flushSocialRetryMicrotasks();
  return pending;
}

test('required social Search timeout remains incomplete UNKNOWN infrastructure with a safe retained cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(SOCIAL_AVAILABLE) });
  let requiredAttempts = 0;
  const fetcher: typeof fetch = async input => {
    const query = new URL(String(input)).searchParams.get('query') ?? '';
    if (query.includes('official project website social account')) {
      requiredAttempts++;
      throw Object.assign(new Error(`private search request ${PRIVATE_ERROR_MARKER}`), { name: 'TimeoutError' });
    }
    return response({ results: [] });
  };
  const pending = collectSocialSources(SOCIAL_TOKEN, attention([POST], {
    discoveryUrls: [], postSampleSourceIds: [POST.id],
  }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  const read = await exhaustThreeReadAttempts(t, pending);

  assert.equal(requiredAttempts, 3, 'the real bounded transport retry completes before collection records its cause');
  assert.equal(read.identityComplete, false);
  assert.ok(read.codes.includes('SOC_SEARCH_TIMEOUT'));
  const diagnostic = read.rawArtifacts['social-collection-search-1-error'];
  assert.ok(diagnostic, 'the required-search failure is retained as local derived evidence');
  assert.deepEqual(JSON.parse(diagnostic), {
    method: 'social-collection-error-v1', operation: 'SEARCH', code: 'SOC_SEARCH_TIMEOUT', required: true,
  });
  assertUnknownIdentity(read, 'SOC_SEARCH_TIMEOUT', 'INFRA');
});

test('required social Fetch transport failure remains incomplete UNKNOWN infrastructure with a safe retained cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(SOCIAL_AVAILABLE) });
  const requiredUrl = 'https://project.example/about';
  let requiredAttempts = 0;
  let optionalProfileFetches = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.search.tinyfish.ai/') return response({ results: [] });
    if (url !== 'https://api.fetch.tinyfish.ai/') throw new Error(`Unexpected provider: ${url}`);
    const request = JSON.parse(String(init?.body)) as { urls: string[] };
    if (request.urls.includes(requiredUrl)) {
      requiredAttempts++;
      throw new TypeError(`private fetch transport ${PRIVATE_ERROR_MARKER}`);
    }
    optionalProfileFetches++;
    return response({
      results: request.urls.map(sourceUrl => ({ url: sourceUrl, final_url: sourceUrl, text: 'Public optional profile context.' })),
      errors: [],
    });
  };
  const pending = collectSocialSources(SOCIAL_TOKEN, attention([POST], {
    discoveryUrls: [requiredUrl], postSampleSourceIds: [POST.id],
  }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  const read = await exhaustThreeReadAttempts(t, pending);

  assert.equal(requiredAttempts, 3, 'the real bounded transport retry completes before collection records its cause');
  assert.equal(optionalProfileFetches, 1, 'the optional account-context request still runs independently');
  assert.equal(read.identityComplete, false);
  assert.ok(read.codes.includes('SOC_FETCH_TRANSPORT'));
  const diagnostic = read.rawArtifacts['social-collection-fetch-1-error'];
  assert.ok(diagnostic, 'the required-Fetch failure is retained as local derived evidence');
  assert.deepEqual(JSON.parse(diagnostic), {
    method: 'social-collection-error-v1', operation: 'FETCH', code: 'SOC_FETCH_TRANSPORT', required: true,
  });
  assertUnknownIdentity(read, 'SOC_FETCH_TRANSPORT', 'INFRA');
});

test('malformed Search, HTTP 404, blocked pages, and text caps remain collection unknowns', async t => {
  const searchCases: Array<{ name: string; code: string; response: Response }> = [
    { name: 'malformed Search JSON', code: 'SOC_SEARCH_SHAPE', response: new Response('{ malformed', { status: 200 }) },
    { name: 'HTTP 404 Search result', code: 'SOC_SEARCH_HTTP_404', response: new Response('not found', { status: 404 }) },
  ];
  for (const scenario of searchCases) await t.test(scenario.name, async () => {
    const fetcher: typeof fetch = async input => {
      const query = new URL(String(input)).searchParams.get('query') ?? '';
      return query.includes('official project website social account') ? scenario.response.clone() : response({ results: [] });
    };
    const read = await collectSocialSources(SOCIAL_TOKEN, attention([POST], {
      discoveryUrls: [], postSampleSourceIds: [POST.id],
    }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
    assert.equal(read.identityComplete, false);
    assert.ok(read.codes.includes(scenario.code));
    assertUnknownIdentity(read, scenario.code);
  });

  const requiredUrl = 'https://project.example/about';
  const fetchCases: Array<{ name: string; code: string; makeResponse: () => Response }> = [
    {
      name: 'blocked required page', code: 'SOC_FETCH_URL_ERROR',
      makeResponse: () => response({ results: [], errors: [{ url: requiredUrl, error: 'blocked' }] }),
    },
    {
      name: 'required page text cap', code: 'SOC_TEXT_CAP',
      makeResponse: () => response({ results: [{ url: requiredUrl, final_url: requiredUrl, text: 'x'.repeat(120_001) }], errors: [] }),
    },
  ];
  for (const scenario of fetchCases) await t.test(scenario.name, async () => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://api.search.tinyfish.ai/') return response({ results: [] });
      if (url !== 'https://api.fetch.tinyfish.ai/') throw new Error(`Unexpected provider: ${url}`);
      const request = JSON.parse(String(init?.body)) as { urls: string[] };
      if (request.urls.includes(requiredUrl)) return scenario.makeResponse();
      return response({
        results: request.urls.map(sourceUrl => ({ url: sourceUrl, final_url: sourceUrl, text: 'Public optional profile context.' })),
        errors: [],
      });
    };
    const read = await collectSocialSources(SOCIAL_TOKEN, attention([POST], {
      discoveryUrls: [requiredUrl], postSampleSourceIds: [POST.id],
    }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
    assert.equal(read.identityComplete, false);
    assert.ok(read.codes.includes(scenario.code));
    assertUnknownIdentity(read, scenario.code);
  });
});

test('optional account-context failure is retained without making the required identity roots incomplete', async () => {
  const website: AttentionSource = {
    id: 'retained-identity-website', url: 'https://project.example/about', text: `The project for ${SOCIAL_TOKEN.address} identifies its public scope.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.search.tinyfish.ai/') return response({ results: [] });
    if (url !== 'https://api.fetch.tinyfish.ai/') throw new Error(`Unexpected provider: ${url}`);
    const request = JSON.parse(String(init?.body)) as { urls: string[] };
    assert.ok(request.urls.every(sourceUrl => sourceUrl === 'https://x.com/alice'), 'only optional account context is requested');
    throw new Error(`private optional account context ${PRIVATE_ERROR_MARKER}`);
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, attention([POST, website], {
    discoveryUrls: [website.url], postSampleSourceIds: [POST.id],
  }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);

  assert.equal(read.identityComplete, true, 'a retained required identity page stays complete when optional account context fails');
  assert.ok(read.codes.includes('SOC_ACCOUNT_CONTEXT_UNAVAILABLE'));
  assert.equal(read.codes.some(code => code.startsWith('SOC_FETCH_')), false, 'the optional error is not promoted to a required Fetch failure');
  const diagnostic = read.rawArtifacts['social-collection-fetch-1-error'];
  assert.ok(diagnostic);
  assert.deepEqual(JSON.parse(diagnostic), {
    method: 'social-collection-error-v1', operation: 'FETCH', code: 'SOC_FETCH_UNAVAILABLE', required: false,
  });
  const { rows, rendered } = socialReport(read);
  const identity = rows.find(row => row.checkId === 'SOC-01');
  assert.equal(identity?.status, 'UNKNOWN', 'no model review means the completed scope remains unresolved');
  assert.notEqual(identity?.unknownKind, 'INFRA', 'the optional provider miss cannot label required identity infrastructure unavailable');
  assert.doesNotMatch(JSON.stringify(read.rawArtifacts) + rendered, new RegExp(PRIVATE_ERROR_MARKER));
});

test('a completed identity discovery with no official account claim stays distinct from a failed search', async () => {
  const completedSearch: typeof fetch = async input => {
    assert.ok(String(input).startsWith('https://api.search.tinyfish.ai/'));
    return response({ results: [] });
  };
  const complete = await collectSocialSources(SOCIAL_TOKEN, attention([POST], {
    discoveryUrls: [], postSampleSourceIds: [POST.id],
  }), 'synthetic-provider-key', completedSearch, () => SOCIAL_AVAILABLE);

  assert.equal(complete.entryDecisionMethod, 'public-support-v3');
  assert.equal(complete.identityComplete, true);
  assert.deepEqual(complete.identitySourceIds, []);
  assert.deepEqual(complete.sources.map(source => source.id), [POST.id]);
  assert.ok(!complete.codes.some(code => code.startsWith('SOC_SEARCH_')),
    'an optional profile-context miss does not turn successful identity discovery into a required search failure');

  const failedSearch: typeof fetch = async input => {
    assert.ok(String(input).startsWith('https://api.search.tinyfish.ai/'));
    return response({ error: 'temporarily unavailable' }, 503);
  };
  const failed = await collectSocialSources(SOCIAL_TOKEN, attention([POST], {
    discoveryUrls: [], postSampleSourceIds: [POST.id],
  }), 'synthetic-provider-key', failedSearch, () => SOCIAL_AVAILABLE);

  assert.equal(failed.entryDecisionMethod, 'public-support-v3');
  assert.equal(failed.identityComplete, false, 'a failed search cannot be interpreted as an empty official identity scope');
  assert.deepEqual(failed.identitySourceIds, []);
  assert.ok(failed.codes.includes('SOC_SEARCH_HTTP_503'));
});

test('fresh source-bound social collection emits the literal-association marker while legacy collection stays unmarked', async () => {
  const completedSearch: typeof fetch = async input => {
    assert.ok(String(input).startsWith('https://api.search.tinyfish.ai/'));
    return response({ results: [] });
  };
  const freshAttention = attention([POST], {
    discoveryUrls: [], postSampleSourceIds: [POST.id], leadershipPositiveMethod: 'source-bound-positive-v1',
  });
  const fresh = await collectSocialSources(SOCIAL_TOKEN, freshAttention, 'synthetic-provider-key', completedSearch, () => SOCIAL_AVAILABLE);
  const legacy = await collectSocialSources(SOCIAL_TOKEN, attention([POST], {
    discoveryUrls: [], postSampleSourceIds: [POST.id],
  }), 'synthetic-provider-key', completedSearch, () => SOCIAL_AVAILABLE);

  assert.equal(fresh.associationCitationMethod, 'literal-associations-v1');
  assert.equal(fresh.inspectionRecoveryMethod, 'retained-source-inspection-v2');
  assert.equal(legacy.associationCitationMethod, undefined, 'legacy collection without the fresh source-bound marker retains its old wire');
  assert.equal(legacy.inspectionRecoveryMethod, undefined);
});

test('a retained required HTTP 404 or 410 is a bounded identity gap only after successful batch HTTP; whole-request failures and legacy mode stay incomplete', async t => {
  const requiredUrl = 'https://project.example/identity-source';
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(SOCIAL_AVAILABLE) });
  const run = async (status: number, fresh: boolean, batchHttpStatus = 200) => {
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url !== 'https://api.fetch.tinyfish.ai/') throw new Error(`Unexpected provider: ${url}`);
      const request = JSON.parse(String(init?.body)) as { urls: string[] };
      return response({
        results: request.urls.filter(sourceUrl => sourceUrl !== requiredUrl).map(sourceUrl => ({
          url: sourceUrl, final_url: sourceUrl, text: 'Public optional profile context.',
        })),
        errors: request.urls.filter(sourceUrl => sourceUrl === requiredUrl).map(sourceUrl => ({
          url: sourceUrl, status, error: status === 404 || status === 410 ? 'page_not_found' : 'upstream unavailable',
        })),
      }, request.urls.includes(requiredUrl) ? batchHttpStatus : 200);
    };
    const read = await collectSocialSources(SOCIAL_TOKEN, attention([POST], {
      discoveryUrls: [requiredUrl], postSampleSourceIds: [POST.id],
      ...(fresh ? { leadershipPositiveMethod: 'source-bound-positive-v1' as const } : {}),
    }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
    const scope = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as {
      selection: Array<{ url: string; required: boolean; status: string }>;
    };
    return { read, scope };
  };

  for (const status of [404, 410] as const) {
    const { read, scope } = await run(status, true);
    const code = status === 404 ? 'HTTP_404' : 'HTTP_410';
    assert.equal(read.screeningConstraintMethod, 'frozen-positive-guards-v2');
    assert.equal(read.identityComplete, true, 'a terminal public-source gap does not turn the collection into a transport outage');
    assert.deepEqual(read.identityUnavailableSources, [{ url: requiredUrl, code }]);
    assert.equal(read.sources.some(source => source.url === requiredUrl), false, 'the unavailable URL does not become fabricated source text');
    assert.ok(read.codes.includes(`SOC_IDENTITY_${code}`));
    assert.ok(scope.selection.some(row => row.url === requiredUrl && row.required && row.status === `TERMINAL_${code}`));
    assert.deepEqual(JSON.parse(read.rawArtifacts['social-http-outcome-1']!), {
      method: 'social-fetch-http-v1', status: 200, ok: true,
    }, 'the per-URL gap is bound to a successful outer Fetch response');
  }

  const { read: failed, scope: failedScope } = await run(500, true);
  assert.equal(failed.identityComplete, false, 'a 500 remains incomplete acquisition');
  assert.equal(failed.identityUnavailableSources, undefined, 'a server error cannot be relabeled as a terminal absence');
  assert.ok(failed.codes.includes('SOC_FETCH_URL_ERROR'));
  assert.ok(failedScope.selection.some(row => row.url === requiredUrl && row.required && row.status === 'SOC_FETCH_URL_ERROR'));

  const failedBatchPending = run(404, true, 503);
  const { read: failedBatch, scope: failedBatchScope } = await exhaustThreeReadAttempts(t, failedBatchPending);
  assert.equal(failedBatch.identityComplete, false, 'a 503 body cannot complete required identity acquisition');
  assert.equal(failedBatch.identityUnavailableSources, undefined, 'a per-URL 404 inside a failed HTTP response is not a terminal source gap');
  assert.ok(failedBatch.codes.includes('SOC_FETCH_HTTP_503'));
  assert.deepEqual(JSON.parse(failedBatch.rawArtifacts['social-http-outcome-1']!), {
    method: 'social-fetch-http-v1', status: 503, ok: false,
  });
  assert.deepEqual(JSON.parse(failedBatch.rawArtifacts['social-fetch-1']!).errors, [
    { url: requiredUrl, status: 404, error: 'page_not_found' },
  ], 'the failed HTTP body stays retained as diagnostic evidence');
  assert.deepEqual(JSON.parse(failedBatch.rawArtifacts['social-collection-fetch-1-error']!), {
    method: 'social-collection-error-v1', operation: 'FETCH', code: 'SOC_FETCH_HTTP_503', required: true,
  });
  assert.ok(failedBatchScope.selection.some(row => row.url === requiredUrl && row.required && row.status === 'SOC_FETCH_HTTP_503'));

  const { read: legacy, scope: legacyScope } = await run(404, false);
  assert.equal(legacy.screeningConstraintMethod, undefined, 'the new scoped fact is marker-gated');
  assert.equal(legacy.identityComplete, false, 'legacy reconstruction keeps the earlier missing-required-page behavior');
  assert.equal(legacy.identityUnavailableSources, undefined);
  assert.ok(legacyScope.selection.some(row => row.url === requiredUrl && row.required && row.status === 'SOC_FETCH_URL_ERROR'));
});

test('an unavailable optional metadata URI does not poison retained website and social identity roots', async () => {
  const website: AttentionSource = {
    id: 'identity-website', url: 'https://project.example/about', text: `The project identifies ${SOCIAL_TOKEN.address}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  };
  const profile: AttentionSource = {
    id: 'identity-social', url: 'https://x.com/alice', text: `The project account confirms ${SOCIAL_TOKEN.address}.`,
    publishedAt: null, authorId: 'x.com:alice', availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  };
  const calls: string[] = [];
  const unavailableMetadata: typeof fetch = async input => {
    calls.push(String(input));
    if (String(input).startsWith('https://api.search.tinyfish.ai/')) return response({ results: [] });
    throw new Error('The retained roots are complete; optional metadata must not be fetched as a required identity source.');
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, attention([POST, website, profile], {
    discoveryUrls: [METADATA_URI, website.url, profile.url], metadataLinks: true, metadataUri: METADATA_URI,
  }), 'synthetic-provider-key', unavailableMetadata, () => SOCIAL_AVAILABLE);
  const scope = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as { requestedUrls: string[]; selection: Array<{ url: string; required: boolean }> };

  assert.equal(read.identityComplete, true);
  assert.deepEqual(read.identitySourceIds, [website.id, profile.id]);
  assert.deepEqual(read.targetPostIds, [POST.id], 'optional metadata discovery does not change the declared participant sample');
  assert.equal(read.sampleComplete, true);
  assert.equal(calls.some(url => url.startsWith('https://api.fetch.tinyfish.ai/')), false, 'already-retained identity roots require no supplemental page fetch');
  assert.equal(calls.some(url => url.includes(new URL(METADATA_URI).hostname)), false, 'the unavailable optional metadata page is never fetched');
  assert.deepEqual(scope.requestedUrls, []);
  assert.equal(scope.selection.some(item => item.url === METADATA_URI && item.required), false);
});

test('a failed required website identity root stays incomplete while metadata remains optional', async () => {
  const profile: AttentionSource = {
    id: 'identity-social', url: 'https://x.com/alice', text: `The project account confirms ${SOCIAL_TOKEN.address}.`,
    publishedAt: null, authorId: 'x.com:alice', availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  };
  const websiteUrl = 'https://project.example/about';
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      requested.push(...body.urls);
      return response({ results: [], errors: body.urls.map(sourceUrl => ({ url: sourceUrl, error: 'unavailable' })) });
    }
    throw new Error(`Unexpected hosted request: ${url}`);
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, attention([POST, profile], {
    discoveryUrls: [METADATA_URI, websiteUrl, profile.url], metadataLinks: true, metadataUri: METADATA_URI,
  }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  const scope = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as { selection: Array<{ url: string; required: boolean; status: string }> };

  assert.equal(read.identityComplete, false);
  assert.deepEqual(requested, [websiteUrl]);
  assert.equal(scope.selection.some(item => item.url === METADATA_URI), false);
  assert.ok(scope.selection.some(item => item.url === websiteUrl && item.required && item.status === 'SOC_FETCH_URL_ERROR'));
});

test('a metadata JSON page alone cannot become a social identity root', async () => {
  const metadataPage: AttentionSource = {
    id: 'token-metadata-json', url: METADATA_URI, text: JSON.stringify({ mint: SOCIAL_TOKEN.address, name: 'Synthetic Token' }),
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  };
  let searchCalls = 0;
  let fetchCalls = 0;
  const searchOnly: typeof fetch = async input => {
    const url = String(input);
    if (url.startsWith('https://api.search.tinyfish.ai/')) { searchCalls++; return response({ results: [] }); }
    if (url.startsWith('https://api.fetch.tinyfish.ai/')) { fetchCalls++; return response({ results: [], errors: [] }); }
    throw new Error(`Unexpected hosted request: ${url}`);
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, attention([POST, metadataPage], {
    postSampleSourceIds: [], discoveryUrls: [METADATA_URI], metadataLinks: true, metadataUri: METADATA_URI,
  }), 'synthetic-provider-key', searchOnly, () => SOCIAL_AVAILABLE);
  const scope = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as { selection: Array<{ url: string }> };

  assert.equal(read.identityComplete, false);
  assert.deepEqual(read.identitySourceIds, []);
  assert.equal(read.sources.some(source => source.id === metadataPage.id), false);
  assert.equal(searchCalls, 1, 'the normal bounded identity search may look for actual public identity pages');
  assert.equal(fetchCalls, 0, 'the metadata URI itself is never fetched as an identity root');
  assert.equal(scope.selection.some(item => item.url === METADATA_URI), false);
});

test('social supplements use their own eight-source budget, exclude comparison pages, and preserve the frozen post sample', async () => {
  const docs = Array.from({ length: 7 }, (_, index) => `https://project.example/docs/about-${index + 1}`);
  const projectPage: AttentionSource = {
    id: 'project-page', url: 'https://project.example/', text: docs.map((url, index) => `[About ${index + 1}](${url})`).join('\n'),
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  };
  const comparisonOnly: AttentionSource[] = Array.from({ length: 8 }, (_, index) => ({
    id: `comparison-only-${index + 1}`, url: `https://unrelated${index + 1}.example/representation`, text: 'unrelated '.repeat(7000),
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  }));
  const otherPages: AttentionSource[] = Array.from({ length: 22 }, (_, index) => ({
    id: `context-${index + 1}`, url: `https://context${index + 1}.example/about`, text: `Public context page ${index + 1}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  }));
  const retained = [POST, projectPage, ...comparisonOnly, ...otherPages];
  assert.equal(retained.length, 32);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://api.search.tinyfish.ai/') return response({ results: [] });
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      return response({ results: body.urls.map(requested => ({
        url: requested, final_url: requested,
        text: requested.startsWith('https://x.com/') ? 'Public profile for alice.' : `Public project source for ${SOCIAL_TOKEN.address}.`,
      })), errors: [] });
    }
    throw new Error(`Unexpected hosted request: ${url}`);
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, attention(retained, {
    discoveryUrls: ['https://project.example/'], comparisonSourceIds: comparisonOnly.map(source => source.id),
  }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);

  const acquisition = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as {
    retainedAttentionSourceCount: number; excludedComparisonSourceIds: string[]; supplementLimit: number;
    requestedUrls: string[]; clippedSourceIds: string[]; method: string; baseSocialSourceCount: number;
    submittedSocialSourceCount: number; socialSourceLimit: number; actualSupplements: number;
  };
  const fetchCalls = calls.filter(call => call.url === 'https://api.fetch.tinyfish.ai/');
  assert.equal(fetchCalls.length, 1, 'all eight bounded social supplements fit in one Fetch batch');
  const requested = { urls: fetchCalls.flatMap(call => (JSON.parse(String(call.init?.body)) as { urls: string[] }).urls) };
  assert.deepEqual(requested.urls, [...docs, 'https://x.com/alice']);
  assert.equal(read.sources.length, 32, 'the social source limit is independent from the retained attention count');
  assert.ok(read.sources.length <= 32);
  assert.deepEqual(read.targetPostIds, [POST.id]);
  assert.equal(read.sources.filter(source => read.targetPostIds.includes(source.id)).length, 1);
  assert.ok(comparisonOnly.every(source => !read.sources.some(retainedSource => retainedSource.id === source.id)));
  assert.equal(read.sources.some(source => source.text.includes('unrelated unrelated unrelated')), false);
  assert.equal(acquisition.retainedAttentionSourceCount, 32);
  assert.deepEqual(acquisition.excludedComparisonSourceIds, comparisonOnly.map(source => source.id));
  assert.equal(acquisition.supplementLimit, 8);
  assert.deepEqual(acquisition.requestedUrls, requested.urls);
  assert.deepEqual(acquisition.clippedSourceIds, []);
  assert.equal(acquisition.baseSocialSourceCount, 24);
  assert.equal(acquisition.submittedSocialSourceCount, 32);
  assert.equal(acquisition.socialSourceLimit, 32);
  assert.equal(acquisition.actualSupplements, 8);
  assert.equal(acquisition.method, 'free-social-supplements-v2');
});

function clippedRead(clippedSourceId: string, contextCount = 30): AttentionRead {
  const sources: AttentionSource[] = [
    { ...POST, text: POST.text },
    { id: 'identity-profile', url: 'https://x.com/alice', text: 'Account profile identifies this public source.', publishedAt: null, authorId: 'x.com:alice', availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' },
    ...Array.from({ length: contextCount }, (_, index) => ({
      id: `page-${index + 1}`, url: `https://source${index + 1}.example/about`, text: `Short public page ${index + 1}.`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
    })),
  ];
  assert.ok(sources.length <= 32);
  const source = sources.find(item => item.id === clippedSourceId)!;
  source.text = `${source.text}${'x'.repeat(12000 - source.text.length)}`;
  const rawText = `${source.text} additional text omitted from the retained attention excerpt`;
  return attention(sources, {
    rawArtifacts: { 'attention-fetch-1': JSON.stringify({ results: [{ url: source.url, final_url: source.url, text: rawText }], errors: [] }) },
  });
}

test('clipped identity text can be completed from an exact verified prefix with an additive social source ID', async () => {
  const clipped = clippedRead('identity-profile', 29);
  const originalSources = structuredClone(clipped.sources);
  const attentionSample = {
    targetPostIds: [...clipped.postSampleSourceIds!],
    postSampleComplete: clipped.postSampleComplete,
    comparisonSourceIds: clipped.comparisonSourceIds,
    discoveryUrls: clipped.discoveryUrls,
  };
  const priorPage = clipped.sources.find(source => source.id === 'identity-profile')!;
  const fullText = (JSON.parse(clipped.rawArtifacts['attention-fetch-1']!) as { results: Array<{ text: string }> }).results[0]!.text;
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const body = JSON.parse(String(init?.body)) as { urls: string[] };
      return response({ results: body.urls.map(requested => ({ url: requested, final_url: requested, text: fullText })), errors: [] });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, clipped, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  const page = read.sources.find(source => source.kind === 'PAGE' && source.text === fullText);
  assert.ok(page);
  assert.equal(page.id, 'social-page-32', 'the completed source receives a fresh ID after retained sources and additions');
  assert.equal(page.availableAt, priorPage.availableAt, 'completion preserves the original availability timestamp');
  assert.equal(page.discoveredFrom, 'https://x.com/alice');
  assert.equal(read.sources.some(source => source.id === 'identity-profile'), false, 'the clipped page is removed from the social packet');
  assert.equal(read.identityComplete, true);
  assert.deepEqual(read.targetPostIds, [POST.id]);
  assert.deepEqual(read.sources.filter(source => source.kind === 'POST').map(source => source.id), [POST.id]);
  assert.equal(read.sources.length, originalSources.length, 'completion replaces the clipped social page and retains every other source');
  assert.equal(JSON.stringify(read.sources).includes('additional text omitted from the retained attention excerpt'), true);
  assert.deepEqual(clipped.sources, originalSources, 'completion never edits shared attention source text');
  assert.deepEqual({
    targetPostIds: clipped.postSampleSourceIds,
    postSampleComplete: clipped.postSampleComplete,
    comparisonSourceIds: clipped.comparisonSourceIds,
    discoveryUrls: clipped.discoveryUrls,
  }, attentionSample, 'completion does not change attention scope or counters');
  assert.equal(calls.some(call => call.url === 'https://api.fetch.tinyfish.ai/'), false, 'an exact full-text prefix already retained in fetch artifacts completes the clipped page without another request');
  const manifest = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as { clippedSourceIds: string[]; supplementLimit: number; method: string };
  assert.deepEqual(manifest.clippedSourceIds, ['identity-profile']);
  assert.equal(manifest.supplementLimit, 8);
  assert.equal(manifest.method, 'free-social-supplements-v2');
});

test('required identity failures and exhausted source capacity cannot imply completion', async t => {
  const noNetwork: typeof fetch = async () => { throw new Error('No supplementary request fits the 32-source budget.'); };
  const targetClipped = await collectSocialSources(SOCIAL_TOKEN, clippedRead(POST.id), 'synthetic-provider-key', noNetwork, () => SOCIAL_AVAILABLE);
  const targetManifest = JSON.parse(targetClipped.rawArtifacts['social-acquisition-scope']!) as { clippedSourceIds: string[] };
  assert.deepEqual(targetManifest.clippedSourceIds, [POST.id]);
  assert.equal(targetClipped.sampleComplete, false);

  const saturated = attention([POST, ...Array.from({ length: 31 }, (_, index) => ({
    id: `retained-${index + 1}`, url: `https://retained${index + 1}.example/about`, text: `Retained identity source ${index + 1}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
  }))], { discoveryUrls: ['https://required-project.example/about'] });
  const saturatedFetch: typeof fetch = async input => {
    if (String(input) === 'https://api.search.tinyfish.ai/') return response({ results: [] });
    throw new Error('A source-cap rejected lead must not trigger a Fetch request.');
  };
  const fullInput = await collectSocialSources(SOCIAL_TOKEN, saturated, 'synthetic-provider-key', saturatedFetch, () => SOCIAL_AVAILABLE);
  const fullManifest = JSON.parse(fullInput.rawArtifacts['social-acquisition-scope']!) as { selection: Array<{ url: string; required: boolean; status: string }>; submittedSocialSourceCount: number; requestedUrls: string[] };
  assert.equal(fullManifest.submittedSocialSourceCount, 32);
  assert.deepEqual(fullManifest.requestedUrls, []);
  assert.ok(fullManifest.selection.some(item => item.url === 'https://required-project.example/about' && item.required && item.status === 'SOC_SOURCE_CAP'));
  assert.equal(fullInput.identityComplete, false, 'a required identity lead rejected at the social-input capacity bound remains unresolved');
  assert.ok(fullInput.codes.includes('SOC_SOURCE_CAP'));

  const nineClipped: AttentionSource[] = [{ ...POST }];
  const fullResults: Array<{ url: string; final_url: string; text: string }> = [];
  for (let index = 0; index < 9; index++) {
    const url = `https://identity${index + 1}.example/about`;
    const prefix = `Complete public identity source ${index + 1}: ${'x'.repeat(11950)}`;
    nineClipped.push({ id: `identity-${index + 1}`, url, text: prefix, publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' });
    fullResults.push({ url, final_url: url, text: `${prefix} verified suffix` });
  }
  nineClipped.push(...Array.from({ length: 22 }, (_, index) => ({
    id: `unrelated-${index + 1}`, url: `https://unrelated${index + 1}.example/about`, text: `Context ${index + 1}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
  })));
  assert.equal(nineClipped.length, 32);
  const nineRaw = nineClipped.slice(1, 10).map(source => {
    const complete = fullResults.find(item => item.url === source.url)!;
    return complete;
  });
  const nineInput = attention(nineClipped, { rawArtifacts: { 'attention-fetch-1': JSON.stringify({ results: nineRaw, errors: [] }) } });
  const eightFetch: typeof fetch = async (input, init) => {
    if (String(input) !== 'https://api.fetch.tinyfish.ai/') throw new Error('All eight completion URLs are selected before optional search.');
    const request = JSON.parse(String(init?.body)) as { urls: string[] };
    return response({ results: request.urls.map(url => fullResults.find(item => item.url === url)!), errors: [] });
  };
  const eightOnly = await collectSocialSources(SOCIAL_TOKEN, nineInput, 'synthetic-provider-key', eightFetch, () => SOCIAL_AVAILABLE);
  const eightManifest = JSON.parse(eightOnly.rawArtifacts['social-acquisition-scope']!) as { requestedUrlsByBatch: string[][]; selection: Array<{ url: string; required: boolean; status: string }>; remainingClippedSourceIds: string[]; actualSupplements: number };
  assert.equal(eightManifest.requestedUrlsByBatch.flat().length, 0, 'verified complete-prefix text is reused without another fetch');
  assert.equal(eightManifest.actualSupplements, 8);
  assert.equal(eightManifest.selection.filter(item => item.status === 'RETAINED').length, 8);
  assert.equal(eightManifest.selection.find(item => item.status === 'SOC_SOURCE_CAP')?.required, true);
  assert.deepEqual(eightManifest.remainingClippedSourceIds, ['identity-9']);
  assert.equal(eightOnly.identityComplete, false, 'the ninth required clipped identity page cannot be silently treated as complete');

  for (const scenario of ['non-prefix', 'oversized'] as const) await t.test(scenario, async () => {
    const clipped = clippedRead('identity-profile', 29);
    const old = clipped.sources.find(source => source.id === 'identity-profile')!;
    const oversizedRetainedArtifact = `${old.text}${'x'.repeat(120000 - old.text.length + 1)}`;
    clipped.rawArtifacts = { 'attention-fetch-1': JSON.stringify({
      results: [{ url: old.url, final_url: old.url, text: oversizedRetainedArtifact }], errors: [],
    }) };
    const text = scenario === 'non-prefix'
      ? `replacement starts differently from retained prefix ${'x'.repeat(12000)}`
      : `${old.text}${'x'.repeat(120000 - old.text.length + 1)}`;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input) !== 'https://api.fetch.tinyfish.ai/') return response({ results: [] });
      const request = JSON.parse(String(init?.body)) as { urls: string[] };
      return response({ results: request.urls.map(requested => ({ url: requested, final_url: requested, text })), errors: [] });
    };
    const result = await collectSocialSources(SOCIAL_TOKEN, clipped, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
    assert.equal(result.identityComplete, false, 'conflict or cap cannot turn a clipped source complete');
    assert.equal(result.sources.some(source => source.id === 'identity-profile'), true, 'the previous clipped evidence remains retained for diagnosis');
    assert.equal(result.sources.some(source => source.text === text), false);
    if (scenario === 'non-prefix') assert.ok(result.codes.includes('SOC_SOURCE_CONFLICT'));
    else assert.ok(result.codes.includes('SOC_TEXT_CAP'));
  });
});

test('optional account profile cap does not invalidate complete identity pages and only current accounts get ordinary profiles', async () => {
  const projectPage: AttentionSource = {
    id: 'primary-project-page', url: 'https://project.example/about', text: `The public project page discusses ${SOCIAL_TOKEN.address}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
  };
  const crowded = attention([POST, projectPage, ...Array.from({ length: 30 }, (_, index) => ({
    id: `context-${index + 1}`, url: `https://context${index + 1}.example/about`, text: `Public context ${index + 1}.`,
    publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE' as const,
  }))]);
  const noNetwork: typeof fetch = async () => { throw new Error('No ordinary profile fetch slot is available.'); };
  const capped = await collectSocialSources(SOCIAL_TOKEN, crowded, 'synthetic-provider-key', noNetwork, () => SOCIAL_AVAILABLE);
  assert.equal(capped.identityComplete, true, 'ordinary account context is optional when the reviewed identity page itself is complete');
  const cappedManifest = JSON.parse(capped.rawArtifacts['social-acquisition-scope']!) as { selection: Array<{ reason: string; required: boolean; status: string }> };
  assert.ok(cappedManifest.selection.some(item => item.reason === 'PUBLIC_ACCOUNT_PROFILE' && !item.required && item.status === 'SOC_ACCOUNT_CONTEXT_CAP'));
  assert.equal(capped.codes.includes('SOC_SOURCE_CAP'), false);

  const historical: AttentionSource = {
    id: 'historical-post', url: 'https://x.com/olduser/status/88', text: `${SOCIAL_TOKEN.address} historical post.`,
    publishedAt: '2026-10-02T10:00:00.000Z', authorId: 'x.com:olduser', availableAt: SOCIAL_AVAILABLE, kind: 'POST',
  };
  const currentAndHistorical = attention([POST, historical], { postSampleSourceIds: [POST.id, historical.id] });
  const requestedProfiles: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.search.tinyfish.ai/') return response({ results: [] });
    if (url === 'https://api.fetch.tinyfish.ai/') {
      const request = JSON.parse(String(init?.body)) as { urls: string[] };
      requestedProfiles.push(...request.urls.filter(value => /^https:\/\/x\.com\/[^/]+$/.test(value)));
      return response({ results: request.urls.map(requested => ({ url: requested, final_url: requested, text: `Public profile text for ${new URL(requested).pathname.slice(1)}.` })), errors: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const current = await collectSocialSources(SOCIAL_TOKEN, currentAndHistorical, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  assert.deepEqual(requestedProfiles, ['https://x.com/alice']);
  assert.equal(current.sources.some(source => source.id === 'historical-post'), true);
  assert.deepEqual(current.targetPostIds, [POST.id, historical.id]);
  assert.equal(current.sources.filter(source => source.kind === 'POST').length, 2, 'ordinary profile collection never adds historical/profile records as sampled posts');
});

test('a pre-aborted signal prevents supplemental search and fetch while retaining the original sample', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error('aborted run must not call fetch'); };
  const read = await collectSocialSources(SOCIAL_TOKEN, attention([POST]), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE, controller.signal);
  assert.equal(calls, 0);
  assert.deepEqual(read.targetPostIds, [POST.id]);
  assert.equal(read.sampleComplete, true);
  assert.ok(read.codes.includes('SOC_COLLECTION_BUDGET'));
});

test('social observed links use the fresh Pump project boundary and retain ordinary project docs', async () => {
  const pumpCoin = `https://pump.fun/coin/${SOCIAL_TOKEN.address}`;
  const projectHome = 'https://river-lantern.example/';
  const projectDocs = 'https://river-lantern.example/docs/token-contract';
  const globalPumpLinks = [
    'https://pump.fun/docs/terms-and-conditions',
    'https://pump.fun/terms',
    'https://pump.fun/privacy',
  ];
  const retained: AttentionSource[] = [
    {
      id: 'pump-coin-seed', url: pumpCoin,
      text: globalPumpLinks.map((url, index) => `[Pump global link ${index + 1}](${url})`).join('\n'),
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
    },
    {
      id: 'project-home-seed', url: projectHome, text: `[Project documentation](${projectDocs})`,
      publishedAt: null, authorId: null, availableAt: SOCIAL_AVAILABLE, kind: 'PAGE',
    },
  ];
  const fetched: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://api.search.tinyfish.ai/') return response({ results: [] });
    if (url !== 'https://api.fetch.tinyfish.ai/') throw new Error(`Unexpected request: ${url}`);
    const request = JSON.parse(String(init?.body)) as { urls: string[] };
    fetched.push(...request.urls);
    return response({ results: request.urls.map(requested => ({ url: requested, final_url: requested, text: `Public project documentation for ${SOCIAL_TOKEN.address}.` })), errors: [] });
  };
  const read = await collectSocialSources(SOCIAL_TOKEN, attention(retained, {
    collectionMethod: 'project-context-v2', entryEvidenceMethod: 'public-support-v2',
    discoveryUrls: [pumpCoin, projectHome], postSampleSourceIds: [],
  }), 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  const scope = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as {
    selection: Array<{ url: string; status: string; reason: string }>;
  };

  assert.equal(read.identityComplete, true);
  assert.deepEqual(fetched, [projectDocs], 'same-host project docs are still an eligible identity source');
  assert.equal(read.sources.some(source => globalPumpLinks.includes(source.url)), false);
  assert.equal(scope.selection.some(item => globalPumpLinks.includes(item.url)), false,
    'social expansion cannot reintroduce the shared Pump legal/docs pages as required sources');
  assert.equal(scope.selection.find(item => item.url === projectDocs)?.status, 'RETAINED');
});

test('project-context-v2 social collection preserves 56 sampled posts and uses eight supplemental slots up to 64 sources', async () => {
  const posts: AttentionSource[] = Array.from({ length: 56 }, (_, index) => ({
    id: `attention-post-${index + 1}`,
    url: `https://x.com/alice/status/${2000 + index}`,
    text: `${SOCIAL_TOKEN.address} original public post ${index + 1} describes a distinct project update and source context.`,
    publishedAt: '2026-10-03T10:00:00.000Z', authorId: 'x.com:alice', availableAt: SOCIAL_AVAILABLE, kind: 'POST',
  }));
  const projectPages = Array.from({ length: 7 }, (_, index) => `https://river-lantern.example/docs/source-${index + 1}`);
  const requested: string[][] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('api.search.tinyfish.ai')) return response({ results: [] });
    if (url !== 'https://api.fetch.tinyfish.ai/') throw new Error(`Unexpected request: ${url}`);
    const urls = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
    requested.push(urls);
    return response({
      results: urls.map(item => ({ url: item, final_url: item, text: `Complete public project evidence for ${SOCIAL_TOKEN.address} at ${item}.` })),
      errors: [],
    });
  };
  const attentionRead = attention(posts, {
    collectionMethod: 'project-context-v2',
    discoveryUrls: projectPages,
    postSampleSourceIds: posts.map(post => post.id),
  });
  const read = await collectSocialSources(SOCIAL_TOKEN, attentionRead, 'synthetic-provider-key', fetcher, () => SOCIAL_AVAILABLE);
  const scope = JSON.parse(read.rawArtifacts['social-acquisition-scope']!) as {
    actualSupplements: number; socialSourceLimit: number; baseSocialSourceCount: number; submittedSocialSourceCount: number;
  };

  assert.equal(scope.baseSocialSourceCount, 56);
  assert.equal(scope.socialSourceLimit, 64);
  assert.equal(scope.actualSupplements, 8, 'seven required project documents and one account profile fit the supplement bound');
  assert.equal(scope.submittedSocialSourceCount, 64);
  assert.equal(read.sources.length, 64);
  assert.equal(read.targetPostIds.length, 56);
  assert.ok(posts.every(post => read.sources.some(source => source.id === post.id && source.text === post.text)),
    'all original sampled posts retain their complete text');
  assert.ok(projectPages.every(url => read.sources.some(source => source.url === url)));
  assert.deepEqual(requested.flat(), [...projectPages, 'https://x.com/alice']);
  assert.equal(read.sampleComplete, true);
  assert.equal(read.identityComplete, true);
});
