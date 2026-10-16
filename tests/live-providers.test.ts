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
  assert.equal(attentionModelCalls, 8, JSON.stringify(result.semantic));
  assert.equal(attentionPackets.length, 8, 'base, v3 lead accounting, full comparison and support review calls are retained');
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
  assert.equal(retainedScope.comparisonComplete, true, result.rawArtifacts['attention-comparison-coverage']);
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
    const effective = JSON.parse(bundle.rawArtifacts['attention-scope']!) as {
      comparisonComplete: boolean; comparisonAcquisition: { originalComplete: boolean; leads: Array<{ id: string; acquisitionStatus: string; recoverySourceIds: string[] }> };
        comparisonQualification: { mode: string; accountingComplete: boolean; decisions: Array<{ leadId: string; accounted: boolean; qualified: boolean;
          accounting: { status: string; basis: string }; representation: { status: string } }> };
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
    const firstCanonicalRequestIndex = mock.calls.findIndex(call => {
      if (!call.url.startsWith('https://rpc.example/') && !call.url.startsWith('https://api.mainnet.solana.com')) return false;
      return JSON.parse(String(call.init?.body)).method !== 'getMultipleAccounts';
    });

    assert.equal(bundle.analysisKind, 'LIVE');
    assert.equal(original.comparisonComplete, false);
    assert.equal(original.comparisonAcquisition.originalComplete, false);
    assert.equal(original.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-2')?.acquisitionStatus, 'FAILED');
    assert.equal(original.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-3')?.acquisitionStatus, 'FAILED');
    assert.equal(effective.comparisonComplete, true, JSON.stringify({
      qualification: effective.comparisonQualification.decisions.map(decision => [decision.leadId, decision.accounting.status, decision.accounted, decision.representation.status, decision.qualified]),
      coverage: bundle.rawArtifacts['attention-comparison-coverage'],
    }));
    assert.equal(effective.comparisonAcquisition.originalComplete, false, 'effective qualification preserves the failed original acquisition state');
    assert.equal(effective.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-2')?.acquisitionStatus, 'FAILED');
    assert.equal(effective.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-3')?.acquisitionStatus, 'FAILED');
    assert.equal(effective.comparisonQualification.mode, 'qualified-identified-leads-v3');
    assert.equal(effective.comparisonQualification.accountingComplete, true);
    assert.deepEqual(effective.comparisonQualification.decisions.map(decision => [decision.accounting.status, decision.accounted, decision.representation.status, decision.qualified]), [
      ['ACCOUNTED', true, 'BOUND', true], ['ACCOUNTED', true, 'UNRELATED', true], ['ACCOUNTED', true, 'UNRELATED', true],
    ]);
    assert.equal(effective.comparisonQualification.decisions[1]?.accounting.basis, 'RECOVERED_ENTITY');
    assert.equal(effective.comparisonQualification.decisions[2]?.accounting.basis, 'RECOVERED_ENTITY',
      'different-host recovery accounts the indexed feline-art entity, not its unread original page');
    assert.deepEqual(effective.comparisonQualification.decisions.slice(1).map(decision => decision.representation.status), ['UNRELATED', 'UNRELATED']);
    assert.ok(effective.comparisonAcquisition.leads.find(lead => lead.id === 'comparison-lead-3')?.recoverySourceIds.length,
      'the unrelated lead is backed by recovered, retained sources');
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
    const comparisonCoverage = JSON.parse(bundle.rawArtifacts['attention-comparison-coverage']!) as {
      complete: boolean; sourceRequirements: Array<{ sourceId: string; obligation: string }>;
    };
    const retainedFooterId = Object.entries(bundle.rawArtifacts).find(([, raw]) => raw === footerText)?.[0];
    assert.ok(retainedFooterId, 'the actual fetched footer is retained as a source artifact');
    assert.equal(comparisonCoverage.complete, true);
    assert.equal(comparisonCoverage.sourceRequirements.find(item => item.sourceId === retainedFooterId)?.obligation,
      'OPTIONAL_UNUSABLE_SUPPLEMENT');
    const sharedProof = JSON.parse(bundle.rawArtifacts['shared-derivation']!) as { sources: Array<{ id: string; text: string }> };
    assert.ok(sharedProof.sources.some(source => source.id === retainedFooterId && source.text.includes(footerText)),
      'the optional footer remains in the full audited Shared source catalog');
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

    const forgedCoverage = structuredClone(bundle);
    const coverageEvidence = forgedCoverage.evidence.find(item => item.id === 'attention-comparison-coverage');
    assert.ok(coverageEvidence, 'locally derived coverage has a retained provenance record');
    const forgedLocalCoverage = JSON.parse(forgedCoverage.rawArtifacts[coverageEvidence.id]!) as { complete: boolean };
    forgedLocalCoverage.complete = false;
    forgedCoverage.rawArtifacts[coverageEvidence.id] = JSON.stringify(forgedLocalCoverage);
    coverageEvidence.contentHash = sha256(forgedCoverage.rawArtifacts[coverageEvidence.id]!);
    assert.equal(forgedCoverage.rawArtifacts['attention-comparison-final-review-response'],
      bundle.rawArtifacts['attention-comparison-final-review-response'], 'the tamper leaves Gemini review bytes unchanged');
    const comparisonResponseIds = Object.keys(bundle.rawArtifacts).filter(id => /^attention-comparison-.*-response$/.test(id));
    assert.ok(comparisonResponseIds.length > 0);
    for (const id of comparisonResponseIds) assert.equal(forgedCoverage.rawArtifacts[id], bundle.rawArtifacts[id],
      `the local coverage tamper leaves ${id} unchanged`);
    const verifier = new Service(join(directory, 'forged-coverage.sqlite'));
    try {
      assert.throws(() => verifier.analyzeLive(forgedCoverage), /SHARED_PROOF_INVALID/,
        'rehashed locally derived coverage cannot contradict the raw model proof and replayed source requirements');
    } finally {
      verifier.close();
    }

    type LocalComparisonReceipt = {
      read: {
        comparisonAcquisition: { leads: Array<{ id: string; sourceIds: string[]; recoverySourceIds: string[] }> };
        comparisonQualification: { decisions: Array<{ leadId: string; qualified: boolean }> };
        sources: Array<{ id: string }>;
      };
    };
    const rejectRehashedReceipt = (name: string, mutate: (receipt: LocalComparisonReceipt) => void) => {
      const forged = structuredClone(bundle);
      const receiptRecord = forged.evidence.find(item => item.id === 'attention-qualified-receipt');
      assert.ok(receiptRecord);
      const receipt = JSON.parse(forged.rawArtifacts[receiptRecord.id]!) as LocalComparisonReceipt;
      mutate(receipt);
      forged.rawArtifacts[receiptRecord.id] = JSON.stringify(receipt);
      receiptRecord.contentHash = sha256(forged.rawArtifacts[receiptRecord.id]!);
      const receiptVerifier = new Service(join(directory, `${name}.sqlite`));
      try {
        assert.throws(() => receiptVerifier.analyzeLive(forged), /SHARED_(?:PROOF|SOURCE)_(?:INVALID|REQUIRED)/, name);
      } finally {
        receiptVerifier.close();
      }
    };
    rejectRehashedReceipt('locally-forged-qualified-unrelated-lead', receipt => {
      receipt.read.comparisonQualification.decisions.find(item => item.leadId === 'comparison-lead-3')!.qualified = false;
    });
    rejectRehashedReceipt('locally-forged-recovery-parent-lineage', receipt => {
      receipt.read.comparisonAcquisition.leads.find(item => item.id === 'comparison-lead-3')!.recoverySourceIds = [];
    });
    rejectRehashedReceipt('locally-deleted-original-comparison-source', receipt => {
      receipt.read.sources = receipt.read.sources.filter(source => source.id !== 'attention-page-1');
    });
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
  const wrappedMarketUrl = `/url?opi=79508299&q=${encodeURIComponent(marketUrl)}&sa=U&ved=2ahUKEwi-test&usg=AOvVaw-public`;
  const recoveredMarketUrl = 'https://index.example/river-lantern-market-record';
  const targetUrl = 'https://public.example/river-lantern-project';
  const postUrls = [
    'https://x.com/first_writer/status/7101',
    'https://x.com/second_writer/status/7102',
  ];
  const postText = new Map(postUrls.map((url, index) => [url, `Unrelated gardening note ${index + 1}; this post does not discuss a token or project.`]));
  const title = 'River Lantern / USDC pair on DexScreener';
  const snippet = 'DexScreener lists a River Lantern market pair on Base with pair and liquidity data only, without project narrative or origin context.';
  const marketText = `Token ${target.address}. A market index lists a River Lantern pair and trading data only; it contains no project narrative or origin description.`;
  const targetText = `Token ${target.address}. River Lantern token metadata lists a deployment index and a Base contract. No project description, narrative, mechanism, or explanation is provided.`;
  const mock = mockedFetch({
    dexValue: [pair(0, { chainId: 'base', baseToken: { address: target.address, name: 'River Lantern' }, quoteToken: { address: '0x3333333333333333333333333333333333333333' } })],
    searchValue: (requestUrl, call) => call === 0
      ? { results: [
        { url: targetUrl, title: 'River Lantern project', snippet: `Token ${target.address}` },
        ...postUrls.map(url => ({ url, title: 'Unrelated gardening note', snippet: 'A general gardening update.' })),
      ] }
      : call === 2
        ? { results: [{ url: wrappedMarketUrl, title, snippet }] }
        : call > 2 && new URL(requestUrl).searchParams.get('query')?.includes('River Lantern')
          ? { results: [{ url: recoveredMarketUrl, title: 'River Lantern market index record', snippet: 'The index repeats pair and liquidity details without project narrative.' }] }
          : { results: [] },
    fetchValue: (urls: string[]) => ({
      results: urls.filter(url => url !== marketUrl).map(url => ({
        url, final_url: url,
        text: url === recoveredMarketUrl ? marketText : postText.get(url) ?? targetText,
        ...(postText.has(url) ? { published_date: '2026-09-29T11:00:00.000Z' } : {}),
      })),
      errors: urls.includes(marketUrl) ? [{ url: marketUrl, status: 404, error: 'not_found' }] : [],
    }),
    attentionResponse: packet => {
      if (isSocialModelPacket(packet)) return attentionEnvelope({ decisions: {}, candidateSet: { complete: false, rationale: 'This fixture leaves optional social judgments unresolved.' } });
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
          decisions: {
            NARRATIVE_DESCRIPTION: { accepted: true, rationale: 'The full scope supports the bounded narrative-support gap.' },
            EXPLAINABLE_THESIS: { accepted: true, rationale: 'The full scope supports the bounded explanation-support gap.' },
          },
        });
        return attentionEnvelope({
          sourceSupport: Object.fromEntries(sources.map(source => {
            const own = source.spans.find(span => span.text.includes(target.address));
            return [source.id, own
              ? { status: 'PUBLIC_SUPPORT_GAP', criteria: ['NARRATIVE_DESCRIPTION', 'EXPLAINABLE_THESIS'],
                rationale: 'This exact-token metadata identifies deployment but supplies no project narrative or explanation.',
                citations: [{ sourceId: source.id, spanId: own.id }] }
              : { status: 'CONTEXT_ONLY', criteria: [], rationale: 'This original source is contextual and does not provide a token-bound narrative.', citations: [] }];
          })),
          judgments: Object.fromEntries(['NARRATIVE_DESCRIPTION', 'EXPLAINABLE_THESIS'].map(criterion => [criterion, {
            verdict: 'INADEQUATE', rationale: `The complete reviewed scope does not establish ${criterion}.`,
            citations: [{ sourceId: cited.source.id, spanId: cited.span.id }],
          }])),
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
          accepted: id !== 'claim-topic', rationale: id === 'claim-topic'
            ? 'The exact-token deployment metadata does not support the proposed community-project narrative.'
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

  const bundle = await collectLiveToken(target, liveOptions(mock.fetcher, {
    tinyfishKey: TINYFISH_KEY, geminiKey: nextGeminiKey(), semanticEnabled: true,
  }));
  const receipt = JSON.parse(bundle.rawArtifacts['attention-qualified-receipt']!) as {
    read: { sources: Array<{ id: string; url: string; text: string; kind: 'POST' | 'PAGE' }>; narrativePublicSupport?: { method: string; judgments: Record<string, { verdict: string; review: { accepted: boolean } }> };
      comparisonAcquisition: { originalComplete: boolean }; comparisonQualification: { mode: string; wireMethod: string; accountingComplete: boolean;
      entryDecisionMethod?: string; entryScopeMethod?: string; entryCitationMethod?: string;
      decisions: Array<{ leadId: string; accounted: boolean; accounting: { status: string; role: string }; representation: { status: string } }>;
    }; comparisonCoverage?: { complete: boolean }; comparisonPublicSupport?: {
      method: string; verdict: string; review: { accepted: boolean }; decision?: { verdict: string; rationale: string }; researchComplete?: boolean;
      leadScopes: Array<{ status: string; basis: string; role: string; review: { accepted: boolean } }>;
      sourceSupport: Array<{ status: string; accepted: boolean; inspectionComplete: boolean }>;
      bodyObservations?: Array<{ sourceId: string; bodyRole: { kind: string }; description: { kind: string; citations: unknown } }>;
      entry?: { sourceSupport: Record<string, { status: string }>; grade: { citations: unknown } };
    } };
    proposal: { claims: Array<{ id: string; feature: string; value: boolean; summary: string }>; posts: Array<{ id: string; sourceId: string; role: string }>; competitors: Array<{ id: string }> };
    review: { candidateSet: { complete: boolean }; decisions: Array<{ id: string; accepted: boolean }>;
      entryDecisions?: { method: string; originTraceability: { verdict: string }; leadership: { verdict: string } };
      leadershipScreening?: { method: string; verdict: string; review: { accepted: boolean };
        originTraceability: { verdict: string; review: { accepted: boolean } } } };
  };
  assert.equal(receipt.read.comparisonQualification.mode, 'qualified-identified-leads-v3', JSON.stringify({
    qualification: bundle.rawArtifacts['comparison-lead-qualification'],
    rawProposal: bundle.rawArtifacts['attention-comparison-lead-proposal-response'],
    artifacts: Object.keys(bundle.rawArtifacts).filter(key => key.includes('comparison-lead')),
  }));
    assert.equal(receipt.read.comparisonQualification.wireMethod, 'comparison-lead-tasks-v5',
    'the fresh Service proof reconstructs the authoritative-basis task wire');
  assert.equal(receipt.read.comparisonQualification.entryDecisionMethod, 'binary-public-support-v1');
  assert.equal(receipt.read.comparisonQualification.entryCitationMethod, 'single-required-citation-v1');
  assert.equal(receipt.review.entryDecisions?.method, 'binary-public-support-v1');
  assert.deepEqual([receipt.review.entryDecisions?.originTraceability.verdict,
    receipt.review.entryDecisions?.leadership.verdict], ['FAIL', 'PASS'],
  'the fresh Service proof preserves distinct independently reviewed origin and leadership outcomes');
  assert.equal(receipt.read.comparisonQualification.entryScopeMethod, 'code-owned-origin-scope-v1');
  for (const id of ['attention-leadership-proposal-response', 'attention-leadership-review-response']) {
    const envelope = JSON.parse(bundle.rawArtifacts[id]!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    const rawDecision = JSON.parse(envelope.candidates[0]!.content.parts[0]!.text) as Record<string, unknown>;
    assert.equal('sourceIds' in rawDecision, false, `${id} relies on the supplied code-owned origin catalog`);
    if (id === 'attention-leadership-review-response') {
      const origin = rawDecision.originTraceability as Record<string, unknown>;
      const leadership = rawDecision.leadership as Record<string, unknown>;
      assert.ok(origin.citation && typeof origin.citation === 'object', 'the fresh final wire requires one citation object for origin traceability');
      assert.ok(leadership.citation && typeof leadership.citation === 'object', 'the fresh final wire requires one citation object for leadership');
      assert.equal('citations' in origin, false, 'the final wire does not use the legacy citation array');
      assert.equal('citations' in leadership, false, 'the final wire does not use the legacy citation array');
    }
  }
  const publicProposalEnvelope = JSON.parse(bundle.rawArtifacts['attention-comparison-support-proposal-response']!) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  const publicProposalWire = JSON.parse(publicProposalEnvelope.candidates[0]!.content.parts[0]!.text) as {
    leadRoles: Array<{ leadId: string; descriptorRef?: { sourceId: string; spanId: string }; descriptorRefs?: unknown }>;
  };
  assert.equal(publicProposalWire.leadRoles.length, 1);
  assert.equal(publicProposalWire.leadRoles[0]!.descriptorRef?.sourceId, receipt.read.comparisonQualification.decisions[0]!.leadId + '-metadata',
    'the Service fixture retains the exact v4 singular selector against its own indexed descriptor');
  assert.ok(publicProposalWire.leadRoles[0]!.descriptorRef?.spanId);
  assert.equal(publicProposalWire.leadRoles[0]!.descriptorRefs, undefined,
    'the original v4 Service proof does not rewrite the singular wire field to an array');
  assert.equal(receipt.read.comparisonAcquisition.originalComplete, false, 'the original DexScreener body remains failed');
  assert.equal(receipt.read.comparisonQualification.accountingComplete, false, 'the index recovery does not manufacture factual accounting');
  assert.deepEqual(receipt.read.comparisonQualification.decisions.map(item => [item.accounted, item.accounting.status, item.accounting.role, item.representation.status]),
    [[false, 'UNRESOLVED', 'MARKET_OR_INDEX_RECORD', 'UNRESOLVED']],
    'entry public-support grading must not promote the independent factual representation axis');
  assert.equal(receipt.read.comparisonPublicSupport?.verdict, 'INADEQUATE');
  assert.equal(receipt.read.comparisonPublicSupport?.review.accepted, true);
  assert.equal(receipt.read.comparisonPublicSupport?.method, 'comparison-public-support-v6');
  assert.equal(receipt.read.comparisonPublicSupport?.decision?.verdict, 'FAIL');
  assert.equal(receipt.read.comparisonPublicSupport?.researchComplete, true);
  assert.deepEqual(receipt.read.comparisonPublicSupport?.leadScopes.map(scope => [scope.status, scope.basis, scope.role, scope.review.accepted]),
    [['REVIEWED', 'REVIEWED_MARKET_RECOVERY', 'MARKET_OR_INDEX_RECORD', true]],
    'the accepted negative grade records a reviewed own market scope without changing factual acquisition');
  assert.equal(receipt.read.comparisonPublicSupport?.sourceSupport.some(source => source.status === 'PUBLIC_SUPPORT_GAP'), false,
    'the actual required source does not use the separate public-support-gap status');
  const unresolvedMarketSource = receipt.read.sources.find(source => source.text.includes('market index lists'));
  assert.ok(unresolvedMarketSource);
  const publicSupport = receipt.read.comparisonPublicSupport;
  assert.ok(publicSupport?.bodyObservations && publicSupport.entry);
  const marketBodyObservation = publicSupport.bodyObservations.find(observation => observation.sourceId === unresolvedMarketSource.id
    && observation.bodyRole.kind === 'MARKET_OR_INDEX_RECORD' && observation.description.kind === 'MARKET_FIELDS_OR_BOILERPLATE');
  assert.ok(marketBodyObservation);
  assert.equal(publicSupport.entry.sourceSupport[unresolvedMarketSource.id]?.status, 'BINDING_EVIDENCE');
  assert.deepEqual(publicSupport.entry.grade.citations, marketBodyObservation.description.citations,
    'the reviewed inadequate grade and positively binding support select the exact same full-body quote');
  assert.equal(receipt.read.narrativePublicSupport?.method, 'narrative-public-support-v1');
  assert.equal(receipt.read.narrativePublicSupport?.judgments.NARRATIVE_DESCRIPTION?.verdict, 'INADEQUATE');
  assert.equal(receipt.read.narrativePublicSupport?.judgments.NARRATIVE_DESCRIPTION?.review.accepted, true);
  assert.equal(receipt.read.narrativePublicSupport?.judgments.EXPLAINABLE_THESIS?.review.accepted, true);
  assert.equal(receipt.proposal.claims[0]?.value, true, 'the original unsupported factual narrative proposal is retained');
  assert.equal(receipt.review.decisions.find(item => item.id === 'claim-topic')?.accepted, false,
    'the inadequate-support grade does not promote the rejected factual narrative');
  assert.equal(receipt.read.comparisonCoverage?.complete, false, 'the negative grade leaves raw candidate coverage false');
  assert.equal(receipt.review.candidateSet.complete, false);
  const bodyReviewEnvelope = JSON.parse(bundle.rawArtifacts['attention-comparison-1-review-response']!) as {
    candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
  };
  const bodyReview = JSON.parse(bodyReviewEnvelope.candidates[0]!.content.parts[0]!.text) as {
    sourceDecisions: {
      withLiteralObservations: Array<{ sourceId: string; disposition: string; insufficiencyKind: string }>;
      withoutLiteralObservations: Array<{ sourceId: string; disposition: string; insufficiencyKind: string }>;
    };
  };
  assert.ok(bodyReview.sourceDecisions.withLiteralObservations.some(decision => decision.sourceId === unresolvedMarketSource.id),
    'the market body carries a literal mint while factual acquisition remains unresolved');
  const unresolvedMarketDecision = bodyReview.sourceDecisions.withLiteralObservations.find(decision => decision.sourceId === unresolvedMarketSource.id);
  assert.deepEqual([unresolvedMarketDecision?.disposition, unresolvedMarketDecision?.insufficiencyKind], ['INSUFFICIENT', 'UNRESOLVED_MEANING_OR_ASSOCIATION'],
    'clear market-body observations can support public review while the exact factual token association stays unresolved');
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
  assert.equal(bundle.details?.baseline.find(row => row.id === 'A14')?.projection?.value, true,
    'the independently reviewed leadership PASS is separate from the origin-traceability FAIL');
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
    const tampered = structuredClone(bundle);
    const raw = JSON.parse(tampered.rawArtifacts['attention-comparison-support-proposal-response']!) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    const wire = JSON.parse(raw.candidates[0]!.content.parts[0]!.text) as { verdict: string };
    wire.verdict = 'UNRESOLVED';
    raw.candidates[0]!.content.parts[0]!.text = JSON.stringify(wire);
    tampered.rawArtifacts['attention-comparison-support-proposal-response'] = JSON.stringify(raw);
    recalculateProofHashes(tampered);
    const verifier = new Service(join(directory, 'tampered.sqlite'));
    try { assert.throws(() => verifier.analyzeLive(tampered), /SHARED_(?:PROOF|ATTENTION)_/); }
    finally { verifier.close(); }

    const strippedLeadershipMarker = structuredClone(bundle);
    const screeningReceipt = JSON.parse(strippedLeadershipMarker.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    delete screeningReceipt.review.entryDecisions;
    strippedLeadershipMarker.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(screeningReceipt);
    recalculateProofHashes(strippedLeadershipMarker);
    const screeningVerifier = new Service(join(directory, 'stripped-binary-entry-marker.sqlite'));
    try { assert.throws(() => screeningVerifier.analyzeLive(strippedLeadershipMarker), /SHARED_(?:PROOF|ATTENTION)_/); }
    finally { screeningVerifier.close(); }

    const strippedOriginCatalogMarker = structuredClone(bundle);
    const originCatalogReceipt = JSON.parse(strippedOriginCatalogMarker.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    delete originCatalogReceipt.read.comparisonQualification.entryScopeMethod;
    strippedOriginCatalogMarker.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(originCatalogReceipt);
    recalculateProofHashes(strippedOriginCatalogMarker);
    const originCatalogVerifier = new Service(join(directory, 'stripped-origin-catalog-marker.sqlite'));
    try { assert.throws(() => originCatalogVerifier.analyzeLive(strippedOriginCatalogMarker), /SHARED_(?:PROOF|ATTENTION)_/); }
    finally { originCatalogVerifier.close(); }

    const strippedCitationMarker = structuredClone(bundle);
    const citationReceipt = JSON.parse(strippedCitationMarker.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    delete citationReceipt.read.comparisonQualification.entryCitationMethod;
    strippedCitationMarker.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(citationReceipt);
    recalculateProofHashes(strippedCitationMarker);
    const citationMarkerVerifier = new Service(join(directory, 'stripped-single-citation-marker.sqlite'));
    try { assert.throws(() => citationMarkerVerifier.analyzeLive(strippedCitationMarker), /SHARED_(?:PROOF|ATTENTION)_/); }
    finally { citationMarkerVerifier.close(); }

    const tamperedNarrative = structuredClone(bundle);
    const narrativeEnvelope = JSON.parse(tamperedNarrative.rawArtifacts['attention-narrative-support-proposal-response']!) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const narrativeWire = JSON.parse(narrativeEnvelope.candidates[0]!.content.parts[0]!.text) as {
      judgments: Record<string, { verdict: string }>;
    };
    narrativeWire.judgments.NARRATIVE_DESCRIPTION!.verdict = 'UNRESOLVED';
    narrativeEnvelope.candidates[0]!.content.parts[0]!.text = JSON.stringify(narrativeWire);
    tamperedNarrative.rawArtifacts['attention-narrative-support-proposal-response'] = JSON.stringify(narrativeEnvelope);
    recalculateProofHashes(tamperedNarrative);
    const narrativeVerifier = new Service(join(directory, 'tampered-narrative.sqlite'));
    try { assert.throws(() => narrativeVerifier.analyzeLive(tamperedNarrative), /SHARED_(?:PROOF|ATTENTION)_/); }
    finally { narrativeVerifier.close(); }

    const pluralDescriptorWire = structuredClone(bundle);
    const descriptorEnvelope = JSON.parse(pluralDescriptorWire.rawArtifacts['attention-comparison-support-proposal-response']!) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const descriptorProposal = JSON.parse(descriptorEnvelope.candidates[0]!.content.parts[0]!.text) as {
      leadRoles: Array<{ descriptorRef?: { sourceId: string; spanId: string }; descriptorRefs?: Array<{ sourceId: string; spanId: string }> }>;
    };
    for (const row of descriptorProposal.leadRoles) {
      assert.ok(row.descriptorRef, 'the accepted proof starts with the v4 singular selector');
      row.descriptorRefs = [row.descriptorRef];
      delete row.descriptorRef;
    }
    descriptorEnvelope.candidates[0]!.content.parts[0]!.text = JSON.stringify(descriptorProposal);
    pluralDescriptorWire.rawArtifacts['attention-comparison-support-proposal-response'] = JSON.stringify(descriptorEnvelope);
    recalculateProofHashes(pluralDescriptorWire);
    const pluralDescriptorVerifier = new Service(join(directory, 'plural-descriptor-wire.sqlite'));
    try { assert.throws(() => pluralDescriptorVerifier.analyzeLive(pluralDescriptorWire), /SHARED_(?:PROOF|ATTENTION)_/); }
    finally { pluralDescriptorVerifier.close(); }

    const downgradedScope = structuredClone(bundle);
    const downgradedReceipt = JSON.parse(downgradedScope.rawArtifacts['attention-qualified-receipt']!) as typeof receipt;
    downgradedReceipt.read.comparisonPublicSupport!.method = 'comparison-public-support-v2';
    downgradedReceipt.read.comparisonPublicSupport!.leadScopes = [];
    downgradedReceipt.read.comparisonPublicSupport!.sourceSupport = [];
    downgradedScope.rawArtifacts['attention-qualified-receipt'] = JSON.stringify(downgradedReceipt);
    recalculateProofHashes(downgradedScope);
    const downgradeVerifier = new Service(join(directory, 'downgraded-public-scope.sqlite'));
    try { assert.throws(() => downgradeVerifier.analyzeLive(downgradedScope), /SHARED_(?:PROOF|ATTENTION)_/); }
    finally { downgradeVerifier.close(); }
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
    const rejectRehashed = (change: (candidate: typeof bundle) => void, label: string) => {
      const candidate = structuredClone(bundle);
      change(candidate);
      rehashProof(candidate);
      const verifier = new Service(join(directory, `${label}.sqlite`));
      try { assert.throws(() => verifier.analyzeLive(candidate), /SHARED_PROOF_INVALID/, label); }
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
    }, 'rehashed receipt cannot delete a discovery seed and recompute an incomplete scope');
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
