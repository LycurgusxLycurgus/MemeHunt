import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EvidenceRecord } from '../src/domain/contracts.js';
import { archiveHolderPopulation, collectAuthorityTopology, deriveAuthorityTopology, HOLDER_ARCHIVE_ADAPTER, HOLDER_ARCHIVE_SOURCE_BYTES, unpackHolderPopulation, type TopologyReceipts } from '../src/providers/advisory-topology.js';
import { LEGACY_TOKEN_PROGRAM as LEGACY, SOLANA_MAINNET_GENESIS as GENESIS, TOKEN_2022_PROGRAM as T22, decodeSolanaAddress, encodeSolanaAddress } from '../src/providers/solana.js';

const key = (n: number) => encodeSolanaAddress(Buffer.alloc(32, n));
const wide = (n: number) => { const b = Buffer.alloc(32, 7); b.writeUInt32BE(n, 0); return encodeSolanaAddress(b); };
const MINT = key(99), token = { chain: 'solana' as const, address: MINT };
const MINT_AT = '2026-10-11T22:00:00.000Z', POP_AT = '2026-10-11T22:00:05.000Z', cutoff = '2026-10-11T22:10:00.000Z';
const MINT_SLOT = 1000, POP_SLOT = 1001, MAX = 18446744073709551615n, KEY = 'topology-population', TOPOLOGY_ID = 'advisory-topology-topology-population', RPC = 'https://rpc.example.invalid';
const [A, B, C, D, E, F, G, H] = [1, 2, 3, 4, 5, 6, 7, 8].map(key);
const [X, Y, Z, W, V, CL] = [50, 51, 52, 53, 54, 55].map(key);
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const envelope = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', result, id: 1 });

// Synthetic SPL layouts: 165-byte base token account, 82-byte base mint, Token-2022 AccountType at byte 165 and TLV from 166.
type Acc = { owner: string; amount: bigint; delegate?: string; allowance?: bigint; state?: number; close?: string; delegateTag?: number; mint?: string; pubkey?: string; length?: number; ext?: Buffer; accountType?: number };
function baseAccount(a: Acc) {
  const b = Buffer.alloc(165); decodeSolanaAddress(a.mint ?? MINT).copy(b, 0); decodeSolanaAddress(a.owner).copy(b, 32); b.writeBigUInt64LE(a.amount, 64);
  if (a.delegate) { b.writeUInt32LE(1, 72); decodeSolanaAddress(a.delegate).copy(b, 76); }
  if (a.delegateTag !== undefined) b.writeUInt32LE(a.delegateTag, 72);
  b[108] = a.state ?? 1; b.writeBigUInt64LE(a.allowance ?? 0n, 121);
  if (a.close) { b.writeUInt32LE(1, 129); decodeSolanaAddress(a.close).copy(b, 133); }
  return b;
}
const tlv = (type: number, length: number) => { const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(length, 2); return Buffer.concat([h, Buffer.alloc(length, 1)]); };
const IMMUTABLE = tlv(7, 0);
/** Full Token-2022 account: base, AccountType, extension bytes, then zero padding to the allocated length. */
function fullAccount(a: Acc) {
  const base = baseAccount(a), length = a.length ?? 165; if (length === 165) return base;
  const b = Buffer.alloc(length); base.copy(b); b[165] = a.accountType ?? 2; (a.ext ?? IMMUTABLE).copy(b, 166); return b;
}
function mintBase(supply: bigint, initialized = 1) { const b = Buffer.alloc(82); b.writeBigUInt64LE(supply, 36); b[44] = 6; b[45] = initialized; return b; }
/** 414-byte metadata-only mint: MetadataPointer (18, len 64) and TokenMetadata (19, len 176). */
const metadataMint = (supply: bigint, ...extra: Buffer[]) => Buffer.concat([mintBase(supply), Buffer.alloc(83), Buffer.from([1]), tlv(18, 64), tlv(19, 176), ...extra]);
const value = (owner: string, data: Buffer, extra: Record<string, unknown> = {}) => ({ data: [data.toString('base64'), 'base64'], executable: false, lamports: 2039280, owner, rentEpoch: 0, space: data.length, ...extra });
const supplyOf = (accounts: Acc[]) => accounts.reduce((s, a) => s + a.amount, 0n);

type Bundle = { evidence: EvidenceRecord[]; raw: Record<string, string>; topology?: TopologyReceipts; fullRaw?: string };
const live = (id: string, raw: string, scope: Record<string, unknown>, at: string): EvidenceRecord => ({ id, sourceId: 'solana-rpc', sourceType: 'JSON_RPC', retrievedAt: at, availableAt: at, contentHash: sha(raw), adapterVersion: 'live-v1', accessMode: 'PUBLIC_API', scope });
/** Canonical live-v1 receipts exactly as collectLiveToken records them. */
function canonical(program: string, mint: Buffer, population?: { items: unknown[]; slot?: number }, genesis = GENESIS, mintExtra: Record<string, unknown> = {}): Bundle {
  const raw: Record<string, string> = { 'rpc-genesis': envelope(genesis), 'rpc-mint-raw': envelope({ context: { apiVersion: '2.3.0', slot: MINT_SLOT }, value: value(program, mint, mintExtra) }) };
  const evidence = [live('rpc-genesis', raw['rpc-genesis']!, { method: 'getGenesisHash', genesisHash: genesis }, MINT_AT), live('rpc-mint-raw', raw['rpc-mint-raw']!, { operation: 'rpc-mint-raw', commitment: 'finalized', mint: MINT }, MINT_AT)];
  if (population) { raw['rpc-holder-population'] = envelope({ context: { apiVersion: '2.3.0', slot: population.slot ?? POP_SLOT }, value: population.items }); evidence.push(live('rpc-holder-population', raw['rpc-holder-population'], { operation: 'rpc-holder-population', commitment: 'finalized', mint: MINT }, POP_AT)); }
  return { evidence, raw };
}
const items = (accounts: Acc[], program: string, data: (a: Acc) => Buffer) => accounts.map((a, i) => ({ pubkey: a.pubkey ?? wide(1000 + i), account: value(program, data(a)) }));
const legacy = (accounts: Acc[], o: { supply?: bigint; slot?: number; mint?: Buffer; program?: string } = {}) => canonical(o.program ?? LEGACY, o.mint ?? mintBase(o.supply ?? supplyOf(accounts)), { items: items(accounts, LEGACY, baseAccount), slot: o.slot });

const REQUEST = { method: 'getProgramAccounts', params: [T22, { encoding: 'base64', commitment: 'finalized', minContextSlot: MINT_SLOT, withContext: true, filters: [{ memcmp: { offset: 0, bytes: MINT } }] }] };
const receiptsOf = (raw: string, at = POP_AT, request: unknown = REQUEST): TopologyReceipts => ({ rawArtifacts: { [KEY]: raw }, retrievedAt: { [KEY]: at }, requests: { [KEY]: request } });
/** Adds the full receipt as the root namespace resolves it: HISTORICAL_RECEIPT, public access, hashed raw, request scope. */
const withTopology = (b: Bundle, r: TopologyReceipts): Bundle => {
  const raw = r.rawArtifacts[KEY]!, at = r.retrievedAt[KEY]!;
  const record: EvidenceRecord = { id: TOPOLOGY_ID, sourceId: 'advisory-topology', sourceType: 'HISTORICAL_RECEIPT', retrievedAt: at, availableAt: at, contentHash: sha(raw), adapterVersion: 'live-v1', accessMode: 'PUBLIC_API', scope: { request: r.requests[KEY] } };
  return { ...b, evidence: [...b.evidence.filter(e => e.sourceId !== 'advisory-topology'), record], topology: r };
};
const T22_ACCOUNTS: Acc[] = [
  { owner: A, amount: 4000n },
  { owner: B, amount: 3000n, delegate: X, allowance: MAX, length: 170 },
  { owner: C, amount: 2000n, delegate: X, allowance: 500n, length: 191 },
  { owner: D, amount: 1000n, close: CL, length: 256 },
];
function t22(o: { accounts?: Acc[]; mint?: Buffer; slot?: number; supply?: bigint; mutate?: (list: any[]) => void } = {}): Bundle {
  const accounts = o.accounts ?? T22_ACCOUNTS, full = items(accounts, T22, fullAccount); o.mutate?.(full);
  // The canonical live read sliced 165 bytes while the RPC still reports the full allocated space.
  const sliced = items(accounts, T22, baseAccount).map((item, i) => ({ ...item, account: { ...item.account, space: accounts[i]!.length ?? 165 } }));
  const bundle = canonical(T22, o.mint ?? metadataMint(o.supply ?? supplyOf(accounts)), { items: sliced });
  const fullRaw = envelope({ context: { apiVersion: '2.3.0', slot: o.slot ?? POP_SLOT }, value: full });
  return { ...withTopology(bundle, receiptsOf(fullRaw)), fullRaw };
}
const run = (b: Bundle) => deriveAuthorityTopology(token, cutoff, b.evidence, b.raw, b.topology);
const canonicalOnly = (b: Bundle): Bundle => ({ evidence: b.evidence.filter(e => e.sourceId !== 'advisory-topology'), raw: b.raw });
const withRaw = (b: Bundle, id: string, raw: string): Bundle => ({ ...b, raw: { ...b.raw, [id]: raw }, evidence: b.evidence.map(e => e.id === id ? { ...e, contentHash: sha(raw) } : e) });
const without = (b: Bundle, id: string): Bundle => { const raw = { ...b.raw }; delete raw[id]; return { ...b, raw, evidence: b.evidence.filter(e => e.id !== id) }; };
const edit = (b: Bundle, id: string, change: Partial<EvidenceRecord>): Bundle => ({ ...b, evidence: b.evidence.map(e => e.id === id ? { ...e, ...change } : e) });
function missing(b: Bundle, reason: string) {
  const m = run(b), data = m.data as any;
  assert.equal(m.quality, 'MISSING', reason); assert.equal(m.reasonCode, reason); assert.equal(data.status, 'UNRESOLVED', reason);
  assert.ok(!('counts' in data) && !('graphs' in data), reason);
  return m;
}
function mockFetch(respond: () => Response) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return respond(); }) as typeof fetch;
  return { calls, fetcher };
}
const pair = (list: any[], owner: string, authority: string) => list.find(p => p.owner === owner && p.authority === authority);

// A-X-B-Y-C plus C-X closes a cycle; Y is both delegate and holder; X holds nothing; C, F, G share close authority CL.
const LEGACY_ACCOUNTS: Acc[] = [
  { owner: A, amount: 1000n, delegate: X, allowance: 300n },
  { owner: A, amount: 500n, delegate: X, allowance: MAX },
  { owner: B, amount: 2000n, delegate: Y, allowance: 2000n },
  { owner: B, amount: 100n, delegate: X, allowance: 50n },
  { owner: C, amount: 400n, delegate: Y, allowance: 10n, close: CL },
  { owner: C, amount: 100n, delegate: X, allowance: 1n },
  { owner: C, amount: 0n, delegate: Z, allowance: 5n, close: CL },
  { owner: D, amount: 700n, delegate: D, allowance: 700n },
  { owner: D, amount: 300n, delegate: W, allowance: 0n },
  { owner: E, amount: 600n, delegate: V, allowance: 600n, state: 2 },
  { owner: F, amount: 800n, close: CL },
  { owner: G, amount: 250n, close: CL },
  { owner: Y, amount: 150n },
  { owner: H, amount: 3100n, close: H },
];

test('legacy population yields strong delegate groups with unique owner balances and weak-link sensitivity', () => {
  const m = run(legacy(LEGACY_ACCOUNTS)), d = m.data as any;
  assert.equal(m.quality, 'KNOWN'); assert.equal(m.reasonCode, 'EXPLICIT_AUTHORITY_ASSOCIATIONS_OBSERVED');
  assert.deepEqual(m.evidenceIds, ['rpc-genesis', 'rpc-mint-raw', 'rpc-holder-population']);
  assert.equal(d.supplyAtomic, '10000'); assert.equal(d.state.program, LEGACY); assert.equal(d.coverage.populationSource, 'rpc-holder-population');
  assert.deepEqual(d.population, { accounts: 14, positiveAccounts: 13, owners: 9, positiveOwners: 9, complete: true, reconciledToSupply: true });
  assert.deepEqual(d.counts, { strongPairs: 5, strongAccounts: 6, strongAuthorities: 2, suspendedPairs: 1, closeAuthorityPairs: 3, closeAuthorityAccounts: 3, closeAuthorities: 1 });
  assert.deepEqual([d.approvedExposure.accounts, d.approvedExposure.owners, d.approvedExposure.effectiveAtomic, d.approvedExposure.fractionOfSupply], [6, 3, '2861', '0.2861']);
  const ax = pair(d.strongAssociations, A, X);
  assert.equal(ax.accounts.length, 2); assert.equal(ax.effectiveAtomic, '800');
  assert.ok(ax.accounts.some((p: any) => p.allowanceAtomic === MAX.toString() && p.approvedAtomic === '500' && p.effectiveAtomic === '500'));
  assert.ok(ax.accounts.some((p: any) => p.allowanceAtomic === '300' && p.approvedAtomic === '300'));
  assert.deepEqual([[B, Y], [B, X], [C, Y], [C, X]].map(([o, a]) => pair(d.strongAssociations, o!, a!).effectiveAtomic), ['2000', '50', '10', '1']);
  const authorities = [...d.strongAssociations, ...d.weakAssociations].map((p: any) => p.authority);
  for (const ignored of [D, Z, W, H]) assert.ok(!authorities.includes(ignored), 'self, zero-balance and zero-allowance links create no edge');
  const frozen = pair(d.weakAssociations, E, V);
  assert.equal(frozen.suspended, true); assert.equal(frozen.state, 'FROZEN'); assert.equal(frozen.accounts[0].approvedAtomic, '600'); assert.equal(frozen.accounts[0].effectiveAtomic, '0');
  for (const owner of [C, F, G]) { const close = pair(d.weakAssociations, owner, CL); assert.equal(close.kind, 'CLOSE_AUTHORITY'); assert.equal(close.accounts.length, 1); assert.deepEqual(Object.keys(close.accounts[0]).sort(), ['account', 'balanceAtomic']); }
  const strong = d.graphs.strongOnly, weak = d.graphs.withObservedWeak;
  assert.deepEqual(strong.components[0].owners, [{ owner: B, balanceAtomic: '2100' }, { owner: A, balanceAtomic: '1500' }, { owner: C, balanceAtomic: '500' }, { owner: Y, balanceAtomic: '150' }]);
  assert.deepEqual(new Set(strong.components[0].authorities), new Set([X, Y])); assert.equal(strong.components[0].associations.length, 5);
  assert.deepEqual([strong.nontrivialComponents, strong.associatedOwners, strong.associatedHolderAtomic, strong.largestComponentShare], [1, 4, '4250', '0.425']);
  assert.deepEqual(strong.singletons, { count: 5, totalAtomic: '5750', share: '0.575', largest: { owner: H, balanceAtomic: '3100', share: '0.31' } });
  assert.equal(weak.nontrivialComponents, 2); assert.equal(weak.components[0].holderBalanceAtomic, '5300'); assert.equal(weak.components[0].holderShare, '0.53');
  assert.ok([F, G].every(o => weak.components[0].owners.some((r: any) => r.owner === o)));
  assert.deepEqual(weak.components[1].owners, [{ owner: E, balanceAtomic: '600' }]); assert.deepEqual(weak.components[1].authorities, [V]);
  assert.deepEqual(weak.singletons, { count: 2, totalAtomic: '4100', share: '0.41', largest: { owner: H, balanceAtomic: '3100', share: '0.31' } });
  assert.deepEqual(d.sensitivity, { largestComponentShare: { strongOnly: '0.425', withObservedWeak: '0.53' }, associatedHolderShare: { strongOnly: '0.425', withObservedWeak: '0.59' }, ownersAddedByWeak: 3 });
});

test('a complete population without explicit authorities is a known zero-association result', () => {
  const m = run(legacy([{ owner: A, amount: 7n }, { owner: B, amount: 3n, delegate: X, allowance: 0n }, { owner: C, amount: 0n, delegate: X, allowance: 9n }])), d = m.data as any;
  assert.equal(m.quality, 'KNOWN');
  assert.deepEqual(d.counts, { strongPairs: 0, strongAccounts: 0, strongAuthorities: 0, suspendedPairs: 0, closeAuthorityPairs: 0, closeAuthorityAccounts: 0, closeAuthorities: 0 });
  assert.deepEqual([d.population.owners, d.population.positiveOwners, d.approvedExposure.effectiveAtomic, d.approvedExposure.fractionOfSupply], [3, 2, '0', '0']);
  assert.deepEqual([d.graphs.strongOnly.components, d.graphs.strongOnly.largestComponentShare, d.sensitivity.ownersAddedByWeak], [[], '0', 0]);
  assert.deepEqual(d.graphs.withObservedWeak.singletons, { count: 2, totalAtomic: '10', share: '1', largest: { owner: A, balanceAtomic: '7', share: '0.7' } });
});

test('forged canonical receipt metadata, clocks, hashes and membership throw', () => {
  const b = legacy(LEGACY_ACCOUNTS), future = '2026-10-11T22:10:00.001Z', noRaw = { ...b.raw }; delete noRaw['rpc-holder-population'];
  const cases: Array<[Bundle, string]> = [
    [edit(b, 'rpc-holder-population', { contentHash: '0'.repeat(64) }), 'ADVISORY_TOPOLOGY_RECEIPT_HASH'],
    [edit(b, 'rpc-mint-raw', { scope: { operation: 'rpc-mint-raw', commitment: 'confirmed', mint: MINT } }), 'ADVISORY_TOPOLOGY_RECEIPT_SCOPE'],
    [edit(b, 'rpc-holder-population', { scope: { operation: 'rpc-holder-population', commitment: 'finalized', mint: X } }), 'ADVISORY_TOPOLOGY_RECEIPT_SCOPE'],
    [edit(b, 'rpc-genesis', { scope: { method: 'getGenesisHash', genesisHash: X } }), 'ADVISORY_TOPOLOGY_RECEIPT_SCOPE'],
    [edit(b, 'rpc-mint-raw', { sourceId: 'advisory-chain' }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, 'rpc-mint-raw', { sourceType: 'HISTORICAL_RECEIPT' }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, 'rpc-mint-raw', { accessMode: 'PAID_API' }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, 'rpc-mint-raw', { adapterVersion: 'live-v0' }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, 'rpc-holder-population', { retrievedAt: future, availableAt: future }), 'ADVISORY_TOPOLOGY_RECEIPT_TIME'],
    [edit(b, 'rpc-holder-population', { availableAt: cutoff }), 'ADVISORY_TOPOLOGY_RECEIPT_TIME'],
    [{ ...b, evidence: [...b.evidence, b.evidence[2]!] }, 'ADVISORY_TOPOLOGY_RECEIPT_DUPLICATE'],
    [{ ...b, raw: noRaw }, 'ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP'],
    [{ ...b, evidence: b.evidence.filter(e => e.id !== 'rpc-mint-raw') }, 'ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP'],
  ];
  for (const [bundle, code] of cases) assert.throws(() => run(bundle), { message: code }, code);
  assert.throws(() => deriveAuthorityTopology(token, 'yesterday', b.evidence, b.raw), { message: 'ADVISORY_TOPOLOGY_CUTOFF' });
  assert.throws(() => deriveAuthorityTopology({ chain: 'bsc', address: MINT }, cutoff, b.evidence, b.raw), { message: 'ADVISORY_TOPOLOGY_SCOPE' });
});

test('absent, remote, wrong-cluster and malformed canonical data stay explicit MISSING', () => {
  const b = legacy(LEGACY_ACCOUNTS), small: Acc[] = [{ owner: A, amount: 6n }, { owner: B, amount: 4n }];
  const cases: Array<[Bundle, string]> = [
    [without(b, 'rpc-holder-population'), 'RPC_HOLDER_POPULATION_UNAVAILABLE'],
    [without(b, 'rpc-genesis'), 'RPC_GENESIS_UNAVAILABLE'],
    [canonical(LEGACY, mintBase(10n), { items: items(small, LEGACY, baseAccount) }, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'), 'GENESIS_NOT_MAINNET'],
    [withRaw(b, 'rpc-holder-population', JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32010, message: 'excluded from account secondary indexes' } })), 'RPC_REMOTE_-32010'],
    [withRaw(b, 'rpc-mint-raw', envelope({ context: { slot: MINT_SLOT }, value: null })), 'MINT_ACCOUNT_MISSING'],
    [legacy(small, { mint: mintBase(10n, 0) }), 'RPC_SHAPE'],
    [legacy(small, { program: key(77) }), 'MINT_PROGRAM_UNSUPPORTED'],
    [legacy([{ owner: A, amount: 0n }], { supply: 0n }), 'MINT_SUPPLY_ZERO'],
    [legacy(small, { slot: MINT_SLOT - 1 }), 'RPC_SHAPE'],
    [legacy([{ owner: A, amount: 6n, state: 0 }, { owner: B, amount: 4n }]), 'RPC_SHAPE'],
    [legacy([{ owner: A, amount: 6n, delegateTag: 2 }, { owner: B, amount: 4n }]), 'TOKEN_ACCOUNT_OPTION_INVALID'],
    [legacy([{ owner: A, amount: 6n, pubkey: key(90) }, { owner: B, amount: 4n, pubkey: key(90) }]), 'RPC_SHAPE'],
    [legacy([{ owner: A, amount: 6n, mint: X }, { owner: B, amount: 4n }]), 'RPC_SHAPE'],
    [legacy(small, { supply: 11n }), 'HOLDER_SUPPLY_UNRECONCILED'],
  ];
  for (const [bundle, reason] of cases) assert.deepEqual(missing(bundle, reason).evidenceIds, bundle.evidence.map(e => e.id), reason);
});

test('details over the 2 MB bound become explicit MISSING with the summary only', () => {
  const accounts = Array.from({ length: 9000 }, (_, i): Acc => ({ owner: wide(i), amount: 1n, close: CL, pubkey: wide(20000 + i) }));
  const m = run(legacy(accounts)), d = m.data as any;
  assert.equal(m.quality, 'MISSING'); assert.equal(m.reasonCode, 'TOPOLOGY_OUTPUT_LIMIT_EXCEEDED'); assert.equal(d.status, 'UNRESOLVED');
  assert.equal(d.counts.closeAuthorityPairs, 9000); assert.ok(!('weakAssociations' in d) && !('graphs' in d));
});

test('Token-2022 full population is read once without slicing and certifies only allow-listed extensions', async () => {
  assert.equal(metadataMint(1n).length, 414);
  const b = t22(), { calls, fetcher } = mockFetch(() => new Response(b.fullRaw!, { status: 200 }));
  const receipts = await collectAuthorityTopology(token, b.raw['rpc-mint-raw'], RPC, fetcher, () => POP_AT);
  assert.equal(calls.length, 1); assert.equal(calls[0]!.url, RPC);
  assert.deepEqual(calls[0]!.body, { jsonrpc: '2.0', id: 1, method: 'getProgramAccounts', params: REQUEST.params });
  assert.ok(!('dataSlice' in (calls[0]!.body.params[1] as Record<string,unknown>)) && !JSON.stringify(calls[0]!.body).includes('dataSize'));
  assert.deepEqual(receipts, b.topology);
  const m = run(withTopology(canonicalOnly(b), receipts)), d = m.data as any;
  assert.equal(m.quality, 'KNOWN'); assert.deepEqual(m.evidenceIds, ['rpc-genesis', 'rpc-mint-raw', TOPOLOGY_ID]);
  assert.deepEqual([d.state.program, d.state.mintSlot, d.state.populationSlot, d.coverage.populationSource], [T22, MINT_SLOT, POP_SLOT, TOPOLOGY_ID]);
  assert.deepEqual(d.coverage.mintExtensions, ['METADATA_POINTER', 'TOKEN_METADATA']);
  assert.deepEqual([d.coverage.bareAccounts, d.coverage.extendedAccounts, d.coverage.dataLengths, d.coverage.accountExtensions], [1, 3, { 165: 1, 170: 1, 191: 1, 256: 1 }, { IMMUTABLE_OWNER: 3 }]);
  assert.deepEqual(d.population, { accounts: 4, positiveAccounts: 4, owners: 4, positiveOwners: 4, complete: true, reconciledToSupply: true });
  assert.deepEqual([d.approvedExposure.effectiveAtomic, d.approvedExposure.fractionOfSupply, d.counts.closeAuthorityPairs], ['3500', '0.35', 1]);
  assert.deepEqual(d.graphs.strongOnly.components[0].owners, [{ owner: B, balanceAtomic: '3000' }, { owner: C, balanceAtomic: '2000' }]);
  assert.equal(d.graphs.strongOnly.components[0].holderShare, '0.5');
});

test('the canonical 165-byte slice cannot certify a Token-2022 population, alone or posing as the full read', () => {
  const b = t22();
  assert.deepEqual(missing(canonicalOnly(b), 'TOKEN_2022_FULL_POPULATION_UNAVAILABLE').evidenceIds, ['rpc-genesis', 'rpc-mint-raw']);
  missing(withTopology(canonicalOnly(b), receiptsOf(b.raw['rpc-holder-population']!)), 'TOKEN_2022_ACCOUNT_DATA_SLICED');
});

test('legacy, invalid and unsupported mints plan no read; topology receipts for them are foreign', async () => {
  const { calls, fetcher } = mockFetch(() => { throw new Error('UNEXPECTED_READ'); }), valid = t22().topology!, empty = { rawArtifacts: {}, retrievedAt: {}, requests: {} };
  const multisigSizedMint=Buffer.alloc(355); mintBase(10000n).copy(multisigSizedMint); multisigSizedMint[165]=1;
  const unsupported: Array<[Bundle, string]> = [
    [canonical(T22, multisigSizedMint), 'TOKEN_2022_MINT_SIZE_INVALID'],
    [canonical(T22, metadataMint(10000n, tlv(12, 32))), 'TOKEN_2022_MINT_EXTENSION_12_UNSUPPORTED'],
    [canonical(T22, metadataMint(10000n, tlv(14, 64))), 'TOKEN_2022_MINT_EXTENSION_14_UNSUPPORTED'],
    [canonical(T22, metadataMint(10000n, tlv(9, 0))), 'TOKEN_2022_MINT_EXTENSION_9_UNSUPPORTED'],
    [canonical(T22, Buffer.concat([metadataMint(10000n), tlv(18, 64)])), 'RPC_SHAPE'],
    [canonical(T22, metadataMint(10000n).subarray(0, 410)), 'RPC_SHAPE'],
    [canonical(T22, metadataMint(10000n), undefined, GENESIS, { executable: true }), 'MINT_ACCOUNT_EXECUTABLE'],
    [canonical(T22, mintBase(10000n), undefined, GENESIS, { space: 414 }), 'MINT_ACCOUNT_DATA_SLICED'],
  ];
  for (const [bundle, reason] of unsupported) {
    assert.deepEqual(await collectAuthorityTopology(token, bundle.raw['rpc-mint-raw'], RPC, fetcher, () => POP_AT), empty, reason);
    missing(bundle, reason);
    assert.throws(() => run(withTopology(bundle, valid)), { message: 'ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP' }, reason);
  }
  for (const mintRaw of [legacy([{ owner: A, amount: 1n }]).raw['rpc-mint-raw'], undefined, '{}', envelope({ context: { slot: MINT_SLOT }, value: null })])
    assert.deepEqual(await collectAuthorityTopology(token, mintRaw, RPC, fetcher, () => POP_AT), empty);
  assert.equal(calls.length, 0);
  await assert.rejects(collectAuthorityTopology({ chain: 'bsc', address: MINT }, undefined, RPC, fetcher, () => POP_AT), { message: 'ADVISORY_TOPOLOGY_SCOPE' });
});

test('malformed or unsupported full Token-2022 accounts fail closed as MISSING', () => {
  const at = (i: number, change: Partial<Acc>) => T22_ACCOUNTS.map((a, j) => j === i ? { ...a, ...change } : a);
  const cases: Array<[Bundle, string]> = [
    [t22({ accounts: at(2, { ext: tlv(15, 8) }) }), 'TOKEN_2022_ACCOUNT_EXTENSION_15_UNSUPPORTED'],
    [t22({ accounts: at(2, { ext: tlv(13, 0) }) }), 'TOKEN_2022_ACCOUNT_EXTENSION_13_UNSUPPORTED'],
    [t22({ accounts: at(2, { ext: Buffer.concat([IMMUTABLE, IMMUTABLE]) }) }), 'TOKEN_2022_ACCOUNT_TLV_MALFORMED'],
    [t22({ accounts: at(2, { ext: Buffer.from([7, 0, 100, 0]) }) }), 'TOKEN_2022_ACCOUNT_TLV_MALFORMED'],
    [t22({ accounts: at(2, { length: 168, ext: Buffer.from([7, 0]) }) }), 'TOKEN_2022_ACCOUNT_TLV_TRUNCATED'],
    [t22({ accounts: at(1, { accountType: 1 }) }), 'TOKEN_2022_ACCOUNT_TYPE_INVALID'],
    [t22({ accounts: at(1, { length: 355 }) }), 'TOKEN_2022_ACCOUNT_SIZE_INVALID'],
    [t22({ mutate: list => { list[3].account.space = 300; } }), 'TOKEN_2022_ACCOUNT_DATA_SLICED'],
    [t22({ mutate: list => { list[0].account.owner = LEGACY; } }), 'RPC_SHAPE'],
    [t22({ mutate: list => { list[0].account.executable = true; } }), 'RPC_SHAPE'],
    [t22({ slot: MINT_SLOT - 1 }), 'RPC_SHAPE'],
    [t22({ accounts: at(0, { state: 0 }) }), 'RPC_SHAPE'],
    [t22({ supply: 10001n }), 'HOLDER_SUPPLY_UNRECONCILED'],
  ];
  for (const [bundle, reason] of cases) assert.deepEqual(missing(bundle, reason).evidenceIds, ['rpc-genesis', 'rpc-mint-raw', TOPOLOGY_ID], reason);
});

test('forged topology membership, requests, clocks and records throw', () => {
  const b = t22(), raw = b.fullRaw!, r = b.topology!;
  const sliced = { method: 'getProgramAccounts', params: [T22, { ...(REQUEST.params[1] as object), dataSlice: { offset: 0, length: 165 } }] };
  const cases: Array<[Bundle, string]> = [
    [{ ...b, topology: { ...r, rawArtifacts: { ...r.rawArtifacts, extra: '{}' } } }, 'ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP'],
    [{ ...b, topology: { ...r, retrievedAt: {} } }, 'ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP'],
    [{ ...b, evidence: b.evidence.filter(e => e.id !== TOPOLOGY_ID) }, 'ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP'],
    [edit(b, TOPOLOGY_ID, { id: 'advisory-topology-other' }), 'ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP'],
    [withTopology(legacy(LEGACY_ACCOUNTS), r), 'ADVISORY_TOPOLOGY_RECEIPT_MEMBERSHIP'],
    [withTopology(b, receiptsOf(raw, POP_AT, sliced)), 'ADVISORY_TOPOLOGY_REQUEST'],
    [withTopology(b, receiptsOf(raw, '2026-10-11T21:59:59.999Z')), 'ADVISORY_TOPOLOGY_RECEIPT_TIME'],
    [withTopology(b, receiptsOf(raw, '2026-10-11T22:10:00.001Z')), 'ADVISORY_TOPOLOGY_RECEIPT_TIME'],
    [edit(b, TOPOLOGY_ID, { retrievedAt: '2026-10-11T22:00:06.000Z', availableAt: '2026-10-11T22:00:06.000Z' }), 'ADVISORY_TOPOLOGY_RECEIPT_TIME'],
    [edit(b, TOPOLOGY_ID, { sourceType: 'JSON_RPC' }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, TOPOLOGY_ID, { accessMode: 'PAID_API' }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, TOPOLOGY_ID, { scope: { request: sliced } }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, TOPOLOGY_ID, { adapterVersion: 'FORGED' }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, TOPOLOGY_ID, { adapterVersion: undefined as unknown as string }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, TOPOLOGY_ID, { scope: { request: REQUEST, extra: 'FORGED' } }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, TOPOLOGY_ID, { scope: {} }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, TOPOLOGY_ID, { scope: undefined as unknown as EvidenceRecord['scope'] }), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [edit(b, TOPOLOGY_ID, { contentHash: sha('forged') }), 'ADVISORY_TOPOLOGY_RECEIPT_HASH'],
  ];
  for (const [bundle, code] of cases) assert.throws(() => run(bundle), { message: code }, code);
});

test('collector retains RPC failures and cancellation without retries; the deriver reports them as MISSING', async () => {
  const b = t22(), mintRaw = b.raw['rpc-mint-raw'];
  const remote = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32010, message: 'excluded from account secondary indexes' } });
  const failures: Array<[() => Response, string, number, AbortSignal | undefined]> = [
    [() => { throw new Error('COLLECTION_BUDGET'); }, 'RPC_TRANSPORT', 1, undefined],
    [() => new Response('unavailable', { status: 500 }), 'RPC_HTTP_500', 1, undefined],
    [() => new Response(remote, { status: 200 }), 'RPC_REMOTE_-32010', 1, undefined],
    [() => new Response(b.fullRaw!, { status: 200 }), 'RPC_TRANSPORT', 0, AbortSignal.abort()],
  ];
  for (const [respond, reason, reads, signal] of failures) {
    const { calls, fetcher } = mockFetch(respond);
    const receipts = await collectAuthorityTopology(token, mintRaw, RPC, fetcher, () => POP_AT, signal);
    assert.equal(calls.length, reads, reason);
    assert.deepEqual([receipts.requests, receipts.retrievedAt], [{ [KEY]: REQUEST }, { [KEY]: POP_AT }], reason);
    assert.equal(receipts.rawArtifacts[KEY], reason === 'RPC_REMOTE_-32010' ? remote : JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: reason } }), reason);
    assert.deepEqual(missing(withTopology(canonicalOnly(b), receipts), reason).evidenceIds, ['rpc-genesis', 'rpc-mint-raw', TOPOLOGY_ID]);
  }
});

test('full canonical Token-2022 population is reused under its full-data scope without a duplicate artifact',()=>{
  const b=t22(),canonical=canonicalOnly(b),raw=b.fullRaw!;
  const scoped=edit(withRaw(canonical,'rpc-holder-population',raw),'rpc-holder-population',{scope:{operation:'rpc-holder-population',commitment:'finalized',mint:MINT,fullAccountData:true}});
  const m=run(scoped);assert.equal(m.quality,'KNOWN');assert.equal((m.data as any).coverage.populationSource,'rpc-holder-population');assert.deepEqual(m.evidenceIds,['rpc-genesis','rpc-mint-raw','rpc-holder-population']);assert.equal((m.data as any).approvedExposure.effectiveAtomic,'3500');
  missing(edit(canonical,'rpc-holder-population',{scope:{operation:'rpc-holder-population',commitment:'finalized',mint:MINT,fullAccountData:true}}),'TOKEN_2022_ACCOUNT_DATA_SLICED');
});

// Proof v22: the canonical holder population is stored as one holder-population-archive-v1 container; O21 replays only the exact original body.
const HOLDER = 'rpc-holder-population';
const archived = (b: Bundle): Bundle => edit(withRaw(b, HOLDER, archiveHolderPopulation(b.raw[HOLDER]!)), HOLDER, { adapterVersion: HOLDER_ARCHIVE_ADAPTER });
const runArchived = (b: Bundle) => deriveAuthorityTopology(token, cutoff, b.evidence, b.raw, b.topology, true);

test('a holder archive replays the exact original JSON-RPC body to the identical O21 result', () => {
  const plain = legacy(LEGACY_ACCOUNTS), stored = archived(plain), source = plain.raw[HOLDER]!, container = JSON.parse(stored.raw[HOLDER]!);
  assert.deepEqual(Object.keys(container), ['method', 'encoding', 'sourceBytes', 'sourceHash', 'data']);
  assert.deepEqual([container.method, container.encoding, container.sourceBytes, container.sourceHash], ['advisory-demand-rpc-archive-v1', 'DEFLATE_RAW_BASE64', Buffer.byteLength(source), sha(source)]);
  assert.equal(unpackHolderPopulation(stored.raw[HOLDER]!), source);
  const m = runArchived(stored); assert.equal(m.quality, 'KNOWN'); assert.deepEqual(m, run(plain));
  // The full-data Token-2022 canonical read and a retained remote error keep their exact meaning through the archive.
  const t = t22(), full = edit(withRaw(canonicalOnly(t), HOLDER, t.fullRaw!), HOLDER, { scope: { operation: HOLDER, commitment: 'finalized', mint: MINT, fullAccountData: true } });
  assert.equal(run(full).quality, 'KNOWN'); assert.deepEqual(runArchived(archived(full)), run(full));
  const remote = withRaw(plain, HOLDER, JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32010, message: 'excluded from account secondary indexes' } }));
  assert.equal(run(remote).reasonCode, 'RPC_REMOTE_-32010'); assert.deepEqual(runArchived(archived(remote)), run(remote));
  // A larger population of the same JSON-RPC shape compresses well below its source bytes and still replays identically.
  const many = legacy(Array.from({ length: 6000 }, (_, i): Acc => ({ owner: wide(i), amount: 1n, pubkey: wide(50000 + i) }))), packed = archived(many);
  assert.ok(Buffer.byteLength(packed.raw[HOLDER]!) * 2 < Buffer.byteLength(many.raw[HOLDER]!)); assert.deepEqual(runArchived(packed), run(many));
});

test('holder archive dispatch is exclusive and forged or nested containers never certify a population', () => {
  const plain = legacy(LEGACY_ACCOUNTS), stored = archived(plain), source = plain.raw[HOLDER]!, container = JSON.parse(stored.raw[HOLDER]!);
  const forge = (c: Record<string, unknown>) => withRaw(stored, HOLDER, JSON.stringify(c));
  const cases: Array<[() => unknown, string]> = [
    [() => run(stored), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [() => runArchived(plain), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [() => runArchived(edit(plain, HOLDER, { adapterVersion: HOLDER_ARCHIVE_ADAPTER })), 'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
    [() => runArchived(edit(stored, 'rpc-mint-raw', { adapterVersion: HOLDER_ARCHIVE_ADAPTER })), 'ADVISORY_TOPOLOGY_RECEIPT_METADATA'],
    [() => runArchived(edit(stored, HOLDER, { contentHash: sha(source) })), 'ADVISORY_TOPOLOGY_RECEIPT_HASH'],
    [() => runArchived(edit(stored, HOLDER, { scope: { operation: HOLDER, commitment: 'finalized', mint: X } })), 'ADVISORY_TOPOLOGY_RECEIPT_SCOPE'],
    [() => runArchived(forge({ ...container, sourceHash: sha('forged') })), 'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
    [() => runArchived(forge({ ...container, sourceBytes: container.sourceBytes + 1 })), 'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
    [() => runArchived(forge({ ...container, sourceBytes: HOLDER_ARCHIVE_SOURCE_BYTES + 1 })), 'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
    [() => runArchived(forge({ ...container, method: HOLDER_ARCHIVE_ADAPTER })), 'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
    [() => runArchived(forge({ ...container, data: `${container.data.slice(0, -8)}AAAAAAAA` })), 'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
    [() => runArchived(forge({ data: container.data, method: container.method, encoding: container.encoding, sourceBytes: container.sourceBytes, sourceHash: container.sourceHash })), 'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
    [() => runArchived(withRaw(stored, HOLDER, ` ${stored.raw[HOLDER]}`)), 'ADVISORY_TOPOLOGY_HOLDER_ARCHIVE_INVALID'],
  ];
  for (const [call, code] of cases) assert.throws(call, { message: code }, code);
  // Archives are single-level: a nested container is never unwrapped twice, so its inner text is not a JSON-RPC body and O21 stays MISSING.
  const nested = runArchived(withRaw(stored, HOLDER, archiveHolderPopulation(stored.raw[HOLDER]!)));
  assert.deepEqual([nested.quality, nested.reasonCode], ['MISSING', 'RPC_SHAPE']);
});

test('holder archive refuses bodies above the unchanged 20 MB source ceiling and round-trips one at it', () => {
  assert.equal(HOLDER_ARCHIVE_SOURCE_BYTES, 20_000_000);
  for (const body of ['', 'x'.repeat(HOLDER_ARCHIVE_SOURCE_BYTES + 1), 'é'.repeat(HOLDER_ARCHIVE_SOURCE_BYTES / 2 + 1)]) assert.throws(() => archiveHolderPopulation(body), { message: 'HOLDER_ARCHIVE_SOURCE_LIMIT' });
  const edge = 'x'.repeat(HOLDER_ARCHIVE_SOURCE_BYTES), stored = archiveHolderPopulation(edge);
  assert.ok(Buffer.byteLength(stored) < 100_000); assert.equal(unpackHolderPopulation(stored), edge);
});
