import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { AccountType, ExtensionType, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { MPL_TOKEN_METADATA_PROGRAM_ID, metadataPda } from '@pump-fun/pump-swap-sdk';
import { collectLiveSolana, collectLiveToken } from '../src/app/live.js';
import type { LiveRuntime } from '../src/app/live-phases.js';
import { renderSnapshot } from '../src/app/report.js';
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
import { decodeTokenMetadataUri, discoverTokenMetadata } from '../src/providers/token-discovery.js';
import { originSourceScope } from '../src/domain/attention.js';
import { entryEvidenceScope, type AttentionRead } from '../src/providers/attention.js';
import { deriveShared, expireSharedWitnesses, sharedClaims, type SharedInputs } from '../src/domain/shared.js';
import { decodeSharedAudit, decodeSharedAuditProof, sharedAuditPrompt, sharedReassessmentIds, validSharedReassessment } from '../src/providers/shared-model.js';
import { sourceSpans } from '../src/providers/source-model.js';
import { sharedFixture } from './shared-fixtures.js';
import type { Profile, TokenRef } from '../src/domain/contracts.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const RPC_URL = 'https://rpc.example/?api-key=rpc-secret';
const TINYFISH_KEY = 'tinyfish-test-secret';
const GEMINI_KEY = 'gemini-test-secret';
let geminiKeySequence = 0;
const nextGeminiKey = () => `${GEMINI_KEY}-${++geminiKeySequence}`;
const AT = '2026-09-29T12:00:00.000Z';
const PROGRAM_DATA = new PublicKey(Buffer.alloc(32, 8)).toBase58();
const token: TokenRef = { chain: 'solana', address: MINT };
const profile: Profile = { id: 'unconfigured-live', risk: {}, stage: { ageBands: [] } };

function comparisonGradeIdFields(packet: Record<string, unknown>): Record<string, unknown> {
  const qualification = packet.leadQualification as { globalScopeWireMethod?: string } | undefined;
  return qualification?.globalScopeWireMethod === 'code-owned-comparison-ids-v1' ? {} : {
    leadIds: packet.requiredLeadIds, sourceIds: packet.requiredSourceIds, batchIds: packet.requiredBatchIds,
  };
}

test('mainnet RPC pin matches the complete documented Solana genesis hash', () => {
  assert.equal(SOLANA_MAINNET_GENESIS, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
});

test('mint metadata discovery decodes embedded Token-2022 and Metaplex URIs without fetching them', async t => {
  await t.test('Token-2022 reads only its already-fetched mint account and preserves raw RPC evidence', async () => {
    const raw = metadataRpcRaw([rpcAccount(TOKEN_2022_PROGRAM_ID.toBase58(), token2022MetadataAccount('https://project.example/token.json?utm_source=fixture&v=1')), null]);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await discoverTokenMetadata(MINT, RPC_URL, async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return jsonResponse(JSON.parse(raw));
    }, () => AT);

    assert.equal(result.uri, 'https://project.example/token.json?v=1');
    assert.equal(result.code, undefined);
    assert.equal(calls.length, 1, 'metadata parsing makes no hidden follow-up request to the URI');
    assert.equal(calls[0]?.url, RPC_URL);
    assert.equal(calls[0]?.body.method, 'getMultipleAccounts');
    assert.deepEqual((calls[0]?.body.params as unknown[][])[0], [MINT, metadataPda(new PublicKey(MINT)).toBase58()]);
    assert.equal(result.rawArtifacts['discovery-token-metadata'], raw);
    assert.equal(result.retrievedAt['discovery-token-metadata'], AT);
  });

  await t.test('legacy Metaplex URI is public-HTTPS filtered; mismatched mint bindings fail closed', () => {
    const raw = metadataRpcRaw([null, rpcAccount(MPL_TOKEN_METADATA_PROGRAM_ID.toBase58(), legacyMetadataAccount('http://127.0.0.1/private'))]);
    const unsafe = decodeTokenMetadataUri(raw, MINT);
    assert.equal(unsafe.uri, undefined);
    assert.equal(unsafe.code, 'TOKEN_METADATA_URL_UNSAFE');

    const forged = metadataRpcRaw([null, rpcAccount(MPL_TOKEN_METADATA_PROGRAM_ID.toBase58(), legacyMetadataAccount('https://project.example/token.json', new PublicKey(OTHER_MINT)))]);
    assert.throws(() => decodeTokenMetadataUri(forged, MINT), /TOKEN_METADATA_BINDING/);
  });

  await t.test('Token-2022 metadata must declare the exact requested mint', () => {
    const raw = metadataRpcRaw([rpcAccount(TOKEN_2022_PROGRAM_ID.toBase58(), token2022MetadataAccount('https://project.example/token.json', new PublicKey(OTHER_MINT))), null]);
    assert.throws(() => decodeTokenMetadataUri(raw, MINT), /TOKEN_METADATA_BINDING/);
  });
});

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

function token2022MetadataAccount(uri: string, mint = new PublicKey(MINT)): Buffer {
  const metadataString = (value: string) => {
    const bytes = Buffer.from(value);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  const extension = Buffer.concat([
    Buffer.alloc(32), mint.toBuffer(), metadataString('River Lantern'), metadataString('LANT'), metadataString(uri), Buffer.alloc(4),
  ]);
  const length = 170 + extension.length;
  const data = Buffer.alloc(length);
  data.writeBigUInt64LE(1_000_000_000_000n, 36);
  data[44] = 6;
  data[45] = 1;
  data[165] = AccountType.Mint;
  data.writeUInt16LE(ExtensionType.TokenMetadata, 166);
  data.writeUInt16LE(extension.length, 168);
  extension.copy(data, 170);
  return data;
}

function metadataRpcRaw(accounts: Array<unknown | null>): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 900 }, value: accounts } });
}

function rpcAccount(owner: string, data: Buffer) {
  return { owner, executable: false, lamports: 1_000_000, data: [data.toString('base64'), 'base64'] };
}

function legacyMetadataAccount(uri: string, mint = new PublicKey(MINT)): Buffer {
  const metadataString = (value: string) => {
    const bytes = Buffer.from(value);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(bytes.length);
    return Buffer.concat([size, bytes]);
  };
  return Buffer.concat([Buffer.from([4]), Buffer.alloc(32), mint.toBuffer(), metadataString('River Lantern'), metadataString('LANT'), metadataString(uri)]);
}
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
      if (url.endsWith(':countTokens')) return jsonResponse({ totalTokens: 100 });
      if (config.geminiStatus) return jsonResponse({ error: 'simulated' }, config.geminiStatus);
      if (config.geminiBody !== undefined) return new Response(config.geminiBody, { headers: { 'content-type': 'application/json' } });
      const request = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const packet = JSON.parse(request.contents[0]?.parts[0]?.text ?? '{}') as Record<string, unknown>;
      geminiPackets.push(packet);
      if (config.attentionResponse) return jsonResponse(comparisonRowsForV3(packet, config.attentionResponse(packet, geminiPackets.length)));
      return jsonResponse({ candidates: [] });
    }
    throw new Error('UNEXPECTED_MOCK_REQUEST');
  };
  const reset = () => { calls.length = 0; geminiPackets.length = 0; searchCalls = 0; dexCalls = 0; };
  return { calls, fetcher, geminiPackets, reset };
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

  await t.test('final mint reads request the preflight context floor and reject an older response', async () => {
    let accountParams: unknown;
    const mock = mockedFetch();
    const floor = 321;
    const read = await inspectSolanaMint(MINT, RPC_URL, async (input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT) accountParams = request.params[1];
      return mock.fetcher(input, init);
    }, undefined, () => AT, floor);
    assert.equal(read.status, 'OBSERVED');
    assert.deepEqual(accountParams, { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: floor });

    const stale: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === 'getGenesisHash') return jsonResponse({ jsonrpc: '2.0', id: 1, result: SOLANA_MAINNET_GENESIS });
      assert.equal(request.method, 'getAccountInfo');
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: floor - 1 }, value: legacyAccount() } });
    };
    const rejected = await inspectSolanaMint(MINT, RPC_URL, stale, undefined, undefined, floor);
    assert.deepEqual({ status: rejected.status, code: rejected.code }, { status: 'UNAVAILABLE', code: 'RPC_SHAPE' });
    assert.equal(rejected.accountRaw, undefined, 'a stale account body cannot become canonical mint evidence');
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

test('semantic expiry still performs fresh final RPC and DEX reads in the actual collector', async () => {
  const mock = mockedFetch();
  let nowMs = 0;
  let workDeadline: AbortController | undefined;
  let expired = false;
  const afterExpiry: Array<{ url: string; method?: string; params?: unknown[] }> = [];
  const runtime: LiveRuntime = {
    nowMs: () => nowMs,
    timeout: milliseconds => {
      const controller = new AbortController();
      if (milliseconds === 480_000) workDeadline = controller;
      return controller.signal;
    },
    wait: async () => {},
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    let request: { method?: string; params?: unknown[] } | undefined;
    if (url.startsWith('https://rpc.example/')) request = JSON.parse(String(init?.body)) as typeof request;
    if (expired && (url.startsWith('https://rpc.example/') || url.startsWith('https://api.dexscreener.com/'))) {
      afterExpiry.push({ url, method: request?.method, params: request?.params });
    }
    const response = await mock.fetcher(input, init);
    if (!expired && url.startsWith('https://api.search.tinyfish.ai/')) {
      assert.ok(workDeadline, 'the semantic work signal exists before attention starts its first provider request');
      nowMs = 480_000;
      expired = true;
      workDeadline.abort();
    }
    return response;
  };
  const now = () => new Date(Date.parse(AT) + nowMs).toISOString();
  const bundle = await collectLiveSolana(token, liveOptions(fetcher, {
    semanticEnabled: true, tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), rpcUrl: RPC_URL, runtime, now,
  }));

  assert.equal(expired, true);
  const run = JSON.parse(bundle.rawArtifacts['live-run-scope']!) as {
    elapsedMs: number; semanticLimitMs: number; stages: Array<{ phase: string; status: string; origin?: string; ops: number; endMs: number | null }>;
  };
  const attention = run.stages.find(stage => stage.phase === 'ATTENTION')!;
  const finalize = run.stages.find(stage => stage.phase === 'FINALIZE')!;
  assert.equal(run.semanticLimitMs, 600_000);
  assert.equal(run.elapsedMs, 480_000);
  assert.deepEqual([attention.status, attention.origin, attention.endMs], ['CANCELLED', 'PHASE_DEADLINE', 480_000]);
  assert.equal(finalize.status, 'COMPLETED');
  assert.ok(finalize.ops > 0, 'the final stage receives live transport operations after semantic cancellation');

  assert.ok(afterExpiry.some(call => call.url.startsWith('https://rpc.example/') && call.method === 'getGenesisHash'));
  const finalMint = afterExpiry.find(call => call.url.startsWith('https://rpc.example/') && call.method === 'getAccountInfo' && call.params?.[0] === MINT);
  assert.ok(finalMint, 'the final canonical mint is actually read after semantic expiry');
  assert.deepEqual(finalMint.params?.[1], { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: 321 });
  assert.ok(afterExpiry.some(call => call.url.startsWith('https://api.dexscreener.com/')), 'the final DEX request is actually sent after semantic expiry');
  assert.ok(bundle.evidence.some(record => record.id === 'rpc-account' && record.sourceId === 'solana-rpc'));
  assert.ok(bundle.evidence.some(record => record.id === 'dex-pairs-primary' && record.sourceId === 'dexscreener'),
    'the final direct DEX response remains evidence even when the optional recovery is not selected');
  assert.ok(bundle.evidence.some(record => record.id === 'dex-discovery-primary'), 'early discovery remains separately labeled');
  const discoveryPrimary = bundle.evidence.find(record => record.id === 'dex-discovery-primary')!;
  const finalDex = bundle.evidence.find(record => record.id === 'dex-pairs-primary')!;
  assert.ok(discoveryPrimary, 'early DEX discovery is retained');
  assert.ok(Date.parse(finalDex.retrievedAt) > Date.parse(discoveryPrimary.retrievedAt), 'final market state is retrieved after early discovery');
});

test('semantic research keeps the partial 120-second final stage active through venue collection', async () => {
  const mock = mockedFetch();
  const timeouts: number[] = [];
  const runtime: LiveRuntime = {
    nowMs: () => 0,
    timeout: milliseconds => { timeouts.push(milliseconds); return new AbortController().signal; },
    wait: async () => {},
  };
  const research = { schemaVersion: 1 as const, token, records: [], reviews: [] };
  const bundle = await collectLiveSolana(token, liveOptions(mock.fetcher, {
    semanticEnabled: true, tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), rpcUrl: RPC_URL, research, runtime,
  }));
  assert.ok(timeouts.every(milliseconds => milliseconds === 120_000), 'research uses the existing partial-run ceiling');
  assert.ok(bundle.evidence.some(record => record.id === 'curated-research'));
  assert.ok(!bundle.rawArtifacts['live-run-scope'], 'legacy/partial research does not claim the fresh full-run phase receipt');
  assert.ok(!bundle.rawArtifacts['social-attention-seed'], 'curated research does not start the live social branch');
  const rpcMethods = mock.calls.filter(call => call.url.startsWith('https://rpc.example/'))
    .map(call => (JSON.parse(String(call.init?.body)) as { method: string }).method);
  assert.ok(rpcMethods.some(method => method === 'getAccountInfo'), 'canonical mint acquisition remains live');
  const lastSearchIndex = mock.calls.reduce((last, call, index) => call.url.startsWith('https://api.search.tinyfish.ai/') ? index : last, -1);
  assert.ok(mock.calls.slice(lastSearchIndex + 1).some(call => call.url.startsWith('https://rpc.example/')),
    'venue RPC work still reaches the provider after attention uses the shared final-stage fetcher');
});

test('Service accepts safe RPC diagnostics and keeps a partial holder error as the cause', async () => {
  const mock = mockedFetch();
  const rawMint = Buffer.alloc(82);
  rawMint.writeBigUInt64LE(1_000_000_000_000n, 36);
  rawMint[44] = 6;
  rawMint[45] = 1;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://rpc.example/') || url.startsWith('https://api.mainnet.solana.com')) {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT
        && (request.params[1] as { encoding?: string } | undefined)?.encoding === 'base64') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: 321 }, value: rpcAccount(LEGACY_TOKEN_PROGRAM, rawMint),
        } });
      }
      if (request.method === 'getProgramAccounts') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'provider population failure' } });
      }
    }
    return mock.fetcher(input, init);
  };
  const bundle = await collectLiveSolana(token, liveOptions(fetcher));
  const diagnostic = bundle.evidence.find(record => record.id === 'rpc-detail-errors');
  assert.ok(diagnostic, 'partial detail failures have a retained local diagnostic record');
  assert.equal(diagnostic.sourceId, 'solana-rpc-diagnostics');
  assert.equal(diagnostic.accessMode, 'LOCAL_DERIVED');
  const diagnostics = JSON.parse(bundle.rawArtifacts['rpc-detail-errors']!) as { errors: Record<string, string> };
  assert.equal(diagnostics.errors.holderPopulation, 'RPC_REMOTE_-32005', 'safe diagnostics preserve the provider’s actual full-population error code');
  for (const id of ['O17', 'O18', 'O19', 'O20']) {
    assert.equal(bundle.details?.baseline.find(row => row.id === id)?.causes[0]?.code, 'RPC_REMOTE_-32005',
      `${id} keeps the original failed population request despite the top-account fallback`);
  }

  const directory = mkdtempSync(join(tmpdir(), 'holder-diagnostic-service-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  try {
    const saved = service.analyzeLive(bundle);
    assert.ok(saved.evidence.some(record => record.id === 'rpc-detail-errors' && record.sourceId === 'solana-rpc-diagnostics'));
    assert.equal(saved.details?.baseline.find(row => row.id === 'O19')?.causes[0]?.code, 'RPC_REMOTE_-32005');
    assert.deepEqual(service.replay(saved.id), saved, 'diagnostic evidence and the real cause survive persistence and replay');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Service gives only the validated LIVE holder-population artifact its separate bounded allowance', async () => {
  const mock = mockedFetch();
  const rawMint = Buffer.alloc(82);
  rawMint.writeBigUInt64LE(100n, 36);
  rawMint[44] = 6;
  rawMint[45] = 1;
  const holderAccount = Buffer.alloc(165);
  new PublicKey(MINT).toBuffer().copy(holderAccount);
  Buffer.alloc(32, 9).copy(holderAccount, 32);
  holderAccount.writeBigUInt64LE(100n, 64);
  holderAccount[108] = 1;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://rpc.example/') || url.startsWith('https://api.mainnet.solana.com')) {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT
        && (request.params[1] as { encoding?: string } | undefined)?.encoding === 'base64') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: 321 }, value: rpcAccount(LEGACY_TOKEN_PROGRAM, rawMint),
        } });
      }
      if (request.method === 'getProgramAccounts') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 321 }, value: [{
          pubkey: PROGRAM_DATA, account: rpcAccount(LEGACY_TOKEN_PROGRAM, holderAccount),
        }] } });
      }
    }
    return mock.fetcher(input, init);
  };
  const bundle = await collectLiveSolana(token, liveOptions(fetcher));
  const population = bundle.evidence.find(record => record.id === 'rpc-holder-population');
  const populationRaw = bundle.rawArtifacts['rpc-holder-population'];
  assert.ok(population && populationRaw, 'the fixture retains a successful exact-supply full holder population');
  assert.equal(population.sourceId, 'solana-rpc');
  assert.equal(population.sourceType, 'JSON_RPC');
  assert.equal(population.accessMode, 'PUBLIC_API');

  const directory = mkdtempSync(join(tmpdir(), 'holder-population-cap-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  const setArtifact = (id: string, raw: string) => {
    const evidence = bundle.evidence.find(record => record.id === id);
    assert.ok(evidence, `${id} has a matching provenance record`);
    bundle.rawArtifacts[id] = raw;
    evidence.contentHash = sha256(raw);
  };
  try {
    setArtifact('rpc-holder-population', populationRaw.trimEnd().padEnd(24_000_001, ' '));
    assert.doesNotThrow(() => service.analyzeLive(bundle),
      'a correctly hashed holder response above the ordinary aggregate cap fits the exact holder allowance');

    setArtifact('rpc-holder-population', populationRaw.trimEnd().padEnd(64_000_001, ' '));
    assert.throws(() => service.analyzeLive(bundle), /ARTIFACT_HASH_OR_SIZE/,
      'the holder allowance still has a hard 64 MB ceiling even when the supplied digest matches');

    setArtifact('rpc-holder-population', populationRaw);
    const mintRaw = bundle.rawArtifacts['rpc-mint-raw'];
    assert.ok(mintRaw, 'the paired raw mint artifact is retained');
    setArtifact('rpc-mint-raw', mintRaw.trimEnd().padEnd(24_000_001, ' '));
    assert.throws(() => service.analyzeLive(bundle), /ARTIFACT_HASH_OR_SIZE/,
      'an equally large non-holder artifact remains subject to the ordinary LIVE aggregate cap');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Service reconstructs a finalized holder-population retry and rejects rehashed trigger, floor, and bound mutations', async () => {
  const mock = mockedFetch();
  const makeMint = (supply: bigint) => {
    const bytes = Buffer.alloc(82);
    bytes.writeBigUInt64LE(supply, 36);
    bytes[44] = 6;
    bytes[45] = 1;
    return bytes;
  };
  const holderAccount = (amount: bigint) => {
    const bytes = Buffer.alloc(165);
    new PublicKey(MINT).toBuffer().copy(bytes, 0);
    Buffer.alloc(32, 9).copy(bytes, 32);
    bytes.writeBigUInt64LE(amount, 64);
    bytes[108] = 1;
    return bytes;
  };
  let mintReads = 0;
  let populationReads = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://rpc.example/') || url.startsWith('https://api.mainnet.solana.com')) {
      const request = JSON.parse(String(init?.body)) as { method: string; params?: unknown[] };
      if (request.method === 'getAccountInfo' && request.params?.[0] === MINT
        && (request.params[1] as { encoding?: string } | undefined)?.encoding === 'base64') {
        mintReads++;
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: mintReads === 1 ? 322 : 324 }, value: rpcAccount(LEGACY_TOKEN_PROGRAM, makeMint(mintReads === 1 ? 100n : 90n)),
        } });
      }
      if (request.method === 'getProgramAccounts') {
        populationReads++;
        const amount = populationReads === 1 ? 90n : 90n;
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: {
          context: { slot: populationReads === 1 ? 323 : 325 },
          value: [{ pubkey: PROGRAM_DATA, account: rpcAccount(LEGACY_TOKEN_PROGRAM, holderAccount(amount)) }],
        } });
      }
    }
    return mock.fetcher(input, init);
  };
  const bundle = await collectLiveSolana(token, liveOptions(fetcher));
  assert.equal(mintReads, 2, 'the mismatch produces exactly one finalized raw-mint refresh');
  assert.equal(populationReads, 2, 'the refreshed mint is followed by exactly one fresh population scan');
  assert.ok(bundle.rawArtifacts['rpc-mint-raw-reconciliation-attempt-1']);
  assert.ok(bundle.rawArtifacts['rpc-holder-population-reconciliation-attempt-1']);
  assert.ok(bundle.rawArtifacts['rpc-mint-reconciliation-response']);
  assert.equal(bundle.rawArtifacts['rpc-mint-raw'], bundle.rawArtifacts['rpc-mint-reconciliation-response']);
  for (const id of ['O17', 'O18', 'O19', 'O20']) {
    assert.equal(bundle.details?.baseline.find(row => row.id === id)?.quality, 'KNOWN', `${id} is derived from the reconciled complete population`);
  }

  const directory = mkdtempSync(join(tmpdir(), 'holder-reconciliation-service-'));
  const service = new Service(join(directory, 'proof.sqlite'));
  const rehash = (candidate: typeof bundle, id: string, raw: string) => {
    candidate.rawArtifacts[id] = raw;
    const evidence = candidate.evidence.find(record => record.id === id);
    assert.ok(evidence, `${id} has a provenance record`);
    evidence.contentHash = sha256(raw);
  };
  try {
    const saved = service.analyzeLive(bundle);
    assert.deepEqual(service.replay(saved.id), saved, 'the verified reconciliation survives persistence and deterministic replay');

    const badTrigger = structuredClone(bundle);
    const initialPopulation = JSON.parse(badTrigger.rawArtifacts['rpc-holder-population-reconciliation-attempt-1']!) as {
      result: { value: Array<{ account: { data: [string, string] } }> };
    };
    const initialBytes = Buffer.from(initialPopulation.result.value[0]!.account.data[0], 'base64');
    initialBytes.writeBigUInt64LE(100n, 64);
    initialPopulation.result.value[0]!.account.data[0] = initialBytes.toString('base64');
    const initialPopulationRaw = JSON.stringify(initialPopulation);
    rehash(badTrigger, 'rpc-holder-population-reconciliation-attempt-1', initialPopulationRaw);
    assert.throws(() => service.analyzeLive(badTrigger), /HOLDER_RECONCILIATION_PROOF_INVALID/,
      'a rehashed original sample that no longer mismatches cannot authorize a retry');

    const badFloor = structuredClone(bundle);
    const currentMint = JSON.parse(badFloor.rawArtifacts['rpc-mint-raw']!) as { result: { context: { slot: number } } };
    currentMint.result.context.slot = 322;
    rehash(badFloor, 'rpc-mint-raw', JSON.stringify(currentMint));
    assert.throws(() => service.analyzeLive(badFloor), /HOLDER_RECONCILIATION_PROOF_INVALID/,
      'a rehashed refreshed mint below the first population slot fails monotonic-floor validation');

    const badBounds = structuredClone(bundle);
    const concentration = badBounds.details?.baseline.find(row => row.id === 'O19');
    assert.ok(concentration);
    concentration.data = { ...(concentration.data as Record<string, unknown>), sampledAtomic: '89' };
    assert.throws(() => service.analyzeLive(badBounds), /HOLDER_RECONCILIATION_PROOF_INVALID/,
      'a modified baseline cannot be admitted when it disagrees with the exact reconciled holder decode');
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
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

function publicLeadScopes(packet: Record<string, unknown>) {
  const qualification = packet.leadQualification as {
    leads?: Array<{ id: string; metadataEvidenceId: string; sourceIds?: string[]; recoverySourceIds?: string[] }>;
    decisions?: Array<{ leadId: string; accounted: boolean; accounting: { role: string } }>;
  } | undefined;
  const facts = packet.publicScopeFacts as Array<{
    leadId: string; originalComplete: boolean; recoveryComplete: boolean; queryReady: boolean; queryCount: number;
    effectiveAccounted: boolean; descriptorComplete: boolean; descriptorFresh: boolean;
    collectionBlocked: boolean; leadReviewsComplete: boolean; reviewedIndexedRole?: string;
  }> | undefined;
  const catalog = packet.sources as Array<{ sourceId: string; spans: Array<{ id: string; text: string }> }> | undefined;
  assert.ok(qualification?.leads && facts && catalog, 'the v2 grade packet supplies exact lead and collection facts');
  return Object.fromEntries(qualification.leads.map(lead => {
    const fact = facts.find(row => row.leadId === lead.id);
    const decision = qualification.decisions?.find(row => row.leadId === lead.id);
    const descriptor = catalog.find(source => source.sourceId === lead.metadataEvidenceId);
    assert.ok(fact && decision && descriptor?.spans[0], `the v2 packet has the full scope inputs for ${lead.id}`);
    const citations: Array<{ sourceId: string; spanId: string }> = [{ sourceId: descriptor.sourceId, spanId: descriptor.spans[0]!.id }];
    const bodyIds = fact.originalComplete ? lead.sourceIds ?? [] : lead.recoverySourceIds ?? [];
    const body = catalog.find(source => bodyIds.includes(source.sourceId) && source.spans.length > 0);
    if (body?.spans[0]) citations.push({ sourceId: body.sourceId, spanId: body.spans[0].id });
    const reviewed = fact.descriptorComplete && fact.descriptorFresh && !fact.collectionBlocked
      && fact.queryReady && fact.recoveryComplete && fact.leadReviewsComplete;
    const role = fact.reviewedIndexedRole ?? decision.accounting.role;
    const basis = fact.originalComplete ? 'ORIGINAL_COMPLETE'
      : fact.effectiveAccounted && fact.queryCount > 0 ? 'MATCHED_ENTITY_RECOVERY'
        : role === 'MARKET_OR_INDEX_RECORD' && fact.queryCount > 0 ? 'REVIEWED_MARKET_RECOVERY' : 'NONE';
    const complete = reviewed && basis !== 'NONE' && role !== 'UNRESOLVED';
    return [lead.id, {
      status: complete ? 'REVIEWED' : 'UNRESOLVED', basis: complete ? basis : 'NONE', role,
      blocker: complete ? 'NONE' : role === 'PROJECT_OR_PUBLICATION' ? 'MISSING_NECESSARY_CONTEXT' : 'INCOMPLETE_COLLECTION_OR_REVIEW',
      rationale: complete
        ? 'The independent review verifies this lead public-support scope against its own descriptor and retained source evidence.'
        : 'The lead public-review scope remains unresolved because a necessary own collection or review condition is incomplete.',
      citations,
    }];
  }));
}

function publicLeadScopeReviews(packet: Record<string, unknown>) {
  const scopes = (packet.supportProposal as { leadScopes?: Record<string, unknown> } | undefined)?.leadScopes;
  return scopes ? Object.fromEntries(Object.keys(scopes).map(id => [id, {
    accepted: true, rationale: 'The independent review checks this lead scope against its own original and recovery evidence.',
  }])) : undefined;
}

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

function attentionObservationId(packet: Record<string, unknown>, token: TokenRef, sourceId: string): string {
  const observations = packet.exactContractObservations as Array<{
    observationId: string; token: TokenRef; sourceId: string; spanId: string;
  }>;
  const observation = observations.find(item => item.token.chain === token.chain && item.token.address === token.address
    && item.sourceId === sourceId);
  assert.ok(observation, `no code-owned literal observation for ${token.chain}:${token.address} in ${sourceId}`);
  return observation.observationId;
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

function comparisonRowsForV3(packet: Record<string, unknown>, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const envelope = structuredClone(value) as Record<string, unknown>;
  const candidate = (envelope.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0];
  const part = candidate?.content?.parts?.[0];
  const response = (part?.text ? JSON.parse(part.text) : envelope) as Record<string, unknown>;
  const rowFormat = `${String(packet.rowFormat ?? '')}\n${String(packet.instruction ?? '')}`;
  const rows = (source: unknown, key: string) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
    return Object.entries(source as Record<string, unknown>).map(([id, item]) => ({ [key]: id, ...(item as Record<string, unknown>) }));
  };
  const coherentRows = (source: unknown) => {
    const decisions = Array.isArray(source) ? source : rows(source, 'leadId');
    return Array.isArray(decisions) ? decisions.map(value => {
      const row = value as Record<string, unknown>;
      const accounting = row.accounting as Record<string, unknown> | undefined;
      if (!accounting || ('descriptorRef' in accounting && !('status' in accounting))) return row;
      const descriptorRefs = accounting.descriptorRefs;
      const corroboratingRefs = accounting.corroboratingRefs;
      if (!Array.isArray(descriptorRefs) || descriptorRefs.length !== 1 || !Array.isArray(corroboratingRefs)) return row;
      if (accounting.status === 'UNRESOLVED' && accounting.basis === 'NONE') {
        const { status: _status, descriptorRefs: _descriptorRefs, ...rest } = accounting;
        return { ...row, accounting: { ...rest, descriptorRef: descriptorRefs[0] } };
      }
      if (accounting.status === 'ACCOUNTED' && accounting.basis !== 'NONE' && accounting.role !== 'UNRESOLVED'
        && corroboratingRefs.length > 0 && corroboratingRefs.length <= 5) {
        const { status: _status, descriptorRefs: _descriptorRefs, corroboratingRefs: _corroboratingRefs, ...rest } = accounting;
        return { ...row, accounting: { ...rest, descriptorRef: descriptorRefs[0], corroboratingRef: corroboratingRefs[0], additionalCorroboratingRefs: corroboratingRefs.slice(1) } };
      }
      return row;
    }) : decisions;
  };
  if (Array.isArray(packet.operands) && packet.requiredLeadDecisionGroups && !('proposal' in packet)
    && response.decisions && !('withOriginalBodies' in (response.decisions as Record<string, unknown>))) {
    const groups = packet.requiredLeadDecisionGroups as { withOriginalBodies: string[]; withoutOriginalBodies: string[] };
    const decisions = coherentRows(response.decisions) as Array<Record<string, unknown>>;
    const byId = new Map(decisions.map(row => [String(row.leadId), row]));
    response.decisions = {
      withOriginalBodies: groups.withOriginalBodies.flatMap(id => byId.has(id) ? [byId.get(id)] : []),
      withoutOriginalBodies: groups.withoutOriginalBodies.flatMap(id => byId.has(id) ? [byId.get(id)] : []),
    };
  } else if (Array.isArray(packet.operands) && rowFormat.includes('Accounting has one authoritative basis and no status field.')
    && !('proposal' in packet) && response.decisions) {
    response.decisions = coherentRows(response.decisions);
  } else if (Array.isArray(packet.selectedLeadIds) && Array.isArray(packet.leads) && response.leads && !Array.isArray(response.leads)) {
    response.leads = rows(response.leads, 'leadId');
  } else if (packet.requiredSourceDecisionGroups && response.sourceDecisions
    && !('withLiteralObservations' in (response.sourceDecisions as Record<string, unknown>))) {
    const decisions = response.sourceDecisions as Record<string, unknown>;
    const groups = packet.requiredSourceDecisionGroups as { withLiteralObservations: string[]; withoutLiteralObservations: string[] };
    response.decisions = rows(response.decisions, 'id');
    response.bodyDecisions = rows(response.bodyDecisions, 'sourceId');
    response.sourceDecisions = {
      withLiteralObservations: groups.withLiteralObservations.flatMap(id => id in decisions ? [{ sourceId: id, ...(decisions[id] as Record<string, unknown>) }] : []),
      withoutLiteralObservations: groups.withoutLiteralObservations.flatMap(id => id in decisions ? [{ sourceId: id, ...(decisions[id] as Record<string, unknown>) }] : []),
    };
  } else if (Array.isArray(packet.operands) && rowFormat.includes('Return decisions as one array row for EVERY operand')) {
    response.decisions = rows(response.decisions, 'leadId');
  } else if (Array.isArray(packet.operands) && rowFormat.includes('Return decisions as an array with exactly one leadId row')) {
    response.decisions = rows(response.decisions, 'leadId');
  } else if (rowFormat.includes('Return bodyObservations and posts as arrays')) {
    response.bodyObservations = rows(response.bodyObservations, 'sourceId');
    const postRows = rows(response.posts, 'sourceId');
    const omitNoPosts = String(packet.rowFormat ?? '').includes('There are no POST sources: posts field does not exist');
    if (omitNoPosts && Array.isArray(postRows) && postRows.length === 0) delete response.posts;
    else response.posts = postRows;
    const omitNoObservations = String(packet.rowFormat ?? '').includes('There are no literal contract observations: competitors field does not exist');
    if (omitNoObservations && Array.isArray(response.competitors) && response.competitors.length === 0) delete response.competitors;
  } else if (rowFormat.includes('Return decisions, sourceDecisions and bodyDecisions as arrays')) {
    response.decisions = rows(response.decisions, 'id');
    response.sourceDecisions = rows(response.sourceDecisions, 'sourceId');
    response.bodyDecisions = rows(response.bodyDecisions, 'sourceId');
  } else if (rowFormat.includes('Return leadRoles, sourceSupport and leadBlockers as arrays')) {
    const leadRoles = rows(response.leadRoles, 'leadId');
    response.leadRoles = Array.isArray(leadRoles) && rowFormat.includes('descriptorRef is a single object, not an array')
      ? leadRoles.map(value => {
        const row = value as Record<string, unknown>;
        if ('descriptorRef' in row) return row;
        const { descriptorRefs, ...rest } = row;
        return Array.isArray(descriptorRefs) && descriptorRefs.length > 0
          ? { ...rest, descriptorRef: descriptorRefs[0] }
          : rest;
      })
      : leadRoles;
    response.sourceSupport = rows(response.sourceSupport, 'sourceId');
    const blockers = rows(response.leadBlockers, 'leadId');
    response.leadBlockers = Array.isArray(blockers) ? blockers.map((row: Record<string, unknown>) => ({
      ...row, blockerProof: row.blockerProof ?? null,
    })) : blockers;
  } else if (rowFormat.includes('Return entryReview.leadRoles, sourceSupport and leadBlockers as exact ID arrays')) {
    const entryReview = response.entryReview as Record<string, unknown> | undefined;
    if (entryReview) response.entryReview = {
      ...entryReview,
      leadRoles: rows(entryReview.leadRoles, 'leadId'),
      sourceSupport: rows(entryReview.sourceSupport, 'sourceId'),
      leadBlockers: rows(entryReview.leadBlockers, 'leadId'),
    };
    response.decisions = rows(response.decisions, 'id');
  }
  if (part) part.text = JSON.stringify(response);
  return part ? envelope : response;
}

function comparisonLeadArray(decisions: Record<string, unknown>) {
  return Object.entries(decisions).map(([leadId, decision]) => ({ leadId, ...(decision as Record<string, unknown>) }));
}

function comparisonReviewFields(packet: Record<string, unknown>) {
  const sources = (packet.sources ?? []) as Array<{ id: string }>;
  return {
    sourceDecisions: Object.fromEntries(sources.map(source => [source.id, {
      disposition: 'RELEVANT', insufficiencyKind: 'NONE',
      rationale: 'The retained source establishes this exact project representation.',
      inspectionComplete: true,
    }])),
    supportDecisions: Object.fromEntries(sources.map(source => [source.id, {
      accepted: true, rationale: 'The independent review accepts the selected source-support classification.',
    }])),
    missingRepresentations: [],
  };
}

function freshComparisonResponse(packet: Record<string, unknown>, target: TokenRef, additionalCandidates: TokenRef[] = []) {
  const sources = (packet.sources ?? []) as AttentionPacket['sources'];
  if (packet.entryTask && packet.mergeTask) {
    const entry = packet.entryTask as { proposal?: Record<string, unknown>; sources?: Array<{ id: string; spans: Array<{ id: string }> }> };
    const merge = packet.mergeTask as { candidates?: Array<{ id: string }>; manifest?: { qualificationMethod?: string; entryDecisionMethod?: string } };
    const proposal = entry.proposal;
    assert.ok(proposal, 'the fresh final review receives the exact entry proposal');
    const leadRoles = proposal.leadRoles as Record<string, unknown>;
    const sourceSupport = proposal.sourceSupport as Record<string, unknown>;
    const leadBlockers = proposal.leadBlockers as Record<string, unknown>;
    const entryCitation = entry.sources?.flatMap(source => source.spans.map(span => ({ sourceId: source.id, spanId: span.id })))
      .find(ref => ref.sourceId && ref.spanId);
    if (merge.manifest?.entryDecisionMethod === 'binary-public-support-v1') {
      assert.ok(entryCitation, 'the direct entry decision cites a supplied comparison-body span');
    }
    return attentionEnvelope({
      ...(merge.manifest?.entryDecisionMethod === 'binary-public-support-v1' ? { entryDecision: {
        verdict: 'FAIL', rationale: 'The bounded comparison sample does not meet the independent public-support standard.', citations: [entryCitation!],
      } } : {}),
      entryReview: {
        leadRoles: Object.fromEntries(Object.keys(leadRoles).map(id => [id, { accepted: true, rationale: 'The own indexed role is supported by its descriptor and retained body.' } ])),
        sourceSupport: Object.fromEntries(Object.keys(sourceSupport).map(id => [id, { accepted: true, rationale: 'The body classification is supported by its own inspected literal text.' } ])),
        leadBlockers: Object.fromEntries(Object.keys(leadBlockers).map(id => [id, { accepted: true, rationale: 'No unsupported semantic blocker is asserted.' } ])),
        grade: { accepted: true, rationale: 'The unresolved public-support judgment is appropriate for the selected evidence.' },
      },
      decisions: Object.fromEntries((merge.candidates ?? []).map(({ id }) => [id, { accepted: true, rationale: 'The candidate is checked against its retained literal observation.' } ])),
      candidateSet: { complete: true, rationale: 'The target and every relevant representation in these full source batches are accounted for.' },
    });
  }

  if ((packet.method === 'binary-public-support-v2' || packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4') && Array.isArray(packet.sources)) {
    const catalog = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
    const originIds = (packet.scope as { originSourceIds: string[] }).originSourceIds;
    const origin = catalog.flatMap(source => source.spans.map(span => ({ source, span })))
      .find(({ source, span }) => originIds.includes(source.id) && span.text.includes(target.address));
    const comparison = catalog.flatMap(source => source.spans.map(span => ({ source, span })))[0];
    assert.ok(origin, 'the independent origin criterion cites a literal target span from the original scope');
    assert.ok(comparison, 'the remaining criteria cite actual retained comparison text');
    const explanationIds = packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4' ? packet.explainableCitationSourceIds as string[] : [];
    const explainable = catalog.flatMap(source => source.spans.map(span => ({ source, span })))
      .find(({ source, span }) => explanationIds.includes(source.id) && span.text.includes(target.address));
    if (packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4') assert.ok(explainable, 'the fresh thesis judgment cites a narrative-bound exact-token source');
    const final = Object.hasOwn(packet, 'draft');
    const grade = (verdict: 'PASS' | 'FAIL', sourceId: string, spanId: string, rationale: string) => ({
      verdict, rationale, citation: { sourceId, spanId },
    });
    return attentionEnvelope({
      originTraceability: grade(final ? 'FAIL' : 'PASS', origin.source.id, origin.span.id, final
        ? 'The retained source names the exact contract but does not establish its specific originating project or catalyst.'
        : 'The retained source is proposed as support for the origin criterion.'),
      leadership: { ...grade(packet.method === 'binary-public-support-v4' || final ? 'FAIL' : 'PASS', comparison.source.id, comparison.span.id, final
        ? 'The bounded sample has no relative exact-token mention counts or verified primary-origin relationship.'
        : 'The retained source is proposed as support for the leadership criterion.'),
        ...(packet.method === 'binary-public-support-v4' ? { basis: 'EVIDENCE_INADEQUACY' } : {}) },
      representations: grade(final ? 'FAIL' : 'PASS', comparison.source.id, comparison.span.id, final
        ? 'The bounded source review does not establish adequate competing-representation coverage.'
        : 'The retained source is proposed as support for the representation criterion.'),
      ...(packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4' ? { explainableThesis: grade(final ? 'FAIL' : 'PASS', explainable!.source.id, explainable!.span.id, final
        ? 'The retained sources do not adequately explain the narrative interest and its relationship to this exact token.'
        : 'The retained source is proposed as support for a plain-language thesis judgment.') } : {}),
      inspectionComplete: true,
    });
  }

  if (packet.method === 'binary-public-support-v1' && Array.isArray(packet.sources)) {
    const catalog = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
    const sourceIds = catalog.map(source => source.id);
    const cited = catalog.flatMap(source => source.spans.map(span => ({ sourceId: source.id, ...span })))
      .find(span => span.text.includes(target.address));
    assert.ok(cited, 'the binary origin pair cites literal target text in its original source scope');
    const decision = (verdict: 'PASS' | 'FAIL') => ({ verdict,
      rationale: 'The criterion is judged independently from the complete retained sample.', citations: [{ sourceId: cited.sourceId, spanId: cited.id }] });
    if ('screening' in packet) return attentionEnvelope({
      originTraceability: decision('FAIL'), leadership: decision('FAIL'), inspectionComplete: true, sourceIds,
    });
    return attentionEnvelope({
      originTraceability: { verdict: 'UNRESOLVED', rationale: 'The draft leaves the criterion for independent review.', citations: [{ sourceId: cited.sourceId, spanId: cited.id }] },
      leadership: { verdict: 'UNRESOLVED', rationale: 'The draft leaves the separate criterion for independent review.', citations: [{ sourceId: cited.sourceId, spanId: cited.id }] },
      sourceIds,
    });
  }

  if (Array.isArray(packet.operands)) {
    const operands = packet.operands as Array<{
      leadId: string; indexedDescriptorId: string; originalBodyIds: string[]; recoveryBodyIds: string[];
      literalOptions: Array<{ id: string; token: TokenRef; sourceId: string; spanId: string }>;
    }>;
    if (packet.proposal) {
      const decisions = packet.proposal as { decisions: Record<string, unknown> };
      return attentionEnvelope({ decisions: Object.fromEntries(Object.keys(decisions.decisions).map(id => [id, {
        accounting: { accepted: true, rationale: 'The indexed item identity is reviewed separately from public support.' },
        representation: { accepted: true, rationale: 'The proposed relation is checked against its own descriptor and retained sources.' },
        subjectComparison: { accepted: true, rationale: 'The original-body comparison is reviewed as a separate factual axis.' },
        evidenceAdequacy: { accepted: true, rationale: 'The proposal does not infer inadequacy from a missing original body.' },
      }])) });
    }
    const catalog = sources;
    return attentionEnvelope({ decisions: Object.fromEntries(operands.map(operand => {
      const descriptor = catalog.find(source => source.id === operand.indexedDescriptorId);
      assert.ok(descriptor?.spans[0], `the task packet retains ${operand.indexedDescriptorId}`);
      const descriptorRef = { sourceId: descriptor.id, spanId: descriptor.spans[0]!.id };
      const ownIds = [...operand.originalBodyIds, ...operand.recoveryBodyIds];
      const body = catalog.find(source => ownIds.includes(source.id) && source.spans.length > 0
        && source.spans.some(span => span.text.includes(target.address)));
      const ownBody = body ?? catalog.find(source => ownIds.includes(source.id) && source.spans.length > 0);
      const bodyRef = ownBody?.spans[0] ? { sourceId: ownBody.id, spanId: ownBody.spans[0].id } : undefined;
      const literal = operand.literalOptions.find(option => option.token.chain === target.chain
        && option.token.address === target.address && ownIds.includes(option.sourceId));
      const isTarget = !!literal && operand.originalBodyIds.length > 0;
      const decision: Record<string, unknown> = {
        accounting: {
          status: ownBody ? 'ACCOUNTED' : 'UNRESOLVED', basis: ownBody ? operand.originalBodyIds.includes(ownBody.id) ? 'ORIGINAL_TEXT' : 'RECOVERED_ENTITY' : 'NONE',
          role: /market|pool|pair|dexscreener/i.test(operand.leadId) ? 'MARKET_OR_INDEX_RECORD' : 'PROJECT_OR_PUBLICATION',
          rationale: ownBody ? 'This lead is supported by its own acquired or positively recovered source.' : 'The own item remains unresolved without acquired corroboration.',
          descriptorRefs: [descriptorRef], corroboratingRefs: bodyRef ? [bodyRef] : [],
        },
        representation: isTarget && literal
          ? { status: 'BOUND', literalObservationId: literal.id, rationale: 'The target mint is bound by its own original project text.', associationRefs: bodyRef ? [bodyRef] : [] }
          : ownBody
            ? { status: 'UNRELATED', rationale: 'The own source describes a distinct indexed project, not the target narrative.', citations: [descriptorRef, bodyRef] }
            : { status: 'UNRESOLVED', rationale: 'The available item evidence does not establish a target association.', citations: [descriptorRef] },
      };
      if (operand.originalBodyIds.length) {
        decision.subjectComparison = isTarget && bodyRef
          ? { status: 'CONSISTENT', indexedSubject: 'The indexed target project', currentSubject: 'The acquired target project', rationale: 'The original body describes its own indexed target project.', descriptorRefs: [descriptorRef], fetchedRefs: [bodyRef] }
          : { status: 'UNRESOLVED', indexedSubject: 'The indexed project', currentSubject: null, rationale: 'The original body does not establish a current subject match.', descriptorRefs: [descriptorRef], fetchedRefs: [] };
        decision.evidenceAdequacy = { verdict: 'UNRESOLVED', rationale: 'This lead does not establish an original-source public-support deficiency.', citations: [] };
      }
      return [operand.leadId, decision];
    })) });
  }

  const scope = packet.scope as { batch?: number } | undefined;
  if (typeof scope?.batch === 'number' && packet.targetContext && Array.isArray(packet.exactContractObservations)) {
    const observationSources = packet.exactContractObservations as Array<{ observationId: string; token: TokenRef; sourceId: string }>;
    if (!packet.proposal) {
      const bodyObservations = Object.fromEntries(sources.map(source => {
        const span = source.spans[0];
        assert.ok(span, `batch source ${source.id} has a selected literal span`);
        const text = source.spans.map(item => item.text).join('\n');
        const footer = /About Press Copyright Contact us Creators (?:Advertisers )?Developers Terms Privacy Policy/i.test(text);
        const isTarget = text.includes(target.address);
        const bodyRole = footer ? 'OTHER_CONTEXT'
          : /market index|market pair|liquidity|trading data/i.test(text) ? 'MARKET_OR_INDEX_RECORD' : 'PROJECT_OR_PUBLICATION';
        const description = footer ? 'NO_SUBSTANTIVE_CONTENT'
          : /Lunar Cat|feline art|digital-parasite project|AVA AI/i.test(text) && !isTarget ? 'DISTINCT_OTHER_SUBJECT'
            : /market index|market pair|liquidity|trading data/i.test(text) ? 'MARKET_FIELDS_OR_BOILERPLATE' : 'SPECIFIC_PROJECT_OR_MECHANISM';
        const ref = { sourceId: source.id, spanId: span.id };
        return [source.id, {
          bodyRole: { kind: bodyRole, rationale: 'The source role follows its own full retained body.', citations: [ref] },
          description: { kind: description, rationale: 'The description follows the inspected text rather than the indexed name alone.', citations: [ref] },
        }];
      }));
      const candidateTokens = [target, ...additionalCandidates];
      const competitors = candidateTokens.flatMap((token, index) => {
        const observation = observationSources.find(item => item.token.chain === token.chain && item.token.address === token.address
          && sources.some(source => source.id === item.sourceId && source.spans.some(span => span.text.includes(token.address))));
        return observation ? [{ id: index === 0 ? 'target-retained-text' : `competing-retained-text-${index}`, observationId: observation.observationId }] : [];
      });
      return attentionEnvelope({ bodyObservations, competitors,
        posts: Object.fromEntries(((packet.requiredPostSourceIds ?? []) as string[]).map(id => [id, {
          spanId: attentionSpanId(packet, id, target.address), role: 'OTHER',
        }])) });
    }
    const proposal = packet.proposal as { competitors?: Array<{ observationId?: string; sourceId?: string }> };
    const selectedSourceIds = new Set((proposal.competitors ?? []).flatMap(item => {
      if (item.sourceId) return [item.sourceId];
      const observation = observationSources.find(candidate => candidate.observationId === item.observationId);
      return observation ? [observation.sourceId] : [];
    }));
    const noContent = (source: AttentionPacket['sources'][number]) => source.spans.some(span => /About Press Copyright Contact us Creators (?:Advertisers )?Developers Terms Privacy Policy/i.test(span.text));
    const decisions = Object.fromEntries(((packet.requiredDecisionIds ?? []) as string[]).map(id => [id, {
      accepted: true, rationale: 'The exact batch item is reviewed against every retained source span.' } ]));
    const omitNoItemDecisions = String(packet.rowFormat ?? '').includes('There are no required item decisions. The decisions field does not exist');
    return attentionEnvelope({
      ...(omitNoItemDecisions ? {} : { decisions }),
      candidateSet: { complete: true, rationale: 'Every relevant exact-contract observation in the acquired full-text batch is included.' },
      sourceDecisions: Object.fromEntries(sources.map(source => [source.id, {
        disposition: noContent(source) ? 'INSUFFICIENT' : selectedSourceIds.has(source.id) ? 'RELEVANT' : 'CONTEXT',
        insufficiencyKind: noContent(source) ? 'NO_SUBSTANTIVE_CONTENT' : 'NONE',
        rationale: 'The source is classified from its full retained text and selected observations.', inspectionComplete: true,
      } ])),
      bodyDecisions: Object.fromEntries(sources.map(source => [source.id, {
        bodyRole: { accepted: true, rationale: 'The retained full body supports this role.' },
        description: { accepted: true, rationale: 'The retained full body supports this description.' },
      } ])),
      ...(observationSources.length ? { missingRepresentations: [] } : {}),
    });
  }

  if (Array.isArray(packet.bodyObservations) && Array.isArray(packet.leadContexts) && Array.isArray(packet.sourceRequirements)) {
    const observations = packet.bodyObservations as Array<{ sourceId: string; bodyRole: { kind: string }; description: { kind: string } }>;
    const contexts = packet.leadContexts as Array<{ leadId: string; indexedMetadataSourceId: string; originalSourceIds: string[]; recoverySourceIds: string[] }>;
    const refFor = (sourceId: string) => {
      const source = sources.find(item => item.id === sourceId);
      assert.ok(source?.spans[0], `the entry packet supplies a selected span for ${sourceId}`);
      return { sourceId, spanId: source.spans[0]!.id };
    };
    const leadRoles = Object.fromEntries(contexts.map(context => {
      const descriptor = sources.find(source => source.id === context.indexedMetadataSourceId);
      assert.ok(descriptor?.spans[0], `the entry packet includes ${context.indexedMetadataSourceId}`);
      const own = [...context.originalSourceIds, ...context.recoverySourceIds].find(id => sources.some(source => source.id === id && source.spans.length));
      return [context.leadId, {
        role: /market|pool|pair|dexscreener/i.test(descriptor.spans.map(span => span.text).join(' ')) ? 'MARKET_OR_INDEX_RECORD' : 'PROJECT_OR_PUBLICATION',
        rationale: 'The original indexed descriptor identifies the source role.', descriptorRefs: [refFor(descriptor.id)],
        ownContextRefs: own ? [refFor(own)] : [],
      }];
    }));
    const sourceSupport = Object.fromEntries(observations.map(observation => {
      const status = observation.description.kind === 'SPECIFIC_PROJECT_OR_MECHANISM' ? 'BINDING_EVIDENCE' : 'CONTEXT_ONLY';
      return [observation.sourceId, { status, rationale: 'The fully inspected body is either specific narrative evidence or context.', citations: [refFor(observation.sourceId)], blockerProof: null }];
    }));
    const gradeSourceId = observations.find(item => item.description.kind === 'MARKET_FIELDS_OR_BOILERPLATE')?.sourceId
      ?? observations[0]?.sourceId ?? sources[0]?.id;
    assert.ok(gradeSourceId, 'the entry packet contains a literal grade witness');
    const proposal = { leadRoles, sourceSupport, leadBlockers: Object.fromEntries(contexts.map(context => [context.leadId, null])),
      grade: { verdict: 'UNRESOLVED', rationale: 'The retained bodies do not establish a reviewed public-support gap.', citations: [refFor(gradeSourceId)] } };
    if (!packet.entryTask) return attentionEnvelope(proposal);
  }
  return undefined;
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
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
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
    { name: 'full-text in-window post', publishedDate: '2026-09-29T10:00:00Z', complete: true, quality: 'KNOWN' },
    { name: 'missing post date', publishedDate: undefined, complete: true, quality: 'MISSING' },
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
      tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
    }));
    const receipt = JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as {
      read: { sources: Array<{ id: string; text: string }>; growthSample: { complete: boolean } };
    };
    const submitted = receipt.read.sources[0]!;
    const a18 = bundle.details?.baseline.find(row => row.id === 'A18');
    const attentionPackets = mock.geminiPackets.filter(packet => !isSocialModelPacket(packet)) as AttentionPacket[];
    assert.ok(bundle.rawArtifacts[submitted.id], 'the original acquired body remains separately retained');
    assert.equal(bundle.rawArtifacts[submitted.id]!.length, longText.length);
    assert.equal(submitted.text, longText, 'fresh mode retains the complete long source in its replay receipt');
    assert.ok(submitted.text.length > 6_000);
    assert.ok(attentionPackets.length >= 2);
    for (const packet of attentionPackets.slice(0, 2)) {
      const source = packet.sources.find(item => item.id === submitted.id)!;
      assert.equal(source.spans.map(span => span.text).join(''), longText, 'both fresh-mode model passes receive every retained character');
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

test('fresh live entry review receives full acquired text without a factual comparison pass', async () => {
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
      return { results: query.includes('"River Lantern"') || query.toLowerCase().includes(target.address.toLowerCase()) ? [{
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
      const scope = packet.scope as { mode?: string; batch?: number } | undefined;
      const freshResponse = freshComparisonResponse(packet, target, [{ chain: 'base', address: rival }]);
      if (freshResponse) return freshResponse;
      if (packet.manifest) {
        const leadScopeReviews = publicLeadScopeReviews(packet);
        return attentionEnvelope({
          ...(packet.supportProposal ? { supportReview: { accepted: true, rationale: 'The global review independently checks the scoped support assessment and all inspected sources.' } } : {}),
          ...(leadScopeReviews ? { leadScopeReviews } : {}),
          decisions: Object.fromEntries((typed.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The retained batch citations support this merged exact-contract candidate.',
          }])),
          candidateSet: { complete: true, rationale: 'Every full-text batch includes its supported exact-contract representations in the global merge.' },
        });
      }
      if (Array.isArray(packet.requiredLeadIds) && Array.isArray(packet.requiredSourceIds) && Array.isArray(packet.requiredBatchIds)) {
        const catalog = packet.sources as Array<{ sourceId: string; spans: Array<{ id: string; text: string }> }>;
        const cited = catalog.flatMap(source => source.spans.map(span => ({ sourceId: source.sourceId, ...span })))[0];
        assert.ok(cited, 'the public-support review receives a selected literal source citation');
        return attentionEnvelope({ verdict: 'UNRESOLVED', rationale: 'This fixture does not claim a reviewed public-support deficiency.',
          citations: [{ sourceId: cited.sourceId, spanId: cited.id }], ...comparisonGradeIdFields(packet),
          ...((packet.leadQualification as { supportScopeMethod?: string } | undefined)?.supportScopeMethod === 'comparison-lead-support-scope-v2'
            ? { leadScopes: publicLeadScopes(packet) } : {}) });
      }
      if (typeof scope?.batch === 'number' && packet.proposal) {
        return attentionEnvelope({
          decisions: Object.fromEntries((typed.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The complete original spans support this batch item.',
          }])),
          candidateSet: { complete: true, rationale: 'Every exact-contract representation visible in this complete-text batch is proposed and accepted.' },
          ...comparisonReviewFields(packet),
        });
      }
      if (typeof scope?.batch === 'number') {
        const source = typed.sources.find(item => item.spans.some(span => span.text.includes(target.address)));
        const rivalSource = typed.sources.find(item => item.spans.some(span => span.text.includes(rival)));
        assert.ok(source, 'the full-text batch contains the target representation');
        assert.ok(rivalSource, 'the full-text batch contains the tail rival');
        const leadScope = (scope as { leadQualification?: { leads?: Array<{ id?: string; leadId?: string; sourceIds?: string[]; recoverySourceIds?: string[] }> } }).leadQualification?.leads ?? [];
        const sourceSupport = Object.fromEntries(typed.sources.map(item => {
          const supporting = item.spans.find(span => span.text.includes(target.address))
            ?? item.spans.find(span => span.text.includes(rival));
          const leadIds = leadScope.filter(lead => [...(lead.sourceIds ?? []), ...(lead.recoverySourceIds ?? [])].includes(item.id))
            .map(lead => lead.id ?? lead.leadId).filter((id): id is string => typeof id === 'string');
          return [item.id, supporting
            ? { status: 'BINDING_EVIDENCE', rationale: 'The retained text ties a literal competing representation to the neighborhood-art narrative.', citations: [{ sourceId: item.id, spanId: supporting.id }], leadIds }
            : { status: 'CONTEXT_ONLY', rationale: 'This retained source is contextual and does not establish a distinct token representation.', citations: [], leadIds }];
        }));
        return attentionEnvelope({
          competitors: [
            { id: 'target-fulltext', observationId: attentionObservationId(packet, target, source.id) },
            { id: 'rival-tail', observationId: attentionObservationId(packet, { chain: 'base', address: rival }, rivalSource.id) },
          ],
          posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => [id, { spanId: attentionSpanId(packet, id, target.address), role: 'NEWS' }])),
          sourceSupport,
        });
      }
      if (scope?.mode === 'qualified-identified-leads-v3' && packet.proposal) {
        const proposed = packet.proposal as { decisions: Record<string, unknown> };
        const decisions = Object.keys(proposed.decisions).map(leadId => ({ leadId,
          accounting: { accepted: true, rationale: 'The original indexed lead is checked separately from its relation to the target.' },
          representation: { accepted: true, rationale: 'The cited exact mint and neighborhood-art narrative support the proposed representation.' },
          subjectComparison: { accepted: true, rationale: 'The indexed project and retained page describe the same River Lantern mechanism.' },
          evidenceAdequacy: { accepted: true, rationale: 'No source mismatch establishes inadequate public representation for this lead.' },
        }));
        return attentionEnvelope({ decisions });
      }
      if (scope?.mode === 'qualified-identified-leads-v3') {
        const leads = packet.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[]; acquisitionStatus: string }>;
        const decisions = leads.map(lead => {
          const sourceId = lead.sourceIds[0];
          const source = typed.sources.find(item => item.id === sourceId);
          assert.ok(source, `the acquired named lead ${lead.id} retains its source`);
          const span = source.spans.find(item => item.text.includes(target.address));
          assert.ok(span, `the indexed source ${lead.id} contains the exact target contract`);
          const descriptor = { sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId) };
          const fetched = { sourceId, spanId: span.id };
          return { leadId: lead.id,
            accounting: { status: 'ACCOUNTED', basis: 'ORIGINAL_TEXT', role: 'PROJECT_OR_PUBLICATION',
              rationale: 'The original project publication was fetched and its own indexed subject is retained.',
              descriptorRefs: [descriptor], corroboratingRefs: [fetched] },
            representation: { status: 'BOUND', unresolvedKind: 'NONE', token: target,
              rationale: 'The original project publication connects the exact token to the neighborhood-art narrative.', citations: [fetched] },
            subjectComparison: { status: 'CONSISTENT', indexedSubject: 'River Lantern neighborhood-art project', currentSubject: 'River Lantern neighborhood-art project',
              rationale: 'The indexed descriptor and fetched original page describe the same project.', descriptorRefs: [descriptor], fetchedRefs: [fetched] },
            evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'This project page does not establish a factual public-support deficiency.', citations: [descriptor] },
          };
        });
        return attentionEnvelope({ decisions });
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
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));

  const providerCalls = assertSocialProviderCallsAreSeparated(mock, result.rawArtifacts);
  assert.deepEqual(providerCalls, { attentionSearchCount: 3, socialSearchCount: 2, attentionFetchCount: 1, socialFetchCount: 1 });
  const attentionPackets = mock.geminiPackets.filter(packet => !isSocialModelPacket(packet));
  const socialPackets = mock.geminiPackets.filter(isSocialModelPacket);
  const entryPackets = attentionPackets.filter(packet => packet.method === 'binary-public-support-v4');
  assert.equal(entryPackets.length, 2, 'fresh acquisition reuses the independent public-entry proposal/review pair');
  assert.equal(socialPackets.length, 1);
  assert.equal(invalidSocialModelCalls, 1);
  assertInvalidSocialProposal(result.rawArtifacts);
  const receipt = JSON.parse(result.rawArtifacts['attention-qualified-receipt']!) as {
    read: {
      entryExecutionMethod?: string; comparisonComplete?: boolean; comparisonQualification?: unknown;
      comparisonSourceIds?: string[]; comparisonRecovery?: {
        method: string; selectedLeadIds: string[]; recoveryQueries: Array<{ queryId: string; parentLeadId: string; state: string }>;
        sourceLineage: Array<{ leadId: string; queryIds: string[]; sourceIds: string[] }>;
      }; comparisonAcquisition?: { leads: Array<{ id: string; recoveryQueryIds: string[]; recoverySourceIds: string[] }> };
    };
    review: { entryDecisions?: { method: string; originTraceability: { verdict: string }; leadership: { verdict: string };
      representations: { verdict: string }; explainableThesis?: { verdict: string } } };
  };
  const comparisonSourceId = receipt.read.comparisonSourceIds?.[0];
  assert.ok(comparisonSourceId);
  assert.equal(receipt.read.entryExecutionMethod, 'entry-first-v2');
  assert.equal(receipt.read.comparisonComplete, false);
  assert.equal(receipt.read.comparisonQualification, undefined,
    'source acquisition does not manufacture factual comparison accounting');
  assert.equal(receipt.read.comparisonRecovery?.method, 'comparison-acquisition-v1');
  assert.ok(receipt.read.comparisonRecovery?.recoveryQueries.every(query =>
    receipt.read.comparisonRecovery?.selectedLeadIds.includes(query.parentLeadId)));
  for (const lineage of receipt.read.comparisonRecovery?.sourceLineage ?? []) {
    const lead = receipt.read.comparisonAcquisition?.leads.find(item => item.id === lineage.leadId);
    assert.ok(lead);
    assert.deepEqual(lineage.queryIds, lead.recoveryQueryIds);
    assert.deepEqual(lineage.sourceIds, lead.recoverySourceIds);
  }
  assert.equal(result.rawArtifacts['attention-entry-first-acquisition'], JSON.stringify(receipt.read.comparisonRecovery));
  assert.deepEqual(receipt.review.entryDecisions && [receipt.review.entryDecisions.method,
    receipt.review.entryDecisions.originTraceability.verdict, receipt.review.entryDecisions.leadership.verdict,
    receipt.review.entryDecisions.representations.verdict, receipt.review.entryDecisions.explainableThesis?.verdict],
  ['binary-public-support-v4', 'FAIL', 'FAIL', 'FAIL', 'FAIL']);
  const baseProposalResponse = JSON.parse(result.rawArtifacts['attention-proposal-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  assert.deepEqual((JSON.parse(baseProposalResponse.candidates[0]!.content.parts[0]!.text) as { competitors: unknown[] }).competitors, [], 'the base pass leaves comparison candidates to full-text review');
  assert.equal(result.rawArtifacts[comparisonSourceId], comparisonText, 'live evidence retains the full collector text, including the rival after the model prefix');
  for (const packet of entryPackets) {
    const packetSources: AttentionPacket['sources'] = packet.sources as AttentionPacket['sources'];
    const submitted: AttentionPacket['sources'][number] = packetSources.find(source => source.id === comparisonSourceId)!;
    assert.equal(submitted.spans.map(span => span.text).join(''), comparisonText,
      'both independent entry passes receive the complete retained body, including the tail representation');
    assert.ok(submitted.spans.some(span => span.text.includes(rival)));
  }
  assert.equal(Object.keys(result.rawArtifacts).some(id => /^attention-comparison-\d+-(?:proposal|review)-prompt$/.test(id)), false,
    'the fresh route does not issue factual comparison batch prompts');
  assert.equal(result.rawArtifacts['attention-comparison-manifest'], undefined);
  for (const id of ['attention-leadership-proposal-prompt', 'attention-leadership-proposal-response',
    'attention-leadership-review-prompt', 'attention-leadership-review-response']) {
    assert.ok(result.rawArtifacts[id], `the independent entry pair retains ${id}`);
  }
  assert.equal(result.rawArtifacts['attention-entry-first-acquisition'], JSON.stringify(receipt.read.comparisonRecovery));
  assert.equal(result.rawArtifacts['attention-comparison-coverage'], undefined);
  const a09 = result.details?.baseline.find(row => row.id === 'A09');
  assert.equal(a09?.quality, 'KNOWN');
  assert.equal(a09?.projection?.value, false, 'the independent entry decision grades public support');
  const a09Data = a09?.data as { entryDecisionMethod?: string; factualAssessment?: { quality: string; value: unknown } } | undefined;
  assert.equal(a09Data?.entryDecisionMethod, 'binary-public-support-v4');
  assert.notEqual(a09Data?.factualAssessment?.quality, 'KNOWN',
    'the public entry grade does not turn the acquired rival text into factual comparison qualification');
  assert.equal(a09Data?.factualAssessment?.value, null);
});

test('fresh entry-first lead recovery preserves each parent lineage through Service replay', async () => {
  const target = { chain: 'solana', address: MINT } as const;
  const alternate = { chain: 'solana', address: OTHER_MINT } as const;
  const targetUrl = 'https://public.example/river-lantern';
  const failedUrl = 'https://index.example/ava';
  const unrelatedUrl = 'https://index.example/lunar-cat';
  const alternateUrl = 'https://projects.example/avaai-contract';
  const unrelatedEvidenceUrl = 'https://encyclopedia.example/lunar-cat';
  const footerUrl = 'https://www.youtube.com/about';
  const targetText = `The River Lantern project represents exact contract ${target.address}. Its community shares a neighborhood story.`;
  const alternateText = `AVAAI represents the indexed digital-parasite project under exact contract ${alternate.address}; this is a separate Solana representation.`;
  const unrelatedEvidenceText = 'Lunar Cat is an illustrated pink-eyed feline art collective on Solana, centered on pink-eyed cat collectibles and community illustration rather than a digital-parasite mechanism.';
  const footerText = 'About Press Copyright Contact us Creators Advertise Developers Terms Privacy Policy.';
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
        { url: unrelatedUrl, title: 'Lunar Cat pink-eyed feline art project', snippet: 'A Solana art project centered on illustrated pink-eyed cats and collectible artwork.' },
      ] };
      if (query.includes(`"${target.address}"`)) return { results: [{ url: targetUrl }] };
      if (query.includes('Lunar Cat')) return { results: [
        { url: unrelatedEvidenceUrl, title: 'Lunar Cat is a feline art collective', snippet: 'A Solana art project centered on pink-eyed cat collectibles, not a digital-parasite mechanism.' },
        { url: footerUrl, title: 'YouTube About', snippet: 'About Press Copyright Contact us Creators Advertise Developers Terms Privacy Policy' },
      ] };
      return { results: [{
        url: alternateUrl, title: 'AVAAI exact contract project page',
        snippet: 'This page connects the indexed AVAAI digital-parasite project to its deployed contract.',
      }] };
    },
    fetchValue: (urls: string[]) => urls.some(url => url === failedUrl || url === unrelatedUrl)
      ? {
        results: urls.filter(url => url === targetUrl).map(url => ({ url, final_url: url, text: targetText })),
        errors: urls.filter(url => url === failedUrl || url === unrelatedUrl).map(url => ({ url, status: 404, error: 'not_found' })),
      }
      : { results: urls.map((url: string) => ({ url, final_url: url,
        text: url === alternateUrl ? alternateText : url === unrelatedEvidenceUrl ? unrelatedEvidenceText : url === footerUrl ? footerText : 'A retained public project page.' })), errors: [] },
    attentionResponse: packet => {
      const attentionCall = ++attentionModelCalls;
      clockMs += 61_000;
      const typed = packet as AttentionPacket;
      const scope = packet.scope as Record<string, unknown> | undefined;
      const freshResponse = freshComparisonResponse(packet, target);
      if (freshResponse) return freshResponse;
      if (packet.manifest) {
        const leadScopeReviews = publicLeadScopeReviews(packet);
        return attentionEnvelope({
          ...(packet.supportProposal ? { supportReview: { accepted: true, rationale: 'The final review checks the scoped public-support proposal and its exact source citations.' } } : {}),
          ...(leadScopeReviews ? { leadScopeReviews } : {}),
          decisions: Object.fromEntries((packet.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The chain-qualified contracts remain bound to reviewed source observations.',
          }])),
          candidateSet: { complete: true, rationale: 'The target and every positively recovered representation are present in the reviewed merge.' },
        });
      }
      if (Array.isArray(packet.requiredLeadIds) && Array.isArray(packet.requiredSourceIds) && Array.isArray(packet.requiredBatchIds)) {
        const catalog = packet.sources as Array<{ sourceId: string; spans: Array<{ id: string; text: string }> }>;
        const cited = catalog.flatMap(source => source.spans.map(span => ({ sourceId: source.sourceId, ...span })))[0];
        assert.ok(cited, 'the global grade can cite one exact retained source span');
        return attentionEnvelope({ verdict: 'UNRESOLVED', rationale: 'This fixture does not assert a complete public-support deficiency.',
          citations: [{ sourceId: cited.sourceId, spanId: cited.id },], ...comparisonGradeIdFields(packet),
          ...((packet.leadQualification as { supportScopeMethod?: string } | undefined)?.supportScopeMethod === 'comparison-lead-support-scope-v2'
            ? { leadScopes: publicLeadScopes(packet) } : {}) });
      }
      if (typeof scope?.batch === 'number') {
        if (packet.proposal) {
          const comparisonReview = comparisonReviewFields(packet);
          const sourceDecisions = comparisonReview.sourceDecisions as Record<string, { disposition: string; insufficiencyKind: string; rationale: string }>;
          for (const source of typed.sources) {
            if (source.spans.some(span => span.text.includes('About Press Copyright'))) {
              sourceDecisions[source.id] = {
                disposition: 'INSUFFICIENT', insufficiencyKind: 'NO_SUBSTANTIVE_CONTENT',
                rationale: 'The retained YouTube footer contains no substantive project evidence.',
              };
            } else if (source.spans.some(span => span.text.includes('pink-eyed cat collectibles'))) {
              sourceDecisions[source.id] = {
                disposition: 'CONTEXT', insufficiencyKind: 'NONE',
                rationale: 'This retained page positively describes the independently indexed feline art subject.',
              };
            }
          }
          const supportDecisions = comparisonReview.supportDecisions as Record<string, { accepted: boolean; rationale: string }>;
          for (const source of typed.sources) {
            if (source.spans.some(span => span.text.includes('About Press Copyright'))) {
              comparisonReview.sourceDecisions[source.id] = {
                disposition: 'INSUFFICIENT', insufficiencyKind: 'NO_SUBSTANTIVE_CONTENT', inspectionComplete: true,
                rationale: 'The retained YouTube footer contains no substantive project evidence.',
              };
              supportDecisions[source.id] = { accepted: true, rationale: 'The full footer is correctly treated as non-substantive context.' };
            } else if (source.spans.some(span => span.text.includes('pink-eyed cat collectibles'))) {
              comparisonReview.sourceDecisions[source.id] = {
                disposition: 'CONTEXT', insufficiencyKind: 'NONE', inspectionComplete: true,
                rationale: 'This retained page positively describes a distinct indexed feline art subject.',
              };
              supportDecisions[source.id] = { accepted: true, rationale: 'The independent review accepts this unrelated context classification.' };
            } else if (!source.spans.some(span => span.text.includes(target.address) && span.text.includes('River Lantern'))) {
              comparisonReview.sourceDecisions[source.id] = {
                disposition: 'CONTEXT', insufficiencyKind: 'NONE', inspectionComplete: true,
                rationale: 'This full source describes a different indexed project, so it is audited as context rather than a target representation.',
              };
              supportDecisions[source.id] = { accepted: true, rationale: 'The independent review accepts this distinct-project context classification.' };
            }
          }
          return attentionEnvelope({
          decisions: Object.fromEntries((packet.requiredDecisionIds as string[]).map(id => [id, {
            accepted: true, rationale: 'The exact source span supports this reviewed comparison item.',
          }])),
          candidateSet: { complete: true, rationale: 'Every relevant exact-contract observation in the retained batch is included.' },
          ...comparisonReview,
          });
        }
        const competitors = [] as Array<{ id: string; observationId: string }>;
        if (typed.sources.some(source => source.spans.some(span => span.text.includes(target.address)))) {
          const sourceId = attentionSourceId(packet, target.address);
          competitors.push({ id: 'target-recovered-review', observationId: attentionObservationId(packet, target, sourceId) });
        }
        const leadScope = scope.leadQualification as { leads?: Array<{ id?: string; leadId?: string; sourceIds?: string[]; recoverySourceIds?: string[] }> } | undefined;
        const sourceSupport = Object.fromEntries(typed.sources.map(source => {
          const targetSpan = source.spans.find(span => span.text.includes(target.address) && span.text.includes('River Lantern'));
          const leadIds = (leadScope?.leads ?? []).filter(lead => [...(lead.sourceIds ?? []), ...(lead.recoverySourceIds ?? [])].includes(source.id))
            .map(lead => lead.id ?? lead.leadId).filter((id): id is string => typeof id === 'string');
          return [source.id, targetSpan
            ? { status: 'BINDING_EVIDENCE', rationale: 'This retained page connects the River Lantern narrative with its literal token.', citations: [{ sourceId: source.id, spanId: targetSpan.id }], leadIds }
            : { status: 'CONTEXT_ONLY', rationale: 'This retained page documents a distinct indexed subject or non-narrative context.', citations: [], leadIds }];
        }));
        return attentionEnvelope({ competitors, posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => {
          const span = attentionSpanId(packet, id, target.address);
          return [id, { spanId: span, role: 'NEWS' }];
        })), sourceSupport });
      }
      if (packet.selectedLeadIds) {
        const selected = packet.leads as Array<{ id: string; metadataEvidenceId: string }>;
        const metadata = packet.metadata as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
        return attentionEnvelope({ leads: Object.fromEntries(selected.map(lead => {
          const source = metadata.find(item => item.id === lead.metadataEvidenceId);
          assert.ok(source, `V2 recovery plan includes own descriptor ${lead.metadataEvidenceId}`);
          const descriptorTerm = lead.id === 'comparison-lead-3' ? 'pink-eyed feline art' : 'digital parasite';
          const descriptor = source.spans.find(span => span.text.includes(descriptorTerm));
          assert.ok(descriptor, `V2 recovery plan receives the ${lead.id} lead descriptor`);
          const isUnrelated = lead.id === 'comparison-lead-3';
          return [lead.id, {
            queries: [isUnrelated
              ? 'Find Lunar Cat pink-eyed feline art subject and its distinctive Solana project description'
              : 'Find AVAAI digital parasite project original sources and exact contract on Solana'],
            rationale: isUnrelated
              ? 'Find an independent descriptive source for the indexed Lunar Cat art subject.'
              : 'Find independent sources identifying the indexed AVAAI mechanism and its contract.',
            metadataRefs: [{ sourceId: lead.metadataEvidenceId, spanId: descriptor.id }],
          }];
        })) });
      }
      if (scope?.mode === 'qualified-identified-leads-v3' && packet.proposal) {
        const proposed = packet.proposal as { decisions: Record<string, unknown> };
        return attentionEnvelope({ decisions: Object.keys(proposed.decisions).map(leadId => ({ leadId,
          accounting: { accepted: true, rationale: 'The review checks each original indexed entity and acquisition outcome.' },
          representation: { accepted: true, rationale: 'The proposed binding or unrelated subject is supported by its own cited evidence.' },
          subjectComparison: { accepted: true, rationale: 'An unread original stays unresolved while recovered subject evidence is reviewed separately.' },
          evidenceAdequacy: { accepted: true, rationale: 'No failed fetch is used as a negative factual adequacy finding.' },
        })) });
      }
      if (scope?.mode === 'qualified-identified-leads-v3') {
        const leads = packet.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[]; recoverySourceIds: string[]; acquisitionStatus: string }>;
        const decisions = leads.map(lead => {
          const descriptor = { sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId) };
          const original = typed.sources.find(source => lead.sourceIds.includes(source.id));
          const originalSpan = original?.spans.find(span => span.text.includes(lead.id === 'comparison-lead-3' ? 'pink-eyed' : 'project'));
          if (lead.id === 'comparison-lead-1' && original && originalSpan) {
            const fetched = { sourceId: original.id, spanId: originalSpan.id };
            return { leadId: lead.id,
              accounting: { status: 'ACCOUNTED', basis: 'ORIGINAL_TEXT', role: 'PROJECT_OR_PUBLICATION',
                rationale: 'The original target project page was fetched and its own indexed entity is retained.', descriptorRefs: [descriptor], corroboratingRefs: [fetched] },
              representation: { status: 'BOUND', unresolvedKind: 'NONE', token: target, rationale: 'The original target page binds its literal mint to the River Lantern neighborhood project.', citations: [fetched] },
              subjectComparison: { status: 'CONSISTENT', indexedSubject: 'River Lantern exact target project', currentSubject: 'River Lantern exact target project',
                rationale: 'The original indexed descriptor and fetched target page describe the same subject.', descriptorRefs: [descriptor], fetchedRefs: [fetched] },
              evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'The target page does not establish a factual public-support deficiency.', citations: [descriptor] },
            };
          }
          if (lead.id === 'comparison-lead-2') {
            const recovered = typed.sources.find(source => source.url === alternateUrl && lead.recoverySourceIds.includes(source.id));
            assert.ok(recovered, 'the AVAAI proof is an actually fetched source in this lead recovery lineage');
            const fetched = { sourceId: recovered.id, spanId: attentionSpanId(packet, recovered.id, alternate.address) };
            return { leadId: lead.id,
              accounting: { status: 'ACCOUNTED', basis: 'RECOVERED_ENTITY', role: 'PROJECT_OR_PUBLICATION',
                rationale: 'The indexed AVAAI subject is positively identified by its own different-host recovered project description.',
                descriptorRefs: [descriptor], corroboratingRefs: [fetched] },
              representation: { status: 'UNRELATED', unresolvedKind: 'NONE', token: null,
                rationale: 'The recovered digital-parasite project is distinct from the target neighborhood-art narrative.', citations: [descriptor, fetched] },
              subjectComparison: { status: 'UNRESOLVED', indexedSubject: 'AVAAI digital-parasite project', currentSubject: null,
                rationale: 'The failed original page remains unread; recovery identifies the indexed entity without replacing its original body.', descriptorRefs: [descriptor], fetchedRefs: [] },
              evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'The failed original page does not establish a factual public-support deficiency.', citations: [descriptor] },
            };
          }
          const independent = typed.sources.find(source => source.url === unrelatedEvidenceUrl && lead.recoverySourceIds.includes(source.id));
          assert.ok(independent, 'the different-host Lunar Cat description is retained in its own lead recovery lineage');
          const fetched = { sourceId: independent.id, spanId: attentionSpanId(packet, independent.id, 'pink-eyed cat collectibles') };
          const indexed = { sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId, 'pink-eyed feline art') };
          return { leadId: lead.id,
            accounting: { status: 'ACCOUNTED', basis: 'RECOVERED_ENTITY', role: 'PROJECT_OR_PUBLICATION',
              rationale: 'The lead-specific different-host description corroborates this indexed feline-art entity.', descriptorRefs: [indexed], corroboratingRefs: [fetched] },
            representation: { status: 'UNRELATED', unresolvedKind: 'NONE', token: null,
              rationale: 'The positively described feline-art project is distinct from the neighborhood target narrative.', citations: [indexed, fetched] },
            subjectComparison: { status: 'UNRESOLVED', indexedSubject: 'Lunar Cat pink-eyed feline art project', currentSubject: null,
              rationale: 'The original indexed page was not fetched; the corroborating recovery does not replace its body.', descriptorRefs: [indexed], fetchedRefs: [] },
            evidenceAdequacy: { verdict: 'UNRESOLVED', rationale: 'An unread original page does not establish a factual adequacy mismatch.', citations: [indexed] },
          };
        });
        return attentionEnvelope({ decisions });
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
      tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true, now: fakeNow,
    }));
    const original = JSON.parse(bundle.rawArtifacts['attention-acquisition-scope']!) as {
      comparisonComplete: boolean; comparisonAcquisition: { originalComplete: boolean; leads: Array<{ id: string; acquisitionStatus: string }> };
    };
    const effective = (JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as { read: {
      entryExecutionMethod?: string; comparisonComplete?: boolean; comparisonQualification?: unknown;
      comparisonAcquisition: { originalComplete: boolean; leads: Array<{ id: string; acquisitionStatus: string; recoveryQueryIds: string[]; recoverySourceIds: string[] }> };
      comparisonRecovery?: { method: string; selectedLeadIds: string[];
        recoveryQueries: Array<{ queryId: string; parentLeadId: string; state: string; descriptorComplete: boolean }>;
        sourceLineage: Array<{ leadId: string; queryIds: string[]; sourceIds: string[] }> };
    } }).read;
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
    const finalGenesisRequestIndex = mock.calls.map((call, index) => ({ call, index })).filter(({ call }) => {
      if (!call.url.startsWith('https://rpc.example/') && !call.url.startsWith('https://api.mainnet.solana.com')) return false;
      return JSON.parse(String(call.init?.body)).method === 'getGenesisHash';
    }).at(-1)?.index ?? -1;

    assert.equal(bundle.analysisKind, 'LIVE');
    assert.equal(original.comparisonComplete, false);
    assert.equal(original.comparisonAcquisition.originalComplete, false);
    assert.equal(original.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-2')?.acquisitionStatus, 'FAILED');
    assert.equal(original.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-3')?.acquisitionStatus, 'FAILED');
    assert.equal(effective.entryExecutionMethod, 'entry-first-v2');
    assert.equal(effective.comparisonComplete, false);
    assert.equal(effective.comparisonQualification, undefined,
      'recovery acquisition is not full factual comparison qualification');
    assert.equal(effective.comparisonRecovery?.method, 'comparison-acquisition-v1');
    assert.ok(effective.comparisonRecovery?.selectedLeadIds.includes('comparison-lead-2'));
    assert.ok(effective.comparisonRecovery?.selectedLeadIds.includes('comparison-lead-3'));
    assert.equal(effective.comparisonAcquisition.originalComplete, false, 'effective qualification preserves the failed original acquisition state');
    assert.equal(effective.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-2')?.acquisitionStatus, 'FAILED');
    assert.equal(effective.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-3')?.acquisitionStatus, 'FAILED');
    for (const leadId of ['comparison-lead-2', 'comparison-lead-3']) {
      const lead = effective.comparisonAcquisition.leads.find(item => item.id === leadId)!;
      const queries = effective.comparisonRecovery?.recoveryQueries.filter(item => item.parentLeadId === leadId) ?? [];
      const lineage: { leadId: string; queryIds: string[]; sourceIds: string[] } | undefined =
        effective.comparisonRecovery?.sourceLineage.find(item => item.leadId === leadId);
      assert.ok(queries.length > 0 && queries.every(query => query.state === 'OBSERVED' && query.descriptorComplete),
        `${leadId} has a complete owned recovery Search receipt`);
      assert.ok(lead.recoveryQueryIds.length > 0 && lead.recoverySourceIds.length > 0,
        `${leadId} retains its own recovery query and fetched sources without upgrading the original failure`);
      assert.deepEqual(lineage?.queryIds, lead.recoveryQueryIds);
      assert.deepEqual(lineage?.sourceIds, lead.recoverySourceIds);
    }
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
    const retainedFooterId = Object.entries(bundle.rawArtifacts).find(([, raw]) => raw === footerText)?.[0];
    assert.ok(retainedFooterId, 'the actual fetched footer is retained as a source artifact');
    const sharedProof = JSON.parse(bundle.rawArtifacts['shared-derivation']!) as { sources: Array<{ id: string; text: string }> };
    assert.ok(sharedProof.sources.some(source => source.id === retainedFooterId && source.text.includes(footerText)),
      'the fetched footer remains in the Shared source audit without creating a comparison grade');
    assert.equal(bundle.rawArtifacts['attention-entry-first-acquisition'], JSON.stringify(effective.comparisonRecovery));
    assert.equal(bundle.rawArtifacts['attention-comparison-coverage'], undefined);
    const receipt = JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as {
      review: { entryDecisions?: { method: string; originTraceability: { verdict: string }; leadership: { verdict: string };
        representations: { verdict: string }; explainableThesis?: { verdict: string } } };
    };
    assert.deepEqual(receipt.review.entryDecisions && [receipt.review.entryDecisions.method,
      receipt.review.entryDecisions.originTraceability.verdict, receipt.review.entryDecisions.leadership.verdict,
      receipt.review.entryDecisions.representations.verdict, receipt.review.entryDecisions.explainableThesis?.verdict],
    ['binary-public-support-v4', 'FAIL', 'FAIL', 'FAIL', 'FAIL']);
    assert.deepEqual(replayed, snapshot, 'the temporary proof database reopens the live snapshot unchanged');
    assert.equal(capture.method, 'late-state-capture-v1');
    assert.equal(capture.discoveryId, 'dex-discovery');
    assert.ok(Date.parse(capture.startedAt) - Date.parse(discovery.retrievedAt) > 300_000,
      'the discovery quote is older than the state TTL after bounded semantic work');
    assert.equal(capture.rpcState, 'OBSERVED');
    assert.equal(capture.dexState, 'OBSERVED');
    assert.equal(dexCalls.length, 2, 'discovery and final canonical DEX reads are retained as separate requests');
    assert.ok(geminiCallIndexes.length > 0);
    assert.ok(Math.max(...geminiCallIndexes) < finalGenesisRequestIndex,
      'the final canonical RPC refresh follows attention, social, and Shared semantic work after the discovery-only preflight');
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

    type FreshAcquisitionReceipt = {
      read: {
        comparisonAcquisition: { leads: Array<{ id: string; sourceIds: string[]; recoverySourceIds: string[] }> };
        comparisonRecovery: { sourceLineage: Array<{ leadId: string; queryIds: string[]; sourceIds: string[] }> };
        sources: Array<{ id: string }>;
      };
    };
    const rejectRehashedReceipt = (name: string, mutate: (receipt: FreshAcquisitionReceipt) => void,
      expected: RegExp = /SHARED_(?:PROOF|SOURCE)_(?:INVALID|REQUIRED)/) => {
      const forged = structuredClone(bundle);
      const receiptRecord = forged.evidence.find(item => item.id === 'attention-qualified-receipt');
      assert.ok(receiptRecord);
      const receipt = JSON.parse(forged.rawArtifacts[receiptRecord.id]!) as FreshAcquisitionReceipt;
      mutate(receipt);
      forged.rawArtifacts[receiptRecord.id] = JSON.stringify(receipt);
      for (const evidence of forged.evidence) {
        const raw = forged.rawArtifacts[evidence.id];
        if (raw !== undefined) evidence.contentHash = sha256(raw);
      }
      const sharedRecord = forged.evidence.find(item => item.id === 'shared-derivation')!;
      const shared = JSON.parse(forged.rawArtifacts[sharedRecord.id]!) as { evidence: typeof forged.evidence };
      shared.evidence = forged.evidence.filter(item => item.id !== sharedRecord.id);
      forged.rawArtifacts[sharedRecord.id] = JSON.stringify(shared);
      sharedRecord.contentHash = sha256(forged.rawArtifacts[sharedRecord.id]!);
      const receiptVerifier = new Service(join(directory, `${name}.sqlite`));
      try {
        assert.throws(() => receiptVerifier.analyzeLive(forged), expected, name);
      } finally {
        receiptVerifier.close();
      }
    };
    rejectRehashedReceipt('locally-forged-recovery-parent-lineage', receipt => {
      receipt.read.comparisonAcquisition.leads.find(item => item.id === 'comparison-lead-3')!.recoverySourceIds = [];
    });
    rejectRehashedReceipt('locally-forged-recovery-source-lineage', receipt => {
      receipt.read.comparisonRecovery.sourceLineage.find(item => item.leadId === 'comparison-lead-3')!.sourceIds = [];
    });
    rejectRehashedReceipt('locally-deleted-original-entry-source', receipt => {
      receipt.read.sources = receipt.read.sources.filter(source => source.id !== 'attention-page-1');
    }, /SOCIAL_SEED_PROOF_INVALID/);
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

test('fresh task-v5/v6 Service proof accepts reordered provider keys, replays, and rejects rehashed semantic tampering', async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const marketUrl = 'https://dexscreener.com/base/river-lantern-usdc-pair';
  const dexSupplementUrl = `https://api.dexscreener.com/token-pairs/v1/${target.chain}/${target.address}`;
  const dexSupplementText = JSON.stringify([{ chainId: target.chain,
    baseToken: { address: target.address }, quoteToken: { address: '0x3333333333333333333333333333333333333333' } }]);
  const wrappedMarketUrl = `/url?opi=79508299&q=${encodeURIComponent(marketUrl)}&sa=U&ved=2ahUKEwi-test&usg=AOvVaw-public`;
  const recoveredMarketUrl = 'https://index.example/river-lantern-market-record';
  const alternateRecoveredMarketUrl = 'https://alternate.example/river-lantern-market-record';
  const blockedRecoveryUrls = [recoveredMarketUrl, ...Array.from({ length: 7 }, (_, index) =>
    `https://blocked-recovery-${index + 1}.example/river-lantern-market-record`)];
  const targetUrl = 'https://public.example/river-lantern-project';
  const roleGapUrl = 'https://market.example/river-lantern-origin-index';
  const roleAlternateUrl = 'https://independent.example/river-lantern-origin-record';
  const postUrls = [
    'https://x.com/first_writer/status/7101',
    'https://x.com/second_writer/status/7102',
  ];
  const postText = new Map(postUrls.map((url, index) => [url, `Unrelated gardening note ${index + 1}; this post does not discuss a token or project.`]));
  const title = 'River Lantern / USDC pair on DexScreener';
  const snippet = 'DexScreener lists a River Lantern market pair on Base with pair and liquidity data only, without project narrative or origin context.';
  const marketText = `Token ${target.address}. A market index lists a River Lantern pair and trading data only; it contains no project narrative or origin description.`;
  const targetText = `Token ${target.address}. River Lantern token metadata lists a deployment index and a Base contract. No project description, narrative, mechanism, or explanation is provided.`;
  const roleRecoveryTargetText = `The River Lantern project launched a neighborhood arts collective to fund public murals. The project uses exact contract ${target.address} for community puzzle rewards connected to those murals.`;
  const roleAlternateText = `An independent River Lantern market index lists token ${target.address} and public pair records.`;
  let recoverViaAlternate = false;
  let timeoutOriginalMarket = false;
  let omitRecoveredMarket = false;
  let omittedRecoveredFetches = 0;
  let ownRoleRecovery = false;
  let timeoutOriginalRole = false;
  let originRoleFetchStatus: number | undefined;
  const mock = mockedFetch({
    dexValue: [pair(0, { chainId: 'base', baseToken: { address: target.address, name: 'River Lantern' }, quoteToken: { address: '0x3333333333333333333333333333333333333333' } })],
    searchValue: (requestUrl, call) => {
      const query = new URL(requestUrl).searchParams.get('query') ?? '';
      if (ownRoleRecovery && query.includes('origin project launch announcement')) return { results: [{
        url: roleAlternateUrl,
        title: 'River Lantern independent market index',
        snippet: 'An independent market index lists this token with public pair records only.',
      }] };
      if (call === 0) return { results: [
        { url: targetUrl, title: 'River Lantern project', snippet: ownRoleRecovery
          ? `The neighborhood arts collective uses exact contract ${target.address} for public mural rewards.`
          : `Token ${target.address}` },
        ...(ownRoleRecovery ? [
          { url: roleGapUrl, title: 'River Lantern market index', snippet: 'A market index provides trading pair listings only, not a project launch or origin source.' },
          { url: roleAlternateUrl, title: 'River Lantern independent market index', snippet: 'An independent market index lists this token with public pair records only.' },
        ] : []),
        ...postUrls.map(url => ({ url, title: 'Unrelated gardening note', snippet: 'A general gardening update.' })),
      ] };
      if (call === 2) return { results: [{ url: wrappedMarketUrl, title, snippet }] };
      if (call > 2 && query.includes('indexed project independent public sources')) return {
        results: recoverViaAlternate ? [...blockedRecoveryUrls.map(url => ({ url,
          title: 'River Lantern blocked market index record', snippet: 'An independent index repeats pair and liquidity details without project narrative.' })), {
          url: alternateRecoveredMarketUrl,
          title: 'River Lantern alternate market index record', snippet: 'An independent index repeats pair and liquidity details without project narrative.' }]
          : [{ url: recoveredMarketUrl, title: 'River Lantern market index record', snippet: 'The index repeats pair and liquidity details without project narrative.' }],
      };
      return { results: [] };
    },
    fetchValue: (urls: string[]) => {
      if (omitRecoveredMarket && urls.includes(recoveredMarketUrl)) omittedRecoveredFetches++;
      const blockedFallbackBatch = recoverViaAlternate ? urls.filter(url => blockedRecoveryUrls.includes(url)) : [];
      return {
      results: urls.filter(url => url !== marketUrl && !(timeoutOriginalRole && url === roleGapUrl)
        && !blockedFallbackBatch.includes(url) && !(omitRecoveredMarket && url === recoveredMarketUrl)).map(url => ({
        url, final_url: url,
        text: url === dexSupplementUrl ? dexSupplementText
          : url === recoveredMarketUrl || url === alternateRecoveredMarketUrl ? marketText
            : url === roleAlternateUrl ? roleAlternateText
          : postText.get(url) ?? (ownRoleRecovery && url === targetUrl ? roleRecoveryTargetText : targetText),
        ...(postText.has(url) ? { published_date: '2026-09-29T11:00:00.000Z' } : {}),
      })),
      errors: [...(urls.includes(marketUrl) ? [timeoutOriginalMarket
        ? { url: marketUrl, error: 'timeout' }
        : { url: marketUrl, status: 404, error: 'not_found' }] : []),
        ...(urls.includes(roleGapUrl) && timeoutOriginalRole ? [{ url: roleGapUrl, error: 'timeout' }] : []),
        ...blockedFallbackBatch.map(url => ({ url, status: 404, error: 'not_found' }))],
      };
    },
    attentionResponse: packet => {
      if (isSocialModelPacket(packet)) return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'This fixture leaves optional social judgments unresolved.' } });
      const rolePacket = packet as {
        url?: string;
        context?: Array<{ id: string; spans: Array<{ id: string }> }>;
        corroboration?: Array<{ id: string; spans: Array<{ id: string }> }>;
      };
      if (ownRoleRecovery && rolePacket.url === roleGapUrl && rolePacket.context?.length && rolePacket.corroboration?.length) {
        if ('proposal' in packet) return attentionEnvelope({ accepted: true,
          rationale: 'The independent role review verifies the market-only classification against the retained sources.' });
        return attentionEnvelope({
          role: 'MARKET_ONLY',
          rationale: 'The indexed description and independent fetched page identify a market listing with no launch role.',
          contextSpanIds: [rolePacket.context[0]!.spans[0]!.id],
          corroborationSpanIds: [rolePacket.corroboration[0]!.spans[0]!.id],
        });
      }
      const scope = packet.scope as { mode?: string; batch?: number; meaning?: string; leadQualification?: { leads?: Array<{ id?: string; leadId?: string; sourceIds?: string[]; recoverySourceIds?: string[] }> } } | undefined;
      const typed = packet as AttentionPacket;
      if ('originalProposal' in packet) {
        const sources = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
        const cited = sources.flatMap(source => source.spans.map(span => ({ source, span })))
          .find(({ span }) => span.text.includes(target.address));
        assert.ok(cited, 'the complete retained origin scope contains an own exact-token metadata span');
        if ('proposal' in packet) return attentionEnvelope({
          sourceDecisions: Object.fromEntries(sources.map(source => [source.id, {
            accepted: true, rationale: 'The independent pass inspected every retained original source span.', inspectionComplete: true,
          }])),
          decisions: Object.fromEntries(['NARRATIVE_DESCRIPTION', 'EXPLAINABLE_THESIS'].map(criterion => [criterion, {
            accepted: true, rationale: ownRoleRecovery
              ? 'The reviewed exact-token project source supports a bounded narrative, so this pass makes no inadequacy finding.'
              : `The full scope supports the bounded ${criterion} public-support gap.`,
          }])),
        });
        return attentionEnvelope({
          sourceSupport: Object.fromEntries(sources.map(source => {
            const own = source.spans.find(span => span.text.includes(target.address));
            const narrative = ownRoleRecovery && source.spans.find(span => span.text.includes(target.address)
              && /neighborhood arts collective|public murals/i.test(span.text));
            if (narrative) return [source.id, { status: 'SUBSTANTIVE_SUPPORT', criteria: ['NARRATIVE_DESCRIPTION', 'EXPLAINABLE_THESIS'],
              rationale: 'The full source grounds the neighborhood arts narrative and its relation to the exact target contract.',
              citations: [{ sourceId: source.id, spanId: narrative.id }] }];
            return [source.id, own
              ? { status: 'PUBLIC_SUPPORT_GAP', criteria: ['NARRATIVE_DESCRIPTION', 'EXPLAINABLE_THESIS'],
                rationale: 'This exact-token metadata identifies deployment but supplies no project narrative or explanation.',
                citations: [{ sourceId: source.id, spanId: own.id }] }
              : { status: 'CONTEXT_ONLY', criteria: [], rationale: 'This original source is contextual and does not provide a token-bound narrative.', citations: [] }];
          })),
          judgments: Object.fromEntries(['NARRATIVE_DESCRIPTION', 'EXPLAINABLE_THESIS'].map(criterion => [criterion, {
            verdict: ownRoleRecovery ? 'UNRESOLVED' : 'INADEQUATE', rationale: ownRoleRecovery
              ? `The exact-token narrative source is retained, so this review does not find ${criterion} inadequate.`
              : `The complete reviewed scope does not establish ${criterion}.`,
            citations: [{ sourceId: cited.source.id, spanId: cited.span.id }],
          }])),
        });
      }
      if ((packet.method === 'binary-public-support-v2' || packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4') && Array.isArray(packet.sources)) {
        assert.equal(omitRecoveredMarket, false, 'the binary entry reviewer must not run for an unfinished selected recovery');
        const sources = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
        const originIds = (packet.scope as { originSourceIds: string[] }).originSourceIds;
        const origin = sources.flatMap(source => source.spans.map(span => ({ source, span })))
          .find(({ source, span }) => originIds.includes(source.id) && span.text.includes(target.address));
        const comparison = sources.flatMap(source => source.spans.map(span => ({ source, span })))[0];
        assert.ok(origin, 'the current binary entry packet cites a literal exact-token original source');
        assert.ok(comparison, 'the full retained catalog provides a comparison citation');
        const explanationIds = packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4' ? packet.explainableCitationSourceIds as string[] : [];
        const explainable = sources.flatMap(source => source.spans.map(span => ({ source, span })))
          .find(({ source, span }) => explanationIds.includes(source.id) && span.text.includes(target.address));
        if (packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4') assert.ok(explainable, 'the fresh thesis review cites a narrative-bound exact-token source');
        const final = Object.hasOwn(packet, 'draft');
        const grade = (verdict: 'PASS' | 'FAIL', sourceId: string, spanId: string, rationale: string) => ({
          verdict, rationale, citation: { sourceId, spanId },
        });
        return attentionEnvelope({
          originTraceability: grade(final ? 'FAIL' : 'PASS', origin.source.id, origin.span.id, final
            ? 'The retained token index provides deployment identity but no source-grounded originating project or catalyst relationship.'
            : 'The original source is proposed as sufficient for an origin-traceability judgment.'),
          leadership: { ...grade(packet.method === 'binary-public-support-v4' || final ? 'FAIL' : 'PASS', comparison.source.id, comparison.span.id, final
            ? 'The collected record supplies neither relative explicit-token mention counts nor a documented primary-origin relationship.'
            : 'The retained source is proposed as sufficient for a leadership judgment.'),
            ...(packet.method === 'binary-public-support-v4' ? { basis: 'EVIDENCE_INADEQUACY' } : {}) },
          representations: grade(final ? 'FAIL' : 'PASS', comparison.source.id, comparison.span.id, final
            ? 'The collected market record and incomplete candidate coverage do not identify or bind relevant competing representations.'
            : 'The retained source is proposed as sufficient for a representation-coverage judgment.'),
          ...(packet.method === 'binary-public-support-v3' || packet.method === 'binary-public-support-v4' ? { explainableThesis: grade(final ? 'FAIL' : 'PASS', explainable!.source.id, explainable!.span.id, final
            ? 'The retained evidence does not adequately explain the narrative interest and its relationship to the exact token.'
            : 'The retained source is proposed as sufficient for an ordinary-language thesis judgment.') } : {}),
          inspectionComplete: true,
        });
      }
      if (packet.method === 'binary-public-support-v1' && packet.originEvidenceScope && Array.isArray(packet.sources)) {
        const sources = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
        const sourceIds = sources.map(source => source.id);
        const codeOwnedOriginScope = typeof packet.instruction === 'string'
          && packet.instruction.includes('The originEvidenceScope source catalog is code-owned; do not repeat sourceIds.');
        const singleRequiredCitation = codeOwnedOriginScope && typeof packet.instruction === 'string'
          && packet.instruction.includes('MUST supply one citation object per criterion');
        const echoedScope = codeOwnedOriginScope ? {} : { sourceIds };
        const cited = sources.flatMap(source => source.spans.map(span => ({ sourceId: source.id, ...span })))
          .find(span => span.text.includes(target.address));
        assert.ok(cited, 'the binary entry pair receives a literal target span from the original origin scope');
        const decision = (verdict: 'PASS' | 'FAIL') => ({ verdict,
          rationale: 'The independent entry review decides this criterion separately using the complete bounded evidence.',
          citations: [{ sourceId: cited.sourceId, spanId: cited.id }] });
        if ('screening' in packet) {
          const finalDecision = (verdict: 'PASS' | 'FAIL') => {
            const value = decision(verdict);
            if (!singleRequiredCitation) return value;
            const { citations, ...grade } = value;
            return { ...grade, citation: citations[0] };
          };
          return attentionEnvelope({
            originTraceability: finalDecision('FAIL'), leadership: finalDecision('PASS'), inspectionComplete: true, ...echoedScope,
          });
        }
        return attentionEnvelope({
          originTraceability: { verdict: 'UNRESOLVED', rationale: 'The draft keeps factual uncertainty separate from the final entry judgment.', citations: [{ sourceId: cited.sourceId, spanId: cited.id }] },
          leadership: { verdict: 'UNRESOLVED', rationale: 'The draft does not stand in for the independent criterion judgments.', citations: [{ sourceId: cited.sourceId, spanId: cited.id }] },
          ...echoedScope,
        });
      }
      if (packet.originEvidenceScope && (packet.comparisonQualification as { wireMethod?: string } | undefined)?.wireMethod === 'comparison-lead-tasks-v5') {
        const sources = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
        const sourceIds = sources.map(source => source.id);
        const cited = sources.flatMap(source => source.spans.map(span => ({ sourceId: source.id, ...span })))
          .find(span => span.text.includes(target.address));
        assert.ok(cited, 'the independent public-origin pair receives a literal target span');
        const originTraceability = { verdict: 'INADEQUATE',
          rationale: 'The fully inspected original scope has no adequately supported primary-origin traceability.',
          citations: [{ sourceId: cited.sourceId, spanId: cited.id }] };
        const leadership = { verdict: 'UNRESOLVED',
          rationale: 'The same original scope does not establish a measured leadership result.',
          citations: [{ sourceId: cited.sourceId, spanId: cited.id }] };
        if ('screening' in packet) return attentionEnvelope({
          originTraceability: { accepted: true, rationale: 'The independent review checks origin traceability separately.' },
          leadership: { accepted: true, rationale: 'The independent review checks entry leadership separately.' },
          inspectionComplete: true, sourceIds,
        });
        return attentionEnvelope({ originTraceability, leadership, sourceIds });
      }
      if (packet.entryTask && packet.mergeTask) {
        const entryTask = packet.entryTask as { proposal: { leadRoles: Record<string, unknown>; sourceSupport: Record<string, unknown>; leadBlockers: Record<string, unknown> } };
        const proposal = entryTask.proposal;
        const mergeTask = packet.mergeTask as { candidates?: Array<{ id: string }>; manifest?: { qualificationMethod?: string } };
        const binaryEntryDecision = (mergeTask.manifest as { entryDecisionMethod?: string } | undefined)?.entryDecisionMethod === 'binary-public-support-v1';
        const entrySources = (entryTask as unknown as { sources?: Array<{ id: string; spans: Array<{ id: string }> }> }).sources ?? [];
        const entryCitation = entrySources.flatMap(source => source.spans.map(span => ({ sourceId: source.id, spanId: span.id }))).find(ref => ref.sourceId && ref.spanId);
        if (binaryEntryDecision) assert.ok(entryCitation, 'the binary final decision cites an actual supplied comparison-body span');
        const accepted = (rationale: string) => ({ accepted: true, rationale });
        return attentionEnvelope({
          ...(binaryEntryDecision ? { entryDecision: { verdict: 'FAIL',
            rationale: 'The independent final judgment finds the bounded comparison evidence insufficient for entry.', citations: [entryCitation!] } } : {}),
          entryReview: {
            leadRoles: Object.fromEntries(Object.keys(proposal.leadRoles).map(id => [id, accepted('The indexed market role matches its own descriptor and recovered source.')])),
            sourceSupport: Object.fromEntries(Object.keys(proposal.sourceSupport).map(id => [id, accepted('The source classification matches its complete retained body.')])),
            leadBlockers: Object.fromEntries(Object.keys(proposal.leadBlockers).map(id => [id, accepted('No semantic blocker is supported by the inspected evidence.')])),
            grade: accepted('The independently reviewed public-support grade follows the required market-only evidence.'),
          },
          decisions: Object.fromEntries((mergeTask.candidates ?? []).map(candidate => [candidate.id, accepted('The merge selection is checked against the literal source evidence.')])) ,
          candidateSet: { complete: false, rationale: 'The acquired comparison sample does not establish complete representation coverage.' },
        });
      }
      if (Array.isArray(packet.operands)) {
        const operands = packet.operands as Array<{ leadId: string; indexedDescriptorId: string; originalBodyIds: string[] }>;
        const sources = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
        if (packet.proposal) {
          const proposal = packet.proposal as { decisions: Record<string, unknown> };
          const accepted = { accepted: true, rationale: 'The independent review accepts only the factual axis actually supported by its cited source.' };
          return attentionEnvelope({ decisions: Object.fromEntries(Object.keys(proposal.decisions).map(id => [id, {
            accounting: accepted, representation: accepted, subjectComparison: accepted, evidenceAdequacy: accepted,
          }])) });
        }
        return attentionEnvelope({ decisions: Object.fromEntries(operands.map(operand => {
          const descriptor = sources.find(source => source.id === operand.indexedDescriptorId);
          assert.ok(descriptor?.spans[0], `the task packet contains ${operand.indexedDescriptorId}`);
          const descriptorRef = { sourceId: descriptor.id, spanId: descriptor.spans[0]!.id };
          const decision: Record<string, unknown> = {
            accounting: { status: 'UNRESOLVED', basis: 'NONE', role: 'MARKET_OR_INDEX_RECORD',
              rationale: 'The recovered market item supports public review but does not establish exact original-item identity.',
              descriptorRefs: [descriptorRef], corroboratingRefs: [] },
            representation: { status: 'UNRESOLVED',
              rationale: 'The separate public-support review does not establish a factual token relation.', citations: [descriptorRef] },
          };
          if (operand.originalBodyIds.length) {
            decision.subjectComparison = { status: 'UNRESOLVED', indexedSubject: 'The indexed market item', currentSubject: null,
              rationale: 'The original item body is not available for an identity comparison.', descriptorRefs: [descriptorRef], fetchedRefs: [] };
            decision.evidenceAdequacy = { verdict: 'UNRESOLVED', rationale: 'No factual adequacy conclusion is made about the unread original body.', citations: [descriptorRef] };
          }
          return [operand.leadId, decision];
        })) });
      }
      if (typeof scope?.batch === 'number' && scope.meaning === 'Every retained source span in this batch; original-record collection is outside this body-reading task.') {
        const sources = typed.sources as Array<(typeof typed.sources)[number] & { kind?: string }>;
        if (packet.proposal) {
          const requiredIds = packet.requiredDecisionIds as string[];
          const observations = packet.proposal as { bodyObservations: Record<string, unknown> };
          const exact = (packet.exactContractObservations as unknown[] | undefined)?.length ?? 0;
          const omitNoItemDecisions = String(packet.rowFormat ?? '').includes('There are no required item decisions. The decisions field does not exist');
          return attentionEnvelope({
            ...(omitNoItemDecisions ? {} : { decisions: Object.fromEntries(requiredIds.map(id => [id, { accepted: true, rationale: 'The full body decision is checked against the retained source.' }])) }),
            candidateSet: { complete: false, rationale: 'The sample does not establish exhaustive contract representation coverage.' },
            sourceDecisions: Object.fromEntries(sources.map(source => {
              const unknownAssociation = source.spans.some(span => span.text.includes('market index lists'));
              return [source.id, { disposition: unknownAssociation ? 'INSUFFICIENT' : 'CONTEXT',
                insufficiencyKind: unknownAssociation ? 'UNRESOLVED_MEANING_OR_ASSOCIATION' : 'NONE',
                rationale: 'The full body is readable as a market record, while its exact token association remains unresolved.', inspectionComplete: true }];
            })),
            bodyDecisions: Object.fromEntries(sources.map(source => [source.id, {
              bodyRole: { accepted: true, rationale: 'The source role matches its actual full text.' },
              description: { accepted: true, rationale: 'The body description matches its actual full text.' },
            }])),
            ...(exact ? { missingRepresentations: [] } : {}),
          });
        }
        const bodyObservations = Object.fromEntries(sources.map(source => {
          const first = source.spans[0];
          assert.ok(first, `the body request contains an inspectable span for ${source.id}`);
          const text = source.spans.map(span => span.text).join('\n');
          const market = /market index lists|market pair|pair and liquidity|trading data/i.test(text);
          const deploymentOnly = /deployment metadata lists the contract but provides no project description/i.test(text);
          const unrelatedPost = source.kind === 'POST' || /gardening note/i.test(text);
          return [source.id, {
            bodyRole: { kind: market ? 'MARKET_OR_INDEX_RECORD' : 'OTHER_CONTEXT', rationale: 'The actual retained source text establishes this role.', citations: [{ sourceId: source.id, spanId: first.id }] },
            description: { kind: market ? 'MARKET_FIELDS_OR_BOILERPLATE' : deploymentOnly ? 'NO_SUBSTANTIVE_CONTENT' : unrelatedPost ? 'DISTINCT_OTHER_SUBJECT' : 'NO_SUBSTANTIVE_CONTENT',
              rationale: 'The cited full body contains only the described support or contextual content.', citations: [{ sourceId: source.id, spanId: first.id }] },
          }];
        }));
        return attentionEnvelope({
          bodyObservations,
          competitors: [],
          posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => {
            const source = sources.find(item => item.id === id);
            assert.ok(source?.spans[0], `the body request contains an original POST span for ${id}`);
            return [id, { spanId: source.spans[0]!.id, role: 'OTHER' }];
          })),
        });
      }
      if (Array.isArray(packet.bodyObservations) && Array.isArray(packet.leadContexts) && Array.isArray(packet.sourceRequirements)) {
        const catalog = packet.sources as Array<{ id: string; spans: Array<{ id: string; text: string }> }>;
        const contexts = packet.leadContexts as Array<{ leadId: string; indexedMetadataSourceId: string; originalSourceIds: string[]; recoverySourceIds: string[] }>;
        const observations = packet.bodyObservations as Array<{ sourceId: string; bodyRole: { kind: string }; description: { kind: string } }>;
        const sourceRequirements = packet.sourceRequirements as Array<{ sourceId: string; obligation: string }>;
        const leadRoles = Object.fromEntries(contexts.map(context => {
          const descriptor = catalog.find(source => source.id === context.indexedMetadataSourceId);
          assert.ok(descriptor?.spans[0]);
          const ownIds = [...context.originalSourceIds, ...context.recoverySourceIds];
          const ownBody = catalog.find(source => ownIds.includes(source.id) && source.spans[0]);
          return [context.leadId, { role: 'MARKET_OR_INDEX_RECORD', rationale: 'The original indexed descriptor identifies a market listing.',
            descriptorRefs: [{ sourceId: descriptor.id, spanId: descriptor.spans[0]!.id }],
            ownContextRefs: ownBody?.spans[0] ? [{ sourceId: ownBody.id, spanId: ownBody.spans[0].id }] : [] }];
        }));
        const sourceSupport = Object.fromEntries(observations.map(observation => {
          const source = catalog.find(item => item.id === observation.sourceId);
          assert.ok(source?.spans[0]);
          const gap = observation.bodyRole.kind === 'MARKET_OR_INDEX_RECORD' && observation.description.kind === 'MARKET_FIELDS_OR_BOILERPLATE';
          const bindingMarket = gap && source.spans.some(span => span.text.includes(target.address));
          const binding = observation.description.kind === 'SPECIFIC_PROJECT_OR_MECHANISM';
          return [observation.sourceId, {
            status: bindingMarket ? 'BINDING_EVIDENCE' : gap ? 'PUBLIC_SUPPORT_GAP' : binding ? 'BINDING_EVIDENCE' : 'CONTEXT_ONLY',
            rationale: bindingMarket ? 'The retained market record names the target project and exact token while containing only market fields.'
              : gap ? 'The inspected market record supplies pair data without project or narrative support.'
              : binding ? 'The source supports a specific project or mechanism.' : 'The source is contextual and does not establish target representation.',
            citations: gap || binding ? [{ sourceId: source.id, spanId: source.spans[0]!.id }] : [], blockerProof: null,
          }];
        }));
        const gap = Object.entries(sourceSupport).find(([id, decision]) => decision.status === 'PUBLIC_SUPPORT_GAP'
          && sourceRequirements.some(requirement => requirement.sourceId === id && requirement.obligation === 'REQUIRED'));
        const bindingMarket = Object.entries(sourceSupport).find(([id, decision]) => decision.status === 'BINDING_EVIDENCE'
          && observations.some(observation => observation.sourceId === id && observation.bodyRole.kind === 'MARKET_OR_INDEX_RECORD'
            && observation.description.kind === 'MARKET_FIELDS_OR_BOILERPLATE')
          && sourceRequirements.some(requirement => requirement.sourceId === id && requirement.obligation === 'REQUIRED'));
        const witness = gap ?? bindingMarket;
        const citationSourceId = witness?.[0] ?? observations[0]?.sourceId;
        const citationSource = catalog.find(source => source.id === citationSourceId);
        assert.ok(citationSource?.spans[0]);
        return attentionEnvelope({ leadRoles: leadRoles,
          sourceSupport, leadBlockers: Object.fromEntries(contexts.map(context => [context.leadId, null])),
          grade: { verdict: witness ? 'INADEQUATE' : 'UNRESOLVED',
            rationale: witness ? 'The fully inspected own market body provides the reviewed inadequate-support witness.' : 'No independently reviewed positive support gap is established.',
            citations: [{ sourceId: citationSource.id, spanId: citationSource.spans[0]!.id }] },
        });
      }
      if (Array.isArray(packet.selectedLeadIds)) {
        const selected = packet.leads as Array<{ id: string; metadataEvidenceId: string }>;
        return attentionEnvelope({ leads: Object.fromEntries(selected.map(lead => {
          const descriptor = (packet.metadata as AttentionPacket['sources']).find(item => item.id === lead.metadataEvidenceId);
          assert.ok(descriptor, `the planner receives the original descriptor for ${lead.id}`);
          const span = descriptor.spans.find(item => item.text.includes('market pair'));
          assert.ok(span);
          return [lead.id, { queries: [`River Lantern indexed project independent public sources for ${lead.id}`],
            rationale: 'Check this indexed project with one bounded independent query.', metadataRefs: [{ sourceId: descriptor.id, spanId: span.id }] }];
        })) });
      }
      if (Array.isArray(packet.requiredLeadIds) && Array.isArray(packet.requiredSourceIds) && Array.isArray(packet.requiredBatchIds)) {
        const selected = (packet.sources as Array<{ sourceId: string; spans: Array<{ id: string; text: string }> }>).flatMap(item => item.spans.map(span => ({ ...span, sourceId: item.sourceId }))).find(span => span.text.includes('market index lists'));
        if (omitRecoveredMarket && !selected) {
          const available = (packet.sources as Array<{ sourceId: string; spans: Array<{ id: string }> }>).flatMap(item => item.spans.map(span => ({ ...span, sourceId: item.sourceId })))[0];
          assert.ok(available, 'the incomplete support proposal retains at least one honest source citation');
          return attentionEnvelope({ verdict: 'UNRESOLVED', rationale: 'The selected indexed recovery body was omitted after its bounded Fetch retry.',
            citations: [{ sourceId: available.sourceId, spanId: available.id }],
            ...comparisonGradeIdFields(packet),
            ...((packet.leadQualification as { supportScopeMethod?: string } | undefined)?.supportScopeMethod === 'comparison-lead-support-scope-v2'
              ? { leadScopes: publicLeadScopes(packet) } : {}) });
        }
        assert.ok(selected, 'the support proposal cites the successfully fetched own indexed market recovery');
        return attentionEnvelope({ verdict: 'INADEQUATE',
          rationale: 'The fully inspected indexed market recovery provides pair data but no project or narrative support in this bounded sample.',
          citations: [{ sourceId: selected.sourceId, spanId: selected.id }],
          ...comparisonGradeIdFields(packet),
          ...((packet.leadQualification as { supportScopeMethod?: string } | undefined)?.supportScopeMethod === 'comparison-lead-support-scope-v2'
            ? { leadScopes: publicLeadScopes(packet) } : {}) });
      }
      if (packet.supportProposal) return attentionEnvelope({
        decisions: Object.fromEntries(((packet.requiredDecisionIds ?? []) as string[]).map(id => [id, {
          accepted: true, rationale: 'Every merged exact-contract candidate is independently checked against the retained source text.',
        }])),
        supportReview: { accepted: true, rationale: 'The independent review accepts the cited gap after inspecting every required source and batch.' },
        ...(publicLeadScopeReviews(packet) ? { leadScopeReviews: publicLeadScopeReviews(packet) } : {}),
        candidateSet: { complete: false, rationale: 'The acquired comparison sample does not establish a complete representation set.' },
      });
      if (scope?.mode === 'qualified-identified-leads-v3' && packet.proposal) {
        const proposed = packet.proposal as { decisions: Record<string, unknown> };
        return attentionEnvelope({ decisions: Object.keys(proposed.decisions).map(id => ({ leadId: id,
          accounting: { accepted: true, rationale: 'The failed original market page remains factually unresolved after successful bounded own recovery.' },
          representation: { accepted: true, rationale: 'The indexed market record is correctly classified as inadequate public project support.' },
          subjectComparison: { accepted: true, rationale: 'The unread original market page is left unresolved rather than replaced by recovery text.' },
          evidenceAdequacy: { accepted: true, rationale: 'No factual adequacy claim is made about the unavailable original page.' },
        })) });
      }
      if (scope?.mode === 'qualified-identified-leads-v3') {
        const leads = packet.leads as Array<{ id: string; metadataEvidenceId: string; sourceIds: string[] }>;
        assert.equal(leads.length, 1, 'the collector fixture retains one original comparison lead');
        const lead = leads[0]!;
        const descriptor = { sourceId: lead.metadataEvidenceId, spanId: attentionMetadataSpanId(packet, lead.metadataEvidenceId, 'market pair') };
        return attentionEnvelope({ decisions: [{ leadId: lead.id,
          accounting: { status: 'UNRESOLVED', basis: 'NONE', role: 'MARKET_OR_INDEX_RECORD',
            rationale: 'The original market page failed and the indexed recovery does not settle its exact factual identity.', descriptorRefs: [descriptor], corroboratingRefs: [] },
          representation: { status: 'INADEQUATE', unresolvedKind: 'NONE', token: null,
            rationale: 'The indexed descriptor identifies market data but supplies no project or narrative support.', citations: [descriptor] },
          subjectComparison: { status: 'UNRESOLVED', indexedSubject: 'River Lantern market listing', currentSubject: null,
            rationale: 'The original market page was unavailable, so its body remains unknown.', descriptorRefs: [descriptor], fetchedRefs: [] },
          evidenceAdequacy: { verdict: 'UNRESOLVED',
            rationale: 'The unavailable original body cannot establish a factual adequacy mismatch.', citations: [descriptor] },
        }] });
      }
      if (typeof scope?.batch === 'number') {
        const sources = typed.sources;
        if (!packet.proposal) {
          const leadScope = scope.leadQualification?.leads ?? [];
          const sourceSupport = Object.fromEntries(sources.map(source => {
            const parentIds = leadScope.filter(lead => [...(lead.sourceIds ?? []), ...(lead.recoverySourceIds ?? [])].includes(source.id))
              .map(lead => lead.id ?? lead.leadId).filter((id): id is string => typeof id === 'string');
            const binding = source.spans.find(span => span.text.includes(target.address) && span.text.includes('River Lantern'));
            const gap = source.spans.find(span => span.text.includes('market index lists'));
            if (binding && gap) return [source.id, { status: 'BINDING_EVIDENCE', rationale: 'The retained source names the target project and exact token in a market-only record.', citations: [{ sourceId: source.id, spanId: binding.id }], leadIds: parentIds }];
            if (gap) return [source.id, { status: 'PUBLIC_SUPPORT_GAP', rationale: 'The successfully fetched indexed market record contains pair data but no project narrative.', citations: [{ sourceId: source.id, spanId: gap.id }], leadIds: parentIds }];
            if (binding) return [source.id, { status: 'BINDING_EVIDENCE', rationale: 'The retained source names the target project and exact token together.', citations: [{ sourceId: source.id, spanId: binding.id }], leadIds: parentIds }];
            return [source.id, { status: 'CONTEXT_ONLY', rationale: 'This full source is contextual and does not establish another exact-token representation.', citations: [], leadIds: parentIds }];
          }));
          return attentionEnvelope({ competitors: [], posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => [id, { spanId: attentionSpanId(packet, id, target.address), role: 'NEWS' }])), sourceSupport });
        }
        const emptyCatalog = ((packet.exactContractObservations as unknown[] | undefined)?.length ?? 0) === 0;
        return attentionEnvelope({
          decisions: Object.fromEntries(((packet.requiredDecisionIds ?? []) as string[]).map(id => [id, { accepted: true, rationale: 'The batch proposal is checked against the full retained source.' }])),
          candidateSet: { complete: false, rationale: 'The acquired comparison sample does not establish a complete representation set.' },
          sourceDecisions: Object.fromEntries(sources.map(source => {
            const gap = source.spans.some(span => span.text.includes('market index lists'));
            return [source.id, { disposition: gap ? 'INSUFFICIENT' : 'CONTEXT', insufficiencyKind: gap ? 'PUBLIC_SUPPORT_GAP' : 'NONE', inspectionComplete: true,
              rationale: 'The full source was inspected and its public-support gap or contextual role is independently reviewed.' }];
          })),
          supportDecisions: Object.fromEntries(sources.map(source => [source.id, { accepted: true, rationale: 'The independent review checks each full source support decision.' }])),
          ...(emptyCatalog ? {} : { missingRepresentations: [] }),
        });
      }
      if (packet.proposal) return attentionEnvelope({
        decisions: Object.fromEntries([...(typed.requiredDecisionIds ?? [])].reverse().map(id => [id, {
          accepted: id !== 'claim-topic' || ownRoleRecovery, rationale: id === 'claim-topic'
            ? ownRoleRecovery
              ? 'The exact-token project source supports the neighborhood arts narrative and its relation to this contract.'
              : 'The exact-token deployment metadata does not support the proposed community-project narrative.'
            : 'The source supports this bounded attention item.',
        }])),
        candidateSet: { complete: false, rationale: 'The original comparison acquisition remains incomplete.' },
        originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No primary origin relationship is established in this fixture.' },
      });
      const targetSourceId = attentionSourceId(packet, target.address);
      const span = attentionSpanId(packet, targetSourceId, target.address);
      // Deliberately vary raw JSON key order; Service must reconstruct the canonical parsed claim.
      return attentionEnvelope({
        claims: [{ citations: [{ sourceId: targetSourceId, spanId: span }], value: true, id: 'claim-topic', feature: 'A01', summary: 'A neighborhood art project narrative.' }],
        posts: Object.fromEntries([...(typed.requiredPostSourceIds ?? [])].reverse().map(id => [id, { spanId: attentionSpanId(packet, id, 'Unrelated gardening note'), role: 'OTHER' }])),
        competitors: [],
      });
    },
  });
  const roleFetcher: typeof fetch = async (input, init) => {
    const response = await mock.fetcher(input, init);
    if (originRoleFetchStatus === undefined || !String(input).startsWith('https://api.fetch.tinyfish.ai/')) return response;
    const request = JSON.parse(String(init?.body ?? '{}')) as { urls?: unknown };
    if (!Array.isArray(request.urls) || request.urls.length !== 1 || request.urls[0] !== roleAlternateUrl) return response;
    return new Response(await response.text(), {
      status: originRoleFetchStatus,
      headers: { 'content-type': 'application/json' },
    });
  };

  const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  const receipt = JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as {
    evidenceIds: string[];
    read: { collectionMethod?: string; leadershipPositiveMethod?: string; entryEvidenceMethod?: string; entryExecutionMethod?: string; comparisonComplete?: boolean; complete?: boolean; codes?: string[]; end: string;
      originRecovery?: { comparisonSupplementIds: string[] };
      sources: Array<{ id: string; url: string; text: string; kind: 'POST' | 'PAGE' }>;
      comparisonAcquisition: { originalComplete: boolean; leads: Array<{ id: string; url: string | null; acquisitionStatus: string; recoveryQueryIds: string[]; recoverySourceIds: string[] }> };
      comparisonRecovery?: { method: string; accessGapMethod?: string; selectedLeadIds: string[];
        recoveryQueries: Array<{ queryId: string; parentLeadId: string; query: string; state: string; descriptorComplete: boolean }>;
        sourceLineage: Array<{ leadId: string; queryIds: string[]; sourceIds: string[] }> };
      comparisonQualification?: unknown;
    };
    proposal: { claims: Array<{ id: string; feature: string; value: boolean; summary: string }>; posts: Array<{ id: string; sourceId: string; role: string }>; competitors: Array<{ id: string }> };
    review: { candidateSet: { complete: boolean }; decisions: Array<{ id: string; accepted: boolean }>;
      entryDecisions?: { method: string; originTraceability: { verdict: string }; leadership: { verdict: string }; representations: { verdict: string }; explainableThesis?: { verdict: string } };
      leadershipScreening?: { method: string; verdict: string; review: { accepted: boolean };
        originTraceability: { verdict: string; review: { accepted: boolean } } } };
  };
  assert.equal(receipt.read.entryExecutionMethod, 'entry-first-v2');
  assert.equal(receipt.read.comparisonComplete, false);
  assert.equal(receipt.read.comparisonQualification, undefined,
    'the fresh route retains source acquisition and binary entry review without a factual lead task graph');
  assert.equal(receipt.read.comparisonRecovery?.method, 'comparison-acquisition-v1');
  assert.ok(receipt.read.comparisonRecovery?.selectedLeadIds.length);
  assert.equal(receipt.read.entryEvidenceMethod, 'public-support-v2');
  const supplementId = receipt.read.originRecovery?.comparisonSupplementIds[0];
  assert.ok(supplementId, 'the actual failed DEX lead produces one retained validated pair supplement');
  const supplement = receipt.read.sources.find(source => source.id === supplementId);
  assert.equal(supplement?.url, dexSupplementUrl);
  assert.equal(supplement?.text, dexSupplementText);
  const originFetch = JSON.parse(bundle.rawArtifacts['attention-origin-fetch-1']!) as { results: Array<{ url: string; text: string }> };
  assert.equal(originFetch.results.find(result => result.url === dexSupplementUrl)?.text, dexSupplementText,
    'the source catalog and raw actual Fetch response retain the same complete body');
  const reconstructedScope = entryEvidenceScope({ ...receipt.read, rawArtifacts: bundle.rawArtifacts } as unknown as AttentionRead,
    target, receipt.read.end);
  assert.equal(reconstructedScope.complete, true, JSON.stringify(reconstructedScope));
  assert.ok(reconstructedScope.sourceIds.includes(supplementId));
  assert.equal(bundle.rawArtifacts['attention-entry-first-acquisition'], JSON.stringify(receipt.read.comparisonRecovery));
  assert.equal(receipt.review.entryDecisions?.method, 'binary-public-support-v4');
  assert.deepEqual([receipt.review.entryDecisions?.originTraceability.verdict,
    receipt.review.entryDecisions?.leadership.verdict, receipt.review.entryDecisions?.representations.verdict,
    receipt.review.entryDecisions?.explainableThesis?.verdict], ['FAIL', 'FAIL', 'FAIL', 'FAIL'],
  'the fresh Service proof preserves all four independently reviewed public-entry outcomes');
  for (const id of ['attention-leadership-proposal-response', 'attention-leadership-review-response']) {
    const envelope = JSON.parse(bundle.rawArtifacts[id]!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    const rawDecision = JSON.parse(envelope.candidates[0]!.content.parts[0]!.text) as Record<string, unknown>;
    assert.equal('sourceIds' in rawDecision, false, `${id} relies on the supplied code-owned origin catalog`);
    if (id === 'attention-leadership-review-response') {
      const origin = rawDecision.originTraceability as Record<string, unknown>;
      const leadership = rawDecision.leadership as Record<string, unknown>;
      const representations = rawDecision.representations as Record<string, unknown>;
      assert.ok(origin.citation && typeof origin.citation === 'object', 'the fresh final wire requires one citation object for origin traceability');
      assert.ok(leadership.citation && typeof leadership.citation === 'object', 'the fresh final wire requires one citation object for leadership');
      assert.ok(representations.citation && typeof representations.citation === 'object', 'the fresh final wire requires one citation object for representation coverage');
      assert.equal('citations' in origin, false, 'the final wire does not use the legacy citation array');
      assert.equal('citations' in leadership, false, 'the final wire does not use the legacy citation array');
      assert.equal('citations' in representations, false, 'the final wire does not use the legacy citation array');
    }
  }
  assert.equal(receipt.read.comparisonAcquisition.originalComplete, false, 'the original DexScreener body remains failed');
  const selectedMarketLeadId = receipt.read.comparisonRecovery!.selectedLeadIds.find(id =>
    receipt.read.comparisonAcquisition.leads.find(lead => lead.id === id)?.url === marketUrl);
  assert.ok(selectedMarketLeadId, 'the selected recovery remains bound to the original indexed market lead');
  const marketLead = receipt.read.comparisonAcquisition.leads.find(lead => lead.id === selectedMarketLeadId)!;
  const marketQueries = receipt.read.comparisonRecovery!.recoveryQueries.filter(query => query.parentLeadId === selectedMarketLeadId);
  assert.ok(marketQueries.length && marketQueries.every(query => query.state === 'OBSERVED' && query.descriptorComplete));
  assert.ok(marketLead.recoveryQueryIds.length && marketLead.recoverySourceIds.length);
  const marketLineage = receipt.read.comparisonRecovery!.sourceLineage.find(row => row.leadId === selectedMarketLeadId);
  assert.deepEqual(marketLineage?.queryIds, marketLead.recoveryQueryIds);
  assert.deepEqual(marketLineage?.sourceIds, marketLead.recoverySourceIds);
  assert.ok(marketLead.recoverySourceIds.some(id => receipt.read.sources.some(source => source.id === id && source.text === marketText)),
    'the source planner acquisition binds a selected full body to its original parent');
  assert.equal(Object.keys(bundle.rawArtifacts).some(id => /^attention-comparison-\d+-(?:proposal|review)-prompt$/.test(id)), false,
    'no factual comparison batch task is issued on this fresh route');
  assert.equal(bundle.rawArtifacts['attention-comparison-coverage'], undefined);
  assert.equal(receipt.proposal.claims[0]?.value, true, 'the original unsupported factual narrative proposal is retained');
  assert.equal(receipt.review.decisions.find(item => item.id === 'claim-topic')?.accepted, false,
    'the inadequate-support grade does not promote the rejected factual narrative');
  assert.equal(receipt.review.candidateSet.complete, false);
  const canonicalPostSourceIds = receipt.read.sources.filter(source => source.kind === 'POST').map(source => source.id);
  assert.deepEqual(canonicalPostSourceIds, postUrls.map(url => receipt.read.sources.find(source => source.url === url)?.id));
  assert.ok(canonicalPostSourceIds.length > 1, 'the fixture exercises multiple keyed POST selections');
  assert.deepEqual(receipt.proposal.posts.map(post => post.sourceId), canonicalPostSourceIds,
    'Service decodes post labels in retained source order even when the provider JSON keys are reversed');
  const rawBase = JSON.parse(bundle.rawArtifacts['attention-proposal-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const rawBaseWire = JSON.parse(rawBase.candidates[0]!.content.parts[0]!.text) as {
    claims: Array<{ id: string }>; posts: Record<string, unknown>; competitors: Array<{ id: string }>;
  };
  assert.deepEqual(Object.keys(rawBaseWire.posts), [...canonicalPostSourceIds].reverse(), 'the retained model response deliberately reverses keyed POST order');
  const rawReview = JSON.parse(bundle.rawArtifacts['attention-review-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const rawReviewWire = JSON.parse(rawReview.candidates[0]!.content.parts[0]!.text) as { decisions: Record<string, unknown> };
  const canonicalDecisionIds = [
    ...rawBaseWire.claims.map(item => item.id),
    ...canonicalPostSourceIds.map(id => `post:${id}`),
    ...rawBaseWire.competitors.map(item => item.id),
  ];
  assert.ok(canonicalDecisionIds.length > 1, 'the fixture exercises multiple keyed review decisions');
  assert.deepEqual(Object.keys(rawReviewWire.decisions), [...canonicalDecisionIds].reverse(), 'the retained review deliberately reverses keyed decision order');
  assert.deepEqual(receipt.review.decisions.filter(decision => canonicalDecisionIds.includes(decision.id)).map(decision => decision.id), canonicalDecisionIds,
    'Service reconstructs review decisions in canonical proposal order');
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A09')?.projection?.value, false);
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A01')?.projection?.value, false);
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A05')?.projection?.value, false);
  assert.deepEqual([bundle.details?.baseline.find(row => row.id === 'A03')?.quality,
    bundle.details?.baseline.find(row => row.id === 'A03')?.projection?.value], ['KNOWN', false],
  'the task-v5 public origin-traceability grade produces a scoped NAR-02 failure while leaving the underlying facts separate');
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A14')?.quality, 'KNOWN');
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A14')?.projection?.value, false,
    'the public entry judgment is separate from factual origin and measured leadership');
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A02')?.quality, 'MISSING');
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A04')?.quality, 'MISSING');
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A10')?.quality, 'MISSING');
  assert.ok(bundle.details?.shared, 'Service receives the nonempty Shared source audit from the collected bundle');
  assert.equal(bundle.details?.shared?.qualityMode, 'ENTRY_GATES_V1');
  assert.equal((JSON.parse(bundle.rawArtifacts['shared-derivation']!) as { qualityMode?: string }).qualityMode, 'ENTRY_GATES_V1',
    'the live shared proof persists the explicit entry-data-quality mode');
  assert.ok(bundle.evidence.some(item => item.id === 'shared-derivation'));
  const sharedSupportClaim = sharedClaims(bundle.details!.baseline, bundle.details!.social).find(claim => claim.id === 'A09:entry');
  assert.ok(sharedSupportClaim,
    'the Shared audit retains the binary CAN-01 entry decision alongside the separate missing factual binding');
  assert.match(sharedSupportClaim.statement, /Entry CAN-01 evidence standard FAIL/);
  assert.ok(sharedSupportClaim.citations.length > 0, 'the Shared entry decision keeps its selected literal evidence citations');
  const sharedOriginClaim = sharedClaims(bundle.details!.baseline, bundle.details!.social).find(claim => claim.id === 'A03');
  assert.ok(sharedOriginClaim, 'Shared receives the independently reviewed task-v5 origin-traceability projection');
  assert.match(sharedOriginClaim.statement, /Entry origin\/catalyst evidence standard FAIL/);
  assert.ok(sharedOriginClaim.citations.length > 0, 'the origin-traceability grade retains its selected original-scope citation');
  const narrativeSupportClaim = sharedClaims(bundle.details!.baseline, bundle.details!.social).find(claim => claim.id === 'A01:adequacy');
  assert.ok(narrativeSupportClaim, 'the Shared audit receives the separate reviewed narrative-support grade');
  assert.match(narrativeSupportClaim.statement, /factual narrative remains unresolved/);
  assert.ok(narrativeSupportClaim.citations.length > 0);
  const rawBaseClaimWire = JSON.parse(rawBase.candidates[0]!.content.parts[0]!.text) as { claims: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(rawBaseClaimWire.claims[0]!), ['citations', 'value', 'id', 'feature', 'summary'], 'the raw producer order is intentionally noncanonical');

  omitRecoveredMarket = true;
  omittedRecoveredFetches = 0;
  mock.reset();
  const incompleteBundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  omitRecoveredMarket = false;
  const incompleteReceipt = JSON.parse(incompleteBundle.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
  const incompleteScope = entryEvidenceScope({ ...incompleteReceipt.read, rawArtifacts: incompleteBundle.rawArtifacts } as unknown as AttentionRead,
    target, incompleteReceipt.read.end);
  assert.equal(omittedRecoveredFetches, 2, 'the actual selected recovery URL is omitted from initial Fetch and its bounded retry');
  assert.equal(incompleteScope.complete, false, JSON.stringify(incompleteScope));
  assert.ok(incompleteScope.blockers.includes('ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE'));
  assert.equal(incompleteReceipt.review.entryDecisions, undefined,
    'the collector leaves public entry UNKNOWN without an effective body or terminal gap');

  const directory = mkdtempSync(join(tmpdir(), 'v3-accounting-service-'));
  try {
    const database = join(directory, 'accepted.sqlite');
    let snapshotId = '';
    let snapshotHash = '';
    const writer = new Service(database);
    try {
      const saved = writer.analyzeLive(bundle);
      snapshotId = saved.id;
      snapshotHash = saved.hash;
      const can01 = saved.result.checks.find(row => row.checkId === 'CAN-01');
      assert.equal(can01?.status, 'FAIL');
      assert.deepEqual(can01?.featureRefs, ['A09'], 'the accepted binary public judgment remains distinct from missing factual A10');
      assert.equal(saved.details?.baseline.find(row => row.id === 'A09')?.quality, 'KNOWN',
        'a complete selected-recovery scope remains eligible for its reviewed binary public-entry grade');
      assert.doesNotThrow(() => renderSnapshot(saved, { details: saved.details }),
        'the binary decision route renders snapshots whose unrelated baseline rows have null assessment data');
    } finally { writer.close(); }
    const storedDb = new DatabaseSync(database);
    try {
      const row = storedDb.prepare('SELECT semantic FROM snapshots WHERE id=?').get(snapshotId) as { semantic: string };
      const semantic = JSON.parse(row.semantic) as { policyVersion: string; entryComparison?: boolean };
      assert.equal(semantic.policyVersion, 'research-screen-shared-v2');
      assert.equal(semantic.entryComparison, false, 'the independently reviewed public FAIL is frozen for offline policy replay');
    } finally { storedDb.close(); }
    const reopened = new Service(database);
    try {
      const replay = reopened.replay(snapshotId);
      assert.equal(replay.hash, snapshotHash);
      assert.deepEqual(replay, reopened.show(snapshotId));
      assert.equal(replay.result.checks.find(row => row.checkId === 'CAN-01')?.status, 'FAIL');
      assert.equal(replay.details?.baseline.find(row => row.id === 'A09')?.projection?.value, false);
    } finally { reopened.close(); }

    recoverViaAlternate = true;
    timeoutOriginalMarket = true;
    mock.reset();
    const alternateBundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
      tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
    }));
    recoverViaAlternate = false;
    timeoutOriginalMarket = false;
    const alternateReceipt = JSON.parse(alternateBundle.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    const alternateDiagnosticRead = alternateReceipt.read as unknown as {
      comparisonRecovery?: { recoveryQueries?: unknown[] };
      codes?: string[];
    };
    const alternateScope = entryEvidenceScope({ ...alternateReceipt.read, rawArtifacts: alternateBundle.rawArtifacts } as unknown as AttentionRead,
      target, alternateReceipt.read.end);
    assert.equal(alternateScope.complete, true, JSON.stringify({
      scope: alternateScope,
      recoveryQueries: alternateDiagnosticRead.comparisonRecovery?.recoveryQueries,
      searches: Object.fromEntries(Object.entries(alternateBundle.rawArtifacts).filter(([id]) => /^attention-recovery-search-\d+$/.test(id))),
      selection: alternateBundle.rawArtifacts['attention-recovery-selection-scope'],
      fallback: alternateBundle.rawArtifacts['attention-recovery-fallback-scope'],
      codes: alternateDiagnosticRead.codes,
    }));
    const declaredAccessGap = alternateScope.gaps.find(gap => gap.url === marketUrl);
    assert.equal(declaredAccessGap?.code, 'TARGET_ACCESS_GAP', JSON.stringify(alternateScope));
    assert.equal(declaredAccessGap?.cause, 'ATT_FETCH_TIMEOUT');
    assert.equal(declaredAccessGap?.originalAttemptIds?.length, 2, 'both original target-local Fetch attempts record explicit timeout');
    assert.ok(declaredAccessGap?.queryIds?.length, 'the gap is tied to a completed own recovery query');
    assert.ok(declaredAccessGap?.alternativeSourceIds?.some(id => alternateReceipt.read.sources.some(source => source.id === id)),
      'the same lead has a retained full alternative body');
    const httpOutcomeReceipt = JSON.parse(alternateBundle.rawArtifacts['attention-http-outcomes']!) as {
      outcomes: Array<{ artifactId: string; status: number }>;
    };
    assert.ok((declaredAccessGap?.originalAttemptIds ?? []).every(id => httpOutcomeReceipt.outcomes.some(row => row.artifactId === id && row.status === 200)),
      'the timeout rows are admitted only inside successful HTTP Fetch envelopes');
    assert.ok(alternateReceipt.read.sources.some(source => source.url === alternateRecoveredMarketUrl),
      'the second-round alternate body is retained in the actual attention qualification');
    const fallbackReceipt = JSON.parse(alternateBundle.rawArtifacts['attention-recovery-fallback-scope']!) as {
      method: string; rounds: Array<{ batch: number; selections: Array<{ url: string }> }>;
    };
    assert.equal(fallbackReceipt.method, 'same-parent-alternates-v1');
    assert.equal(fallbackReceipt.rounds.length, 1);
    assert.equal(fallbackReceipt.rounds[0]?.batch, 2);
    assert.ok(fallbackReceipt.rounds[0]?.selections.some(selection => selection.url === alternateRecoveredMarketUrl));
    const alternateWriter = new Service(join(directory, 'selected-recovery-alternate.sqlite'));
    let alternateSnapshotId = '';
    let alternateSnapshotHash = '';
    try {
      const saved = alternateWriter.analyzeLive(alternateBundle);
      alternateSnapshotId = saved.id;
      alternateSnapshotHash = saved.hash;
      assert.equal(saved.result.checks.find(row => row.checkId === 'CAN-01')?.status, 'FAIL');
      assert.equal(saved.details?.baseline.find(row => row.id === 'A09')?.quality, 'KNOWN',
        'Service accepts a reviewed public-entry grade after a same-parent alternate was actually acquired');
    } finally { alternateWriter.close(); }
    const alternateReopened = new Service(join(directory, 'selected-recovery-alternate.sqlite'));
    try {
      const replay = alternateReopened.replay(alternateSnapshotId);
      assert.equal(replay.hash, alternateSnapshotHash);
      assert.deepEqual(replay, alternateReopened.show(alternateSnapshotId));
      assert.equal(replay.result.checks.find(row => row.checkId === 'CAN-01')?.status, 'FAIL');
    } finally { alternateReopened.close(); }

    const recalculateProofHashes = (candidate: typeof bundle) => {
      for (const evidence of candidate.evidence) {
        const raw = candidate.rawArtifacts[evidence.id];
        if (raw !== undefined) evidence.contentHash = createHash('sha256').update(raw).digest('hex');
      }
      const proofRecord = candidate.evidence.find(evidence => evidence.id === 'shared-derivation')!;
      const proof = JSON.parse(candidate.rawArtifacts[proofRecord.id]!) as { evidence: typeof candidate.evidence };
      proof.evidence = candidate.evidence.filter(evidence => evidence.id !== proofRecord.id);
      candidate.rawArtifacts[proofRecord.id] = JSON.stringify(proof);
      proofRecord.contentHash = createHash('sha256').update(candidate.rawArtifacts[proofRecord.id]!).digest('hex');
    };

    const collectOwnRoleCase = async (fetchStatus: number) => {
      ownRoleRecovery = true;
      timeoutOriginalRole = true;
      originRoleFetchStatus = fetchStatus;
      mock.reset();
      try {
        return await collectLiveToken(target, liveOptions(roleFetcher, {
          tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
        }));
      } finally {
        ownRoleRecovery = false;
        timeoutOriginalRole = false;
        originRoleFetchStatus = undefined;
      }
    };

    const roleQualifiedBundle = await collectOwnRoleCase(200);
    const roleQualifiedReceipt = JSON.parse(roleQualifiedBundle.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    assert.equal(roleQualifiedReceipt.read.collectionMethod, 'project-context-v2');
    assert.equal((JSON.parse(roleQualifiedBundle.rawArtifacts['attention-acquisition-scope']!) as { collectionMethod?: string }).collectionMethod,
      'project-context-v2');
    assert.equal((JSON.parse(roleQualifiedBundle.rawArtifacts['social-attention-seed']!) as { read: { collectionMethod?: string } }).read.collectionMethod,
      'project-context-v2');
    assert.equal((JSON.parse(roleQualifiedBundle.rawArtifacts['attention-proposal-prompt']!) as { scope: { collectionMethod?: string } }).scope.collectionMethod,
      'project-context-v2');
    assert.equal((JSON.parse(roleQualifiedBundle.rawArtifacts['attention-review-prompt']!) as { scope: { collectionMethod?: string } }).scope.collectionMethod,
      'project-context-v2');
    const roleQualifiedScope = entryEvidenceScope({ ...roleQualifiedReceipt.read, rawArtifacts: roleQualifiedBundle.rawArtifacts } as unknown as AttentionRead,
      target, roleQualifiedReceipt.read.end);
    const roleGap = roleQualifiedScope.gaps.find(gap => gap.url === roleGapUrl);
    assert.equal(roleQualifiedScope.complete, true, JSON.stringify(roleQualifiedScope));
    assert.equal(roleGap?.code, 'TARGET_ACCESS_GAP', JSON.stringify(roleQualifiedScope));
    assert.equal(roleGap?.originalRoleId, 'attention-origin-role-1');
    assert.equal(roleGap?.originalAttemptIds?.length, 2, 'the original role URL has two per-URL timeout outcomes');
    assert.ok(roleGap?.alternativeSourceIds?.some(id => roleQualifiedReceipt.read.sources.some(source => source.id === id && source.url === roleAlternateUrl)),
      'the own-role Fetch source is bound to the selected different-host alternate');
    assert.ok(roleQualifiedReceipt.read.sources.some(source => source.url === roleAlternateUrl && source.text === roleAlternateText),
      'the selected alternate body was already retained from the earlier Fetch');
    const roleHttp = JSON.parse(roleQualifiedBundle.rawArtifacts['attention-origin-http-outcomes']!) as {
      outcomes: Array<{ artifactId: string; status: number }>;
    };
    assert.ok(roleHttp.outcomes.some(row => row.artifactId === 'attention-origin-role-1-search' && row.status === 200));
    assert.ok(roleHttp.outcomes.some(row => row.artifactId === 'attention-origin-role-1-fetch' && row.status === 200));
    assert.equal(mock.geminiPackets.filter(packet => packet.method === 'binary-public-support-v4').length, 2,
      'completed own-role acquisition dispatches the real independent entry proposal and review pair');
    assert.equal(roleQualifiedReceipt.review.entryDecisions?.method, 'binary-public-support-v4');
    assert.equal(roleQualifiedReceipt.read.leadershipPositiveMethod, 'source-bound-positive-v1');
    const socialSeed = JSON.parse(roleQualifiedBundle.rawArtifacts['social-attention-seed']!) as {
      read: { leadershipPositiveMethod?: string };
    };
    assert.equal(socialSeed.read.leadershipPositiveMethod, 'source-bound-positive-v1');
    const socialDerivation = JSON.parse(roleQualifiedBundle.rawArtifacts['social-derivation']!) as {
      read: { inspectionRecoveryMethod?: string };
    };
    assert.equal(socialDerivation.read.inspectionRecoveryMethod, 'historical-post-inspection-v1',
      'the fresh source-bound route binds the historical inspection recovery mode into the social proof');

    const roleWriter = new Service(join(directory, 'own-role-qualified.sqlite'));
    let roleSnapshotId = '';
    let roleSnapshotHash = '';
    try {
      const saved = roleWriter.analyzeLive(roleQualifiedBundle);
      roleSnapshotId = saved.id;
      roleSnapshotHash = saved.hash;
      assert.equal(saved.result.checks.find(row => row.checkId === 'CAN-01')?.status, 'FAIL');
      assert.equal(saved.details?.baseline.find(row => row.id === 'A09')?.quality, 'KNOWN');
    } finally { roleWriter.close(); }
    const roleReopened = new Service(join(directory, 'own-role-qualified.sqlite'));
    try {
      const replay = roleReopened.replay(roleSnapshotId);
      assert.equal(replay.hash, roleSnapshotHash);
      assert.deepEqual(replay, roleReopened.show(roleSnapshotId));
      assert.equal(replay.result.checks.find(row => row.checkId === 'CAN-01')?.status, 'FAIL');
    } finally { roleReopened.close(); }

    const rejectRehashedCollectionMethod = (change: (candidate: typeof roleQualifiedBundle) => void, label: string) => {
      const candidate = structuredClone(roleQualifiedBundle);
      change(candidate);
      recalculateProofHashes(candidate);
      const verifier = new Service(join(directory, `collection-method-${label}.sqlite`));
      try {
        assert.throws(() => verifier.analyzeLive(candidate), /ATTENTION_COLLECTION_METHOD_INVALID/, label);
      } finally { verifier.close(); }
    };
    rejectRehashedCollectionMethod(candidate => {
      const receipt = JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as typeof roleQualifiedReceipt;
      delete receipt.read.collectionMethod;
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, 'receipt marker stripped');
    rejectRehashedCollectionMethod(candidate => {
      const receipt = JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as typeof roleQualifiedReceipt;
      (receipt.read as { collectionMethod?: string }).collectionMethod = 'project-context-v1';
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, 'unknown receipt marker');
    rejectRehashedCollectionMethod(candidate => {
      const scope = JSON.parse(candidate.rawArtifacts['attention-acquisition-scope']!) as { collectionMethod?: string };
      scope.collectionMethod = 'project-context-v1';
      candidate.rawArtifacts['attention-acquisition-scope'] = JSON.stringify(scope);
    }, 'acquisition scope mismatch');
    rejectRehashedCollectionMethod(candidate => {
      const seed = JSON.parse(candidate.rawArtifacts['social-attention-seed']!) as { read: { collectionMethod?: string } };
      delete seed.read.collectionMethod;
      candidate.rawArtifacts['social-attention-seed'] = JSON.stringify(seed);
    }, 'social seed marker stripped');
    const strippedInspectionRecovery = structuredClone(roleQualifiedBundle);
    const strippedSocialProof = JSON.parse(strippedInspectionRecovery.rawArtifacts['social-derivation']!) as {
      read: { inspectionRecoveryMethod?: string };
    };
    delete strippedSocialProof.read.inspectionRecoveryMethod;
    strippedInspectionRecovery.rawArtifacts['social-derivation'] = JSON.stringify(strippedSocialProof);
    recalculateProofHashes(strippedInspectionRecovery);
    const strippedInspectionVerifier = new Service(join(directory, 'stripped-historical-inspection-marker.sqlite'));
    try {
      assert.throws(() => strippedInspectionVerifier.analyzeLive(strippedInspectionRecovery), /SOCIAL_SEED_PROOF_INVALID/,
        'Service rejects a fully rehashed fresh proof that strips the source-bound historical-inspection marker');
    } finally { strippedInspectionVerifier.close(); }
    rejectRehashedCollectionMethod(candidate => {
      const prompt = JSON.parse(candidate.rawArtifacts['attention-proposal-prompt']!) as { scope: { collectionMethod?: string } };
      prompt.scope.collectionMethod = 'legacy';
      candidate.rawArtifacts['attention-proposal-prompt'] = JSON.stringify(prompt);
    }, 'proposal prompt mismatch');
    rejectRehashedCollectionMethod(candidate => {
      const prompt = JSON.parse(candidate.rawArtifacts['attention-review-prompt']!) as { scope: { collectionMethod?: string } };
      delete prompt.scope.collectionMethod;
      candidate.rawArtifacts['attention-review-prompt'] = JSON.stringify(prompt);
    }, 'review prompt marker stripped');

    const roleFailedBundle = await collectOwnRoleCase(503);
    const roleFailedReceipt = JSON.parse(roleFailedBundle.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    const roleFailedScope = entryEvidenceScope({ ...roleFailedReceipt.read, rawArtifacts: roleFailedBundle.rawArtifacts } as unknown as AttentionRead,
      target, roleFailedReceipt.read.end);
    assert.equal(roleFailedScope.complete, false, JSON.stringify(roleFailedScope));
    assert.ok(roleFailedScope.blockers.some(code => code === 'ATT_FETCH_HTTP_503' || code === 'ATT_ENTRY_ORIGIN_RECOVERY_HTTP_INCOMPLETE'),
      JSON.stringify({ scope: roleFailedScope, accessGapMethod: roleFailedReceipt.read.comparisonRecovery?.accessGapMethod,
        entryEvidenceMethod: roleFailedReceipt.read.entryEvidenceMethod,
        entryExecutionMethod: roleFailedReceipt.read.entryExecutionMethod,
        comparisonRecovery: roleFailedReceipt.read.comparisonRecovery,
        acquisitionMarker: roleFailedBundle.rawArtifacts['attention-entry-first-acquisition'],
        collectionComplete: roleFailedReceipt.read.complete,
        collectionCodes: roleFailedReceipt.read.codes,
        proposalPresent: !!roleFailedReceipt.proposal,
        reviewPresent: !!roleFailedReceipt.review,
        originAndRecoveryArtifactIds: Object.keys(roleFailedBundle.rawArtifacts)
          .filter(id => /attention-(?:proposal|review|comparison-recovery|entry-first-acquisition|origin-role)/.test(id)),
        proposalResponsePrefix: roleFailedBundle.rawArtifacts['attention-proposal-response']?.slice(0, 400),
        reviewResponsePrefix: roleFailedBundle.rawArtifacts['attention-review-response']?.slice(0, 400),
        recoveryPlanResponsePrefix: roleFailedBundle.rawArtifacts['attention-comparison-recovery-plan-response']?.slice(0, 400),
        fetchedBatches: mock.calls.filter(call => call.url.startsWith('https://api.fetch.tinyfish.ai/'))
          .map(call => JSON.parse(String(call.init?.body)) as { urls?: string[] }),
        sourceUrls: roleFailedReceipt.read.sources.map(source => source.url),
        roleSearch: roleFailedBundle.rawArtifacts['attention-origin-role-1-search'],
        roleFetch: roleFailedBundle.rawArtifacts['attention-origin-role-1-fetch'],
        fetchOutcomeIds: Object.keys(roleFailedBundle.rawArtifacts).filter(id => /http-outcomes|attention-origin-role/.test(id)),
        roleOutcomes: roleFailedBundle.rawArtifacts['attention-origin-http-outcomes'] }));
    const roleFailedHttp = JSON.parse(roleFailedBundle.rawArtifacts['attention-origin-http-outcomes']!) as {
      outcomes: Array<{ artifactId: string; status: number }>;
    };
    assert.ok(roleFailedHttp.outcomes.some(row => row.artifactId === 'attention-origin-role-1-fetch' && row.status === 503),
      'the honest failed bundle retains the actual required own-role HTTP 503 outcome');
    assert.equal(roleFailedScope.gaps.some(gap => gap.url === roleGapUrl && gap.code === 'TARGET_ACCESS_GAP'), false,
      'the already-retained alternate body cannot mask a failed required own-role Fetch');
    assert.equal(roleFailedReceipt.review.entryDecisions, undefined,
      'the failed required Fetch leaves the public entry result ungraded');
    assert.equal(mock.geminiPackets.filter(packet => packet.method === 'binary-public-support-v4').length, 0,
      'an incomplete own-role scope does not dispatch public entry grading');

    const roleFailedWriter = new Service(join(directory, 'own-role-failed.sqlite'));
    let roleFailedSnapshotId = '';
    let roleFailedSnapshotHash = '';
    try {
      const saved = roleFailedWriter.analyzeLive(roleFailedBundle);
      roleFailedSnapshotId = saved.id;
      roleFailedSnapshotHash = saved.hash;
      assert.equal(saved.result.checks.find(row => row.checkId === 'CAN-01')?.status, 'UNKNOWN');
    } finally { roleFailedWriter.close(); }
    const roleFailedReopened = new Service(join(directory, 'own-role-failed.sqlite'));
    try {
      const replay = roleFailedReopened.replay(roleFailedSnapshotId);
      assert.equal(replay.hash, roleFailedSnapshotHash);
      assert.deepEqual(replay, roleFailedReopened.show(roleFailedSnapshotId));
      assert.equal(replay.result.checks.find(row => row.checkId === 'CAN-01')?.status, 'UNKNOWN');
    } finally { roleFailedReopened.close(); }

    const forgedRoleGrade = structuredClone(roleQualifiedBundle);
    const forgedRoleHttp = JSON.parse(forgedRoleGrade.rawArtifacts['attention-origin-http-outcomes']!) as {
      outcomes: Array<{ artifactId: string; status: number }>;
    };
    const forgedFetchOutcome = forgedRoleHttp.outcomes.find(row => row.artifactId === 'attention-origin-role-1-fetch');
    assert.equal(forgedFetchOutcome?.status, 200, 'the accepted known-grade proof begins with a successful own-role Fetch receipt');
    forgedFetchOutcome!.status = 503;
    forgedRoleGrade.rawArtifacts['attention-origin-http-outcomes'] = JSON.stringify(forgedRoleHttp);
    recalculateProofHashes(forgedRoleGrade);
    const forgedRoleVerifier = new Service(join(directory, 'forged-own-role-grade.sqlite'));
    try {
      assert.throws(() => forgedRoleVerifier.analyzeLive(forgedRoleGrade), /ATTENTION_HTTP_PROOF_INVALID|SHARED_(?:PROOF|ATTENTION|SOURCE)_/,
        'Service rejects the admitted known grade when only its required own-role HTTP outcome is changed to 503 and rehashed');
    } finally { forgedRoleVerifier.close(); }

    const accessGapRead = (candidate: typeof alternateBundle) => JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as {
      read: {
        comparisonRecovery: { accessGapMethod?: string; recoveryQueries: Array<{ queryId: string; parentLeadId: string }> };
        sources: Array<{ id: string; url: string; text: string }>;
      };
    };
    const rejectRehashedAccessGap = (change: (candidate: typeof alternateBundle) => void, label: string) => {
      const candidate = structuredClone(alternateBundle);
      change(candidate);
      recalculateProofHashes(candidate);
      const verifier = new Service(join(directory, `access-gap-${label}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), /ATTENTION_HTTP_PROOF_INVALID|SHARED_(?:PROOF|ATTENTION|SOURCE)_/m, label); }
      finally { verifier.close(); }
    };
    rejectRehashedAccessGap(candidate => {
      const receipt = accessGapRead(candidate);
      receipt.read.comparisonRecovery.accessGapMethod = 'unverified-alternates-v0';
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, 'fresh access-gap marker downgrade');
    rejectRehashedAccessGap(candidate => {
      const outcomes = JSON.parse(candidate.rawArtifacts['attention-http-outcomes']!) as { outcomes: Array<{ artifactId: string; status: number }> };
      const receipt = accessGapRead(candidate);
      const gap = alternateScope.gaps.find(row => row.code === 'TARGET_ACCESS_GAP' && row.url === marketUrl);
      const attempt = gap?.originalAttemptIds?.[0];
      assert.ok(attempt);
      const outcome = outcomes.outcomes.find(row => row.artifactId === attempt);
      assert.ok(outcome);
      outcome.status = 503;
      candidate.rawArtifacts['attention-http-outcomes'] = JSON.stringify(outcomes);
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, 'per-URL timeout status changed to a failed provider response');
    rejectRehashedAccessGap(candidate => {
      const receipt = accessGapRead(candidate);
      assert.ok(receipt.read.comparisonRecovery.recoveryQueries[0]);
      receipt.read.comparisonRecovery.recoveryQueries[0]!.parentLeadId = 'unrelated-lead';
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, 'recovery query parent reassignment');
    rejectRehashedAccessGap(candidate => {
      const receipt = accessGapRead(candidate);
      const gap = alternateScope.gaps.find(row => row.code === 'TARGET_ACCESS_GAP' && row.url === marketUrl);
      const sourceId = gap?.alternativeSourceIds?.[0];
      const source = receipt.read.sources.find(row => row.id === sourceId);
      assert.ok(source);
      source.text += ' Changed after the retained fetch response.';
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(receipt);
    }, 'alternative source body changed after acquisition');
    rejectRehashedAccessGap(candidate => {
      const prompt = JSON.parse(candidate.rawArtifacts['attention-leadership-proposal-prompt']!) as { instruction: string };
      prompt.instruction += ' Remove the declared gap from consideration.';
      candidate.rawArtifacts['attention-leadership-proposal-prompt'] = JSON.stringify(prompt);
    }, 'entry prompt no longer matches the canonical access-gap scope');

    const movedRecoveryBundle = structuredClone(alternateBundle);
    const movedFetchId = 'attention-recovery-fetch-2';
    const movedFetchRaw = movedRecoveryBundle.rawArtifacts[movedFetchId]!;
    movedRecoveryBundle.rawArtifacts[movedFetchId] = JSON.stringify({ results: [], errors: [] });
    movedRecoveryBundle.rawArtifacts['attention-recovery-fetch-99'] = movedFetchRaw;
    const movedRecoveryReceipt = JSON.parse(movedRecoveryBundle.rawArtifacts['attention-qualified-receipt']!) as typeof alternateReceipt;
    movedRecoveryReceipt.evidenceIds.push('attention-recovery-fetch-99');
    movedRecoveryBundle.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(movedRecoveryReceipt);
    const movedFetchEvidence = movedRecoveryBundle.evidence.find(evidence => evidence.id === movedFetchId)!;
    movedRecoveryBundle.evidence.push({ ...structuredClone(movedFetchEvidence), id: 'attention-recovery-fetch-99' });
    recalculateProofHashes(movedRecoveryBundle);
    const movedRecoveryVerifier = new Service(join(directory, 'moved-recovery-batch.sqlite'));
    try {
      assert.throws(() => movedRecoveryVerifier.analyzeLive(movedRecoveryBundle), /SHARED_(?:PROOF|ATTENTION|SOURCE)_/,
        'Service rechecks a rehashed real receipt and rejects a successful alternate moved from its owning Fetch batch');
    } finally { movedRecoveryVerifier.close(); }

    const incompleteWriter = new Service(join(directory, 'selected-recovery-incomplete.sqlite'));
    let incompleteSnapshotId = '';
    let incompleteSnapshotHash = '';
    try {
      const saved = incompleteWriter.analyzeLive(incompleteBundle);
      incompleteSnapshotId = saved.id;
      incompleteSnapshotHash = saved.hash;
      const can01 = saved.result.checks.find(row => row.checkId === 'CAN-01');
      assert.equal(can01?.status, 'UNKNOWN', JSON.stringify({
        expectation: 'the incomplete selected recovery cannot become a binary PASS or FAIL', can01,
        a09: saved.details?.baseline.find(row => row.id === 'A09'),
        comparisonRecoveryMethod: incompleteReceipt.read.comparisonRecovery?.method,
        scopeBlockers: incompleteScope.blockers,
      }));
      const recoveredA09 = saved.details?.baseline.find(row => row.id === 'A09');
      assert.equal(recoveredA09?.quality, 'MISSING');
      assert.ok(recoveredA09?.causes.some(cause => cause.code === 'ATT_ENTRY_RECOVERY_FETCH_INCOMPLETE'));
    } finally { incompleteWriter.close(); }
    const incompleteReopened = new Service(join(directory, 'selected-recovery-incomplete.sqlite'));
    try {
      const replay = incompleteReopened.replay(incompleteSnapshotId);
      assert.equal(replay.hash, incompleteSnapshotHash);
      assert.deepEqual(replay, incompleteReopened.show(incompleteSnapshotId));
      assert.equal(replay.result.checks.find(row => row.checkId === 'CAN-01')?.status, 'UNKNOWN',
        'offline replay preserves the honest UNKNOWN entry result');
    } finally { incompleteReopened.close(); }

    const forgedIncompleteEntry = structuredClone(incompleteBundle);
    const forgedReceipt = JSON.parse(forgedIncompleteEntry.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    forgedReceipt.review.entryDecisions = receipt.review.entryDecisions;
    forgedReceipt.evidenceIds.push('attention-leadership-proposal-response', 'attention-leadership-review-response');
    forgedIncompleteEntry.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(forgedReceipt);
    for (const id of ['attention-leadership-proposal-response', 'attention-leadership-review-response']) {
      forgedIncompleteEntry.rawArtifacts[id] = bundle.rawArtifacts[id]!;
      forgedIncompleteEntry.evidence.push(structuredClone(bundle.evidence.find(evidence => evidence.id === id)!));
    }
    recalculateProofHashes(forgedIncompleteEntry);
    const forgedVerifier = new Service(join(directory, 'forged-incomplete-entry.sqlite'));
    try {
      assert.throws(() => forgedVerifier.analyzeLive(forgedIncompleteEntry), /SHARED_PROOF_INVALID/,
        'Service re-runs canonical scope reconstruction and rejects a stale binary grade after selected acquisition omission');
    } finally { forgedVerifier.close(); }

    const tamperedSupplement = structuredClone(bundle);
    const tamperedSupplementReceipt = JSON.parse(tamperedSupplement.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    const tamperedSupplementSource = tamperedSupplementReceipt.read.sources.find(source => source.id === supplementId)!;
    const editedSupplementText = tamperedSupplementSource.text + ' edited after the acquired response';
    tamperedSupplementSource.text = editedSupplementText;
    tamperedSupplement.rawArtifacts[supplementId] = editedSupplementText;
    tamperedSupplement.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(tamperedSupplementReceipt);
    recalculateProofHashes(tamperedSupplement);
    const supplementVerifier = new Service(join(directory, 'tampered-origin-supplement.sqlite'));
    try { assert.throws(() => supplementVerifier.analyzeLive(tamperedSupplement), /SOCIAL_SOURCE_INVALID/,
      'the already admitted fresh bundle rejects a rehashed body mutation at the frozen social-source boundary'); }
    finally { supplementVerifier.close(); }

    const tamperedEntryGrade = structuredClone(bundle);
    const entryResponse = JSON.parse(tamperedEntryGrade.rawArtifacts['attention-leadership-review-response']!) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const entryWire = JSON.parse(entryResponse.candidates[0]!.content.parts[0]!.text) as {
      originTraceability: { verdict: string };
    };
    entryWire.originTraceability.verdict = 'PASS';
    entryResponse.candidates[0]!.content.parts[0]!.text = JSON.stringify(entryWire);
    tamperedEntryGrade.rawArtifacts['attention-leadership-review-response'] = JSON.stringify(entryResponse);
    recalculateProofHashes(tamperedEntryGrade);
    const entryGradeVerifier = new Service(join(directory, 'tampered-entry-grade.sqlite'));
    try { assert.throws(() => entryGradeVerifier.analyzeLive(tamperedEntryGrade), /SHARED_PROOF_INVALID/,
      'Service re-derives entry decisions from the retained independent response after raw hashes are recomputed'); }
    finally { entryGradeVerifier.close(); }

    const tamperedAcquisitionMarker = structuredClone(bundle);
    const marker = JSON.parse(tamperedAcquisitionMarker.rawArtifacts['attention-entry-first-acquisition']!) as {
      selectedLeadIds: string[];
    };
    marker.selectedLeadIds = [];
    tamperedAcquisitionMarker.rawArtifacts['attention-entry-first-acquisition'] = JSON.stringify(marker);
    recalculateProofHashes(tamperedAcquisitionMarker);
    const acquisitionMarkerVerifier = new Service(join(directory, 'tampered-acquisition-marker.sqlite'));
    try { assert.throws(() => acquisitionMarkerVerifier.analyzeLive(tamperedAcquisitionMarker), /SHARED_PROOF_INVALID/,
      'Service binds the raw acquisition marker to the validated receipt after rehashing'); }
    finally { acquisitionMarkerVerifier.close(); }

    const strippedLeadershipMarker = structuredClone(bundle);
    const screeningReceipt = JSON.parse(strippedLeadershipMarker.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    delete screeningReceipt.review.entryDecisions;
    strippedLeadershipMarker.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(screeningReceipt);
    recalculateProofHashes(strippedLeadershipMarker);
    const screeningVerifier = new Service(join(directory, 'stripped-binary-entry-marker.sqlite'));
    try { assert.throws(() => screeningVerifier.analyzeLive(strippedLeadershipMarker), /SHARED_(?:PROOF|ATTENTION)_/); }
    finally { screeningVerifier.close(); }

  } finally { rmSync(directory, { recursive: true, force: true }); }
});
test('reviewed inadequate A03 persists as bounded traceability and Service rejects rehashed scope or review forgery', async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const website = 'https://public.example/river-lantern-origin';
  const sourceText = `Token ${target.address}. The River Lantern page describes a community project but provides no dated origin or catalyst source.`;
  const mock = mockedFetch({
    dexValue: [{
      chainId: 'base', pairAddress: 'FixtureRiverLanternOriginPair',
      baseToken: { address: target.address, name: 'River Lantern', symbol: 'RIVER' },
      quoteToken: { address: '0x3333333333333333333333333333333333333333', name: 'USD Coin', symbol: 'USDC' },
      priceUsd: '0.001', liquidity: { usd: '100000' },
      info: { websites: [{ url: website }], socials: [] },
    }],
    searchValue: { results: [] },
    fetchValue: (urls: string[]) => ({ results: urls.map(url => ({ url, final_url: url, text: sourceText })), errors: [] }),
    attentionResponse: packet => {
      if (isSocialModelPacket(packet)) return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'No optional social judgments are present in this sample.' } });
      if (packet.manifest) return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'No common-query representations were acquired.' } });
      if (packet.proposal) {
        const required = packet.requiredDecisionIds as string[];
        const scope = packet.originEvidenceScope as { complete: boolean; sourceIds: string[] };
        assert.equal(scope.complete, true, 'the live collector supplies a complete exact-address origin scope');
        return attentionEnvelope({
          decisions: Object.fromEntries(required.map(id => [id, { accepted: true, rationale: 'The cited source and bounded screening scope support this decision.' }])),
          originScopeReview: { complete: true, sourceIds: [...scope.sourceIds], rationale: 'Every original source in this exact-token sample was independently inspected.' },
          candidateSet: { complete: false, rationale: 'No complete exact-contract comparison set was acquired.' },
          originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No dated primary origin relationship is established.' },
        });
      }
      const typed = packet as AttentionPacket;
      const sourceId = attentionSourceId(packet, target.address);
      return attentionEnvelope({
        claims: [
          { id: 'claim-narrative', feature: 'A01', value: true, summary: 'A River Lantern community project narrative.', citations: [{ sourceId, spanId: attentionSpanId(packet, sourceId, target.address) }] },
          { id: 'claim-origin-screen', feature: 'A03', value: false, summary: 'The bounded sources do not establish this project origin or catalyst.',
            originBasis: 'PUBLIC_EVIDENCE_INADEQUATE', citations: [{ sourceId, spanId: attentionSpanId(packet, sourceId, target.address) }] },
        ],
        posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => [id, { spanId: attentionSpanId(packet, id, target.address), role: 'NEWS' }])),
        competitors: [],
      });
    },
  });

  const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  const receipt = JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as {
    read: { originScope: { complete: boolean; sourceIds: string[] } };
    proposal: { claims: Array<{ id: string; feature: string; value: boolean; originBasis?: string }> };
    review: { originScopeReview: { complete: boolean; sourceIds: string[] } };
  };
  assert.equal(receipt.read.originScope.complete, true);
  assert.deepEqual(receipt.review.originScopeReview.sourceIds, receipt.read.originScope.sourceIds);
  assert.ok(receipt.proposal.claims.some(claim => claim.feature === 'A03' && claim.value === false && claim.originBasis === 'PUBLIC_EVIDENCE_INADEQUATE'));
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A03')?.quality, 'KNOWN');
  assert.equal(bundle.features.find(feature => feature.id === 'A03')?.value, false);
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A01')?.quality, 'KNOWN', 'the separately accepted narrative survives the negative origin grade');
  assert.equal(bundle.semantic.claims.find(claim => claim.kind === 'ORIGIN')?.assertion, 'MODEL_INFERENCE',
    'the scoped screening grade is reported as model-reviewed evidence, not a source-proved fact');
  const screenedClaim = sharedClaims(bundle.details!.baseline, bundle.details!.social).find(claim => claim.id === 'A03');
  assert.ok(screenedClaim);
  assert.match(screenedClaim.statement, /traceability screening grade, not fraud/);
  assert.ok(bundle.details?.shared, 'the Service proof includes the source and Shared derivations');

  const directory = mkdtempSync(join(tmpdir(), 'origin-screen-service-proof-'));
  try {
    const service = new Service(join(directory, 'valid.sqlite'));
    try {
      const saved = service.analyzeLive(bundle);
      assert.deepEqual(service.replay(saved.id), saved);
      assert.match(renderSnapshot(saved, { details: saved.details }), /poor traceability, not a finding of fraud/);
    } finally { service.close(); }

    const rehashProof = (candidate: typeof bundle) => {
      for (const evidence of candidate.evidence) {
        const raw = candidate.rawArtifacts[evidence.id];
        if (raw !== undefined) evidence.contentHash = sha256(raw);
      }
      const proofRecord = candidate.evidence.find(evidence => evidence.id === 'shared-derivation');
      assert.ok(proofRecord);
      const proof = JSON.parse(candidate.rawArtifacts[proofRecord.id]!) as { evidence: typeof candidate.evidence };
      proof.evidence = candidate.evidence.filter(evidence => evidence.id !== proofRecord.id);
      candidate.rawArtifacts[proofRecord.id] = JSON.stringify(proof);
      proofRecord.contentHash = sha256(candidate.rawArtifacts[proofRecord.id]!);
    };
    const rejectRehashed = (change: (candidate: typeof bundle) => void, label: string, expected: RegExp = /SHARED_PROOF_INVALID/) => {
      const candidate = structuredClone(bundle);
      change(candidate);
      rehashProof(candidate);
      const verifier = new Service(join(directory, `${label}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), expected, label); }
      finally { verifier.close(); }
    };
    rejectRehashed(candidate => {
      const value = JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
      value.read.originScope.sourceIds = [];
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(value);
    }, 'rehashed but source-unbound origin scope is rejected');
    rejectRehashed(candidate => {
      const envelope = JSON.parse(candidate.rawArtifacts['attention-review-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      const response = JSON.parse(envelope.candidates[0]!.content.parts[0]!.text) as { originScopeReview: { sourceIds: string[] } };
      response.originScopeReview.sourceIds = [];
      envelope.candidates[0]!.content.parts[0]!.text = JSON.stringify(response);
      candidate.rawArtifacts['attention-review-response'] = JSON.stringify(envelope);
    }, 'rehashed reviewer scope that disagrees with its receipt is rejected');
    rejectRehashed(candidate => {
      const value = JSON.parse(candidate.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
      const read = value.read as unknown as Parameters<typeof originSourceScope>[0];
      read.discoveryUrls = [];
      value.read.originScope = originSourceScope(read, target);
      candidate.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(value);
    }, 'rehashed receipt cannot delete a discovery seed and recompute an incomplete scope', /SOCIAL_SEED_PROOF_INVALID/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Service rejects a rehashed negative A03 scope that drops a blocked exact-token URL', async () => {
  const target = { chain: 'base', address: '0x1111111111111111111111111111111111111111' } as const;
  const website = 'https://public.example/river-lantern-origin';
  const launch = 'https://public.example/river-lantern-launch';
  const sourceText = `Token ${target.address}. The River Lantern page describes a community project but provides no dated origin or catalyst source.`;
  const mock = mockedFetch({
    dexValue: [{
      chainId: 'base', pairAddress: 'FixtureRiverLanternOriginPair',
      baseToken: { address: target.address, name: 'River Lantern', symbol: 'RIVER' },
      quoteToken: { address: '0x3333333333333333333333333333333333333333', name: 'USD Coin', symbol: 'USDC' },
      priceUsd: '0.001', liquidity: { usd: '100000' },
      info: { websites: [{ url: website }], socials: [] },
    }],
    searchValue: (_url, call) => ({ results: call === 0 ? [{ url: website }, { url: launch }] : [] }),
    fetchValue: (urls: string[]) => ({
      results: urls.filter(url => url !== launch).map(url => ({ url, final_url: url, text: sourceText })),
      errors: urls.includes(launch) ? [{ url: launch, error: 'bot_blocked', status: 403 }] : [],
    }),
    attentionResponse: packet => {
      if (isSocialModelPacket(packet)) return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'No optional social judgments are present in this sample.' } });
      if (packet.manifest) return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'No common-query representations were acquired.' } });
      if (packet.proposal) {
        const required = packet.requiredDecisionIds as string[];
        const scope = packet.originEvidenceScope as { complete: boolean; sourceIds: string[]; acquisition: { urls: Array<{ url: string; state: string }> } };
        assert.equal(scope.complete, false);
        assert.equal(scope.acquisition.urls.find(item => item.url === launch)?.state, 'UNAVAILABLE');
        return attentionEnvelope({
          decisions: Object.fromEntries(required.map(id => [id, { accepted: true, rationale: 'The available source supports this bounded screening judgment.' }])),
          originScopeReview: { complete: true, sourceIds: [...scope.sourceIds], rationale: 'Every acquired source was independently inspected.' },
          candidateSet: { complete: false, rationale: 'No complete exact-contract comparison set was acquired.' },
          originRelationship: { status: 'UNKNOWN', citations: [], rationale: 'No dated primary origin relationship is established.' },
        });
      }
      const typed = packet as AttentionPacket;
      const sourceId = attentionSourceId(packet, target.address);
      return attentionEnvelope({
        claims: [{ id: 'claim-origin-screen', feature: 'A03', value: false,
          summary: 'The acquired sample does not establish this project origin or catalyst.', originBasis: 'PUBLIC_EVIDENCE_INADEQUATE',
          citations: [{ sourceId, spanId: attentionSpanId(packet, sourceId, target.address) }] }],
        posts: Object.fromEntries((typed.requiredPostSourceIds ?? []).map(id => [id, { spanId: attentionSpanId(packet, id, target.address), role: 'NEWS' }])),
        competitors: [],
      });
    },
  });

  const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  const receipt = JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as {
    read: { originScope: { complete: boolean; sourceIds: string[]; acquisition: { complete: boolean; urls: Array<{ url: string; state: string }> } } };
    review: { decisions: Array<{ id: string; accepted: boolean }>; originScopeReview: { complete: boolean } };
  };
  assert.equal(receipt.read.originScope.complete, false);
  assert.equal(receipt.read.originScope.acquisition.urls.find(item => item.url === launch)?.state, 'UNAVAILABLE');
  assert.equal(receipt.review.decisions.find(item => item.id === 'claim-origin-screen')?.accepted, true);
  assert.equal(receipt.review.originScopeReview.complete, true);
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A03')?.quality, 'MISSING');

  const directory = mkdtempSync(join(tmpdir(), 'origin-blocked-service-proof-'));
  try {
    const forged = structuredClone(bundle);
    const value = JSON.parse(forged.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    value.read.originScope.complete = true;
    value.read.originScope.acquisition.complete = true;
    value.read.originScope.acquisition.urls = value.read.originScope.acquisition.urls.filter(item => item.url !== launch);
    forged.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(value);
    for (const evidence of forged.evidence) {
      const raw = forged.rawArtifacts[evidence.id];
      if (raw !== undefined) evidence.contentHash = sha256(raw);
    }
    const proofRecord = forged.evidence.find(evidence => evidence.id === 'shared-derivation');
    assert.ok(proofRecord);
    const proof = JSON.parse(forged.rawArtifacts[proofRecord.id]!) as { evidence: typeof forged.evidence };
    proof.evidence = forged.evidence.filter(evidence => evidence.id !== proofRecord.id);
    forged.rawArtifacts[proofRecord.id] = JSON.stringify(proof);
    proofRecord.contentHash = sha256(forged.rawArtifacts[proofRecord.id]!);

    const service = new Service(join(directory, 'forged.sqlite'));
    try { assert.throws(() => service.analyzeLive(forged), /SHARED_PROOF_INVALID/); }
    finally { service.close(); }
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

test('ENTRY_GATES_V1 records an incomplete C05 as known false and persists it through replay', async () => {
  const mock = mockedFetch({ dexValue: [pair(1)] });
  const bundle = await collectLiveSolana(token, liveOptions(mock.fetcher, { semanticEnabled: true }));
  const c05Features = bundle.features.filter(feature => feature.id === 'C05');
  const c05Assessment = bundle.details?.baseline.find(row => row.id === 'C05');
  assert.equal(c05Features.length, 1, 'a legacy C05 with no projection still receives one shared projection');
  assert.equal(bundle.details?.shared?.qualityMode, 'ENTRY_GATES_V1');
  assert.equal(c05Features[0]?.quality, 'KNOWN', 'the explicit gate mode records an incomplete review as a known failed quality gate');
  assert.equal(c05Features[0]?.value, false);
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
      ? 'The initial cross-claim pass records a one-sided comparison conflict.'
      : 'The retained sources show no incompatible assertion for this claim.',
    citations: claim.id === 'A01'
      ? [sourceAClaimRefs[claim.id]]
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
  const resolveProposalForPrompt = (wire: Record<string, { disposition: string; rationale: string; citations: Array<{ sourceId: string; spanId: string }> }>) =>
    Object.entries(wire).map(([id, decision]) => ({
      ...decision,
      id,
      citations: decision.citations.map(ref => {
        const source = sources.find(item => item.id === ref.sourceId)!;
        const span = sourceSpans(source.id, source.text, 'SHARED_MODEL').find(item => item.id === ref.spanId);
        assert.ok(span, `the resolved prompt citation points to an original span ${ref.spanId}`);
        return { sourceId: ref.sourceId, quote: span.text };
      }),
    }));
  const initialResolvedProposal = resolveProposalForPrompt(initialClaims);
  const repairResolvedProposal = resolveProposalForPrompt(repairClaims);
  const review = (acceptA01: boolean) => ({
    claims: Object.fromEntries(claims.map(claim => [claim.id, claim.id === 'A01' ? acceptA01 : true])),
    sources: Object.fromEntries(sources.map(item => [item.id, true])),
  });
  const raw = (value: unknown) => sourceModelRaw({ claims: value && typeof value === 'object' && 'claims' in value
    ? (value as { claims: unknown }).claims : value });
  const proposalResponse = raw({ claims: initialClaims });
  const reviewResponse = sourceModelRaw(review(true));
  const repairProposalResponse = raw({ claims: repairClaims });
  const repairReviewResponse = sourceModelRaw(review(true));
  const audit = decodeSharedAudit(claims, sources, repairProposalResponse, repairReviewResponse);
  const initialAudit = decodeSharedAudit(claims, sources, proposalResponse, reviewResponse);
  assert.equal(initialAudit.review.find(item => item.id === 'A01')?.accepted, true);
  assert.deepEqual(sharedReassessmentIds(initialAudit), ['A01'], 'the locally detected one-sided conflict is the repair trigger');
  assert.equal(validSharedReassessment(initialAudit, audit), true);
  assert.equal(deriveShared({ ...fixture, social: undefined, claims, sources, audit }).facts.values.C06, true);

  const modelScope = { method: 'automated-source-review-v1', model: 'fixture' };
  for (const [id, content, sourceType] of [
    ['shared-proposal-prompt', sharedAuditPrompt('proposal', claims, sources, bundle.token), 'MODEL_INPUT'],
    ['shared-proposal-response', proposalResponse, 'MODEL_RESPONSE'],
    ['shared-review-prompt', sharedAuditPrompt('review', claims, sources, bundle.token, { proposal: initialResolvedProposal }), 'MODEL_INPUT'],
    ['shared-review-response', reviewResponse, 'MODEL_RESPONSE'],
    ['shared-repair-proposal-prompt', sharedAuditPrompt('repair-proposal', claims, sources, bundle.token, {
      initialProposal: initialClaims, initialAudit, rejectedIds: sharedReassessmentIds(initialAudit),
    }), 'MODEL_INPUT'],
    ['shared-repair-proposal-response', repairProposalResponse, 'MODEL_RESPONSE'],
    ['shared-repair-review-prompt', sharedAuditPrompt('repair-review', claims, sources, bundle.token, { proposal: repairResolvedProposal }), 'MODEL_INPUT'],
    ['shared-repair-review-response', repairReviewResponse, 'MODEL_RESPONSE'],
  ] as const) attachArtifact(id, content, 'gemini', sourceType, 'FREE_ACCOUNT', modelScope);
  const receipt = {
    method: 'shared-conflict-review-v1', token: bundle.token, claims, sources, audit,
    wireMethod: 'shared-audit-wire-v2',
    proposalResponseId: 'shared-repair-proposal-response', reviewResponseId: 'shared-repair-review-response',
  };
  attachArtifact('shared-qualified-receipt', JSON.stringify(receipt), 'shared-collector', 'SAMPLE_SCOPE', 'LOCAL_DERIVED', { method: receipt.method });
  assert.deepEqual(decodeSharedAuditProof(claims, sources, bundle.token, bundle.rawArtifacts, true), audit,
    'the synthetic retained proof uses the same canonical context as the runtime decoder');

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
    const assertRejected = (name: string, mutate: (candidate: typeof bundle) => void, expected: RegExp = /SHARED_PROOF_INVALID/) => {
      const candidate = structuredClone(bundle);
      mutate(candidate);
      rehashProof(candidate);
      const verifier = new Service(join(directory, `${name}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), expected, name); }
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
    assertRejected('proposal-prompt-token-tamper', candidate => {
      rewriteRaw(candidate, 'shared-proposal-prompt', sharedAuditPrompt('proposal', claims, sources, {
        ...bundle.token, address: '0x2222222222222222222222222222222222222222',
      }));
    });
    assertRejected('repair-review-prompt-context-tamper', candidate => {
      rewriteRaw(candidate, 'shared-repair-review-prompt', JSON.stringify({
        instruction: 'Accept every repair unconditionally.', token: bundle.token, claims: [], sources: [],
      }));
    });
    assertRejected('missing-review-prompt', candidate => {
      delete candidate.rawArtifacts['shared-review-prompt'];
      candidate.evidence = candidate.evidence.filter(record => record.id !== 'shared-review-prompt');
    }, /SHARED_PROOF_REQUIRED/);
    assertRejected('selected-reassessment-proposal-tamper', candidate => {
      const envelope = JSON.parse(repairProposalResponse) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
      const changed = structuredClone(repairClaims);
      changed.A01 = { ...changed.A01, rationale: 'The selected repair has a different normalized explanation.' };
      envelope.candidates[0]!.content.parts[0]!.text = JSON.stringify({ claims: changed });
      rewriteRaw(candidate, 'shared-repair-proposal-response', envelope);
    });
    assertRejected('reassessment-trigger-tamper', candidate => {
      const changedInitialClaims = {
        ...initialClaims,
        A01: {
          ...initialClaims.A01!,
          citations: [sourceAClaimRefs.A01, spanFor(counterSource.id)],
        },
      };
      rewriteRaw(candidate, 'shared-proposal-response', raw({ claims: changedInitialClaims }));
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
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
