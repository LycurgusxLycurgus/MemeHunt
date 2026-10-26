import test from 'node:test';
import assert from 'node:assert/strict';
import { collectLaunchpadContext, decodeLaunchpadContext, deriveC16Launchpad, uncollectedC16, LAUNCHPAD_REQUESTS, type LaunchpadKey, type LaunchpadReceipts } from '../src/providers/advisory-launchpad.js';

const BASE = Date.parse('2026-10-12T07:06:55.600Z'), CUT = '2026-10-12T07:10:00.000Z', KEY = 'test-key-0123456789';
const D10 = 1_791_590_400, D11 = D10 + 86_400, D12 = D11 + 86_400;
const ORDER = Object.keys(LAUNCHPAD_REQUESTS) as LaunchpadKey[];
const IDS = ORDER.map(k => `advisory-launchpad-${k}`);
const iso = (ms: number) => new Date(ms).toISOString();
// Sequential reads one second apart, each completing 400 ms after its start, with the whole-second HTTP Date a real server sends.
const startOf = (k: LaunchpadKey) => BASE + ORDER.indexOf(k) * 1000;
const doneOf = (k: LaunchpadKey) => startOf(k) + 400;
const dateOf = (k: LaunchpadKey, shift = 0) => new Date(Math.floor(startOf(k) / 1000) * 1000 + shift).toUTCString();
const R = iso(doneOf('lighthouse'));
const side = (total: number, buys: number, sells: number) => ({ total, buys, sells, changePct: 0 });
const one = (total: number, changePct = 0) => ({ total, changePct });
// Transaction sides miss their total by one and HLL wallets exceed transactions, as in the retained probe; neither may fail decoding.
const frame = (created: number, migrated: number) => ({ transactions: side(133263, 74299, 58965), wallets: one(1135259), volume: side(7510017.06, 3532581.51, 3977435.55), tokensCreated: one(created, -5.5), migrations: one(migrated) });
const stats = (c: number[], m: number[]) => ({ '5m': frame(c[0], m[0]), '1h': frame(c[1], m[1]), '6h': frame(c[2], m[2]), '24h': frame(c[3], m[3]) });
type Market = Record<string, any>;
const lighthouse = (mutate?: (body: Market[]) => void) => {
  const body: Market[] = [
    { market: 'all', label: 'All', icon: '', url: '', stats: stats([180, 2716, 20493, 92011], [10, 121, 845, 3633]) },
    { market: 'pumpfun', label: 'Pumpfun', icon: '', url: 'https://pump.fun', stats: stats([148, 2229, 16554, 74835], [5, 41, 255, 1178]) },
    { market: 'meteora-curve:bags', label: 'BAGS', icon: '', url: '', parent: 'meteora-curve', stats: stats([1, 2, 3, 4], [0, 0, 0, 0]) },
  ];
  mutate?.(body); return JSON.stringify(body);
};
const methodology = { Volume: 'Quote-asset side of bonding-curve trades.', Fees: 'Bonding-curve trade and graduation fees.', Revenue: 'Pump slice of trade fees plus graduation fees.' };
const llama = (rows: number[][], patch: Record<string, unknown> = {}) => JSON.stringify({ id: '4449', defillamaId: '4449', slug: 'pump.fun', name: 'pump.fun', methodology, totalDataChart: rows, ...patch });
const envelope = (key: LaunchpadKey, body: string, httpStatus = 200, httpDate: string | null = dateOf(key)) => JSON.stringify({ httpStatus, httpDate, startedAt: iso(startOf(key)), body });
const base = (): Record<LaunchpadKey, string> => ({ lighthouse: envelope('lighthouse', lighthouse()), 'llama-volume': envelope('llama-volume', llama([[D10, 160975736], [D11, 158813405], [D12, 1000]])), 'llama-fees': envelope('llama-fees', llama([[D10, 2382659], [D11, 2242930]])), 'llama-revenue': envelope('llama-revenue', llama([[D10, 1720253], [D11, 1631179]])) });
function receipts(over: Partial<Record<LaunchpadKey, string>> = {}): LaunchpadReceipts {
  return { rawArtifacts: { ...base(), ...over }, retrievedAt: Object.fromEntries(ORDER.map(k => [k, iso(doneOf(k))])), requests: Object.fromEntries(Object.entries(LAUNCHPAD_REQUESTS).map(([k, r]) => [k, { ...r }])) };
}
const patch = (key: LaunchpadKey, change: (e: Record<string, unknown>) => void) => { const r = receipts(), e = JSON.parse(r.rawArtifacts[key]!); change(e); r.rawArtifacts[key] = JSON.stringify(e); return r; };

test('derives C16 from receipt-bound rolling counts and the latest common completed-day money series', () => {
  const context = decodeLaunchpadContext(receipts(), CUT), metric = deriveC16Launchpad(context, IDS);
  assert.equal(metric.quality, 'KNOWN'); assert.equal(metric.reasonCode, 'LAUNCHPAD_COUNTS_AND_COMPLETED_DAY_SERIES_OBSERVED');
  assert.deepEqual(context.counts?.launches.map(r => [r.window, r.durationSeconds, r.total]), [['5m', 300, 148], ['1h', 3600, 2229], ['6h', 21600, 16554], ['24h', 86400, 74835]]);
  assert.deepEqual(context.counts?.migrations.map(r => r.total), [5, 41, 255, 1178]);
  assert.equal(context.counts?.observedBy, R); assert.equal(context.counts?.endNotBefore, null); assert.equal(context.counts?.asOf, 'PROVIDER_UNPUBLISHED');
  assert.deepEqual(context.counts?.clock, { requestStartedAt: iso(BASE), retrievedAt: R, httpDate: dateOf('lighthouse') });
  assert.deepEqual(context.money?.day, { start: '2026-10-11T00:00:00.000Z', end: '2026-10-12T00:00:00.000Z', interval: '[start,end)' });
  assert.deepEqual([context.money?.volumeUsd, context.money?.feesUsd, context.money?.revenueUsd], ['158813405', '2242930', '1631179']);
  assert.deepEqual(context.money?.clocks.fees, { requestStartedAt: iso(startOf('llama-fees')), retrievedAt: iso(doneOf('llama-fees')), httpDate: dateOf('llama-fees') });
  assert.equal(context.survival.fraction, null); assert.deepEqual(context.causes, {});
  assert.deepEqual(decodeLaunchpadContext(receipts(), CUT), context);
});

test('strict Lighthouse drift, approximate counts and unbound cohorts leave counts missing without touching money', () => {
  const cases: Array<[(b: Market[]) => void, string]> = [
    [b => { b[2].stats['5m'].tokensCreated.extra = 1; }, 'LAUNCHPAD_LIGHTHOUSE_SHAPE'],
    [b => { b[1].stats['24h'].migrations.total = 1178.5; }, 'LAUNCHPAD_COUNT_INVALID'],
    [b => { b[1].parent = 'pumpfun-family'; }, 'LAUNCHPAD_COHORT_UNBOUND'],
    [b => { b.push({ ...b[1] }); }, 'LAUNCHPAD_LIGHTHOUSE_DUPLICATE_MARKET'],
  ];
  for (const [mutate, code] of cases) {
    const context = decodeLaunchpadContext(receipts({ lighthouse: envelope('lighthouse', lighthouse(mutate)) }), CUT), metric = deriveC16Launchpad(context, IDS);
    assert.equal(context.counts, null); assert.equal(context.causes.lighthouse, code); assert.notEqual(context.money, null);
    assert.equal(metric.quality, 'MISSING'); assert.equal(metric.reasonCode, 'LAUNCH_AND_MIGRATION_COUNTS_UNAVAILABLE');
  }
  const unauthorized = decodeLaunchpadContext(receipts({ lighthouse: envelope('lighthouse', JSON.stringify({ error: 'Unauthorized' }), 401) }), CUT);
  assert.equal(unauthorized.causes.lighthouse, 'LAUNCHPAD_HTTP_UNAVAILABLE');
});

test('money requires bound, named, completed and fresh common days', () => {
  const unbound = decodeLaunchpadContext(receipts({ 'llama-fees': envelope('llama-fees', llama([[D10, 1], [D11, 2]], { slug: 'pumpswap' })) }), CUT);
  assert.equal(unbound.money, null); assert.equal(unbound.causes['llama-fees'], 'LAUNCHPAD_LLAMA_BINDING');
  assert.equal(deriveC16Launchpad(unbound, IDS).reasonCode, 'COMPLETED_DAY_MONEY_SERIES_UNAVAILABLE');
  const unnamed = decodeLaunchpadContext(receipts({ 'llama-revenue': envelope('llama-revenue', llama([[D11, 2]], { methodology: { Fees: 'x' } })) }), CUT);
  assert.equal(unnamed.causes['llama-revenue'], 'LAUNCHPAD_LLAMA_METHODOLOGY');
  const old = (key: LaunchpadKey) => envelope(key, llama([[D10 - 172_800, 1]]));
  const stale = decodeLaunchpadContext(receipts({ 'llama-volume': old('llama-volume'), 'llama-fees': old('llama-fees'), 'llama-revenue': old('llama-revenue') }), CUT);
  assert.equal(stale.money, null); assert.equal(stale.causes.money, 'LAUNCHPAD_LLAMA_STALE');
  assert.equal(decodeLaunchpadContext(receipts({ 'llama-fees': envelope('llama-fees', llama([[D12, 5]])) }), CUT).causes.money, 'LAUNCHPAD_COMMON_COMPLETED_DAY_MISSING');
});

test('rejects tampered request scope, extra receipts and receipts after the cutoff', () => {
  const scoped = receipts(); scoped.requests['llama-volume'] = { url: 'https://api.llama.fi/summary/dexs/pumpswap?dataType=dailyVolume', auth: 'none' };
  assert.throws(() => decodeLaunchpadContext(scoped, CUT), /LAUNCHPAD_REQUEST_SCOPE/);
  const extra = receipts(); extra.rawArtifacts.extra = 'x';
  assert.throws(() => decodeLaunchpadContext(extra, CUT), /LAUNCHPAD_REQUEST_SCOPE/);
  const late = receipts(); late.retrievedAt.lighthouse = '2026-10-12T07:11:00.000Z';
  assert.throws(() => decodeLaunchpadContext(late, CUT), /LAUNCHPAD_TIME/);
});

test('the HTTP Date is a bracketed provider response clock: absence is disclosed, inconsistency or malformation is a named cause', () => {
  const absent = decodeLaunchpadContext(receipts({ lighthouse: envelope('lighthouse', lighthouse(), 200, null) }), CUT);
  assert.equal(deriveC16Launchpad(absent, IDS).quality, 'KNOWN'); assert.equal(absent.counts?.clock.httpDate, null); assert.equal(absent.counts?.endNotBefore, null);
  const right = dateOf('lighthouse'), wrongDay = (right.startsWith('Mon') ? 'Tue' : 'Mon') + right.slice(3);
  const cases: Array<[LaunchpadKey, string, string]> = [
    ['lighthouse', dateOf('lighthouse', 2000), 'LAUNCHPAD_HTTP_DATE_INCONSISTENT'],
    ['llama-revenue', dateOf('llama-revenue', -1000), 'LAUNCHPAD_HTTP_DATE_INCONSISTENT'],
    ['lighthouse', iso(startOf('lighthouse')), 'LAUNCHPAD_HTTP_DATE_INVALID'],
    ['lighthouse', wrongDay, 'LAUNCHPAD_HTTP_DATE_INVALID'],
  ];
  for (const [key, date, code] of cases) {
    const context = decodeLaunchpadContext(receipts({ [key]: envelope(key, JSON.parse(base()[key]).body, 200, date) }), CUT);
    assert.equal(context.causes[key], code, date);
    assert.equal(key === 'lighthouse' ? context.counts : context.money, null, date);
    assert.equal(deriveC16Launchpad(context, IDS).quality, 'MISSING', date);
  }
  // The completion second itself stays inside the bracket.
  assert.equal(decodeLaunchpadContext(receipts({ lighthouse: envelope('lighthouse', lighthouse(), 200, dateOf('lighthouse', 1000)) }), CUT).causes.lighthouse, undefined);
});

test('reversed, overlapping or malformed read clocks and non-collector envelopes reject the receipt set', () => {
  const reversed = receipts(); reversed.retrievedAt.lighthouse = iso(startOf('lighthouse') - 1);
  assert.throws(() => decodeLaunchpadContext(reversed, CUT), /LAUNCHPAD_TIME/);
  assert.throws(() => decodeLaunchpadContext(patch('llama-volume', e => { e.startedAt = iso(doneOf('lighthouse') - 1); }), CUT), /LAUNCHPAD_TIME/);
  assert.throws(() => decodeLaunchpadContext(patch('llama-fees', e => { e.startedAt = '2026-10-12 07:06:57'; }), CUT), /LAUNCHPAD_TIME/);
  assert.throws(() => decodeLaunchpadContext(patch('llama-fees', e => { delete e.startedAt; }), CUT), /LAUNCHPAD_RECEIPT_INVALID/);
  assert.throws(() => decodeLaunchpadContext(patch('lighthouse', e => { e.echo = 'x'; }), CUT), /LAUNCHPAD_RECEIPT_INVALID/);
  assert.throws(() => decodeLaunchpadContext(receipts({ 'llama-volume': JSON.stringify({ code: 'LAUNCHPAD_TIMEOUT' }) }), CUT), /LAUNCHPAD_RECEIPT_INVALID/);
  // A retained transport failure is a named cause, never a silent gap.
  const timedOut = decodeLaunchpadContext(receipts({ 'llama-volume': JSON.stringify({ code: 'LAUNCHPAD_TIMEOUT', startedAt: iso(startOf('llama-volume')) }) }), CUT);
  assert.deepEqual([timedOut.causes['llama-volume'], timedOut.money, deriveC16Launchpad(timedOut, IDS).reasonCode], ['LAUNCHPAD_TIMEOUT', null, 'COMPLETED_DAY_MONEY_SERIES_UNAVAILABLE']);
});

test('an uncollected run is a disclosed missing C16 without evidence', () => {
  const metric = uncollectedC16();
  assert.deepEqual([metric.id, metric.quality, metric.reasonCode, metric.evidenceIds, (metric.data as { collected: boolean }).collected], ['C16', 'MISSING', 'LAUNCHPAD_RECEIPTS_NOT_COLLECTED', [], false]);
});

test('collects four fixed sequential reads once each, keeping the start, the Date header and errors, never the key', async () => {
  const L = LAUNCHPAD_REQUESTS.lighthouse.url;
  const bodies: Record<string, string> = { [L]: lighthouse(), [LAUNCHPAD_REQUESTS['llama-volume'].url]: llama([[D11, 3]]), [LAUNCHPAD_REQUESTS['llama-fees'].url]: llama([[D11, 2]]), [LAUNCHPAD_REQUESTS['llama-revenue'].url]: llama([[D11, 1]]) };
  const calls: Array<{ url: string; key: string | null; redirect: string | undefined }> = [];
  let t = BASE, failRevenue = false; const now = () => iso(t += 200);
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = String(input); calls.push({ url, key: new Headers(init?.headers).get('x-api-key'), redirect: init?.redirect });
    if (failRevenue && url === LAUNCHPAD_REQUESTS['llama-revenue'].url) throw new TypeError('fetch failed');
    return new Response(bodies[url], { status: 200, headers: { date: new Date(Math.floor(t / 1000) * 1000).toUTCString() } });
  }) as typeof fetch;
  const r = await collectLaunchpadContext(KEY, fetcher, now);
  assert.deepEqual(calls.map(c => c.url), Object.values(LAUNCHPAD_REQUESTS).map(x => x.url));
  assert.deepEqual(calls.map(c => c.key), [KEY, null, null, null]);
  assert.ok(calls.every(c => c.redirect === 'error'));
  const lh = JSON.parse(r.rawArtifacts.lighthouse!);
  assert.deepEqual(Object.keys(lh).sort(), ['body', 'httpDate', 'httpStatus', 'startedAt']);
  assert.deepEqual([lh.startedAt, r.retrievedAt.lighthouse, lh.httpDate, lh.body], [iso(BASE + 200), iso(BASE + 400), new Date(Math.floor((BASE + 200) / 1000) * 1000).toUTCString(), bodies[L]]);
  assert.ok(!JSON.stringify(r).includes(KEY));
  const context = decodeLaunchpadContext(r, CUT);
  assert.equal(deriveC16Launchpad(context, IDS).quality, 'KNOWN'); assert.equal(context.counts?.clock.httpDate, lh.httpDate);
  failRevenue = true; t = BASE;
  const failed = await collectLaunchpadContext(KEY, fetcher, now);
  assert.deepEqual(JSON.parse(failed.rawArtifacts['llama-revenue']!), { code: 'LAUNCHPAD_TRANSPORT', startedAt: iso(BASE + 1400) });
  assert.equal(decodeLaunchpadContext(failed, CUT).causes['llama-revenue'], 'LAUNCHPAD_TRANSPORT');
  failRevenue = false; t = BASE; bodies[L] = JSON.stringify({ echo: KEY });
  await assert.rejects(collectLaunchpadContext(KEY, fetcher, now), /LAUNCHPAD_CREDENTIAL_ECHO/);
});
