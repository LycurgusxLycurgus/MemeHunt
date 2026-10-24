import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { completeFixtureEntryFeatures, illustrativeUncalibratedProfile } from '../examples/fixtures.js';
import { deriveAttention, narrativeSourceBound, originEntryCitationAllowed, originSourceScope } from '../src/domain/attention.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { attentionInitialPageLimit, attentionSourceLimit, attentionSubmittedSources, collectAttentionSources, comparisonRecoveryFallback, comparisonRecoverySelection, entryEvidenceScope, normalizeAttentionFetchUrl, normalizeAttentionSearchUrl, originSeedLinks, recoverComparisonSources, terminalPostScope, type AttentionRead } from '../src/providers/attention.js';
import { binaryEntryDecisionProgram, qualifyAttention, resolvePublicEntryDecision } from '../src/providers/attention-model.js';
import { originRecoveryQuery, verifyOriginAlias } from '../src/providers/origin-recovery.js';

const token = { chain: 'solana', address: 'MintAddress111111111111111111111111111111111' } as const;
const KEY = 'attention-test-key';

type Call = { url: string; init: RequestInit };
type FetchPlan = (url: string, init: RequestInit, callIndex: number) => Response | Promise<Response>;

function mockFetch(plan: FetchPlan) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return plan(call.url, call.init, calls.length - 1);
  };
  return { calls, fetcher };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const search = (urls: string[]) => json({ results: urls.map(url => ({ url })) });
const fetchResult = (url: string, text: string, published_date?: string) => ({
  url, final_url: url, text, ...(published_date === undefined ? {} : { published_date }),
});

const comparisonReviewFields = (packet: Record<string, unknown>) => ({
  sourceDecisions: Object.fromEntries(((packet.sources ?? []) as Array<{ id: string }>).map(source => [source.id, {
    disposition: 'RELEVANT', insufficiencyKind: 'NONE',
    rationale: 'The retained source establishes this exact project representation.',
  }])),
  missingRepresentations: [],
});

const indexedSpanId = (packet: Record<string, unknown>, sourceId: string) => {
  const catalog = packet.sources as Array<{ id: string; spans: Array<{ id: string }> }>;
  const source = catalog.find(item => item.id === sourceId);
  assert.ok(source, `the lead packet includes descriptor ${sourceId}`);
  assert.ok(source.spans[0], `descriptor ${sourceId} contains a citable title or snippet`);
  return source.spans[0]!.id;
};

const comparisonObservationId = (packet: Record<string, unknown>, token: { chain: string; address: string }, sourceId: string) => {
  const observations = packet.exactContractObservations as Array<{
    observationId: string; token: { chain: string; address: string }; sourceId: string;
  }>;
  const observation = observations.find(item => item.token.chain === token.chain
    && item.token.address === token.address && item.sourceId === sourceId);
  assert.ok(observation, `the packet includes a code-owned ${token.chain}:${token.address} observation in ${sourceId}`);
  return observation.observationId;
};

test('collector runs bounded mint and name searches, binds public pages, and derives post metadata from provider fields', async () => {
  const requested: string[] = [];
  const searchBodies = [
    ['https://public.example/story?utm_source=search', 'http://public.example/insecure', 'https://user:pass@public.example/private'],
    ['https://public.example/story', 'https://x.com/SomeUser/status/123/photo/1', 'https://www.twitter.com/OtherUser/status/456'],
    ['https://example.test/ignored', 'https://twitter.com/not-a-status/123', 'https://x.com/commonname/status/789', 'https://public.example/story'],
  ];
  const text = 'Mint ' + token.address + ' source text';
  const mock = mockFetch((url, _init, index) => {
    if (url.includes('api.search.tinyfish.ai')) return search(searchBodies[index] ?? []);
    const body = JSON.parse(String(_init.body)) as { urls: string[]; format: string; ttl: number };
    requested.push(...body.urls);
    const published = new Map([
      ['https://x.com/someuser/status/123', '2026-10-01T07:55:00-04:00'],
      ['https://x.com/otheruser/status/456', '2026-10-02T00:00:00Z'],
      ['https://x.com/commonname/status/789', '2026-10-01T07:00:00-04:00'],
    ]);
    return json({ results: body.urls.map(url => fetchResult(url, text, published.get(url))), errors: [] });
  });
  const times = [
    '2026-10-01T12:00:00.000Z',
    '2026-10-01T12:00:01.000Z',
    '2026-10-01T12:00:02.000Z',
    '2026-10-01T12:00:03.000Z',
    '2026-10-01T12:00:04.000Z',
    '2026-10-01T12:00:05.000Z',
  ];
  let timeIndex = 0;
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => times[timeIndex++]!, 'Dove "Red"\\Coin');

  assert.equal(read.queries.length, 3);
  assert.ok(read.queries[0]?.includes(token.address));
  assert.ok(read.queries[1]?.includes(token.address));
  assert.match(read.queries[2] ?? '', /Dove RedCoin/);
  assert.equal(read.start, '2026-09-30T12:00:00.000Z');
  assert.equal(read.end, '2026-10-01T12:00:00.000Z');
  assert.equal(read.complete, true, JSON.stringify(read));
  assert.equal(read.comparisonComplete, false, 'an unsafe named result remains an unaccounted original lead');
  assert.equal(read.comparisonAcquisition?.leadCount, 4);
  assert.equal(read.comparisonAcquisition?.leads[0]?.acquisitionStatus, 'UNSAFE');
  assert.deepEqual(read.comparisonAcquisition?.leads[0]?.sourceIds, [], 'an unsafe result cannot be promoted into a fetched source');
  assert.deepEqual(read.codes, []);
  assert.deepEqual(requested, [
    'https://public.example/story',
    'https://x.com/someuser/status/123',
    'https://x.com/otheruser/status/456',
    'https://twitter.com/not-a-status/123',
    'https://x.com/commonname/status/789',
  ]);
  assert.deepEqual(read.sources, [
    {
      id: 'attention-page-1', url: 'https://public.example/story', text,
      publishedAt: null, authorId: null, availableAt: times[1], kind: 'PAGE',
    },
    {
      id: 'attention-page-2', url: 'https://x.com/someuser/status/123', text,
      publishedAt: '2026-10-01T11:55:00.000Z', authorId: 'x.com:someuser', availableAt: times[2], kind: 'POST',
    },
    {
      id: 'attention-page-3', url: 'https://x.com/otheruser/status/456', text,
      publishedAt: null, authorId: 'x.com:otheruser', availableAt: times[3], kind: 'POST',
    },
    {
      id: 'attention-page-4', url: 'https://twitter.com/not-a-status/123', text,
      publishedAt: null, authorId: null, availableAt: times[4], kind: 'PAGE',
    },
    {
      id: 'attention-page-5', url: 'https://x.com/commonname/status/789', text,
      publishedAt: '2026-10-01T11:00:00.000Z', authorId: 'x.com:commonname', availableAt: times[5], kind: 'POST',
    },
  ]);

  const searchCalls = mock.calls.filter(call => call.url.includes('api.search.tinyfish.ai'));
  assert.equal(searchCalls.length, 3);
  const commonRequest = new URL(searchCalls[2]!.url);
  const commonQuery = commonRequest.searchParams.get('query') ?? '';
  const commonIntent = commonRequest.searchParams.get('intent') ?? '';
  assert.ok(searchCalls[2]!.url.length < 2000, 'the named comparison request stays within TinyFish URL limits');
  assert.equal(commonQuery, '"Dove RedCoin" solana crypto token contract');
  assert.equal(commonQuery.includes('meme narrative'), false, 'the common query remains specific and crypto-qualified without broad narrative expansion');
  assert.equal(commonQuery.includes(token.address), false, 'the common-name query does not anchor candidate selection on the target contract');
  assert.match(commonIntent, /Find public sources identifying distinct token contract addresses/);
  assert.match(commonIntent, /Same name alone does not establish association; do not rank by price/);
  assert.equal(read.rawArtifacts['attention-search-3-intent'], commonIntent, 'the exact search intent is retained beside provider response evidence');
  for (const call of searchCalls) {
    assert.equal(new Headers(call.init.headers).get('x-api-key'), KEY);
    assert.equal(call.init.method, undefined);
    assert.equal(call.url.includes(KEY), false);
  }
  const fetchCalls = mock.calls.filter(call => call.url.includes('api.fetch.tinyfish.ai'));
  assert.equal(fetchCalls.length, 1);
  assert.equal(new Headers(fetchCalls[0]?.init.headers).get('x-api-key'), KEY);
  assert.equal(JSON.stringify(read).includes(KEY), false);
  assert.deepEqual(Object.keys(read.rawArtifacts).sort(), [
    'attention-fetch-1', 'attention-search-1', 'attention-search-2', 'attention-search-3', 'attention-search-3-intent',
    'comparison-lead-1-metadata', 'comparison-lead-2-metadata', 'comparison-lead-3-metadata', 'comparison-lead-4-metadata',
  ]);
  assert.deepEqual(read.sources.filter(source => source.kind === 'POST' && read.comparisonSourceIds?.includes(source.id)).map(source => source.id), ['attention-page-5']);
});

test('an empty crypto-qualified comparison query gets one broader retry and stays unknown when that retry is empty', async () => {
  const primary = { results: [] };
  const searchQueries: string[] = [];
  const fetched: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      searchQueries.push(query);
      return json(primary);
    }
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    fetched.push(...requested);
    return json({ results: requested.map(item => fetchResult(item, `River Lantern represents ${token.address}.`)), errors: [] });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
  assert.equal(searchQueries.length, 4, 'only the successful empty primary gets one broader retry');
  assert.deepEqual(searchQueries, [
    `"${token.address}" solana narrative origin catalyst`,
    `"${token.address}" (site:x.com OR site:twitter.com)`,
    '"River Lantern" solana crypto token contract',
    '"River Lantern" solana',
  ]);
  assert.equal(read.queries[2], '"River Lantern" solana');
  assert.equal(read.rawArtifacts['attention-search-3-primary-query'], '"River Lantern" solana crypto token contract');
  assert.equal(read.rawArtifacts['attention-search-3-empty-response'], JSON.stringify(primary), 'the primary empty response is retained separately');
  assert.equal(read.rawArtifacts['attention-search-3'], JSON.stringify(primary), 'the selected fallback response remains the canonical search result');
  assert.deepEqual(fetched, []);
  assert.equal(read.sources.length, 0);
  assert.equal(read.comparisonAcquisition?.leadCount, 0);
  assert.equal(read.comparisonAcquisition?.originalComplete, false);
  assert.equal(read.comparisonComplete, false, 'an empty sample remains unknown rather than proving no representation exists');
});

test('failed crypto-qualified comparison searches remain unknown without fallback', async t => {
  await t.test('a successful empty primary response with provider errors does not trigger fallback', async () => {
    let searchCount = 0;
    const mock = mockFetch(url => {
      if (url.includes('api.search.tinyfish.ai')) {
        searchCount++;
        return json(searchCount === 3 ? { results: [], errors: [{ error: 'provider_error' }] } : { results: [] });
      }
      return json({ results: [], errors: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');

    assert.equal(searchCount, 3);
    assert.equal(read.rawArtifacts['attention-search-3-empty-response'], undefined);
    assert.equal(read.queries[2], '"River Lantern" solana crypto token contract');
    assert.equal(read.comparisonComplete, false);
    assert.equal(read.comparisonAcquisition?.originalComplete, false);
  });

  await t.test('an embedded primary error does not trigger fallback even with an empty results array', async () => {
    let searchCount = 0;
    const mock = mockFetch(url => {
      if (!url.includes('api.search.tinyfish.ai')) return json({ results: [], errors: [] });
      searchCount++;
      return json(searchCount === 3 ? { results: [], error: 'provider_error' } : { results: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
    assert.equal(searchCount, 3);
    assert.equal(read.rawArtifacts['attention-search-3-empty-response'], undefined);
    assert.equal(read.queries[2], '"River Lantern" solana crypto token contract');
    assert.equal(read.comparisonComplete, false);
  });

  await t.test('HTTP failure on the exact-name query is not retried as a fallback', async () => {
    let searchCount = 0;
    const mock = mockFetch(url => {
      if (!url.includes('api.search.tinyfish.ai')) return json({ results: [], errors: [] });
      searchCount++;
      if (searchCount === 3) return new Response('rejected', { status: 400 });
      return json({ results: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');

    assert.equal(searchCount, 3);
    assert.equal(read.rawArtifacts['attention-search-3-empty-response'], undefined);
    assert.equal(read.rawArtifacts['attention-search-3'], undefined);
    assert.equal(read.queries[2], '"River Lantern" solana crypto token contract');
    assert.equal(read.sources.length, 0);
    assert.equal(read.comparisonComplete, false);
    assert.ok(read.codes.includes('ATT_SEARCH_HTTP_400'));
  });

  await t.test('a malformed successful primary response is not retried', async () => {
    let searchCount = 0;
    const mock = mockFetch(url => {
      if (!url.includes('api.search.tinyfish.ai')) return json({ results: [], errors: [] });
      searchCount++;
      return json(searchCount === 3 ? { results: 'not-an-array' } : { results: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
    assert.equal(searchCount, 3);
    assert.equal(read.rawArtifacts['attention-search-3-empty-response'], undefined);
    assert.ok(read.codes.includes('ATT_SEARCH_SHAPE'));
    assert.equal(read.comparisonComplete, false);
  });

  await t.test('a thrown primary transport failure does not trigger the broader fallback', async () => {
    const searchQueries: string[] = [];
    const mock = mockFetch(url => {
      if (!url.includes('api.search.tinyfish.ai')) return json({ results: [], errors: [] });
      const query = new URL(url).searchParams.get('query') ?? '';
      searchQueries.push(query);
      if (query === '"River Lantern" solana crypto token contract') {
        return Promise.reject(Object.assign(new Error('simulated search timeout'), { name: 'TimeoutError' }));
      }
      return json({ results: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
    assert.ok(searchQueries.length > 3, 'the failed primary may use its existing bounded transport retries');
    assert.equal(searchQueries.includes('"River Lantern" solana'), false, 'a transport failure never triggers the empty-result fallback');
    assert.equal(read.rawArtifacts['attention-search-3-empty-response'], undefined);
    assert.ok(read.codes.includes('ATT_SEARCH_UNAVAILABLE'));
    assert.equal(read.comparisonComplete, false);
  });
});

test('original origin scope keeps failed and omitted exact-token acquisitions visible', async t => {
  await t.test('a missing launch result is recorded as omitted', async () => {
    const seed = 'https://public.example/context';
    const launch = 'https://public.example/launch';
    let searchIndex = 0;
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) return search(searchIndex++ === 0 ? [seed] : [launch]);
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      return json({ results: requested.filter(item => item === seed).map(item => fetchResult(item, `Token ${token.address}. Original project context.`)), errors: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', undefined, [seed]);
    const scope = originSourceScope(read, token);

    assert.equal(scope.complete, false);
    assert.equal(scope.acquisition.urls.find(item => item.url === launch)?.state, 'OMITTED');
  });

  await t.test('an eligible metadata seed link that fails remains in the scope', async () => {
    const seed = 'https://metadata.example/token.json';
    const launch = 'https://metadata.example/launch';
    let fetchIndex = 0;
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) return search([]);
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      fetchIndex++;
      if (fetchIndex === 1) return json({
        results: requested.map(item => ({ ...fetchResult(item, JSON.stringify({ mint: token.address })), links: item === seed ? [launch] : [] })),
        errors: [],
      });
      return json({ results: [], errors: [{ url: launch, error: 'bot_blocked', status: 403 }] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', undefined, [seed]);
    const scope = originSourceScope(read, token);

    assert.equal(scope.complete, false);
    assert.equal(scope.acquisition.urls.find(item => item.url === launch)?.state, 'UNAVAILABLE');
  });

  await t.test('a URL omitted by the first-two-search page cap stays in the scope ledger', async () => {
    const urls = Array.from({ length: 33 }, (_, index) => `https://public.example/origin-${index + 1}`);
    let searchIndex = 0;
    const fetched: string[] = [];
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) return search(searchIndex++ === 0 ? urls : []);
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      fetched.push(...requested);
      return json({ results: requested.map(item => fetchResult(item, `Token ${token.address}. Original source.`)), errors: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
    const scope = originSourceScope(read, token);

    assert.equal(fetched.length, 32);
    assert.equal(scope.complete, false);
    assert.equal(scope.acquisition.urls.find(item => item.url === urls[32])?.state, 'OMITTED');
  });
});

test('a third common-query fetch failure does not make a fully acquired original origin scope incomplete', async () => {
  const origin = 'https://public.example/origin';
  const common = 'https://public.example/common-name';
  let searchIndex = 0;
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const current = searchIndex++;
      return search(current === 0 ? [origin] : current === 2 ? [common] : []);
    }
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    return json({
      results: requested.filter(item => item === origin).map(item => fetchResult(item, `Token ${token.address}. Project context, with no dated origin or catalyst.`)),
      errors: requested.filter(item => item === common).map(item => ({ url: item, error: 'bot_blocked', status: 403 })),
    });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern', [origin]);
  const scope = originSourceScope(read, token);
  read.originScope = scope;
  assert.equal(read.complete, false, 'the common-query fetch failure remains visible on the overall collection');
  assert.equal(scope.complete, true, 'origin scope depends on the two exact-token searches and their required pages');
  assert.deepEqual(scope.acquisition.sourceIds, ['attention-page-1']);

  const quote = `Token ${token.address}.`;
  const rows = deriveAttention(read, {
    claims: [{ id: 'screen', feature: 'A03', value: false, summary: 'The reviewed sample lacks public origin proof.',
      originBasis: 'PUBLIC_EVIDENCE_INADEQUATE', citations: [{ sourceId: 'attention-page-1', quote }] }],
    posts: [], competitors: [],
  }, {
    decisions: [{ id: 'screen', accepted: true, rationale: 'The complete original sample supports this scoped screening grade.' }],
    candidateSet: { complete: false, rationale: 'The independent common-name comparison scope is incomplete.' },
    originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'The retained pages do not resolve primary origin.' },
    originScopeReview: { complete: true, sourceIds: [...scope.sourceIds], rationale: 'Every acquired original source was reviewed in full.' },
  }, token, '2026-10-01T12:00:00.000Z', []);

  assert.equal(rows.find(row => row.id === 'A03')?.quality, 'KNOWN', JSON.stringify({
    origin: rows.find(row => row.id === 'A03'), scope, readQueries: read.queries,
  }));
  assert.equal(rows.find(row => row.id === 'A03')?.projection?.value, false);
});

test('TinyFish search redirects normalize only the observed public wrapper and retain original evidence', async t => {
  const destination = 'https://public.example/article?section=community&language=en';
  const encoded = encodeURIComponent(destination);
  const wrapped = `/url?opi=79508299&q=${encoded}&sa=U&ved=2ahUKEwi-test&usg=AOvVaw-public`;
  assert.equal(normalizeAttentionSearchUrl(destination), destination, 'direct public HTTPS search results keep their established path');
  assert.equal(normalizeAttentionSearchUrl(wrapped), destination, 'one exact wrapper unwrap retains benign destination query parameters');

  const nested = `/url?q=${encodeURIComponent(`/url?q=${encoded}`)}`;
  const invalid: Array<[string, string]> = [
    ['repeated q parameters', `/url?q=${encoded}&q=${encoded}`],
    ['nested relative wrapper', nested],
    ['HTTP destination', `/url?q=${encodeURIComponent('http://public.example/article')}`],
    ['private IP destination', `/url?q=${encodeURIComponent('https://127.0.0.1/private')}`],
    ['credentialed destination', `/url?q=${encodeURIComponent('https://user:pass@public.example/private')}`],
    ['wrapper fragment', `${wrapped}#fragment`],
    ['destination fragment', `/url?q=${encodeURIComponent('https://public.example/article#fragment')}`],
    ['unknown wrapper path', wrapped.replace('/url?', '/redirect?')],
  ];
  for (const [name, value] of invalid) await t.test(name, () => {
    assert.equal(normalizeAttentionSearchUrl(value), null);
  });

  const title = 'River Lantern public project article';
  const snippet = 'The public article describes the indexed neighborhood project.';
  const pageText = `This page references ${token.address} and the River Lantern neighborhood project.`;
  const fetched: string[] = [];
  let searchIndex = 0;
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      return searchIndex++ === 2
        ? json({ results: [{ url: wrapped, title, snippet }] })
        : search([]);
    }
    const body = JSON.parse(String(init.body)) as { urls: string[] };
    fetched.push(...body.urls);
    return json({ results: body.urls.map(requested => fetchResult(requested, pageText)), errors: [] });
  });
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
  const lead = read.comparisonAcquisition?.leads[0];
  assert.ok(lead);
  assert.equal(lead.url, destination);
  assert.equal(lead.acquisitionStatus, 'ACQUIRED');
  assert.deepEqual(fetched, [destination], 'Fetch receives the validated public destination, never the relative wrapper');
  assert.deepEqual(lead.sourceIds, [read.sources[0]!.id]);
  assert.equal(read.sources[0]?.url, destination);
  assert.deepEqual(JSON.parse(read.rawArtifacts['attention-search-3']!).results[0], { url: wrapped, title, snippet });
  assert.deepEqual(JSON.parse(read.rawArtifacts[lead.metadataEvidenceId]!), {
    searchArtifactId: 'attention-search-3', resultIndex: 0, url: wrapped, normalizedUrl: destination,
    urlMethod: 'tinyfish-search-redirect-v1', title, snippet,
  });
});

test('fetch final-resource fragments normalize without loosening public-source admission', async t => {
  const requestedOrigin = 'https://public.example/river-lantern-origin';
  const comparison = 'https://index.example/river-lantern-representation';
  const redirectedOrigin = `${requestedOrigin}#transactions`;
  const originText = `The River Lantern project identifies token ${token.address} as its original deployment.`;
  const comparisonText = `The indexed River Lantern representation records token ${token.address}.`;
  const cutoff = '2026-10-01T12:00:00.000Z';

  assert.equal(normalizeAttentionFetchUrl(redirectedOrigin), requestedOrigin,
    'a browser fragment does not change the HTTP resource retained by Fetch');
  assert.equal(normalizeAttentionFetchUrl('https://twitter.com/Community_Author/status/901/photo/1#transactions'),
    'https://x.com/community_author/status/901',
    'fragment normalization preserves the existing canonical X status identity');
  assert.equal(normalizeAttentionFetchUrl('https://public.example/path?section=launch#transactions'),
    'https://public.example/path?section=launch', 'benign functional query parameters survive fragment removal');
  for (const [name, value] of [
    ['HTTP URL', 'http://public.example/page#transactions'],
    ['credentialed URL', 'https://user:password@public.example/page#transactions'],
    ['loopback IP', 'https://127.0.0.1/page#transactions'],
    ['private IP', 'https://10.0.0.8/page#transactions'],
    ['private hostname', 'https://service.internal/page#transactions'],
    ['API key query', 'https://public.example/page?api_key=secret#transactions'],
    ['token query', 'https://public.example/page?token=secret#transactions'],
    ['signature query', 'https://public.example/page?signature=secret#transactions'],
  ] as const) await t.test(name, () => assert.equal(normalizeAttentionFetchUrl(value), null));

  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      if (query.includes('River Lantern')) return search([comparison]);
      if (query.includes('site:x.com')) return search([]);
      return search([requestedOrigin]);
    }
    const body = JSON.parse(String(init.body)) as { urls: string[] };
    return json({ results: body.urls.map(requested => ({
      url: requested,
      final_url: requested === requestedOrigin ? redirectedOrigin : requested,
      text: requested === requestedOrigin ? originText : comparisonText,
    })), errors: [] });
  });
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => cutoff, 'River Lantern',
    [requestedOrigin], undefined, 'public-support-v2');
  const origin = read.sources.find(source => source.url === requestedOrigin);
  assert.ok(origin, 'the acquired page is stored under the fragment-free final HTTP resource');
  assert.equal(origin.text, originText);
  assert.ok(Object.entries(read.rawArtifacts).some(([id, raw]) => /^attention-fetch-\d+$/.test(id)
    && JSON.parse(raw).results.some((row: { url: string; final_url: string; text: string }) =>
      row.url === requestedOrigin && row.final_url === redirectedOrigin && row.text === originText)),
  'the retained provider receipt preserves the original fragment-bearing response and exact body');
  const scope = entryEvidenceScope(read, token, cutoff);
  assert.equal(scope.complete, true, JSON.stringify({ scope, origin: read.originScope }));
  assert.ok(scope.originSourceIds.includes(origin.id), 'the verified origin scope admits the source after URL normalization');

  const moved = structuredClone(read);
  for (const [id, raw] of Object.entries(moved.rawArtifacts)) if (/^attention-fetch-\d+(?:-retry-1)?$/.test(id)) {
    const packet = JSON.parse(raw) as { results: Array<{ url: string; final_url?: string; text: string }> };
    for (const row of packet.results) if (row.url === requestedOrigin) row.final_url = 'https://moved.example/other-resource#transactions';
    moved.rawArtifacts[id] = JSON.stringify(packet);
  }
  assert.equal(entryEvidenceScope(moved, token, cutoff).complete, false,
    'changing the final fetched resource cannot preserve admission for a source stored under the original URL');

  const changedBody = structuredClone(read);
  const acquisitionId = Object.keys(changedBody.rawArtifacts).find(id => /^attention-fetch-\d+$/.test(id)
    && JSON.parse(changedBody.rawArtifacts[id]!).results.some((row: { url: string }) => row.url === requestedOrigin));
  assert.ok(acquisitionId);
  const acquisition = JSON.parse(changedBody.rawArtifacts[acquisitionId]!) as { results: Array<{ url: string; text: string }> };
  acquisition.results.find(row => row.url === requestedOrigin)!.text += ' changed after acquisition';
  changedBody.rawArtifacts[acquisitionId] = JSON.stringify(acquisition);
  assert.equal(entryEvidenceScope(changedBody, token, cutoff).complete, false,
    'a body that no longer matches the exact retained fetch receipt cannot be admitted');

  const unrequestedMock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      if (query.includes('River Lantern')) return search([comparison]);
      if (query.includes('site:x.com')) return search([]);
      return search([requestedOrigin]);
    }
    return json({ results: [{ url: 'https://unrequested.example/page', final_url: redirectedOrigin, text: originText }], errors: [] });
  });
  const unrequested = await collectAttentionSources(token, KEY, unrequestedMock.fetcher, () => cutoff, 'River Lantern',
    [requestedOrigin], undefined, 'public-support-v2');
  assert.ok(unrequested.codes.includes('ATT_FETCH_BINDING'), 'an unrequested result row remains rejected even with a safe normalized final resource');
});

test('metadata association cannot fill a linked-page fetch outage or complete its origin scope', async () => {
  const metadataUri = 'https://metadata.example/token/opaque';
  const linkedUrl = 'https://riverlantern.example/community';
  const metadataText = JSON.stringify({ name: 'River Lantern', website: linkedUrl });
  const cutoff = '2026-10-01T12:00:00.000Z';
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) return search([]);
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    return json({
      results: requested.includes(metadataUri) ? [{ url: metadataUri, final_url: metadataUri, text: metadataText }] : [],
      errors: requested.includes(linkedUrl) ? [{ url: linkedUrl, status: 503, error: 'target_unreachable' }] : [],
    });
  });
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => cutoff, undefined,
    [metadataUri, linkedUrl], undefined, 'public-support-v2');
  read.metadataLinks = true;
  read.metadataUri = metadataUri;
  read.metadataLinkMethod = 'onchain-metadata-v1';
  read.originScope = originSourceScope(read, token);

  assert.equal(read.sources.some(source => source.url === metadataUri && source.text === metadataText), true,
    'the exact opaque URI metadata response remains available as acquired evidence');
  assert.equal(read.sources.some(source => source.url === linkedUrl), false,
    'an HTTP 503 page never enters the retained source catalog');
  assert.equal(narrativeSourceBound(read, 'missing-linked-page', token), false);
  assert.equal(originEntryCitationAllowed(read, 'missing-linked-page', token, 'FAIL'), false);
  assert.equal(read.originScope?.complete, false, JSON.stringify(read.originScope));
  assert.equal(entryEvidenceScope(read, token, cutoff).complete, false,
    'a linked-page outage remains an acquisition gap and cannot qualify a negative-origin grade');
});

test('collector preserves functional page queries, removes tracking keys, and binds the requested URL', async () => {
  const functional = 'https://public.example/resource?k=MTUxNzY%3D';
  const tracked = `${functional}&utm_source=search`;
  const duplicateTracked = `${functional}&fbclid=click-id`;
  const text = `The requested RootData resource names ${token.address}.`;
  const requested: string[][] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      return search(query.includes('x.com') ? [] : [tracked, duplicateTracked]);
    }
    const body = JSON.parse(String(init.body)) as { urls: string[] };
    requested.push(body.urls);
    return json({ results: [fetchResult(functional, text)], errors: [] });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');

  assert.deepEqual(requested, [[functional]], 'tracking variants deduplicate while the functional k parameter stays intact');
  assert.equal(read.sources.length, 1);
  assert.equal(read.sources[0]?.url, functional);
  assert.equal(read.sources[0]?.text, text);
  assert.equal(read.complete, true);
});

test('named comparison ledger preserves duplicate, blocked, failed, and unsafe indexed leads', async () => {
  const target = 'https://public.example/target';
  const blocked = 'https://public.example/challenge';
  const missing = 'https://public.example/missing';
  const entries = [
    { url: target, title: 'River Lantern target project', snippet: `The target contract is ${token.address}.` },
    { url: target, title: 'Duplicate target index entry', snippet: 'A separately indexed copy of the target lead.' },
    { url: blocked, title: 'Blocked indexed result', snippet: 'A project page returned a challenge.' },
    { url: missing, title: 'Unavailable indexed result', snippet: 'A project detail page returned not found.' },
    { url: 'http://127.0.0.1/private', title: 'Unsafe indexed result', snippet: 'This URL is not publicly fetchable.' },
  ];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      return json({ results: query.includes('"River Lantern"') ? entries : [] });
    }
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    assert.deepEqual(requested, [target, blocked, missing]);
    return json({
      results: [fetchResult(target, `River Lantern represents ${token.address}.`), fetchResult(blocked, 'Safety check')],
      errors: [{ url: missing, status: 404, error: 'not_found' }],
    });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
  const ledger = read.comparisonAcquisition!;

  assert.equal(ledger.originalComplete, false);
  assert.equal(ledger.searchSucceeded, true);
  assert.equal(ledger.descriptorComplete, true);
  assert.equal(ledger.leadCount, entries.length);
  assert.deepEqual(ledger.leads.map(lead => [lead.resultIndex, lead.url, lead.acquisitionStatus]), [
    [0, target, 'ACQUIRED'], [1, target, 'ACQUIRED'], [2, blocked, 'BLOCKED'], [3, missing, 'FAILED'], [4, null, 'UNSAFE'],
  ]);
  assert.deepEqual(ledger.leads.slice(0, 2).map(lead => lead.sourceIds), [['attention-page-1'], ['attention-page-1']],
    'duplicate descriptor rows retain their own identities and bind to the shared acquired source');
  assert.equal(ledger.leads[2]?.acquisitionCodes.includes('ATT_LEAD_BLOCKED'), true);
  assert.equal(ledger.leads[3]?.acquisitionCodes.includes('ATT_LEAD_FAILED'), true);
  assert.equal(read.rawArtifacts['attention-search-3']?.includes('Unavailable indexed result'), true);
  for (const [index, lead] of ledger.leads.entries()) {
    const metadata = JSON.parse(read.rawArtifacts[lead.metadataEvidenceId]!) as {
      searchArtifactId: string; resultIndex: number; url: string; title: string; snippet: string;
    };
    assert.deepEqual([metadata.searchArtifactId, metadata.resultIndex, metadata.url, metadata.title, metadata.snippet], [
      'attention-search-3', index, entries[index]!.url, entries[index]!.title, entries[index]!.snippet,
    ]);
    assert.equal(read.sources.some(source => source.id === lead.metadataEvidenceId), false,
      'indexed metadata remains separate from fetched PAGE/POST evidence');
  }
  assert.deepEqual(read.sources.map(source => source.url), [target]);
  assert.ok(read.codes.includes('ATT_FETCH_BLOCKED_CONTENT'));
  assert.ok(read.codes.includes('ATT_FETCH_URL_ERROR'));
  assert.equal(mock.calls.filter(call => call.url.includes('api.fetch.tinyfish.ai')).length, 1,
    'a returned challenge and a permanent 404 do not trigger recovery retries');
});

test('named comparison leads beyond the modeled and fetch caps remain explicitly incomplete', async () => {
  const entries = Array.from({ length: 33 }, (_, index) => ({
    url: `https://public.example/lead-${index + 1}`,
    title: `Indexed project lead ${index + 1}`,
    snippet: `Descriptor ${index + 1} identifies a separate public project page.`,
  }));
  const batches: string[][] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      return json({ results: query.includes('"River Lantern"') ? entries : [] });
    }
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    batches.push(requested);
    return json({ results: requested.map(item => fetchResult(item, 'A retained public project page.')), errors: [] });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
  const ledger = read.comparisonAcquisition!;

  assert.equal(ledger.leadCount, entries.length);
  assert.equal(ledger.leads.length, 32);
  assert.equal(ledger.descriptorComplete, false, 'the extra original descriptor is visible as a ledger gap');
  assert.equal(ledger.leads[31]?.resultIndex, 31);
  assert.equal(read.rawArtifacts['attention-search-3']?.includes(entries[32]!.url), true,
    'the unmodeled descriptor remains in the exact original search response');
  assert.deepEqual(batches.map(batch => batch.length), [10, 10, 10, 2]);
  assert.equal(read.sources.length, 32);
  assert.equal(read.comparisonComplete, false);
  assert.ok(read.codes.includes('ATT_PAGE_CAP'));
  assert.ok(read.codes.includes('ATT_DESCRIPTOR_CAP'));
});

test('recovery query parents share the bounded fetch budget fairly and preserve legacy result-order selection', async t => {
  await t.test('later parents and second-query hits receive slots despite a crowded first query', async () => {
    const queries = [
      'failed lead one descriptive subject', 'failed lead two descriptive subject', 'mutable profile descriptive subject',
      'failed lead one alternate source', 'failed lead two alternate source', 'mutable profile alternate source',
    ];
    const parents = [
      { leadId: 'failed-lead-1', originalUrl: 'https://original-a.example/failed' },
      { leadId: 'failed-lead-2', originalUrl: 'https://original-b.example/failed' },
      { leadId: 'mutable-profile-3', originalUrl: 'https://profile-c.example/failed' },
      { leadId: 'failed-lead-1', originalUrl: 'https://original-a.example/failed' },
      { leadId: 'failed-lead-2', originalUrl: 'https://original-b.example/failed' },
      { leadId: 'mutable-profile-3', originalUrl: 'https://profile-c.example/failed' },
    ];
    const reusedUrl = 'https://catalog.example/already-collected';
    const sharedUrl = 'https://catalog.example/shared-source';
    const alphaHits = [
      ...Array.from({ length: 10 }, (_, index) => ({
        url: `https://independent-a.example/page-${index + 1}`,
        title: `Independent page ${index + 1}`,
        snippet: `A retained descriptor from result ${index + 1}.`,
      })),
      { url: 'https://original-a.example/same-host-fallback', title: 'Same-host alternative', snippet: 'A fallback descriptor.' },
      { url: 'http://unsafe.example/refused', title: 'Unsafe descriptor', snippet: 'Retain the raw result but do not fetch it.' },
    ];
    const resultsByQuery = new Map<string, Array<{ url: string; title: string; snippet: string }>>([
      [queries[0]!, alphaHits],
      [queries[1]!, [{ url: 'https://independent-b.example/first', title: 'B independent source', snippet: 'A distinct-host descriptor.' }]],
      [queries[2]!, [{ url: 'https://independent-c.example/first', title: 'C independent source', snippet: 'A distinct-host descriptor.' }]],
      [queries[3]!, [
        { url: 'https://independent-a.example/query-two', title: 'A second-query source', snippet: 'The alternate query also gets a chance.' },
        { url: reusedUrl, title: 'Previously collected source', snippet: 'This URL is supplied through skipUrls.' },
      ]],
      [queries[4]!, [
        { url: 'https://original-b.example/same-host-fallback', title: 'B same-host fallback', snippet: 'A fallback descriptor.' },
        { url: sharedUrl, title: 'Shared B and C source', snippet: 'One URL is linked to two lead queries.' },
      ]],
      [queries[5]!, [
        { url: 'https://profile-c.example/same-host-fallback', title: 'C same-host fallback', snippet: 'A fallback descriptor.' },
        { url: sharedUrl, title: 'Shared B and C source', snippet: 'One URL is linked to two lead queries.' },
      ]],
    ]);
    const run = async () => {
      const fetched: string[][] = [];
      const mock = mockFetch((url, init) => {
        if (url.includes('api.search.tinyfish.ai')) {
          const query = new URL(url).searchParams.get('query') ?? '';
          return json({ results: resultsByQuery.get(query) ?? [] });
        }
        const requested = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
        fetched.push(requested);
        return json({ results: requested.map(item => fetchResult(item, 'A retained public page.')), errors: [] });
      });
      const read = await recoverComparisonSources(
        token, KEY, queries, [reusedUrl], 8, mock.fetcher, () => '2026-10-01T12:00:00.000Z', parents,
      );
      const scope = JSON.parse(read.rawArtifacts['attention-selection-scope']!) as {
        method: string; maxUrls: number; selectedUrls: string[];
        selection: Array<{ parentId: string; queryId: string; resultIndex: number; url: string | null; selected: boolean; reused: boolean }>;
      };
      return { read, fetched, scope };
    };

    const first = await run();
    const second = await run();
    const expected = [
      'https://independent-a.example/page-1',
      'https://independent-b.example/first',
      'https://independent-c.example/first',
      'https://independent-a.example/query-two',
      sharedUrl,
      'https://profile-c.example/same-host-fallback',
      'https://independent-a.example/page-2',
      'https://original-b.example/same-host-fallback',
    ];
    assert.equal(first.scope.method, 'fair-parent-query-v1');
    assert.equal(first.scope.maxUrls, 8);
    assert.deepEqual(first.scope.selectedUrls, expected,
      'the selector serves every parent before allocating remaining slots and interleaves result ranks across that lead’s queries');
    assert.deepEqual(first.fetched, [expected], 'eight unique URLs share one bounded Fetch batch');
    assert.deepEqual(second.scope.selectedUrls, first.scope.selectedUrls, 'selection order is deterministic');
    assert.equal(first.read.comparisonAcquisition?.leadCount, alphaHits.length + 1 + 1 + 2 + 2 + 2);
    assert.equal(first.read.comparisonComplete, false, 'unselected search descriptors keep the recovery acquisition incomplete');
    assert.ok(first.read.codes.includes('ATT_PAGE_CAP'));
    assert.ok(first.read.rawArtifacts['attention-search-1']?.includes('https://independent-a.example/page-10'),
      'unselected descriptors remain in the exact raw search response');

    const selection = first.scope.selection;
    const reused = selection.find(item => item.url === reusedUrl);
    assert.deepEqual([reused?.selected, reused?.reused], [false, true], 'a previously collected URL is recorded and costs no new slot');
    const shared = selection.filter(item => item.url === sharedUrl);
    assert.deepEqual(shared.map(item => [item.parentId, item.selected]), [
      ['failed-lead-2', true], ['mutable-profile-3', true],
    ], 'a shared fetch remains linked to each parent descriptor');
    const sameHostA = selection.find(item => item.url === 'https://original-a.example/same-host-fallback');
    assert.equal(sameHostA?.selected, false, 'the crowded parent exhausts independent-host options before its same-host fallback');
    const unsafe = first.read.comparisonAcquisition?.leads.find(lead => lead.title === 'Unsafe descriptor');
    assert.equal(unsafe?.url, null);
    assert.equal(unsafe?.acquisitionStatus, 'UNSAFE');
    assert.equal(selection.find(item => item.url === null)?.selected, false, 'unsafe raw descriptors never become fetch URLs');
  });

  await t.test('fewer URL slots than parents leaves later obligations visible', async () => {
    const queries = ['lead one discovery', 'lead two discovery', 'lead three discovery'];
    const parents = queries.map((_, index) => ({ leadId: `failed-${index + 1}`, originalUrl: `https://origin-${index + 1}.example/failed` }));
    const fetched: string[][] = [];
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) {
        const query = new URL(url).searchParams.get('query') ?? '';
        const index = queries.indexOf(query);
        return search([`https://alternate-${index + 1}.example/page`]);
      }
      const requested = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
      fetched.push(requested);
      return json({ results: requested.map(item => fetchResult(item, 'An acquired source page.')), errors: [] });
    });
    const read = await recoverComparisonSources(token, KEY, queries, [], 2, mock.fetcher,
      () => '2026-10-01T12:00:00.000Z', parents);
    const scope = JSON.parse(read.rawArtifacts['attention-selection-scope']!) as {
      selectedUrls: string[]; selection: Array<{ parentId: string; selected: boolean }>;
    };

    assert.deepEqual(fetched, [['https://alternate-1.example/page', 'https://alternate-2.example/page']]);
    assert.deepEqual(scope.selectedUrls, fetched[0]);
    assert.equal(scope.selection.some(item => item.parentId === 'failed-3' && item.selected), false);
    assert.equal(read.comparisonComplete, false);
    assert.ok(read.codes.includes('ATT_PAGE_CAP'));
    assert.ok(read.rawArtifacts['attention-search-3']?.includes('https://alternate-3.example/page'));
  });

  await t.test('without query parents, recovery keeps the previous first-result selection', async () => {
    const firstQuery = Array.from({ length: 10 }, (_, index) => `https://legacy.example/page-${index + 1}`);
    const queries = ['legacy first result set', 'legacy later result set'];
    const fetched: string[][] = [];
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) {
        const query = new URL(url).searchParams.get('query') ?? '';
        return search(query === queries[0] ? firstQuery : ['https://later.example/not-selected']);
      }
      const requested = (JSON.parse(String(init?.body)) as { urls: string[] }).urls;
      fetched.push(requested);
      return json({ results: requested.map(item => fetchResult(item, 'A legacy retained result.')), errors: [] });
    });
    const read = await recoverComparisonSources(token, KEY, queries, [], 8, mock.fetcher,
      () => '2026-10-01T12:00:00.000Z');

    assert.deepEqual(fetched, [firstQuery.slice(0, 8)]);
    assert.equal(read.rawArtifacts['attention-selection-scope'], undefined,
      'the fair recovery selector is opt-in; legacy result-order recovery has no new selection manifest');
    assert.equal(read.comparisonComplete, false);
  });
});

test('project-context-v2 retains the complete bounded recovery descriptor set', async () => {
  const queries = Array.from({ length: 20 }, (_, index) => `independent indexed subject recovery query ${index + 1}`);
  const resultsByQuery = new Map(queries.map((query, queryIndex) => [query, Array.from({ length: 10 }, (_, resultIndex) => ({
    url: `https://recovery-${queryIndex + 1}.example/source-${resultIndex + 1}`,
    title: `Distinctive indexed source ${queryIndex + 1}-${resultIndex + 1}`,
    snippet: `Public description of indexed subject ${queryIndex + 1} with source context ${resultIndex + 1}.`,
  }))]));
  const fetched: string[][] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      return json({ results: resultsByQuery.get(query) ?? [], errors: [] });
    }
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    fetched.push(requested);
    return json({ results: requested.map(item => fetchResult(item, `A fully acquired independent source about ${token.address}.`)), errors: [] });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', undefined, [], {
    queries, skipUrls: [], maxUrls: 8,
  }, 'public-support-v2');

  assert.equal(read.comparisonAcquisition?.leadCount, 200);
  assert.equal(read.comparisonAcquisition?.leads.length, 200,
    'all 20 × 10 indexed descriptors are retained for qualification');
  assert.equal(read.comparisonAcquisition?.descriptorComplete, true);
  assert.equal(read.codes.includes('ATT_DESCRIPTOR_CAP'), false);
  assert.equal(fetched.flat().length, 8, 'only the bounded source-fetch budget is consumed');
  assert.equal(read.sources.length, 8);
  assert.equal(read.comparisonComplete, false, 'unfetched descriptors remain an explicit acquisition gap');
  assert.ok(read.codes.includes('ATT_PAGE_CAP'));
});

test('collector caps unique pages at thirty-two, fetch batches at ten, and retained text at twelve thousand characters', async () => {
  const allUrls = Array.from({ length: 40 }, (_, index) => `https://public.example/page-${index + 1}`);
  const fetchBatches: string[][] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) return search(allUrls);
    const body = JSON.parse(String(init.body)) as { urls: string[] };
    fetchBatches.push(body.urls);
    return json({ results: body.urls.map(pageUrl => fetchResult(pageUrl, 'x'.repeat(12_001))), errors: [] });
  });
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');

  assert.equal(read.queries.length, 2);
  assert.equal(read.sources.length, 32);
  assert.equal(read.sources.every(source => source.text.length === 12_000), true);
  assert.deepEqual(fetchBatches.map(batch => batch.length), [10, 10, 10, 2]);
  assert.equal(new Set(fetchBatches.flat()).size, 32);
  assert.equal(read.complete, false);
  assert.equal(read.postSampleComplete, true, 'omitting page-only search results does not erase selected-post completeness');
  assert.ok(read.codes.includes('ATT_PAGE_CAP'));
  assert.ok(read.codes.includes('ATT_TEXT_CAP'));
  assert.equal(read.comparisonComplete, false, 'a read without a named comparison query has no complete comparison scope');
  assert.equal(mock.calls.filter(call => call.url.includes('api.fetch.tinyfish.ai')).length, 4);
});

test('named comparison retention exceeds the ordinary page cap and remains explicit at per-source and aggregate limits', async t => {
  const run = async (pageTexts: string[]) => {
    const urls = pageTexts.map((_, index) => `https://public.example/comparison-${index + 1}`);
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) {
        const query = new URL(url).searchParams.get('query') ?? '';
        return search(query.includes('"River Lantern"') ? urls : []);
      }
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      return json({ results: requested.map(item => fetchResult(item, pageTexts[urls.indexOf(item)]!)), errors: [] });
    });
    return { read: await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern'), urls };
  };

  await t.test('retains a full comparison tail beyond twelve thousand characters', async () => {
    const text = `The River Lantern source names ${token.address}.` + 'x'.repeat(16_000);
    const { read } = await run([text]);
    assert.equal(read.comparisonComplete, true);
    assert.equal(read.sources[0]?.text, text);
    assert.equal(read.codes.includes('ATT_TEXT_CAP'), false);
  });

  await t.test('a comparison source over one hundred twenty thousand characters stays incomplete', async () => {
    const { read } = await run(['x'.repeat(120_001)]);
    assert.equal(read.comparisonComplete, false);
    assert.equal(read.sources[0]?.text.length, 120_000);
    assert.ok(read.codes.includes('ATT_TEXT_CAP'));
  });

  await t.test('comparison aggregate retention stops at five hundred twelve thousand characters', async () => {
    const texts = Array.from({ length: 5 }, (_, index) => {
      const prefix = `Source ${index + 1} names ${token.address}.`;
      return prefix + 'x'.repeat(120_000 - prefix.length);
    });
    const { read } = await run(texts);
    assert.equal(read.sources.length, 5);
    assert.equal(read.sources.reduce((sum, source) => sum + source.text.length, 0), 512_000);
    assert.deepEqual(read.sources.map(source => source.text.length), [120_000, 120_000, 120_000, 120_000, 32_000]);
    assert.equal(read.comparisonComplete, false);
    assert.ok(read.codes.includes('ATT_TEXT_CAP'));
  });
});

test('public-support-v2 retains and submits full original and comparison bodies while legacy submission stays at six thousand characters', async () => {
  const originUrl = 'https://public.example/river-lantern-origin';
  const comparisonUrl = 'https://public.example/river-lantern-comparison';
  const originText = `Original source for ${token.address}. ${'Acquired origin detail. '.repeat(1200)}`.slice(0, 23_704);
  const comparisonText = `Comparison source for ${token.address}. ${'Acquired comparison detail. '.repeat(1000)}`.slice(0, 19_893);
  assert.equal(originText.length, 23_704);
  assert.equal(comparisonText.length, 19_893);
  const makeFetcher = () => mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      if (query.includes('River Lantern')) return json({ results: [{ url: comparisonUrl, title: 'River Lantern token origin', snippet: 'A comparison result.' }] });
      return search([originUrl]);
    }
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    return json({ results: requested.map(requestedUrl => fetchResult(requestedUrl,
      requestedUrl === originUrl ? originText : comparisonText)), errors: [] });
  });
  const now = () => '2026-10-19T18:30:00.000Z';

  const freshRead = await collectAttentionSources(token, KEY, makeFetcher().fetcher, now, 'River Lantern', [], undefined, 'public-support-v2');
  assert.equal(freshRead.entryEvidenceMethod, 'public-support-v2');
  assert.deepEqual(freshRead.sources.map(source => source.text.length), [23_704, 19_893]);
  assert.deepEqual(attentionSubmittedSources(freshRead).map(source => source.text), [originText, comparisonText]);
  const scope = entryEvidenceScope(freshRead, token, now());
  assert.equal(scope.complete, true, JSON.stringify(scope));
  assert.deepEqual(scope.sourceIds, freshRead.sources.map(source => source.id), 'the full retained catalog remains the reviewed catalog');
  assert.deepEqual(scope.originSourceIds, [freshRead.sources[0]!.id], 'only the two original exact-token searches establish origin scope');

  const legacyRead = await collectAttentionSources(token, KEY, makeFetcher().fetcher, now, 'River Lantern');
  assert.equal(legacyRead.entryEvidenceMethod, undefined);
  assert.deepEqual(attentionSubmittedSources(legacyRead).map(source => source.text.length), [6_000, 6_000],
    'method-absent historical packet reconstruction keeps its original six-thousand-character submitted prefix');
});

test('public-support scope accepts only explicit permanent blocks after each comparison recovery query succeeds', () => {
  const originUrl = 'https://public.example/river-lantern-origin';
  const blockedUrl = 'https://public.example/river-lantern-comparison';
  const originText = `Original source for ${token.address}.`;
  const read: AttentionRead = {
    entryEvidenceMethod: 'public-support-v2',
    sources: [{ id: 'origin-source', url: originUrl, text: originText, publishedAt: null, authorId: null,
      availableAt: '2026-10-19T18:30:00.000Z', kind: 'PAGE' }],
    rawArtifacts: {
      'attention-search-1': JSON.stringify({ results: [{ url: originUrl }], errors: [] }),
      'attention-search-2': JSON.stringify({ results: [{ url: originUrl }], errors: [] }),
      'attention-search-3': JSON.stringify({ results: [{ url: blockedUrl, title: 'River Lantern', snippet: 'Candidate token source.' }], errors: [] }),
      'attention-recovery-search-1': JSON.stringify({ results: [], errors: [] }),
      'attention-fetch-1': JSON.stringify({ results: [{ url: originUrl, final_url: originUrl, text: originText }], errors: [{ url: blockedUrl, error: 'HTTP 404 not found' }] }),
    },
    queries: ['mint origin', 'mint x.com', 'named comparison'], complete: false, codes: ['ATT_FETCH_URL_ERROR'],
    start: '2026-10-18T18:30:00.000Z', end: '2026-10-19T18:30:00.000Z', comparisonSourceIds: [],
    comparisonComplete: false,
    comparisonAcquisition: {
      originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 1,
      leads: [{ id: 'lead-1', searchArtifactId: 'attention-search-3', resultIndex: 0, url: blockedUrl,
        title: 'River Lantern', snippet: 'Candidate token source.', metadataEvidenceId: 'lead-1-metadata', sourceIds: [],
        acquisitionStatus: 'FAILED', acquisitionCodes: [], recoveryQueryIds: ['attention-recovery-search-1'], recoverySourceIds: [] }],
    },
    comparisonQualification: { recoveryCapped: false, recoveryQueries: [{ queryId: 'attention-recovery-search-1', parentLeadId: 'lead-1', state: 'NO_RESULTS', descriptorComplete: true }] },
  };

  const permitted = entryEvidenceScope(read, token, '2026-10-19T18:30:00.000Z');
  assert.equal(permitted.complete, true, JSON.stringify(permitted));
  assert.deepEqual(permitted.gaps, [{ url: blockedUrl, code: 'TARGET_BLOCKED' }]);
  assert.deepEqual(permitted.blockers, []);

  const incompleteRecovery = structuredClone(read);
  (incompleteRecovery.comparisonQualification as { recoveryQueries: Array<{ state: string }> }).recoveryQueries[0]!.state = 'UNAVAILABLE';
  const blockedWithoutRecovery = entryEvidenceScope(incompleteRecovery, token, '2026-10-19T18:30:00.000Z');
  assert.equal(blockedWithoutRecovery.complete, false);
  assert.ok(blockedWithoutRecovery.blockers.includes('ATT_ENTRY_COMPARISON_RECOVERY_INCOMPLETE'));
  assert.deepEqual(blockedWithoutRecovery.gaps, []);

  for (const failure of ['HTTP 429 rate limit', 'HTTP 503 transport failure', 'timeout']) {
    const interrupted = structuredClone(read);
    const fetch = JSON.parse(interrupted.rawArtifacts['attention-fetch-1']!) as { errors: Array<{ url: string; error: string }> };
    fetch.errors[0]!.error = failure;
    interrupted.rawArtifacts['attention-fetch-1'] = JSON.stringify(fetch);
    interrupted.codes = [failure.includes('429') ? 'ATT_FETCH_HTTP_429' : failure.includes('503') ? 'ATT_FETCH_HTTP_503' : 'ATT_FETCH_TIMEOUT'];
    const scope = entryEvidenceScope(interrupted, token, '2026-10-19T18:30:00.000Z');
    assert.equal(scope.complete, false, `${failure} is an unresolved collection boundary`);
    assert.deepEqual(scope.gaps, [], `${failure} cannot be recorded as a permanent public-access gap`);
  }
});

test('public-support timeout gaps require successful original attempts and a selected full body from the target lead own recovery', async () => {
  const cutoff = '2026-10-20T12:00:00.000Z';
  const originUrl = 'https://public.example/river-lantern-origin';
  const targetUrl = 'https://public.example/river-lantern-market';
  const alternateUrl = 'https://independent.example/river-lantern-market-record';
  const query = 'Identify the indexed River Lantern market record and independent project sources';
  const originText = `The River Lantern project describes its public art theme and identifies token ${token.address} as its original deployment.`;
  const alternateText = `An independent index records the River Lantern project and token ${token.address}; its indexed subject remains distinct from the unread original market page.`;
  let searchCall = 0;
  let fetchCall = 0;
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const call = searchCall++;
      if (call < 2) return json({ results: [{ url: originUrl }], errors: [] });
      if (call === 2) return json({ results: [{ url: targetUrl, title: 'River Lantern market record', snippet: 'A public index page for the project market.' }], errors: [] });
      return json({ results: [{ url: alternateUrl, title: 'River Lantern project index', snippet: 'An independent public project record.' }], errors: [] });
    }
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    fetchCall++;
    if (requested.includes(alternateUrl)) return json({
      results: [fetchResult(alternateUrl, alternateText)], errors: [],
    });
    return json({
      results: requested.includes(originUrl) ? [fetchResult(originUrl, originText)] : [],
      errors: requested.includes(targetUrl) ? [{ url: targetUrl, error: 'timeout' }] : [],
    });
  });
  const initial = await collectAttentionSources(token, KEY, mock.fetcher, () => cutoff, 'River Lantern', [], undefined, 'public-support-v2');
  assert.equal(fetchCall, 2, 'the original target timeout is retained after the collector makes its bounded retry');
  const originalOutcomes = JSON.parse(initial.rawArtifacts['attention-http-outcomes']!) as { outcomes: Array<{ artifactId: string; status: number }> };
  assert.deepEqual(originalOutcomes.outcomes.filter(row => row.artifactId.startsWith('attention-fetch-')),
    [{ artifactId: 'attention-fetch-1', status: 200 }, { artifactId: 'attention-fetch-1-retry-1', status: 200 }],
    'the transport envelope succeeded for the original and retry even though the target-local page timed out');
  assert.equal(entryEvidenceScope(initial, token, cutoff).complete, false,
    'a timeout by itself remains unknown before own alternate acquisition');

  const parent = initial.comparisonAcquisition!.leads.find(lead => lead.url === targetUrl)!;
  const recovery = await recoverComparisonSources(token, KEY, [query], [originUrl, targetUrl], 8,
    mock.fetcher, () => cutoff, [{ leadId: parent.id, originalUrl: targetUrl }], true, 'public-support-v2');
  const recoveredSources = recovery.sources.map(source => ({ ...source, id: source.id.replace(/^attention-/, 'attention-recovery-') }));
  const recoveryArtifacts: Record<string, string> = {};
  for (const [id, raw] of Object.entries(recovery.rawArtifacts)) {
    if (id === 'attention-selection-scope') {
      const selection = JSON.parse(raw) as { selection: Array<Record<string, unknown> & { queryId: string }> };
      recoveryArtifacts['attention-recovery-selection-scope'] = JSON.stringify({
        ...selection,
        selection: selection.selection.map(row => ({ ...row, collectorQueryId: row.queryId,
          queryId: row.queryId.replace(/^attention-/, 'attention-recovery-') })),
      });
    } else if (id.startsWith('attention-')) recoveryArtifacts[id.replace(/^attention-/, 'attention-recovery-')] = raw;
    else if (id.startsWith('comparison-lead-')) recoveryArtifacts[`attention-recovery-${id}`] = raw;
  }
  const recoverySearch = JSON.parse(recovery.rawArtifacts['attention-search-1']!) as { results: unknown[] };
  const recoveryQueryId = 'attention-recovery-search-1';
  const sourceIds = recoveredSources.map(source => source.id);
  const recoveryQueries = [{ queryId: recoveryQueryId, parentLeadId: parent.id, query, state: 'OBSERVED',
    descriptorComplete: true, resultCount: recoverySearch.results.length, availableAt: cutoff }];
  const lead = { ...parent, recoveryQueryIds: [recoveryQueryId], recoverySourceIds: sourceIds };
  const comparisonRecovery = { method: 'comparison-acquisition-v1' as const, accessGapMethod: 'own-acquired-alternates-v1' as const,
    selectedLeadIds: [parent.id], recoveryQueries, recoveryCapped: false,
    sourceLineage: [{ leadId: parent.id, queryIds: [recoveryQueryId], sourceIds }] };
  const qualified: AttentionRead = {
    ...initial,
    entryExecutionMethod: 'entry-first-v2',
    sources: [...initial.sources, ...recoveredSources],
    rawArtifacts: { ...initial.rawArtifacts, ...recoveryArtifacts, 'attention-entry-first-acquisition': JSON.stringify(comparisonRecovery) },
    comparisonAcquisition: { ...initial.comparisonAcquisition!, originalComplete: false, leads: [lead] },
    comparisonRecovery,
    comparisonSourceIds: sourceIds,
    comparisonComplete: false,
  };
  const eligible = entryEvidenceScope(qualified, token, cutoff);
  assert.equal(eligible.complete, true, JSON.stringify(eligible));
  assert.deepEqual(eligible.gaps, [{ url: targetUrl, code: 'TARGET_ACCESS_GAP', cause: 'ATT_FETCH_TIMEOUT',
    originalAttemptIds: ['attention-fetch-1', 'attention-fetch-1-retry-1'], parentLeadId: parent.id,
    queryIds: [recoveryQueryId], alternativeSourceIds: sourceIds }]);
  assert.equal(qualified.complete, false, 'a public review scope does not rewrite factual acquisition completeness');
  assert.equal(qualified.comparisonComplete, false, 'alternate acquisition does not claim original comparison completion');
  assert.equal(qualified.comparisonAcquisition?.originalComplete, false);

  const blocked = (name: string, mutate: (candidate: AttentionRead) => void, expected?: string) => {
    const candidate = structuredClone(qualified);
    mutate(candidate);
    const scope = entryEvidenceScope(candidate, token, cutoff);
    assert.equal(scope.complete, false, `${name}: ${JSON.stringify(scope)}`);
    assert.equal(scope.gaps.some(gap => gap.code === 'TARGET_ACCESS_GAP'), false, `${name} cannot certify the original access gap`);
    if (expected) assert.ok(scope.blockers.includes(expected), `${name}: ${scope.blockers.join(', ')}`);
  };
  for (const [artifactId, status, code] of [
    ['attention-fetch-1', 503, 'ATT_FETCH_HTTP_503'],
    ['attention-fetch-1-retry-1', 429, 'ATT_FETCH_HTTP_429'],
  ] as const) blocked(`${artifactId} HTTP ${status}`, candidate => {
    const outcomes = JSON.parse(candidate.rawArtifacts['attention-http-outcomes']!) as { outcomes: Array<{ artifactId: string; status: number }> };
    outcomes.outcomes.find(row => row.artifactId === artifactId)!.status = status;
    candidate.rawArtifacts['attention-http-outcomes'] = JSON.stringify(outcomes);
  }, code);
  blocked('missing recovery HTTP receipt', candidate => { delete candidate.rawArtifacts['attention-recovery-http-outcomes']; }, 'ATT_ENTRY_RECOVERY_HTTP_INCOMPLETE');
  blocked('no results from the own query', candidate => {
    candidate.rawArtifacts[recoveryQueryId] = JSON.stringify({ results: [], errors: [] });
    const q = candidate.comparisonRecovery!;
    q.recoveryQueries[0]!.state = 'NO_RESULTS';
    q.recoveryQueries[0]!.resultCount = 0;
    candidate.rawArtifacts['attention-entry-first-acquisition'] = JSON.stringify(q);
  });
  blocked('full body exists only outside the own query results', candidate => {
    const raw = JSON.parse(candidate.rawArtifacts[recoveryQueryId]!) as { results: Array<Record<string, unknown>> };
    raw.results = [{ url: 'https://sibling.example/river-lantern' }];
    candidate.rawArtifacts[recoveryQueryId] = JSON.stringify(raw);
  });
  blocked('selected alternative body is missing from the retained catalog', candidate => {
    candidate.sources = candidate.sources.filter(source => !source.id.startsWith('attention-recovery-'));
  });
  blocked('selected Fetch is moved out of its canonical batch', candidate => {
    candidate.rawArtifacts['attention-recovery-fetch-99'] = candidate.rawArtifacts['attention-recovery-fetch-1']!;
    delete candidate.rawArtifacts['attention-recovery-fetch-1'];
  }, 'ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE');
});

test('public-support scope requires completed recovery for blocked original sources and reuses only matching comparison recovery', () => {
  const originUrl = 'https://public.example/river-lantern-origin';
  const blockedUrl = 'https://public.example/river-lantern-launch';
  const alternateUrl = 'https://independent.example/river-lantern-launch';
  const originText = `River Lantern token ${token.address}; the project launch page is ${blockedUrl}.`;
  const alternateText = `An independent public index describes the River Lantern launch and token ${token.address}.`;
  const cutoff = '2026-10-19T18:30:00.000Z';
  const blockedOriginal = (): AttentionRead => ({
    entryEvidenceMethod: 'public-support-v2',
    sources: [{ id: 'origin-source', url: originUrl, text: originText, publishedAt: null, authorId: null,
      availableAt: cutoff, kind: 'PAGE' }],
    rawArtifacts: {
      'attention-search-1': JSON.stringify({ results: [{ url: originUrl }, { url: blockedUrl }], errors: [] }),
      'attention-search-2': JSON.stringify({ results: [{ url: originUrl }, { url: blockedUrl }], errors: [] }),
      'attention-search-3': JSON.stringify({ results: [], errors: [] }),
      'attention-fetch-1': JSON.stringify({ results: [{ url: originUrl, final_url: originUrl, text: originText }],
        errors: [{ url: blockedUrl, status: 404, error: 'HTTP 404 not found' }] }),
    },
    queries: ['original source', 'original account', 'comparison search'], complete: false,
    codes: ['ATT_FETCH_URL_ERROR'], start: '2026-10-18T18:30:00.000Z', end: cutoff,
    discoveryUrls: [originUrl, blockedUrl], comparisonSourceIds: [], comparisonComplete: false,
    comparisonAcquisition: { originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 0, leads: [] },
  });
  const unresolved = entryEvidenceScope(blockedOriginal(), token, cutoff);
  assert.equal(unresolved.complete, false, 'a permanent original-page denial stays unknown before alternate research');
  assert.ok(unresolved.blockers.includes('ATT_ENTRY_ORIGIN_RECOVERY_INCOMPLETE'));
  assert.deepEqual(unresolved.gaps, []);

  const ownRecovery = blockedOriginal();
  ownRecovery.rawArtifacts['attention-origin-role-1-search-query'] = originRecoveryQuery(ownRecovery, token, blockedUrl);
  ownRecovery.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ results: [{ url: alternateUrl }], errors: [] });
  ownRecovery.rawArtifacts['attention-origin-role-1-fetch'] = JSON.stringify({
    results: [{ url: alternateUrl, final_url: alternateUrl, text: alternateText }], errors: [],
  });
  ownRecovery.sources.push({ id: 'attention-origin-role-page-2', url: alternateUrl, text: alternateText,
    publishedAt: null, authorId: null, availableAt: cutoff, kind: 'PAGE' });
  const eligible = entryEvidenceScope(ownRecovery, token, cutoff);
  assert.equal(eligible.complete, true, JSON.stringify(eligible));
  assert.deepEqual(eligible.gaps, [{ url: blockedUrl, code: 'TARGET_BLOCKED' }]);

  const emptySearch = blockedOriginal();
  emptySearch.rawArtifacts['attention-origin-role-1-search-query'] = originRecoveryQuery(emptySearch, token, blockedUrl);
  emptySearch.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ results: [], errors: [] });
  const emptySearchScope = entryEvidenceScope(emptySearch, token, cutoff);
  assert.equal(emptySearchScope.complete, true, JSON.stringify(emptySearchScope));
  assert.deepEqual(emptySearchScope.gaps, [{ url: blockedUrl, code: 'TARGET_BLOCKED' }],
    'a successful bounded search with no alternate results is a completed attempt');

  const emptyContentOriginal = (): AttentionRead => {
    const read = blockedOriginal();
    const fetch = JSON.parse(read.rawArtifacts['attention-fetch-1']!) as {
      results: Array<Record<string, unknown>>; errors: Array<Record<string, unknown>>;
    };
    fetch.errors[0] = { url: blockedUrl, error: 'empty_content' };
    read.rawArtifacts['attention-fetch-1'] = JSON.stringify(fetch);
    return read;
  };
  const emptyWithoutRecovery = entryEvidenceScope(emptyContentOriginal(), token, cutoff);
  assert.equal(emptyWithoutRecovery.complete, false, 'empty_content is not a terminal gap without the matching bounded recovery');
  assert.deepEqual(emptyWithoutRecovery.gaps, []);

  const emptyNoResultsRecovery = emptyContentOriginal();
  emptyNoResultsRecovery.rawArtifacts['attention-origin-role-1-search-query'] = originRecoveryQuery(emptyNoResultsRecovery, token, blockedUrl);
  emptyNoResultsRecovery.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ results: [], errors: [] });
  const emptyNoResultsScope = entryEvidenceScope(emptyNoResultsRecovery, token, cutoff);
  assert.equal(emptyNoResultsScope.complete, true, JSON.stringify(emptyNoResultsScope));
  assert.deepEqual(emptyNoResultsScope.gaps, [{ url: blockedUrl, code: 'TARGET_EMPTY' }]);

  const emptyMissingRecovery = emptyContentOriginal();
  emptyMissingRecovery.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ results: [], errors: [] });
  const emptyMissingScope = entryEvidenceScope(emptyMissingRecovery, token, cutoff);
  assert.equal(emptyMissingScope.complete, false, 'an unbound recovery response cannot close the original empty_content gap');
  assert.deepEqual(emptyMissingScope.gaps, []);

  const emptyFailedRecovery = emptyContentOriginal();
  emptyFailedRecovery.rawArtifacts['attention-origin-role-1-search-query'] = originRecoveryQuery(emptyFailedRecovery, token, blockedUrl);
  emptyFailedRecovery.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ error: 'HTTP 503 transport failure' });
  const emptyFailedScope = entryEvidenceScope(emptyFailedRecovery, token, cutoff);
  assert.equal(emptyFailedScope.complete, false, 'a failed recovery search leaves empty_content unresolved');
  assert.deepEqual(emptyFailedScope.gaps, []);

  const emptyTimeoutRecovery = emptyContentOriginal();
  const timeoutFetch = JSON.parse(emptyTimeoutRecovery.rawArtifacts['attention-fetch-1']!) as {
    results: Array<Record<string, unknown>>; errors: Array<Record<string, unknown>>;
  };
  timeoutFetch.errors[0] = { url: blockedUrl, error: 'timeout' };
  emptyTimeoutRecovery.rawArtifacts['attention-fetch-1'] = JSON.stringify(timeoutFetch);
  emptyTimeoutRecovery.codes = ['ATT_FETCH_TIMEOUT'];
  emptyTimeoutRecovery.rawArtifacts['attention-origin-role-1-search-query'] = originRecoveryQuery(emptyTimeoutRecovery, token, blockedUrl);
  emptyTimeoutRecovery.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ results: [], errors: [] });
  const emptyTimeoutScope = entryEvidenceScope(emptyTimeoutRecovery, token, cutoff);
  assert.equal(emptyTimeoutScope.complete, false, 'a successful no-results search cannot erase the original timeout');
  assert.deepEqual(emptyTimeoutScope.gaps, []);

  const terminalAlternate = blockedOriginal();
  terminalAlternate.rawArtifacts['attention-origin-role-1-search-query'] = originRecoveryQuery(terminalAlternate, token, blockedUrl);
  terminalAlternate.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ results: [{ url: alternateUrl }], errors: [] });
  terminalAlternate.rawArtifacts['attention-origin-role-1-fetch'] = JSON.stringify({
    results: [], errors: [{ url: alternateUrl, status: 404, error: 'HTTP 404 not found' }],
  });
  const terminalAlternateScope = entryEvidenceScope(terminalAlternate, token, cutoff);
  assert.equal(terminalAlternateScope.complete, true, JSON.stringify(terminalAlternateScope));
  assert.deepEqual(terminalAlternateScope.gaps, [{ url: blockedUrl, code: 'TARGET_BLOCKED' }],
    'a completed different-host Fetch that ends in a terminal access gap is eligible');

  const matchingComparison = blockedOriginal();
  matchingComparison.rawArtifacts['attention-search-3'] = JSON.stringify({
    results: [{ url: blockedUrl, title: 'River Lantern launch', snippet: 'Original launch page.' }], errors: [],
  });
  matchingComparison.rawArtifacts['attention-recovery-search-1'] = JSON.stringify({
    results: [{ url: alternateUrl, title: 'River Lantern launch record', snippet: 'Independent index.' }], errors: [],
  });
  matchingComparison.rawArtifacts['attention-recovery-fetch-1'] = JSON.stringify({
    results: [{ url: alternateUrl, final_url: alternateUrl, text: alternateText }], errors: [],
  });
  const matchingSelection = comparisonRecoverySelection(
    [{ searchArtifactId: 'attention-search-1', resultIndex: 0, url: alternateUrl }],
    [{ leadId: 'lead-1', originalUrl: blockedUrl }], [originUrl, blockedUrl], 8,
  );
  matchingComparison.rawArtifacts['attention-recovery-selection-scope'] = JSON.stringify({
    ...matchingSelection,
    selection: matchingSelection.selection.map(row => ({
      ...row, collectorQueryId: row.queryId, queryId: row.queryId.replace('attention-', 'attention-recovery-'),
    })),
  });
  matchingComparison.sources.push({ id: 'attention-recovery-page-2', url: alternateUrl, text: alternateText,
    publishedAt: null, authorId: null, availableAt: cutoff, kind: 'PAGE' });
  matchingComparison.comparisonAcquisition = { originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 1,
    leads: [{ id: 'lead-1', searchArtifactId: 'attention-search-3', resultIndex: 0, url: blockedUrl,
      title: 'River Lantern launch', snippet: 'Original launch page.', metadataEvidenceId: 'lead-1-metadata', sourceIds: [],
      acquisitionStatus: 'FAILED', acquisitionCodes: ['ATT_LEAD_FAILED'], recoveryQueryIds: ['attention-recovery-search-1'],
      recoverySourceIds: ['attention-recovery-page-2'] }] };
  matchingComparison.comparisonQualification = { recoveryCapped: false,
    recoveryQueries: [{ queryId: 'attention-recovery-search-1', parentLeadId: 'lead-1', state: 'OBSERVED' }] };
  const reused = entryEvidenceScope(matchingComparison, token, cutoff);
  assert.equal(reused.complete, true, JSON.stringify(reused));
  assert.deepEqual(reused.gaps, [{ url: blockedUrl, code: 'TARGET_BLOCKED' }]);
  assert.equal(matchingComparison.rawArtifacts['attention-origin-role-1-search'], undefined,
    'the completed same-URL comparison recovery is reused without another search');

  const invalidRecoveryCases: Array<[string, (read: AttentionRead) => void]> = [
    ['recovery for another candidate slot', read => {
      read.rawArtifacts['attention-origin-role-2-search'] = JSON.stringify({ results: [], errors: [] });
    }],
    ['same-host result only', read => {
      read.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ results: [{ url: 'https://public.example/other' }], errors: [] });
    }],
    ['missing selected Fetch result', read => {
      read.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ results: [{ url: alternateUrl }], errors: [] });
    }],
    ['failed selected Fetch result', read => {
      read.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ results: [{ url: alternateUrl }], errors: [] });
      read.rawArtifacts['attention-origin-role-1-fetch'] = JSON.stringify({ results: [], errors: [{ url: alternateUrl, status: 429, error: 'HTTP 429 rate limit' }] });
    }],
    ['failed Search response', read => {
      read.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify({ error: 'HTTP 503 transport failure' });
    }],
    ['completed comparison recovery belongs to another URL', read => {
      const otherUrl = 'https://public.example/another-launch';
      const otherAlternate = 'https://independent.example/another-launch-record';
      const otherText = `An independent page records the separate launch for ${token.address}.`;
      read.rawArtifacts['attention-search-3'] = JSON.stringify({
        results: [{ url: otherUrl, title: 'Another launch', snippet: 'A different page.' }], errors: [],
      });
      const firstFetch = JSON.parse(read.rawArtifacts['attention-fetch-1']!) as { results: Array<Record<string, unknown>>; errors: Array<Record<string, unknown>> };
      firstFetch.errors.push({ url: otherUrl, status: 404, error: 'HTTP 404 not found' });
      read.rawArtifacts['attention-fetch-1'] = JSON.stringify(firstFetch);
      read.rawArtifacts['attention-recovery-search-1'] = JSON.stringify({ results: [{ url: otherAlternate }], errors: [] });
      read.rawArtifacts['attention-recovery-fetch-1'] = JSON.stringify({
        results: [{ url: otherAlternate, final_url: otherAlternate, text: otherText }], errors: [],
      });
      read.sources.push({ id: 'other-recovery-source', url: otherAlternate, text: otherText,
        publishedAt: null, authorId: null, availableAt: cutoff, kind: 'PAGE' });
      read.comparisonAcquisition = { originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 1,
        leads: [{ id: 'other-lead', searchArtifactId: 'attention-search-3', resultIndex: 0, url: otherUrl,
          title: 'Another launch', snippet: 'A different page.', metadataEvidenceId: 'other-lead-metadata', sourceIds: [],
          acquisitionStatus: 'FAILED', acquisitionCodes: ['ATT_LEAD_FAILED'], recoveryQueryIds: ['attention-recovery-search-1'],
          recoverySourceIds: ['other-recovery-source'] }] };
      read.comparisonQualification = { recoveryCapped: false,
        recoveryQueries: [{ queryId: 'attention-recovery-search-1', parentLeadId: 'other-lead', state: 'OBSERVED', descriptorComplete: true }] };
    }],
    ['claimed comparison recovery has no successful Search receipt', read => {
      read.rawArtifacts['attention-search-3'] = JSON.stringify({
        results: [{ url: blockedUrl, title: 'River Lantern launch', snippet: 'Original launch page.' }], errors: [],
      });
      read.comparisonAcquisition = { originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 1,
        leads: [{ id: 'lead-1', searchArtifactId: 'attention-search-3', resultIndex: 0, url: blockedUrl,
          title: 'River Lantern launch', snippet: 'Original launch page.', metadataEvidenceId: 'lead-1-metadata', sourceIds: [],
          acquisitionStatus: 'FAILED', acquisitionCodes: ['ATT_LEAD_FAILED'], recoveryQueryIds: ['attention-recovery-search-1'],
          recoverySourceIds: [] }] };
      read.comparisonQualification = { recoveryCapped: false,
        recoveryQueries: [{ queryId: 'attention-recovery-search-1', parentLeadId: 'lead-1', state: 'OBSERVED' }] };
    }],
  ];
  for (const [name, apply] of invalidRecoveryCases) {
    const read = blockedOriginal();
    read.rawArtifacts['attention-origin-role-1-search-query'] = originRecoveryQuery(read, token, blockedUrl);
    apply(read);
    const scope = entryEvidenceScope(read, token, cutoff);
    assert.equal(scope.complete, false, `${name}: ${JSON.stringify(scope)}`);
    assert.ok(scope.blockers.includes('ATT_ENTRY_ORIGIN_RECOVERY_INCOMPLETE'), name);
    assert.equal(scope.gaps.some(gap => gap.url === blockedUrl), false, name);
  }
});

test('fresh original-role access gaps require the role Fetch HTTP receipt and bind to its own body', () => {
  const originUrl = 'https://public.example/river-lantern-origin';
  const blockedUrl = 'https://public.example/river-lantern-launch';
  const alternateUrl = 'https://independent.example/river-lantern-launch-record';
  const originText = `River Lantern token ${token.address}; the project launch page is ${blockedUrl}.`;
  const alternateText = `An independent public index describes River Lantern launch activity and token ${token.address}.`;
  const cutoff = '2026-10-19T18:30:00.000Z';
  const result = (url: string, title: string, snippet: string) => ({ url, title, snippet });
  const search = { results: [
    result(originUrl, 'River Lantern origin', 'A project page about its launch.'),
    result(blockedUrl, 'River Lantern launch page', 'An indexed original project launch page.'),
    result(alternateUrl, 'River Lantern launch record', 'An independent launch record.'),
  ], errors: [] };
  const makeRead = (roleStatus: number | null = 200): AttentionRead => {
    const read: AttentionRead = {
      entryEvidenceMethod: 'public-support-v2', entryExecutionMethod: 'entry-first-v2',
      comparisonRecovery: { method: 'comparison-acquisition-v1', accessGapMethod: 'own-acquired-alternates-v1',
        selectedLeadIds: [], recoveryQueries: [], recoveryCapped: false, sourceLineage: [] },
      sources: [
        { id: 'origin-source', url: originUrl, text: originText, publishedAt: null, authorId: null, availableAt: cutoff, kind: 'PAGE' },
        { id: 'earlier-alternate-source', url: alternateUrl, text: alternateText, publishedAt: null, authorId: null, availableAt: cutoff, kind: 'PAGE' },
      ],
      rawArtifacts: {
        'attention-search-1': JSON.stringify(search), 'attention-search-2': JSON.stringify(search),
        'attention-search-3': JSON.stringify({ results: [], errors: [] }),
        'attention-fetch-1': JSON.stringify({ results: [
          { url: originUrl, final_url: originUrl, text: originText },
          { url: alternateUrl, final_url: alternateUrl, text: alternateText },
        ], errors: [{ url: blockedUrl, error: 'timeout' }] }),
        'attention-fetch-1-retry-1': JSON.stringify({ results: [], errors: [{ url: blockedUrl, error: 'timeout' }] }),
        'attention-http-outcomes': JSON.stringify({ method: 'fetch-http-outcomes-v1', outcomes: [
          { artifactId: 'attention-fetch-1', status: 200 },
          { artifactId: 'attention-fetch-1-retry-1', status: 200 },
        ] }),
        'attention-origin-role-1-search-query': '',
        'attention-origin-role-1-search': JSON.stringify({ results: [{ url: alternateUrl }], errors: [] }),
        // The same page body was retained by an earlier successful Fetch. The
        // role receipt must still prove this required role Fetch succeeded.
        'attention-origin-role-1-fetch': JSON.stringify({ results: [
          { url: alternateUrl, final_url: alternateUrl, text: alternateText },
        ], errors: [] }),
        'attention-origin-http-outcomes': JSON.stringify({ method: 'fetch-http-outcomes-v1', outcomes: [
          { artifactId: 'attention-origin-role-1-search', status: 200 },
          ...(roleStatus === null ? [] : [{ artifactId: 'attention-origin-role-1-fetch', status: roleStatus }]),
        ] }),
      },
      queries: [`"${token.address}" ${token.chain} origin`, `"${token.address}" public source`, 'comparison search'],
      complete: false, codes: ['ATT_FETCH_URL_ERROR'], start: cutoff, end: cutoff,
      discoveryUrls: [originUrl, blockedUrl, alternateUrl], comparisonSourceIds: [], comparisonComplete: false,
      comparisonAcquisition: { originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 0, leads: [] },
    };
    read.rawArtifacts['attention-origin-role-1-search-query'] = originRecoveryQuery(read, token, blockedUrl);
    // The original request and its bounded retry both timed out at the target
    // URL inside successful HTTP responses; the alternate was already retained.
    return read;
  };

  const eligibleRead = makeRead();
  const eligible = entryEvidenceScope(eligibleRead, token, cutoff);
  assert.equal(eligible.complete, true, JSON.stringify(eligible));
  assert.deepEqual(eligible.gaps, [{ url: blockedUrl, code: 'TARGET_ACCESS_GAP', cause: 'ATT_FETCH_TIMEOUT',
    originalAttemptIds: ['attention-fetch-1', 'attention-fetch-1-retry-1'], originalRoleId: 'attention-origin-role-1',
    queryIds: ['attention-origin-role-1-search'], alternativeSourceIds: ['earlier-alternate-source'] }]);

  const requestTimeoutRead = makeRead();
  requestTimeoutRead.codes = ['ATT_FETCH_TIMEOUT'];
  const requestTimeoutScope = entryEvidenceScope(requestTimeoutRead, token, cutoff);
  assert.equal(requestTimeoutScope.complete, false, 'a provider/request timeout remains an operational blocker');
  assert.ok(requestTimeoutScope.blockers.includes('ATT_FETCH_TIMEOUT'));

  const blocked = (name: string, mutate: (read: AttentionRead) => void, expected?: string) => {
    const read = makeRead();
    mutate(read);
    const scope = entryEvidenceScope(read, token, cutoff);
    assert.equal(scope.complete, false, `${name}: ${JSON.stringify(scope)}`);
    assert.equal(scope.gaps.some(gap => gap.code === 'TARGET_ACCESS_GAP'), false, `${name} cannot certify the original gap`);
    if (expected) assert.ok(scope.blockers.includes(expected), `${name}: ${scope.blockers.join(', ')}`);
  };
  for (const [status, code] of [[503, 'ATT_FETCH_HTTP_503'], [429, 'ATT_FETCH_HTTP_429']] as const) {
    blocked(`own role Fetch HTTP ${status}`, read => {
      const proof = JSON.parse(read.rawArtifacts['attention-origin-http-outcomes']!) as { outcomes: Array<{ artifactId: string; status: number }> };
      proof.outcomes.find(row => row.artifactId === 'attention-origin-role-1-fetch')!.status = status;
      read.rawArtifacts['attention-origin-http-outcomes'] = JSON.stringify(proof);
    }, code);
  }
  blocked('missing own role Fetch HTTP outcome row', read => {
    const proof = JSON.parse(read.rawArtifacts['attention-origin-http-outcomes']!) as { outcomes: Array<{ artifactId: string }> };
    proof.outcomes = proof.outcomes.filter(row => row.artifactId !== 'attention-origin-role-1-fetch');
    read.rawArtifacts['attention-origin-http-outcomes'] = JSON.stringify(proof);
  }, 'ATT_ENTRY_ORIGIN_RECOVERY_HTTP_INCOMPLETE');
  blocked('missing own role HTTP receipt', read => { delete read.rawArtifacts['attention-origin-http-outcomes']; },
    'ATT_ENTRY_ORIGIN_RECOVERY_HTTP_INCOMPLETE');
  blocked('missing own role Fetch artifact', read => { delete read.rawArtifacts['attention-origin-role-1-fetch']; });
  blocked('own role Fetch omits the selected row', read => {
    read.rawArtifacts['attention-origin-role-1-fetch'] = JSON.stringify({ results: [], errors: [] });
  });
  blocked('own role Fetch redirects away from the selected URL', read => {
    read.rawArtifacts['attention-origin-role-1-fetch'] = JSON.stringify({ results: [
      { url: alternateUrl, final_url: 'https://elsewhere.example/redirected', text: alternateText },
    ], errors: [] });
  });
  blocked('own role Fetch includes an unselected result URL', read => {
    const searchRows = JSON.parse(read.rawArtifacts['attention-origin-role-1-search']!) as { results: Array<Record<string, unknown>>; errors: unknown[] };
    searchRows.results.push({ url: 'https://public.example/same-host-result', title: 'Same host', snippet: 'Excluded from different-host corroboration.' });
    read.rawArtifacts['attention-origin-role-1-search'] = JSON.stringify(searchRows);
    read.rawArtifacts['attention-origin-role-1-fetch'] = JSON.stringify({ results: [
      { url: alternateUrl, final_url: alternateUrl, text: alternateText },
      { url: 'https://public.example/same-host-result', final_url: 'https://public.example/same-host-result', text: 'Unexpected unselected result.' },
    ], errors: [] });
  });
  blocked('own role Fetch body differs from the retained source', read => {
    read.rawArtifacts['attention-origin-role-1-fetch'] = JSON.stringify({ results: [
      { url: alternateUrl, final_url: alternateUrl, text: alternateText + ' altered after acquisition' },
    ], errors: [] });
  });
  blocked('role Search HTTP failure', read => {
    const proof = JSON.parse(read.rawArtifacts['attention-origin-http-outcomes']!) as { outcomes: Array<{ artifactId: string; status: number }> };
    proof.outcomes.find(row => row.artifactId === 'attention-origin-role-1-search')!.status = 503;
    read.rawArtifacts['attention-origin-http-outcomes'] = JSON.stringify(proof);
  }, 'ATT_FETCH_HTTP_503');
  blocked('role Search receipt missing', read => {
    const proof = JSON.parse(read.rawArtifacts['attention-origin-http-outcomes']!) as { outcomes: Array<{ artifactId: string }> };
    proof.outcomes = proof.outcomes.filter(row => row.artifactId !== 'attention-origin-role-1-search');
    read.rawArtifacts['attention-origin-http-outcomes'] = JSON.stringify(proof);
  }, 'ATT_ENTRY_ORIGIN_RECOVERY_HTTP_INCOMPLETE');
});

test('public-support scope requires an effective Fetch outcome for each actual selected comparison URL', async () => {
  const cutoff = '2026-10-20T12:00:00.000Z';
  const originUrl = 'https://public.example/river-lantern-origin';
  const leadUrl = 'https://index.example/river-lantern-market';
  const selectedUrl = 'https://independent.example/river-lantern-market-record';
  const unselectedUrl = 'https://another.example/river-lantern-market-record';
  const sameHostAlternateUrl = 'https://independent.example/river-lantern-market-alternate';
  const differentHostAlternateUrl = 'https://another.example/river-lantern-market-alternate';
  const nextPageUrl = 'https://third.example/river-lantern-market-alternate';
  const wrongParentUrl = 'https://other-parent.example/river-lantern-market-alternate';
  const query = 'Find independent sources for the indexed River Lantern market record';
  const originText = `The River Lantern origin page identifies ${token.address}.`;
  const selectedText = 'An independent source describes the indexed River Lantern market record.';
  const origin: AttentionRead['sources'][number] = {
    id: 'attention-page-1', url: originUrl, text: originText, publishedAt: null, authorId: null,
    availableAt: cutoff, kind: 'PAGE',
  };

  const collectRecovery = async (
    hits: string[],
    responses: Array<{ results: unknown[]; errors: unknown[] }>,
    initialSources: AttentionRead['sources'] = [origin],
    fallbackSelectionMethod?: 'observed-hosts-v1',
  ) => {
    let fetchCall = 0;
    let searchCalls = 0;
    const requested: string[][] = [];
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) {
        searchCalls++;
        return json({
          results: hits.map((hit, resultIndex) => ({ url: hit, title: `Indexed result ${resultIndex + 1}`, snippet: 'A public market index record.' })),
          errors: [],
        });
      }
      requested.push((JSON.parse(String(init.body)) as { urls: string[] }).urls);
      return json(responses[fetchCall++] ?? { results: [], errors: [] });
    });
    const skipUrls = [...initialSources.map(source => source.url), leadUrl];
    const recovery = await recoverComparisonSources(token, KEY, [query], skipUrls,
      Math.min(8, 32 - initialSources.length), mock.fetcher, () => cutoff,
      [{ leadId: 'lead-1', originalUrl: leadUrl }], true, 'public-support-v2', fallbackSelectionMethod);
    return { recovery, requested, searchCalls };
  };

  const makeRead = (recovery: Awaited<ReturnType<typeof recoverComparisonSources>>,
    initialSources: AttentionRead['sources'] = [origin],
    fallbackSelectionMethod?: 'observed-hosts-v1'): AttentionRead => {
    const rawArtifacts: Record<string, string> = {
      'attention-search-1': JSON.stringify({ results: [{ url: originUrl }], errors: [] }),
      'attention-search-2': JSON.stringify({ results: [{ url: originUrl }], errors: [] }),
      'attention-search-3': JSON.stringify({ results: [{ url: leadUrl, title: 'River Lantern market', snippet: 'Indexed market record.' }], errors: [] }),
    };
    for (let offset = 0; offset < initialSources.length; offset += 10) {
      const batch = Math.floor(offset / 10) + 1;
      const sources = initialSources.slice(offset, offset + 10);
      rawArtifacts[`attention-fetch-${batch}`] = JSON.stringify({
        results: sources.map(source => ({ url: source.url, final_url: source.url, text: source.text })),
        errors: batch === 1 ? [{ url: leadUrl, status: 404, error: 'not_found' }] : [],
      });
    }
    for (const [id, raw] of Object.entries(recovery.rawArtifacts)) {
      if (id === 'attention-selection-scope') {
        const selection = JSON.parse(raw) as { selection: Array<Record<string, unknown> & { queryId: string }> };
        rawArtifacts['attention-recovery-selection-scope'] = JSON.stringify({
          ...selection,
          selection: selection.selection.map(row => ({
            ...row, collectorQueryId: row.queryId, queryId: row.queryId.replace('attention-', 'attention-recovery-'),
          })),
        });
      } else if (id.startsWith('attention-')) rawArtifacts[id.replace(/^attention-/, 'attention-recovery-')] = raw;
      else if (id.startsWith('comparison-lead-')) rawArtifacts[`attention-recovery-${id}`] = raw;
    }
    const recoveredSources = recovery.sources.map(source => ({
      ...source, id: source.id.replace(/^attention-/, 'attention-recovery-'),
    }));
    const search = JSON.parse(recovery.rawArtifacts['attention-search-1']!) as { results: unknown[] };
    return {
      ...(fallbackSelectionMethod ? { entryExecutionMethod: 'entry-first-v2' as const } : {}),
      entryEvidenceMethod: 'public-support-v2', sources: [...initialSources, ...recoveredSources], rawArtifacts,
      queries: ['exact token origin', 'exact token account', 'named comparison'], complete: false,
      codes: ['ATT_FETCH_URL_ERROR'], start: '2026-10-19T12:00:00.000Z', end: cutoff,
      discoveryUrls: [originUrl], comparisonSourceIds: [], comparisonComplete: false,
      comparisonAcquisition: { originalComplete: false, searchSucceeded: true, descriptorComplete: true, leadCount: 1, leads: [{
        id: 'lead-1', searchArtifactId: 'attention-search-3', resultIndex: 0, url: leadUrl,
        title: 'River Lantern market', snippet: 'Indexed market record.', metadataEvidenceId: 'lead-1-metadata',
        sourceIds: [], acquisitionStatus: 'FAILED', acquisitionCodes: ['ATT_LEAD_FAILED'],
        recoveryQueryIds: ['attention-recovery-search-1'], recoverySourceIds: [],
      }] },
      comparisonQualification: { recoveryCapped: false, recoveryQueries: [{
        queryId: 'attention-recovery-search-1', parentLeadId: 'lead-1', query,
        state: 'OBSERVED', descriptorComplete: true, resultCount: search.results.length, availableAt: cutoff,
      }] },
      ...(fallbackSelectionMethod ? { comparisonRecovery: {
        method: 'comparison-acquisition-v1' as const, fallbackSelectionMethod, selectedLeadIds: ['lead-1'],
        recoveryQueries: [{
          queryId: 'attention-recovery-search-1', parentLeadId: 'lead-1', query,
          state: 'OBSERVED', descriptorComplete: true, resultCount: search.results.length, availableAt: cutoff,
        }],
        recoveryCapped: false, sourceLineage: [],
      } } : {}),
    };
  };

  const omitted = await collectRecovery([selectedUrl], [
    { results: [], errors: [] }, { results: [], errors: [] },
  ]);
  assert.deepEqual(omitted.requested, [[selectedUrl], [selectedUrl]], 'an omitted selected URL receives one bounded retry');
  assert.ok(omitted.recovery.rawArtifacts['attention-fetch-1']);
  assert.ok(omitted.recovery.rawArtifacts['attention-fetch-1-retry-1']);
  const omittedRead = makeRead(omitted.recovery);
  const omittedScope = entryEvidenceScope(omittedRead, token, cutoff);
  assert.equal(omittedScope.complete, false, JSON.stringify(omittedScope));
  assert.ok(omittedScope.blockers.includes('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE'));
  assert.throws(() => resolvePublicEntryDecision({}, omittedRead, token, cutoff), /ATT_MODEL_ENTRY_SCOPE_INCOMPLETE/,
    'a selected omission cannot produce a binary public-entry decision');
  const entryProgram = binaryEntryDecisionProgram(omittedRead, {}, {}, token, cutoff, {});
  assert.deepEqual(entryProgram.next(), { value: null, done: true }, 'incomplete acquisition yields no entry grade');

  const missingSelection = structuredClone(omittedRead);
  delete missingSelection.rawArtifacts['attention-recovery-selection-scope'];
  const missingSelectionScope = entryEvidenceScope(missingSelection, token, cutoff);
  assert.ok(missingSelectionScope.blockers.includes('ATT_ENTRY_RECOVERY_SELECTION_MISSING'));
  assert.ok(missingSelectionScope.blockers.includes('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE'));

  const editedSelection = structuredClone(omittedRead);
  editedSelection.rawArtifacts['attention-recovery-selection-scope'] = JSON.stringify({
    method: 'fair-parent-query-v1', maxUrls: 0, selectedUrls: [], selection: [],
  });
  const editedSelectionScope = entryEvidenceScope(editedSelection, token, cutoff);
  assert.ok(editedSelectionScope.blockers.includes('ATT_ENTRY_RECOVERY_SELECTION_INVALID'));
  assert.ok(editedSelectionScope.blockers.includes('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE'));

  const retry = await collectRecovery([selectedUrl], [
    { results: [], errors: [{ url: selectedUrl, status: 429, error: 'HTTP 429 rate limit' }] },
    { results: [{ url: selectedUrl, final_url: selectedUrl, text: selectedText }], errors: [] },
  ]);
  const retryRead = makeRead(retry.recovery);
  const retryScope = entryEvidenceScope(retryRead, token, cutoff);
  assert.equal(retryScope.complete, true, JSON.stringify(retryScope));
  assert.equal(retryScope.gaps.some(gap => gap.url === selectedUrl), false,
    'a validated full-body retry replaces its original transient error');

  const selectedSuccess = await collectRecovery([selectedUrl], [
    { results: [{ url: selectedUrl, final_url: selectedUrl, text: selectedText }], errors: [] },
  ]);
  const movedSuccessRead = makeRead(selectedSuccess.recovery);
  const movedSuccessPacket = movedSuccessRead.rawArtifacts['attention-recovery-fetch-1']!;
  movedSuccessRead.rawArtifacts['attention-recovery-fetch-1'] = JSON.stringify({ results: [], errors: [] });
  movedSuccessRead.rawArtifacts['attention-recovery-fetch-99'] = movedSuccessPacket;
  const movedSuccessScope = entryEvidenceScope(movedSuccessRead, token, cutoff);
  assert.ok(movedSuccessRead.sources.some(source => source.url === selectedUrl),
    'the moved-body case keeps the actual retained source intact');
  assert.ok(movedSuccessRead.rawArtifacts['attention-recovery-selection-scope'],
    'the moved-body case keeps the canonical selection receipt intact');
  assert.equal(movedSuccessScope.complete, false, JSON.stringify(movedSuccessScope));
  assert.ok(movedSuccessScope.blockers.includes('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE'));
  assert.ok(movedSuccessScope.blockers.includes('ATT_ENTRY_RECOVERY_SELECTION_INVALID'),
    'a full body moved out of its owning batch cannot satisfy the selected URL');

  const terminal = await collectRecovery([selectedUrl], [
    { results: [], errors: [{ url: selectedUrl, status: 404, error: 'not_found' }] },
  ]);
  const terminalScope = entryEvidenceScope(makeRead(terminal.recovery), token, cutoff);
  assert.equal(terminalScope.complete, true, JSON.stringify(terminalScope));
  assert.ok(terminalScope.gaps.some(gap => gap.url === selectedUrl && gap.code === 'TARGET_BLOCKED'),
    'an explicit terminal response for the selected alternate remains an eligible documented gap');

  const movedTerminalRead = makeRead(terminal.recovery);
  const movedTerminalPacket = JSON.parse(movedTerminalRead.rawArtifacts['attention-recovery-fetch-1']!) as {
    results: unknown[]; errors: unknown[];
  };
  movedTerminalRead.rawArtifacts['attention-recovery-fetch-1'] = JSON.stringify({ results: [], errors: [] });
  movedTerminalRead.rawArtifacts['attention-recovery-fetch-99'] = JSON.stringify(movedTerminalPacket);
  const movedTerminalScope = entryEvidenceScope(movedTerminalRead, token, cutoff);
  assert.equal(movedTerminalScope.complete, false, JSON.stringify(movedTerminalScope));
  assert.ok(movedTerminalScope.blockers.includes('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE'));
  assert.equal(movedTerminalScope.gaps.some(gap => gap.url === selectedUrl && gap.code === 'TARGET_BLOCKED'), false,
    'a terminal error moved outside its owning batch cannot make an omission gradable');

  const fullInitialSources: AttentionRead['sources'] = Array.from({ length: 31 }, (_, index) => index === 0 ? origin : ({
    id: `attention-page-${index + 1}`, url: `https://public.example/initial-${index + 1}`,
    text: `Retained initial source ${index + 1}.`, publishedAt: null, authorId: null, availableAt: cutoff, kind: 'PAGE' as const,
  }));
  const twoRound = await collectRecovery([selectedUrl, sameHostAlternateUrl, differentHostAlternateUrl, nextPageUrl], [
    { results: [], errors: [{ url: selectedUrl, status: 404, error: 'not_found' }] },
    { results: [], errors: [{ url: differentHostAlternateUrl, status: 404, error: 'not_found' }] },
    { results: [{ url: sameHostAlternateUrl, final_url: sameHostAlternateUrl, text: selectedText }], errors: [] },
  ], fullInitialSources);
  assert.deepEqual(twoRound.requested, [[selectedUrl], [differentHostAlternateUrl], [sameHostAlternateUrl]],
    'each additional Fetch round tries the next same-parent result and prefers a different host');
  const twoRoundRead = makeRead(twoRound.recovery, fullInitialSources);
  const twoRoundScope = entryEvidenceScope(twoRoundRead, token, cutoff);
  assert.equal(twoRoundScope.complete, true, JSON.stringify(twoRoundScope));
  assert.equal(twoRoundRead.sources.length, 32, 'alternate recovery keeps retained pages at the 32-source cap');
  assert.deepEqual(twoRoundScope.gaps.filter(gap => gap.code === 'RECOVERED_ALTERNATE').map(gap => gap.url).sort(),
    [selectedUrl, differentHostAlternateUrl].sort(), 'an acquired second-round page resolves both earlier omissions while retaining their gaps');
  const fallbackReceipt = JSON.parse(twoRoundRead.rawArtifacts['attention-recovery-fallback-scope']!) as {
    rounds: Array<{ batch: number; selections: Array<{ failedUrl: string; parentId: string; url: string }> }>;
  };
  assert.deepEqual(fallbackReceipt.rounds.map(round => round.batch), [2, 3]);
  assert.deepEqual(fallbackReceipt.rounds.map(round => round.selections[0]?.url), [differentHostAlternateUrl, sameHostAlternateUrl]);

  const missingFallback = structuredClone(twoRoundRead);
  delete missingFallback.rawArtifacts['attention-recovery-fallback-scope'];
  const missingFallbackScope = entryEvidenceScope(missingFallback, token, cutoff);
  assert.equal(missingFallbackScope.complete, false, JSON.stringify(missingFallbackScope));
  assert.ok(missingFallbackScope.blockers.some(code => /ATT_ENTRY_RECOVERY_SELECTION_(?:MISSING|INVALID)/.test(code)),
    'removing the fallback receipt cannot hide available same-parent alternates');

  const editedFallback = structuredClone(twoRoundRead);
  const editedReceipt = JSON.parse(editedFallback.rawArtifacts['attention-recovery-fallback-scope']!) as typeof fallbackReceipt;
  editedReceipt.rounds[0]!.selections[0]!.parentId = 'another-lead';
  editedFallback.rawArtifacts['attention-recovery-fallback-scope'] = JSON.stringify(editedReceipt);
  const editedFallbackScope = entryEvidenceScope(editedFallback, token, cutoff);
  assert.equal(editedFallbackScope.complete, false, JSON.stringify(editedFallbackScope));
  assert.ok(editedFallbackScope.blockers.includes('ATT_ENTRY_RECOVERY_SELECTION_INVALID'),
    'a forged replacement parent cannot be reconciled as the selected lead’s alternate');

  const exhausted = await collectRecovery([selectedUrl, sameHostAlternateUrl, differentHostAlternateUrl, nextPageUrl], [
    { results: [], errors: [{ url: selectedUrl, status: 404, error: 'not_found' }] },
    { results: [], errors: [{ url: differentHostAlternateUrl, status: 404, error: 'not_found' }] },
    { results: [], errors: [{ url: sameHostAlternateUrl, status: 404, error: 'not_found' }] },
  ], fullInitialSources);
  const exhaustedScope = entryEvidenceScope(makeRead(exhausted.recovery, fullInitialSources), token, cutoff);
  assert.equal(exhausted.requested.some(batch => batch.includes(nextPageUrl)), false,
    'the collector stops after the two bounded alternate Fetch rounds');
  assert.equal(exhaustedScope.complete, true, JSON.stringify(exhaustedScope));
  assert.ok([selectedUrl, differentHostAlternateUrl, sameHostAlternateUrl].every(url => exhaustedScope.gaps.some(gap => gap.url === url && gap.code === 'TARGET_BLOCKED')),
    'exhausted explicit permanent blocks remain reviewable gaps');

  const ownParentFallback = comparisonRecoveryFallback([{ parentId: 'lead-1', url: selectedUrl }], [
    { searchArtifactId: 'attention-search-1', resultIndex: 1, url: sameHostAlternateUrl },
    { searchArtifactId: 'attention-search-1', resultIndex: 2, url: nextPageUrl },
    { searchArtifactId: 'attention-search-2', resultIndex: 0, url: wrongParentUrl },
  ], [{ leadId: 'lead-1', originalUrl: leadUrl }, { leadId: 'lead-2', originalUrl: null }],
  [leadUrl, selectedUrl, sameHostAlternateUrl], new Set());
  assert.deepEqual(ownParentFallback, [{ failedUrl: selectedUrl, parentId: 'lead-1', url: nextPageUrl }],
    'fallback skips already tried URLs and never borrows a result owned by another lead');

  const blockedFirst = 'https://blocked.example/stack-overflow';
  const unknownPdf = 'https://papers.example/market-scan.pdf';
  const observedInitial = 'https://www.working.example/initial-page';
  const workingAlternate = 'https://working.example/lower-ranked-alternate';
  const previouslyTriedWorkingUrl = 'https://working.example/already-requested';
  const crossParentWorkingUrl = 'https://working.example/other-parent';
  const rankedCandidates = [
    { searchArtifactId: 'attention-search-1', resultIndex: 0, url: 'https://blocked.example/retry-the-blocked-host' },
    { searchArtifactId: 'attention-search-1', resultIndex: 1, url: unknownPdf },
    { searchArtifactId: 'attention-search-1', resultIndex: 2, url: workingAlternate },
    { searchArtifactId: 'attention-search-1', resultIndex: 3, url: previouslyTriedWorkingUrl },
    { searchArtifactId: 'attention-search-2', resultIndex: 0, url: crossParentWorkingUrl },
  ];
  const observedPolicy = { method: 'observed-hosts-v1' as const, priorSelections: [] };
  const observedFallback = comparisonRecoveryFallback([{ parentId: 'lead-1', url: blockedFirst }], rankedCandidates,
    [{ leadId: 'lead-1', originalUrl: leadUrl }, { leadId: 'lead-2', originalUrl: null }],
    [leadUrl, blockedFirst, previouslyTriedWorkingUrl], new Set([observedInitial]), observedPolicy);
  assert.deepEqual(observedFallback, [{ failedUrl: blockedFirst, parentId: 'lead-1', url: workingAlternate }],
    'a validated body from this recovery makes its host outrank the lower-ranked unknown PDF and failed host; tried and cross-parent URLs stay ineligible');
  const legacyFallback = comparisonRecoveryFallback([{ parentId: 'lead-1', url: blockedFirst }], rankedCandidates,
    [{ leadId: 'lead-1', originalUrl: leadUrl }, { leadId: 'lead-2', originalUrl: null }],
    [leadUrl, blockedFirst, previouslyTriedWorkingUrl], new Set([observedInitial]));
  assert.deepEqual(legacyFallback, [{ failedUrl: blockedFirst, parentId: 'lead-1', url: unknownPdf }],
    'without the opt-in policy the legacy immediate-host/result-rank order is preserved');

  const chainA = 'https://host-a.example/first-block';
  const chainB = 'https://host-b.example/second-unreachable';
  const chainC = 'https://host-c.example/untried';
  const ancestryFallback = comparisonRecoveryFallback([{ parentId: 'lead-1', url: chainB }], [
    { searchArtifactId: 'attention-search-1', resultIndex: 0, url: 'https://host-a.example/retry-old-host' },
    { searchArtifactId: 'attention-search-1', resultIndex: 1, url: chainC },
    { searchArtifactId: 'attention-search-1', resultIndex: 2, url: 'https://host-b.example/retry-current-host' },
  ], [{ leadId: 'lead-1', originalUrl: leadUrl }], [leadUrl, chainA, chainB], new Set(), {
    method: 'observed-hosts-v1', priorSelections: [{ failedUrl: chainA, parentId: 'lead-1', url: chainB }],
  });
  assert.deepEqual(ancestryFallback, [{ failedUrl: chainB, parentId: 'lead-1', url: chainC }],
    'with no observed working host, a new host outranks both the earlier failed ancestry and immediate failed host');

  const tiedQueryOrdinal = comparisonRecoveryFallback([{ parentId: 'lead-1', url: blockedFirst }], [
    { searchArtifactId: 'attention-search-1', resultIndex: 0, url: 'https://tie-a.example/first-query' },
    { searchArtifactId: 'attention-search-2', resultIndex: 0, url: 'https://tie-b.example/second-query' },
  ], [{ leadId: 'lead-1', originalUrl: leadUrl }, { leadId: 'lead-1', originalUrl: leadUrl }],
  [leadUrl, blockedFirst], new Set(), observedPolicy);
  assert.deepEqual(tiedQueryOrdinal, [{ failedUrl: blockedFirst, parentId: 'lead-1', url: 'https://tie-a.example/first-query' }],
    'query ordinal provides the final stable tie-break for same-parent candidates');

  const knownHostBlocked = 'https://blocked.example/first-attempt';
  const knownHostInitial = 'https://working.example/acquired-in-initial-recovery-batch';
  const knownHostBatch = [knownHostBlocked, knownHostInitial,
    ...Array.from({ length: 6 }, (_, index) => `https://initial-${index + 1}.example/page`)];
  const knownHostFirstAlternate = 'https://working.example/first-alternate';
  const knownHostSecondAlternate = 'https://working.example/second-alternate';
  const knownHostBlockedRepeat = 'https://blocked.example/retry-earlier-host';
  const temptingUnknownPdf = 'https://papers.example/unread-market-scan.pdf';
  const knownHostSequence = await collectRecovery([
    ...knownHostBatch, knownHostFirstAlternate, knownHostBlockedRepeat, temptingUnknownPdf, knownHostSecondAlternate,
  ], [
    { results: knownHostBatch.slice(1).map(url => ({ url, final_url: url, text: `Validated body for ${url}.` })),
      errors: [{ url: knownHostBlocked, status: 403, error: 'bot_blocked' }] },
    { results: [], errors: [{ url: knownHostFirstAlternate, error: 'target_unreachable' }] },
    { results: [{ url: knownHostSecondAlternate, final_url: knownHostSecondAlternate,
      text: `Validated body for ${knownHostSecondAlternate}.` }], errors: [] },
  ], [origin], 'observed-hosts-v1');
  assert.deepEqual(knownHostSequence.requested, [knownHostBatch, [knownHostFirstAlternate], [knownHostSecondAlternate]],
    'the actual producer uses a host with a validated body in the initial recovery batch, then selects a different same-parent URL after target_unreachable');
  assert.equal(knownHostSequence.searchCalls, 1, 'both fallback rounds reuse the one recovery Search response');
  const knownHostReceipt = JSON.parse(knownHostSequence.recovery.rawArtifacts['attention-fallback-scope']!) as {
    method: string; rounds: Array<{ batch: number; selections: Array<{ failedUrl: string; parentId: string; url: string }> }>;
  };
  assert.equal(knownHostReceipt.method, 'same-parent-alternates-v2');
  assert.deepEqual(knownHostReceipt.rounds.map(round => round.selections[0]), [
    { failedUrl: knownHostBlocked, parentId: 'lead-1', url: knownHostFirstAlternate },
    { failedUrl: knownHostFirstAlternate, parentId: 'lead-1', url: knownHostSecondAlternate },
  ]);
  const knownHostRead = makeRead(knownHostSequence.recovery, [origin], 'observed-hosts-v1');
  const knownHostScope = entryEvidenceScope(knownHostRead, token, cutoff);
  assert.equal(knownHostScope.complete, true, JSON.stringify(knownHostScope));
  assert.equal(knownHostScope.fallbackSelectionMethod, 'observed-hosts-v1');
  assert.deepEqual(knownHostScope.gaps.filter(gap => gap.code === 'RECOVERED_ALTERNATE').map(gap => gap.url).sort(),
    [knownHostBlocked, knownHostFirstAlternate].sort(), 'the exact body in the second fallback batch resolves both earlier failures');
  assert.ok(JSON.parse(knownHostRead.rawArtifacts['attention-recovery-fetch-2']!).errors
    .some((error: { url: string; error: string }) => error.url === knownHostFirstAlternate && error.error === 'target_unreachable'),
  'the recovered path retains the first fallback error in its owning raw batch');
  assert.equal(knownHostScope.gaps.some(gap => gap.url === knownHostFirstAlternate && gap.code === 'TARGET_BLOCKED'), false,
    'target_unreachable remains an unresolved acquisition error unless the later selected body is acquired');

  const ancestryA = 'https://ancestry-a.example/blocked';
  const ancestryB = 'https://ancestry-b.example/unreachable';
  const ancestryC = 'https://ancestry-c.example/untried';
  const staleCatalogPage: AttentionRead['sources'][number] = {
    id: 'attention-page-stale-catalog', url: 'https://ancestry-c.example/catalog-page',
    text: 'An older catalog body exists on the eventual alternate host.', publishedAt: null, authorId: null,
    availableAt: cutoff, kind: 'PAGE',
  };
  const ancestryInitialBatch = [ancestryA,
    ...Array.from({ length: 7 }, (_, index) => `https://unrelated-${index + 1}.example/retained-page`)];
  const ancestrySequence = await collectRecovery([
    ...ancestryInitialBatch, ancestryB, ancestryC, 'https://ancestry-a.example/retry', 'https://ancestry-b.example/retry',
  ], [
    { results: ancestryInitialBatch.slice(1).map(url => ({ url, final_url: url, text: `Validated body for ${url}.` })),
      errors: [{ url: ancestryA, status: 403, error: 'bot_blocked' }] },
    { results: [], errors: [{ url: ancestryB, error: 'target_unreachable' }] },
    { results: [{ url: ancestryC, final_url: ancestryC, text: `Fresh body for ${ancestryC}.` }], errors: [] },
  ], [origin, staleCatalogPage], 'observed-hosts-v1');
  assert.deepEqual(ancestrySequence.requested, [ancestryInitialBatch, [ancestryB], [ancestryC]],
    'without a recovery-owned working host, actual production prefers the untried C after A is blocked and B is unreachable');
  assert.equal(ancestrySequence.searchCalls, 1);
  const ancestryRead = makeRead(ancestrySequence.recovery, [origin, staleCatalogPage], 'observed-hosts-v1');
  const ancestryScope = entryEvidenceScope(ancestryRead, token, cutoff);
  assert.equal(ancestryScope.complete, true, JSON.stringify(ancestryScope));
  assert.deepEqual(ancestryScope.gaps.filter(gap => gap.code === 'RECOVERED_ALTERNATE').map(gap => gap.url).sort(),
    [ancestryA, ancestryB].sort());
  assert.equal(ancestryScope.gaps.some(gap => gap.url === ancestryB && gap.code === 'TARGET_BLOCKED'), false);
  assert.ok(JSON.parse(ancestryRead.rawArtifacts['attention-fetch-1']!).results
    .some((result: { url: string }) => result.url === staleCatalogPage.url),
  'the adversarial fixture really contains a pre-existing catalog body on C’s host');

  const incompleteKnownHost = await collectRecovery([
    ...knownHostBatch, knownHostFirstAlternate, knownHostBlockedRepeat, temptingUnknownPdf, knownHostSecondAlternate,
  ], [
    { results: knownHostBatch.slice(1).map(url => ({ url, final_url: url, text: `Validated body for ${url}.` })),
      errors: [{ url: knownHostBlocked, status: 403, error: 'bot_blocked' }] },
    { results: [], errors: [{ url: knownHostFirstAlternate, error: 'target_unreachable' }] },
    { results: [], errors: [{ url: knownHostSecondAlternate, error: 'target_unreachable' }] },
  ], [origin], 'observed-hosts-v1');
  const incompleteKnownHostRead = makeRead(incompleteKnownHost.recovery, [origin], 'observed-hosts-v1');
  const incompleteKnownHostScope = entryEvidenceScope(incompleteKnownHostRead, token, cutoff);
  assert.equal(incompleteKnownHostScope.complete, false, JSON.stringify(incompleteKnownHostScope));
  assert.ok(incompleteKnownHostScope.blockers.includes('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE'));
  assert.equal(incompleteKnownHostScope.gaps.some(gap => [knownHostFirstAlternate, knownHostSecondAlternate].includes(gap.url)
    && gap.code === 'TARGET_BLOCKED'), false, 'target_unreachable cannot become a terminal block or a reviewable negative gap');
  const incompleteProgram = binaryEntryDecisionProgram(incompleteKnownHostRead, {}, {}, token, cutoff, {});
  assert.deepEqual(incompleteProgram.next(), { value: null, done: true },
    'missing the selected alternate’s own body leaves the public-entry decision unavailable');

  const bounded = await collectRecovery([selectedUrl, unselectedUrl], [
    { results: [{ url: selectedUrl, final_url: selectedUrl, text: selectedText }], errors: [] },
  ], fullInitialSources);
  assert.deepEqual(bounded.requested, [[selectedUrl]], 'only the selected URL is fetched when one recovery slot remains');
  assert.ok(bounded.recovery.codes.includes('ATT_PAGE_CAP'), 'the fixture has an actual unselected search hit');
  const boundedRead = makeRead(bounded.recovery, fullInitialSources);
  const boundedScope = entryEvidenceScope(boundedRead, token, cutoff);
  assert.equal(boundedScope.complete, true, JSON.stringify(boundedScope));
  const boundedReceipt = JSON.parse(boundedRead.rawArtifacts['attention-recovery-selection-scope']!) as {
    maxUrls: number; selectedUrls: string[]; selection: Array<{ url: string; selected: boolean }>;
  };
  assert.equal(boundedReceipt.maxUrls, 1);
  assert.deepEqual(boundedReceipt.selectedUrls, [selectedUrl]);
  assert.equal(boundedReceipt.selection.find(item => item.url === unselectedUrl)?.selected, false,
    'unselected bounded hits do not become required Fetch outcomes');
});

test('safe discovery seeds lead the fetch queue and only approved one-level links are followed', async () => {
  const seedProfile = 'https://x.com/community';
  const seedWebsite = 'https://official.example/';
  const seedThree = 'https://public.example/seed-three';
  const seedFour = 'https://public.example/seed-four';
  const ignoredSeed = 'https://public.example/seed-five';
  const searchPage = 'https://public.example/search-page';
  const searchPost = 'https://x.com/search_author/status/501';
  const sameAccountOne = 'https://x.com/community/status/601';
  const sameAccountTwo = 'https://x.com/community/status/602';
  const sameHostWhitepaper = 'https://official.example/whitepaper/overview';
  const sameHostAbout = 'https://official.example/about';
  const ignoredLinks = [
    'https://x.com/other_account/status/603',
    'https://official.example/careers',
    'https://elsewhere.example/docs/guide',
    'https://public.example/not-a-seed-child',
  ];
  const discoveryUrls = [seedProfile, seedWebsite, seedThree, seedFour, ignoredSeed, 'http://127.0.0.1/private'];
  const searchUrls = [searchPage, searchPost];
  const allExpected = [...discoveryUrls.slice(0, 4), ...searchUrls, sameAccountOne, sameAccountTwo, sameHostWhitepaper, sameHostAbout];
  const fetchBatches: string[][] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) return search(searchUrls);
    const body = JSON.parse(String(init.body)) as { urls: string[]; links?: boolean };
    assert.equal(body.links, true, 'Fetch must return links for the bounded seed-only expansion');
    fetchBatches.push(body.urls);
    return json({ results: body.urls.map(requestedUrl => {
      const base = { url: requestedUrl, final_url: requestedUrl, text: `Mint ${token.address}. Public source for ${requestedUrl}.` };
      const links = requestedUrl === seedProfile
        ? [sameAccountOne, ignoredLinks[0]!, sameAccountTwo, ...ignoredLinks.slice(1)]
        : requestedUrl === seedWebsite
          ? [sameHostWhitepaper, sameHostAbout, ...ignoredLinks.slice(1)]
          : requestedUrl === searchPage ? [ignoredLinks[3]!] : [];
      const isPost = /\/status\/\d+$/.test(requestedUrl);
      return { ...base, ...(isPost ? { published_date: '2026-10-01T10:00:00Z' } : {}), ...(links.length ? { links } : {}) };
    }), errors: [] });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', undefined, discoveryUrls);
  assert.deepEqual(read.discoveryUrls, [seedProfile, seedWebsite, seedThree, seedFour], 'only the first four safe unique seeds are retained');
  assert.equal(read.queries.length, 2);
  assert.match(read.queries[0] ?? '', /site:x\.com\/community/);
  assert.match(read.queries[0] ?? '', /site:official\.example/);
  assert.deepEqual(fetchBatches[0], [...read.discoveryUrls, ...searchUrls], 'DEX seeds precede the bounded search results');
  assert.deepEqual(fetchBatches[1], [sameAccountOne, sameAccountTwo, sameHostWhitepaper, sameHostAbout]);
  assert.deepEqual(fetchBatches.flat(), allExpected);
  assert.equal(fetchBatches.flat().includes(ignoredSeed), false);
  for (const ignored of ignoredLinks) assert.equal(fetchBatches.flat().includes(ignored), false, `${ignored} must be ignored`);
  assert.equal(read.sources.find(source => source.url === sameAccountOne)?.discoveredFrom, seedProfile);
  assert.equal(read.sources.find(source => source.url === sameHostWhitepaper)?.discoveredFrom, seedWebsite);
  assert.equal(read.sources.find(source => source.url === searchPage)?.discoveredFrom, undefined, 'search-result links do not trigger crawling');
  assert.equal(read.postSampleComplete, true);
  assert.equal(read.complete, true);
  assert.equal(fetchBatches.flat().length, 10);
  assert.ok(fetchBatches.flat().length <= 20);
});

test('fresh Pump coin context skips shared platform docs without starving indexed and project posts', async () => {
  const pumpCoin = `https://pump.fun/coin/${token.address}`;
  const projectHome = 'https://river-lantern.example/';
  const projectDocs = 'https://river-lantern.example/docs/token-contract';
  const projectProfile = 'https://x.com/river_lantern';
  const ownPosts = ['https://x.com/river_lantern/status/9101', 'https://x.com/river_lantern/status/9102'];
  const indexedPosts = Array.from({ length: 24 }, (_, index) => `https://x.com/writer${index % 4}/status/${9200 + index}`);
  const globalDocs = Array.from({ length: 20 }, (_, index) => `https://pump.fun/docs/platform-${index + 1}`);
  const globalLegal = ['https://pump.fun/terms', 'https://pump.fun/privacy'];
  const linkedGlobalPages = [...globalLegal, globalDocs[0]!, globalDocs[1]!, ...globalDocs.slice(2)];
  const discoveryUrls = [pumpCoin, projectHome, projectProfile];

  const collect = async (fresh: boolean) => {
    const fetched: string[] = [];
    let searchIndex = 0;
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) {
        const page = searchIndex++;
        return search((page === 0 ? indexedPosts.slice(0, 12) : indexedPosts.slice(12)));
      }
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      fetched.push(...requested);
      return json({ results: requested.map(requestedUrl => {
        const links = requestedUrl === pumpCoin ? linkedGlobalPages
          : requestedUrl === projectHome ? [projectDocs]
            : requestedUrl === projectProfile ? ownPosts : [];
        const isPost = /\/status\/\d+$/.test(requestedUrl);
        return { ...fetchResult(requestedUrl, `River Lantern source names ${token.address} and describes its project context.`, isPost ? '2026-10-01T10:00:00Z' : undefined), ...(links.length ? { links } : {}) };
      }), errors: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', undefined,
      discoveryUrls, undefined, fresh ? 'public-support-v2' : undefined);
    return { read, fetched };
  };

  assert.deepEqual(originSeedLinks(pumpCoin, [globalDocs[0]!]), [globalDocs[0]], 'the markerless helper preserves historical behavior');
  assert.deepEqual(originSeedLinks(pumpCoin, [globalDocs[0]!], 'project-context-v2'), [], 'the fresh helper excludes shared Pump navigation');

  const fresh = await collect(true);
  assert.equal(fresh.read.collectionMethod, 'project-context-v2');
  assert.equal(fresh.read.sources.length, 30, 'three seeds, one project docs page, two own posts, and twenty-four indexed posts fit');
  assert.deepEqual(fresh.read.codes, []);
  assert.equal(fresh.read.postSampleComplete, true);
  assert.equal(fresh.read.sources.some(source => source.url === projectDocs), true, 'ordinary project documentation remains eligible');
  assert.ok(ownPosts.every(url => fresh.read.sources.some(source => source.url === url)), 'the profile’s own original posts are retained');
  assert.ok(indexedPosts.every(url => fresh.read.sources.some(source => source.url === url)), 'indexed post coverage survives shared-platform link expansion');
  assert.equal(fresh.fetched.some(url => linkedGlobalPages.includes(url)), false, 'global legal and platform docs never enter the fresh Fetch queue');
  const pumpReceipt = Object.values(fresh.read.rawArtifacts).map(raw => JSON.parse(raw) as { results?: Array<{ url: string; links?: string[] }> })
    .flatMap(packet => packet.results ?? []).find(result => result.url === pumpCoin);
  assert.deepEqual(pumpReceipt?.links, linkedGlobalPages, 'the original provider receipt remains available for audit');

  const legacy = await collect(false);
  assert.equal(legacy.read.collectionMethod, undefined, 'the legacy route keeps the method marker absent');
  assert.ok(legacy.read.codes.includes('ATT_PAGE_CAP'), 'markerless Pump docs retain their historical shared-page-cap effect');
  assert.ok(legacy.read.sources.some(source => globalDocs.includes(source.url)), 'markerless collection still follows an eligible Pump docs link');
});

test('project-context-v2 keeps its 40-page initial budget and leaves eight recovery slots within 64 sources', async () => {
  const pumpCoin = `https://pump.fun/coin/${token.address}`;
  const projectHome = 'https://river-lantern.example/';
  const projectProfile = 'https://x.com/river_lantern';
  const projectAnnouncement = 'https://river-lantern.example/announcements';
  const projectDocs = Array.from({ length: 6 }, (_, index) => `https://river-lantern.example/docs/project-context-${index + 1}`);
  const globalPumpPages = [
    'https://pump.fun/terms', 'https://pump.fun/privacy',
    ...Array.from({ length: 20 }, (_, index) => `https://pump.fun/docs/platform-${index + 1}`),
  ];
  const indexedPosts = [
    ...Array.from({ length: 10 }, (_, index) => `https://x.com/writer_a/status/${9400 + index}`),
    ...Array.from({ length: 10 }, (_, index) => `https://x.com/writer_b/status/${9500 + index}`),
  ];
  const comparisonPages = Array.from({ length: 10 }, (_, index) => `https://independent.example/market-record-${index + 1}`);
  const queryResults = [indexedPosts.slice(0, 10), indexedPosts.slice(10), comparisonPages];
  const fetched: string[] = [];
  let searchIndex = 0;
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const rows = queryResults[searchIndex++] ?? [];
      return json({ results: rows.map((item, index) => ({ url: item, title: `River Lantern public source ${index + 1}`, snippet: `A retained independent source mentions ${token.address}.` })), errors: [] });
    }
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    fetched.push(...requested);
    return json({ results: requested.map(requestedUrl => {
      const links = requestedUrl === pumpCoin ? globalPumpPages : requestedUrl === projectHome ? projectDocs : [];
      const isPost = /\/status\/\d+$/.test(requestedUrl);
      return {
        ...fetchResult(requestedUrl, `River Lantern original public source ${token.address} ${requestedUrl}.`, isPost ? '2026-10-01T10:00:00Z' : undefined),
        ...(links.length ? { links } : {}),
      };
    }), errors: [] });
  });
  const seeds = [pumpCoin, projectHome, projectProfile, projectAnnouncement];
  const initial = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern',
    seeds, undefined, 'public-support-v2');

  assert.equal(initial.collectionMethod, 'project-context-v2');
  assert.equal(attentionInitialPageLimit(initial), 40);
  assert.equal(attentionSourceLimit(initial), 64);
  assert.equal(initial.sources.length, 40);
  assert.equal(initial.codes.includes('ATT_PAGE_CAP'), false);
  assert.ok(projectDocs.every(url => initial.sources.some(source => source.url === url)),
    'ordinary project documentation uses the added initial slots');
  assert.ok(indexedPosts.every(url => initial.sources.some(source => source.url === url)),
    'both complete indexed post pages survive project-context collection');
  assert.ok(comparisonPages.every(url => initial.sources.some(source => source.url === url)));
  assert.equal(fetched.some(url => globalPumpPages.includes(url)), false,
    'Pump global legal/navigation links do not consume project identity capacity');

  const parent = initial.comparisonAcquisition!.leads[0]!;
  assert.ok(parent.url);
  const recoveryPages = Array.from({ length: 8 }, (_, index) => `https://recovery.example/market-alternate-${index + 1}`);
  const recoveryFetched: string[][] = [];
  const recoveryMock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) return json({
      results: recoveryPages.map((item, index) => ({ url: item, title: `Independent alternate ${index + 1}`, snippet: 'A separate indexed market source.' })),
      errors: [],
    });
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    recoveryFetched.push(requested);
    return json({ results: requested.map(item => fetchResult(item, `Independent alternate evidence for ${token.address}.`)), errors: [] });
  });
  const recoveryLimit = Math.min(8, attentionSourceLimit(initial) - initial.sources.length);
  const recovery = await recoverComparisonSources(token, KEY, ['Find independent alternate sources for the indexed market record'],
    [...initial.sources.map(source => source.url), parent.url], recoveryLimit, recoveryMock.fetcher,
    () => '2026-10-01T12:00:00.000Z', [{ leadId: parent.id, originalUrl: parent.url }], true, 'public-support-v2');
  const merged = { ...initial, sources: [...initial.sources, ...recovery.sources.map(source => ({
    ...source, id: source.id.replace(/^attention-/, 'attention-recovery-'),
  }))] };

  assert.equal(recoveryLimit, 8);
  assert.deepEqual(recoveryFetched, [recoveryPages]);
  assert.equal(recovery.sources.length, 8);
  assert.equal(merged.sources.length, 48);
  assert.equal(merged.sources.length <= attentionSourceLimit(merged), true);
  assert.equal(attentionSubmittedSources(merged).length, 48,
    'the submitted source catalog retains all eight newly acquired pages');
});

test('IPFS recovery accepts only a whole JSON fence whose bytes match the immutable CID', () => {
  const sourceText = JSON.stringify({ name: 'River Lantern', symbol: 'LANTERN', mint: token.address, description: 'A neighborhood project.' });
  const cidFor = (text: string) => {
    const multihash = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), createHash('sha256').update(text).digest()]);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = 0, value = 0, encoded = '';
    for (const byte of multihash) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) { bits -= 5; encoded += alphabet[(value >> bits) & 31]; }
    }
    if (bits) encoded += alphabet[(value << (5 - bits)) & 31];
    return `b${encoded}`;
  };
  const cid = cidFor(sourceText);
  const originUrl = `https://ipfs.io/ipfs/${cid}`;
  const gatewayUrl = `https://gateway.pinata.cloud/ipfs/${cid}`;
  const fenced = `\x60\x60\x60json\r\n${sourceText}\r\n\x60\x60\x60`;
  const alias = { method: 'raw-cid-sha256-v1' as const, originUrl, sourceId: 'recovered-ipfs-json', responseId: 'attention-origin-fetch-1', resultIndex: 0 };
  const source = { id: alias.sourceId, url: gatewayUrl, text: sourceText, kind: 'PAGE' as const,
    publishedAt: null, authorId: null, availableAt: '2026-10-01T12:00:00.000Z' };
  const receipt = (text: string, url = gatewayUrl) => ({ [alias.responseId]: JSON.stringify({ results: [{ url, final_url: url, text }], errors: [] }) });
  const scope = (rawArtifacts: Record<string, string>) => originSourceScope({
    sources: [source], rawArtifacts: {
      'attention-search-1': JSON.stringify({ results: [{ url: originUrl }], errors: [] }),
      'attention-search-2': JSON.stringify({ results: [{ url: originUrl }], errors: [] }),
      ...rawArtifacts,
    }, queries: [`"${token.address}" origin`, `"${token.address}" project`], complete: false, codes: [],
    start: '2026-10-01T00:00:00.000Z', end: '2026-10-01T12:00:00.000Z', discoveryUrls: [originUrl],
    originRecovery: { aliases: [alias], comparisonSupplementIds: [] },
  } as AttentionRead, token);

  assert.equal(verifyOriginAlias(alias, [source], receipt(fenced)), source,
    'the complete JSON body may be unwrapped from a whole response fence after its SHA-256 CID matches');
  assert.equal(scope(receipt(fenced)).complete, true,
    'the verified canonical body is accepted when reconstructing the original public-source scope');
  assert.equal(verifyOriginAlias(alias, [source], receipt(`\x60\x60\x60json\n${sourceText.replace('River Lantern', 'Other project')}\n\x60\x60\x60`)), null,
    'changed JSON bytes do not qualify under the original CID');
  const wrongCidUrl = `https://ipfs.io/ipfs/${cidFor(sourceText.replace('River Lantern', 'Other project'))}`;
  const wrongCidAlias = { ...alias, originUrl: wrongCidUrl };
  const wrongGateway = `https://gateway.pinata.cloud/ipfs/${wrongCidUrl.split('/').at(-1)}`;
  assert.equal(verifyOriginAlias(wrongCidAlias, [{ ...source, url: wrongGateway }], receipt(fenced, wrongGateway)), null,
    'a CID for other JSON bytes cannot authenticate the retained response');
  assert.equal(verifyOriginAlias(alias, [source], receipt(`Provider commentary\n${fenced}`)), null,
    'only the complete standalone JSON fence is eligible for normalization; surrounding prose remains part of the hash input');
  assert.equal(scope(receipt(`Provider commentary\n${fenced}`)).complete, false,
    'source-scope reconstruction rejects a prose-wrapped body instead of treating it as the original document');
});

test('five eligible project posts linked from an original profile complete the origin ledger within the shared page cap', async () => {
  const profile = 'https://x.com/river_lantern';
  const linkedPosts = Array.from({ length: 5 }, (_, index) => `https://x.com/river_lantern/status/${810 + index}`);
  const fetched: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) return search([]);
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    fetched.push(...requested);
    return json({
      results: requested.map(requestedUrl => ({
        ...fetchResult(requestedUrl, `River Lantern's original project update names ${token.address} and explains its token-bound mechanism.`, '2026-10-01T10:00:00Z'),
        ...(requestedUrl === profile ? { links: linkedPosts } : {}),
      })),
      errors: [],
    });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', undefined, [profile]);
  const scope = originSourceScope(read, token);
  const originalFetches = Object.entries(read.rawArtifacts)
    .filter(([id]) => /^attention-fetch-\d+$/.test(id))
    .map(([, raw]) => JSON.parse(raw) as { results: Array<{ url: string; links?: string[] }>; errors: unknown[] });

  assert.deepEqual(fetched, [profile, ...linkedPosts], 'all five original posts are fetched after the profile seed');
  assert.equal(read.sources.length, 6);
  assert.equal(read.sources.filter(source => source.kind === 'POST').length, 5);
  assert.equal(read.sources.length < 32, true, 'all required original pages fit within the shared page cap');
  assert.equal(read.complete, true);
  assert.deepEqual(read.codes, [], 'successful collection does not carry an outage or omission code');
  assert.deepEqual(Object.keys(read.rawArtifacts).sort(), ['attention-fetch-1', 'attention-fetch-2', 'attention-search-1', 'attention-search-2']);
  assert.deepEqual(originalFetches.flatMap(response => response.results.map(source => source.url)), [profile, ...linkedPosts]);
  assert.deepEqual(originalFetches[0]?.results[0]?.links, linkedPosts, 'the fetched profile link list remains in the original raw receipt');
  assert.ok(originalFetches.every(response => response.errors.length === 0), 'both retained Fetch receipts show successful acquisition');
  assert.equal(scope.complete, true);
  assert.equal(scope.acquisition.complete, true);
  assert.equal(scope.acquisition.urls.length, 6);
  assert.ok(scope.acquisition.urls.every(item => item.state === 'ACQUIRED'));
  assert.deepEqual(scope.sourceIds, read.sources.map(source => source.id));
});

test('a metadata JSON seed follows safe public links within the shared page cap and retains parent lineage', async () => {
  const seed = 'https://metadata.example/token.json';
  const linked = [
    'https://narrative.example/one',
    'https://project.example/two',
    'https://images.example/hero.png',
    'http://127.0.0.1/private',
    'https://narrative.example/three',
    'https://narrative.example/four',
    'https://narrative.example/five',
  ];
  const nested = 'https://elsewhere.example/deeper.json';
  let fetched: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) return search([]);
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    fetched.push(...requested);
    return json({ results: requested.map(requestedUrl => fetchResult(requestedUrl,
      requestedUrl === seed ? JSON.stringify({ mint: token.address, references: linked }) : `A linked public reference. ${nested}`)), errors: [] });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', undefined, [seed]);

  const retainedChildren = [linked[0]!, linked[1]!, linked[4]!, linked[5]!, linked[6]!];
  assert.deepEqual(fetched, [seed, ...retainedChildren], 'every safe non-image link is fetched while it fits the shared 32-source cap');
  assert.equal(read.sources.length, 6);
  for (const url of retainedChildren) assert.equal(read.sources.find(source => source.url === url)?.discoveredFrom, seed);
  assert.equal(read.sources.some(source => source.url === nested), false, 'a child JSON page cannot trigger a second hop');
  assert.equal(read.sources.some(source => source.url === linked[2]), false, 'image links are not narrative sources');
  assert.equal(read.sources.some(source => source.url === linked[3]), false, 'private and non-HTTPS targets are rejected');
});

test('a direct status seed is retained as a POST but cannot expand into other posts', async () => {
  const statusSeed = 'https://twitter.com/community/status/701';
  const linkedStatus = 'https://x.com/community/status/702';
  const requested: string[][] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) return search([]);
    const body = JSON.parse(String(init.body)) as { urls: string[]; links?: boolean };
    requested.push(body.urls);
    assert.equal(body.links, true);
    return json({ results: body.urls.map(requestedUrl => ({
      ...fetchResult(requestedUrl, `Token ${token.address}. Neighbors share this project update.`, '2026-10-01T10:00:00Z'),
      links: [linkedStatus],
    })), errors: [] });
  });
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', undefined, [statusSeed]);

  assert.deepEqual(read.discoveryUrls, ['https://x.com/community/status/701']);
  assert.deepEqual(requested, [['https://x.com/community/status/701']]);
  assert.equal(read.sources.length, 1);
  assert.equal(read.sources[0]?.kind, 'POST');
  assert.equal(read.sources[0]?.discoveredFrom, undefined);
  assert.equal(read.postSampleComplete, true);
  assert.equal(read.complete, true);
});

test('a POST hidden behind the thirty-two-source cap leaves the declared post sample incomplete', async () => {
  const pages = Array.from({ length: 32 }, (_, index) => `https://public.example/page-${index + 1}`);
  const omittedPost = 'https://x.com/community/status/900/photo/1';
  const urls = [...pages, omittedPost];
  const outgoing: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) return search(urls);
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    outgoing.push(...requested);
    return json({ results: requested.map(item => fetchResult(item, 'A public retained source.')), errors: [] });
  });
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
  assert.equal(outgoing.length, 32);
  assert.equal(outgoing.some(url => url.includes('/status/900')), false);
  assert.equal(read.sources.some(source => source.kind === 'POST'), false);
  assert.equal(read.postSampleComplete, false);
  assert.ok(read.codes.includes('ATT_PAGE_CAP'));
});

test('X photo URLs canonicalize before fetch and deduplicate across Twitter aliases', async () => {
  const first = 'https://twitter.com/Community_Author/status/901/photo/1';
  const second = 'https://www.x.com/community_author/status/901/photo/2';
  const third = 'https://x.com/COMMUNITY_AUTHOR/status/901';
  const requested: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) return search([first, second, third]);
    const urls = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    requested.push(...urls);
    assert.deepEqual(urls, ['https://x.com/community_author/status/901']);
    return json({ results: [{
      url: urls[0], final_url: 'https://twitter.com/Community_Author/status/901/photo/1',
      text: 'A substantive original post.', published_date: '2026-10-01T10:00:00Z',
    }], errors: [] });
  });
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
  assert.deepEqual(requested, ['https://x.com/community_author/status/901']);
  assert.equal(read.sources.length, 1);
  assert.equal(read.sources[0]?.url, 'https://x.com/community_author/status/901');
  assert.equal(read.sources[0]?.authorId, 'x.com:community_author');
  assert.equal(read.sources[0]?.kind, 'POST');
  assert.equal(read.postSampleComplete, true);
  assert.equal(read.complete, true);
});

test('missing and redirected POST fetches invalidate only declared post-sample completeness', async t => {
  const requestedPost = 'https://x.com/community/status/902';
  await t.test('an omitted selected post', async () => {
    const mock = mockFetch(url => url.includes('api.search.tinyfish.ai') ? search([requestedPost])
      : json({ results: [], errors: [{ url: requestedPost, error: 'timeout' }] }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
    assert.equal(read.postSampleComplete, false);
    assert.ok(read.codes.includes('ATT_FETCH_INCOMPLETE'));
  });
  await t.test('redirect to a different status ID', async () => {
    const mock = mockFetch(url => url.includes('api.search.tinyfish.ai') ? search([requestedPost])
      : json({ results: [{ url: requestedPost, final_url: 'https://x.com/community/status/999', text: 'Redirected post.' }], errors: [] }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
    assert.equal(read.sources.length, 0);
    assert.equal(read.postSampleComplete, false);
    assert.ok(read.codes.includes('ATT_FETCH_BINDING'));
  });
});

test('terminal deleted-post scope requires a retained full body and treats only definitive 404/410 as gaps', async t => {
  const retained = 'https://x.com/community/status/903';
  const missing = 'https://x.com/community/status/904';
  const retainedText = `A complete original post about ${token.address} and the project.`;
  const collect = async (urls: string[], mode: '404' | '410' | '403' | '503' | 'missing' | 'full' | 'cap' | 'clipped') => {
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) return json({ results: urls.map(item => ({ url: item })), errors: [] });
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      if (mode === 'full' || mode === 'cap') return json({ results: requested.map(item => fetchResult(item, retainedText)), errors: [] });
      const results = requested.filter(item => item === retained).map(item => fetchResult(item,
        mode === 'clipped' ? `${retainedText}${'x'.repeat(120_001)}` : retainedText));
      if (mode === 'missing') return json({ results: [], errors: [] });
      const status = mode === '404' || mode === 'clipped' ? 404 : mode === '410' ? 410 : mode === '403' ? 403 : 503;
      const error = mode === '404' || mode === 'clipped' ? 'not_found' : mode === '410' ? 'not_found' : mode === '403' ? 'forbidden' : 'timeout';
      return json({ results, errors: requested.filter(item => item !== retained).map(item => ({ url: item, status, error })) });
    });
    return collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', undefined, [], undefined, 'public-support-v2');
  };

  for (const [status, code] of [['404', 'HTTP_404'], ['410', 'HTTP_410']] as const) await t.test(`HTTP ${status} is a terminal gap after full retained-body acquisition`, async () => {
    const read = await collect([retained, missing], status);
    assert.equal(read.postSampleScope?.complete, true, JSON.stringify(read.postSampleScope));
    assert.deepEqual(read.postSampleScope?.sourceIds, [read.sources[0]?.id]);
    assert.deepEqual(read.postSampleScope?.gaps, [{ url: missing, code }]);
    assert.deepEqual(read.postSampleScope?.blockers, []);
    assert.equal(read.postSampleComplete, false, 'the factual post sample remains incomplete despite its terminal gap classification');
  });

  for (const status of ['403', '503', 'missing'] as const) await t.test(`${status} remains unresolved`, async () => {
    const read = await collect([retained, missing], status);
    assert.equal(read.postSampleScope?.complete, false, JSON.stringify(read.postSampleScope));
    assert.deepEqual(read.postSampleScope?.gaps, []);
    assert.ok(read.postSampleScope?.blockers.includes('ATT_POST_SCOPE_UNRESOLVED'));
  });

  await t.test('full bodies without a deleted-post gap do not create a negative-only scope', async () => {
    const read = await collect([retained, 'https://x.com/community/status/905'], 'full');
    assert.equal(read.postSampleScope?.complete, false);
    assert.deepEqual(read.postSampleScope?.gaps, []);
    assert.deepEqual(read.postSampleScope?.blockers, []);
  });

  await t.test('a source cap cannot be treated as a terminal-gap scope', async () => {
    const urls = Array.from({ length: 41 }, (_, index) => `https://x.com/community/status/${1000 + index}`);
    const read = await collect(urls, 'cap');
    assert.ok(read.codes.includes('ATT_PAGE_CAP'));
    assert.equal(read.postSampleScope?.complete, false);
    assert.ok(read.postSampleScope?.blockers.includes('ATT_POST_SCOPE_LIMIT_OR_BINDING'));
    assert.ok(read.postSampleScope?.blockers.includes('ATT_POST_SCOPE_UNRESOLVED'));
  });

  await t.test('a clipped post body cannot count as retained evidence', async () => {
    const read = await collect([retained, missing], 'clipped');
    assert.ok(read.codes.includes('ATT_TEXT_CAP'));
    assert.equal(read.postSampleScope?.complete, false);
    assert.deepEqual(read.postSampleScope?.gaps, [{ url: missing, code: 'HTTP_404' }]);
  });

  await t.test('a later matching full-body retry overrides an earlier 404', async () => {
    const read = await collect([retained, missing], '404');
    const retainedSource = read.sources[0]!;
    const recoveredSource = { ...retainedSource, id: 'recovered-post', url: missing };
    read.sources.push(recoveredSource);
    read.postSampleSourceIds = [retainedSource.id, recoveredSource.id];
    read.rawArtifacts['attention-fetch-1-retry-1'] = JSON.stringify({
      results: [fetchResult(missing, retainedText)], errors: [],
    });

    const scope = terminalPostScope(read);
    assert.equal(scope.complete, false, 'complete negative-only scope still requires at least one remaining terminal gap');
    assert.deepEqual(scope.gaps, []);
    assert.deepEqual(scope.blockers, [], JSON.stringify({ scope, sources: read.sources.map(source => ({ id: source.id, url: source.url, kind: source.kind })), postSampleSourceIds: read.postSampleSourceIds }));
  });
});

test('partial fetch errors retain returned sources and mark missing source coverage incomplete', async () => {
  const first = 'https://public.example/first';
  const second = 'https://public.example/second';
  const mock = mockFetch(url => url.includes('api.search.tinyfish.ai')
    ? search([first, second])
    : json({ results: [fetchResult(first, 'First retained page')], errors: [{ url: second, error: 'timeout' }] }));
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');

  assert.equal(read.sources.length, 1);
  assert.equal(read.sources[0]?.url, first);
  assert.equal(read.sources[0]?.text, 'First retained page');
  assert.equal(read.complete, false);
  assert.equal(read.postSampleComplete, true, 'a failed PAGE fetch leaves the selected POST scope intact');
  assert.ok(read.codes.includes('ATT_FETCH_URL_ERROR'));
  assert.ok(read.codes.includes('ATT_FETCH_INCOMPLETE'));
  assert.ok(read.rawArtifacts['attention-fetch-1']);
});

test('collector retries only transient missing comparison URLs once and retains both provider attempts', async t => {
  const recovered = 'https://public.example/recovered';
  const stable = 'https://public.example/stable';
  const failed = 'https://public.example/failed';

  await t.test('a timeout retries only the missing URL and restores comparison completeness', async () => {
    let fetchAttempt = 0;
    const textByUrl = new Map([
      [stable, `Stable comparison source names ${token.address}.`],
      [recovered, `Recovered comparison source names ${token.address}.`],
    ]);
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) {
        const query = new URL(url).searchParams.get('query') ?? '';
        return search(query.includes('"River Lantern"') ? [stable, recovered] : []);
      }
      fetchAttempt++;
      const body = JSON.parse(String(init.body)) as { urls: string[]; per_url_timeout_ms: number };
      if (fetchAttempt === 1) {
        assert.deepEqual(body.urls, [stable, recovered]);
        assert.equal(body.per_url_timeout_ms, 8000);
        return json({ results: [fetchResult(stable, textByUrl.get(stable)!)], errors: [{ url: recovered, error: 'timeout' }] });
      }
      assert.deepEqual(body.urls, [recovered], 'the recovery request contains only the transiently missing URL');
      assert.equal(body.per_url_timeout_ms, 15000);
      return json({ results: [fetchResult(recovered, textByUrl.get(recovered)!)], errors: [] });
    });

    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
    const fetchCalls = mock.calls.filter(call => call.url.includes('api.fetch.tinyfish.ai'));
    assert.equal(fetchCalls.length, 2);
    assert.equal(read.complete, true);
    assert.equal(read.comparisonComplete, true);
    assert.deepEqual(read.sources.map(source => source.url), [stable, recovered]);
    assert.deepEqual(read.sources.map(source => source.text), [textByUrl.get(stable), textByUrl.get(recovered)]);
    assert.ok(read.rawArtifacts['attention-fetch-1']?.includes('timeout'));
    assert.ok(read.rawArtifacts['attention-fetch-1-retry-1']?.includes(recovered));
    assert.equal(read.codes.includes('ATT_FETCH_URL_ERROR'), false);
    assert.equal(read.codes.includes('ATT_FETCH_INCOMPLETE'), false);
  });

  await t.test('a repeated timeout remains incomplete after the one retry', async () => {
    let fetchAttempt = 0;
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) {
        const query = new URL(url).searchParams.get('query') ?? '';
        return search(query.includes('"River Lantern"') ? [failed] : []);
      }
      fetchAttempt++;
      assert.deepEqual((JSON.parse(String(init.body)) as { urls: string[] }).urls, [failed]);
      return json({ results: [], errors: [{ url: failed, error: 'timeout' }] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
    assert.equal(fetchAttempt, 2);
    assert.equal(read.sources.length, 0);
    assert.equal(read.comparisonComplete, false);
    assert.ok(read.codes.includes('ATT_FETCH_URL_ERROR'));
    assert.ok(read.codes.includes('ATT_FETCH_INCOMPLETE'));
    assert.ok(read.rawArtifacts['attention-fetch-1-retry-1']);
  });

  await t.test('a permanent 404 is not retried', async () => {
    let fetchAttempt = 0;
    const mock = mockFetch((url, _init) => {
      if (url.includes('api.search.tinyfish.ai')) {
        const query = new URL(url).searchParams.get('query') ?? '';
        return search(query.includes('"River Lantern"') ? [failed] : []);
      }
      fetchAttempt++;
      return json({ results: [], errors: [{ url: failed, status: 404, error: 'not_found' }] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
    assert.equal(fetchAttempt, 1);
    assert.equal(read.comparisonComplete, false);
    assert.ok(read.codes.includes('ATT_FETCH_URL_ERROR'));
    assert.ok(read.codes.includes('ATT_FETCH_INCOMPLETE'));
    assert.equal(read.rawArtifacts['attention-fetch-1-retry-1'], undefined);
  });
});

test('public-support scope uses successful Fetch retries and keeps unresolved timeout or rate-limit failures unknown', async t => {
  const originUrl = 'https://public.example/river-lantern-origin';
  const comparisonUrl = 'https://index.example/river-lantern-market';
  const originText = `River Lantern token ${token.address} is listed on its project page.`;
  const comparisonText = `The River Lantern market record lists ${token.address} and pair data.`;
  const cutoff = '2026-10-19T18:30:00.000Z';

  for (const scenario of [
    { name: 'successful retry after HTTP 429', initial: { status: 429, error: 'HTTP 429 rate limit' }, retry: 'success' as const },
    { name: 'unresolved HTTP 429 retry', initial: { status: 429, error: 'HTTP 429 rate limit' }, retry: '429' as const },
    { name: 'unresolved timeout retry', initial: { error: 'timeout' }, retry: 'timeout' as const },
  ]) {
    await t.test(scenario.name, async () => {
      let fetchAttempt = 0;
      const mock = mockFetch((url, init) => {
        if (url.includes('api.search.tinyfish.ai')) {
          const query = new URL(url).searchParams.get('query') ?? '';
          return search(query.includes('River Lantern') ? [comparisonUrl] : [originUrl]);
        }
        fetchAttempt++;
        const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
        if (fetchAttempt === 1) {
          assert.deepEqual(requested, [originUrl, comparisonUrl]);
          return json({ results: [fetchResult(originUrl, originText)], errors: [{ url: comparisonUrl, ...scenario.initial }] });
        }
        assert.deepEqual(requested, [comparisonUrl], 'the retry fetches only the unresolved URL');
        if (scenario.retry === 'success') return json({ results: [fetchResult(comparisonUrl, comparisonText)], errors: [] });
        return json({ results: [], errors: [{ url: comparisonUrl, ...(scenario.retry === '429'
          ? { status: 429, error: 'HTTP 429 rate limit' } : { error: 'timeout' }) }] });
      });

      const read = await collectAttentionSources(token, KEY, mock.fetcher, () => cutoff, 'River Lantern', [], undefined, 'public-support-v2');
      const scope = entryEvidenceScope(read, token, cutoff);
      assert.equal(fetchAttempt, 2);
      assert.ok(read.rawArtifacts['attention-fetch-1']?.includes(scenario.initial.error));
      assert.ok(read.rawArtifacts['attention-fetch-1-retry-1']);
      if (scenario.retry === 'success') {
        assert.equal(read.complete, true);
        assert.equal(read.codes.includes('ATT_FETCH_URL_ERROR'), false);
        assert.equal(scope.complete, true, JSON.stringify(scope));
        assert.deepEqual(read.sources.map(source => source.text), [originText, comparisonText]);
      } else {
        assert.equal(read.complete, false);
        assert.equal(scope.complete, false, JSON.stringify(scope));
        assert.deepEqual(scope.gaps, [], 'transient fetch errors are never reported as target blocks');
      }
    });
  }

  await t.test('a silently omitted alternate can be reconciled from its completed recovery Search receipt', async () => {
    const alternateUrl = 'https://archive.example/river-lantern-token-record';
    const alternateText = `The River Lantern token record identifies ${token.address} and its launch.`;
    let fetchAttempt = 0;
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) {
        const query = new URL(url).searchParams.get('query') ?? '';
        return search(query.includes('River Lantern') ? [comparisonUrl] : [originUrl]);
      }
      fetchAttempt++;
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      if (fetchAttempt === 1) {
        assert.deepEqual(requested, [alternateUrl, originUrl, comparisonUrl]);
        return json({ results: [fetchResult(originUrl, originText), fetchResult(comparisonUrl, comparisonText)], errors: [] });
      }
      assert.deepEqual(requested, [alternateUrl], 'only the silently omitted URL is retried');
      return json({ results: [fetchResult(alternateUrl, alternateText)], errors: [] });
    });

    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => cutoff, 'River Lantern', [alternateUrl], undefined, 'public-support-v2');
    const initial = JSON.parse(read.rawArtifacts['attention-fetch-1']!) as { results: Array<{ url: string }>; errors: unknown[] };
    const retry = JSON.parse(read.rawArtifacts['attention-fetch-1-retry-1']!) as { results: Array<{ url: string; text: string }>; errors: unknown[] };
    assert.equal(fetchAttempt, 2);
    assert.deepEqual(initial.errors, [], 'the original response has no error entry for the omitted URL');
    assert.equal(initial.results.some(result => result.url === alternateUrl), false);
    assert.deepEqual(retry.results, [fetchResult(alternateUrl, alternateText)]);

    // The production recovery merge stores this successful Search response under
    // its recovery receipt ID; the URL must be justified by that receipt alone.
    read.rawArtifacts['attention-recovery-search-1'] = JSON.stringify({ results: [{ url: alternateUrl }], errors: [] });
    read.discoveryUrls = [];
    const scope = entryEvidenceScope(read, token, cutoff);
    assert.equal(read.sources.some(source => source.url === alternateUrl && source.text === alternateText), true);
    assert.equal(scope.complete, true, JSON.stringify(scope));
    assert.equal(scope.blockers.length, 0, JSON.stringify(scope));
  });
});

test('a genuinely empty bounded search leaves qualified attention unknown without hosted calls', async () => {
  const mock = mockFetch(url => {
    assert.ok(url.includes('api.search.tinyfish.ai'));
    return search([]);
  });
  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');

  assert.equal(read.complete, true);
  assert.deepEqual(read.sources, []);
  assert.deepEqual(read.codes, []);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls.some(call => call.url.includes('api.fetch.tinyfish.ai')), false);

  const qualification = await qualifyAttention(read, token, KEY, mock.fetcher);
  assert.deepEqual(qualification.proposal, { claims: [], posts: [], competitors: [] });
  assert.deepEqual(qualification.review, {
    decisions: [],
    candidateSet: { complete: false, rationale: 'No observed sources establish a discovered representation set.' },
    originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No observed sources establish a primary-origin relationship.' },
  });
  assert.equal(mock.calls.some(call => !call.url.includes('api.search.tinyfish.ai')), false, 'empty corpus must not call Fetch or Gemini');

  const rows = deriveAttention({ ...read, sources: qualification.sources ?? read.sources }, qualification.proposal, qualification.review, token, '2026-10-01T12:00:00.000Z', []);
  for (const id of ['A15', 'A16', 'A17']) {
    const row = rows.find(item => item.id === id);
    assert.equal(row?.quality, 'MISSING', id);
    assert.equal(row?.projection?.value, null, id);
    assert.equal(row?.causes[0]?.code, 'ATT_POST_CORPUS_UNAVAILABLE', id);
  }
  const features = new Map(completeFixtureEntryFeatures().map(item => [item.id, item]));
  for (const row of rows) if (row.projection) features.set(row.id, row.projection);
  const result = evaluateEntry([...features.values()], illustrativeUncalibratedProfile, '2026-10-01T12:00:00.000Z', 'QUALIFIED');
  assert.equal(result.checks.find(check => check.checkId === 'ATT-01')?.status, 'UNKNOWN');
});

test('comparison scope stays complete when unrelated origin search and fetch entries fail', async () => {
  const origin = 'https://public.example/origin';
  const common = 'https://x.com/river_lantern/status/777';
  let searchIndex = 0;
  const mock = mockFetch((url, _init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const current = searchIndex++;
      if (current === 0) return search([origin]);
      if (current === 1) return new Response('search unavailable', { status: 403 });
      return search([common]);
    }
    return json({ results: [fetchResult(common, `The community shares ${token.address} stories.`)], errors: [{ url: origin, error: 'timeout' }] });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
  const commonSource = read.sources.find(source => source.url === common);

  assert.equal(read.complete, false, 'unrelated acquisition errors remain visible on the overall read');
  assert.equal(read.postSampleComplete, false, 'failed mint query remains visible on the selected post sample');
  assert.equal(read.comparisonComplete, true, 'the common-name scope is judged independently');
  assert.ok(commonSource);
  assert.deepEqual(read.comparisonSourceIds, [commonSource.id]);
});

test('collector to complete comparison batches derives the rival beyond the prefix with exact retained citation', async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const rival = '0x2222222222222222222222222222222222222222';
  const postUrl = 'https://x.com/river_lantern/status/779';
  const targetLead = `The River Lantern neighborhood-art project represents exact contract ${target.address}.`;
  const rivalTail = ` Rival contract ${rival}.`;
  const longText = targetLead
    + 'x'.repeat(6100 - targetLead.length)
    + rivalTail
    + 'z'.repeat(6166 - 6100 - rivalTail.length);
  assert.equal(longText.length, 6166);
  assert.ok(longText.indexOf(rival) > 6100);

  const packets: Array<Record<string, unknown>> = [];
  const modelResponse = (value: unknown) => json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const query = new URL(url).searchParams.get('query') ?? '';
      return query.includes('"River Lantern"')
        ? json({ results: [{ url: postUrl, title: 'River Lantern exact-contract source', snippet: `The project page names ${target.address}.` }] })
        : search([]);
    }
    if (url.includes('api.fetch.tinyfish.ai')) {
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      return json({ results: requested.map(item => fetchResult(item, longText, '2026-10-01T10:00:00Z')), errors: [] });
    }
    const body = JSON.parse(String(init.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
    const packet = JSON.parse(body.contents[0]!.parts[0]!.text) as Record<string, unknown>;
    packets.push(packet);
    const sources = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
    const requiredPostIds = packet.requiredPostSourceIds as string[] | undefined;
    const scope = packet.scope as { batch?: number } | undefined;
    const sourceSpan = (sourceId: string, exactAddress: string) => {
      const source = sources.find(item => item.id === sourceId);
      assert.ok(source, `packet omitted retained source ${sourceId}`);
      const span = source.spans.find(item => item.text.includes(exactAddress));
      assert.ok(span, `no submitted span contains ${exactAddress}`);
      return span.id;
    };
    if (packet.manifest) {
      const requiredDecisionIds = packet.requiredDecisionIds as string[];
      return modelResponse({ decisions: Object.fromEntries(requiredDecisionIds.map(id => [id, { accepted: true, rationale: 'The merged exact-contract candidate matches the complete retained comparison evidence.' }])),
        candidateSet: { complete: true, rationale: 'All supported representations in every full-text batch are included.' } });
    }
    if (typeof scope?.batch === 'number' && packet.proposal) {
      const requiredDecisionIds = packet.requiredDecisionIds as string[];
      return modelResponse({ decisions: Object.fromEntries(requiredDecisionIds.map(id => [id, { accepted: true, rationale: 'The exact source span supports this full-text batch item.' }])),
        candidateSet: { complete: true, rationale: 'Every relevant exact-contract representation in the full-text batch is accounted for.' },
        ...comparisonReviewFields(packet) });
    }
    if ((packet.scope as { mode?: string } | undefined)?.mode === 'qualified-identified-leads-v1') {
      if (packet.proposal) {
        const proposed = packet.proposal as { decisions: Record<string, unknown> };
        return modelResponse({ decisions: Object.fromEntries(Object.keys(proposed.decisions).map(id => [id, {
          accepted: true, rationale: 'The independent review confirms the disposition from its exact indexed and fetched source spans.',
        }])) });
      }
      const leads = packet.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[] }>;
      return modelResponse({ decisions: Object.fromEntries(leads.map(lead => {
        const sourceId = lead.sourceIds[0];
        const source = sources.find(item => item.id === sourceId);
        assert.ok(source, `the acquired lead ${lead.id} retains its fetched source`);
        const targetSpan = source.spans.find(span => span.text.includes(target.address));
        assert.ok(targetSpan, `the fetched source for ${lead.id} binds the target contract`);
        return [lead.id, {
          disposition: 'ACQUIRED', rationale: 'The fetched source is consistent with this indexed River Lantern exact-contract lead.',
          descriptorRefs: [{ sourceId: lead.metadataEvidenceId, spanId: indexedSpanId(packet, lead.metadataEvidenceId) }],
          corroboratingRefs: [{ sourceId, spanId: targetSpan.id }], token: null,
        }];
      })) });
    }
    if (typeof scope?.batch === 'number') {
      const source = sources.find(item => item.spans.some(span => span.text.includes(target.address)));
      assert.ok(source, 'the full-text batch contains the target representation');
      return modelResponse({
        competitors: [
          { id: 'target-fulltext', observationId: comparisonObservationId(packet, target, source.id) },
          { id: 'rival-tail', observationId: comparisonObservationId(packet, { chain: 'base', address: rival }, source.id) },
        ],
        posts: Object.fromEntries((requiredPostIds ?? []).map(id => [id, { spanId: sourceSpan(id, target.address), role: 'NEWS' }])),
      });
    }
    if (packet.proposal) {
      const requiredDecisionIds = packet.requiredDecisionIds as string[];
      return json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
        decisions: Object.fromEntries(requiredDecisionIds.map(id => [id, { accepted: true, rationale: 'The supplied text supports this bounded synthetic review.' }])) ,
        candidateSet: { complete: false, rationale: 'The prefix alone cannot establish every representation in the retained source text.' },
        originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No primary project relationship is established in this source.' },
      }) }] } }] });
    }
    const targetSource = sources.find(item => item.spans.some(span => span.text.includes(target.address)));
    assert.ok(targetSource, 'the base packet retains its named target source');
    return json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
      claims: [{ id: 'claim-topic', feature: 'A01', value: true,
        summary: 'The source connects River Lantern with its neighborhood-art project narrative.',
        citations: [{ sourceId: targetSource.id, spanId: sourceSpan(targetSource.id, target.address) }] }],
      posts: Object.fromEntries((requiredPostIds ?? []).map(id => [id, { spanId: sourceSpan(id, target.address), role: 'CALL' }])),
      competitors: [],
    }) }] } }] });
  });

  const read = await collectAttentionSources(target, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
  assert.equal(read.complete, true);
  assert.equal(read.comparisonComplete, true, 'the collector retained the complete 6166-character provider result');
  assert.equal(read.sources[0]?.text.length, 6166);
  assert.deepEqual(read.comparisonSourceIds, [read.sources[0]?.id]);

  const qualification = await qualifyAttention(read, target, KEY, mock.fetcher);
  const qualifiedRead = { ...qualification.scope, sources: qualification.sources ?? qualification.scope.sources };
  assert.equal(qualification.code, undefined);
  assert.equal(qualification.review?.candidateSet?.complete, true,
    JSON.stringify({
      scopeCodes: qualification.scope.codes,
      leadQualification: qualification.rawArtifacts['comparison-lead-qualification'],
      batchReview: qualification.rawArtifacts['attention-comparison-1-review-response'],
      finalReview: qualification.rawArtifacts['attention-comparison-final-review-response'],
    }));
  assert.equal(qualification.scope.comparisonComplete, true);
  assert.equal(qualification.scope.codes.includes('ATT_MODEL_COMPARISON_TEXT_CAP'), false);
  assert.equal(qualification.sources?.[0]?.text.length, longText.length);
  assert.equal(packets.length, 7, 'fresh comparison leads receive proposal and independent review before full-text batches');
  assert.equal((packets[0]!.scope as { comparisonDeferred?: boolean }).comparisonDeferred, true);
  const baseProposalResponse = JSON.parse(qualification.rawArtifacts['attention-proposal-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  assert.deepEqual((JSON.parse(baseProposalResponse.candidates[0]!.content.parts[0]!.text) as { competitors: unknown[] }).competitors, [], 'the bounded base pass defers competitor extraction to the full-text batch');
  assert.equal((packets[0]!.sources as Array<{ spans: Array<{ text: string }> }>)[0]!.spans.map(item => item.text).join('').length, 6000);
  const batchProposal = packets.find(packet => (packet.scope as { batch?: number } | undefined)?.batch === 1 && !packet.proposal)!;
  const fullModelText = (batchProposal.sources as Array<{ spans: Array<{ text: string }> }>)[0]!.spans.map(item => item.text).join('');
  assert.equal(fullModelText, longText);
  assert.ok(fullModelText.includes(rival), 'the tail contract is submitted to complete-text comparison');
  const rivalCandidate = qualification.proposal?.competitors.find(candidate => candidate.token.address === rival);
  assert.ok(rivalCandidate?.quote.includes(rival));
  assert.ok(rivalCandidate && longText.includes(rivalCandidate.quote), 'the returned competitor citation exactly matches retained tail text');
  assert.ok(qualification.rawArtifacts['attention-comparison-manifest']);

  const rows = new Map(deriveAttention(qualifiedRead, qualification.proposal, qualification.review, target, read.end, ['scope', 'model']).map(row => [row.id, row]));
  assert.equal(rows.get('A09')?.quality, 'KNOWN');
  assert.equal((rows.get('A09')?.data as { candidates: Array<{ token: { address: string }; quote: string }> }).candidates.some(candidate => candidate.token.address === rival), true);
  assert.equal(rows.get('A11')?.quality, 'MISSING', 'one sampled post is still too little evidence to rank representation leadership');
  assert.equal(rows.get('A11')?.causes[0]?.code, 'ATT_COMPARABLE_SAMPLE_INSUFFICIENT');
  const routes = rows.get('A14')?.data as { originRelationship: { status: string }; measuredAttention: { status: string } };
  assert.equal(routes.originRelationship.status, 'UNKNOWN');
  assert.equal(routes.measuredAttention.status, 'UNKNOWN');
});

test('comparison is incomplete when the common-name result is displaced by the thirty-two page cap', async () => {
  const crowded = Array.from({ length: 32 }, (_, index) => `https://public.example/origin-${index + 1}`);
  const common = 'https://public.example/common-result';
  let searchIndex = 0;
  const fetched: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const current = searchIndex++;
      return search(current === 0 ? crowded : current === 2 ? [common] : []);
    }
    const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    fetched.push(...requested);
    return json({ results: requested.map(item => fetchResult(item, 'A public source page.')), errors: [] });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');

  assert.equal(fetched.length, 32);
  assert.equal(fetched.includes(common), false);
  assert.equal(read.comparisonSourceIds?.length, 0);
  assert.equal(read.comparisonComplete, false);
  assert.ok(read.codes.includes('ATT_PAGE_CAP'));
});

test('a discovery follow-up cannot displace a common-name result without marking its scope incomplete', async () => {
  const seed = 'https://x.com/community';
  const seeds = [seed, 'https://public.example/seed-2', 'https://public.example/seed-3', 'https://public.example/seed-4'];
  const origin = Array.from({ length: 27 }, (_, index) => `https://public.example/origin-${index + 1}`);
  const common = 'https://public.example/common-result';
  const followed = 'https://x.com/community/status/333';
  let searchIndex = 0;
  const requested: string[] = [];
  const mock = mockFetch((url, init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      const current = searchIndex++;
      return search(current === 0 ? origin : current === 2 ? [common] : []);
    }
    const batch = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
    requested.push(...batch);
    return json({ results: batch.map(item => ({
      ...fetchResult(item, 'A public source page.'),
      ...(item === seed ? { links: [followed] } : {}),
    })), errors: [] });
  });

  const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern', seeds);

  assert.equal(requested.includes(followed), true);
  assert.equal(requested.includes(common), false, 'the global cap evicts the common result after the follow-up is inserted');
  assert.equal(read.comparisonComplete, false);
  assert.ok(read.codes.includes('ATT_PAGE_CAP'));
});

test('comparison completeness requires a named successful nonempty common result and bound fetch', async t => {
  await t.test('no name means no comparison scope', async () => {
    const mock = mockFetch(url => url.includes('api.search.tinyfish.ai')
      ? search(['https://public.example/page'])
      : json({ results: [fetchResult('https://public.example/page', 'Public page')], errors: [] }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
    assert.equal(read.comparisonComplete, false);
  });

  await t.test('an empty crypto-qualified query uses the broader result as its selected comparison sample', async () => {
    let searchIndex = 0;
    const mock = mockFetch(url => url.includes('api.search.tinyfish.ai')
      ? search(searchIndex++ === 2 ? [] : ['https://public.example/origin'])
      : json({ results: [fetchResult('https://public.example/origin', 'Origin page')], errors: [] }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
    assert.equal(searchIndex, 4, 'the successful empty primary is followed by one broader search');
    assert.equal(read.queries[2], '"River Lantern" solana');
    assert.equal(read.rawArtifacts['attention-search-3-primary-query'], '"River Lantern" solana crypto token contract');
    assert.equal(read.rawArtifacts['attention-search-3-empty-response'], JSON.stringify({ results: [] }));
    assert.equal(read.rawArtifacts['attention-search-3'], JSON.stringify({ results: [{ url: 'https://public.example/origin' }] }),
      'the selected search artifact is the fallback response, while the primary empty response remains retained');
    assert.equal(read.comparisonAcquisition?.leadCount, 1);
  });

  await t.test('common search failure', async () => {
    let searchIndex = 0;
    const mock = mockFetch(url => url.includes('api.search.tinyfish.ai')
      ? searchIndex++ === 2 ? new Response('unavailable', { status: 403 }) : search([])
      : json({ results: [], errors: [] }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
    assert.equal(read.comparisonComplete, false);
  });

  const commonPost = 'https://x.com/river_lantern/status/778';
  const runFetchCase = async (fetchReply: (requested: string[]) => Response) => {
    let searchIndex = 0;
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) return search(searchIndex++ === 2 ? [commonPost] : []);
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      return fetchReply(requested);
    });
    return collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
  };

  await t.test('common fetch HTTP failure', async () => {
    const read = await runFetchCase(() => new Response('unavailable', { status: 403 }));
    assert.equal(read.comparisonComplete, false);
  });
  await t.test('HTTP-200 safety-check challenge is retained as blocked evidence, not a source', async () => {
    const read = await runFetchCase(requested => json({
      results: [fetchResult(requested[0]!, 'Safety check')],
      errors: [],
    }));
    assert.equal(read.complete, false);
    assert.equal(read.comparisonComplete, false);
    assert.deepEqual(read.sources, [], 'challenge text cannot become a source or support a fabricated negative');
    assert.deepEqual(read.comparisonSourceIds, []);
    assert.ok(read.codes.includes('ATT_FETCH_BLOCKED_CONTENT'));
    assert.ok(read.codes.includes('ATT_FETCH_INCOMPLETE'));
    assert.equal(read.codes.includes('ATT_FETCH_URL_ERROR'), false, 'the provider returned HTTP 200 with no per-URL error');
    assert.ok(read.rawArtifacts['attention-fetch-1']?.includes('Safety check'), 'the original provider response remains available for diagnosis');
  });
  await t.test('malformed common fetch shape', async () => {
    const read = await runFetchCase(() => json({ items: [] }));
    assert.equal(read.comparisonComplete, false);
  });
  await t.test('missing common fetch result', async () => {
    const read = await runFetchCase(() => json({ results: [], errors: [] }));
    assert.equal(read.comparisonComplete, false);
  });
  await t.test('redirect to a different comparison status ID', async () => {
    const read = await runFetchCase(() => json({ results: [{
      ...fetchResult(commonPost, 'Wrong status'), final_url: 'https://x.com/river_lantern/status/999',
    }], errors: [] }));
    assert.equal(read.comparisonComplete, false);
    assert.ok(read.codes.includes('ATT_FETCH_BINDING'));
  });
  await t.test('truncated common source text', async () => {
    const read = await runFetchCase(requested => json({ results: [fetchResult(requested[0]!, 'x'.repeat(120_001))], errors: [] }));
    assert.equal(read.comparisonComplete, false);
    assert.equal(read.sources[0]?.text.length, 120_000);
    assert.ok(read.codes.includes('ATT_TEXT_CAP'));
  });

  await t.test('comparison redirect to a prior truncated seed cannot inherit a complete flag', async () => {
    const seed = 'https://public.example/seed';
    const common = 'https://public.example/common';
    let searchIndex = 0;
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) return search(searchIndex++ === 2 ? [common] : []);
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      return json({ results: requested.map(item => item === seed
        ? { ...fetchResult(seed, 'x'.repeat(12_001)), final_url: common }
        : fetchResult(common, 'A shorter duplicate result.')), errors: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern', [seed]);
    assert.deepEqual(read.comparisonSourceIds, ['attention-page-1']);
    assert.equal(read.sources.length, 1, 'redirected seed and common result refer to the same retained source');
    assert.equal(read.sources[0]?.text.length, 12_000);
    assert.equal(read.comparisonComplete, false);
    assert.ok(read.codes.includes('ATT_TEXT_CAP'));
  });

  await t.test('a truncated duplicate comparison response is checked before source deduplication', async () => {
    const seed = 'https://public.example/seed';
    const common = 'https://public.example/common';
    let searchIndex = 0;
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) return search(searchIndex++ === 2 ? [common] : []);
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      return json({ results: requested.map(item => item === seed
        ? { ...fetchResult(seed, 'An initially short seed result.'), final_url: common }
        : fetchResult(common, 'x'.repeat(120_001)), ), errors: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern', [seed]);
    assert.deepEqual(read.comparisonSourceIds, ['attention-page-1']);
    assert.equal(read.sources[0]?.text.length, 120_000, 'the full bounded comparison response replaces the shorter prior source');
    assert.equal(read.comparisonComplete, false);
    assert.ok(read.codes.includes('ATT_TEXT_CAP'));
  });

  await t.test('a longer comparison response replaces a shorter matching seed without losing its tail', async () => {
    const seed = 'https://public.example/seed';
    const common = 'https://public.example/common';
    const prefix = `River Lantern project source names ${token.address}.` + 'x'.repeat(5_000);
    const fullText = prefix + 'Distinct tail representation ' + 'z'.repeat(8_000);
    let searchIndex = 0;
    const mock = mockFetch((url, init) => {
      if (url.includes('api.search.tinyfish.ai')) return search(searchIndex++ === 2 ? [common] : []);
      const requested = (JSON.parse(String(init.body)) as { urls: string[] }).urls;
      return json({ results: requested.map(item => item === seed
        ? { ...fetchResult(seed, prefix), final_url: common }
        : fetchResult(common, fullText)), errors: [] });
    });
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern', [seed]);

    assert.equal(read.sources.length, 1);
    assert.equal(read.sources[0]?.id, 'attention-page-1');
    assert.equal(read.sources[0]?.text, fullText);
    assert.equal(read.comparisonComplete, true);
    assert.equal(read.complete, true);
    assert.equal(read.codes.includes('ATT_TEXT_CAP'), false);
  });
});

test('search and fetch HTTP failures remain incomplete without inventing sources', async t => {
  await t.test('search failure', async () => {
    const mock = mockFetch(url => url.includes('api.search.tinyfish.ai')
      ? new Response('unavailable', { status: 403 })
      : json({ results: [], errors: [] }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
    assert.equal(read.complete, false);
    assert.equal(read.sources.length, 0);
    assert.ok(read.codes.includes('ATT_SEARCH_HTTP_403'));
    assert.equal(mock.calls.some(call => call.url.includes('api.fetch.tinyfish.ai')), false);
  });

  await t.test('fetch failure', async () => {
    const mock = mockFetch(url => url.includes('api.search.tinyfish.ai')
      ? search(['https://public.example/source'])
      : new Response('unavailable', { status: 403 }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
    assert.equal(read.complete, false);
    assert.equal(read.sources.length, 0);
    assert.ok(read.codes.includes('ATT_FETCH_HTTP_403'));
  });
});

test('collector retries one transient 502 and preserves the successful source', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-10-01T12:00:00.000Z') });
  let searchCalls = 0;
  const mock = mockFetch((url, _init) => {
    if (url.includes('api.search.tinyfish.ai')) {
      searchCalls++;
      if (searchCalls === 1) return new Response('busy', { status: 502, headers: { 'retry-after': '0' } });
      return search(searchCalls === 2 ? ['https://public.example/recovered'] : []);
    }
    return json({ results: [fetchResult('https://public.example/recovered', 'Recovered source')], errors: [] });
  });
  const pending = collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
  for (let index = 0; index < 12; index++) await Promise.resolve();
  assert.equal(mock.calls.length, 1);
  t.mock.timers.tick(1000);
  for (let index = 0; index < 12; index++) await Promise.resolve();
  const read = await pending;

  assert.equal(read.sources.length, 1);
  assert.equal(read.sources[0]?.text, 'Recovered source');
  assert.equal(read.complete, true);
  assert.equal(mock.calls.filter(call => call.url.includes('api.search.tinyfish.ai')).length, 3);
});

test('malformed provider response shapes and unsafe final URLs are retained as incomplete evidence', async t => {
  await t.test('malformed search shape', async () => {
    const mock = mockFetch(url => url.includes('api.search.tinyfish.ai')
      ? json({ items: [] })
      : json({ results: [], errors: [] }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
    assert.equal(read.complete, false);
    assert.ok(read.codes.includes('ATT_SEARCH_SHAPE'));
    assert.equal(read.sources.length, 0);
  });

  await t.test('unsafe final URL', async () => {
    const url = 'https://public.example/source';
    const mock = mockFetch(requestUrl => requestUrl.includes('api.search.tinyfish.ai')
      ? search([url])
      : json({ results: [{ url, final_url: 'http://127.0.0.1/private', text: 'must not be retained' }], errors: [] }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z');
    assert.equal(read.complete, false);
    assert.equal(read.sources.length, 0);
    assert.ok(read.codes.includes('ATT_FETCH_BINDING'));
    assert.ok(read.codes.includes('ATT_FETCH_INCOMPLETE'));
  });
});
