// Integration tests for opt-in executable liquidity across Live collection, Service persistence, CLI and report.
// Labelling: every transport envelope, request id, run clock and USD reference row below is CONSTRUCTED conformance data.
// The retained account and program-account bytes in the maintained fixture are genuine public data; nothing here is a live or simulated certification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { runCli } from '../src/cli.js';
import { EXEC_LIQ_REFERENCE_CASH_POOLS, execLiqAccountsRequest, execLiqInventoryRequest, validateExecutableLiquidity } from '../src/providers/executable-liquidity.js';
import type { ExecLiqFrameId } from '../src/domain/executable-liquidity.js';
import type { Profile, TokenRef } from '../src/domain/contracts.js';
import { a29LiveFetcher } from './a29-fixtures.js';

type Loose = any;
const FIXTURE_SHA256 = 'f9a2917a0921562b132324ed979ab3d8f8dce50ba4f94320c8a4248033d9c0dd';
const fixtureBytes = readFileSync(new URL('../../tests/fixtures/executable-liquidity-c5.json', import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
/** Fixture key order is the pinned frame order. */
const FRAMES = Object.keys(fixture.gpa) as ExecLiqFrameId[];
const C5: TokenRef = { chain: 'solana', address: 'C5xph2yL6gMdxmuLGxJBkGpmuDFfyi5fqkBNhvL6pump' };
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
/** Genuine retained Clock unix timestamp 1793008129 (2026-10-26T09:48:49Z). */
const BANK_CLOCK_MS = 1_793_008_129_000;
/** CONSTRUCTED run clock, 11 s after the genuine bank Clock and inside its 30 s expiry. */
const AT = '2026-10-26T09:49:00.000Z';
/** CONSTRUCTED foreign-network (devnet) genesis, used only for the NOT_PRIMARY branch. */
const FOREIGN_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/** CONSTRUCTED mint-as-base USD reference rows; never inferred from C5 priceNative or a stable peg. */
const USD_REFS = [
  { symbol: 'WSOL', mint: 'So11111111111111111111111111111111111111112', priceUsd: '101.37' },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', priceUsd: '0.9994' },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', priceUsd: '0.9983' },
  { symbol: 'WBTC', mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', priceUsd: '80300.26' },
];
const OLD_GET = ['/token-pairs/', 'include=base_token', 'ohlcv', 'coinbase', 'llama', '/orders/'];
const isOwned = (id: string) => id.startsWith('execliq-');
const sansId = (body: Loose) => { const { id: _id, ...rest } = body ?? {}; return rest; };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const sha256 = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');

type TransportLog = { mode: 'ORDINARY' | 'EXECLIQ'; genesis: number; foreignSent: boolean; frames: string[]; bankKeys: string[][]; usd: string[]; violations: string[] };
/** Ordinary reads go to the existing a29LiveFetcher unchanged; from the first pinned inventory frame on, only the new collector's own reads are answered. */
function transport(options: { foreignGenesisAt?: number } = {}) {
  const ordinary = a29LiveFetcher(C5.address, AT);
  const log: TransportLog = { mode: 'ORDINARY', genesis: 0, foreignSent: false, frames: [], bankKeys: [], usd: [], violations: [] };
  // A terminal 4xx stops the collector retrying until the deadline; the recorded violation fails the test.
  const reject = (why: string) => { log.violations.push(why); return json({ error: 'CONSTRUCTED_CONFORMANCE_REJECT' }, 400); };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input), body = init?.method === 'POST' ? JSON.parse(String(init.body)) : undefined;
    if (log.foreignSent) return reject(`request after the foreign genesis: ${body?.method ?? url}`);
    if (Array.isArray(body)) return reject('batch JSON-RPC request');
    if (body?.method === 'getGenesisHash') {
      log.genesis++;
      if (log.mode === 'EXECLIQ') return reject('getGenesisHash after the inventory');
      if (options.foreignGenesisAt === log.genesis) { log.foreignSent = true; return json({ jsonrpc: '2.0', id: body.id, result: FOREIGN_GENESIS }); }
      return ordinary(input, init);
    }
    if (body?.method === 'getProgramAccounts') {
      const frame = FRAMES.find(id => isDeepStrictEqual(sansId(body), sansId(execLiqInventoryRequest(C5, id))));
      if (!frame) return log.mode === 'EXECLIQ' ? reject('unpinned getProgramAccounts') : ordinary(input, init);
      log.mode = 'EXECLIQ'; log.frames.push(frame);
      return json({ ...fixture.gpa[frame].body, id: body.id });
    }
    if (log.mode === 'ORDINARY') return ordinary(input, init);
    if (body?.method === 'getMultipleAccounts') {
      const keys: unknown = body.params?.[0], minContextSlot = body.params?.[1]?.minContextSlot;
      if (!Array.isArray(keys) || !keys.every(k => typeof k === 'string')) return reject('getMultipleAccounts without string keys');
      if (!isDeepStrictEqual(sansId(body), sansId(execLiqAccountsRequest(keys as string[], minContextSlot)))) return reject('getMultipleAccounts body differs from execLiqAccountsRequest');
      // Absent and observed-null differ: only retained keys are answered, never absent => null.
      const missing = keys.filter(k => !Object.hasOwn(fixture.accounts, k));
      if (missing.length) return reject(`unretained account keys ${missing.join(',')}`);
      log.bankKeys.push(keys);
      return json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: fixture.sourceContextSlot }, value: keys.map(k => fixture.accounts[k]) } });
    }
    if (body) return reject(`unexpected RPC ${body.method}`);
    if (OLD_GET.some(p => url.includes(p))) return reject(`ordinary collector read after the capture: ${url}`);
    if (!new URL(url).hostname.endsWith('dexscreener.com')) return reject(`unexpected host ${new URL(url).hostname}`);
    const rows = USD_REFS.filter(r => url.includes(r.mint)).map(r => ({ chainId: 'solana', dexId: 'constructed', pairAddress: r.mint, baseToken: { address: r.mint, symbol: r.symbol }, quoteToken: { address: '11111111111111111111111111111111', symbol: 'CONSTRUCTED' }, priceUsd: r.priceUsd, liquidity: { usd: 1_000_000 } }));
    if (!rows.length) return reject(`USD request names no constructed reference mint: ${url}`);
    log.usd.push(url);
    return json(url.includes('/latest/dex/') ? { schemaVersion: '1.0.0', pairs: rows } : rows);
  };
  return { fetcher, log };
}

type Run = { b: Loose; log: TransportLog };
async function collect(profile: Profile, origins: Record<string, string>, executableLiquidity: boolean | undefined, options: { foreignGenesisAt?: number } = {}): Promise<Run> {
  const t = transport(options);
  const b = await collectLiveToken(C5, { profile, origins, semanticEnabled: false, advisoryEnabled: false, fetcher: t.fetcher, now: () => AT, ...(executableLiquidity === undefined ? {} : { executableLiquidity }) });
  return { b, log: t.log };
}

async function withDir<T>(fn: (dir: string, db: string, config: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'execliq-integration-'));
  try { return await fn(dir, join(dir, 'dd.sqlite'), join(dir, 'config.json')); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function withService<T>(file: string, fn: (s: Service) => T): T { const s = new Service(file); try { return fn(s); } finally { s.close(); } }
function snapshotRows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT id,payload,semantic FROM snapshots').all().map(r => ({ id: String(r.id), payload: String(r.payload), policyVersion: JSON.parse(String(r.semantic)).policyVersion as string })); } finally { db.close(); }
}
async function cli(argv: string[], fetcher?: typeof fetch) {
  let out = '', err = '';
  const spies = { network: 0, executor: 0 };
  const exit = await runCli(argv, { env: {}, isInteractive: false,
    fetcher: fetcher ?? (async () => { spies.network++; throw Error('OFFLINE_NETWORK_DENIED'); }),
    semanticExecutor: async () => { spies.executor++; throw Error('OFFLINE_EXECUTOR_DENIED'); },
    now: () => AT, stdout: t => { out += t; }, stderr: t => { err += t; } });
  return { exit, out, err, spies };
}

const once = <T>(f: () => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= f()); };
/** The profile and origins come from an actual keyless CLI partial run, so no preset is invented here. */
const runs = once(async () => {
  const { profile, origins } = await withDir(async (_dir, db, config) => {
    const t = transport(), r = await cli(['analyze', C5.address, '--partial', '--json', '--db', db, '--config', config], t.fetcher);
    assert.equal(r.exit, 0, r.err); assert.deepEqual([t.log.violations, t.log.frames], [[], []]);
    const s = JSON.parse(r.out);
    return { profile: s.details.profile as Profile, origins: s.details.origins as Record<string, string> };
  });
  const d = await collect(profile, origins, undefined);
  const f = await collect(profile, origins, false);
  const x = await collect(profile, origins, true);
  const n = await collect(profile, origins, true, { foreignGenesisAt: d.log.genesis + 1 });
  return { d, f, x, n };
});

const oldPart = (b: Loose) => {
  const { executableLiquidity: _e, ...details } = b.details;
  return { features: b.features, observations: b.observations, market: b.market, collection: b.collection, semantic: b.semantic, profile: b.profile, thesis: b.thesis,
    evidence: b.evidence.filter((e: Loose) => !isOwned(e.id)), raw: Object.fromEntries(Object.entries(b.rawArtifacts).filter(([id]) => !isOwned(id))), details };
};
const stripOwned = (b: Loose) => {
  const c = structuredClone(b);
  c.evidence = c.evidence.filter((e: Loose) => !isOwned(e.id));
  for (const id of Object.keys(c.rawArtifacts)) if (isOwned(id)) delete c.rawArtifacts[id];
  delete c.details.executableLiquidity;
  return c;
};
const reqSequence = (b: Loose): number[] => b.evidence.map((e: Loose) => /^execliq-req-([1-9][0-9]*)$/.exec(e.id)?.[1]).filter(Boolean).map(Number);
const rejectsOwned = (e: unknown) => e instanceof Error && !(e instanceof TypeError) && /^EXEC_LIQ_PROOF_INVALID(:[A-Z][A-Z0-9_]{0,63})?$/.test(e.message);
const blockOf = (lines: string[], start: number) => { const out = [lines[start]]; for (let i = start + 1; i < lines.length && lines[i].startsWith('  '); i++) out.push(lines[i]); return out; };
/** Parses a rendered decimal amount back to integer atoms, independent of how trailing zeros or grouping are rendered. */
const atomsOf = (text: string, decimals: number) => {
  const [i, f = ''] = text.replace(/,/g, '').split('.');
  assert.ok(/^[0-9]+$/.test(i) && /^[0-9]*$/.test(f) && f.length <= decimals, text);
  return BigInt(i + f.padEnd(decimals, '0'));
};

test('the maintained C5 fixture is the described public capture', () => {
  assert.equal(sha256(fixtureBytes), FIXTURE_SHA256);
  assert.deepEqual(fixture.token, C5);
  assert.equal(fixture.sourceContextSlot, 461618922);
  assert.deepEqual(FRAMES.map(id => fixture.gpa[id].body.result.value.length), [2, 27, 7, 0, 9, 11]);
  assert.equal(Object.keys(fixture.accounts).length, 91);
  assert.ok(Object.hasOwn(fixture.accounts, CLOCK_SYSVAR));
});

test('default and explicit false add zero executable-liquidity frames, records or details', async () => {
  const { d, f } = await runs();
  for (const { b, log } of [d, f]) {
    assert.deepEqual([log.violations, log.frames, log.usd, log.mode], [[], [], [], 'ORDINARY']);
    assert.equal(b.cutoff, AT);
    assert.deepEqual(b.evidence.filter((e: Loose) => isOwned(e.id)), []);
    assert.deepEqual(Object.keys(b.rawArtifacts).filter(isOwned), []);
    assert.equal('executableLiquidity' in b.details, false);
    assert.equal(b.details.advisory, undefined); assert.equal(b.semantic.status, 'NOT_REQUESTED');
    assert.deepEqual(validateExecutableLiquidity(b), { ok: true, claim: 'ABSENT' });
  }
  assert.deepEqual(f.b, d.b);
});

test('opt-in C5 capture is PRIMARY_KNOWN over every fixture cash route while old components stay equal at the same cutoff', async () => {
  const { d, x } = await runs(), b = x.b, facts = b.details.executableLiquidity;
  assert.deepEqual(x.log.violations, []);
  assert.deepEqual([...new Set(x.log.frames)].sort(), [...FRAMES].sort());
  assert.ok(x.log.bankKeys.some(keys => keys.includes(CLOCK_SYSVAR)), 'the bank includes Clock');
  assert.ok(x.log.usd.length >= 1);
  assert.equal(x.log.genesis, d.log.genesis + 1, 'one new genesis read, answered with the same constructed mainnet hash');
  // Old components are deeply equal; the whole snapshot hash may differ because new content is added.
  assert.equal(b.cutoff, d.b.cutoff);
  assert.deepEqual(oldPart(b), oldPart(d.b));
  assert.deepEqual(b.evidence.slice(0, d.b.evidence.length), d.b.evidence, 'owned records are appended after every existing record');
  const owned = b.evidence.slice(d.b.evidence.length);
  assert.ok(owned.length >= FRAMES.length + 4 && owned.every((e: Loose) => isOwned(e.id)));
  assert.equal(owned.at(-1).id, 'execliq-derivation');
  const seq = reqSequence(b); assert.deepEqual(seq, seq.map((_, i) => i + 1));
  for (const e of owned) {
    assert.ok(['execliq-solana-rpc', 'execliq-dexscreener', 'execliq-collector'].includes(e.sourceId), e.id);
    assert.ok(Date.parse(e.availableAt) <= Date.parse(AT) && Date.parse(e.retrievedAt) <= Date.parse(AT), e.id);
    assert.equal(sha256(b.rawArtifacts[e.id]), e.contentHash, e.id);
  }
  const derivation = owned.at(-1);
  assert.deepEqual([derivation.sourceId, derivation.sourceType, derivation.accessMode, derivation.retrievedAt, derivation.availableAt], ['execliq-collector', 'CALCULATION', 'LOCAL_DERIVED', AT, AT]);
  assert.deepEqual(JSON.parse(b.rawArtifacts['execliq-derivation']), facts);
  assert.equal(facts.cutoff, AT); assert.equal(facts.impactBps, 300);
  assert.equal(facts.aggregate.status, 'PRIMARY_KNOWN');
  const pools = facts.routes.map((r: Loose) => r.pool);
  assert.deepEqual(facts.inventory.cashPools, pools);
  // 17 is this fixture's expected current count only; production has no count gate.
  assert.equal(pools.length, 17);
  assert.deepEqual([...pools].sort(), [...EXEC_LIQ_REFERENCE_CASH_POOLS].sort());
  assert.ok(facts.routes.every((r: Loose) => r.outcome.status === 'KNOWN'));
  assert.deepEqual(facts.inventory.comparison, { referenceId: 'exec-liq-C5-2026-10-26-accepted-baseline', added: [], vanished: [] });
  assert.equal(new Set(facts.inventory.frames.flatMap((f: Loose) => f.pools)).size, 56);
  assert.deepEqual(Object.fromEntries(facts.inventory.frames.map((f: Loose) => [f.frameId, f.pools.length])), Object.fromEntries(FRAMES.map(id => [id, fixture.gpa[id].body.result.value.length])));
  assert.equal(facts.bank.slot, fixture.sourceContextSlot);
  assert.equal(Date.parse(facts.freshness.bankClockAt), BANK_CLOCK_MS);
  assert.equal(facts.freshness.freshAtCutoff, true);
  assert.ok(Date.parse(facts.freshness.expiresAt) > Date.parse(AT) && Date.parse(facts.freshness.expiresAt) <= BANK_CLOCK_MS + 30_000);
  assert.equal(facts.aggregate.chosenInputSumAtoms, facts.inputDomain.chosenInputSumAtoms);
  for (const asset of facts.aggregate.assets) {
    const ref = USD_REFS.find(r => r.mint === asset.outputMint);
    assert.ok(ref, `cash mint ${asset.outputMint} is outside the constructed USD table`);
    assert.equal(facts.usd.refs.find((r: Loose) => r.mint === asset.outputMint)?.priceUsdText, ref.priceUsd);
  }
  const v = validateExecutableLiquidity(b);
  if (!v.ok || v.claim !== 'PRESENT') assert.fail(`validator: ${JSON.stringify(v)}`);
  assert.deepEqual(v.facts, facts);
  assert.equal(b.details.advisory, undefined); assert.equal(b.semantic.status, 'NOT_REQUESTED');
});

test('Service persists idempotently, survives reopen and replays offline through runCli at the original cutoff', async () => {
  const { d, x } = await runs();
  await withDir(async (_dir, db, config) => {
    let saved!: Loose, base!: Loose;
    withService(db, s => {
      base = s.analyzeLive(structuredClone(d.b));
      saved = s.analyzeLive(structuredClone(x.b));
      assert.equal(s.analyzeLive(structuredClone(x.b)).id, saved.id, 'idempotent reanalysis');
      assert.notEqual(saved.hash, base.hash);
      assert.deepEqual(s.show(saved.id), saved); assert.deepEqual(s.replay(saved.id), saved);
    });
    assert.equal(saved.cutoff, AT);
    assert.deepEqual(saved.details.executableLiquidity, x.b.details.executableLiquidity);
    assert.deepEqual(saved.evidence.filter((e: Loose) => isOwned(e.id)), x.b.evidence.filter((e: Loose) => isOwned(e.id)));
    // No promotion: the entry result, policy features and policy version are those of the ordinary run.
    assert.deepEqual(saved.result, base.result);
    assert.deepEqual(saved.features, base.features);
    const rows = snapshotRows(db);
    assert.equal(rows.length, 2);
    assert.equal(rows.find(r => r.id === saved.id)!.policyVersion, rows.find(r => r.id === base.id)!.policyVersion);
    const payload = rows.find(r => r.id === saved.id)!.payload;
    assert.equal(JSON.stringify(saved), payload);
    withService(db, s => { assert.deepEqual(s.show(saved.id), saved); assert.deepEqual(s.replay(saved.id), saved); });
    for (const cmd of ['show', 'replay']) {
      const r = await cli([cmd, saved.id, '--db', db, '--config', config, '--json']);
      assert.equal(r.exit, 0, r.err);
      assert.equal(JSON.stringify(JSON.parse(r.out)), payload, `${cmd} payload is byte-equivalent`);
      assert.deepEqual(r.spies, { network: 0, executor: 0 });
      // Replay keeps the original cutoff and expiry; it never renews freshness.
      assert.deepEqual(JSON.parse(r.out).details.executableLiquidity.freshness, x.b.details.executableLiquidity.freshness);
    }
    assert.equal(existsSync(config), false, 'offline show/replay writes no config');
  });
});

test('Service rejects owned-namespace tampering and accepts the fully stripped ordinary bundle', async () => {
  const { d, x } = await runs();
  const owned: string[] = x.b.evidence.filter((e: Loose) => isOwned(e.id)).map((e: Loose) => e.id);
  const tamper = (f: (b: Loose) => void) => { const b = structuredClone(x.b); f(b); return b; };
  const drop = (b: Loose, ids: string[]) => { b.evidence = b.evidence.filter((e: Loose) => !ids.includes(e.id)); for (const id of ids) delete b.rawArtifacts[id]; };
  const bump = (b: Loose) => { const n = b.details.executableLiquidity.aggregate.netUsd; n.num = (BigInt(n.num) + 1n).toString(); };
  const cases: [string, Loose][] = [
    ['retained indicator without owned proof', tamper(b => drop(b, owned))],
    ['owned records without detail', tamper(b => { delete b.details.executableLiquidity; })],
    ['partial strip of one owned request', tamper(b => drop(b, ['execliq-req-2']))],
    ['forged cached value', tamper(bump)],
    ['forged cached value with a re-hashed derivation', tamper(b => {
      bump(b);
      const raw = JSON.stringify(b.details.executableLiquidity);
      b.rawArtifacts['execliq-derivation'] = raw;
      b.evidence.find((e: Loose) => e.id === 'execliq-derivation').contentHash = sha256(raw);
    })],
    ['old component citing an owned record', tamper(b => {
      const target = b.features[0] ?? b.observations[0];
      assert.ok(target, 'the ordinary bundle has an old component to cite from');
      target.evidenceIds = [...target.evidenceIds, 'execliq-req-1'];
    })],
  ];
  await withDir(async (_dir, db) => {
    withService(db, s => {
      for (const [name, bad] of cases) assert.throws(() => s.analyzeLive(bad), (e: unknown) => rejectsOwned(e) || assert.fail(`${name}: ${String(e)}`), name);
      const stripped = stripOwned(x.b);
      assert.deepEqual(stripped, d.b, 'stripping the whole namespace leaves exactly the ordinary partial bundle');
      const kept = s.analyzeLive(stripped);
      assert.equal(kept.details!.executableLiquidity, undefined);
      assert.equal(s.analyzeLive(structuredClone(d.b)).id, kept.id);
    });
    assert.equal(snapshotRows(db).length, 1, 'no rejected bundle was saved');
  });
});

test('the genuine indicator alone exceeds the ordinary details cap, which still binds the ordinary portion of both bundles', async () => {
  const { d, x } = await runs();
  const { executableLiquidity: facts, ...ordinary } = x.b.details;
  // Sizes of the unchanged 17-route fixture: the reconstructed indicator by itself is larger than the historical cap, the rest is not.
  assert.ok(JSON.stringify(facts).length > 2_000_000, 'the genuine indicator exceeds 2M');
  assert.ok(JSON.stringify(ordinary).length < 2_000_000, 'the ordinary portion stays under 2M');
  assert.deepEqual(ordinary, d.b.details, 'excluding the one field leaves exactly the ordinary details');
  const oversize = (b: Loose) => {
    const c = structuredClone(b), key = Object.keys(c.details.origins)[0];
    assert.ok(key, 'the ordinary details carry an origin');
    c.details.origins[key] += 'x'.repeat(2_000_001);
    return c;
  };
  await withDir(async (_dir, db) => {
    withService(db, s => {
      for (const [name, bad] of [['ordinary bundle', oversize(d.b)], ['full valid indicator bundle', oversize(x.b)]] as [string, Loose][])
        assert.throws(() => s.analyzeLive(bad), (e: unknown) => (e instanceof Error && e.message === 'INVALID_ASSESSMENT_DETAILS') || assert.fail(`${name}: ${String(e)}`), name);
    });
    assert.equal(snapshotRows(db).length, 0, 'no oversized bundle was saved');
  });
});

test('non-LIVE envelopes: an owned orphan is rejected by the validator view and an ordinary fixture stays accepted', async () => {
  const { x } = await runs(), b = x.b;
  const smallest = (pick: (id: string) => boolean) => b.evidence.filter((e: Loose) => pick(e.id)).sort((p: Loose, q: Loose) => b.rawArtifacts[p.id].length - b.rawArtifacts[q.id].length)[0];
  const envelope = (e: Loose) => ({ token: b.token, cutoff: b.cutoff, analysisKind: 'FIXTURE', evidence: [structuredClone(e)], rawArtifacts: { [e.id]: b.rawArtifacts[e.id] }, observations: [], features: [], profile: b.profile });
  const orphan = smallest(id => /^execliq-req-/.test(id)), ordinary = smallest(id => !isOwned(id));
  assert.ok(orphan && ordinary);
  assert.ok(Buffer.byteLength(b.rawArtifacts[orphan.id]) < 2_000_000);
  await withDir(async (_dir, db) => {
    withService(db, s => {
      assert.throws(() => s.analyze(envelope(orphan) as Loose), (e: unknown) => rejectsOwned(e) || assert.fail(String(e)));
      const kept = s.analyze(envelope(ordinary) as Loose);
      assert.equal(kept.analysisKind, 'FIXTURE'); assert.equal(kept.details!.executableLiquidity, undefined);
    });
    assert.equal(snapshotRows(db).length, 1);
  });
});

test('CLI rejects --executable-liquidity outside live Solana analyze before any DB, config or network effect', async () => {
  await withDir(async (dir, db, config) => {
    const missing = join(dir, 'missing-bundle.json'), evm = `0x${'ab'.repeat(20)}`;
    for (const argv of [
      ['show', 'snapshot-id', '--executable-liquidity'],
      ['replay', 'snapshot-id', '--executable-liquidity'],
      ['reassess', 'case-id', '--bundle', missing, '--executable-liquidity'],
      ['analyze', C5.address, '--bundle', missing, '--executable-liquidity'],
      ['analyze', evm, '--chain', 'base', '--partial', '--executable-liquidity'],
    ]) {
      const r = await cli([...argv, '--db', db, '--config', config, '--json']);
      assert.notEqual(r.exit, 0, argv.join(' '));
      assert.ok(r.err.startsWith('EXEC_LIQ_SOLANA_REQUIRED'), `${argv.join(' ')}: ${r.err}`);
      assert.deepEqual(r.spies, { network: 0, executor: 0 });
      assert.deepEqual([existsSync(db), existsSync(config), existsSync(join(dir, 'artifacts'))], [false, false, false], argv.join(' '));
    }
  });
});

test('CLI --executable-liquidity plumbs the opt-in into a live partial run; without it the run stays the ordinary partial', async () => {
  const { x } = await runs();
  await withDir(async (_dir, db, config) => {
    const on = transport(), r = await cli(['analyze', C5.address, '--partial', '--executable-liquidity', '--json', '--db', db, '--config', config], on.fetcher);
    assert.equal(r.exit, 0, r.err);
    assert.deepEqual(on.log.violations, []); assert.deepEqual(r.spies, { network: 0, executor: 0 });
    assert.ok(r.err.includes('PARTIAL_MODE'));
    const s = JSON.parse(r.out);
    assert.deepEqual(s.details.executableLiquidity, x.b.details.executableLiquidity);
    assert.equal(s.details.advisory, undefined); assert.equal(s.semantic.status, 'NOT_REQUESTED');
    const off = transport(), q = await cli(['analyze', C5.address, '--partial', '--json', '--db', db, '--config', config], off.fetcher);
    assert.equal(q.exit, 0, q.err);
    assert.deepEqual([off.log.violations, off.log.frames], [[], []]);
    const t = JSON.parse(q.out);
    assert.equal(t.details.executableLiquidity, undefined);
    assert.ok(!t.evidence.some((e: Loose) => isOwned(e.id)));
  });
});

test('human report states the scoped quote-net total, the honest NOT_PRIMARY form, and nothing for the absent field', async () => {
  const { d, x, n } = await runs();
  assert.deepEqual([n.log.violations, n.log.frames, n.log.usd], [[], [], []]);
  const nf = n.b.details.executableLiquidity;
  assert.equal(nf.aggregate.status, 'NOT_PRIMARY');
  assert.ok(nf.aggregate.blockers.some((bl: Loose) => bl.code === 'NETWORK_NOT_VERIFIED'));
  assert.equal(nf.requests.length, 1, 'collection ends after the unverified genesis');
  assert.deepEqual(oldPart(n.b), oldPart(d.b));
  await withDir(async (_dir, db, config) => {
    const ids = withService(db, s => ({ d: s.analyzeLive(structuredClone(d.b)).id, x: s.analyzeLive(structuredClone(x.b)).id, n: s.analyzeLive(structuredClone(n.b)).id }));
    const report = async (id: string) => {
      const r = await cli(['show', id, '--db', db, '--config', config]);
      assert.equal(r.exit, 0, r.err); assert.deepEqual(r.spies, { network: 0, executor: 0 });
      assert.ok(!r.out.trimStart().startsWith('{'), 'show without --json renders the human report');
      return r.out.split('\n');
    };
    const facts = x.b.details.executableLiquidity, xr = await report(ids.x);
    const start = xr.findIndex(l => l.startsWith('Executable sell liquidity:'));
    assert.ok(start >= 0);
    const block = blockOf(xr, start), total = block[0];
    assert.equal(xr.filter(l => l.startsWith('Executable sell liquidity:')).length, 1);
    assert.ok(total.startsWith('Executable sell liquidity: ~$'));
    for (const part of [`quote-net cash output across ${facts.routes.length} enumerated direct routes`, '300 bps fee-inclusive average price impact', `for ${facts.aggregate.chosenInputSumAtoms} token atoms sold`, `as of ${AT}`, `on-chain bank clock ${facts.freshness.bankClockAt}`, 'fresh at the cutoff']) assert.ok(total.includes(part), part);
    assert.ok(!total.includes('not fresh'));
    for (const a of facts.aggregate.assets) assert.ok(block.some(l => l.startsWith(`  ${a.cashAsset}: `) && l.includes(' net (~$')), a.cashAsset);
    const scope = block.filter(l => l.startsWith('  Scope: direct enumerated PumpSwap'));
    assert.equal(scope.length, 1);
    for (const part of ['only quoted trading fees are deducted', 'network fees, rent, account setup, priority fees and unwrapping are not included', 'not wallet availability', 'physical output-vault balances are separate context, not capacity', 'not an entry check']) assert.ok(scope[0].includes(part), part);
    // Physical output-vault context is required: derived independently from the bound route facts by deduplicating vault addresses.
    assert.equal(facts.routes.length, 17);
    const vaults = new Map<string, { asset: string; mint: string; decimals: number; atoms: bigint }>();
    for (const r of facts.routes) {
      assert.equal(r.outcome.status, 'KNOWN', r.pool);
      const v = r.outcome.facts.vaults.output, cur = { asset: String(r.cashAsset), mint: String(v.mint), decimals: Number(r.outcome.facts.decimals.output), atoms: BigInt(v.amountAtoms) };
      const prev = vaults.get(String(v.address));
      if (prev) assert.deepEqual(prev, cur, `shared vault ${v.address} binds one recorded balance`); else vaults.set(String(v.address), cur);
    }
    const physical = new Map<string, { asset: string; decimals: number; atoms: bigint; vaults: number }>();
    for (const v of vaults.values()) {
      const m = physical.get(v.mint);
      if (!m) { physical.set(v.mint, { asset: v.asset, decimals: v.decimals, atoms: v.atoms, vaults: 1 }); continue; }
      assert.deepEqual([m.asset, m.decimals], [v.asset, v.decimals], v.mint);
      m.atoms += v.atoms; m.vaults++;
    }
    const wbtc = physical.get(USD_REFS.find(r => r.symbol === 'WBTC')!.mint);
    assert.equal(wbtc?.atoms, 207_952_234n, 'genuine recorded WBTC vault amount; the 3165754 virtual quote is not a vault balance');
    assert.ok(!/vault|physical/i.test(total), 'the executable total excludes physical context');
    const headers = block.filter(l => l.startsWith('  Physical output-vault balances (separate context, not sellable capacity): '));
    assert.equal(headers.length, 1);
    assert.equal(xr.filter(l => l.startsWith('  Physical output-vault balances')).length, 1);
    const header = headers[0];
    for (const part of ['from 17/17 enumerated routes known;', `${vaults.size} distinct output vault${vaults.size === 1 ? '' : 's'} after deduplicating shared vault addresses`, 'recorded raw balances include accrued fees and dust', 'wrapped SOL counts the recorded token amount only, not rent or surplus lamports', `as of ${AT}`]) assert.ok(header.includes(part), part);
    assert.ok(!header.includes('partial'));
    const physTotals = block.filter(l => l.startsWith('  Physical reference-USD total'));
    assert.equal(physTotals.length, 1);
    assert.ok(physTotals[0].startsWith('  Physical reference-USD total, known-route vaults only: ~$') && physTotals[0].endsWith('; not sellable capacity.'), physTotals[0]);
    assert.ok(!physTotals[0].includes('partial'));
    const headerAt = block.indexOf(header), totalAt = block.indexOf(physTotals[0]);
    assert.equal(block.filter(l => l.startsWith('  Physical ')).length, physical.size + 2, 'one header, one line per cash asset and one reference total');
    assert.ok(!block.some(l => l.includes('conflicting duplicate') || l.includes('USD reference unavailable')));
    for (const m of physical.values()) {
      const prefix = `  Physical ${m.asset}: `, ls = block.filter(l => l.startsWith(prefix));
      assert.equal(ls.length, 1, m.asset);
      const at = block.indexOf(ls[0]);
      assert.ok(headerAt < at && at < totalAt, `${m.asset} is scoped under the context header`);
      const rest = ls[0].slice(prefix.length), amount = rest.slice(0, rest.indexOf(' '));
      assert.equal(atomsOf(amount, m.decimals), m.atoms, `${m.asset} physical amount`);
      assert.ok(rest.startsWith(`${amount} in ${m.vaults} vault${m.vaults === 1 ? '' : 's'} (~$`), ls[0]);
      assert.ok(rest.includes(' at recorded reference ~$') && rest.endsWith(`/${m.asset}).`), ls[0]);
    }
    assert.ok(block.some(l => l.startsWith(`  Physical ${wbtc!.asset}: 2.07952234 in `)), 'exact WBTC physical amount text');
    const nr = await report(ids.n), nTotal = nr.filter(l => l.startsWith('Executable sell liquidity:'));
    assert.equal(nTotal.length, 1);
    assert.ok(nTotal[0].startsWith('Executable sell liquidity: not a complete total'));
    assert.ok(nTotal[0].includes('NETWORK_NOT_VERIFIED'));
    assert.ok(!nTotal[0].includes('~$'));
    assert.ok(nr.some(l => l.startsWith('  Scope: direct enumerated PumpSwap')));
    const dr = await report(ids.d);
    assert.ok(!dr.some(l => l.startsWith('Executable sell liquidity') || l.startsWith('  Scope: direct enumerated') || l.startsWith('  Known-route subtotal') || l.startsWith('  Physical ')));
  });
});
