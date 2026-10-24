import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { starterProfile } from '../src/app/config.js';
import { SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';
import { reconstructAdvisory } from '../src/app/advisory.js';
import type { AdvisoryMetric } from '../src/domain/advisory-contracts.js';
import { LAUNCHPAD_REQUESTS, type LaunchpadKey } from '../src/providers/advisory-launchpad.js';
import { legacyWindowBundle } from './window-legacy-fixtures.js';

const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const pool = '4zLRGHwKdXyaTovP8UkV66CskWgo9E7kAaGYcw1vFh7E', quote = 'So11111111111111111111111111111111111111112';
const at = '2026-10-10T12:30:00.000Z', hour = Date.parse('2026-10-10T12:00:00.000Z') / 1000, day = Date.parse('2026-10-10T00:00:00.000Z') / 1000;
const KEY = 'tracker-live-key-123', LIGHTHOUSE = LAUNCHPAD_REQUESTS.lighthouse.url, HTTP_DATE = new Date(at).toUTCString();
/** The public advisory fixture of advisory-integration, without any launchpad route. */
const base: typeof fetch = async (input, init) => {
  const url = String(input); let value: unknown;
  if (init?.method === 'POST') {
    const request = JSON.parse(String(init.body));
    value = { jsonrpc: '2.0', id: 1, result: request.method === 'getGenesisHash' ? SOLANA_MAINNET_GENESIS : request.method === 'getSignaturesForAddress' ? [] : { context: { slot: 1 }, value: null } };
  } else if (url.includes('/token-pairs/')) value = [{ chainId: 'solana', dexId: 'pumpswap', pairAddress: pool, baseToken: { address: token.address }, quoteToken: { address: quote }, priceUsd: '1', liquidity: { usd: 10000 }, volume: { h24: 100 }, txns: { h24: { buys: 4, sells: 3 } } }];
  else if (url.includes('include=base_token')) value = { data: { id: `solana_${pool}`, type: 'pool', attributes: { address: pool }, relationships: { base_token: { data: { id: `solana_${token.address}`, type: 'token' } }, quote_token: { data: { id: `solana_${quote}`, type: 'token' } } } }, included: [token.address, quote].map(address => ({ id: `solana_${address}`, type: 'token', attributes: { address } })) };
  else if (url.includes('ohlcv')) value = { data: { attributes: { ohlcv_list: Array.from({ length: 75 }, (_, i) => [hour - i * 3600, 10 + i % 6, 11 + i % 6, 9 + i % 6, 10 + i % 6, 20]) } } };
  else if (url.includes('coinbase')) value = Array.from({ length: 75 }, (_, i) => [hour - i * 3600, 9 + i % 6, 11 + i % 6, 10 + i % 6, 10 + i % 6, 2]);
  else if (url.includes('llama')) value = { chain: new URL(url).pathname.split('/').at(-1), totalDataChart: [[day - 172800, 10], [day - 86400, 20], [day, 999]] };
  else if (url.includes('/orders/')) value = { orders: [{ chainId: 'solana', tokenAddress: token.address, type: 'tokenProfile', status: 'approved', paymentTimestamp: Date.parse(at) - 1000 }], boosts: [] };
  else throw new Error('Unexpected fixture request');
  return new Response(JSON.stringify(value));
};
const frame = (created: number, migrated: number) => ({ transactions: { total: 10, buys: 6, sells: 4, changePct: 0 }, wallets: { total: 9, changePct: 0 }, volume: { total: 2, buys: 1, sells: 1, changePct: 0 }, tokensCreated: { total: created, changePct: 0 }, migrations: { total: migrated, changePct: 0 } });
const launches = [148, 2229, 16554, 74835], migrations = [5, 41, 255, 1178];
const lighthouseBody = JSON.stringify([{ market: 'pumpfun', label: 'Pumpfun', icon: '', url: 'https://pump.fun', stats: { '5m': frame(launches[0]!, migrations[0]!), '1h': frame(launches[1]!, migrations[1]!), '6h': frame(launches[2]!, migrations[2]!), '24h': frame(launches[3]!, migrations[3]!) } }]);
const methodology = { Volume: 'Bonding-curve trade volume.', Fees: 'Bonding-curve trade fees.', Revenue: 'Protocol share of fees.' };
const llama = (values: number[]) => JSON.stringify({ id: '4449', defillamaId: '4449', slug: 'pump.fun', methodology, totalDataChart: [[day - 172800, values[0]], [day - 86400, values[1]], [day, values[2]]] });
const BODIES: Record<string, string> = { [LIGHTHOUSE]: lighthouseBody, [LAUNCHPAD_REQUESTS['llama-volume'].url]: llama([100, 200, 300]), [LAUNCHPAD_REQUESTS['llama-fees'].url]: llama([10, 20, 30]), [LAUNCHPAD_REQUESTS['llama-revenue'].url]: llama([1, 2, 3]) };
type Call = { url: string; key: string | null };
/** Launchpad routes answer with the exact bodies and a whole-second HTTP Date; everything else is the public fixture. */
const tracker = (calls: Call[], override: (url: string) => Response | undefined = () => undefined): typeof fetch => async (input, init) => {
  const url = String(input); calls.push({ url, key: new Headers(init?.headers).get('x-api-key') });
  if (BODIES[url] === undefined) return base(input, init);
  return override(url) ?? new Response(BODIES[url], { status: 200, headers: { date: HTTP_DATE } });
};
const collect = (fetcher: typeof fetch, solanaTrackerKey?: string) => collectLiveToken(token, { profile: starterProfile(), semanticEnabled: false, advisoryEnabled: true, ...(solanaTrackerKey ? { solanaTrackerKey } : {}), fetcher, now: () => at });
type Bundle = Awaited<ReturnType<typeof collect>>;
const rehash = (b: Bundle, id: string) => { b.evidence.find(e => e.id === id)!.contentHash = createHash('sha256').update(b.rawArtifacts[id]!).digest('hex'); };
const proofOf = (b: Bundle) => JSON.parse(b.rawArtifacts['advisory-derivation']!);
const setProof = (b: Bundle, proof: unknown) => { b.rawArtifacts['advisory-derivation'] = JSON.stringify(proof); rehash(b, 'advisory-derivation'); };
const reconstruct = (b: Bundle, proof: unknown = proofOf(b)) => reconstructAdvisory(token, at, b.details!.baseline, b.evidence, b.rawArtifacts, proof, b.thesis ?? null, b.features);
const c16 = (facts: { metrics: AdvisoryMetric[] }) => facts.metrics.find(m => m.id === 'C16')!;
const diagnostics = (b: Bundle) => JSON.parse(b.rawArtifacts['launchpad-run-diagnostics']!);
const persist = (b: Bundle, policy: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'advisory-launchpad-live-')), file = join(directory, 'live.sqlite');
  try {
    const writer = new Service(file); let id = ''; try { id = writer.analyzeLive(b).id; } finally { writer.close(); }
    const reader = new Service(file); try { assert.deepEqual(reader.replay(id), reader.show(id)); assert.equal(reader.analyzeLive(b).id, id); } finally { reader.close(); }
    const db = new DatabaseSync(file); try { assert.equal(JSON.parse((db.prepare('SELECT semantic FROM snapshots WHERE id=?').get(id) as { semantic: string }).semantic).policyVersion, policy); } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
};

test('a keyed advisory run captures one Lighthouse and three public Llama receipts and persists a replayable C16', async () => {
  const calls: Call[] = [], bundle = await collect(tracker(calls), KEY), proof = proofOf(bundle), facts = bundle.details!.advisory!;
  assert.deepEqual([proof.method, facts.method], ['advisory-provenance-v33', 'advisory-measurements-v32']);
  assert.deepEqual(Object.keys(proof.launchpad.artifactIds).sort(), ['lighthouse', 'llama-fees', 'llama-revenue', 'llama-volume']);
  for (const [key, id] of Object.entries(proof.launchpad.artifactIds as Record<LaunchpadKey, string>) as Array<[LaunchpadKey, string]>) {
    const record = bundle.evidence.find(e => e.id === id)!, envelope = JSON.parse(bundle.rawArtifacts[id]!);
    assert.deepEqual([id, record.sourceId, record.sourceType, record.accessMode, record.adapterVersion, Object.keys(record.scope), record.availableAt, record.retrievedAt], [`advisory-launchpad-${key}`, 'advisory-launchpad', 'HISTORICAL_RECEIPT', key === 'lighthouse' ? 'FREE_ACCOUNT' : 'PUBLIC_API', 'live-v1', ['request'], at, at]);
    assert.deepEqual(record.scope.request, LAUNCHPAD_REQUESTS[key]);
    assert.deepEqual([envelope.httpStatus, envelope.httpDate, envelope.startedAt, envelope.body], [200, HTTP_DATE, at, BODIES[LAUNCHPAD_REQUESTS[key].url]]);
  }
  // The key travels once, only in the Lighthouse header, and is retained nowhere.
  assert.ok(!JSON.stringify(bundle).includes(KEY));
  for (const request of Object.values(LAUNCHPAD_REQUESTS)) assert.equal(calls.filter(c => c.url === request.url).length, 1);
  assert.deepEqual(calls.filter(c => c.key !== null).map(c => [c.url, c.key]), [[LIGHTHOUSE, KEY]]);
  const metric = c16(facts), data = metric.data as any;
  assert.deepEqual([metric.quality, metric.reasonCode, [...metric.evidenceIds].sort()], ['KNOWN', 'LAUNCHPAD_COUNTS_AND_COMPLETED_DAY_SERIES_OBSERVED', Object.values(proof.launchpad.artifactIds as Record<string, string>).sort()]);
  assert.deepEqual([data.counts.launches.map((r: any) => r.total), data.counts.migrations.map((r: any) => r.total)], [launches, migrations]);
  assert.deepEqual([data.counts.observedBy, data.counts.endNotBefore, data.counts.asOf, data.counts.clock], [at, null, 'PROVIDER_UNPUBLISHED', { requestStartedAt: at, retrievedAt: at, httpDate: HTTP_DATE }]);
  assert.deepEqual([data.money.day.start, data.money.volumeUsd, data.money.feesUsd, data.money.revenueUsd], ['2026-10-09T00:00:00.000Z', '200', '20', '2']);
  assert.equal(data.survival.fraction, null);
  assert.deepEqual(diagnostics(bundle), { method: 'launchpad-run-v1', availability: 'COLLECTED', receipts: 4 });
  persist(bundle, 'research-screen-advisory-v30');
});

test('C16 is rebuilt only from captured launchpad receipts; forged, orphaned, downgraded, misattributed or reclocked receipts fail closed', async () => {
  const bundle = await collect(tracker([]), KEY), directory = mkdtempSync(join(tmpdir(), 'advisory-launchpad-forgery-'));
  const idOf = (key: LaunchpadKey) => `advisory-launchpad-${key}`, recordOf = (b: Bundle, key: LaunchpadKey) => b.evidence.find(e => e.id === idOf(key))!;
  const editEnvelope = (b: Bundle, key: LaunchpadKey, change: (e: any) => void) => { const e = JSON.parse(b.rawArtifacts[idOf(key)]!); change(e); b.rawArtifacts[idOf(key)] = JSON.stringify(e); rehash(b, idOf(key)); };
  const reject = (name: string, mutate: (b: Bundle) => void, direct?: RegExp) => {
    const b = structuredClone(bundle); mutate(b);
    if (direct) assert.throws(() => reconstruct(b), direct, name);
    const service = new Service(join(directory, `${name}.sqlite`));
    try { assert.throws(() => service.analyzeLive(b), /ADVISORY_PROOF_INVALID|LIVE_PROVENANCE_INVALID|FUTURE_EVIDENCE|DUPLICATE_BUNDLE_ID|ARTIFACT_HASH_OR_SIZE/, name); } finally { service.close(); }
  };
  try {
    reject('forged-lighthouse-count', b => editEnvelope(b, 'lighthouse', e => { const body = JSON.parse(e.body); body[0].stats['24h'].tokensCreated.total = 999999; e.body = JSON.stringify(body); }));
    reject('claimed-normalized-c16', b => { (c16(b.details!.advisory!).data as any).counts.launches[3].total = 999999; });
    reject('proof-v16-with-launchpad', b => { const proof = proofOf(b); proof.method = 'advisory-provenance-v16'; setProof(b, proof); }, /ADVISORY_PROOF_INVALID/);
    reject('launchpad-descriptor-removal', b => { const proof = proofOf(b); delete proof.launchpad; setProof(b, proof); }, /ADVISORY_PROOF_INVALID/);
    reject('orphan-launchpad-receipts', b => { const proof = proofOf(b); proof.launchpad = null; setProof(b, proof); }, /ADVISORY_PROOF_INVALID/);
    reject('lighthouse-public-identity', b => { recordOf(b, 'lighthouse').accessMode = 'PUBLIC_API'; }, /ADVISORY_PROOF_INVALID/);
    reject('llama-account-identity', b => { recordOf(b, 'llama-fees').accessMode = 'FREE_ACCOUNT'; }, /ADVISORY_PROOF_INVALID/);
    reject('foreign-source-identity', b => { recordOf(b, 'llama-volume').sourceId = 'advisory-context'; }, /ADVISORY_PROOF_INVALID/);
    reject('duplicate-receipt-id', b => { b.evidence.push(structuredClone(recordOf(b, 'lighthouse'))); }, /ADVISORY_PROOF_INVALID/);
    // The populated descriptor must own the whole launchpad catalog: an undeclared source-owned copy with an attacker request and untrusted adapter is rejected, not persisted unused.
    reject('extra-launchpad-source-receipt', b => { const id = 'advisory-launchpad-extra'; b.rawArtifacts[id] = b.rawArtifacts[idOf('llama-fees')]!; b.evidence.push({ ...structuredClone(recordOf(b, 'llama-fees')), id, adapterVersion: 'untrusted', scope: { request: { url: 'https://attacker.example', auth: 'none' } } }); rehash(b, id); }, /ADVISORY_PROOF_INVALID/);
    // A prefix-owned receipt under another accepted public advisory source, with a valid adapter, body, hash, request and clock, is equally undeclared.
    reject('prefix-owned-foreign-source-receipt', b => { const id = 'advisory-launchpad-shadow'; b.rawArtifacts[id] = b.rawArtifacts[idOf('llama-fees')]!; b.evidence.push({ ...structuredClone(recordOf(b, 'llama-fees')), id, sourceId: 'advisory-context', scope: { request: { ...LAUNCHPAD_REQUESTS['llama-fees'] } } }); rehash(b, id); }, /ADVISORY_PROOF_INVALID/);
    reject('declared-receipt-missing', b => { b.evidence = b.evidence.filter(e => e.id !== idOf('llama-revenue')); delete b.rawArtifacts[idOf('llama-revenue')]; }, /ADVISORY_PROOF_INVALID/);
    reject('stale-receipt-hash', b => { recordOf(b, 'llama-revenue').contentHash = '0'.repeat(64); }, /ADVISORY_PROOF_INVALID/);
    reject('swapped-request', b => { const proof = proofOf(b); proof.launchpad.requests['llama-fees'] = { ...LAUNCHPAD_REQUESTS['llama-revenue'] }; recordOf(b, 'llama-fees').scope = { request: proof.launchpad.requests['llama-fees'] }; setProof(b, proof); }, /LAUNCHPAD_REQUEST_SCOPE/);
    reject('reversed-read-clock', b => editEnvelope(b, 'lighthouse', e => { e.startedAt = '2026-10-10T12:30:00.001Z'; }), /LAUNCHPAD_TIME/);
    reject('reversed-metadata-clock', b => { const r = recordOf(b, 'llama-fees'); r.retrievedAt = r.availableAt = '2026-10-10T12:29:59.000Z'; }, /LAUNCHPAD_TIME/);
    reject('future-metadata-clock', b => { const r = recordOf(b, 'lighthouse'); r.retrievedAt = r.availableAt = '2026-10-10T12:31:00.000Z'; }, /ADVISORY_PROOF_INVALID/);
    reject('future-http-date', b => editEnvelope(b, 'lighthouse', e => { e.httpDate = new Date(Date.parse(at) + 2000).toUTCString(); }));
    reject('malformed-http-date', b => editEnvelope(b, 'llama-volume', e => { e.httpDate = at; }));
    // A future provider clock is a disclosed cause on rebuild, never a KNOWN count.
    const dated = structuredClone(bundle); editEnvelope(dated, 'lighthouse', e => { e.httpDate = new Date(Date.parse(at) + 2000).toUTCString(); });
    const rebuilt = c16(reconstruct(dated)), data = rebuilt.data as any;
    assert.deepEqual([rebuilt.quality, data.causes.lighthouse, data.counts], ['MISSING', 'LAUNCHPAD_HTTP_DATE_INCONSISTENT', null]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('without a key no launchpad request is made; errored receipts are retained and a failed collector retains nothing', async () => {
  const calls: Call[] = [], bundle = await collect(tracker(calls));
  assert.equal(proofOf(bundle).launchpad, null);
  assert.ok(!calls.some(c => BODIES[c.url] !== undefined || c.key !== null));
  assert.ok(!bundle.evidence.some(e => e.sourceId === 'advisory-launchpad'));
  assert.deepEqual(diagnostics(bundle), { method: 'launchpad-run-v1', availability: 'SOLANA_TRACKER_API_KEY_MISSING', receipts: 0 });
  const missing = c16(bundle.details!.advisory!);
  assert.deepEqual([missing.quality, missing.reasonCode, missing.evidenceIds], ['MISSING', 'LAUNCHPAD_RECEIPTS_NOT_COLLECTED', []]);
  persist(bundle, 'research-screen-advisory-v30');
  const errored = await collect(tracker([], url => url === LAUNCHPAD_REQUESTS['llama-fees'].url ? new Response('unavailable', { status: 503, headers: { date: HTTP_DATE } }) : undefined), KEY);
  const metric = c16(errored.details!.advisory!), data = metric.data as any;
  assert.deepEqual([metric.quality, metric.reasonCode, data.causes['llama-fees'], data.counts.launches[0].total], ['MISSING', 'COMPLETED_DAY_MONEY_SERIES_UNAVAILABLE', 'LAUNCHPAD_HTTP_UNAVAILABLE', 148]);
  assert.equal(JSON.parse(errored.rawArtifacts['advisory-launchpad-llama-fees']!).httpStatus, 503);
  assert.deepEqual(diagnostics(errored), { method: 'launchpad-run-v1', availability: 'COLLECTED', receipts: 4 });
  persist(errored, 'research-screen-advisory-v30');
  const echoed = await collect(tracker([], url => url === LIGHTHOUSE ? new Response(JSON.stringify({ echo: KEY }), { status: 200 }) : undefined), KEY);
  assert.ok(!JSON.stringify(echoed).includes(KEY));
  assert.equal(proofOf(echoed).launchpad, null);
  assert.ok(!echoed.evidence.some(e => e.sourceId === 'advisory-launchpad'));
  assert.deepEqual(diagnostics(echoed), { method: 'launchpad-run-v1', availability: 'COLLECTION_FAILED', receipts: 0 });
  assert.equal(c16(echoed.details!.advisory!).reasonCode, 'LAUNCHPAD_RECEIPTS_NOT_COLLECTED');
});

test('legacy proofs keep their frozen C16 dispatch and cannot adopt launchpad receipts', async () => {
  const { bundle, proof } = legacyWindowBundle(await collect(tracker([])));
  // Proof v16 (short supplement) rebuilds facts v17 with the same supplement and the registry C16 default; proof v15 keeps facts v16 without it.
  const current = reconstruct(bundle, proof), v16 = reconstruct(bundle, { ...proof, method: 'advisory-provenance-v16', launchpad: undefined });
  assert.deepEqual([v16.method, v16.supplements, v16.metrics.filter(m => m.id !== 'C16'), v16.groups], ['advisory-measurements-v17', current.supplements, current.metrics.filter(m => m.id !== 'C16'), current.groups]);
  assert.equal(c16(v16).reasonCode, 'LAUNCH_MIGRATION_AND_COHORT_HISTORY_REQUIRED');
  proof.method = 'advisory-provenance-v15'; delete proof.launchpad;
  const facts = reconstruct(bundle, proof);
  assert.equal(facts.method, 'advisory-measurements-v16'); assert.equal(facts.supplements, undefined);
  assert.equal(c16(facts).reasonCode, 'LAUNCH_MIGRATION_AND_COHORT_HISTORY_REQUIRED');
  const keyed = legacyWindowBundle(await collect(tracker([]), KEY)).bundle, legacy = proofOf(keyed);
  legacy.method = 'advisory-provenance-v16'; legacy.launchpad = null;
  assert.throws(() => reconstruct(keyed, legacy), /ADVISORY_PROOF_INVALID/);
});
