import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAdvisoryMarket, decodeAdvisoryMarket } from '../src/providers/advisory-market.js';

const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const pool = '4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E';
const other = 'So11111111111111111111111111111111111111112';
const at = '2026-10-10T12:30:00.000Z';
const hour = Date.parse('2026-10-10T12:00:00.000Z') / 1000;
const day = Date.parse('2026-10-10T00:00:00.000Z') / 1000;
const bars = (coinbase = false) => Array.from({ length: 75 }, (_, i) => {
  const stamp = hour - i * 3600, p = 10 + i % 6;
  return coinbase ? [stamp, p - 1, p + 1, p, p, 2] : [stamp, p, p + 1, p - 1, p, 20];
});
const metadata = (base = token.address, quote = other) => ({ data: { id: `solana_${pool}`, type: 'pool', attributes: { address: pool },
  relationships: { base_token: { data: { id: `solana_${base}`, type: 'token' } }, quote_token: { data: { id: `solana_${quote}`, type: 'token' } } } },
  included: [base, quote].map(address => ({ id: `solana_${address}`, type: 'token', attributes: { address } })) });
function fixture(input: string): unknown {
  if (input.includes('include=base_token')) return metadata();
  if (input.includes('ohlcv')) return { data: { attributes: { ohlcv_list: bars() } } };
  if (input.includes('coinbase')) return bars(true);
  const chain = new URL(input).pathname.split('/').at(-1);
  return { chain, totalDataChart: [[day - 172800, 10], [day - 86400, 20], [day, 500]] };
}
const make = async (mutate?: (url: string, value: any) => any) => collectAdvisoryMarket(token, pool, async input => {
  const url = String(input), value = fixture(url);
  return new Response(JSON.stringify(mutate ? mutate(url, value) : value));
}, () => at);

test('market collection binds a real mint/pool, completed candles and matching daily chain context; replays offline exactly', async () => {
  const run = await make();
  assert.equal(Object.keys(run.requests).length, 8);
  assert.equal(run.data.candles?.bars.length, 72);
  assert.equal(run.data.candles?.bars.at(-1)?.end, '2026-10-10T12:00:00.000Z');
  assert.equal(run.data.candles?.bars[0]?.availableAt, at);
  assert.equal(run.data.macro.length, 3);
  assert.ok(run.data.macro.every(item => item.bars.length === 72 && item.bars.every(b => b.volumeQuote === null)));
  assert.deepEqual(run.data.chainVolumes.map(c => [c.chain, c.usd, c.previousUsd]), [['solana', '20', '10'], ['bsc', '20', '10'], ['base', '20', '10']]);
  assert.deepEqual(run.data.contextWindow, { start: '2026-10-09T00:00:00.000Z', end: '2026-10-10T00:00:00.000Z', availableAt: at });
  assert.deepEqual(Object.keys(run.data.missingCauses), ['C12', 'C16']);
  assert.deepEqual(decodeAdvisoryMarket(token, pool, run.rawArtifacts, run.retrievedAt, run.requests), run.data);
});

test('arbitrary wrong mint, duplicate base/quote binding and mismatched included metadata cannot qualify candles', async () => {
  for (const invalid of [metadata(other, other), metadata(other, '11111111111111111111111111111111'), { ...metadata(), included: [] }]) {
    const run = await make((url, value) => url.includes('include=base_token') ? invalid : value);
    assert.equal(run.data.candles, null);
    assert.equal(run.data.missingCauses['market-pool'], 'MARKET_POOL_BINDING');
    assert.equal(run.data.macro.length, 3);
  }
});

test('quote-side target uses the exact target-mint selector rather than assuming base orientation', async () => {
  const run = await make((url, value) => url.includes('include=base_token') ? metadata(other, token.address) : value);
  assert.ok(run.data.candles);
  assert.equal(new URL(run.requests['market-candles']!.url).searchParams.get('token'), token.address);
  const changed = structuredClone(run.requests);
  changed['market-candles']!.url = changed['market-candles']!.url.replace(`token=${token.address}`, 'token=base');
  const decoded = decodeAdvisoryMarket(token, pool, run.rawArtifacts, at, changed);
  assert.equal(decoded.candles, null);
  assert.equal(decoded.missingCauses['market-candles'], 'MARKET_REQUEST_SCOPE');
});

test('descending and reordered provider arrays normalize identically, while duplicate, gapped and future candles fail closed', async () => {
  const reference = await make();
  const reordered = await make((url, value) => {
    if (url.includes('ohlcv')) value.data.attributes.ohlcv_list.reverse();
    if (url.includes('coinbase')) value.reverse();
    return value;
  });
  assert.deepEqual(reordered.data, reference.data);
  for (const [code, mutate] of [
    ['MARKET_CANDLES_DUPLICATE_OR_TIME', (rows: number[][]) => { rows.push(rows[2]!); }],
    ['MARKET_CANDLES_GAP', (rows: number[][]) => { rows.splice(4, 1); }],
    ['MARKET_CANDLES_FUTURE', (rows: number[][]) => { rows[0]![0] = hour + 3600; }],
    ['MARKET_CANDLES_OHLC', (rows: number[][]) => { rows[4]![2] = 1; }],
    ['MARKET_NUMBER_INVALID', (rows: number[][]) => { rows[4]![1] = -1; }],
  ] as const) {
    const run = await make((url, value) => { if (url.includes('ohlcv')) mutate(value.data.attributes.ohlcv_list); return value; });
    assert.equal(run.data.candles, null);
    assert.equal(run.data.missingCauses['market-candles'], code);
  }
});

test('exact completed-hour boundary includes the candle ending at cutoff and excludes an unfinished one', async () => {
  const run = await make();
  const before = decodeAdvisoryMarket(token, pool, run.rawArtifacts, '2026-10-10T11:59:59.999Z', run.requests);
  assert.equal(before.candles, null); // The receipt also contains a future 12:00 bar at this earlier cutoff.
  assert.equal(before.missingCauses['market-candles'], 'MARKET_CANDLES_FUTURE');
  const exact = decodeAdvisoryMarket(token, pool, run.rawArtifacts, '2026-10-10T12:00:00.000Z', run.requests);
  assert.equal(exact.candles?.bars.at(-1)?.end, '2026-10-10T12:00:00.000Z');
});

test('stale history and missing daily comparison do not become latest-window measurements', async () => {
  const run = await make((url, value) => {
    if (url.includes('ohlcv')) value.data.attributes.ohlcv_list.splice(0, 2);
    if (url.includes('/dexs/BSC')) value.totalDataChart = [[day - 86400, 20]];
    return value;
  });
  assert.equal(run.data.missingCauses['market-candles'], 'MARKET_CANDLES_STALE');
  assert.equal(run.data.missingCauses['dex-bsc'], 'MARKET_CHAIN_WINDOW_MISSING');
  assert.equal(run.data.chainVolumes.length, 2);
});

test('daily chain identity, negative data, duplicate dates and unexpected raw endpoints are rejected', async () => {
  for (const [code, mutate] of [
    ['MARKET_CHAIN_BINDING', (value: any) => { value.chain = 'Ethereum'; }],
    ['MARKET_NUMBER_INVALID', (value: any) => { value.totalDataChart[0][1] = -5; }],
    ['MARKET_CHAIN_DUPLICATE_OR_TIME', (value: any) => { value.totalDataChart.push(value.totalDataChart[0]); }],
    ['MARKET_CHAIN_FUTURE', (value: any) => { value.totalDataChart.push([day + 86400, 999]); }],
  ] as const) {
    const run = await make((url, value) => { if (url.includes('/dexs/Solana')) mutate(value); return value; });
    assert.equal(run.data.missingCauses['dex-solana'], code);
  }
  const run = await make();
  assert.throws(() => decodeAdvisoryMarket(token, pool, { ...run.rawArtifacts, arbitrary: '{}' }, at, run.requests), /MARKET_REQUEST_SCOPE/);
});

test('HTTP failures, body limits and transport errors preserve receipts and safe causes without leaked messages', async () => {
  let active = 0, maximum = 0, calls = 0;
  const run = await collectAdvisoryMarket(token, pool, async input => {
    calls++; active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (String(input).includes('ohlcv')) return new Response('private raw error', { status: 429 });
    if (String(input).includes('BTC-USD')) throw new Error('sensitive-message');
    if (String(input).includes('ETH-USD')) return new Response('x'.repeat(1_000_001));
    return new Response(JSON.stringify(fixture(String(input))));
  }, () => at);
  assert.equal(calls, 8); assert.ok(maximum <= 4);
  assert.equal(run.data.missingCauses['market-candles'], 'MARKET_HTTP_UNAVAILABLE');
  assert.equal(run.data.missingCauses['macro-BTC'], 'MARKET_TRANSPORT');
  assert.equal(run.data.missingCauses['macro-ETH'], 'MARKET_RESPONSE_LIMIT');
  assert.match(run.rawArtifacts['market-candles']!, /private raw error/);
  assert.ok(!JSON.stringify(run).includes('sensitive-message'));
});

test('no recognized pool still collects macro/context and cannot invent token chart or call paid services', async () => {
  const urls: string[] = [];
  const run = await collectAdvisoryMarket(token, null, async input => { urls.push(String(input)); return new Response(JSON.stringify(fixture(String(input)))); }, () => at);
  assert.equal(urls.length, 6); assert.ok(urls.every(url => !url.includes('bridge') && !url.includes('fee')));
  assert.equal(run.data.candles, null);
  assert.equal(run.data.missingCauses['market-candles'], 'MARKET_POOL_UNAVAILABLE');
  assert.equal(run.data.macro.length, 3);
});
