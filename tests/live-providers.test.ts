import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { collectLiveSolana, collectLiveToken } from '../src/app/live.js';
import { Service } from '../src/app/service.js';
import { parseGeminiSemantic } from '../src/providers/gemini.js';
import { fetchDexPairs, parseDexPairs } from '../src/providers/dexscreener.js';
import { publicHttpsUrl, searchAndFetchPublic } from '../src/providers/tinyfish.js';
import {
  inspectSolanaDetails,
  inspectSolanaMint,
  inspectSolanaRpc,
  LEGACY_TOKEN_PROGRAM,
  SOLANA_MAINNET_GENESIS,
  TOKEN_2022_PROGRAM,
  UPGRADEABLE_LOADER,
} from '../src/providers/solana.js';
import { inspectPumpSwap } from '../src/providers/pumpswap.js';
import { deriveShared, expireSharedWitnesses, sharedClaims, type SharedInputs } from '../src/domain/shared.js';
import { decodeSharedAudit, validSharedReassessment } from '../src/providers/shared-model.js';
import { sourceSpans } from '../src/providers/source-model.js';
import { sharedFixture } from './shared-fixtures.js';
import type { Profile, TokenRef } from '../src/domain/contracts.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const RPC_URL = 'https://rpc.example/?api-key=rpc-secret';
const TINYFISH_KEY = 'tinyfish-test-secret';
const GEMINI_KEY = 'gemini-test-secret';
const AT = '2026-09-29T12:00:00.000Z';
const PROGRAM_DATA = new PublicKey(Buffer.alloc(32, 8)).toBase58();
const token: TokenRef = { chain: 'solana', address: MINT };
const profile: Profile = { id: 'unconfigured-live', risk: {}, stage: { ageBands: [] } };

test('mainnet RPC pin matches the complete documented Solana genesis hash', () => {
  assert.equal(SOLANA_MAINNET_GENESIS, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});
const sourceModelRaw = (value: unknown) => JSON.stringify({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
});

type TimerTestContext = { mock: { timers: { tick(milliseconds: number): void } } };
async function flushMicrotasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}
async function advanceTwoRetryDelays(context: TimerTestContext) {
  for (const delay of [1000, 2000]) {
    await flushMicrotasks();
    context.mock.timers.tick(delay);
    await flushMicrotasks();
  }
}

function legacyAccount(overrides: Record<string, unknown> = {}) {
  return {
    owner: LEGACY_TOKEN_PROGRAM,
    data: {
      program: 'spl-token',
      parsed: { type: 'mint', info: { supply: '1000000000000', decimals: 6, mintAuthority: null, freezeAuthority: null } },
    },
    ...overrides,
  };
}

function pair(index: number, overrides: Record<string, unknown> = {}) {
  const asQuote = index === 1;
  return {
    chainId: 'solana',
    pairAddress: `PairAddress${index}`,
    dexId: 'raydium',
    url: `https://dexscreener.com/solana/PairAddress${index}`,
    baseToken: { address: asQuote ? OTHER_MINT : MINT, name: 'Token', symbol: 'T' },
    quoteToken: { address: asQuote ? MINT : 'QuoteMint', name: 'Quote', symbol: 'Q' },
    priceUsd: '0.001',
    liquidity: { usd: String(index + 1) },
    volume: { h24: '25.5' },
    txns: { h24: { buys: 4, sells: 2 } },
    pairCreatedAt: 1750000000000,
    ...overrides,
  };
}

type MockConfig = {
  genesis?: unknown;
  accountValue?: unknown;
  rpcError?: unknown;
  accountError?: unknown;
  rpcStatus?: number;
  dexValue?: unknown | ((call: number) => unknown);
  dexStatus?: number | ((call: number) => number | undefined);
  searchValue?: Record<string, unknown> | ((requestUrl: string, call: number) => unknown);
  searchStatus?: number;
  fetchValue?: unknown | ((urls: string[]) => unknown);
  fetchStatus?: number;
  attentionResponse?: (packet: Record<string, unknown>, call: number) => unknown;
  geminiStatus?: number;
  geminiBody?: string;
};

function mockedFetch(config: MockConfig = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const geminiPackets: Record<string, unknown>[] = [];
  let searchCalls = 0;
  let dexCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('https://rpc.example/') || url.startsWith('https://api.mainnet.solana.com')) {
      if (config.rpcStatus) return jsonResponse({ error: 'simulated' }, config.rpcStatus);
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getGenesisHash' && config.rpcError !== undefined) throw config.rpcError;
      if (request.method === 'getAccountInfo' && config.accountError !== undefined) throw config.accountError;
      if (request.method === 'getGenesisHash') return jsonResponse({ jsonrpc: '2.0', id: 1, result: config.genesis ?? SOLANA_MAINNET_GENESIS });
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT) return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: config.accountValue === undefined ? legacyAccount() : config.accountValue } });
      if (request.method === 'getProgramAccounts') return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: [] } });
      if (request.method === 'getTokenLargestAccounts') return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: [] } });
      if (request.method === 'getMultipleAccounts') return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: (request.params?.[0] as unknown[]).map(() => null) } });
      if (request.method === 'getAccountInfo' && request.params?.[0] === PROGRAM_DATA) {
        const data = Buffer.alloc(45);
        data.writeUInt32LE(3, 0);
        data.writeBigUInt64LE(300n, 4);
        data[12] = 1;
        Buffer.alloc(32, 11).copy(data, 13);
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: { owner: UPGRADEABLE_LOADER, executable: false, data: [data.toString('base64'), 'base64'] } } });
      }
      if (request.method === 'getAccountInfo') {
        const data = Buffer.alloc(36);
        data.writeUInt32LE(2, 0);
        new PublicKey(PROGRAM_DATA).toBuffer().copy(data, 4);
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: { owner: UPGRADEABLE_LOADER, executable: true, data: [data.toString('base64'), 'base64'] } } });
      }
      throw new Error(`UNEXPECTED_RPC_METHOD_${request.method}`);
    }
    if (url.startsWith('https://api.dexscreener.com/')) {
      const dexCall = dexCalls++;
      const status = typeof config.dexStatus === 'function' ? config.dexStatus(dexCall) : config.dexStatus;
      if (status) return jsonResponse({ error: 'simulated' }, status);
      const value = typeof config.dexValue === 'function' ? config.dexValue(dexCall) : config.dexValue;
      return jsonResponse(value ?? []);
    }
    if (url.startsWith('https://api.search.tinyfish.ai/')) {
      if (config.searchStatus) return jsonResponse({ error: 'simulated' }, config.searchStatus);
      const searchCall = searchCalls++;
      const value = typeof config.searchValue === 'function'
        ? config.searchValue(url, searchCall)
        : config.searchValue ?? { results: [] };
      return jsonResponse(value);
    }
    if (url.startsWith('https://api.fetch.tinyfish.ai/')) {
      if (config.fetchStatus) return jsonResponse({ error: 'simulated' }, config.fetchStatus);
      const request = JSON.parse(String(init?.body)) as { urls?: unknown };
      const urls = Array.isArray(request.urls) ? request.urls.filter((item): item is string => typeof item === 'string') : [];
      const value = typeof config.fetchValue === 'function'
        ? (config.fetchValue as (requestedUrls: string[]) => unknown)(urls)
        : config.fetchValue ?? { results: [], errors: [] };
      return jsonResponse(value);
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      if (config.geminiStatus) return jsonResponse({ error: 'simulated' }, config.geminiStatus);
      if (config.geminiBody !== undefined) return new Response(config.geminiBody, { headers: { 'content-type': 'application/json' } });
      const request = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const packet = JSON.parse(request.contents[0]?.parts[0]?.text ?? '{}') as Record<string, unknown>;
      geminiPackets.push(packet);
      if (config.attentionResponse) return jsonResponse(config.attentionResponse(packet, geminiPackets.length));
      return jsonResponse({ candidates: [] });
    }
    throw new Error('UNEXPECTED_MOCK_REQUEST');
  };
  return { calls, fetcher, geminiPackets };
}

test('the standalone RPC inspection makes one bounded genesis-only mainnet check', async (t) => {
  await t.test('a valid mainnet response uses one getGenesisHash request with no account lookup', async () => {
    const mock = mockedFetch();
    const read = await inspectSolanaRpc(RPC_URL, mock.fetcher);
    assert.equal(read.status, 'OBSERVED');
    assert.equal(read.genesisHash, SOLANA_MAINNET_GENESIS);
    assert.ok(read.genesisRaw);
    assert.equal(read.accountRaw, undefined);
    assert.equal(read.mint, undefined);
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0]!;
    assert.equal(call.url, RPC_URL);
    assert.equal(call.init?.method, 'POST');
    assert.ok(call.init?.signal instanceof AbortSignal);
    assert.equal((call.init?.signal as AbortSignal).aborted, false);
    const request = JSON.parse(String(call.init?.body)) as { method: string; params: unknown[] };
    assert.equal(request.method, 'getGenesisHash');
    assert.deepEqual(request.params, []);
  });

  await t.test('a wrong cluster is rejected after the same single handshake', async () => {
    const mock = mockedFetch({ genesis: 'wrong-genesis' });
    const read = await inspectSolanaRpc(RPC_URL, mock.fetcher);
    assert.deepEqual({ status: read.status, code: read.code }, { status: 'INVALID', code: 'WRONG_CLUSTER' });
    assert.equal(read.genesisRaw, JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'wrong-genesis' }));
    assert.equal(read.accountRaw, undefined);
    assert.equal(mock.calls.length, 1);
    assert.equal((JSON.parse(String(mock.calls[0]?.init?.body)) as { method: string }).method, 'getGenesisHash');
  });
});

test('structured RPC transport failures map to safe codes without inspecting arbitrary messages', async (t) => {
  const direct = (code: string) => Object.assign(new Error('opaque provider failure'), { code });
  const timeoutFailure = (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const coded = error as Error & { code?: string; cause?: { code?: string } };
    return error.name === 'TimeoutError' || [coded.code, coded.cause?.code].some(code => code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT');
  };
  const cases: Array<{ label: string; error: unknown; code: string }> = [
    { label: 'TimeoutError name', error: Object.assign(new Error('private endpoint and secret'), { name: 'TimeoutError' }), code: 'RPC_TIMEOUT' },
    { label: 'direct ETIMEDOUT', error: direct('ETIMEDOUT'), code: 'RPC_TIMEOUT' },
    { label: 'cause UND_ERR_CONNECT_TIMEOUT', error: new Error('wrapper failure', { cause: direct('UND_ERR_CONNECT_TIMEOUT') }), code: 'RPC_TIMEOUT' },
    { label: 'direct EACCES', error: direct('EACCES'), code: 'RPC_NETWORK_ACCESS_DENIED' },
    { label: 'cause EPERM', error: new Error('wrapper failure', { cause: direct('EPERM') }), code: 'RPC_NETWORK_ACCESS_DENIED' },
    { label: 'direct ENOTFOUND', error: direct('ENOTFOUND'), code: 'RPC_DNS_ERROR' },
    { label: 'cause EAI_AGAIN', error: new Error('wrapper failure', { cause: direct('EAI_AGAIN') }), code: 'RPC_DNS_ERROR' },
    {
      label: 'misleading message and unknown cause code',
      error: new Error('TimeoutError ETIMEDOUT EACCES ENOTFOUND https://private-rpc.example/?token=rpc-secret', { cause: direct('PRIVATE_PROVIDER_CODE') }),
      code: 'RPC_TRANSPORT',
    },
  ];
  for (const item of cases) {
    await t.test(item.label, async st => {
      if (timeoutFailure(item.error)) st.mock.timers.enable({ apis: ['setTimeout'] });
      let calls = 0;
      const fetcher: typeof fetch = async () => { calls += 1; throw item.error; };
      const pending = inspectSolanaRpc(RPC_URL, fetcher);
      if (timeoutFailure(item.error)) {
        await advanceTwoRetryDelays(st);
        st.mock.timers.tick(30_000);
        await flushMicrotasks();
      }
      const read = await pending;
      assert.deepEqual(read, { status: 'UNAVAILABLE', code: item.code });
      assert.equal(calls, timeoutFailure(item.error) ? 4 : 1,
        'read recovery permits one delayed attempt only for classified local timeouts');
      assert.equal(JSON.stringify(read).includes('rpc-secret'), false);
      assert.equal(JSON.stringify(read).includes('private-rpc.example'), false);
      assert.equal(JSON.stringify(read).includes('PRIVATE_PROVIDER_CODE'), false);
    });
  }
});

test('RPC inspector signals reach child requests and cancel their waits', async t => {
  await t.test('standalone RPC inspector forwards its final signal', async () => {
    const controller = new AbortController();
    const reason = new DOMException('inspection cancelled', 'AbortError');
    let calls = 0;
    let signalAborted = false;
    const pending = inspectSolanaRpc(RPC_URL, (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const attemptSignal = init?.signal;
        controller.signal.addEventListener('abort', () => {
          signalAborted = attemptSignal?.aborted === true;
          reject(reason);
        }, { once: true });
      });
    }, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 1);
    controller.abort(reason);
    const read = await pending;
    assert.equal(read.status, 'UNAVAILABLE');
    assert.equal(calls, 1);
    assert.equal(signalAborted, true);
  });

  await t.test('mint inspector forwards its signal through the handshake and account read', async () => {
    const controller = new AbortController();
    const reason = new DOMException('inspection cancelled', 'AbortError');
    let calls = 0;
    let accountSignalAborted = false;
    const pending = inspectSolanaMint(MINT, RPC_URL, async (_input, init) => {
      calls++;
      if (calls === 1) return jsonResponse({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS });
      return new Promise<Response>((_resolve, reject) => {
        const attemptSignal = init?.signal;
        controller.signal.addEventListener('abort', () => {
          accountSignalAborted = attemptSignal?.aborted === true;
          reject(reason);
        }, { once: true });
      });
    }, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 2);
    controller.abort(reason);
    const read = await pending;
    assert.equal(read.status, 'UNAVAILABLE');
    assert.ok(read.genesisRaw, 'successful handshake evidence is retained');
    assert.equal(calls, 2);
    assert.equal(accountSignalAborted, true);
  });

  await t.test('details inspector forwards its signal to nested RPC requests', async () => {
    const controller = new AbortController();
    const reason = new DOMException('details cancelled', 'AbortError');
    const mint = {
      kind: 'MINT_LEGACY' as const,
      programId: LEGACY_TOKEN_PROGRAM,
      supplyAtomic: '1000000000000',
      decimals: 6,
      mintAuthority: null,
      freezeAuthority: null,
      slot: 321,
    };
    const rawMint = Buffer.alloc(82);
    rawMint[44] = 6;
    rawMint[45] = 1;
    let calls = 0;
    let populationSignalAborted = false;
    const pending = inspectSolanaDetails(mint, MINT, RPC_URL, async (_input, init) => {
      calls++;
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === 'getAccountInfo') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: 321 },
          value: { owner: LEGACY_TOKEN_PROGRAM, executable: false, data: [rawMint.toString('base64'), 'base64'] },
        } });
      }
      assert.equal(request.method, 'getProgramAccounts');
      return new Promise<Response>((_resolve, reject) => {
        const attemptSignal = init?.signal;
        controller.signal.addEventListener('abort', () => {
          populationSignalAborted = attemptSignal?.aborted === true;
          reject(reason);
        }, { once: true });
      });
    }, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 2);
    controller.abort(reason);
    const read = await pending;
    assert.equal(populationSignalAborted, true);
    assert.equal(read.errors.holderPopulation, 'RPC_TRANSPORT');
    assert.equal(calls, 2, 'aborting the child read stops later detail requests');
  });

  await t.test('PumpSwap inspector forwards its final signal to its first RPC read', async () => {
    const controller = new AbortController();
    const reason = new DOMException('venue inspection cancelled', 'AbortError');
    let calls = 0;
    let signalAborted = false;
    const pending = inspectPumpSwap(token, profile, undefined, undefined, 321, RPC_URL, (_input, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const attemptSignal = init?.signal;
        controller.signal.addEventListener('abort', () => {
          signalAborted = attemptSignal?.aborted === true;
          reject(reason);
        }, { once: true });
      });
    }, () => AT, controller.signal);
    await flushMicrotasks();
    assert.equal(calls, 1);
    controller.abort(reason);
    const read = await pending;
    assert.equal(read.inspection.errors.binding, 'RPC_TRANSPORT');
    assert.equal(calls, 1);
    assert.equal(signalAborted, true);
  });
});

test('mint inspection reuses the pinned handshake and preserves successful raw responses', async (t) => {
  await t.test('success performs the genesis and finalized jsonParsed account calls', async () => {
    const mock = mockedFetch();
    const read = await inspectSolanaMint(MINT, RPC_URL, mock.fetcher);
    assert.equal(read.status, 'OBSERVED');
    assert.equal(read.genesisHash, SOLANA_MAINNET_GENESIS);
    assert.ok(read.genesisRaw);
    assert.ok(read.accountRaw);
    assert.equal(read.mint?.kind, 'MINT_LEGACY');
    assert.equal(mock.calls.length, 2);
    const genesis = JSON.parse(String(mock.calls[0]?.init?.body)) as { method: string; params: unknown[] };
    const account = JSON.parse(String(mock.calls[1]?.init?.body)) as { method: string; params: unknown[] };
    assert.equal(genesis.method, 'getGenesisHash');
    assert.deepEqual(genesis.params, []);
    assert.equal(account.method, 'getAccountInfo');
    assert.deepEqual(account.params, [MINT, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    assert.equal(read.genesisRaw, JSON.stringify({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS }));
    assert.equal(read.accountRaw, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: legacyAccount() } }));
    assert.equal(Object.hasOwn(read, 'retrievedAt'), false, 'legacy callers keep the original response shape');
  });

  await t.test('optional clock binds each successful raw response to its own retrieval time', async () => {
    const base = Date.parse('2026-10-06T12:00:00.000Z');
    let current = base;
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === 'getGenesisHash') {
        current = base + 1_000;
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS });
      }
      assert.equal(request.method, 'getAccountInfo');
      current = base + 302_000;
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: legacyAccount() } });
    };
    const read = await inspectSolanaMint(MINT, RPC_URL, fetcher, undefined, () => new Date(current).toISOString());
    assert.equal(read.status, 'OBSERVED');
    assert.deepEqual(read.retrievedAt, {
      'rpc-genesis': new Date(base + 1_000).toISOString(),
      'rpc-account': new Date(base + 302_000).toISOString(),
    });
    assert.equal(Date.parse(read.retrievedAt!['rpc-account']!) - Date.parse(read.retrievedAt!['rpc-genesis']!), 301_000,
      'the account timestamp reflects its response, not the later run completion');
    assert.equal(calls, 2);
  });

  await t.test('failed account reads retain only the successful handshake timestamp', async () => {
    const current = '2026-10-06T12:00:00.000Z';
    const fetcher: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === 'getGenesisHash') return jsonResponse({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS });
      throw new Error('simulated account failure');
    };
    const read = await inspectSolanaMint(MINT, RPC_URL, fetcher, undefined, () => current);
    assert.equal(read.status, 'UNAVAILABLE');
    assert.deepEqual(read.retrievedAt, { 'rpc-genesis': current });
    assert.equal(read.accountRaw, undefined);
  });

  await t.test('an account-stage timeout keeps genesis evidence and does not create account evidence', async st => {
    st.mock.timers.enable({ apis: ['setTimeout'] });
    const timeout = Object.assign(new Error('fetch failed for https://private-rpc.example/?token=rpc-secret'), { name: 'TimeoutError' });
    const mock = mockedFetch({ accountError: timeout });
    const pending = inspectSolanaMint(MINT, RPC_URL, mock.fetcher);
    await advanceTwoRetryDelays(st);
    st.mock.timers.tick(30_000);
    await flushMicrotasks();
    const read = await pending;
    assert.deepEqual({ status: read.status, code: read.code }, { status: 'UNAVAILABLE', code: 'RPC_TIMEOUT' });
    assert.ok(read.genesisRaw);
    assert.equal(read.genesisHash, SOLANA_MAINNET_GENESIS);
    assert.equal(read.accountRaw, undefined);
    assert.equal(read.mint, undefined);
    assert.equal(mock.calls.length, 5, 'the account lookup gets three fast attempts and one delayed fallback after the successful genesis check');
    assert.equal((JSON.parse(String(mock.calls[0]?.init?.body)) as { method: string }).method, 'getGenesisHash');
    assert.equal((JSON.parse(String(mock.calls[1]?.init?.body)) as { method: string }).method, 'getAccountInfo');
    assert.equal((JSON.parse(String(mock.calls[2]?.init?.body)) as { method: string }).method, 'getAccountInfo');
    assert.equal((JSON.parse(String(mock.calls[3]?.init?.body)) as { method: string }).method, 'getAccountInfo');
    assert.equal(JSON.stringify(read).includes('rpc-secret'), false);
    assert.equal(JSON.stringify(read).includes('private-rpc.example'), false);
  });
});

test('DexScreener retrieval timestamps require a successfully read raw body and remain optional for legacy callers', async t => {
  await t.test('records the body retrieval instant', async () => {
    const retrievedAt = '2026-10-06T12:00:00.000Z';
    const read = await fetchDexPairs('solana', MINT, async () => jsonResponse([pair(0)]), () => retrievedAt);
    assert.equal(read.status, 'OBSERVED');
    assert.equal(read.retrievedAt, retrievedAt);
    assert.equal(read.market?.pairs[0]?.priceUsd, '0.001');
  });

  await t.test('leaves unavailable and unclocked results without retrieval metadata', async () => {
    const unavailable = await fetchDexPairs('solana', MINT, async () => jsonResponse({ error: 'unavailable' }, 500), () => {
      throw new Error('clock must not run without a successful raw body');
    });
    assert.equal(unavailable.status, 'UNAVAILABLE');
    assert.equal(Object.hasOwn(unavailable, 'retrievedAt'), false);

    const legacy = await fetchDexPairs('solana', MINT, async () => jsonResponse([pair(0)]));
    assert.equal(legacy.status, 'OBSERVED');
    assert.equal(Object.hasOwn(legacy, 'retrievedAt'), false);
  });
});

test('DEX recovery is opt-in, keeps healthy direct reads unchanged, and selects only literal fixed-URL JSON', async () => {
  const healthy = mockedFetch({ dexValue: [pair(0)] });
  const direct = await fetchDexPairs('solana', MINT, healthy.fetcher, () => AT, { tinyfishKey: TINYFISH_KEY });
  assert.equal(direct.status, 'OBSERVED');
  assert.equal(direct.market?.pairs[0]?.pairAddress, 'PairAddress0');
  assert.equal(Object.hasOwn(direct, 'recovery'), false, 'a healthy direct read bypasses TinyFish entirely');
  assert.equal(healthy.calls.length, 1);
  assert.ok(healthy.calls[0]?.url.startsWith('https://api.dexscreener.com/token-pairs/v1/solana/'));

  const emptyWithoutRecovery = mockedFetch({ dexValue: [] });
  const legacy = await fetchDexPairs('solana', MINT, emptyWithoutRecovery.fetcher, () => AT);
  assert.equal(legacy.status, 'NO_RESULTS');
  assert.equal(Object.hasOwn(legacy, 'recovery'), false);
  assert.equal(emptyWithoutRecovery.calls.length, 1, 'omitting recovery preserves the old direct-only request shape');

  const selectedText = JSON.stringify([pair(0)]);
  const recoveredMock = mockedFetch({
    dexValue: [],
    fetchValue: (urls: string[]) => ({
      results: urls.map(url => ({ url, final_url: url, format: 'html', text: selectedText })),
      errors: [],
    }),
  });
  const times = [AT, '2026-09-29T12:00:02.000Z'];
  let clockReads = 0;
  const recovered = await fetchDexPairs('solana', MINT, recoveredMock.fetcher, () => times[clockReads++]!, { tinyfishKey: TINYFISH_KEY });
  const requestedUrl = `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;
  assert.equal(recovered.status, 'OBSERVED');
  assert.equal(recovered.raw, selectedText, 'the selected provider text is retained verbatim');
  assert.equal(recovered.retrievedAt, times[1]);
  assert.deepEqual(recovered.recovery, {
    method: 'tinyfish-live-dex-json-v1',
    requestedUrl,
    requestRaw: JSON.stringify({
      urls: [requestedUrl], format: 'html', ttl: 0, per_url_timeout_ms: 8000, include_etag_and_last_modified: true,
    }),
    responseRaw: JSON.stringify({
      results: [{ url: requestedUrl, final_url: requestedUrl, format: 'html', text: selectedText }], errors: [],
    }),
    primaryRaw: '[]',
    primaryState: 'NO_RESULTS',
    primaryRetrievedAt: times[0],
    retrievedAt: times[1],
    selected: true,
  });
  assert.equal(recoveredMock.calls.length, 2, 'empty direct data enters exactly one bounded fallback request');
  const fetchCall = recoveredMock.calls.find(call => call.url === 'https://api.fetch.tinyfish.ai/');
  assert.ok(fetchCall);
  assert.equal(fetchCall.init?.method, 'POST');
  assert.equal((fetchCall.init?.headers as Record<string, string>)['X-API-Key'], TINYFISH_KEY);
  assert.deepEqual(JSON.parse(String(fetchCall.init?.body)), {
    urls: [requestedUrl], format: 'html', ttl: 0, per_url_timeout_ms: 8000, include_etag_and_last_modified: true,
  });
  assert.equal(JSON.stringify(recovered).includes(TINYFISH_KEY), false, 'the key is transport-only');
});

test('DEX recovery rejects malformed, redirected, incomplete, oversized, or wrong-token Fetch responses without repair', async () => {
  const requestedUrl = `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;
  const result = (overrides: Record<string, unknown> = {}) => ({
    url: requestedUrl, final_url: requestedUrl, format: 'html', text: JSON.stringify([pair(0)]), ...overrides,
  });
  const cases: Array<{ name: string; body?: string; status?: number; transportError?: Error; code: string; state: string }> = [
    { name: 'malformed Fetch envelope JSON', body: '{', code: 'DEX_FETCH_JSON', state: 'INVALID' },
    { name: 'HTTP-200 Fetch errors', body: JSON.stringify({ results: [], errors: [{ url: requestedUrl, error: 'timeout' }] }), code: 'DEX_FETCH_SHAPE', state: 'INVALID' },
    { name: 'changed requested URL', body: JSON.stringify({ results: [result({ url: `${requestedUrl}?other=1` })], errors: [] }), code: 'DEX_FETCH_URL', state: 'INVALID' },
    { name: 'redirected final URL', body: JSON.stringify({ results: [result({ final_url: 'https://other.example/redirect' })], errors: [] }), code: 'DEX_FETCH_URL', state: 'INVALID' },
    { name: 'non-HTML Fetch format', body: JSON.stringify({ results: [result({ format: 'markdown' })], errors: [] }), code: 'DEX_FETCH_SHAPE', state: 'INVALID' },
    { name: 'Markdown instead of literal JSON text', body: JSON.stringify({ results: [result({ text: `# Pairs\n${JSON.stringify([pair(0)])}` })], errors: [] }), code: 'DEX_FETCH_JSON', state: 'INVALID' },
    { name: 'valid JSON for a different mint', body: JSON.stringify({ results: [result({ text: JSON.stringify([pair(0, { baseToken: { address: 'WrongMint' }, quoteToken: { address: 'OtherMint' } })]) })], errors: [] }), code: 'DEX_FETCH_WRONG_TOKEN', state: 'INVALID' },
    { name: 'oversized raw envelope', body: JSON.stringify({ results: [result({ text: 'x'.repeat(400_001) })], errors: [] }), code: 'DEX_FETCH_RESPONSE_LIMIT', state: 'INVALID' },
    { name: 'provider HTTP failure', status: 503, body: JSON.stringify({ error: 'unavailable' }), code: 'DEX_FETCH_HTTP_503', state: 'UNAVAILABLE' },
    { name: 'provider transport failure', transportError: new TypeError('synthetic network failure'), code: 'DEX_FETCH_TRANSPORT', state: 'UNAVAILABLE' },
  ];

  for (const scenario of cases) {
    let fallbackCalls = 0;
    const fetcher: typeof fetch = async input => {
      const url = String(input);
      if (url === requestedUrl) return jsonResponse([]);
      if (url === 'https://api.fetch.tinyfish.ai/') {
        fallbackCalls++;
        if (scenario.transportError) throw scenario.transportError;
        return new Response(scenario.body, { status: scenario.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`UNEXPECTED_MOCK_REQUEST_${url}`);
    };
    const read = await fetchDexPairs('solana', MINT, fetcher, () => AT, { tinyfishKey: TINYFISH_KEY });
    assert.equal(read.status, scenario.state, scenario.name);
    assert.equal(read.code, scenario.code, scenario.name);
    assert.equal(read.recovery?.selected, false, scenario.name);
    assert.equal(read.recovery?.primaryRaw, '[]', scenario.name);
    assert.equal(read.recovery?.primaryState, 'NO_RESULTS', scenario.name);
    assert.equal(fallbackCalls, 1, `${scenario.name}: recovery is attempted only once`);
    assert.equal(JSON.stringify(read).includes(TINYFISH_KEY), false, `${scenario.name}: key is absent from the receipt`);
  }
});

function liveOptions(fetcher: typeof fetch, overrides: Partial<Parameters<typeof collectLiveSolana>[1]> = {}) {
  return { profile, semanticEnabled: false, fetcher, now: () => AT, ...overrides };
}

test('full semantic live runs use ten minutes while partial collection keeps two minutes', async () => {
  const original = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  assert.ok(original?.value instanceof Function);
  const nativeTimeout = AbortSignal.timeout;
  const observed: number[] = [];
  Object.defineProperty(AbortSignal, 'timeout', {
    ...original,
    value: (milliseconds: number) => { observed.push(milliseconds); return nativeTimeout(milliseconds); },
  });
  try {
    const full = mockedFetch();
    const baseToken = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
    await collectLiveToken(baseToken, liveOptions(full.fetcher, { semanticEnabled: true }));
    assert.equal(observed[0], 600_000, 'full semantic analysis has the user-approved ten-minute run budget');

    const partial = mockedFetch();
    const before = observed.length;
    await collectLiveToken(baseToken, liveOptions(partial.fetcher, { semanticEnabled: false }));
    assert.equal(observed[before], 120_000, 'partial collection retains its existing two-minute run budget');
  } finally {
    Object.defineProperty(AbortSignal, 'timeout', original);
  }
});

test('legacy mint facts stay bounded while direct shared-token-program state proves mutability', async () => {
  const dexPairs = [
    pair(0, { liquidity: { usd: '100000' } }),
    pair(1, { liquidity: { usd: '50000' } }),
    ...Array.from({ length: 22 }, (_, index) => pair(index + 2)),
    pair(0, { liquidity: { usd: '999999999' } }),
    pair(30, { chainId: 'ethereum' }),
    pair(31, { baseToken: { address: 'UnrelatedMint' }, quoteToken: { address: 'OtherQuote' } }),
  ];
  const mock = mockedFetch({ dexValue: dexPairs });
  const result = await collectLiveSolana(token, liveOptions(mock.fetcher));

  assert.equal(result.collection.rpc.state, 'OBSERVED');
  for (const id of ['O01', 'O03', 'O04', 'O06']) {
    const row = result.features.find(feature => feature.id === id);
    assert.equal(row?.quality, 'KNOWN', `${id} is backed by the observed legacy mint account`);
    assert.equal(row?.value, true);
  }
  const program = result.features.find(row => row.id === 'O05');
  assert.equal(program?.quality, 'KNOWN');
  assert.equal(program?.value, false, 'the direct Program and ProgramData accounts resolve a live upgrade authority');
  assert.ok(program?.evidenceIds.includes('rpc-program-data'), 'the token-program conclusion is independently sourced from binary loader state');
  for (const id of ['O08', 'O09', 'O10', 'O17', 'O20', 'C02', 'A01', 'A02', 'A05', 'S01', 'C05']) {
    const row = result.features.find(feature => feature.id === id);
    assert.ok(!row || row.quality !== 'KNOWN' || row.value !== true, `${id} needs its own evidence before becoming favorable`);
  }

  assert.equal(result.market?.reportedPairCount, dexPairs.length);
  assert.equal(result.market?.retainedPairCount, 20);
  assert.equal(result.market?.truncated, true);
  assert.equal(result.market?.pairs.length, 20);
  const quotePair = result.market?.pairs.find(row => row.mintSide === 'quote');
  assert.equal(quotePair?.priceUsd, null);
  assert.equal(result.collection.dex.state, 'TRUNCATED');
  assert.equal(result.observations.some(row => row.field === 'tokenCreatedAt'), false);
  assert.ok(result.observations.some(row => row.field.endsWith('.poolCreatedAt')));
});

test('wrong genesis, missing accounts, Token-2022, and RPC errors remain distinct', async (t) => {
  await t.test('wrong genesis is invalid and does not yield mint features', async () => {
    const mock = mockedFetch({ genesis: 'wrong-genesis' });
    const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
    assert.deepEqual(result.collection.rpc, { state: 'INVALID', code: 'WRONG_CLUSTER' });
    const directFacts = result.features.filter(row => ['O01', 'O02', 'O03', 'O04', 'O05', 'O06', 'O07'].includes(row.id));
    assert.ok(directFacts.every(row => row.quality !== 'KNOWN'), 'a rejected cluster must not yield favorable mint facts');
    assert.equal(result.rawArtifacts['rpc-account'], undefined);
    assert.equal(result.collection.dex.state, 'NO_RESULTS');
  });

  await t.test('a finalized null account produces only a sourced non-mint result', async () => {
    const mock = mockedFetch({ accountValue: null });
    const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
    assert.equal(result.features.find(row => row.id === 'O01')?.quality, 'KNOWN');
    assert.equal(result.features.find(row => row.id === 'O01')?.value, false);
    const otherDirectFacts = result.features.filter(row => row.id !== 'O01' && ['O02', 'O03', 'O04', 'O05', 'O06', 'O07'].includes(row.id));
    assert.ok(otherDirectFacts.every(row => row.quality !== 'KNOWN' || row.value !== true), 'a non-mint account cannot establish mint controls');
    assert.ok(result.observations.some(row => row.field === 'mintAccountKind' && row.value === 'ACCOUNT_MISSING'));
  });

  await t.test('Token-2022 is partial and does not inherit legacy authority checks', async () => {
    const account = {
      owner: TOKEN_2022_PROGRAM,
      data: {
        program: 'spl-token-2022',
        parsed: { type: 'mint', info: { supply: '10', decimals: 2, mintAuthority: 'Authority111', freezeAuthority: 'Authority222' } },
      },
    };
    const mock = mockedFetch({ accountValue: account });
    const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
    assert.equal(result.features.find(row => row.id === 'O01')?.quality, 'KNOWN');
    assert.equal(result.features.find(row => row.id === 'O01')?.value, true);
    const legacyControlFacts = result.features.filter(row => ['O03', 'O04', 'O05', 'O06'].includes(row.id));
    assert.ok(legacyControlFacts.every(row => row.quality !== 'KNOWN' || row.value !== true), 'a parsed Token-2022 response cannot inherit legacy control facts');
    assert.ok(result.observations.some(row => row.field === 'mintProgramId' && row.value === TOKEN_2022_PROGRAM));
  });

  await t.test('parsed program mismatch is invalid rather than treated as a mint', async () => {
    const mock = mockedFetch({ accountValue: legacyAccount({ data: { program: 'spl-token-2022', parsed: { type: 'mint', info: { supply: '10', decimals: 2, mintAuthority: null, freezeAuthority: null } } } }) });
    const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
    assert.equal(result.collection.rpc.state, 'INVALID');
    assert.equal(result.features.some(row => row.id === 'O01'), false);
  });

  await t.test('RPC 429 leaves DEX collection intact and exposes a bounded code', async st => {
    st.mock.timers.enable({ apis: ['setTimeout'] });
    const mock = mockedFetch({ rpcStatus: 429, dexValue: [pair(1)] });
    const pending = collectLiveSolana(token, liveOptions(mock.fetcher));
    await advanceTwoRetryDelays(st);
    const result = await pending;
    assert.deepEqual(result.collection.rpc, { state: 'UNAVAILABLE', code: 'RPC_HTTP_429' });
    assert.equal(result.collection.dex.state, 'OBSERVED');
    assert.equal(result.features.some(row => row.id === 'O01'), false);
    assert.equal(JSON.stringify(result).includes(RPC_URL), false);
  });
});

test('DEX parser binds exact mint sides, removes duplicates and unrelated pairs, and caps output', () => {
  const input = [pair(0), pair(1), pair(0), pair(2, { chainId: 'ethereum' }), pair(3, {
    baseToken: { address: 'UnrelatedMint' }, quoteToken: { address: 'OtherQuote' },
  })];
  const summary = parseDexPairs(input, 'solana', MINT);
  assert.equal(summary.reportedPairCount, 5);
  assert.equal(summary.retainedPairCount, 2);
  assert.equal(summary.truncated, false);
  assert.deepEqual(summary.pairs.map(row => row.pairAddress).sort(), ['PairAddress0', 'PairAddress1']);
  assert.equal(summary.pairs.find(row => row.mintSide === 'base')?.priceUsd, '0.001');
  assert.equal(summary.pairs.find(row => row.mintSide === 'quote')?.priceUsd, null);
});

test('TinyFish includes only exact-mint public pages and drops unsafe redirect targets', async () => {
  const unsafe = 'https://127.0.0.1/private';
  assert.equal(publicHttpsUrl('http://127.0.0.1/private'), null);
  assert.equal(publicHttpsUrl(unsafe), null);
  assert.equal(publicHttpsUrl('https://public.example/page#section'), null);
  assert.equal(publicHttpsUrl('https://public.example/page'), 'https://public.example/page');

  const text = `Mint ${MINT}: the project describes itself as a community token.`;
  const mock = mockedFetch({
    searchValue: { results: [
      { url: 'https://public.example/evidence', title: 'Public mention', snippet: 'Exact token page' },
      { url: 'https://public.example/unrelated', title: 'Unrelated', snippet: 'No mint here' },
      { url: 'http://127.0.0.1/private', title: 'Private', snippet: 'Never fetch' },
    ] },
    fetchValue: { results: [
      { url: 'https://public.example/evidence', final_url: 'https://public.example/evidence', text, published_date: '2026-09-01' },
      { url: 'https://public.example/unrelated', final_url: 'https://public.example/unrelated', text: 'A page with no mint address.' },
      { url: 'https://public.example/evidence', final_url: unsafe, text },
    ], errors: [] },
  });
  const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
  assert.equal(result.status, 'OBSERVED');
  assert.deepEqual(result.pages.map(page => page.finalUrl), ['https://public.example/evidence']);
  const fetchCall = mock.calls.find(call => call.url === 'https://api.fetch.tinyfish.ai/');
  assert.ok(fetchCall);
  assert.equal((fetchCall.init?.headers as Record<string, string>)['X-API-Key'], TINYFISH_KEY);
  const requested = JSON.parse(String(fetchCall.init?.body)) as { urls: string[]; ttl: number; format: string };
  assert.equal(requested.urls.includes('http://127.0.0.1/private'), false);
  assert.equal(requested.ttl, 0);
  assert.equal(requested.format, 'markdown');
});

test('TinyFish query handling preserves resource keys for attention and keeps legacy fetches queryless', async () => {
  const functional = 'https://public.example/rootdata/resource?k=MTUxNzY%3D';
  const tracked = `${functional}&utm_source=search&fbclid=click-id&gclid=click-id&msclkid=click-id`;
  assert.equal(publicHttpsUrl(functional, true), functional);
  assert.equal(publicHttpsUrl(tracked, true), functional, 'known tracking parameters are removed while the resource key survives');
  assert.equal(publicHttpsUrl(functional), 'https://public.example/rootdata/resource', 'the legacy default continues to remove the query');
  assert.equal(publicHttpsUrl(`${functional}&api_key=private`, true), null);
  assert.equal(publicHttpsUrl(`${functional}&access_token=private`, true), null);

  const text = `Mint ${MINT}: the page identifies its exact contract.`;
  const mock = mockedFetch({
    searchValue: { results: [{ url: functional }] },
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({ url, final_url: url, text })), errors: [] }),
  });
  const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
  const fetchCall = mock.calls.find(call => call.url === 'https://api.fetch.tinyfish.ai/')!;
  const fetchRequest = JSON.parse(String(fetchCall.init?.body)) as { urls: string[] };

  assert.deepEqual(fetchRequest.urls, ['https://public.example/rootdata/resource']);
  assert.equal(result.status, 'OBSERVED');
  assert.equal(result.pages[0]?.url, 'https://public.example/rootdata/resource');
});

test('TinyFish HTTP-200 Fetch errors distinguish incomplete coverage from an empty corpus', async (t) => {
  const searchValue = { results: [{ url: 'https://public.example/evidence' }] };
  const timeoutBody = { results: [], errors: [{ url: 'https://public.example/evidence', error: 'timeout' }] };

  await t.test('all requested pages failing is unavailable and keeps the raw Fetch body', async () => {
    const mock = mockedFetch({ searchValue, fetchValue: timeoutBody });
    const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.code, 'WEB_FETCH_TIMEOUT');
    assert.deepEqual(result.pages, []);
    assert.equal(result.fetchRaw, JSON.stringify(timeoutBody));
  });

  await t.test('a successful empty Fetch response remains no results', async () => {
    const mock = mockedFetch({ searchValue, fetchValue: { results: [], errors: [] } });
    const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
    assert.equal(result.status, 'NO_RESULTS');
    assert.equal(result.code, undefined);
    assert.deepEqual(result.pages, []);
    assert.equal(result.fetchRaw, JSON.stringify({ results: [], errors: [] }));
  });

  await t.test('a retained exact-mint page survives alongside a bot-blocked URL', async () => {
    const text = `Mint ${MINT}: a community token.`;
    const fetchValue = {
      results: [{ url: 'https://public.example/evidence', final_url: 'https://public.example/evidence', text }],
      errors: [{ url: 'https://public.example/other', error: 'bot_blocked' }],
    };
    const mock = mockedFetch({ searchValue, fetchValue });
    const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
    assert.equal(result.status, 'TRUNCATED');
    assert.equal(result.code, 'WEB_FETCH_BOT_BLOCKED');
    assert.deepEqual(result.pages.map(page => page.finalUrl), ['https://public.example/evidence']);
    assert.equal(result.fetchRaw, JSON.stringify(fetchValue));
  });

  await t.test('missing or malformed result/error arrays fail closed with raw evidence', async (st) => {
    for (const [name, fetchValue] of [
      ['missing errors', { results: [] }],
      ['malformed results', { results: 'not-an-array', errors: [] }],
    ] as const) {
      await st.test(name, async () => {
        const mock = mockedFetch({ searchValue, fetchValue });
        const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
        assert.equal(result.status, 'INVALID');
        assert.equal(result.code, 'WEB_FETCH_SHAPE');
        assert.deepEqual(result.pages, []);
        assert.equal(result.fetchRaw, JSON.stringify(fetchValue));
      });
    }
  });

  await t.test('unknown provider error tokens map to the generic safe code', async () => {
    const fetchValue = { results: [], errors: [{ url: 'https://public.example/evidence', error: 'private: raw message' }] };
    const mock = mockedFetch({ searchValue, fetchValue });
    const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.code, 'WEB_FETCH_URL_ERROR');
    assert.equal(result.fetchRaw, JSON.stringify(fetchValue));
  });
});

test('TinyFish HTTP authorization and quota failures stay provider-specific', async (t) => {
  for (const status of [401, 402, 429]) {
    await t.test(`Search HTTP ${status}`, async () => {
      const mock = mockedFetch({ searchStatus: status });
      const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
      assert.equal(result.status, 'UNAVAILABLE');
      assert.equal(result.code, `WEB_SEARCH_HTTP_${status}`);
      assert.equal(mock.calls.length, 1);
    });
  }
  for (const status of [401, 402, 429]) {
    await t.test(`Fetch HTTP ${status}`, async () => {
      const mock = mockedFetch({
        fetchStatus: status,
        searchValue: { results: [{ url: 'https://public.example/evidence' }] },
      });
      const result = await searchAndFetchPublic(MINT, TINYFISH_KEY, mock.fetcher);
      assert.equal(result.status, 'UNAVAILABLE');
      assert.equal(result.code, `WEB_FETCH_HTTP_${status}`);
      assert.equal(mock.calls.length, 2);
    });
  }
});

function geminiResponse(claims: unknown, finishReason = 'STOP') {
  return { candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify({ claims }) }] } }] };
}

type AttentionPacket = {
  proposal?: unknown;
  sources: Array<{ id: string; url?: string; discoveredFrom?: string; spans: Array<{ id: string; text: string }> }>;
  requiredPostSourceIds?: string[];
  requiredDecisionIds?: string[];
};

function isSocialModelPacket(packet: Record<string, unknown>): boolean {
  return Array.isArray(packet.requiredPostIds) && 'rubric' in packet;
}

function assertInvalidSocialProposal(rawArtifacts: Record<string, string>) {
  const raw = rawArtifacts['social-validation-error'];
  assert.ok(raw, 'the attention-shaped fixture response is retained as an invalid social proposal');
  const diagnostic = JSON.parse(raw) as { code: string; issues: unknown[] };
  assert.equal(diagnostic.code, 'SOC_MODEL_INVALID');
  assert.ok(diagnostic.issues.length > 0, 'the rejected social response includes safe schema-path diagnostics');
}

function assertSocialProviderCallsAreSeparated(mock: ReturnType<typeof mockedFetch>, rawArtifacts: Record<string, string>) {
  const attentionScope = JSON.parse(rawArtifacts['attention-scope']!) as { queries: string[] };
  const acquisition = JSON.parse(rawArtifacts['social-acquisition-scope']!) as {
    read: { queries: string[] };
    requestedUrls: string[];
  };
  const searchCalls = mock.calls.filter(call => call.url.startsWith('https://api.search.tinyfish.ai/'));
  const query = (url: string) => new URL(url).searchParams.get('query') ?? '';
  const socialQueries = acquisition.read.queries.filter(value => !attentionScope.queries.includes(value));
  const attentionSearchCalls = searchCalls.filter(call => attentionScope.queries.includes(query(call.url))).map(call => query(call.url)).sort();
  const socialSearchCalls = searchCalls.filter(call => socialQueries.includes(query(call.url))).map(call => query(call.url)).sort();
  assert.deepEqual(attentionSearchCalls, [...attentionScope.queries].sort(), 'attention keeps its original search requests');
  assert.deepEqual(socialSearchCalls, [...socialQueries].sort(), 'social selection searches are counted separately');
  assert.equal(searchCalls.length, attentionSearchCalls.length + socialSearchCalls.length, 'every Search request belongs to exactly one stage');

  const fetchCalls = mock.calls.filter(call => call.url === 'https://api.fetch.tinyfish.ai/');
  const fetchUrls = (call: typeof fetchCalls[number]) => {
    const request = JSON.parse(String(call.init?.body)) as { urls?: unknown };
    return Array.isArray(request.urls) ? request.urls : [];
  };
  const socialFetchCalls = fetchCalls.filter(call => JSON.stringify(fetchUrls(call)) === JSON.stringify(acquisition.requestedUrls));
  const socialFetchArtifacts = Object.keys(rawArtifacts).filter(key => /^social-fetch-\d+$/.test(key));
  assert.equal(socialFetchCalls.length, acquisition.requestedUrls.length ? 1 : 0, 'the social selection owns its bounded Fetch batch');
  assert.equal(socialFetchCalls.length, socialFetchArtifacts.length, 'social Fetch calls retain their own response artifact');
  const attentionFetchArtifacts = Object.keys(rawArtifacts).filter(key => /^attention.*fetch-\d+$/.test(key));
  assert.equal(fetchCalls.length - socialFetchCalls.length, attentionFetchArtifacts.length, 'remaining Fetch batches stay with attention and comparison recovery');
  return { attentionSearchCount: attentionSearchCalls.length, socialSearchCount: socialSearchCalls.length, attentionFetchCount: attentionFetchArtifacts.length, socialFetchCount: socialFetchCalls.length };
}

function attentionSpanId(packet: Record<string, unknown>, sourceId: string, includes: string): string {
  const source = (packet.sources as AttentionPacket['sources']).find(item => item.id === sourceId);
  assert.ok(source, `attention packet omitted ${sourceId}`);
  const span = source.spans.find(item => item.text.includes(includes));
  assert.ok(span, `no supplied span in ${sourceId} contains ${JSON.stringify(includes)}`);
  return span.id;
}

function attentionSourceId(packet: Record<string, unknown>, includes: string): string {
  const source = (packet.sources as AttentionPacket['sources']).find(item => item.spans.some(span => span.text.includes(includes)));
  assert.ok(source, `no supplied source span contains ${JSON.stringify(includes)}`);
  return source.id;
}

function attentionMetadataSpanId(packet: Record<string, unknown>, sourceId: string, includes?: string): string {
  const source = (packet.sources as AttentionPacket['sources']).find(item => item.id === sourceId);
  assert.ok(source, `indexed lead packet omitted ${sourceId}`);
  const span = source.spans.find(item => includes === undefined || item.text.includes(includes));
  assert.ok(span, `no indexed span in ${sourceId} contains ${JSON.stringify(includes)}`);
  return span.id;
}

function attentionEnvelope(value: unknown) {
  return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] };
}

function comparisonLeadArray(decisions: Record<string, unknown>) {
  return Object.entries(decisions).map(([leadId, decision]) => ({ leadId, ...(decision as Record<string, unknown>) }));
}

function comparisonReviewFields(packet: Record<string, unknown>) {
  return {
    sourceDecisions: Object.fromEntries(((packet.sources ?? []) as Array<{ id: string }>).map(source => [source.id, {
      disposition: 'RELEVANT', rationale: 'The retained source establishes this exact project representation.',
    }])),
    missingRepresentations: [],
  };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const savedShapeSources = () => [
  {
    id: 'web-page-1',
    text: 'Mint ' + MINT + '\nThe project is a community token for holders. Its category is a meme coin. Official account: @Schoen\\_xyz.',
  },
  {
    id: 'web-page-2',
    text: 'Mint ' + MINT + '\nThe Solana token launched on Pump.fun.',
  },
];
const savedShapeClaims = () => [
  { kind: 'NARRATIVE', value: 'Community token', evidenceId: 'web-page-1', quote: 'community token', assertion: 'SOURCE_STATES' },
  { kind: 'GAME_TYPE', value: 'Meme coin', evidenceId: 'web-page-1', quote: 'meme coin', assertion: 'SOURCE_STATES' },
  { kind: 'SOCIAL_ACCOUNT', value: '@Schoen_xyz', evidenceId: 'web-page-1', quote: '@Schoen_xyz', assertion: 'SOURCE_STATES' },
  { kind: 'TOKEN_RELATION', value: 'Solana token', evidenceId: 'web-page-2', quote: 'Solana token', assertion: 'SOURCE_STATES' },
  { kind: 'ORIGIN', value: 'Pump.fun launch', evidenceId: 'web-page-2', quote: 'launched on Pump.fun', assertion: 'SOURCE_STATES' },
];

test('legacy semantic parser aligns one raw social quote without modifying the response', () => {
  const sources = savedShapeSources();
  const claims = savedShapeClaims();
  const response = geminiResponse(claims);
  const originalResponse = JSON.stringify(response);
  const packet = JSON.stringify({ instruction: 'sanitized saved-shape packet', token: MINT, sources });
  const parsed = parseGeminiSemantic(response, packet, MINT, sources);
  assert.equal(parsed.status, 'CANDIDATE');
  assert.equal(parsed.claims.length, 5);
  assert.equal(parsed.claims[2]?.quote, '@Schoen\\_xyz');
  assert.deepEqual(parsed.claims.filter((claim, index) => index !== 2), claims.filter((_, index) => index !== 2));
  assert.equal(JSON.stringify(response), originalResponse);
  assert.equal(parsed.promptHash, sha256(packet));
  assert.equal(parsed.responseHash, sha256(originalResponse));
});

test('Gemini social-handle fallback accepts only one complete exact raw spelling', async (t) => {
  const sourceWith = (rawHandle: string) => 'Mint ' + MINT + '\nAccount: ' + rawHandle;
  const packet = 'sanitized parser adversary packet';
  const parseQuote = (rawSource: string, quote: string, kind = 'SOCIAL_ACCOUNT', evidenceId = 'web-page-1', address = MINT) =>
    parseGeminiSemantic(geminiResponse([{
      kind, value: 'Synthetic account', evidenceId, quote, assertion: 'SOURCE_STATES',
    }]), packet, address, [{ id: 'web-page-1', text: rawSource }]);

  await t.test('multiple escaped underscores and punctuation delimiters retain the exact raw handle', () => {
    const raw = '@Schoen\\_xyz\\_bot';
    const result = parseQuote(sourceWith('(' + raw + '),'), '@Schoen_xyz_bot');
    assert.equal(result.status, 'CANDIDATE');
    assert.equal(result.claims[0]?.quote, raw);
  });

  await t.test('the same raw spelling may appear more than once', () => {
    const raw = '@Schoen\\_xyz';
    const result = parseQuote(sourceWith(raw + ' and (' + raw + ').'), '@Schoen_xyz');
    assert.equal(result.status, 'CANDIDATE');
    assert.equal(result.claims[0]?.quote, raw);
  });

  await t.test('exact raw quote takes precedence over another equivalent spelling', () => {
    const exact = '@Schoen_xyz';
    const result = parseQuote(sourceWith(exact + ' and @Schoen\\_xyz.'), exact);
    assert.equal(result.status, 'CANDIDATE');
    assert.equal(result.claims[0]?.quote, exact);
  });

  const rejected = [
    ['longer prefix', 'x@Schoen\\_xyz', '@Schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['longer suffix', '@Schoen\\_xyzEvil', '@Schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['escaped suffix', '@Schoen\\_xyz\\_extra', '@Schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['different case', '@Schoen\\_xyz', '@schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['fabricated handle', '@Schoen\\_xyz', '@Other_account', 'SOCIAL_ACCOUNT'],
    ['wrong claim kind', '@Schoen\\_xyz', '@Schoen_xyz', 'NARRATIVE'],
    ['arbitrary backslash escape', '@Schoen\\x_xyz', '@Schoen_x_xyz', 'SOCIAL_ACCOUNT'],
    ['doubled backslash escape', '@Schoen\\\\_xyz', '@Schoen_xyz', 'SOCIAL_ACCOUNT'],
    ['normalized whitespace', '@Schoen\\_xyz', '@Schoen xyz', 'SOCIAL_ACCOUNT'],
  ] as const;
  for (const [name, raw, quote, kind] of rejected) {
    await t.test(name + ' is rejected', () => {
      const result = parseQuote(sourceWith(raw), quote, kind);
      assert.equal(result.status, 'INVALID');
      assert.deepEqual(result.validationErrors, ['UNSUPPORTED_CITATION']);
      assert.deepEqual(result.claims, []);
    });
  }

  await t.test('two distinct raw spellings that render identically are ambiguous', () => {
    const result = parseQuote(sourceWith('@Schoen\\_xyz_bot and @Schoen_xyz\\_bot'), '@Schoen_xyz_bot');
    assert.equal(result.status, 'INVALID');
    assert.deepEqual(result.validationErrors, ['UNSUPPORTED_CITATION']);
  });

  await t.test('expanded raw citation must still fit the quote schema', () => {
    const displayed = '@' + 'a'.repeat(997) + '_b';
    const raw = displayed.replace('_', '\\_');
    assert.equal(displayed.length, 1000);
    assert.equal(raw.length, 1001);
    const result = parseQuote(sourceWith(raw), displayed);
    assert.equal(result.status, 'INVALID');
    assert.deepEqual(result.validationErrors, ['UNSUPPORTED_CITATION']);
  });

  await t.test('missing evidence ID or mint text rejects the claim', () => {
    const quote = 'community token';
    const claim = { kind: 'NARRATIVE', value: 'Community', evidenceId: 'missing-source', quote, assertion: 'SOURCE_STATES' };
    const missingId = parseGeminiSemantic(geminiResponse([claim]), packet, MINT, [{ id: 'web-page-1', text: sourceWith(quote) }]);
    assert.equal(missingId.status, 'INVALID');
    assert.deepEqual(missingId.validationErrors, ['UNSUPPORTED_CITATION']);
    const missingMint = parseGeminiSemantic(geminiResponse([{
      ...claim, evidenceId: 'web-page-1',
    }]), packet, MINT, [{ id: 'web-page-1', text: 'A community token is discussed here.' }]);
    assert.equal(missingMint.status, 'INVALID');
    assert.deepEqual(missingMint.validationErrors, ['UNSUPPORTED_CITATION']);
  });

  await t.test('one unsupported sibling invalidates the complete batch', () => {
    const good = { kind: 'NARRATIVE', value: 'Community', evidenceId: 'web-page-1', quote: 'community token', assertion: 'SOURCE_STATES' };
    const bad = { ...good, value: 'Fabricated', quote: 'project is guaranteed to moon' };
    const source = 'Mint ' + MINT + '\nIt is a community token.';
    const result = parseGeminiSemantic(geminiResponse([good, bad]), packet, MINT, [{ id: 'web-page-1', text: source }]);
    assert.equal(result.status, 'INVALID');
    assert.deepEqual(result.validationErrors, ['UNSUPPORTED_CITATION']);
    assert.deepEqual(result.claims, []);
  });
});

test('legacy Gemini parser cannot cite text beyond its supplied source excerpt', () => {
  const visibleQuote = 'Visible release notes';
  const hiddenQuote = 'Unseen founder guarantee';
  const pageText = 'Mint ' + MINT + '\nThe page says ' + visibleQuote + '.\n' + 'x'.repeat(6100) + '\n' + hiddenQuote + '.';
  assert.ok(pageText.length > 6000);
  assert.ok(pageText.indexOf(hiddenQuote) >= 6000);
  const submitted = pageText.slice(0, 6000);
  assert.ok(submitted.includes(visibleQuote));
  assert.equal(submitted.includes(hiddenQuote), false);
  const source = [{ id: 'web-page-1', text: submitted }];
  const packet = JSON.stringify({ sources: source });
  const visible = parseGeminiSemantic(geminiResponse([{
    kind: 'NARRATIVE', value: 'Synthetic statement', evidenceId: 'web-page-1', quote: visibleQuote, assertion: 'SOURCE_STATES',
  }]), packet, MINT, source);
  assert.equal(visible.status, 'CANDIDATE');
  assert.equal(visible.claims[0]?.quote, visibleQuote);
  const hidden = parseGeminiSemantic(geminiResponse([{
    kind: 'NARRATIVE', value: 'Synthetic statement', evidenceId: 'web-page-1', quote: hiddenQuote, assertion: 'SOURCE_STATES',
  }]), packet, MINT, source);
  assert.equal(hidden.status, 'INVALID');
  assert.deepEqual(hidden.validationErrors, ['UNSUPPORTED_CITATION']);

  const tailOnlyMintText = visibleQuote + '\n' + 'x'.repeat(6000) + '\n' + MINT;
  const submittedText = tailOnlyMintText.slice(0, 6000);
  assert.equal(submittedText.includes(MINT), false);
  const tailMint = parseGeminiSemantic(
    geminiResponse([{ kind: 'NARRATIVE', value: 'Synthetic statement', evidenceId: 'web-page-1', quote: visibleQuote, assertion: 'SOURCE_STATES' }]),
    JSON.stringify({ sources: [{ id: 'web-page-1', text: submittedText }] }),
    MINT,
    [{ id: 'web-page-1', text: submittedText }],
  );
  assert.equal(tailMint.status, 'INVALID');
  assert.deepEqual(tailMint.validationErrors, ['UNSUPPORTED_CITATION']);
});

test('thirty exact-mint DEX pairs stay visibly truncated at twenty retained', async () => {
  const mock = mockedFetch({ dexValue: Array.from({ length: 30 }, (_, index) => pair(index)) });
  const result = await collectLiveSolana(token, liveOptions(mock.fetcher));
  assert.equal(result.market?.reportedPairCount, 30);
  assert.equal(result.market?.retainedPairCount, 20);
  assert.equal(result.market?.pairs.length, 20);
  assert.equal(result.market?.truncated, true);
  assert.deepEqual(result.collection.dex, { state: 'TRUNCATED', count: 20 });
});

test('legacy Gemini parser accepts exact source claims and rejects malformed model output', () => {
  const pageText = `Mint ${MINT}: the project describes itself as a community token.`;
  const supportedClaim = { kind: 'NARRATIVE', value: 'Community token', evidenceId: 'web-page-1', quote: 'a community token', assertion: 'SOURCE_STATES' };
  const packet = JSON.stringify({ sources: [{ id: 'web-page-1', text: pageText }] });
  const sources = [{ id: 'web-page-1', text: pageText }];
  const candidate = parseGeminiSemantic(geminiResponse([supportedClaim]), packet, MINT, sources);
  assert.equal(candidate.status, 'CANDIDATE');
  assert.equal(candidate.claims.length, 1);

  const unsupported = parseGeminiSemantic(geminiResponse([{ ...supportedClaim, quote: 'the project is legitimate' }]), packet, MINT, sources);
  assert.equal(unsupported.status, 'INVALID');
  assert.deepEqual(unsupported.validationErrors, ['UNSUPPORTED_CITATION']);
  const missingId = parseGeminiSemantic(geminiResponse([{ ...supportedClaim, evidenceId: 'unfetched-source' }]), packet, MINT, sources);
  assert.equal(missingId.status, 'INVALID');
  assert.deepEqual(missingId.validationErrors, ['UNSUPPORTED_CITATION']);
  assert.equal(parseGeminiSemantic(geminiResponse([], 'MAX_TOKENS'), packet, MINT, sources).status, 'INVALID');
  const blocked = parseGeminiSemantic({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }, packet, MINT, sources);
  assert.equal(blocked.status, 'INVALID');
  assert.deepEqual(blocked.validationErrors, ['BLOCKED']);
});

test('full Solana discovery seeds only exact-base DEX links and qualifies linked source posts through both model passes', async () => {
  const siteSeed = 'https://official.example/project';
  const profileSeed = 'https://x.com/community';
  const whitepaper = 'https://official.example/whitepaper/overview';
  const linkedPost = 'https://x.com/community/status/601';
  const searchPage = 'https://public.example/search-page';
  const searchPost = 'https://x.com/search_author/status/501';
  const quoteOnlyLink = 'https://quote-only.example/project';
  const unrelatedChainLink = 'https://foreign.example/project';
  const wrongAccountPost = 'https://x.com/other_account/status/602';
  const text = new Map<string, string>([
    [siteSeed, `Mint ${MINT}: the project describes its River Lantern neighborhood art community.`],
    [profileSeed, `Project account for ${MINT}; neighbors share ongoing River Lantern artwork.`],
    [whitepaper, `Mint ${MINT}: the project mechanism funds shared community artwork.`],
    [linkedPost, `Mint ${MINT}: neighbors share an original River Lantern community art update.`],
    [searchPage, `Mint ${MINT}: the bounded search sample includes a public project mention.`],
    [searchPost, `Mint ${MINT}: price and chart volume update only.`],
  ]);
  const requestedUrls: string[] = [];
  // This fixture covers DEX-seeded source acquisition; omit a usable name so it stays outside comparison-ledger qualification.
  const exactBase = pair(0, { baseToken: { address: MINT, name: '' }, info: {
    websites: [{ url: siteSeed }], socials: [{ url: profileSeed }],
  } });
  const quoteOnly = pair(1, { info: {
    websites: [{ url: quoteOnlyLink }], socials: [],
  } });
  const unrelatedChain = pair(2, { chainId: 'ethereum', info: {
    websites: [{ url: unrelatedChainLink }], socials: [],
  } });
  const mock = mockedFetch({
    dexValue: [exactBase, quoteOnly, unrelatedChain],
    searchValue: { results: [{ url: searchPage }, { url: searchPost }] },
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({
      url, final_url: url, text: text.get(url) ?? `Mint ${MINT}: retained exact-token source for ${url}.`,
      ...(url.includes('/status/') ? { published_date: '2026-09-29T10:00:00Z' } : {}),
      ...(url === siteSeed ? { links: [whitepaper, 'https://elsewhere.example/docs/guide'] } : {}),
      ...(url === profileSeed ? { links: [linkedPost, wrongAccountPost] } : {}),
    })), errors: [] }),
    attentionResponse: (packet, call) => {
      if (isSocialModelPacket(packet)) {
        return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'This fixture deliberately returns the attention schema to the social proposal pass.' } });
      }
      const typedPacket = packet as AttentionPacket;
      const value = packet.proposal
        ? { decisions: Object.fromEntries((typedPacket.requiredDecisionIds as string[]).map(id => [id, {
          accepted: true, rationale: 'The exact source span supports this synthetic live integration label.',
        }])),
          candidateSet: { complete: false, rationale: 'The synthetic source packet does not claim complete representation coverage.' },
          originRelationship: {
            status: 'UNKNOWN', citations: [],
            rationale: 'The synthetic source packet has no accepted A03 claim linked to a dated project post.',
          },
        }
        : {
          claims: [{ id: 'community-narrative', feature: 'A01', value: true,
            summary: 'The source describes a River Lantern community art project.',
            citations: [{ sourceId: attentionSourceId(packet, 'describes its River Lantern'), spanId: attentionSpanId(packet, attentionSourceId(packet, 'describes its River Lantern'), 'describes its River Lantern') }] }],
          posts: Object.fromEntries((typedPacket.requiredPostSourceIds as string[]).map(sourceId => {
            const source = typedPacket.sources.find(item => item.id === sourceId)!;
            const priceOnly = source.spans.some(span => span.text.includes('price and chart volume update only'));
            return [sourceId, { spanId: attentionSpanId(packet, sourceId, 'Mint ' + MINT), role: priceOnly ? 'PRICE_ONLY' : 'NEWS' }];
          })),
          competitors: [],
        };
      assert.ok(call === 1 || call === 2);
      return attentionEnvelope(value);
    },
  });

  const result = await collectLiveSolana(token, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: GEMINI_KEY, semanticEnabled: true,
  }));
  const providerCalls = assertSocialProviderCallsAreSeparated(mock, result.rawArtifacts);
  assert.deepEqual(providerCalls, { attentionSearchCount: 2, socialSearchCount: 1, attentionFetchCount: 2, socialFetchCount: 1 }, 'social Search uses only the required query when the bounded context plan is already full');
  const fetchCalls = mock.calls.filter(call => call.url === 'https://api.fetch.tinyfish.ai/');
  assert.equal(fetchCalls.length, 3, 'the social acquisition adds one bounded Fetch batch after the two attention batches');
  const fetchBatches = fetchCalls.map(call => (JSON.parse(String(call.init?.body)) as { urls: string[]; links: boolean }).urls);
  assert.deepEqual(fetchBatches[0], [siteSeed, profileSeed, searchPage, searchPost], 'exact-base DEX links lead the search URLs');
  assert.deepEqual(fetchBatches[1], [whitepaper, linkedPost], 'only same-host project docs and same-account direct posts are expanded');
  assert.ok(fetchCalls.every(call => (JSON.parse(String(call.init?.body)) as { links?: boolean }).links === true));
  const flattened = fetchBatches.flat();
  assert.equal(flattened.includes(quoteOnlyLink), false, 'a quote-side DEX token does not contribute project links');
  assert.equal(flattened.includes(unrelatedChainLink), false, 'another chain does not contribute project links');
  assert.equal(flattened.includes(wrongAccountPost), false, 'a seeded account cannot expand to another account');

  assert.deepEqual(result.collection.web, { state: 'OBSERVED', count: 6 });
  const attentionPackets = mock.geminiPackets.filter(packet => !isSocialModelPacket(packet));
  const socialPackets = mock.geminiPackets.filter(isSocialModelPacket);
  assert.equal(attentionPackets.length, 2, `attention retains its proposal and independent review requests; packet keys: ${JSON.stringify(mock.geminiPackets.map(packet => Object.keys(packet)))}`);
  assert.equal(socialPackets.length, 1, 'the social stage attempts its proposal before rejecting this attention-shaped fixture');
  assertInvalidSocialProposal(result.rawArtifacts);
  const proposalPacket = attentionPackets[0] as { scope: { discoveryUrls: string[] }; sources: AttentionPacket['sources'] };
  const reviewPacket = attentionPackets[1] as { scope: { discoveryUrls: string[] }; sources: AttentionPacket['sources'] };
  assert.deepEqual(proposalPacket.scope.discoveryUrls, [siteSeed, profileSeed]);
  assert.deepEqual(reviewPacket.scope.discoveryUrls, proposalPacket.scope.discoveryUrls);
  assert.deepEqual(reviewPacket.sources, proposalPacket.sources);
  const linkedPostSource = proposalPacket.sources.find(source => source.spans.some(span => span.text.includes('original River Lantern community art update')));
  const docsSource = proposalPacket.sources.find(source => source.spans.some(span => span.text.includes('project mechanism funds shared community artwork')));
  assert.equal(linkedPostSource?.discoveredFrom, profileSeed);
  assert.equal(docsSource?.discoveredFrom, siteSeed);
  assert.equal(JSON.stringify(result).includes(TINYFISH_KEY), false);
  assert.equal(JSON.stringify(result).includes(GEMINI_KEY), false);

  const rowById = new Map(result.details?.baseline.map(row => [row.id, row]) ?? []);
  assert.equal(rowById.get('A01')?.quality, 'KNOWN');
  assert.equal(rowById.get('A01')?.projection?.value, true);
  assert.equal(result.semantic.status, 'VALIDATED');
  assert.equal(result.semantic.claims[0]?.evidenceId, attentionSourceId(mock.geminiPackets[0]!, 'describes its River Lantern'));
  assert.equal(result.semantic.claims[0]?.quote, text.get(siteSeed));
  assert.equal(rowById.get('A15')?.quality, 'KNOWN');
  assert.equal((rowById.get('A15')?.data as { raw?: number })?.raw, 2);
  assert.equal(rowById.get('A16')?.quality, 'KNOWN');
  assert.equal(rowById.get('A16')?.projection?.value, '1');
});

test('A18 excludes a clipped old post but requires retained full text for in-window posts and dates', async () => {
  const longText = `Mint ${MINT}: an original neighborhood art community update. ${'x'.repeat(8_100)}`;
  const cases = [
    { name: 'dated before-window post', publishedDate: '2026-09-27T10:00:00Z', complete: true, quality: 'KNOWN' },
    { name: 'clipped in-window post', publishedDate: '2026-09-29T10:00:00Z', complete: false, quality: 'MISSING' },
    { name: 'missing post date', publishedDate: undefined, complete: false, quality: 'MISSING' },
  ] as const;

  for (const scenario of cases) {
    const postUrl = 'https://x.com/river_lantern/status/991';
    const mock = mockedFetch({
      dexValue: [pair(0, { baseToken: { address: MINT, name: '' }, info: { websites: [], socials: [] } })],
      searchValue: () => ({ results: [{ url: postUrl, title: 'Original community update', snippet: `Mint ${MINT}` }] }),
      fetchValue: (urls: string[]) => ({ results: urls.map(url => ({
        url, final_url: url, text: longText, ...(scenario.publishedDate ? { published_date: scenario.publishedDate } : {}),
      })), errors: [] }),
      attentionResponse: packet => {
        if (isSocialModelPacket(packet)) {
          return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'No social judgment is needed for this attention scope.' } });
        }
        const typed = packet as AttentionPacket;
        if (!packet.proposal) {
          return attentionEnvelope({
            claims: [],
            posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(sourceId => [
              sourceId, { spanId: attentionSpanId(packet, sourceId, MINT), role: 'NEWS' },
            ])),
            competitors: [],
          });
        }
        return attentionEnvelope({
          decisions: Object.fromEntries((typed.requiredDecisionIds ?? []).map(id => [id, {
            accepted: true, rationale: 'The source span is an original token-bound community update.',
          }])),
          candidateSet: { complete: false, rationale: 'This fixture has no comparison scope.' },
          originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'This fixture has no primary-origin evidence.' },
        });
      },
    });

    const bundle = await collectLiveSolana(token, liveOptions(mock.fetcher, {
      tinyfishKey: TINYFISH_KEY, geminiKey: GEMINI_KEY, semanticEnabled: true,
    }));
    const receipt = JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as {
      read: { sources: Array<{ id: string; text: string }>; growthSample: { complete: boolean } };
    };
    const submitted = receipt.read.sources[0]!;
    const a18 = bundle.details?.baseline.find(row => row.id === 'A18');
    const attentionPackets = mock.geminiPackets.filter(packet => !isSocialModelPacket(packet)) as AttentionPacket[];
    assert.ok(bundle.rawArtifacts[submitted.id], 'the original acquired body remains separately retained');
    assert.equal(bundle.rawArtifacts[submitted.id]!.length, longText.length);
    assert.equal(submitted.text.length, 6_000, 'the replay receipt matches the actual model-bound source prefix');
    assert.ok(attentionPackets.length >= 2);
    for (const packet of attentionPackets.slice(0, 2)) {
      const source = packet.sources.find(item => item.id === submitted.id)!;
      assert.equal(source.spans.map(span => span.text).join('').length, 6_000, 'both model passes receive only the bounded prefix');
    }
    assert.equal(receipt.read.growthSample.complete, scenario.complete, scenario.name);
    assert.equal(a18?.quality, scenario.quality, scenario.name);
    if (scenario.name === 'dated before-window post') {
      assert.equal((a18?.projection?.value), false, 'the dated old post is excluded from both growth bins');

      const directory = mkdtempSync(join(tmpdir(), 'shared-a18-proof-'));
      try {
        const database = join(directory, 'shared.sqlite');
        const writer = new Service(database);
        let snapshotId = '';
        let savedHash = '';
        try {
          const saved = writer.analyzeLive(bundle);
          snapshotId = saved.id;
          savedHash = saved.hash;
        } finally {
          writer.close();
        }
        const reopened = new Service(database);
        try {
          const replay = reopened.replay(snapshotId);
          assert.equal(replay.hash, savedHash);
          assert.deepEqual(replay, reopened.show(snapshotId), 'the valid shared derivation survives save, close, reopen, and replay');
        } finally {
          reopened.close();
        }

        const tampered = structuredClone(bundle);
        const proofRecord = tampered.evidence.find(item => item.id === 'shared-derivation');
        assert.ok(proofRecord);
        const proof = JSON.parse(tampered.rawArtifacts[proofRecord.id]!) as { sources: AttentionPacket['sources'] };
        assert.ok(proof.sources.length > 0);
        proof.sources.pop();
        tampered.rawArtifacts[proofRecord.id] = JSON.stringify(proof);
        proofRecord.contentHash = sha256(tampered.rawArtifacts[proofRecord.id]!);
        const verifier = new Service(join(directory, 'tampered.sqlite'));
        try {
          assert.throws(() => verifier.analyzeLive(tampered), /SHARED_SOURCE_INVALID/,
            'rehashed shared proof cannot omit an acquired source from the exact attention/social source union');
        } finally {
          verifier.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  }
});

test('live qualification retains full comparison batches and emits a locally derived batch manifest', async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const rival = '0x2222222222222222222222222222222222222222';
  const postUrl = 'https://x.com/river_lantern/status/901';
  const targetLead = `The River Lantern neighborhood-art project represents exact contract ${target.address}.`;
  const rivalTail = ` Rival contract ${rival}.`;
  const comparisonText = targetLead
    + 'x'.repeat(15_100 - targetLead.length)
    + rivalTail
    + 'z'.repeat(16_166 - 15_100 - rivalTail.length);
  assert.equal(comparisonText.length, 16_166);
  assert.ok(comparisonText.indexOf(rival) > 15_100);

  let attentionModelCalls = 0;
  let invalidSocialModelCalls = 0;
  const mock = mockedFetch({
    dexValue: [{ chainId: 'base', pairAddress: 'comparisonFixturePair', baseToken: { address: target.address, name: 'River Lantern' }, quoteToken: { address: '0x3333333333333333333333333333333333333333' } }],
    searchValue: requestUrl => {
      const query = new URL(requestUrl).searchParams.get('query') ?? '';
      return { results: query.includes('"River Lantern"') ? [{
        url: postUrl, title: 'River Lantern exact-contract source',
        snippet: `The project post names exact contract ${target.address}.`,
      }] : [] };
    },
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({
      url, final_url: url, text: comparisonText, published_date: '2026-09-29T10:00:00Z',
    })), errors: [] }),
    attentionResponse: packet => {
      if (isSocialModelPacket(packet)) {
        invalidSocialModelCalls++;
        return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'This fixture deliberately returns the attention schema to the social proposal pass.' } });
      }
      const attentionCall = ++attentionModelCalls;
      const typed = packet as AttentionPacket;
      const scope = packet.scope as { batch?: number } | undefined;
      if (packet.manifest) {
        assert.equal(attentionCall, 7);
        return attentionEnvelope({
          decisions: Object.fromEntries((typed.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The retained batch citations support this merged exact-contract candidate.',
          }])),
          candidateSet: { complete: true, rationale: 'Every full-text batch includes its supported exact-contract representations in the global merge.' },
        });
      }
      if (typeof scope?.batch === 'number' && packet.proposal) {
        assert.equal(attentionCall, 6);
        return attentionEnvelope({
          decisions: Object.fromEntries((typed.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The complete original spans support this batch item.',
          }])),
          candidateSet: { complete: true, rationale: 'Every exact-contract representation visible in this complete-text batch is proposed and accepted.' },
          ...comparisonReviewFields(packet),
        });
      }
      if (typeof scope?.batch === 'number') {
        assert.equal(attentionCall, 5);
        const source = typed.sources.find(item => item.spans.some(span => span.text.includes(target.address)));
        const rivalSource = typed.sources.find(item => item.spans.some(span => span.text.includes(rival)));
        assert.ok(source, 'the full-text batch contains the target representation');
        assert.ok(rivalSource, 'the full-text batch contains the tail rival');
        return attentionEnvelope({
          competitors: [
            { id: 'target-fulltext', token: target, sourceId: source.id, spanId: attentionSpanId(packet, source.id, target.address) },
            { id: 'rival-tail', token: { chain: 'base', address: rival }, sourceId: rivalSource.id, spanId: attentionSpanId(packet, rivalSource.id, rival) },
          ],
          posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => [id, { spanId: attentionSpanId(packet, id, target.address), role: 'NEWS' }])),
        });
      }
      if ((scope as { mode?: string } | undefined)?.mode === 'qualified-identified-leads-v2' && packet.proposal) {
        const proposed = packet.proposal as { decisions: Record<string, unknown> };
        const decisions = Object.fromEntries(Object.keys(proposed.decisions).map(id => [id, {
          accepted: true, rationale: 'The independent review accepts the disposition from its exact indexed and fetched source spans.',
          subjectComparison: { accepted: true, rationale: 'The indexed project and retained page describe the same River Lantern mechanism.' },
          evidenceAdequacy: { accepted: true, rationale: 'No source mismatch establishes inadequate public representation for this lead.' },
        }]));
        return attentionEnvelope({ decisions: comparisonLeadArray(decisions) });
      }
      if ((scope as { mode?: string } | undefined)?.mode === 'qualified-identified-leads-v2') {
        const leads = packet.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[] }>;
        const decisions = Object.fromEntries(leads.map(lead => {
          const sourceId = lead.sourceIds[0];
          const source = typed.sources.find(item => item.id === sourceId);
          assert.ok(source, `the acquired named lead ${lead.id} retains its source`);
          const span = source.spans.find(item => item.text.includes(target.address));
          assert.ok(span, `the indexed source ${lead.id} contains the exact target contract`);
          return [lead.id, {
            disposition: 'ACQUIRED', rationale: 'The retained project post is consistent with its indexed exact-contract description.',
            descriptorRefs: [{ sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId) }],
            corroboratingRefs: [{ sourceId, spanId: span.id }], token: null,
            subjectComparison: {
              status: 'CONSISTENT', indexedSubject: 'River Lantern neighborhood-art project', currentSubject: 'River Lantern neighborhood-art project',
              rationale: 'The indexed project descriptor and the fetched original project post describe the same River Lantern project.',
              descriptorRefs: [{ sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId) }],
              fetchedRefs: [{ sourceId, spanId: span.id }],
            },
            evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'The retained profile and project post do not show a current subject mismatch.', citations: [] },
          }];
        }));
        return attentionEnvelope({ decisions: comparisonLeadArray(decisions) });
      }
      if (packet.proposal) {
        assert.equal(attentionCall, 2);
        return attentionEnvelope({
          decisions: Object.fromEntries((typed.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The bounded base span supports this synthetic review item.',
          }])),
          candidateSet: { complete: false, rationale: 'The initial text prefix cannot establish all representations in retained source text.' },
          originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No primary project relationship is established in this source.' },
        });
      }
      assert.equal(attentionCall, 1);
      const source = typed.sources.find(item => item.spans.some(span => span.text.includes(target.address)));
      assert.ok(source, 'the base prefix retains the early target contract');
      return attentionEnvelope({
        claims: [{ id: 'claim-topic', feature: 'A01', value: true,
          summary: 'The source connects River Lantern with its neighborhood-art project narrative.',
          citations: [{ sourceId: source.id, spanId: attentionSpanId(packet, source.id, target.address) }] }],
        posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => [id, { spanId: attentionSpanId(packet, id, target.address), role: 'CALL' }])),
        competitors: [],
      });
    },
  });

  const result = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: GEMINI_KEY, semanticEnabled: true,
  }));

  const providerCalls = assertSocialProviderCallsAreSeparated(mock, result.rawArtifacts);
  assert.deepEqual(providerCalls, { attentionSearchCount: 3, socialSearchCount: 2, attentionFetchCount: 1, socialFetchCount: 1 });
  const attentionPackets = mock.geminiPackets.filter(packet => !isSocialModelPacket(packet));
  const socialPackets = mock.geminiPackets.filter(isSocialModelPacket);
  assert.equal(attentionModelCalls, 7, JSON.stringify(result.semantic));
  assert.equal(attentionPackets.length, 7, 'base and full comparison passes retain their prior seven attention calls');
  assert.equal(socialPackets.length, 1);
  assert.equal(invalidSocialModelCalls, 1);
  assertInvalidSocialProposal(result.rawArtifacts);
  const comparisonSourceId = (attentionPackets[0]!.scope as { comparisonSourceIds: string[] }).comparisonSourceIds[0]!;
  assert.equal((attentionPackets[0]!.scope as { comparisonDeferred?: boolean }).comparisonDeferred, true);
  const baseProposalResponse = JSON.parse(result.rawArtifacts['attention-proposal-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  assert.deepEqual((JSON.parse(baseProposalResponse.candidates[0]!.content.parts[0]!.text) as { competitors: unknown[] }).competitors, [], 'the base pass leaves comparison candidates to full-text review');
  assert.equal(result.rawArtifacts[comparisonSourceId], comparisonText, 'live evidence retains the full collector text, including the rival after the model prefix');
  for (const packet of attentionPackets.slice(0, 2)) {
    const submitted = (packet.sources as AttentionPacket['sources']).find(source => source.id === comparisonSourceId)!;
    assert.equal(submitted.spans.map(span => span.text).join('').length, 6000, 'the base narrative and origin passes keep their established bounded prefix');
  }
  const batchPacket = attentionPackets.find(packet => (packet.scope as { batch?: number } | undefined)?.batch === 1 && !packet.proposal)!;
  const fullBatchSource = (batchPacket.sources as AttentionPacket['sources']).find(source => source.id === comparisonSourceId)!;
  assert.equal(fullBatchSource.spans.map(span => span.text).join(''), comparisonText, 'the comparison pass receives every retained character');
  assert.ok(fullBatchSource.spans.some(span => span.text.includes(rival)), 'the tail rival is visible to the comparison proposal');
  assert.ok(result.rawArtifacts['attention-comparison-1-proposal-prompt']);
  assert.ok(result.rawArtifacts['attention-comparison-1-review-prompt']);
  assert.ok(result.rawArtifacts['attention-comparison-final-review-prompt']);
  assert.ok(result.rawArtifacts['attention-comparison-manifest']);

  const retainedScope = JSON.parse(result.rawArtifacts['attention-scope']!) as {
    comparisonComplete: boolean; comparisonSourceIds: string[]; codes: string[];
  };
  assert.equal(retainedScope.comparisonComplete, true);
  assert.deepEqual(retainedScope.comparisonSourceIds, [comparisonSourceId]);
  assert.equal(retainedScope.codes.includes('ATT_MODEL_COMPARISON_TEXT_CAP'), false);
  const scopeRecord = result.evidence.find(item => item.id === 'attention-scope');
  assert.equal(scopeRecord?.sourceType, 'SAMPLE_SCOPE');
  assert.equal(scopeRecord?.scope.method, 'comparison-scope-v2');
  const manifestRecord = result.evidence.find(item => item.id === 'attention-comparison-manifest');
  assert.equal(manifestRecord?.sourceId, 'attention-collector');
  assert.equal(manifestRecord?.sourceType, 'SAMPLE_SCOPE');
  assert.equal(manifestRecord?.accessMode, 'LOCAL_DERIVED');
  assert.equal(manifestRecord?.scope.method, 'complete-comparison-batches-v1');
  const rivalEvidence = result.details?.baseline.find(row => row.id === 'A09')?.data as { candidates?: Array<{ token: { address: string }; quote: string }> } | undefined;
  assert.ok(rivalEvidence?.candidates?.some(candidate => candidate.token.address === rival && comparisonText.includes(candidate.quote)));

  const rows = new Map(result.details?.baseline.map(row => [row.id, row]) ?? []);
  assert.equal(rows.get('A09')?.quality, 'KNOWN');
  assert.equal(rows.get('A11')?.quality, 'MISSING', 'one common-name post cannot establish representation leadership');
  assert.equal(rows.get('A11')?.causes[0]?.code, 'ATT_COMPARABLE_SAMPLE_INSUFFICIENT');
  const routes = rows.get('A14')?.data as { originRelationship: { status: string }; measuredAttention: { status: string } } | undefined;
  assert.equal(routes?.originRelationship.status, 'UNKNOWN');
  assert.equal(routes?.measuredAttention.status, 'UNKNOWN');
});

test('live lead recovery preserves both scopes and source lineage through isolated Service replay', async () => {
  const target = { chain: 'solana', address: MINT } as const;
  const alternate = { chain: 'solana', address: OTHER_MINT } as const;
  const targetUrl = 'https://public.example/river-lantern';
  const failedUrl = 'https://index.example/ava';
  const alternateUrl = 'https://projects.example/avaai-contract';
  const targetText = `The River Lantern project represents exact contract ${target.address}. Its community shares a neighborhood story.`;
  const alternateText = `AVAAI represents the indexed digital-parasite project under exact contract ${alternate.address}; this is a separate Solana representation.`;
  let clockMs = Date.parse('2026-10-06T12:00:00.000Z');
  const fakeNow = () => new Date(clockMs).toISOString();
  let attentionModelCalls = 0;
  const mock = mockedFetch({
    dexValue: (dexCall: number) => [pair(0, { baseToken: { address: target.address, name: 'River Lantern' }, priceUsd: dexCall === 0 ? '0.001' : '0.002' })],
    searchValue: requestUrl => {
      const query = new URL(requestUrl).searchParams.get('query') ?? '';
      if (query.includes('(site:x.com OR site:twitter.com)')) return { results: [] };
      if (query.includes('"River Lantern"')) return { results: [
        { url: targetUrl, title: 'River Lantern exact target project', snippet: `Project contract ${target.address}.` },
        { url: failedUrl, title: 'AVA AI digital parasite project', snippet: 'The indexed project describes a digital-parasite mechanism.' },
      ] };
      if (query.includes(`"${target.address}"`)) return { results: [{ url: targetUrl }] };
      return { results: [{
        url: alternateUrl, title: 'AVAAI exact contract project page',
        snippet: 'This page connects the indexed AVAAI digital-parasite project to its deployed contract.',
      }] };
    },
    fetchValue: (urls: string[]) => urls.includes(failedUrl)
      ? { results: [{ url: targetUrl, final_url: targetUrl, text: targetText }], errors: [{ url: failedUrl, status: 404, error: 'not_found' }] }
      : { results: urls.map((url: string) => ({ url, final_url: url, text: url === alternateUrl ? alternateText : 'A retained public project page.' })), errors: [] },
    attentionResponse: packet => {
      const attentionCall = ++attentionModelCalls;
      clockMs += 61_000;
      const typed = packet as AttentionPacket;
      const scope = packet.scope as Record<string, unknown> | undefined;
      if (packet.manifest) {
        assert.equal(attentionCall, 8);
        return attentionEnvelope({
          decisions: Object.fromEntries((packet.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The chain-qualified contracts remain bound to reviewed source observations.',
          }])),
          candidateSet: { complete: true, rationale: 'The target and every positively recovered representation are present in the reviewed merge.' },
        });
      }
      if (typeof scope?.batch === 'number') {
        if (packet.proposal) {
          assert.equal(attentionCall, 7);
          return attentionEnvelope({
          decisions: Object.fromEntries((packet.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The exact source span supports this reviewed comparison item.',
          }])),
          candidateSet: { complete: true, rationale: 'Every relevant exact-contract observation in the retained batch is included.' },
          ...comparisonReviewFields(packet),
          });
        }
        assert.equal(attentionCall, 6);
        const competitors = [] as Array<{ id: string; token: TokenRef; sourceId: string; spanId: string }>;
        if (typed.sources.some(source => source.spans.some(span => span.text.includes(target.address)))) {
          const sourceId = attentionSourceId(packet, target.address);
          competitors.push({ id: 'target-recovered-review', token: target, sourceId, spanId: attentionSpanId(packet, sourceId, target.address) });
        }
        if (typed.sources.some(source => source.spans.some(span => span.text.includes(alternate.address)))) {
          const sourceId = attentionSourceId(packet, alternate.address);
          competitors.push({ id: 'alternate-recovered-review', token: alternate, sourceId, spanId: attentionSpanId(packet, sourceId, alternate.address) });
        }
        return attentionEnvelope({ competitors, posts: {} });
      }
      if (packet.selectedLeadIds) {
        const selected = packet.leads as Array<{ id: string; metadataEvidenceId: string }>;
        const metadata = packet.metadata as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
        return attentionEnvelope({ leads: Object.fromEntries(selected.map(lead => {
          const source = metadata.find(item => item.id === lead.metadataEvidenceId);
          assert.ok(source, `V2 recovery plan includes own descriptor ${lead.metadataEvidenceId}`);
          const descriptor = source.spans.find(span => span.text.includes('digital parasite'));
          assert.ok(descriptor, 'V2 recovery plan receives the failed lead descriptor');
          return [lead.id, {
            queries: ['Find AVAAI digital parasite project original sources and exact contract on Solana'],
            rationale: 'Find independent sources identifying the indexed AVAAI mechanism and its contract.',
            metadataRefs: [{ sourceId: lead.metadataEvidenceId, spanId: descriptor.id }],
          }];
        })) });
      }
      if (scope?.mode === 'qualified-identified-leads-v2' && packet.proposal) {
        const proposed = packet.proposal as { decisions: Record<string, unknown> };
        const decisions = Object.fromEntries(Object.keys(proposed.decisions).map(id => [id, {
          accepted: true, rationale: 'Independent review accepts the source-bound subject and its evidence route.',
          subjectComparison: { accepted: true, rationale: 'The indexed and fetched subject spans are independently compared.' },
          evidenceAdequacy: { accepted: true, rationale: 'No inadequate public representation finding is proposed for this lead.' },
        }]));
        return attentionEnvelope({ decisions: comparisonLeadArray(decisions) });
      }
      if (scope?.mode === 'qualified-identified-leads-v2') {
        const leads = packet.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[]; recoverySourceIds: string[] }>;
        const decisions = Object.fromEntries(leads.map(lead => {
          const descriptorRefs = [{ sourceId: lead.metadataEvidenceId, spanId: attentionSpanId(packet, lead.metadataEvidenceId, '') }];
          if (lead.id === 'comparison-lead-1') return [lead.id, {
            disposition: 'ACQUIRED', rationale: 'The original target lead is bound to its fetched project page.', descriptorRefs,
            corroboratingRefs: [{ sourceId: 'attention-page-1', spanId: attentionSpanId(packet, 'attention-page-1', target.address) }], token: null,
            subjectComparison: {
              status: 'CONSISTENT', indexedSubject: 'River Lantern exact target project', currentSubject: 'River Lantern exact target project',
              rationale: 'The indexed target descriptor and original fetched project page identify the same subject.', descriptorRefs,
              fetchedRefs: [{ sourceId: 'attention-page-1', spanId: attentionSpanId(packet, 'attention-page-1', target.address) }],
            },
            evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'The target project sources show no indexed-to-current subject mismatch.', citations: [] },
          }];
          const sourceId = attentionSourceId(packet, alternate.address);
          return [lead.id, {
            disposition: 'ALTERNATIVE_BOUND', rationale: 'The fetched exact contract is linked to the independently indexed AVAAI mechanism.', descriptorRefs,
            corroboratingRefs: [{ sourceId, spanId: attentionSpanId(packet, sourceId, alternate.address) }], token: alternate,
            subjectComparison: {
              status: 'CONSISTENT', indexedSubject: 'AVAAI digital-parasite project', currentSubject: 'AVAAI digital-parasite project',
              rationale: 'The indexed AVAAI mechanism and recovered project page identify the same subject.', descriptorRefs,
              fetchedRefs: [{ sourceId, spanId: attentionSpanId(packet, sourceId, alternate.address) }],
            },
            evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'The recovered AVAAI page resolves the indexed subject without an inadequacy finding.', citations: [] },
          }];
        }));
        return attentionEnvelope({ decisions: comparisonLeadArray(decisions) });
      }
      if (packet.proposal) return attentionEnvelope({
        decisions: Object.fromEntries((typed.requiredDecisionIds as string[]).map(id => [id, {
          accepted: true, rationale: 'The bounded narrative source supports this review item.',
        }])),
        candidateSet: { complete: false, rationale: 'The source prefix cannot establish all retained representations.' },
        originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No dated primary account relationship is established.' },
      });
      const targetSourceId = attentionSourceId(packet, target.address);
      return attentionEnvelope({
        claims: [{ id: 'claim-topic', feature: 'A01', value: true, summary: 'A community neighborhood project narrative.',
          citations: [{ sourceId: targetSourceId, spanId: attentionSpanId(packet, targetSourceId, target.address) }] }],
        posts: {}, competitors: [],
      });
    },
  });
  const directory = mkdtempSync(join(tmpdir(), 'attention-recovery-live-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  try {
    const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
      tinyfishKey: TINYFISH_KEY, geminiKey: GEMINI_KEY, semanticEnabled: true, now: fakeNow,
    }));
    const original = JSON.parse(bundle.rawArtifacts['attention-acquisition-scope']!) as {
      comparisonComplete: boolean; comparisonAcquisition: { originalComplete: boolean; leads: Array<{ id: string; acquisitionStatus: string }> };
    };
    const effective = JSON.parse(bundle.rawArtifacts['attention-scope']!) as {
      comparisonComplete: boolean; comparisonAcquisition: { originalComplete: boolean; leads: Array<{ id: string; acquisitionStatus: string; recoverySourceIds: string[] }> };
        comparisonQualification: { mode: string; complete: boolean; decisions: Array<{ leadId: string; disposition: string; qualified: boolean }> };
    };
    const recoveryMetadataId = 'attention-recovery-comparison-lead-1-metadata';
    const transportReceiptId = 'attention-proposal-transport-attempt-1';
    const snapshot = service.analyzeLive(bundle);
    const replayed = service.replay(snapshot.id);
    const evidence = new Map(snapshot.evidence.map(item => [item.id, item]));
    const metadataEvidence = evidence.get(recoveryMetadataId)!;
    const recoverySearchEvidence = evidence.get('attention-recovery-search-1')!;
    const recoveryPageEvidence = evidence.get('attention-recovery-page-1')!;
    const transportEvidence = evidence.get(transportReceiptId)!;
    const transportReceipt = JSON.parse(bundle.rawArtifacts[transportReceiptId]!) as {
      kind: string; attempt: number; phase: string; elapsedMs: number; budgetMs: number; code: string; willRetry: boolean;
    };
    const capture = JSON.parse(bundle.rawArtifacts['live-state-capture']!) as {
      method: string; discoveryId: string | null; startedAt: string; endedAt: string;
      canonical: Array<{ id: string; retrievedAt: string }>; rpcState: string; dexState: string;
    };
    const discovery = evidence.get('dex-discovery')!;
    const finalDex = evidence.get('dex-pairs')!;
    const dexCalls = mock.calls.map((call, index) => ({ call, index })).filter(({ call }) => call.url.startsWith('https://api.dexscreener.com/'));
    const geminiCallIndexes = mock.calls.flatMap((call, index) => call.url.startsWith('https://generativelanguage.googleapis.com/') ? [index] : []);
    const firstCanonicalRequestIndex = mock.calls.findIndex(call =>
      call.url.startsWith('https://rpc.example/') || call.url.startsWith('https://api.mainnet.solana.com'));

    assert.equal(bundle.analysisKind, 'LIVE');
    assert.equal(original.comparisonComplete, false);
    assert.equal(original.comparisonAcquisition.originalComplete, false);
    assert.equal(original.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-2')?.acquisitionStatus, 'FAILED');
    assert.equal(effective.comparisonComplete, true);
    assert.equal(effective.comparisonAcquisition.originalComplete, false, 'effective qualification preserves the failed original acquisition state');
    assert.equal(effective.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-2')?.acquisitionStatus, 'FAILED');
    assert.deepEqual(effective.comparisonQualification.decisions.map(decision => [decision.disposition, decision.qualified]), [['ACQUIRED', true], ['ALTERNATIVE_BOUND', true]]);
    assert.equal(metadataEvidence.sourceId, 'attention-collector');
    assert.equal(metadataEvidence.sourceType, 'INDEXED_LEAD');
    assert.equal(metadataEvidence.accessMode, 'LOCAL_DERIVED');
    assert.equal(recoverySearchEvidence.sourceId, 'tinyfish-search');
    assert.equal(recoverySearchEvidence.accessMode, 'FREE_ACCOUNT');
    assert.equal(recoveryPageEvidence.sourceId, 'tinyfish-fetch');
    assert.equal(recoveryPageEvidence.sourceType, 'WEB_PAGE');
    assert.equal(recoveryPageEvidence.accessMode, 'FREE_ACCOUNT');
    assert.equal(transportReceipt.kind, 'LOCAL_MODEL_TRANSPORT');
    assert.equal(transportReceipt.attempt, 1);
    assert.equal(transportReceipt.code, 'ATT_MODEL_HTTP_200', 'successful Gemini calls receive transport receipts too');
    assert.equal(transportReceipt.willRetry, false);
    assert.equal(transportEvidence.sourceId, 'attention-collector');
    assert.equal(transportEvidence.sourceType, 'SAMPLE_SCOPE');
    assert.equal(transportEvidence.accessMode, 'LOCAL_DERIVED');
    assert.equal(readFileSync(join(directory, 'artifacts', transportEvidence.contentHash), 'utf8'), bundle.rawArtifacts[transportReceiptId],
      'the isolated Service database retains the derived transport receipt by content hash');
    assert.equal(readFileSync(join(directory, 'artifacts', recoveryPageEvidence.contentHash), 'utf8'), alternateText,
      'Service stores recovered page content under its verified evidence hash');
    assert.deepEqual(replayed, snapshot, 'the temporary proof database reopens the live snapshot unchanged');
    assert.equal(capture.method, 'late-state-capture-v1');
    assert.equal(capture.discoveryId, 'dex-discovery');
    assert.ok(Date.parse(capture.startedAt) - Date.parse(discovery.retrievedAt) > 300_000,
      'the discovery quote is older than the state TTL after bounded semantic work');
    assert.equal(capture.rpcState, 'OBSERVED');
    assert.equal(capture.dexState, 'OBSERVED');
    assert.equal(dexCalls.length, 2, 'discovery and final canonical DEX reads are retained as separate requests');
    assert.ok(geminiCallIndexes.length > 0);
    assert.ok(Math.max(...geminiCallIndexes) < firstCanonicalRequestIndex,
      'the final canonical RPC starts only after attention, social, and shared semantic work');
    assert.ok(Math.max(...geminiCallIndexes) < dexCalls[1]!.index,
      'the final DEX observation follows semantic qualification');
    assert.equal((JSON.parse(bundle.rawArtifacts['dex-discovery']!) as Array<{ priceUsd: string }>)[0]?.priceUsd, '0.001');
    assert.equal((JSON.parse(bundle.rawArtifacts['dex-pairs']!) as Array<{ priceUsd: string }>)[0]?.priceUsd, '0.002');
    assert.equal(bundle.market?.pairs[0]?.priceUsd, '0.002', 'returned market state uses the final canonical response');
    assert.ok(capture.canonical.some(item => item.id === 'rpc-genesis' && item.retrievedAt === evidence.get('rpc-genesis')?.retrievedAt));
    assert.ok(capture.canonical.some(item => item.id === 'rpc-account' && item.retrievedAt === evidence.get('rpc-account')?.retrievedAt));
    assert.equal(capture.canonical.filter(item => item.id === 'dex-pairs').length, 1);
    assert.equal(bundle.evidence.filter(item => item.id === 'dex-pairs').length, 1);
    assert.ok(Date.parse(capture.endedAt) >= Math.max(...capture.canonical.map(item => Date.parse(item.retrievedAt))));
    const pumpCapture = evidence.get('pump-pool-config');
    assert.ok(pumpCapture, 'the venue attempt retains its post-capture pool read');
    assert.ok(Date.parse(pumpCapture.retrievedAt) >= Date.parse(capture.endedAt), 'PumpSwap inspection starts after canonical state capture');
    const discoveryId = 'dex-discovery';
    assert.equal(bundle.observations.some(item => item.evidenceIds.includes(discoveryId)), false,
      'discovery metadata never becomes a market observation');
    assert.equal(bundle.features.some(item => item.evidenceIds.includes(discoveryId)), false,
      'discovery metadata never supports a feature');
    assert.ok(bundle.features.find(item => item.id === 'O02')?.evidenceIds.includes('dex-pairs'),
      'derived FDV, when present, uses the final canonical pair record');
    assert.equal(bundle.features.find(item => item.id === 'O02')?.evidenceIds.includes(discoveryId), false);
    assert.equal(JSON.stringify(bundle).includes(TINYFISH_KEY), false);
    assert.equal(JSON.stringify(bundle).includes(GEMINI_KEY), false);
    assert.equal(JSON.stringify(transportReceipt).includes('generativelanguage.googleapis.com'), false);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('shared late capture preserves discovery but never uses it when final RPC and DEX reads fail', async () => {
  const target = { chain: 'solana', address: MINT } as const;
  let clockMs = Date.parse('2026-10-06T12:00:00.000Z');
  const mock = mockedFetch({
    rpcStatus: 503,
    dexValue: [pair(0, { baseToken: { address: target.address, name: 'River Lantern' }, priceUsd: '0.001' })],
    dexStatus: (call: number) => call === 0 ? undefined : 503,
  });
  const directory = mkdtempSync(join(tmpdir(), 'late-capture-final-failure-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  try {
    const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
      semanticEnabled: true,
      rpcUrl: RPC_URL,
      now: () => new Date(clockMs += 1_000).toISOString(),
    }));
    const capture = JSON.parse(bundle.rawArtifacts['live-state-capture']!) as {
      method: string; discoveryId: string | null; canonical: Array<{ id: string; retrievedAt: string }>;
      rpcState: string; dexState: string;
    };
    assert.equal(capture.method, 'late-state-capture-v1');
    assert.equal(capture.discoveryId, 'dex-discovery');
    assert.deepEqual(capture.canonical, [], 'failed final reads contribute no canonical state records');
    assert.equal(capture.rpcState, 'UNAVAILABLE');
    assert.equal(capture.dexState, 'UNAVAILABLE');
    assert.ok(bundle.rawArtifacts['dex-discovery'], 'the successful early discovery response remains available as discovery evidence');
    assert.equal(bundle.rawArtifacts['dex-pairs'], undefined);
    assert.equal(bundle.rawArtifacts['rpc-genesis'], undefined);
    assert.equal(bundle.rawArtifacts['rpc-account'], undefined);
    assert.equal(bundle.collection.dex.state, 'UNAVAILABLE');
    assert.equal(bundle.collection.rpc.state, 'UNAVAILABLE');
    assert.equal(bundle.market, null, 'the failed final DEX read does not fall back to the discovery quote');
    assert.equal(bundle.observations.some(item => item.evidenceIds.includes('dex-discovery')), false);
    assert.equal(bundle.features.some(item => item.evidenceIds.includes('dex-discovery')), false);
    const rows = bundle.details?.baseline ?? [];
    assert.notEqual(rows.find(row => row.id === 'O02')?.quality, 'KNOWN');
    assert.notEqual(rows.find(row => row.id === 'O28')?.quality, 'KNOWN');
    assert.ok(rows.every(row => !row.evidenceIds.includes('dex-discovery')),
      'baseline rows cannot turn the discovery response into a final-state witness');

    const saved = service.analyzeLive(bundle);
    assert.deepEqual(service.replay(saved.id), saved, 'the honest unavailable final capture persists and replays offline');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('accepted representation inadequacy persists with bound metadata and rejects rehashed proof tampering', async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const profileUrl = 'https://x.com/river_lantern';
  const wrappedProfileUrl = `/url?opi=79508299&q=${encodeURIComponent(profileUrl)}&sa=U&ved=2ahUKEwi-test&usg=AOvVaw-public`;
  const targetUrl = 'https://public.example/river-lantern-project';
  const title = 'River Lantern neighborhood art project';
  const snippet = 'The indexed project describes a community art token and shared public murals.';
  const currentProfile = 'The current account now publishes OUSD reserve backing and stablecoin lending updates; these fetched publications do not reflect the indexed River Lantern neighborhood art project.';
  const targetText = `Token ${target.address}. The River Lantern community shares a neighborhood art project.`;
  const mock = mockedFetch({
    dexValue: [pair(0, { chainId: 'base', baseToken: { address: target.address, name: 'River Lantern' }, quoteToken: { address: '0x3333333333333333333333333333333333333333' } })],
    searchValue: (requestUrl, call) => call === 0
      ? { results: [{ url: targetUrl, title: 'River Lantern project', snippet: `Token ${target.address}` }] }
      : call === 2
        ? { results: [{ url: wrappedProfileUrl, title, snippet }] }
        : call > 2 && new URL(requestUrl).searchParams.get('query')?.includes('River Lantern')
          ? { results: [{ url: profileUrl, title, snippet }] }
        : { results: [] },
    fetchValue: (urls: string[]) => ({
      results: urls.map(url => ({ url, final_url: url, text: url === profileUrl ? currentProfile : targetText })),
      errors: [],
    }),
    attentionResponse: packet => {
      if (isSocialModelPacket(packet)) return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'This fixture leaves optional social judgments unresolved.' } });
      const scope = packet.scope as { mode?: string; batch?: number } | undefined;
      const typed = packet as AttentionPacket;
      if (packet.selectedLeadIds) {
        const selected = packet.leads as Array<{ id: string; metadataEvidenceId: string }>;
        const metadata = (packet.metadata ?? []) as AttentionPacket['sources'];
        return attentionEnvelope({ leads: Object.fromEntries(selected.map(lead => {
          const source = metadata.find(item => item.id === lead.metadataEvidenceId);
          assert.ok(source, `recovery planner omitted indexed source ${lead.metadataEvidenceId}`);
          const span = source.spans.find(item => item.text.includes('community art token'));
          assert.ok(span, 'recovery planner did not receive the original indexed descriptor text');
          return [lead.id, {
            queries: [`Compare River Lantern neighborhood art project with independent original publications for ${lead.id}`],
            rationale: 'Check whether the indexed project subject remains represented in independent public sources.',
            metadataRefs: [{ sourceId: lead.metadataEvidenceId, spanId: span.id }],
          }];
        })) });
      }
      if (scope?.mode === 'qualified-identified-leads-v2' && packet.initialInvalidProposal) {
        const initial = packet.initialInvalidProposal as { decisions: Array<{
          leadId: string;
          descriptorRefs: Array<{ sourceId: string; spanId: string }>;
          subjectComparison: Record<string, unknown>;
          evidenceAdequacy: Record<string, unknown>;
        }> };
        const leads = packet.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[] }>;
        const sources = packet.sources as AttentionPacket['sources'];
        return attentionEnvelope({ decisions: initial.decisions.map(decision => {
          const lead = leads.find(item => item.id === decision.leadId);
          assert.ok(lead, `local repair retains original lead ${decision.leadId}`);
          const currentSourceId = lead.sourceIds.find(id =>
            sources.some(source => source.id === id && source.spans.some(span => span.text.includes('OUSD'))));
          assert.ok(currentSourceId, 'local repair receives the lead own actually fetched current profile');
          const descriptorRef = decision.descriptorRefs.find(ref => ref.sourceId === lead.metadataEvidenceId);
          assert.ok(descriptorRef, 'local repair retains the lead own indexed descriptor citation');
          const fetchedRef = {
            sourceId: currentSourceId,
            spanId: attentionSpanId(packet, currentSourceId, 'OUSD reserve backing'),
          };
          return {
            ...decision,
            corroboratingRefs: [],
            subjectComparison: { ...decision.subjectComparison, fetchedRefs: [fetchedRef] },
            evidenceAdequacy: { ...decision.evidenceAdequacy, citations: [descriptorRef, fetchedRef] },
          };
        }) });
      }
      if (scope?.mode === 'qualified-identified-leads-v2' && packet.proposal) {
        const proposed = packet.proposal as { decisions: Record<string, unknown> };
        const decisions = Object.fromEntries(Object.keys(proposed.decisions).map(id => [id, {
            accepted: true, rationale: 'The proposed unresolved disposition follows the indexed and current profile sources.',
            subjectComparison: { accepted: true, rationale: 'The indexed project and current account subjects are compared independently.' },
            evidenceAdequacy: { accepted: true, rationale: 'The indexed descriptor and positively different current profile support the bounded screening.' },
          }]));
        return attentionEnvelope({ decisions: comparisonLeadArray(decisions) });
      }
      if (scope?.mode === 'qualified-identified-leads-v2') {
        const leads = packet.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[] }>;
        const decisions = Object.fromEntries(leads.map(lead => {
          const currentSourceId = lead.sourceIds.find(id =>
            (packet.sources as AttentionPacket['sources']).some(source => source.id === id && source.spans.some(span => span.text.includes('OUSD'))));
          assert.ok(currentSourceId, 'V2 comparison receives the current account subject from fetched profile text');
          return [lead.id, {
          disposition: 'UNRESOLVED', rationale: 'The indexed project cannot be associated with the current account subject from the acquired source trail.',
          descriptorRefs: [{ sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId, 'community art token') }],
          corroboratingRefs: [], token: null,
          subjectComparison: {
            status: 'MISMATCH', indexedSubject: 'River Lantern neighborhood art project', currentSubject: 'OUSD reserve backing account',
            rationale: 'The indexed River Lantern community-art subject differs positively from the current account reserve-lending subject.',
            descriptorRefs: [{ sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId, 'community art token') }],
            fetchedRefs: [{ sourceId: lead.metadataEvidenceId,
              spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId, 'community art token') }],
          },
          evidenceAdequacy: {
            verdict: 'INADEQUATE',
            rationale: 'The indexed project descriptor and positively different current profile leave the public representation unbound after bounded recovery searches.',
            citations: [
              { sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId, 'community art token') },
            ],
          },
          }];
        }));
        return attentionEnvelope({ decisions: comparisonLeadArray(decisions) });
      }
      if (packet.manifest) return attentionEnvelope({
        decisions: Object.fromEntries(((packet.requiredDecisionIds ?? []) as string[]).map(id => [id, {
          accepted: true, rationale: 'No exact representation was proposed for this incomplete comparison batch.',
        }])) ,
        candidateSet: { complete: false, rationale: 'The acquired comparison sample does not establish a complete representation set.' },
      });
      if (typeof scope?.batch === 'number') {
        if (!packet.proposal) return attentionEnvelope({ competitors: [], posts: {} });
        return attentionEnvelope({
          decisions: Object.fromEntries(((packet.requiredDecisionIds ?? []) as string[]).map(id => [id, {
            accepted: true, rationale: 'Every proposed item is accounted for in this bounded comparison batch.',
          }])) ,
          candidateSet: { complete: false, rationale: 'This batch does not establish a complete comparison set.' },
          sourceDecisions: Object.fromEntries(typed.sources.map(source => [source.id, {
            disposition: 'CONTEXT', rationale: 'The fetched subject context does not establish a complete token-representation set.',
          }])) ,
          missingRepresentations: [],
        });
      }
      if (packet.proposal) return attentionEnvelope({
        decisions: Object.fromEntries(((packet.requiredDecisionIds ?? []) as string[]).map(id => [id, {
          accepted: true, rationale: 'The exact token-bound project source supports this bounded narrative judgment.',
        }])) ,
        candidateSet: { complete: false, rationale: 'The original comparison acquisition remains incomplete.' },
        originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No primary origin relationship is established in this fixture.' },
      });
      const targetSourceId = attentionSourceId(packet, target.address);
      return attentionEnvelope({
        claims: [{ id: 'claim-topic', feature: 'A01', value: true, summary: 'A neighborhood art project narrative.',
          citations: [{ sourceId: targetSourceId, spanId: attentionSpanId(packet, targetSourceId, target.address) }] }],
        posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => [id, { spanId: attentionSpanId(packet, id, target.address), role: 'NEWS' }])),
        competitors: [],
      });
    },
  });

  const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: GEMINI_KEY, semanticEnabled: true,
  }));
  const attentionReceipt = JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as {
    evidenceIds: string[];
      read: { comparisonQualification: { mode: string; proposalResponseId?: string; decisions: Array<{
        leadId: string; subjectComparison: { status: string }; evidenceAdequacy: { verdict: string };
        review: { subjectComparison: { accepted: boolean }; evidenceAdequacy: { accepted: boolean } };
      }>;
      recoveryQueries: Array<{ queryId: string; parentLeadId: string; state: string; descriptorComplete: boolean; resultCount: number }>;
      adequacySourceLengths: Array<{ id: string; retainedLength: number }> };
      comparisonAcquisition: { leads: Array<{
        id: string; metadataEvidenceId: string; searchArtifactId: string; resultIndex: number; url: string | null; recoveryQueryIds: string[];
      }> } };
  };
  const adequacyDecision = attentionReceipt.read.comparisonQualification.decisions.find(decision => decision.evidenceAdequacy.verdict === 'INADEQUATE')!;
  const adequacy = adequacyDecision.evidenceAdequacy;
  assert.equal(attentionReceipt.read.comparisonQualification.mode, 'qualified-identified-leads-v2');
  assert.ok(adequacy, 'the collected per-lead V2 record retains the accepted inadequacy assessment');
  const selectedLead = attentionReceipt.read.comparisonAcquisition.leads.find(lead => lead.id === adequacyDecision.leadId)!;
  assert.ok(selectedLead.recoveryQueryIds.length > 0, 'the accepted negative is backed by a retained recovery search');
  const wrapperMetadata = JSON.parse(bundle.rawArtifacts[selectedLead.metadataEvidenceId]!) as {
    url: string; normalizedUrl: string; urlMethod: string; searchArtifactId: string; resultIndex: number;
  };
  const wrapperRow = JSON.parse(bundle.rawArtifacts[selectedLead.searchArtifactId]!).results[selectedLead.resultIndex] as { url: string };
  assert.equal(wrapperRow.url, wrappedProfileUrl, 'the source row keeps the original relative Search wrapper');
  assert.equal(wrapperMetadata.url, wrappedProfileUrl);
  assert.equal(wrapperMetadata.normalizedUrl, profileUrl);
  assert.equal(wrapperMetadata.urlMethod, 'tinyfish-search-redirect-v1');
  assert.equal(selectedLead.url, profileUrl, 'the comparison ledger carries the validated direct public target');
  assert.equal(adequacyDecision.subjectComparison.status, 'MISMATCH');
  assert.equal(adequacyDecision.review.subjectComparison.accepted, true, 'the independent reviewer sees the repaired own fetched subject comparison');
  assert.equal(adequacyDecision.review.evidenceAdequacy.accepted, true);
  assert.ok(attentionReceipt.read.comparisonQualification.recoveryQueries.some(query => query.parentLeadId === adequacyDecision.leadId
    && ['OBSERVED', 'NO_RESULTS'].includes(query.state) && query.descriptorComplete), 'the own bounded recovery query has a retained successful receipt');
  assert.ok(attentionReceipt.evidenceIds.includes('attention-comparison-lead-proposal-response'));
  assert.ok(attentionReceipt.evidenceIds.includes('attention-comparison-lead-repair-proposal-response'));
  assert.ok(attentionReceipt.evidenceIds.includes('attention-comparison-lead-review-response'));
  assert.equal(attentionReceipt.read.comparisonQualification.proposalResponseId, 'attention-comparison-lead-repair-proposal-response');
  const v2ModelPackets = mock.geminiPackets.filter(packet =>
    (packet.scope as { mode?: string } | undefined)?.mode === 'qualified-identified-leads-v2');
  assert.deepEqual(v2ModelPackets.map(packet => packet.initialInvalidProposal ? 'repair' : packet.proposal ? 'review' : 'proposal'), [
    'proposal', 'repair', 'review',
  ]);
  const rawLeadWire = (id: string) => {
    const envelope = JSON.parse(bundle.rawArtifacts[id]!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    return JSON.parse(envelope.candidates[0]!.content.parts[0]!.text) as { decisions: Array<{
      leadId: string;
      descriptorRefs: Array<{ sourceId: string; spanId: string }>;
      subjectComparison: { fetchedRefs: Array<{ sourceId: string; spanId: string }> };
      evidenceAdequacy: { citations: Array<{ sourceId: string; spanId: string }> };
    }> };
  };
  const initialWire = rawLeadWire('attention-comparison-lead-proposal-response');
  const repairedWire = rawLeadWire('attention-comparison-lead-repair-proposal-response');
  const initialPacket = v2ModelPackets[0]!;
  const repairedPacket = v2ModelPackets.find(packet => packet.initialInvalidProposal)!;
  const lead = (initialPacket.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[] }>).find(item => item.id === adequacyDecision.leadId)!;
  const initialDecision = initialWire.decisions.find(item => item.leadId === lead.id)!;
  const repairedDecision = repairedWire.decisions.find(item => item.leadId === lead.id)!;
  const descriptorRef = initialDecision.descriptorRefs.find(ref => ref.sourceId === lead.metadataEvidenceId)!;
  const currentSourceId = lead.sourceIds.find(id =>
    (initialPacket.sources as AttentionPacket['sources']).some(source => source.id === id && source.spans.some(span => span.text.includes('OUSD'))));
  assert.ok(currentSourceId, 'the original lead has a retained own fetched profile');
  const currentRef = { sourceId: currentSourceId, spanId: attentionSpanId(initialPacket, currentSourceId, 'OUSD reserve backing') };
  assert.deepEqual(initialDecision.subjectComparison.fetchedRefs, [descriptorRef], 'the retained first response incorrectly treats its indexed descriptor as fetched current text');
  assert.deepEqual(initialDecision.evidenceAdequacy.citations, [descriptorRef], 'the retained first response omits the own fetched-current span');
  assert.deepEqual(repairedPacket.initialInvalidProposal, initialWire, 'the single repair receives the original invalid proposal unchanged');
  const localFailure = repairedPacket.localReferenceFailure as {
    leadId: string; requiredOwnFetchedSourceIds: string[];
    selectedSubjectFetchedRefs: Array<{ sourceId: string; spanId: string }>;
    selectedAdequacyCitations: Array<{ sourceId: string; spanId: string }>;
  };
  assert.equal(localFailure.leadId, lead.id);
  assert.ok(localFailure.requiredOwnFetchedSourceIds.includes(currentSourceId));
  assert.deepEqual(localFailure.selectedSubjectFetchedRefs, [descriptorRef]);
  assert.deepEqual(localFailure.selectedAdequacyCitations, [descriptorRef]);
  assert.deepEqual(repairedDecision.subjectComparison.fetchedRefs, [currentRef], 'repair replaces the indexed-as-current reference with the lead own fetched profile');
  assert.deepEqual(repairedDecision.evidenceAdequacy.citations, [descriptorRef, currentRef], 'adequacy cites the identical own descriptor and current spans');
  const independentReviewPacket = v2ModelPackets.find(packet => packet.proposal)!;
  const reviewedProposal = independentReviewPacket.proposal as { decisions: Record<string, {
    subjectComparison: { fetchedRefs: Array<{ sourceId: string; spanId: string }> };
    evidenceAdequacy: { citations: Array<{ sourceId: string; spanId: string }> };
  }> };
  assert.deepEqual(reviewedProposal.decisions[lead.id]!.subjectComparison.fetchedRefs, [currentRef]);
  assert.deepEqual(reviewedProposal.decisions[lead.id]!.evidenceAdequacy.citations, [descriptorRef, currentRef]);
  const a09 = bundle.details?.baseline.find(row => row.id === 'A09');
  assert.equal(a09?.quality, 'KNOWN');
  assert.equal(a09?.projection?.value, false);
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A10')?.quality, 'MISSING');

  const directory = mkdtempSync(join(tmpdir(), 'shared-inadequacy-replay-'));
  try {
    const database = join(directory, 'accepted.sqlite');
    let snapshotId = '';
    let snapshotHash = '';
    const writer = new Service(database);
    try {
      const saved = writer.analyzeLive(bundle);
      snapshotId = saved.id;
      snapshotHash = saved.hash;
    } finally { writer.close(); }
    const reopened = new Service(database);
    try {
      const replay = reopened.replay(snapshotId);
      assert.equal(replay.hash, snapshotHash);
      assert.deepEqual(replay, reopened.show(snapshotId));
      assert.equal(replay.details?.baseline.find(row => row.id === 'A09')?.projection?.value, false);
    } finally { reopened.close(); }

    const recalculateProofHashes = (candidate: typeof bundle) => {
      for (const evidence of candidate.evidence) {
        const raw = candidate.rawArtifacts[evidence.id];
        if (raw !== undefined) evidence.contentHash = sha256(raw);
      }
      const proofRecord = candidate.evidence.find(evidence => evidence.id === 'shared-derivation')!;
      const proof = JSON.parse(candidate.rawArtifacts[proofRecord.id]!) as { evidence: typeof candidate.evidence };
      proof.evidence = candidate.evidence.filter(evidence => evidence.id !== proofRecord.id);
      candidate.rawArtifacts[proofRecord.id] = JSON.stringify(proof);
      proofRecord.contentHash = sha256(candidate.rawArtifacts[proofRecord.id]!);
    };
  const assertRejected = (label: string, mutate: (candidate: typeof bundle) => void, code: RegExp) => {
      const candidate = structuredClone(bundle);
      mutate(candidate);
      recalculateProofHashes(candidate);
      const verifier = new Service(join(directory, `${label}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), code, label); }
      finally { verifier.close(); }
    };
    assertRejected('search-normalized-target-tamper', candidate => {
      const descriptor = JSON.parse(candidate.rawArtifacts[selectedLead.metadataEvidenceId]!) as { normalizedUrl: string };
      descriptor.normalizedUrl = 'https://public.example/attacker';
      candidate.rawArtifacts[selectedLead.metadataEvidenceId] = JSON.stringify(descriptor);
    }, /SHARED_SOURCE_INVALID/);
    assertRejected('search-method-tamper', candidate => {
      const descriptor = JSON.parse(candidate.rawArtifacts[selectedLead.metadataEvidenceId]!) as { urlMethod: string };
      descriptor.urlMethod = 'tinyfish-search-redirect-v2';
      candidate.rawArtifacts[selectedLead.metadataEvidenceId] = JSON.stringify(descriptor);
    }, /SHARED_SOURCE_INVALID/);
    assertRejected('missing-proposal-response', candidate => {
      const receipt = JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as typeof attentionReceipt;
      receipt.evidenceIds = receipt.evidenceIds.filter(id => id !== 'attention-comparison-lead-proposal-response');
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, /SHARED_PROOF_(REQUIRED|INVALID)/);
    assertRejected('selected-proposal-pointer-tamper', candidate => {
      const receipt = JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as typeof attentionReceipt;
      receipt.read.comparisonQualification.proposalResponseId = 'attention-comparison-lead-proposal-response';
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, /SHARED_PROOF_INVALID/);
    assertRejected('missing-recovery-query-membership', candidate => {
      const receipt = JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as typeof attentionReceipt;
      const lead = receipt.read.comparisonAcquisition.leads.find(item => item.id === adequacyDecision.leadId)!;
      receipt.evidenceIds = receipt.evidenceIds.filter(id => !lead.recoveryQueryIds.includes(id));
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, /SHARED_PROOF_(REQUIRED|INVALID)/);
    assertRejected('forged-recovery-query-membership', candidate => {
      const receipt = JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as typeof attentionReceipt;
      const lead = receipt.read.comparisonAcquisition.leads.find(item => item.id === adequacyDecision.leadId)!;
      lead.recoveryQueryIds.push('attention-recovery-search-forged');
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, /SHARED_PROOF_REQUIRED|SHARED_PROOF_INVALID|SHARED_ATTENTION_INVALID/);
    assertRejected('retained-length-tamper', candidate => {
      const receipt = JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as typeof attentionReceipt;
      receipt.read.comparisonQualification.adequacySourceLengths[0]!.retainedLength += 1;
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, /SHARED_SOURCE_INVALID/);
    assertRejected('shared-source-union-tamper', candidate => {
      const proofRecord = candidate.evidence.find(evidence => evidence.id === 'shared-derivation')!;
      const proof = JSON.parse(candidate.rawArtifacts[proofRecord.id]!) as { sources: Array<{ id: string }> };
      proof.sources.pop();
      candidate.rawArtifacts[proofRecord.id] = JSON.stringify(proof);
    }, /SHARED_SOURCE_INVALID/);

    for (const [label, field, value] of [
      ['metadata-title-tamper', 'title', 'Forged title'],
      ['metadata-snippet-tamper', 'snippet', 'Forged descriptor text'],
      ['metadata-url-tamper', 'url', 'https://forged.example/descriptor'],
    ] as const) assertRejected(label, candidate => {
      const proof = JSON.parse(candidate.rawArtifacts['shared-derivation']!) as { claims: Array<{ citations: Array<{ sourceId: string }> }> };
      const metadataId = proof.claims.flatMap(claim => claim.citations.map(citation => citation.sourceId))
        .find(id => candidate.evidence.some(evidence => evidence.id === id && evidence.sourceType === 'INDEXED_LEAD'))!;
      const descriptor = JSON.parse(candidate.rawArtifacts[metadataId]!) as Record<string, unknown>;
      if (field === 'url') descriptor.normalizedUrl = value;
      else descriptor[field] = value;
      candidate.rawArtifacts[metadataId] = JSON.stringify(descriptor);
    }, /SHARED_SOURCE_INVALID/);

    assertRejected('metadata-provenance-tamper', candidate => {
      const metadataEvidence = candidate.evidence.find(evidence => evidence.sourceType === 'INDEXED_LEAD')!;
      metadataEvidence.sourceId = 'tinyfish-fetch';
    }, /LIVE_PROVENANCE_INVALID|SHARED_SOURCE_INVALID/);
    assertRejected('metadata-time-tamper', candidate => {
      const proof = JSON.parse(candidate.rawArtifacts['shared-derivation']!) as { sources: Array<{ id: string }> };
      const metadataId = proof.sources.find(source => candidate.evidence.find(evidence => evidence.id === source.id)?.sourceType === 'INDEXED_LEAD')!.id;
      const metadataEvidence = candidate.evidence.find(evidence => evidence.id === metadataId)!;
      metadataEvidence.availableAt = '2026-09-28T00:00:00.000Z';
    }, /SHARED_PROOF_INVALID|SHARED_SOURCE_INVALID/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing provider keys skip optional web/model calls while preserving RPC and DEX collection', async () => {
  const mock = mockedFetch({ dexValue: [pair(1)] });
  const result = await collectLiveSolana(token, liveOptions(mock.fetcher, { semanticEnabled: true }));
  assert.equal(result.collection.web.state, 'KEY_MISSING');
  assert.equal(result.semantic.status, 'KEY_MISSING');
  assert.equal(mock.calls.some(call => call.url.includes('tinyfish.ai')), false);
  assert.equal(mock.calls.some(call => call.url.includes('generativelanguage.googleapis.com')), false);
  assert.equal(result.collection.rpc.state, 'OBSERVED');
  assert.equal(result.collection.dex.state, 'OBSERVED');
});

test('shared live derivation adds exactly one C05 projection and persists it through replay', async () => {
  const mock = mockedFetch({ dexValue: [pair(1)] });
  const bundle = await collectLiveSolana(token, liveOptions(mock.fetcher, { semanticEnabled: true }));
  const c05Features = bundle.features.filter(feature => feature.id === 'C05');
  const c05Assessment = bundle.details?.baseline.find(row => row.id === 'C05');
  assert.equal(c05Features.length, 1, 'a legacy C05 with no projection still receives one shared projection');
  assert.equal(c05Features[0]?.quality, 'MISSING', 'missing model receipts stay missing');
  assert.deepEqual(c05Assessment?.projection, c05Features[0]);
  assert.ok(bundle.details?.shared, 'the shared proof is present even when optional hosted keys are absent');
  assert.equal(mock.calls.some(call => call.url.includes('tinyfish.ai') || call.url.includes('generativelanguage.googleapis.com')), false,
    'the fixture exercises the service boundary without hosted requests');

  const directory = mkdtempSync(join(tmpdir(), 'shared-c05-replay-'));
  const database = join(directory, 'shared.sqlite');
  let snapshotId = '';
  let savedHash = '';
  try {
    const service = new Service(database);
    try {
      const saved = service.analyzeLive(bundle);
      snapshotId = saved.id;
      savedHash = saved.hash;
      assert.deepEqual(saved.details?.baseline.find(row => row.id === 'C05')?.projection, c05Features[0]);
    } finally {
      service.close();
    }

    const reopened = new Service(database);
    try {
      const replay = reopened.replay(snapshotId);
      assert.equal(replay.hash, savedHash);
      assert.deepEqual(replay, reopened.show(snapshotId));
      assert.deepEqual(reopened.frozenDetails(snapshotId).baseline.find(row => row.id === 'C05')?.projection, c05Features[0]);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Shared repair proof reconstructs selected raw responses and rejects rehashed reassessment tampering', async () => {
  const fixture = sharedFixture();
  const mock = mockedFetch({ dexValue: [] });
  const bundle = await collectLiveToken(fixture.token, liveOptions(mock.fetcher, {
    semanticEnabled: true, profile: fixture.profile, now: () => fixture.cutoff,
  }));
  assert.ok(bundle.details?.shared);

  const originalProof = bundle.evidence.find(record => record.id === 'shared-derivation');
  assert.ok(originalProof);
  bundle.evidence = bundle.evidence.filter(record => record.id !== originalProof.id);
  delete bundle.rawArtifacts[originalProof.id];
  bundle.profile = fixture.profile;
  bundle.details!.profile = fixture.profile;
  delete bundle.details!.social;

  const source = fixture.sources.find(item => item.id === 'attention-source')!;
  const counterSource = {
    id: 'counter-source', url: 'https://public.example/counter',
    text: 'A separate acquired page retains the comparison assertion for this fixture.',
    publishedAt: null, authorId: null, availableAt: bundle.cutoff, kind: 'PAGE' as const,
  };
  const claims = sharedClaims(fixture.baseline, undefined);
  const sources = [{ ...source, availableAt: bundle.cutoff }, counterSource];
  const sourceEvidence = (item: typeof sources[number]) => ({
    id: item.id, sourceId: 'tinyfish-fetch', sourceType: 'WEB_PAGE', retrievedAt: bundle.cutoff,
    availableAt: bundle.cutoff, contentHash: sha256(item.text), adapterVersion: 'live-v1',
    accessMode: 'FREE_ACCOUNT' as const,
    scope: { url: item.url, publishedAt: item.publishedAt, authorId: item.authorId, kind: item.kind },
  });
  const attachArtifact = (
    id: string, raw: string, sourceId: string, sourceType: string,
    accessMode: typeof bundle.evidence[number]['accessMode'], scope: Record<string, unknown>,
  ) => {
    bundle.rawArtifacts[id] = raw;
    bundle.evidence.push({
      id, sourceId, sourceType, retrievedAt: bundle.cutoff, availableAt: bundle.cutoff,
      contentHash: sha256(raw), adapterVersion: 'live-v1', accessMode, scope,
    });
  };
  for (const record of fixture.evidence.filter(item => item.id !== 'social-evidence')) {
    attachArtifact(record.id, JSON.stringify({ fixture: record.id }), 'shared-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { fixture: true });
  }
  for (const item of sources) {
    bundle.rawArtifacts[item.id] = item.text;
    bundle.evidence.push(sourceEvidence(item));
  }

  const spanFor = (sourceId: string, quote?: string) => {
    const source = sources.find(item => item.id === sourceId)!;
    const span = sourceSpans(source.id, source.text, 'SHARED_MODEL').find(item => quote ? item.text.includes(quote) : true);
    assert.ok(span, `the raw source has a code-owned span for ${sourceId}`);
    return { sourceId, spanId: span.id };
  };
  const sourceAClaimRefs = Object.fromEntries(claims.map(claim => [claim.id, spanFor(claim.citations[0]!.sourceId, claim.citations[0]!.quote)]));
  const initialClaims = Object.fromEntries(claims.map(claim => [claim.id, {
    disposition: claim.id === 'A01' ? 'CONFLICT' : 'CLEAR',
    rationale: claim.id === 'A01'
      ? 'The initial cross-claim pass records a deliberately rejected comparison conflict.'
      : 'The retained sources show no incompatible assertion for this claim.',
    citations: claim.id === 'A01'
      ? [sourceAClaimRefs[claim.id], spanFor(counterSource.id)]
      : [sourceAClaimRefs[claim.id]],
  }]));
  const repairClaims = {
    ...initialClaims,
    A01: {
      disposition: 'CLEAR',
      rationale: 'The complete retained sources contain no incompatible assertion for this claim.',
      citations: [sourceAClaimRefs.A01],
    },
  };
  const review = (acceptA01: boolean) => ({
    claims: Object.fromEntries(claims.map(claim => [claim.id, claim.id === 'A01' ? acceptA01 : true])),
    sources: Object.fromEntries(sources.map(item => [item.id, true])),
  });
  const raw = (value: unknown) => sourceModelRaw({ claims: value && typeof value === 'object' && 'claims' in value
    ? (value as { claims: unknown }).claims : value });
  const proposalResponse = raw({ claims: initialClaims });
  const reviewResponse = sourceModelRaw(review(false));
  const repairProposalResponse = raw({ claims: repairClaims });
  const repairReviewResponse = sourceModelRaw(review(true));
  const audit = decodeSharedAudit(claims, sources, repairProposalResponse, repairReviewResponse);
  const initialAudit = decodeSharedAudit(claims, sources, proposalResponse, reviewResponse);
  assert.equal(initialAudit.review.find(item => item.id === 'A01')?.accepted, false);
  assert.equal(validSharedReassessment(initialAudit, audit), true);
  assert.equal(deriveShared({ ...fixture, social: undefined, claims, sources, audit }).facts.values.C06, true);

  const modelScope = { method: 'automated-source-review-v1', model: 'fixture' };
  for (const [id, content, sourceType] of [
    ['shared-proposal-prompt', JSON.stringify({ stage: 'proposal' }), 'MODEL_INPUT'],
    ['shared-proposal-response', proposalResponse, 'MODEL_RESPONSE'],
    ['shared-review-prompt', JSON.stringify({ stage: 'review' }), 'MODEL_INPUT'],
    ['shared-review-response', reviewResponse, 'MODEL_RESPONSE'],
    ['shared-repair-proposal-prompt', JSON.stringify({ stage: 'repair-proposal' }), 'MODEL_INPUT'],
    ['shared-repair-proposal-response', repairProposalResponse, 'MODEL_RESPONSE'],
    ['shared-repair-review-prompt', JSON.stringify({ stage: 'repair-review' }), 'MODEL_INPUT'],
    ['shared-repair-review-response', repairReviewResponse, 'MODEL_RESPONSE'],
  ] as const) attachArtifact(id, content, 'gemini', sourceType, 'FREE_ACCOUNT', modelScope);
  const receipt = {
    method: 'shared-conflict-review-v1', token: bundle.token, claims, sources, audit,
    wireMethod: 'shared-audit-wire-v2',
    proposalResponseId: 'shared-repair-proposal-response', reviewResponseId: 'shared-repair-review-response',
  };
  attachArtifact('shared-qualified-receipt', JSON.stringify(receipt), 'shared-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: receipt.method });

  const input: SharedInputs = {
    ...fixture, token: bundle.token, cutoff: bundle.cutoff, profile: bundle.profile,
    baseline: fixture.baseline, features: fixture.features, evidence: structuredClone(bundle.evidence),
    observations: bundle.observations, social: undefined, claims, sources, audit,
    semanticReceiptIds: ['attention-qualified-receipt', 'social-qualified-receipt'],
  };
  const effective = expireSharedWitnesses(input);
  const derived = deriveShared(effective);
  const sharedIds = new Set(['C03', 'C04', 'C05', 'C06']);
  bundle.features = [
    ...effective.features.filter(feature => !sharedIds.has(feature.id)),
    ...derived.assessments.map(assessment => assessment.projection!),
  ];
  bundle.details!.baseline = [
    ...effective.baseline.filter(assessment => !sharedIds.has(assessment.id)),
    ...derived.assessments,
  ];
  bundle.details!.shared = derived.facts;
  assert.equal(bundle.details!.baseline.find(row => row.id === 'C06')?.projection?.value, true);

  const proofRaw = JSON.stringify(input);
  bundle.rawArtifacts['shared-derivation'] = proofRaw;
  bundle.evidence.push({
    id: 'shared-derivation', sourceId: 'shared-collector', sourceType: 'CALCULATION',
    retrievedAt: bundle.cutoff, availableAt: bundle.cutoff, contentHash: sha256(proofRaw),
    adapterVersion: 'live-v1', accessMode: 'LOCAL_DERIVED', scope: { method: 'shared-evidence-v1' },
  });

  const directory = mkdtempSync(join(tmpdir(), 'shared-reassessment-proof-'));
  try {
    const database = join(directory, 'accepted.sqlite');
    const callsBeforeService = mock.calls.length;
    const writer = new Service(database);
    let snapshotId = '';
    let snapshotHash = '';
    try {
      const saved = writer.analyzeLive(bundle);
      snapshotId = saved.id;
      snapshotHash = saved.hash;
      assert.equal(saved.details?.baseline.find(row => row.id === 'C06')?.projection?.value, true);
    } finally { writer.close(); }
    const reopened = new Service(database);
    try {
      const replay = reopened.replay(snapshotId);
      assert.equal(replay.hash, snapshotHash);
      assert.deepEqual(replay, reopened.show(snapshotId));
      assert.equal(replay.details?.baseline.find(row => row.id === 'C06')?.projection?.value, true);
    } finally { reopened.close(); }
    assert.equal(mock.calls.length, callsBeforeService, 'save, reopen, and replay use only the retained source-model artifacts');

    const rehashProof = (candidate: typeof bundle) => {
      const proof = candidate.evidence.find(record => record.id === 'shared-derivation')!;
      const packet = JSON.parse(candidate.rawArtifacts[proof.id]!) as SharedInputs;
      packet.evidence = candidate.evidence.filter(record => record.id !== proof.id);
      candidate.rawArtifacts[proof.id] = JSON.stringify(packet);
      proof.contentHash = sha256(candidate.rawArtifacts[proof.id]!);
    };
    const assertRejected = (name: string, mutate: (candidate: typeof bundle) => void) => {
      const candidate = structuredClone(bundle);
      mutate(candidate);
      rehashProof(candidate);
      const verifier = new Service(join(directory, `${name}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), /SHARED_PROOF_INVALID/, name); }
      finally { verifier.close(); }
    };
    const rewriteRaw = (candidate: typeof bundle, id: string, value: unknown) => {
      const raw = JSON.stringify(value);
      candidate.rawArtifacts[id] = raw;
      candidate.evidence.find(record => record.id === id)!.contentHash = sha256(raw);
    };
    assertRejected('selected-response-tamper', candidate => {
      rewriteRaw(candidate, 'shared-repair-review-response', sourceModelRaw(review(false)));
    });
    assertRejected('reassessment-trigger-tamper', candidate => {
      rewriteRaw(candidate, 'shared-review-response', sourceModelRaw(review(true)));
    });
    assertRejected('reassessment-pointer-tamper', candidate => {
      const updated = { ...receipt, proposalResponseId: 'shared-proposal-response', reviewResponseId: 'shared-review-response' };
      rewriteRaw(candidate, 'shared-qualified-receipt', updated);
    });
    assertRejected('reassessment-marker-removal', candidate => {
      const downgraded = { ...receipt } as Record<string, unknown>;
      delete downgraded.wireMethod;
      delete downgraded.proposalResponseId;
      delete downgraded.reviewResponseId;
      rewriteRaw(candidate, 'shared-qualified-receipt', downgraded);
    });

    const scoped = structuredClone(bundle);
    const setTemporalScope = (candidate: typeof bundle, scope: unknown) => {
      rewriteRaw(candidate, 'shared-qualified-receipt', { ...receipt, temporalScope: scope });
      for (const record of candidate.evidence.filter(item => item.id.startsWith('shared-') && item.sourceType === 'MODEL_INPUT')) {
        rewriteRaw(candidate, record.id, { ...JSON.parse(candidate.rawArtifacts[record.id]!), temporalScope: scope });
      }
    };
    setTemporalScope(scoped, { cutoff: bundle.cutoff });
    rehashProof(scoped);
    const scopedDb = join(directory, 'temporal-scope.sqlite');
    const scopedWriter = new Service(scopedDb);
    let scopedId = '';
    try { scopedId = scopedWriter.analyzeLive(scoped).id; } finally { scopedWriter.close(); }
    const scopedReader = new Service(scopedDb);
    try { assert.deepEqual(scopedReader.replay(scopedId), scopedReader.show(scopedId)); } finally { scopedReader.close(); }

    const rejectScope = (name: string, mutate: (candidate: typeof bundle) => void) => {
      const candidate = structuredClone(scoped);
      mutate(candidate);
      rehashProof(candidate);
      const verifier = new Service(join(directory, `${name}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), /SHARED_PROOF_INVALID/, name); } finally { verifier.close(); }
    };
    rejectScope('future-semantic-cutoff', candidate => {
      setTemporalScope(candidate, { cutoff: new Date(Date.parse(bundle.cutoff) + 1000).toISOString() });
    });
    rejectScope('sources-newer-than-semantic-cutoff', candidate => {
      setTemporalScope(candidate, { cutoff: new Date(Date.parse(bundle.cutoff) - 1000).toISOString() });
    });
    rejectScope('unbound-social-window', candidate => {
      setTemporalScope(candidate, { cutoff: bundle.cutoff, socialWindow: { start: fixture.social!.start, end: fixture.social!.end } });
    });
    rejectScope('invented-social-basis', candidate => {
      setTemporalScope(candidate, { cutoff: bundle.cutoff, socialWindow: { start: fixture.social!.start, end: fixture.social!.end }, socialFacts: fixture.social });
    });
    rejectScope('changed-prompt-scope', candidate => {
      rewriteRaw(candidate, 'shared-review-prompt', { stage: 'review', temporalScope: { cutoff: new Date(Date.parse(bundle.cutoff) + 1000).toISOString() } });
    });
    rejectScope('removed-prompt-scope', candidate => {
      rewriteRaw(candidate, 'shared-review-prompt', { stage: 'review' });
    });
    rejectScope('removed-receipt-scope', candidate => {
      rewriteRaw(candidate, 'shared-qualified-receipt', receipt);
    });

    const spanIndices = new Map(sources.flatMap(item => sourceSpans(item.id, item.text, 'SHARED_MODEL'))
      .map((span, index) => [span.id, index]));
    const indexClaims = (values: typeof initialClaims) => Object.fromEntries(Object.entries(values).map(([id, value]) => [id, {
      ...value, citations: value.citations.map(citation => ({ spanIndex: spanIndices.get(citation.spanId)! })),
    }]));
    const indexed = structuredClone(scoped);
    rewriteRaw(indexed, 'shared-proposal-response', JSON.parse(raw({ claims: indexClaims(initialClaims) })));
    rewriteRaw(indexed, 'shared-repair-proposal-response', JSON.parse(raw({ claims: indexClaims(repairClaims) })));
    for (const record of indexed.evidence.filter(item => item.id.startsWith('shared-') && item.sourceType === 'MODEL_INPUT')) {
      rewriteRaw(indexed, record.id, { ...JSON.parse(indexed.rawArtifacts[record.id]!), citationWire: 'INDEX' });
    }
    rewriteRaw(indexed, 'shared-qualified-receipt', { ...receipt, wireMethod: 'shared-audit-wire-v3', temporalScope: { cutoff: bundle.cutoff } });
    assert.deepEqual(decodeSharedAudit(claims, sources, indexed.rawArtifacts['shared-repair-proposal-response']!, indexed.rawArtifacts['shared-repair-review-response']!, 'INDEX'), audit);
    rehashProof(indexed);
    const indexedDb = join(directory, 'indexed-citations.sqlite');
    const indexedWriter = new Service(indexedDb);
    let indexedId = '';
    try { indexedId = indexedWriter.analyzeLive(indexed).id; } finally { indexedWriter.close(); }
    const indexedReader = new Service(indexedDb);
    try { assert.deepEqual(indexedReader.replay(indexedId), indexedReader.show(indexedId)); } finally { indexedReader.close(); }
    for (const [name, spanIndex] of [['out-of-range-index', spanIndices.size], ['fractional-index', 0.5]] as const) {
      const candidate = structuredClone(indexed);
      const altered = indexClaims(repairClaims);
      altered.A01!.citations = [{ spanIndex }];
      rewriteRaw(candidate, 'shared-repair-proposal-response', JSON.parse(raw({ claims: altered })));
      rehashProof(candidate);
      const verifier = new Service(join(directory, `${name}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), /SHARED_PROOF_INVALID/, name); } finally { verifier.close(); }
    }
    const downgradedIndex = structuredClone(indexed);
    rewriteRaw(downgradedIndex, 'shared-qualified-receipt', { ...receipt, temporalScope: { cutoff: bundle.cutoff } });
    rehashProof(downgradedIndex);
    const downgradeVerifier = new Service(join(directory, 'indexed-wire-downgrade.sqlite'));
    try { assert.throws(() => downgradeVerifier.analyzeLive(downgradedIndex), /SHARED_PROOF_INVALID/); } finally { downgradeVerifier.close(); }

    const unrepairedIndex = structuredClone(indexed);
    for (const record of unrepairedIndex.evidence.filter(item => item.id.startsWith('shared-repair-'))) delete unrepairedIndex.rawArtifacts[record.id];
    unrepairedIndex.evidence = unrepairedIndex.evidence.filter(item => !item.id.startsWith('shared-repair-'));
    rewriteRaw(unrepairedIndex, 'shared-proposal-response', JSON.parse(raw({ claims: indexClaims(repairClaims) })));
    rewriteRaw(unrepairedIndex, 'shared-review-response', JSON.parse(sourceModelRaw(review(true))));
    const unrepairedReceipt = { ...receipt, wireMethod: 'shared-audit-wire-v3', temporalScope: { cutoff: bundle.cutoff }, proposalResponseId: 'shared-proposal-response', reviewResponseId: 'shared-review-response' };
    rewriteRaw(unrepairedIndex, 'shared-qualified-receipt', unrepairedReceipt);
    rehashProof(unrepairedIndex);
    const unrepairedVerifier = new Service(join(directory, 'unrepaired-index.sqlite'));
    try { unrepairedVerifier.analyzeLive(unrepairedIndex); } finally { unrepairedVerifier.close(); }
    const missingMarker = structuredClone(unrepairedIndex);
    const strippedReceipt = { ...unrepairedReceipt } as Record<string, unknown>;
    delete strippedReceipt.wireMethod;
    delete strippedReceipt.proposalResponseId;
    delete strippedReceipt.reviewResponseId;
    rewriteRaw(missingMarker, 'shared-qualified-receipt', strippedReceipt);
    rehashProof(missingMarker);
    const markerVerifier = new Service(join(directory, 'unrepaired-index-marker-removal.sqlite'));
    try { assert.throws(() => markerVerifier.analyzeLive(missingMarker), /SHARED_PROOF_INVALID/); } finally { markerVerifier.close(); }
    for (const record of missingMarker.evidence.filter(item => item.id.startsWith('shared-') && item.sourceType === 'MODEL_INPUT')) {
      const prompt = JSON.parse(missingMarker.rawArtifacts[record.id]!);
      delete prompt.citationWire;
      rewriteRaw(missingMarker, record.id, prompt);
    }
    rehashProof(missingMarker);
    const allMarkersVerifier = new Service(join(directory, 'unrepaired-index-all-markers-removal.sqlite'));
    try { assert.throws(() => allMarkersVerifier.analyzeLive(missingMarker), /SHARED_PROOF_INVALID/); } finally { allMarkersVerifier.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
