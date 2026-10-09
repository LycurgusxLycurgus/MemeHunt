import assert from 'node:assert/strict';
import test from 'node:test';
import { completeFixtureEntryFeatures, illustrativeUncalibratedProfile } from '../examples/fixtures.js';
import { deriveAttention } from '../src/domain/attention.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { collectAttentionSources, normalizeAttentionSearchUrl, recoverComparisonSources } from '../src/providers/attention.js';
import { qualifyAttention } from '../src/providers/attention-model.js';

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
    disposition: 'RELEVANT', rationale: 'The retained source establishes this exact project representation.',
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
  assert.match(commonQuery, /"Dove RedCoin" solana token contract meme narrative/);
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
          { id: 'target-fulltext', token: target, sourceId: source.id, spanId: sourceSpan(source.id, target.address) },
          { id: 'rival-tail', token: { chain: 'base', address: rival }, sourceId: source.id, spanId: sourceSpan(source.id, rival) },
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

  await t.test('empty common result set', async () => {
    let searchIndex = 0;
    const mock = mockFetch(url => url.includes('api.search.tinyfish.ai')
      ? search(searchIndex++ === 2 ? [] : ['https://public.example/origin'])
      : json({ results: [fetchResult('https://public.example/origin', 'Origin page')], errors: [] }));
    const read = await collectAttentionSources(token, KEY, mock.fetcher, () => '2026-10-01T12:00:00.000Z', 'River Lantern');
    assert.equal(read.comparisonComplete, false);
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
