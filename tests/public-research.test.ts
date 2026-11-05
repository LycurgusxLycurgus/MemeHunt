import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { collectPublicResearch } from '../src/providers/public-research.js';

const token = { chain: 'solana' as const, address: '11111111111111111111111111111111' };
const options = { now: () => '2026-01-01T00:00:00.000Z', resolver: async () => [{ address: '8.8.8.8' }] };
const market = (websites: string[], socials: string[] = []) => JSON.stringify([
  { chainId: 'solana', baseToken: { address: token.address }, info: { websites: websites.map(url => ({ url })), socials: socials.map(url => ({ url })) } },
]);

test('free collection preserves raw receipts and address matches without certifying any feature or complete sample', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.includes('dexscreener')) return new Response(market(['https://project.example'], ['https://social.example/account']));
    if (url === 'https://project.example/') return new Response('<a href="/docs">Docs</a>Example project');
    if (url.includes('social.example')) return new Response('Forbidden', { status: 403 });
    return new Response(`Contract ${token.address}`);
  };
  const report = await collectPublicResearch(token, { ...options, fetcher });
  assert.equal(calls.length, 4);
  assert.equal(report.sources[0]!.exactContractInResponse, false);
  assert.equal(report.sources[1]!.status, 'UNAVAILABLE');
  assert.equal(report.sources[1]!.httpStatus, 403);
  assert.equal(report.sources[1]!.exactContractInResponse, null);
  assert.equal(report.sources[2]!.exactContractInResponse, true);
  assert.deepEqual(report.qualifiedFeatures, []);
  assert.equal(report.scope.completeSocialSample, false);
  assert.ok(report.sources.every(s => s.qualification === 'UNREVIEWED'));
  for (const e of report.evidence) assert.equal(e.contentHash, createHash('sha256').update(report.rawArtifacts[e.id]!).digest('hex'));
});

test('quote-side pair metadata and mismatching chain/address do not become project sources', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(JSON.stringify([
      { chainId: 'solana', baseToken: { address: 'OTHER_TOKEN' }, quoteToken: token, info: { websites: [{ url: 'https://wrong.example' }] } },
      { chainId: 'base', baseToken: { address: token.address }, info: { websites: [{ url: 'https://wrong.example' }] } },
    ]));
  };
  const report = await collectPublicResearch(token, { ...options, fetcher });
  assert.equal(calls, 1);
  assert.deepEqual(report.sources, []);
  assert.equal(report.status, 'UNAVAILABLE');
  assert.deepEqual(report.qualifiedFeatures, []);
});

test('redirects to private hosts are refused and oversized pages cannot become complete observations', async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async input => {
    const url = String(input); calls.push(url);
    if (url.includes('dexscreener')) return new Response(market(['https://project.example', 'https://large.example']));
    if (url.includes('project.example')) return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    return new Response('x'.repeat(500_001));
  };
  const report = await collectPublicResearch(token, { ...options, fetcher });
  assert.equal(calls.length, 3);
  assert.ok(!calls.some(url => url.includes('127.0.0.1')));
  assert.deepEqual(report.sources.map(s => s.code), ['NONPUBLIC_SOURCE', 'PROVIDER_RESPONSE_LIMIT']);
  assert.equal(report.status, 'UNAVAILABLE');
  assert.deepEqual(report.qualifiedFeatures, []);
});

test('the explicit source cap prevents excess requests without claiming exhaustive discovery', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async input => {
    calls++;
    return new Response(String(input).includes('dexscreener') ? market(Array.from({ length: 7 }, (_, i) => `https://project${i}.example`)) : 'Bounded page');
  };
  const report = await collectPublicResearch(token, { ...options, fetcher });
  assert.equal(calls, 5);
  assert.equal(report.sources.length, 4);
  assert.equal(report.scope.sourceLimitReached, true);
  assert.equal(report.scope.completeSocialSample, false);
});
