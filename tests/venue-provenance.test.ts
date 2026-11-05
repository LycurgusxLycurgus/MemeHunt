// Offline O08 venue-provenance tests. Account bodies come unchanged from the retained C5 fixture;
// JSON-RPC envelopes, request ids, data slices, clocks, the parsed mint dependency, the native
// absence bank and the single holder account are CONSTRUCTED for production request geometry.
// Nothing here is, or claims to be, a fresh live capture.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectVenueProvenance, decodeVenueProvenance, encodeVenueProvenance, planVenueProvenance, validateVenueProvenanceBundle, venueProvenanceInspection } from '../src/providers/venue-provenance.js';
import { deriveBaseline } from '../src/domain/baseline.js';
import { starterProfile } from '../src/app/config.js';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import type { LiveBundle, TokenRef } from '../src/domain/contracts.js';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type Fixture = { kind: string; token: TokenRef; note: string; originals: Record<string, string>; sha256: Record<string, string> };
type Bank = { body: Json; keys: string[] };
type World = { summary: Json; banks: Record<'discovery' | 'state' | 'deployment', Bank>; canonical: Bank; dexRaw: string; genesisRaw: string; floorSlot: number };
type Call = { jsonrpc: '2.0'; id: string; method: 'getMultipleAccounts'; params: [string[], Record<string, unknown>] };
type TransportOptions = { unknownNull?: boolean; fail?: (request: Call) => boolean; edit?: (request: Call, body: Json) => void };
type Edit = { owner?: string; patches?: Array<[number, Uint8Array]>; length?: number };

const fixture = JSON.parse(readFileSync(new URL('../../tests/fixtures/venue-provenance-c5.json', import.meta.url), 'utf8')) as Fixture;
const TOKEN = fixture.token;
const PREFIX = 'venue-provenance-', RECORD_ID = 'venue-provenance-record', METHOD = 'pump-venue-provenance-v1';
const LEGACY_VERSION = 'pumpswap-sdk-1.20.0-canonical-wsol-v1';
const POOL = '3M9sVgL4u6ATKaiExf3XhQqNfMB6ijvzk3meMcQaen1w', QUOTE = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
const CURVE = '9nzxFL6UXZiMhPSyCqNDTXmPNdCUhtY3jwKoh7FTdeEP', TARGET_AS_QUOTE = 'CzY3kVvgKtpKQyRQsZnT56pKnzRWsrCjzKqRrYSPG2bS';
const WSOL_POOL = '3XDymbcnJgSN8GDUZ49Ngj5MHvJGrEcNG7TTeM3JBFgg', WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111', TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const LEGACY_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const DISCOVERY_SLOT = 461414381, STATE_SLOT = 461414388, AT = '2026-10-25T21:49:32.000Z';
const STAGES = ['discovery', 'state', 'deployment'];
const LATER = ['O09', 'O10', 'O11', 'O12', 'O13', 'O14', 'O15', 'O16'];
const ORIGINALS = ['summary.json', 'manifest.json', 'genesis.json', 'discovery-bank.json', 'canonical-pool.json', 'coupled-bank.json', 'dex-pairs.json', 'deployment-bank.json', 'deployment-manifest.json'];
const EXECUTION_KEYS = new Set(['removableLiquidityFraction', 'executionDisabled', 'entryQuoteUsd', 'exitQuoteUsd', 'exitQuantityAtomic', 'referencePriceUsd', 'simulation', 'executionFailure', 'costsReconciled', 'lockExpiresAt']);
const RELATED = /VENUE_PROVENANCE|venue|provenance|PUMP|O0[89]|O1[0-6]|baseline|certificate|binding|receipt|orphan|artifact|cutoff|expire|stale|FUTURE_EVIDENCE|DUPLICATE_BUNDLE_ID|UNKNOWN_EVIDENCE_REF/i;
const UNRELATED = /TypeError|SyntaxError|invalid_type|Unexpected token|is not a function|Cannot read prop/i;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decode58(text: string): Buffer {
  let n = 0n;
  for (const c of text) { const i = ALPHABET.indexOf(c); assert.ok(i >= 0, `base58 ${text}`); n = n * 58n + BigInt(i); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of text) { if (c !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
function encode58(bytes: Uint8Array): string {
  let n = 0n, text = '';
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  while (n > 0n) { text = ALPHABET.charAt(Number(n % 58n)) + text; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; text = '1' + text; }
  return text;
}
const key = (address: string) => { const out = decode58(address); assert.equal(out.length, 32, address); return out; };
const fakeAddress = (label: string) => encode58(createHash('sha256').update(label).digest());
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const original = (name: string): Json => JSON.parse(fixture.originals[name]!);

function world(): World {
  const summary = original('summary.json'), manifest = original('manifest.json'), deployment = original('deployment-manifest.json');
  const canonicalBody = original('canonical-pool.json');
  const canonicalValue = Array.isArray(canonicalBody.result?.value) ? canonicalBody.result.value[0] : canonicalBody.result?.value;
  assert.ok(canonicalValue, 'canonical-pool original carries the pool account');
  return {
    summary,
    banks: {
      discovery: { body: original('discovery-bank.json'), keys: manifest.find((x: Json) => x.id === 'discovery-bank').params[0] },
      state: { body: original('coupled-bank.json'), keys: summary.coupledKeys },
      deployment: { body: original('deployment-bank.json'), keys: deployment.params[0] },
    },
    // Constructed single-key bank around the retained canonical-pool account for the optional pool-only probe.
    canonical: { body: { jsonrpc: '2.0', id: 'constructed', result: { context: { slot: canonicalBody.result?.context?.slot ?? STATE_SLOT }, value: [canonicalValue] } }, keys: [POOL] },
    dexRaw: fixture.originals['dex-pairs.json']!, genesisRaw: fixture.originals['genesis.json']!, floorSlot: summary.discoverySlot,
  };
}
const banks = (w: World) => [w.banks.discovery, w.banks.state, w.banks.deployment, w.canonical];
function accountOf(w: World, address: string): Json {
  for (const bank of banks(w)) { const i = bank.keys.indexOf(address); if (i >= 0 && bank.body.result.value[i]) return bank.body.result.value[i]; }
  assert.fail(`no retained account ${address}`);
}
const bytesOf = (account: Json) => Buffer.from(account.data[0], 'base64');
function slice(account: Json, config: Json): Json {
  if (!account) return null;
  const out = structuredClone(account);
  if (config?.dataSlice) { const { offset, length } = config.dataSlice; out.data = [bytesOf(out).subarray(offset, offset + length).toString('base64'), 'base64']; }
  return out;
}
const envelope = (id: unknown, value: unknown, slot: number) => ({ jsonrpc: '2.0', id, result: { context: { slot }, value } });

// Known stages map to their retained bank; any other planned stage is mapped by its keys.
function respond(w: World, request: Call, unknownNull = false): Json {
  const stage = request.id.slice(PREFIX.length), keys = request.params[0];
  const bank = STAGES.includes(stage) ? w.banks[stage as keyof World['banks']]
    : [w.canonical, w.banks.state, w.banks.discovery, w.banks.deployment].find(b => keys.every(k => b.keys.includes(k)));
  if (!bank) { assert.ok(unknownNull, `no constructed bank for ${request.id}`); return envelope(request.id, keys.map(() => null), STATE_SLOT); }
  const body = structuredClone(bank.body);
  body.id = request.id;
  body.result.value = keys.map(k => {
    const i = bank.keys.indexOf(k);
    if (i < 0) { assert.ok(unknownNull, `unretained ${k} requested by ${request.id}`); return null; }
    return slice(bank.body.result.value[i], request.params[1]);
  });
  return body;
}

function dependencies(w: World): Record<string, string> {
  const mint = structuredClone(accountOf(w, TOKEN.address)), bytes = bytesOf(mint);
  const parsed = { ...mint, data: { program: mint.owner === TOKEN_2022 ? 'spl-token-2022' : 'spl-token', space: bytes.length, parsed: { type: 'mint', info: { decimals: bytes[44], supply: bytes.readBigUInt64LE(36).toString(), isInitialized: bytes[45] === 1, mintAuthority: null, freezeAuthority: null } } } };
  return {
    'rpc-genesis': w.genesisRaw,
    'rpc-account': JSON.stringify(envelope(1, parsed, w.floorSlot)),
    'pump-pool-config': JSON.stringify(envelope(1, [null], w.floorSlot)),
    'dex-pairs': w.dexRaw,
  };
}

function evidenceFor(w: World, rawArtifacts: Record<string, string>, read: Json): LiveBundle['evidence'] {
  const genesis = JSON.parse(w.genesisRaw).result;
  return Object.entries(rawArtifacts).map(([id, raw]) => {
    const meta = read?.marketEvidence?.[id], rpc = id === 'rpc-genesis' || id === 'rpc-account';
    const scope = meta?.scope ?? (id === 'rpc-genesis' ? { method: 'getGenesisHash', genesisHash: genesis }
      : id === 'rpc-account' ? { method: 'getAccountInfo', commitment: 'finalized', genesisHash: genesis, slot: w.floorSlot }
      : id === 'dex-pairs' ? { chain: 'solana', address: TOKEN.address }
      : { operation: id, mint: TOKEN.address, pool: WSOL_POOL });
    return {
      id, sourceId: meta?.sourceId ?? (rpc ? 'solana-rpc' : id === 'dex-pairs' ? 'dexscreener' : 'pumpswap-direct'),
      sourceType: meta?.sourceType ?? (id === 'dex-pairs' ? 'PUBLIC_MARKET' : 'JSON_RPC'), accessMode: meta?.accessMode ?? 'PUBLIC_API',
      scope, adapterVersion: 'live-v1', availableAt: AT, retrievedAt: AT, contentHash: sha(raw),
    };
  }) as LiveBundle['evidence'];
}
function providerBundle(w: World, deps: Record<string, string>, read: Json): LiveBundle {
  const profile = starterProfile(), rawArtifacts = { ...deps, ...(read?.rawArtifacts ?? {}) }, evidence = evidenceFor(w, rawArtifacts, read);
  const baseline = deriveBaseline({ token: TOKEN, cutoff: AT, profile, features: [], evidence, observations: [], ...(read ? { venueInspection: read.inspection } : {}) });
  return {
    analysisKind: 'LIVE', token: TOKEN, cutoff: AT, profile, rawArtifacts, evidence, observations: [],
    features: baseline.flatMap(x => x.projection ? [x.projection] : []), market: null,
    collection: { rpc: { state: 'OBSERVED' }, dex: { state: 'NO_RESULTS', count: 0 }, web: { state: 'NOT_REQUESTED' } },
    semantic: { status: 'NOT_REQUESTED', claims: [] },
    details: { version: 1, profile, thesis: null, baseline, origins: {}, stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null } },
  } as unknown as LiveBundle;
}

async function provider(w: World, options: TransportOptions = {}) {
  const calls: Call[] = [], responses: Array<{ request: Call; raw: string }> = [], transportErrors: string[] = [];
  const deps = dependencies(w);
  const read = await collectVenueProvenance({
    token: TOKEN, floorSlot: w.floorSlot, genesisRaw: deps['rpc-genesis'], accountRaw: deps['rpc-account'],
    nativeAbsenceRaw: deps['pump-pool-config'], dexRaw: deps['dex-pairs'], now: () => AT,
    transport: async request => {
      calls.push(structuredClone(request) as Call);
      assert.equal(request.method, 'getMultipleAccounts');
      assert.ok(typeof request.id === 'string' && request.id.startsWith(PREFIX), String(request.id));
      if (options.fail?.(request as Call)) throw new Error('constructed transport failure');
      let body: Json;
      try { body = respond(w, request as Call, options.unknownNull); } catch (error) { transportErrors.push(String(error)); throw error; }
      options.edit?.(request as Call, body);
      const raw = JSON.stringify(body);
      responses.push({ request: structuredClone(request) as Call, raw });
      return raw;
    },
  });
  assert.deepEqual(transportErrors, [], 'constructed transport saw only retained keys');
  const recordRaw = read.rawArtifacts[RECORD_ID];
  assert.ok(recordRaw, 'collector always emits the venue-provenance record');
  const record = JSON.parse(recordRaw);
  const bundle = providerBundle(w, deps, read);
  return { read: read as Json, record, bundle, calls, responses, deps, baseline: baselineOf(bundle) };
}

function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(v => allKeys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); allKeys(v, out); }
  return out;
}
// The `errors` subtree is diagnostic (e.g. errors.simulation: '..._UNSUPPORTED'), not an execution result.
function executionKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(v => executionKeys(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (k === 'errors') continue; if (EXECUTION_KEYS.has(k)) out.push(k); executionKeys(v, out); }
  return out;
}
function objectsWith(value: unknown, needle: string, out: Json[] = []): Json[] {
  if (Array.isArray(value)) value.forEach(v => objectsWith(v, needle, out));
  else if (value && typeof value === 'object') { if (Object.values(value).includes(needle)) out.push(value); Object.values(value).forEach(v => objectsWith(v, needle, out)); }
  return out;
}
const baselineOf = (bundle: LiveBundle): Json[] => (bundle.details as Json).baseline;
const rowOf = (baseline: Json[], id: string): Json => { const row = baseline.find(x => x.id === id); assert.ok(row, `baseline row ${id}`); return row; };
const recordOf = (bundle: LiveBundle): Json => JSON.parse(bundle.rawArtifacts[RECORD_ID]!);
const featureAt = (bundle: LiveBundle, id: string) => (bundle.features as Json[]).findIndex(f => f.featureId === id || f.id === id);
const provenanceOf = (record: Json) => ({ method: record.method, version: record.version, lifecycle: record.lifecycle, identity: record.identity, deployments: record.deployments, inventory: record.inventory, selected: record.selected, floorSlot: record.floorSlot, availableAt: record.availableAt, expiresAt: record.expiresAt, ttlSeconds: record.ttlSeconds });
function laterMissing(baseline: Json[], label: string) { for (const id of LATER) assert.equal(rowOf(baseline, id).quality, 'MISSING', `${label}: ${id}`); }

function failsClosed(result: Awaited<ReturnType<typeof provider>>, label: string) {
  assert.equal(result.record.bindingVerified, false, label);
  assert.equal(result.read.inspection.bindingVerified, false, label);
  assert.notEqual(rowOf(result.baseline, 'O08').quality, 'KNOWN', label);
  laterMissing(result.baseline, label);
  assert.equal(result.read.venue, undefined, label);
  assert.deepEqual(executionKeys([result.record, result.read.inspection, rowOf(result.baseline, 'O08').data]), [], label);
  assert.doesNotThrow(() => validateVenueProvenanceBundle(result.bundle), label);
}
const related = (label: string) => (error: unknown) => {
  const text = error instanceof Error ? `${error.name} ${String((error as Json).code ?? '')} ${error.message}` : String(error);
  assert.match(text, RELATED, `${label}: unrelated rejection ${text}`);
  assert.doesNotMatch(text, UNRELATED, `${label}: unrelated rejection ${text}`);
  return true;
};
function withIsolatedService<T>(run: (s: Service) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'venue-provenance-'));
  try {
    const service = new Service(join(dir, 'test.sqlite'));
    try { return run(service); } finally { service.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function mustReject(bundle: LiveBundle, label: string) {
  assert.throws(() => validateVenueProvenanceBundle(structuredClone(bundle)), related(`${label} validator`), `${label} validator`);
  withIsolatedService((service) => assert.throws(() => service.analyzeLive(structuredClone(bundle)), related(`${label} service`), `${label} service`));
}
function rehash(bundle: LiveBundle) { for (const r of bundle.evidence) { const raw = bundle.rawArtifacts[r.id]; if (raw !== undefined) r.contentHash = sha(raw); } }
function writeRecord(bundle: LiveBundle, record: Json) { bundle.rawArtifacts[RECORD_ID] = JSON.stringify(record); rehash(bundle); }

function applyEdit(account: Json, edit: Edit, offset = 0): boolean {
  let changed = false;
  if (edit.owner !== undefined && account.owner !== edit.owner) { account.owner = edit.owner; changed = true; }
  let bytes = bytesOf(account);
  for (const [at, patch] of edit.patches ?? []) patch.forEach((byte, j) => { const p = at + j - offset; if (p >= 0 && p < bytes.length && bytes[p] !== byte) { bytes[p] = byte; changed = true; } });
  if (edit.length !== undefined && bytes.length > edit.length - offset) {
    bytes = bytes.subarray(0, Math.max(0, edit.length - offset)); changed = true;
    if (typeof account.space === 'number') account.space = edit.length;
  }
  account.data = [bytes.toString('base64'), 'base64'];
  return changed;
}
function mutateWorld(w: World, address: string, edit: Edit) {
  let hits = 0;
  for (const bank of banks(w)) bank.keys.forEach((k, i) => { const account = bank.body.result.value[i]; if (k === address && account && applyEdit(account, edit)) hits++; });
  assert.ok(hits > 0, `no retained bytes changed for ${address}`);
}
function receiptId(bundle: LiveBundle, receipt: Json): string {
  const id = receipt.id in bundle.rawArtifacts ? receipt.id : PREFIX + receipt.stage;
  assert.ok(id in bundle.rawArtifacts, `receipt artifact ${receipt.id}`);
  return id;
}
// Receipt hashes inside the record are rewritten too, so rejection must come from re-deriving the
// binding from receipt bytes rather than from a stale content hash.
function editReceipts(bundle: LiveBundle, edit: (body: Json, receipt: Json) => boolean): number {
  const record = recordOf(bundle);
  let hits = 0;
  for (const receipt of record.receipts) {
    const id = receiptId(bundle, receipt), body = JSON.parse(bundle.rawArtifacts[id]!);
    if (!edit(body, receipt)) continue;
    const raw = JSON.stringify(body);
    bundle.rawArtifacts[id] = raw; receipt.contentHash = sha(raw); hits++;
  }
  writeRecord(bundle, record);
  return hits;
}
function editReceiptAccount(bundle: LiveBundle, address: string, edit: Edit): number {
  return editReceipts(bundle, (body, receipt) => {
    const keys: string[] = receipt.request.params[0], offset = receipt.request.params[1]?.dataSlice?.offset ?? 0;
    let changed = false;
    keys.forEach((k, i) => { const account = body.result.value[i]; if (k === address && account) changed = applyEdit(account, edit, offset) || changed; });
    return changed;
  });
}
const flip = (bytes: Buffer, at: number): [number, Uint8Array] => [at, Uint8Array.of(bytes[at]! ^ 0xff)];
const vaultAt = (w: World, at: number) => encode58(bytesOf(accountOf(w, POOL)).subarray(at, at + 32));

async function collectLive(w: World) {
  const calls: Json[] = [], urls: string[] = [];
  const accounts = new Map<string, Json>();
  for (const bank of [w.banks.discovery, w.banks.state, w.banks.deployment]) bank.keys.forEach((k, i) => { if (!accounts.has(k)) accounts.set(k, bank.body.result.value[i]); });
  const parsedMint = JSON.parse(dependencies(w)['rpc-account']!).result.value;
  const mint = accounts.get(TOKEN.address);
  // Constructed whole-supply ordinary holder: exercises population wiring only, not the actual C5 ownership census.
  const holder = Buffer.alloc(165);
  key(TOKEN.address).copy(holder, 0); holder.writeBigUInt64LE(bytesOf(mint).readBigUInt64LE(36), 64); holder[108] = 1;
  const population = [{ pubkey: fakeAddress('constructed-whole-supply-holder'), account: { owner: mint.owner, executable: false, lamports: 2039280, rentEpoch: 0, space: 165, data: [holder.toString('base64'), 'base64'] } }];
  const fetcher = async (url: unknown, init?: { body?: unknown }) => {
    const href = String(url); urls.push(href);
    if (href.includes('dexscreener.com')) return new Response(w.dexRaw, { status: 200, headers: { 'content-type': 'application/json' } });
    assert.ok(href.startsWith('https://rpc.invalid'), `unexpected network ${href}`);
    const q = JSON.parse(String(init?.body)); calls.push(q);
    let body: Json;
    if (typeof q.id === 'string' && q.id.startsWith(PREFIX)) body = respond(w, q);
    else if (q.method === 'getGenesisHash') body = { jsonrpc: '2.0', id: q.id, result: JSON.parse(w.genesisRaw).result };
    else if (q.method === 'getAccountInfo') body = envelope(q.id, q.params[0] === TOKEN.address && q.params[1]?.encoding === 'jsonParsed' ? parsedMint : slice(accounts.get(q.params[0]) ?? null, q.params[1]), w.floorSlot);
    else if (q.method === 'getProgramAccounts') body = envelope(q.id, population, w.floorSlot);
    else if (q.method === 'getMultipleAccounts') body = envelope(q.id, q.params[0].map((k: string) => slice(accounts.get(k) ?? null, q.params[1])), w.floorSlot);
    else throw new Error(`unexpected mock request ${q.method}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const bundle = await collectLiveToken(TOKEN, { profile: starterProfile(), semanticEnabled: false, advisoryEnabled: false, rpcUrl: 'https://rpc.invalid', fetcher: fetcher as unknown as typeof fetch, now: () => AT });
  return { bundle: bundle as LiveBundle, calls, urls };
}
let live!: Awaited<ReturnType<typeof collectLive>>;
before(async () => { live = await collectLive(world()); });
const liveBundle = () => structuredClone(live.bundle);

// 1) Retained C5 provider path

test('retained C5 originals match their SHA-256 and the frozen account layouts', () => {
  assert.deepEqual(Object.keys(fixture.originals).sort(), [...ORIGINALS].sort());
  for (const name of ORIGINALS) assert.equal(sha(fixture.originals[name]!), fixture.sha256[name], name);
  assert.equal(TOKEN.chain, 'solana');
  const w = world();
  assert.equal(w.summary.discoverySlot, DISCOVERY_SLOT);
  assert.equal(w.summary.coupledKeys.length, 12);
  assert.equal(w.banks.discovery.keys.length, 38);
  assert.equal(w.banks.deployment.keys.length, 6);
  const rows = JSON.parse(w.dexRaw) as Json[];
  assert.equal(rows.length, 30);
  assert.ok(rows.some(r => r.pairAddress === POOL), 'actual canonical pool is DEX listed');
  const pool = bytesOf(accountOf(w, POOL));
  assert.equal(pool.subarray(0, 8).toString('hex'), 'f19a6d0411b16dbc');
  assert.equal(pool.readUInt16LE(9), 0);
  assert.equal(encode58(pool.subarray(43, 75)), TOKEN.address);
  assert.equal(encode58(pool.subarray(75, 107)), QUOTE);
  const curve = bytesOf(accountOf(w, CURVE));
  assert.equal(curve[48], 1);
  for (const at of [8, 16, 24, 32]) assert.equal(curve.readBigUInt64LE(at), 0n, `reserve @${at}`);
  assert.equal(encode58(curve.subarray(83, 115)), QUOTE);
  const mint = accountOf(w, TOKEN.address), quote = accountOf(w, QUOTE);
  assert.equal(mint.owner, TOKEN_2022); assert.equal(bytesOf(mint)[44], 6);
  assert.equal(quote.owner, LEGACY_TOKEN); assert.equal(bytesOf(quote)[44], 8);
});

test('retained C5 collector -> deriveBaseline -> validator certifies O08 binding provenance only', async () => {
  const r = await provider(world()), { record, read } = r;
  assert.deepEqual(r.calls.map(c => c.id), STAGES.map(s => PREFIX + s));
  assert.deepEqual(r.calls.map(c => c.params[0].length), [33, 12, 6]);
  assert.equal(record.bindingVerified, true, JSON.stringify(record.errors));
  assert.equal(record.method, METHOD);
  assert.equal(record.version, METHOD);
  assert.equal(record.poolAddress, POOL);
  assert.equal(record.identity.pool.address, POOL);
  assert.ok(JSON.stringify([record.identity, record.lifecycle]).includes(CURVE));
  const quote = objectsWith(record.identity, QUOTE).find(o => 'decimals' in o);
  assert.equal(quote?.decimals, 8); assert.ok(Object.values(quote).includes(LEGACY_TOKEN));
  const target = objectsWith(record.identity, TOKEN.address).find(o => 'decimals' in o);
  assert.equal(target?.decimals, 6); assert.ok(Object.values(target).includes(TOKEN_2022));
  assert.equal(record.lifecycle.classification, 'MIGRATED');
  assert.match(JSON.stringify(record.lifecycle), /CURRENT_FINALIZED_STATE/);
  assert.equal(record.lifecycle.migrationTransaction, null, 'explicitly no historical transaction');
  const txClaims: string[] = [];
  const walkTx = (v: unknown): void => { if (Array.isArray(v)) v.forEach(walkTx); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/signature|transaction/i.test(k) && x !== null) txClaims.push(k); walkTx(x); } };
  walkTx(record.lifecycle);
  assert.deepEqual(txClaims, [], 'no non-null historical transaction claim');

  const rows = JSON.parse(world().dexRaw) as Json[], inventory = record.inventory;
  assert.equal(inventory.reportedRows, 30);
  for (const row of rows) assert.ok(JSON.stringify(inventory).includes(row.pairAddress), `inventory row ${row.pairAddress}`);
  const verified = inventory.candidates.filter((c: Json) => c.certification === 'VERIFIED');
  assert.equal(verified.length, 1); assert.ok(JSON.stringify(verified[0]).includes(POOL));
  assert.equal(inventory.candidates.find((c: Json) => JSON.stringify(c).includes(TARGET_AS_QUOTE))?.certification, 'UNVERIFIED');
  assert.ok(JSON.stringify(record.selected).includes(POOL));
  assert.ok(!JSON.stringify(record.selected).includes(TARGET_AS_QUOTE));

  const deployments: Json[] = Array.isArray(record.deployments) ? record.deployments : Object.values(record.deployments);
  assert.equal(deployments.length, 3);
  for (const d of deployments) {
    assert.equal(d.immutable, false, 'current non-null upgrade authority');
    const slots = Object.entries(d).filter(([k, v]) => /^(deploymentSlot|deploySlot|slot|lastDeploySlot)$/.test(k) && typeof v === 'number').map(([, v]) => v as number);
    assert.ok(slots.length > 0 && slots.every(s => s <= STATE_SLOT), JSON.stringify(d));
    assert.ok(Object.entries(d).some(([k, v]) => /authority/i.test(k) && typeof v === 'string'), JSON.stringify(d));
  }
  assert.deepEqual(allKeys(record.deployments).filter(k => /controller/i.test(k)), []);

  const o08 = rowOf(r.baseline, 'O08');
  assert.equal(o08.quality, 'KNOWN');
  assert.equal(o08.data.version, METHOD);
  assert.deepEqual(o08.data.provenance, provenanceOf(record));
  laterMissing(r.baseline, 'C5');
  assert.deepEqual(executionKeys([record, read.inspection, o08.data]), []);
  assert.equal(read.venue, undefined); assert.equal(read.controls, undefined); assert.equal(read.holders, undefined);
  assert.ok(Object.keys(read.rawArtifacts).every(k => k.startsWith(PREFIX)));
  assert.equal(read.inspection.poolAddress, POOL);
  assert.equal(read.inspection.bindingVerified, true);
  assert.equal(read.inspection.version, METHOD);
  assert.equal(read.inspection.certificateId, record.certificateId);
  assert.deepEqual(decodeVenueProvenance({ token: TOKEN, floorSlot: record.floorSlot, recordAt: AT, genesisRaw: r.deps['rpc-genesis'], accountRaw: r.deps['rpc-account'], nativeAbsenceRaw: r.deps['pump-pool-config'], dexRaw: r.deps['dex-pairs'], receipts: Object.fromEntries(r.responses.map(({ request, raw }) => [request.id.slice(PREFIX.length), { raw, retrievedAt: AT }])) }), record);
  assert.deepEqual(JSON.parse(encodeVenueProvenance(record)), record);
  assert.deepEqual(venueProvenanceInspection(record), read.inspection);
  assert.doesNotThrow(() => validateVenueProvenanceBundle(r.bundle));
});

test('planVenueProvenance reproduces each exact planned request from prior receipts', async () => {
  const w = world(), r = await provider(w), deps = r.deps;
  const plan = (receipts: Json) => planVenueProvenance({ token: TOKEN, floorSlot: w.floorSlot, recordAt: AT, genesisRaw: deps['rpc-genesis'], accountRaw: deps['rpc-account'], nativeAbsenceRaw: deps['pump-pool-config'], dexRaw: deps['dex-pairs'], receipts } as Json);
  let receipts: Json = {};
  for (const { request, raw } of r.responses) {
    const next = plan(receipts);
    assert.ok(next, `planned ${request.id}`);
    assert.equal(next.stage, request.id.slice(PREFIX.length));
    assert.deepEqual(next.request, request);
    receipts = { ...receipts, [next.stage]: { raw, retrievedAt: AT } };
  }
  assert.equal(plan(receipts), null);
});

// 2) Production live path through the untouched Service

test('production collectLiveToken -> Service saves, reopens and replays the same decision', () => {
  const { bundle, calls, urls } = live;
  assert.ok(urls.every(u => u.startsWith('https://rpc.invalid') || u.includes('dexscreener.com')), 'no unexpected network');
  const venueCalls = calls.filter(c => typeof c.id === 'string' && c.id.startsWith(PREFIX));
  assert.deepEqual(venueCalls.map(c => c.id), STAGES.map(s => PREFIX + s));
  assert.deepEqual(venueCalls.map(c => c.params[0].length), [33, 12, 6]);
  const record = recordOf(bundle);
  assert.deepEqual(record.receipts.map((r: Json) => r.request), venueCalls);
  assert.equal(record.bindingVerified, true, JSON.stringify(record.errors));
  assert.equal(record.poolAddress, POOL);
  assert.equal(record.inventory.reportedRows, 30);
  const o08 = rowOf(baselineOf(bundle), 'O08');
  assert.equal(o08.quality, 'KNOWN');
  assert.equal(o08.data.version, METHOD);
  assert.deepEqual(o08.data.provenance, provenanceOf(record));
  assert.deepEqual(executionKeys(o08.data), []);
  laterMissing(baselineOf(bundle), 'live');
  assert.ok(bundle.evidence.some(e => e.id === RECORD_ID));
  for (const e of bundle.evidence.filter(e => e.id.startsWith(PREFIX))) assert.equal(e.adapterVersion, 'live-v1', e.id);
  assert.doesNotThrow(() => validateVenueProvenanceBundle(structuredClone(bundle)));

  const dir = mkdtempSync(join(tmpdir(), 'venue-provenance-')), path = join(dir, 'memehunt.sqlite');
  try {
    let saved: Json = null;
    const service = new Service(path);
    try {
      saved = service.analyzeLive(structuredClone(bundle));
      assert.deepEqual(service.analyzeLive(structuredClone(bundle)).result, saved.result, 'idempotent save');
      assert.deepEqual(service.replay(saved.id).result, saved.result);
    } finally { service.close(); }
    const reopened = new Service(path);
    try { assert.deepEqual(reopened.replay(saved.id).result, saved.result, 'reopened offline replay'); } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 3) Lifecycle

test('bonding-curve lifecycle and layout violations fail binding without execution facts', async () => {
  const cases: Array<[string, (full: Buffer) => Edit, boolean]> = [
    ['active curve (complete false)', () => ({ patches: [[48, Uint8Array.of(0)]] }), true],
    ...[8, 16, 24, 32].map((at): [string, (full: Buffer) => Edit, boolean] => [`complete curve with nonzero reserve @${at}`, () => ({ patches: [[at, Uint8Array.of(1)]] }), true]),
    ['zero curve quote', () => ({ patches: [[83, new Uint8Array(32)]] }), false],
    ['WSOL curve quote', () => ({ patches: [[83, key(WSOL)]] }), false],
    ['pre-quote historical curve layout', () => ({ length: 81 }), false],
    ['wrong curve program', () => ({ owner: SYSTEM }), false],
    ['wrong curve discriminator', full => ({ patches: [flip(full, 0)] }), false],
  ];
  for (const [label, edit, lifecycle] of cases) {
    const w = world();
    mutateWorld(w, CURVE, edit(bytesOf(accountOf(w, CURVE))));
    const r = await provider(w, { unknownNull: true });
    failsClosed(r, label);
    if (lifecycle) assert.notEqual(r.record.lifecycle?.classification, 'MIGRATED', label);
  }
});

// 4) Binding mutations: collector fails closed AND a rehashed positive cache is rejected

test('rehashed pool, vault, mint and program mutations fail closed', async () => {
  const cases: Array<{ label: string; address: (w: World) => string; edit: (full: Buffer) => Edit }> = [
    { label: 'cross-mint pool base', address: () => POOL, edit: () => ({ patches: [[43, key(QUOTE)]] }) },
    { label: 'pool program owner', address: () => POOL, edit: () => ({ owner: SYSTEM }) },
    { label: 'pool quote mint', address: () => POOL, edit: () => ({ patches: [[75, key(WSOL)]] }) },
    { label: 'pool LP mint', address: () => POOL, edit: full => ({ patches: [flip(full, 107)] }) },
    { label: 'pool creator', address: () => POOL, edit: full => ({ patches: [flip(full, 11)] }) },
    { label: 'pool index', address: () => POOL, edit: () => ({ patches: [[9, Uint8Array.of(1, 0)]] }) },
    { label: 'pool header', address: () => POOL, edit: full => ({ patches: [flip(full, 0)] }) },
    { label: 'base vault owner', address: w => vaultAt(w, 139), edit: () => ({ patches: [[32, key(SYSTEM)]] }) },
    { label: 'quote vault mint', address: w => vaultAt(w, 171), edit: () => ({ patches: [[0, key(WSOL)]] }) },
    { label: 'base vault token program', address: w => vaultAt(w, 139), edit: () => ({ owner: LEGACY_TOKEN }) },
    { label: 'target mint token program', address: () => TOKEN.address, edit: () => ({ owner: LEGACY_TOKEN }) },
  ];
  for (const c of cases) {
    const w = world(), address = c.address(w), edit = c.edit(bytesOf(accountOf(w, address)));
    mutateWorld(w, address, edit);
    failsClosed(await provider(w, { unknownNull: true }), `collector ${c.label}`);
    const cached = liveBundle();
    assert.ok(editReceiptAccount(cached, address, edit) > 0, `receipt carries ${c.label}`);
    mustReject(cached, `cached ${c.label}`);
  }
});

test('ProgramData deployment slots after the coupled state fail closed', async () => {
  const w = world(), deployment = w.banks.deployment;
  const programData = deployment.keys.filter((_, i) => { const a = deployment.body.result.value[i]; return a?.owner === LOADER && bytesOf(a).length >= 12 && bytesOf(a).readUInt32LE(0) === 3; });
  assert.equal(programData.length, 3, 'three retained ProgramData accounts');
  const after = Buffer.alloc(8);
  after.writeBigUInt64LE(BigInt(Math.max(STATE_SLOT, w.banks.state.body.result.context.slot) + 1));
  const edit: Edit = { patches: [[4, after]] };
  for (const address of programData) mutateWorld(w, address, edit);
  failsClosed(await provider(w, { unknownNull: true }), 'collector deployment after state');
  const cached = liveBundle();
  assert.ok(programData.reduce((n, a) => n + editReceiptAccount(cached, a, edit), 0) > 0);
  mustReject(cached, 'cached deployment after state');
});

test('response id, context floor and missing receipts fail closed', async () => {
  const state = PREFIX + 'state', floor = world().floorSlot;
  failsClosed(await provider(world(), { edit: (request, body) => { if (request.id === state) body.id = PREFIX + 'forged'; } }), 'collector response id');
  failsClosed(await provider(world(), { edit: (request, body) => { if (request.id === state) body.result.context.slot = floor - 1; } }), 'collector context floor');
  const missing = await provider(world(), { fail: request => request.id === state });
  failsClosed(missing, 'collector missing receipt');
  assert.ok(missing.record.failure, 'missing receipt is recorded as a failure');

  const forged = liveBundle();
  assert.equal(editReceipts(forged, (body, receipt) => { if (receipt.stage !== 'state') return false; body.id = PREFIX + 'forged'; return true; }), 1);
  mustReject(forged, 'cached response id');
  const stale = liveBundle();
  assert.equal(editReceipts(stale, (body, receipt) => { if (receipt.stage !== 'state') return false; body.result.context.slot = floor - 1; return true; }), 1);
  mustReject(stale, 'cached context floor');
  const dropped = liveBundle(), receipt = recordOf(dropped).receipts.find((r: Json) => r.stage === 'state'), id = receiptId(dropped, receipt);
  delete dropped.rawArtifacts[id];
  dropped.evidence = dropped.evidence.filter(e => e.id !== id);
  mustReject(dropped, 'cached missing receipt');
});

// 5) Exact O08 provenance, ownership and O09-O16 promotion

test('O08 provenance and projection identity must match exactly', () => {
  const variants: Array<[string, (b: LiveBundle) => void]> = [
    ['modified provenance', b => { rowOf(baselineOf(b), 'O08').data.provenance.inventory.reportedRows += 1; }],
    ['deleted provenance field', b => { delete rowOf(baselineOf(b), 'O08').data.provenance.deployments; }],
    ['invented provenance field', b => { rowOf(baselineOf(b), 'O08').data.provenance.controller = SYSTEM; }],
    ['changed O08 feature value', b => { const f = b.features[featureAt(b, 'O08')] as Json; assert.equal(f.value, true); f.value = false; }],
    ['wrong O08 evidence ids', b => { const f = b.features[featureAt(b, 'O08')] as Json; assert.ok(Array.isArray(f.evidenceIds)); f.evidenceIds = ['dex-pairs']; }],
  ];
  for (const [label, mutate] of variants) { const b = liveBundle(); assert.equal(rowOf(baselineOf(b), 'O08').quality, 'KNOWN'); mutate(b); mustReject(b, label); }
  // Global uniqueness is enforced by the service before the specialized validator runs.
  const b = liveBundle(), i = featureAt(b, 'O08'); assert.ok(i >= 0); b.features.push(structuredClone(b.features[i]!));
  serviceRejects(b, 'duplicated O08 projection');
});

type Q = 'KNOWN' | 'STALE';
function o08Qualities(assessment: Q, projection: Q, feature: Q, expired: boolean): LiveBundle {
  const b = liveBundle(), row = rowOf(baselineOf(b), 'O08'), i = featureAt(b, 'O08');
  assert.equal(row.quality, 'KNOWN'); assert.ok(row.projection); assert.ok(i >= 0);
  // collectLiveToken shares the projection object with the feature list; detach before relabelling.
  row.projection = structuredClone(row.projection); b.features[i] = structuredClone(b.features[i]!);
  row.quality = assessment; row.projection.quality = projection; (b.features[i] as Json).quality = feature;
  if (expired) b.cutoff = new Date(Date.parse(recordOf(b).expiresAt) + 1000).toISOString();
  return b;
}
const sec05 = (b: LiveBundle) => withIsolatedService(s => s.analyzeLive(b).result.checks.find(c => c.checkId === 'SEC-05')?.status);

test('O08 mixed assessment/projection/feature qualities are rejected fresh and expired', () => {
  const mixed: Array<[Q, Q, Q]> = [['STALE', 'KNOWN', 'KNOWN'], ['KNOWN', 'STALE', 'KNOWN'], ['KNOWN', 'KNOWN', 'STALE'], ['STALE', 'STALE', 'KNOWN'], ['STALE', 'KNOWN', 'STALE'], ['KNOWN', 'STALE', 'STALE']];
  for (const [a, p, f] of mixed) for (const expired of [false, true]) mustReject(o08Qualities(a, p, f, expired), `mixed ${a}/${p}/${f} ${expired ? 'expired' : 'fresh'}`);
  for (const [a, f] of [['KNOWN', 'STALE'], ['STALE', 'KNOWN']] as Array<[Q, Q]>) {
    const bundle = o08Qualities(a, a, f, false);
    delete (rowOf(baselineOf(bundle), 'O08') as { projection?: unknown }).projection;
    mustReject(bundle, `mixed ${a}/absent/${f} fresh`);
  }
});

test('O08 expiry applies to uniform KNOWN while fresh KNOWN and expired uniform STALE stay valid', () => {
  mustReject(o08Qualities('KNOWN', 'KNOWN', 'KNOWN', true), 'uniform KNOWN expired');
  const fresh = liveBundle();
  assert.doesNotThrow(() => validateVenueProvenanceBundle(structuredClone(fresh)));
  assert.equal(sec05(structuredClone(fresh)), 'PASS');
  const stale = o08Qualities('STALE', 'STALE', 'STALE', true);
  assert.doesNotThrow(() => validateVenueProvenanceBundle(structuredClone(stale)));
  assert.equal(sec05(structuredClone(stale)), 'UNKNOWN');
});

test('venue-provenance artifacts reject orphan, foreign, future and stale ownership', () => {
  const recordEvidence = (b: LiveBundle): Json => { const e = b.evidence.find(x => x.id === RECORD_ID); assert.ok(e); return e; };
  const later = new Date(Date.parse(AT) + 3600000).toISOString();
  const variants: Array<[string, (b: LiveBundle) => void]> = [
    ['orphan artifact', b => { b.rawArtifacts[PREFIX + 'orphan'] = '{}'; b.evidence.push({ ...structuredClone(recordEvidence(b)), id: PREFIX + 'orphan', contentHash: sha('{}') }); }],
    ['wrong method', b => { const r = recordOf(b); r.method = 'pump-venue-provenance-v0'; writeRecord(b, r); }],
    ['foreign method', b => { const r = recordOf(b); r.method = LEGACY_VERSION; r.version = LEGACY_VERSION; writeRecord(b, r); }],
    ['missing scope', b => { recordEvidence(b).scope = {}; }],
    ['foreign source', b => { const e = recordEvidence(b); e.sourceId = 'dexscreener'; e.sourceType = 'PUBLIC_MARKET'; }],
    ['foreign adapter', b => { recordEvidence(b).adapterVersion = 'pumpswap-test-v1'; }],
    ['future evidence', b => { const e = recordEvidence(b); e.availableAt = later; e.retrievedAt = later; }],
    ['stale positive cache', b => {
      assert.equal(rowOf(baselineOf(b), 'O08').quality, 'KNOWN');
      b.cutoff = new Date(Date.parse(recordOf(b).expiresAt) + 1000).toISOString();
    }],
  ];
  for (const [label, mutate] of variants) { const b = liveBundle(); mutate(b); mustReject(b, label); }
});

test('binding-only receipts cannot promote O09-O16 through details or features', () => {
  const projectionAs = (b: LiveBundle, id: string): Json => {
    const i = featureAt(b, 'O08'); assert.ok(i >= 0);
    const p: Json = structuredClone(b.features[i]);
    for (const k of ['featureId', 'id']) if (typeof p[k] === 'string') p[k] = id;
    if ('quality' in p) p.quality = 'KNOWN';
    return p;
  };
  const promote = (b: LiveBundle, id: string) => { const rows = baselineOf(b), i = rows.findIndex(x => x.id === id); rows[i] = { ...structuredClone(rows[i]), quality: 'KNOWN', data: { promoted: true }, causes: [] }; return rows[i]; };
  for (const id of ['O09', 'O16']) {
    const variants: Array<[string, (b: LiveBundle) => void]> = [
      ['details', b => { promote(b, id); }],
      ['feature', b => { b.features.push(projectionAs(b, id)); }],
      ['feature without details row', b => { b.features.push(projectionAs(b, id)); (b.details as Json).baseline = baselineOf(b).filter(x => x.id !== id); }],
      ['details and feature', b => { const p = projectionAs(b, id); promote(b, id).projection = p; b.features.push(p); }],
    ];
    for (const [label, mutate] of variants) { const b = liveBundle(); mutate(b); mustReject(b, `${id} ${label}`); }
  }
});

// 6) Legacy labels and the unmarked missing branch

function stripProvenance(bundle: LiveBundle): void {
  const ids = new Set(Object.keys(bundle.rawArtifacts).filter(k => k.startsWith(PREFIX)));
  for (const id of ids) delete bundle.rawArtifacts[id];
  bundle.evidence = bundle.evidence.filter(e => !ids.has(e.id));
  const scrub = (value: unknown): void => {
    if (Array.isArray(value)) { for (let i = value.length - 1; i >= 0; i--) { if (typeof value[i] === 'string' && ids.has(value[i])) value.splice(i, 1); else scrub(value[i]); } }
    else if (value && typeof value === 'object') for (const k of Object.keys(value)) { if (ids.has(k)) delete (value as Json)[k]; else scrub((value as Json)[k]); }
  };
  scrub(bundle.details); scrub(bundle.features); scrub(bundle.observations);
}
function legacyRewrite(value: unknown, pool: string): void {
  if (Array.isArray(value)) { value.forEach(v => legacyRewrite(v, pool)); return; }
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(object)) {
    if ((k === 'version' || k === 'method') && v === METHOD) object[k] = LEGACY_VERSION;
    else if (k === 'certificateId' && typeof v === 'string') object[k] = `${LEGACY_VERSION}:${pool}`;
    else if (v === POOL) object[k] = pool;
    else legacyRewrite(v, pool);
  }
}

test('legacy-labelled O08 without provenance rejects while the retained native primary is null', () => {
  for (const pool of [POOL, WSOL_POOL]) {
    const b = liveBundle();
    const native = b.rawArtifacts['pump-pool-config'];
    if (native !== undefined) assert.equal(JSON.parse(native).result.value[0], null, 'retained native primary is null');
    stripProvenance(b);
    assert.ok(!Object.keys(b.rawArtifacts).some(k => k.startsWith(PREFIX)));
    assert.ok(!b.evidence.some(e => e.id.startsWith(PREFIX)));
    const row = rowOf(baselineOf(b), 'O08');
    assert.equal(row.quality, 'KNOWN');
    delete row.data.provenance;
    legacyRewrite(row, pool);
    row.data.version = LEGACY_VERSION;
    row.data.certificateId = `${LEGACY_VERSION}:${pool}`;
    const i = featureAt(b, 'O08');
    if (i >= 0) legacyRewrite(b.features[i], pool);
    mustReject(b, `legacy label with pool ${pool}`);
  }
});

test('unmarked missing O08 branch stays valid without venue-provenance artifacts', () => {
  const w = world(), bundle = providerBundle(w, dependencies(w), null);
  assert.ok(!Object.keys(bundle.rawArtifacts).some(k => k.startsWith(PREFIX)));
  assert.notEqual(rowOf(baselineOf(bundle), 'O08').quality, 'KNOWN');
  laterMissing(baselineOf(bundle), 'unmarked');
  assert.doesNotThrow(() => validateVenueProvenanceBundle(bundle));
});

function serviceRejects(bundle: LiveBundle, label: string, code?: RegExp) {
  withIsolatedService((service) => {
    assert.throws(() => service.analyzeLive(structuredClone(bundle)), (error: unknown) => { related(label)(error); if (code) assert.match(`${String((error as Json)?.code ?? '')} ${(error as Error)?.message}`, code, label); return true; }, label);
  });
}

test('legacy-labelled cached O08 feature without details rejects as contradicted', () => {
  const b = liveBundle();
  stripProvenance(b);
  const i = featureAt(b, 'O08'); assert.ok(i >= 0);
  assert.equal((b.features[i] as Json).value, true);
  legacyRewrite(b.features[i], POOL);
  assert.equal(JSON.parse(b.rawArtifacts['pump-pool-config']!).result.value[0], null);
  delete (b as Json).details;
  serviceRejects(b, 'legacy cached feature', /LEGACY_CONTRADICTED/);
});

test('failed binding cannot be replaced by a cached KNOWN O08 feature without details', async () => {
  const w = world();
  mutateWorld(w, CURVE, { patches: [[48, Uint8Array.of(0)]] });
  const r = await provider(w);
  assert.equal(r.record.bindingVerified, false);
  const cached = liveBundle().features[featureAt(liveBundle(), 'O08')]!;
  const b = r.bundle, i = featureAt(b, 'O08');
  if (i >= 0) b.features.splice(i, 1);
  const cachedForFailedBinding = structuredClone(cached);
  cachedForFailedBinding.evidenceIds = [...r.read.inspection.evidenceIds];
  b.features.push(cachedForFailedBinding);
  delete (b as Json).details;
  serviceRejects(b, 'cached O08 after failed binding', /DETAILS_MISSING/);
});

test('stripped proof cannot invent curve/DAMM versions or exemption markers', () => {
  const CURVE = 'pump-curve-sdk-4.0.0-sol-v1';
  const DAMM = 'meteora-damm-v2-sdk-1.5.1-native-b-v1';
  const SAFE_DIRECT = new Set(['VENUE_PROVENANCE_LEGACY_CONTRADICTED']);
  const safeService = (version: string) => new Set(['VENUE_PROVENANCE_LEGACY_CONTRADICTED', version === CURVE ? 'CURVE_PROOF_INVALID' : 'DAMM_PROOF_INVALID']);
  const codeOf = (err: unknown) => err instanceof Error ? err.message : (err as { code?: string })?.code;
  const rejectsWith = (allowed: Set<string>) => (err: unknown) => {
    assert.ok(!(err instanceof TypeError) && !(err instanceof SyntaxError), `parser crash: ${String(err)}`);
    assert.ok(allowed.has(codeOf(err) ?? ''), `unexpected rejection code ${codeOf(err)}: ${String(err)}`);
    return true;
  };
  const addEvidence = (b: any, id: string, sourceId: string, raw: unknown, scope: unknown) => {
    // Constructed marker body (labeled): not a captured fixture; fixture bytes are unchanged.
    const rawText = JSON.stringify(raw), hash = sha(rawText);
    b.rawArtifacts[id] = rawText;
    const ev = structuredClone(b.evidence[0]);
    Object.assign(ev, {
      id, sourceId, sourceType: 'CALCULATION', accessMode: 'LOCAL_DERIVED', adapterVersion: 'live-v1',
      scope, contentHash: hash, retrievedAt: AT, availableAt: AT,
    });
    b.evidence.push(ev);
  };
  for (const version of [CURVE, DAMM]) for (const marker of [undefined, 'UNVERIFIED', 'NONE'] as const) {
    const label = `${version} marker ${marker ?? 'none'}`;
    const b = liveBundle();
    stripProvenance(b);
    const baseline = baselineOf(b);
    const row = rowOf(baseline, 'O08');
    delete row.data.provenance;
    row.data.version = version;
    row.data.certificateId = '';
    if (marker) {
      if (version === CURVE) {
        addEvidence(b, 'venue-route-selection', 'pump-curve-derived',
          { method: 'pump-venue-selection-v1', selected: marker, primaryStateId: 'pump-pool-config' },
          { method: 'pump-venue-selection-v1' });
      } else {
        addEvidence(b, 'damm-route-selection', 'meteora-damm-derived',
          { method: 'verified-native-route-v1', selected: marker, pool: POOL },
          { method: 'verified-native-route-v1' });
      }
      addEvidence(b, 'shared-derivation', 'shared-collector', {
        method: 'shared-evidence-v1',
        token: row.data.token ?? TOKEN,
        pool: row.data.pool ?? POOL,
        error: row.data.error ?? null,
        limitation: row.data.limitation ?? null,
        evidenceIds: [...(row.evidenceIds ?? [])],
        venueInspection: { ...structuredClone(row.data), version, bindingVerified: false },
        baseline: structuredClone(b.details!.baseline),
      }, { method: 'shared-evidence-v1' });
    }
    assert.throws(() => validateVenueProvenanceBundle(b), rejectsWith(SAFE_DIRECT), `direct ${label}`);
    withIsolatedService((svc) => {
      assert.throws(() => svc.analyzeLive(b), rejectsWith(marker ? safeService(version) : SAFE_DIRECT), `service ${label}`);
    });
  }
});

test('one-hour reclock of retained stages keeps state-clock expiry and rejects mixed O08 quality', async () => {
  const r = await provider(world());
  const later = new Date(Date.parse(AT) + 3600000).toISOString();
  const decoded: Json = decodeVenueProvenance({
    token: TOKEN, floorSlot: r.record.floorSlot, recordAt: later,
    genesisRaw: r.deps['rpc-genesis'], accountRaw: r.deps['rpc-account'], nativeAbsenceRaw: r.deps['pump-pool-config'], dexRaw: r.deps['dex-pairs'],
    receipts: Object.fromEntries(r.responses.map(({ request, raw }) => [request.id.slice(PREFIX.length), { raw, retrievedAt: AT }])),
  });
  const rec = decoded, recordRaw = encodeVenueProvenance(rec);
  assert.equal(Date.parse(rec.expiresAt), Date.parse(AT) + 300000, 'expiry stays state clock + 300s');
  for (const receipt of rec.receipts) assert.equal(receipt.retrievedAt, AT, 'source receipt clocks unchanged');
  const b = structuredClone(r.bundle);
  b.cutoff = later;
  b.rawArtifacts[RECORD_ID] = recordRaw;
  const e = b.evidence.find(x => x.id === RECORD_ID) as Json; assert.ok(e);
  e.availableAt = later; e.retrievedAt = later;
  rehash(b);
  const derived = deriveBaseline({ token: TOKEN, cutoff: later, profile: b.profile, features: [], evidence: b.evidence, observations: [], venueInspection: venueProvenanceInspection(decoded) } as Json);
  const o08 = derived.find((x: Json) => x.id === 'O08'), rows = baselineOf(b);
  rows[rows.findIndex(x => x.id === 'O08')] = o08;
  const i = featureAt(b, 'O08');
  if (i >= 0) b.features.splice(i, 1);
  if (o08?.projection) b.features.push(o08.projection);
  serviceRejects(b, 'reclocked record', /VENUE_PROVENANCE_O08_FEATURE/);
});

// 7) Discovery bounds and listing-independent route binding

test('discovery deduplicates, filters exact mint and stays bounded over cap', async () => {
  const rows = JSON.parse(world().dexRaw) as Json[], planned = new Set((await provider(world())).calls[0]!.params[0]);
  const own = rows.find(r => r.baseToken?.address === TOKEN.address);
  assert.ok(own, 'a target-base DEX row exists');
  const foreign = [1, 2, 3].map(i => ({ ...structuredClone(rows[0]), pairAddress: fakeAddress(`foreign-${i}`), baseToken: { ...rows[0].baseToken, address: fakeAddress(`foreign-base-${i}`) }, quoteToken: { ...rows[0].quoteToken, address: WSOL } }));
  const w = world();
  w.dexRaw = JSON.stringify([...rows, ...structuredClone(rows), ...foreign]);
  const r = await provider(w, { unknownNull: true });
  const discovery = r.calls.find(c => c.id === PREFIX + 'discovery')!;
  assert.equal(new Set(discovery.params[0]).size, discovery.params[0].length, 'no duplicate discovery keys');
  assert.deepEqual(new Set(discovery.params[0]), planned, 'duplicates and foreign rows leave the planned discovery unchanged');
  for (const f of foreign) assert.ok(!r.calls.some(c => c.params[0].includes(f.pairAddress)), 'foreign-mint row never read');
  assert.equal(r.record.bindingVerified, true, JSON.stringify(r.record.errors));
  assert.equal(r.record.poolAddress, POOL);

  const synthetic = Array.from({ length: 250 }, (_, i) => ({ ...structuredClone(own), pairAddress: fakeAddress(`overcap-${i}`) }));
  const over = world();
  over.dexRaw = JSON.stringify([...rows, ...synthetic]);
  const capped = await provider(over, { unknownNull: true });
  assert.ok(capped.calls.length <= 4, `bounded request count ${capped.calls.length}`);
  for (const c of capped.calls) {
    assert.ok(c.params[0].length <= 100, `${c.id} keys ${c.params[0].length}`);
    assert.equal(new Set(c.params[0]).size, c.params[0].length);
  }
  const syntheticKeys = new Set(synthetic.map(s => s.pairAddress));
  assert.ok(capped.calls.flatMap(c => c.params[0]).filter(k => syntheticKeys.has(k)).length < synthetic.length, 'over-cap listing is not read in full');
  laterMissing(capped.baseline, 'over cap');
  assert.deepEqual(executionKeys([capped.record, capped.read.inspection]), []);
});

test('canonical route binding does not rely on the DEX listing', async () => {
  const w = world(), rows = JSON.parse(w.dexRaw) as Json[];
  w.dexRaw = JSON.stringify(rows.filter(r => r.pairAddress !== POOL));
  const r = await provider(w);
  for (const c of r.calls.filter(c => !STAGES.includes(c.id.slice(PREFIX.length)))) assert.deepEqual(c.params[0], [POOL], `optional probe ${c.id} reads only the canonical pool`);
  assert.ok(r.calls.some(c => c.params[0].includes(POOL)), 'canonical pool read directly');
  assert.equal(r.record.bindingVerified, true, JSON.stringify(r.record.errors));
  assert.equal(r.record.poolAddress, POOL);
  assert.equal(r.record.inventory.reportedRows, 29);
  assert.equal(rowOf(r.baseline, 'O08').quality, 'KNOWN');
  laterMissing(r.baseline, 'unlisted canonical');
  assert.doesNotThrow(() => validateVenueProvenanceBundle(r.bundle));
});
