import assert from 'node:assert/strict';
import test from 'node:test';
import { createFirecrawlFallback, decodeFirecrawlArtifact } from '../src/providers/firecrawl.js';

type Call = { url: string; init: RequestInit };
type Handler = (call: Call) => Promise<Response> | Response;

const jsonResponse = (status: number, value: unknown) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});

function harness(handler: Handler, key = 'firecrawl-test-secret') {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    adapter: createFirecrawlFallback({ key, fetcher, now: () => '2026-10-29T12:34:56.000Z' }),
  };
}

function scrapeEnvelope(markdown: string, metadata: Record<string, unknown> = {
  statusCode: 200,
  url: 'https://final.example/page',
  sourceURL: 'https://source.example/page',
}) {
  return { success: true, data: { markdown, metadata } };
}

test('pure Firecrawl decoding matches the actual adapter result for scrape and search', async () => {
  const scrapeRaw = JSON.stringify(scrapeEnvelope('Retained page body.'));
  const scrapeHarness = harness(() => new Response(scrapeRaw, { status: 200 }));
  const scraped = await scrapeHarness.adapter.scrape('https://requested.example/page');
  assert.equal(scrapeHarness.calls.length, 1);
  assert.equal(scraped.httpStatus, 200);
  assert.deepEqual(decodeFirecrawlArtifact(scraped.request, scraped.raw!, 200), scraped);

  const searchRaw = JSON.stringify({ success: true, data: { web: [
    { url: 'https://result.example/page?utm_source=search&id=4', title: 'Result', description: 'Summary' },
  ] } });
  const searchHarness = harness(() => new Response(searchRaw, { status: 200 }));
  const searched = await searchHarness.adapter.search('source-backed search');
  assert.equal(searchHarness.calls.length, 1);
  assert.equal(searched.httpStatus, 200);
  assert.deepEqual(decodeFirecrawlArtifact(searched.request, searched.raw!, 200), searched);
});

test('pure Firecrawl decoding rejects forged request scopes and tampered native response payloads', () => {
  const scrapeRequest = { operation: 'SCRAPE', url: 'https://requested.example/page', at: '2026-10-29T12:34:56.000Z' };
  const searchRequest = { operation: 'SEARCH', query: 'source-backed search', at: '2026-10-29T12:34:56.000Z' };
  const scrapeRaw = JSON.stringify(scrapeEnvelope('Retained page body.'));
  const decode = (request: unknown, raw: string, status = 200) =>
    decodeFirecrawlArtifact(request as Parameters<typeof decodeFirecrawlArtifact>[0], raw, status);

  for (const request of [
    { ...scrapeRequest, url: 'http://127.0.0.1/private' },
    { ...scrapeRequest, url: 'https://requested.example/document.pdf' },
    { ...scrapeRequest, query: 'unexpected extra field' },
    { ...searchRequest, query: '  source-backed search  ' },
    { ...searchRequest, query: 'q'.repeat(2_001) },
    { ...searchRequest, url: 'https://requested.example/page' },
  ]) {
    assert.throws(() => decode(request, scrapeRaw), /FIRECRAWL_REQUEST_INVALID/);
  }

  const wrongEndpointPayload = JSON.stringify({ success: true, data: { web: [] } });
  assert.equal(decode(scrapeRequest, wrongEndpointPayload).code, 'FIRECRAWL_SHAPE');

  const unsafeMetadata = JSON.stringify(scrapeEnvelope('Retained body.', {
    statusCode: 200, url: 'http://127.0.0.1/private',
  }));
  assert.equal(decode(scrapeRequest, unsafeMetadata).code, 'FIRECRAWL_METADATA_URL');

  const unsafeSearchResult = JSON.stringify({ success: true, data: { web: [
    { url: 'http://127.0.0.1/private' },
  ] } });
  assert.equal(decode(searchRequest, unsafeSearchResult).code, 'FIRECRAWL_SEARCH_URL');
});

test('scrape sends the bounded documented request and retains raw plus complete processed-page provenance', async () => {
  const secret = 'never-return-this-firecrawl-key';
  const raw = JSON.stringify(scrapeEnvelope('# Full page\nNo clipping here.', {
    statusCode: 200,
    url: 'https://final.example/page?utm_source=feed&id=7',
    sourceURL: 'https://source.example/page',
  }));
  const { calls, adapter } = harness(() => new Response(raw, { status: 200 }), secret);

  const result = await adapter.scrape('https://source.example/page');

  assert.equal(result.status, 'OBSERVED');
  assert.equal(result.provider, 'firecrawl');
  assert.equal(result.raw, raw);
  assert.deepEqual(result.request, {
    operation: 'SCRAPE', url: 'https://source.example/page', at: '2026-10-29T12:34:56.000Z',
  });
  assert.deepEqual(result.pages, [{
    url: 'https://source.example/page',
    finalUrl: 'https://final.example/page?id=7',
    text: '# Full page\nNo clipping here.',
    publishedDate: null,
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.firecrawl.dev/v2/scrape');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.equal(calls[0]!.init.credentials, 'omit');
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${secret}`);
  assert.equal(headers.get('accept'), 'application/json');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    url: 'https://source.example/page',
    formats: ['markdown'],
    maxAge: 0,
    parsers: [],
    skipTlsVerification: false,
    storeInCache: false,
    timeout: 20_000,
  });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('missing keys, invalid inputs, pre-aborted calls, and per-instance failure caps do not create extra HTTP attempts', async () => {
  const noKey = harness(() => { throw new Error('fetch must not run'); }, '  ');
  assert.equal((await noKey.adapter.scrape('https://public.example/page')).code, 'FIRECRAWL_DISABLED');
  assert.equal((await noKey.adapter.search('query')).code, 'FIRECRAWL_DISABLED');
  assert.equal(noKey.calls.length, 0);

  const controller = new AbortController();
  controller.abort();
  const bounded = harness(() => new Response('raw upstream error', { status: 503 }));
  assert.equal((await bounded.adapter.scrape('http://127.0.0.1/private')).status, 'INVALID');
  assert.equal((await bounded.adapter.search('   ')).status, 'INVALID');
  assert.equal((await bounded.adapter.scrape('https://public.example/page', controller.signal)).code, 'FIRECRAWL_CANCELLED');
  assert.equal(bounded.calls.length, 0);

  const first = await bounded.adapter.scrape('https://public.example/one');
  const second = await bounded.adapter.scrape('https://public.example/two');
  const third = await bounded.adapter.scrape('https://public.example/three');
  assert.deepEqual([first.code, second.code, third.code], ['FIRECRAWL_HTTP_503', 'FIRECRAWL_HTTP_503', 'FIRECRAWL_ATTEMPT_LIMIT']);
  assert.equal(first.httpStatus, 503, 'an upstream HTTP error retains the received status');
  assert.equal(third.httpStatus, undefined, 'an attempt limit without a request has no HTTP status');
  assert.equal(first.raw, 'raw upstream error');
  assert.equal(second.raw, 'raw upstream error');
  assert.equal(bounded.calls.length, 2, 'failed HTTP requests consume both scrape slots');

  const search = await bounded.adapter.search('one search');
  const secondSearch = await bounded.adapter.search('second search');
  assert.equal(search.code, 'FIRECRAWL_HTTP_503');
  assert.equal(secondSearch.code, 'FIRECRAWL_ATTEMPT_LIMIT');
  assert.equal(bounded.calls.length, 3, 'a failed search consumes its only search slot');
});

test('scrape classifies target errors, challenge pages, genuine empty content, partial errors, and malformed JSON', async t => {
  const cases: Array<{
    name: string;
    status: number;
    body: string;
    expected: { status: string; code?: string; hasPage: boolean };
  }> = [
    { name: 'target 403', status: 200, body: JSON.stringify(scrapeEnvelope('Blocked', { statusCode: 403, url: 'https://target.example/page' })), expected: { status: 'UNAVAILABLE', code: 'FIRECRAWL_TARGET_HTTP_403', hasPage: false } },
    { name: 'target 404', status: 200, body: JSON.stringify(scrapeEnvelope('Missing', { statusCode: 404, sourceURL: 'https://target.example/page' })), expected: { status: 'UNAVAILABLE', code: 'FIRECRAWL_TARGET_HTTP_404', hasPage: false } },
    { name: 'challenge returned with target 200', status: 200, body: JSON.stringify(scrapeEnvelope('# Safety check.')), expected: { status: 'UNAVAILABLE', code: 'FIRECRAWL_CHALLENGE_PAGE', hasPage: false } },
    { name: 'genuine empty data', status: 200, body: JSON.stringify(scrapeEnvelope('  \n ')), expected: { status: 'NO_RESULTS', code: 'FIRECRAWL_EMPTY_CONTENT', hasPage: false } },
    { name: 'partial provider error', status: 200, body: JSON.stringify({ success: false, error: 'target fetch failed' }), expected: { status: 'UNAVAILABLE', code: 'FIRECRAWL_REQUEST_FAILED', hasPage: false } },
    { name: 'malformed success envelope', status: 200, body: JSON.stringify({ success: true, data: { markdown: 'Readable', metadata: { statusCode: '200' } } }), expected: { status: 'INVALID', code: 'FIRECRAWL_SHAPE', hasPage: false } },
    { name: 'malformed JSON', status: 200, body: '{not-json', expected: { status: 'INVALID', code: 'FIRECRAWL_JSON', hasPage: false } },
  ];

  for (const scenario of cases) await t.test(scenario.name, async () => {
    const { adapter } = harness(() => new Response(scenario.body, { status: scenario.status }));
    const result = await adapter.scrape('https://requested.example/page');
    assert.equal(result.status, scenario.expected.status);
    assert.equal(result.code, scenario.expected.code);
    assert.equal(result.pages.length > 0, scenario.expected.hasPage);
    assert.equal(result.raw, scenario.body, 'the complete provider response remains available');
  });
});

test('scrape rejects unsafe or missing reported URLs and preserves full text only within the declared limit', async t => {
  const metadataCases = [
    { name: 'unsafe metadata.url', metadata: { statusCode: 200, url: 'http://127.0.0.1/private', sourceURL: 'https://safe.example/page' } },
    { name: 'unsafe metadata.sourceURL despite a safe final URL', metadata: { statusCode: 200, url: 'https://safe.example/final', sourceURL: 'http://127.0.0.1/private' } },
    { name: 'no reported final URL', metadata: { statusCode: 200 } },
  ];
  for (const scenario of metadataCases) await t.test(scenario.name, async () => {
    const raw = JSON.stringify(scrapeEnvelope('Readable page', scenario.metadata));
    const { adapter } = harness(() => new Response(raw, { status: 200 }));
    const result = await adapter.scrape('https://requested.example/page');
    assert.equal(result.status, 'INVALID');
    assert.equal(result.code, scenario.name === 'no reported final URL' ? 'FIRECRAWL_FINAL_URL_MISSING' : 'FIRECRAWL_METADATA_URL');
    assert.equal(result.raw, raw);
    assert.deepEqual(result.pages, []);
  });

  const fullMarkdown = 'x'.repeat(120_001);
  const longRaw = JSON.stringify(scrapeEnvelope(fullMarkdown));
  const { adapter } = harness(() => new Response(longRaw, { status: 200 }));
  const oversizedText = await adapter.scrape('https://requested.example/page');
  assert.equal(oversizedText.status, 'INVALID');
  assert.equal(oversizedText.code, 'FIRECRAWL_CONTENT_LIMIT');
  assert.equal(oversizedText.raw, longRaw);
  assert.deepEqual(oversizedText.pages, [], 'oversized text is rejected whole rather than clipped');

  const oversizedResponse = harness(() => new Response('x'.repeat(500_001), { status: 200 }));
  const responseLimit = await oversizedResponse.adapter.scrape('https://requested.example/page');
  assert.equal(responseLimit.status, 'INVALID');
  assert.equal(responseLimit.code, 'FIRECRAWL_RESPONSE_LIMIT');
  assert.equal(responseLimit.httpStatus, 200, 'a received but oversized HTTP response still retains its status');
  assert.equal(responseLimit.raw, undefined, 'an over-limit response is not retained partially');
});

test('challenge detection matches whole-body wall messages but leaves substantive mentions readable', async t => {
  const cases = [
    { name: 'bare access wall heading', markdown: '## Access Denied!', status: 'UNAVAILABLE' },
    { name: 'bare CAPTCHA wall', markdown: '**CAPTCHA**.', status: 'UNAVAILABLE' },
    { name: 'bare sign-in wall', markdown: 'Sign in to continue.', status: 'UNAVAILABLE' },
    {
      name: 'substantive article mentioning blocked-page terms',
      markdown: 'This article compares CAPTCHA defenses, documents security checks, and quotes the “Access Denied” message users saw at login walls.',
      status: 'OBSERVED',
    },
  ];
  for (const scenario of cases) await t.test(scenario.name, async () => {
    const { adapter } = harness(() => jsonResponse(200, scrapeEnvelope(scenario.markdown)));
    const result = await adapter.scrape('https://requested.example/page');
    assert.equal(result.status, scenario.status);
    assert.equal(result.code, scenario.status === 'UNAVAILABLE' ? 'FIRECRAWL_CHALLENGE_PAGE' : undefined);
    assert.equal(result.pages.length, scenario.status === 'OBSERVED' ? 1 : 0);
  });
});

test('scrape declines explicit PDF, image, and archive URLs before HTTP but allows JSON metadata URLs', async () => {
  for (const suffix of ['.pdf', '.webp', '.zip']) {
    const { calls, adapter } = harness(() => { throw new Error('unsupported URL must not be requested'); });
    const result = await adapter.scrape(`https://public.example/file${suffix}`);
    assert.equal(result.status, 'INVALID', suffix);
    assert.equal(result.code, 'FIRECRAWL_UNSUPPORTED_MEDIA_URL', suffix);
    assert.equal(calls.length, 0, `${suffix} is rejected before consuming an attempt`);
  }

  const { calls, adapter } = harness(() => jsonResponse(200, scrapeEnvelope('JSON metadata endpoint text')));
  const allowed = await adapter.scrape('https://public.example/api/metadata.json?version=1');
  assert.equal(allowed.status, 'OBSERVED');
  assert.equal(calls.length, 1, 'JSON metadata remains within the provider contract');
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.deepEqual(body.parsers, []);
  assert.equal(body.url, 'https://public.example/api/metadata.json?version=1');
});

test('search trims and bounds the query, validates every result URL, and never scrapes results automatically', async _t => {
  const secret = 'never-return-this-search-key';
  const raw = JSON.stringify({ success: true, data: { web: [
    { url: 'https://result.example/page?utm_campaign=x&id=8', title: 'Result', description: 'Summary' },
    { url: 'https://second.example/' },
  ] } });
  const { calls, adapter } = harness(() => new Response(raw, { status: 200 }), secret);
  const result = await adapter.search('  source-backed query  ');
  assert.equal(result.status, 'OBSERVED');
  assert.deepEqual(result.request, { operation: 'SEARCH', query: 'source-backed query', at: '2026-10-29T12:34:56.000Z' });
  assert.equal(result.raw, raw);
  assert.deepEqual(result.pages, []);
  assert.deepEqual(result.results, [
    { url: 'https://result.example/page?id=8', title: 'Result', description: 'Summary' },
    { url: 'https://second.example/', title: '', description: '' },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://api.firecrawl.dev/v2/search');
  assert.equal(calls[0]!.init.redirect, 'error');
  assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), `Bearer ${secret}`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { query: 'source-backed query', limit: 5, sources: ['web'] });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));

  const unsafe = harness(() => jsonResponse(200, { success: true, data: { web: [
    { url: 'https://safe.example/' }, { url: 'http://127.0.0.1/private' },
  ] } }));
  const unsafeResult = await unsafe.adapter.search('query');
  assert.equal(unsafeResult.status, 'INVALID');
  assert.equal(unsafeResult.code, 'FIRECRAWL_SEARCH_URL');
  assert.deepEqual(unsafeResult.results, undefined, 'an unsafe result invalidates the batch rather than returning a partial list');
  assert.equal(unsafe.calls.length, 1);

  const tooMany = harness(() => jsonResponse(200, { success: true, data: { web: Array.from({ length: 6 }, (_, index) => ({ url: `https://result${index}.example/` })) } }));
  const tooManyResult = await tooMany.adapter.search('query');
  assert.equal(tooManyResult.status, 'INVALID');
  assert.equal(tooManyResult.code, 'FIRECRAWL_RESULT_LIMIT');
  assert.equal(tooMany.calls.length, 1);

  const empty = harness(() => jsonResponse(200, { success: true, data: { web: [] } }));
  const emptyResult = await empty.adapter.search('query');
  assert.equal(emptyResult.status, 'NO_RESULTS');
  assert.deepEqual(emptyResult.results, []);

  const tooLong = harness(() => { throw new Error('fetch must not run'); });
  const invalidQuery = await tooLong.adapter.search('q'.repeat(2_001));
  assert.equal(invalidQuery.status, 'INVALID');
  assert.equal(invalidQuery.code, 'FIRECRAWL_QUERY_INVALID');
  assert.equal(tooLong.calls.length, 0);
});

test('transport, timeout, and caller cancellation return safe codes without exposing error details', async () => {
  const secret = 'never-return-this-transport-key';
  const network = harness(() => { throw new TypeError(`network failed with ${secret}`); }, secret);
  const networkResult = await network.adapter.scrape('https://public.example/page');
  assert.equal(networkResult.status, 'UNAVAILABLE');
  assert.equal(networkResult.code, 'FIRECRAWL_TRANSPORT');
  assert.equal(networkResult.httpStatus, undefined, 'transport failure before response headers has no HTTP status');
  assert.doesNotMatch(JSON.stringify(networkResult), new RegExp(secret));

  const timeout = harness(() => { throw new DOMException(`deadline ${secret}`, 'TimeoutError'); }, secret);
  const timeoutResult = await timeout.adapter.scrape('https://public.example/page');
  assert.equal(timeoutResult.code, 'FIRECRAWL_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(timeoutResult), new RegExp(secret));

  let started!: () => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const cancellation = harness((_call) => new Promise<Response>((_resolve, reject) => {
    const signal = _call.init.signal!;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started();
  }), secret);
  const controller = new AbortController();
  const pending = cancellation.adapter.scrape('https://public.example/page', controller.signal);
  await waiting;
  const requestSignal = cancellation.calls[0]!.init.signal;
  assert.ok(requestSignal && requestSignal !== controller.signal, 'the provider receives a combined deadline and caller signal');
  controller.abort(new Error(`caller cancellation ${secret}`));
  const cancelled = await pending;
  assert.equal(cancelled.status, 'UNAVAILABLE');
  assert.equal(cancelled.code, 'FIRECRAWL_CANCELLED');
  assert.doesNotMatch(JSON.stringify(cancelled), new RegExp(secret));
});
