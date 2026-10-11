import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { OFFLINE_PUMP_AMM_PROGRAM as sdk, PUMP_AMM_PROGRAM_ID, GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA, userVolumeAccumulatorPda, coinCreatorVaultAuthorityPda, poolPda } from '@pump-fun/pump-swap-sdk';
import { collectAdvisoryWindow, decodeAdvisoryWindow, deriveO28Window } from '../src/providers/advisory-window.js';
import { encodeSolanaAddress, SOLANA_MAINNET_GENESIS } from '../src/providers/solana.js';

const token = { chain: 'solana' as const, address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const user = new PublicKey(Buffer.alloc(32, 4)), baseVault = new PublicKey(Buffer.alloc(32, 5)), quoteVault = new PublicKey(Buffer.alloc(32, 6));
const creator = new PublicKey(Buffer.alloc(32, 7)), program = PUMP_AMM_PROGRAM_ID.toBase58();
const pool = poolPda(0, creator, new PublicKey(token.address), NATIVE_MINT).toBase58();
const end = '2026-10-11T12:00:00.000Z', cutoff = '2026-10-11T12:01:00.000Z';
const endSeconds = Date.parse(end) / 1000, startSeconds = endSeconds - 3600;
type Row = { signature: string; slot: number; blockTime: number | null; err: unknown; confirmationStatus: string };
type RpcRequest = { method: string; params: unknown[] };
const sig = (id: number) => { const bytes = Buffer.alloc(64, 8); bytes.writeUInt32LE(id); return encodeSolanaAddress(bytes); };
const row = (id: number, blockTime: number | null, err: unknown = null): Row => ({ signature: sig(id), slot: 10_000 - id, blockTime, err, confirmationStatus: 'finalized' });
function defaults(name: string): any {
  const type = sdk.idl.types!.find(t => t.name === name)!;
  const result: Record<string, unknown> = {};
  for (const f of (type.type as any).fields) result[f.name] = f.type === 'pubkey' ? user : f.type === 'bool' ? false : f.type === 'string' ? 'buy' : f.type === 'u8' || f.type === 'u16' ? 0 : new BN(0);
  return result;
}
function swap(reference: Row, side: 'BUY' | 'SELL' = 'BUY', quote = '9007199254740993'): any {
  const eventName = side === 'BUY' ? 'buyEvent' : 'sellEvent';
  const event = { ...defaults(eventName), timestamp: new BN(reference.blockTime!), pool: new PublicKey(pool), user,
    userBaseTokenAccount: baseVault, userQuoteTokenAccount: quoteVault, poolBaseTokenReserves: new BN(100000), poolQuoteTokenReserves: new BN(1000000),
    baseAmountOut: new BN(500), baseAmountIn: new BN(500), quoteAmountIn: new BN(quote), quoteAmountOut: new BN(quote), quoteAmountInWithLpFee: new BN(quote), quoteAmountOutWithoutLpFee: new BN(quote), userQuoteAmountIn: new BN(quote), userQuoteAmountOut: new BN(quote) };
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(x => x.name === eventName)!.discriminator), sdk.coder.types.encode(eventName, event)]).toString('base64');
  const data = sdk.coder.instruction.encode(side === 'BUY' ? 'buy' : 'sell', side === 'BUY' ? { baseAmountOut: new BN(500), maxQuoteAmountIn: new BN(quote), trackVolume: { 0: true } } : { baseAmountIn: new BN(500), minQuoteAmountOut: new BN(0) });
  const accounts = [pool, user.toBase58(), user.toBase58(), token.address, NATIVE_MINT.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), baseVault.toBase58(), quoteVault.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), user.toBase58(), program];
  return { version: 1, slot: reference.slot, blockTime: reference.blockTime, transaction: { signatures: [reference.signature], message: {
    accountKeys: [...new Set(accounts)].map(pubkey => ({ pubkey, signer: pubkey === user.toBase58() })), instructions: [{ programId: program, accounts, data: encodeSolanaAddress(data) }] } },
    meta: { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [], logMessages: [`Program ${program} invoke [1]`, `Program data: ${payload}`, `Program ${program} success`] } };
}
const v2Methods = ['buy_v2', 'buy_exact_quote_in_v2', 'sell_v2'] as const;
type V2Method = typeof v2Methods[number];
const currentDiscriminators = {
  buy_v2: [184, 23, 238, 97, 103, 197, 211, 61],
  buy_exact_quote_in_v2: [194, 171, 28, 70, 104, 77, 91, 47],
  sell_v2: [93, 246, 130, 60, 231, 233, 64, 178],
  sweep_creator_fee: [32, 246, 191, 52, 8, 201, 73, 186],
  sweep_protocol_fee: [8, 48, 190, 7, 182, 68, 183, 229],
};
const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
function currentArguments(method: V2Method, first: bigint, second: bigint) {
  const result = Buffer.alloc(24); Buffer.from(currentDiscriminators[method]).copy(result);
  result.writeBigUInt64LE(first, 8); result.writeBigUInt64LE(second, 16); return encodeSolanaAddress(result);
}
function bindKeys(tx: any) {
  const previous = new Map(tx.transaction.message.accountKeys.map((k: any) => [k.pubkey, k.signer]));
  tx.transaction.message.accountKeys = [...new Set(tx.transaction.message.instructions.flatMap((i: any) => [...i.accounts, i.programId]))].map(pubkey => ({ pubkey, signer: previous.get(pubkey) === true }));
}
function swapV2(reference: Row, method: V2Method): any {
  const tx = swap(reference, method === 'sell_v2' ? 'SELL' : 'BUY'), ix = tx.transaction.message.instructions[0];
  ix.data = currentArguments(method, method === 'buy_exact_quote_in_v2' ? 9007199254741000n : 500n, method === 'buy_v2' ? 9007199254741000n : method === 'sell_v2' ? 1n : 500n);
  ix.accounts[2] = GLOBAL_CONFIG_PDA.toBase58(); ix.accounts[9] = TOKEN_PROGRAM_ID.toBase58(); ix.accounts[10] = TOKEN_PROGRAM_ID.toBase58();
  ix.accounts[11] = '11111111111111111111111111111111'; ix.accounts[15] = eventAuthority;
  ix.accounts[12] = userVolumeAccumulatorPda(user).toBase58(); ix.accounts[13] = PUMP_AMM_FEE_CONFIG_PDA.toBase58();
  const decoded = sdk.coder.events.decode(tx.meta.logMessages[1].slice(14))!, event = decoded.data as any;
  event.ixName = method; event.maxQuoteAmountIn = new BN('9007199254741000'); event.minBaseAmountOut = new BN(500); event.minQuoteAmountOut = new BN(1);
  event.lpFee = new BN(2); event.protocolFee = new BN(3); event.coinCreatorFee = new BN(2);
  event.quoteAmountIn = new BN(method === 'buy_exact_quote_in_v2' ? '9007199254741000' : '9007199254740993');
  event.userQuoteAmountIn = new BN(method === 'buy_exact_quote_in_v2' ? '9007199254740993' : '9007199254741000');
  event.quoteAmountInWithLpFee = new BN('9007199254740995');
  event.userQuoteAmountOut = new BN('9007199254740986'); event.quoteAmountOutWithoutLpFee = new BN('9007199254740991');
  event.buybackFee = new BN(1);
  const suffix = Buffer.alloc(24);
  // Official current events preserve the SDK event prefix and append three u64 fields.
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === decoded.name)!.discriminator), sdk.coder.types.encode(decoded.name, event), suffix]);
  tx.meta.logMessages[1] = `Program data: ${payload.toString('base64')}`; bindKeys(tx); return tx;
}
function mutateSwapEvent(tx: any, change: (event: any) => void) {
  const payload = Buffer.from(tx.meta.logMessages[1].slice(14), 'base64'), decoded = sdk.coder.events.decode(payload.toString('base64'))!;
  const suffix = payload.subarray(8 + sdk.coder.types.encode(decoded.name, decoded.data).length);
  change(decoded.data);
  tx.meta.logMessages[1] = `Program data: ${Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === decoded.name)!.discriminator), sdk.coder.types.encode(decoded.name, decoded.data), suffix]).toString('base64')}`;
}
type SwapShape = 'buy-24' | 'buy-25' | 'buy_exact_quote_in-24' | 'buy_exact_quote_in-25' | 'sell-24' | V2Method;
const feeShapes: SwapShape[] = ['buy-24', 'buy-25', 'buy_exact_quote_in-24', 'buy_exact_quote_in-25', 'sell-24', ...v2Methods];
function accountingSwap(reference: Row, shape: SwapShape, core = 9007199254740993n, lp = 2n, protocolFee = 3n, creatorFee = 2n): any {
  const name = shape.replace(/-\d+$/, ''), exact = name.includes('exact_quote'), sell = name.startsWith('sell'), fees = lp + protocolFee + creatorFee;
  const gross = sell ? core : core + fees, userQuote = sell ? core - fees : exact ? core : gross;
  const tx = name.endsWith('_v2') ? swapV2(reference, name as V2Method) : swap(reference, sell ? 'SELL' : 'BUY', core.toString());
  const ix = tx.transaction.message.instructions[0];
  if (name.endsWith('_v2')) ix.data = currentArguments(name as V2Method, exact ? gross : 500n, sell ? userQuote : exact ? 500n : gross);
  else {
    const args = sell ? { baseAmountIn: new BN(500), minQuoteAmountOut: new BN(userQuote.toString()) } : exact ? { spendableQuoteIn: new BN(gross.toString()), minBaseAmountOut: new BN(500), trackVolume: { 0: true } } : { baseAmountOut: new BN(500), maxQuoteAmountIn: new BN(gross.toString()), trackVolume: { 0: true } };
    const data = sdk.coder.instruction.encode(sell ? 'sell' : exact ? 'buyExactQuoteIn' : 'buy', args);
    ix.data = encodeSolanaAddress(shape.endsWith('-24') ? data.subarray(0, 24) : data);
  }
  mutateSwapEvent(tx, event => {
    event.ixName = name; event.lpFee = new BN(lp.toString()); event.protocolFee = new BN(protocolFee.toString()); event.coinCreatorFee = new BN(creatorFee.toString());
    event.buybackFee = new BN((protocolFee / 2n).toString()); event.cashback = new BN(0);
    event.quoteAmountIn = new BN((exact ? gross : core).toString()); event.userQuoteAmountIn = new BN(userQuote.toString()); event.quoteAmountInWithLpFee = new BN((core + lp).toString());
    event.quoteAmountOut = new BN(core.toString()); event.userQuoteAmountOut = new BN(userQuote.toString()); event.quoteAmountOutWithoutLpFee = new BN((core - lp).toString());
    event.maxQuoteAmountIn = new BN(gross.toString()); event.minBaseAmountOut = new BN(500); event.minQuoteAmountOut = new BN(userQuote.toString());
  });
  return tx;
}
function feeSweep(reference: Row, method: 'sweep_creator_fee' | 'sweep_protocol_fee'): any {
  const tx = swap(reference), recipient = coinCreatorVaultAuthorityPda(user);
  const accounts = [user.toBase58(), GLOBAL_CONFIG_PDA.toBase58(), pool, NATIVE_MINT.toBase58(), TOKEN_PROGRAM_ID.toBase58(), quoteVault.toBase58(), recipient.toBase58(), getAssociatedTokenAddressSync(NATIVE_MINT, recipient, true).toBase58(), '11111111111111111111111111111111', ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), eventAuthority, program];
  tx.transaction.message.instructions = [{ programId: program, accounts, data: encodeSolanaAddress(Buffer.from(currentDiscriminators[method])) }];
  const prefix = Buffer.alloc(16); Buffer.from([130, 164, 36, 97, 228, 130, 135, 165]).copy(prefix); prefix.writeBigInt64LE(BigInt(reference.blockTime!), 8);
  const amount = Buffer.alloc(9); amount.writeBigUInt64LE(9007199254740993n); amount[8] = method === 'sweep_creator_fee' ? 1 : 0;
  const payload = Buffer.concat([prefix, new PublicKey(pool).toBuffer(), new PublicKey(token.address).toBuffer(), NATIVE_MINT.toBuffer(), recipient.toBuffer(), user.toBuffer(), amount]);
  tx.meta.logMessages = [`Program ${program} invoke [1]`, `Program data: ${payload.toString('base64')}`, `Program ${program} success`];
  bindKeys(tx); return tx;
}
async function fixture(pages: Row[][] = [[row(1, endSeconds - 10), row(2, startSeconds - 1)]], transactions = new Map<string, any>(), mutate?: (request: RpcRequest, result: any) => any) {
  const state = { ...defaults('pool'), creator, baseMint: new PublicKey(token.address), quoteMint: NATIVE_MINT, poolBaseTokenAccount: baseVault, poolQuoteTokenAccount: quoteVault };
  const poolData = await sdk.coder.accounts.encode('pool', state), calls: RpcRequest[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest; calls.push(request);
    let result: any;
    if (request.method === 'getGenesisHash') result = SOLANA_MAINNET_GENESIS;
    else if (request.method === 'getSlot') result = 10_001;
    else if (request.method === 'getBlockTime') result = endSeconds + 30;
    else if (request.method === 'getSignaturesForAddress') {
      const before = (request.params[1] as { before?: string }).before;
      const page = before ? pages.findIndex(p => p.at(-1)?.signature === before) + 1 : 0;
      result = structuredClone(pages[page] ?? []);
    } else if (request.method === 'getTransaction') {
      const reference = pages.flat().find(r => r.signature === request.params[0])!;
      result = transactions.has(reference.signature) ? structuredClone(transactions.get(reference.signature)) : swap(reference);
    } else if (request.method === 'getAccountInfo') result = { context: { slot: 10_001 }, value: { owner: program, executable: false, data: [poolData.toString('base64'), 'base64'] } };
    else throw new Error(`Unexpected request ${request.method}`);
    result = mutate ? mutate(request, result) : result;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
  };
  const collected = await collectAdvisoryWindow(token, pool, 'https://rpc.example', fetcher, () => cutoff, end);
  const decode = (currentAbi = true, feeExclusive = currentAbi) => decodeAdvisoryWindow(token, pool, end, collected.rawArtifacts, collected.retrievedAt, collected.requests, cutoff, currentAbi, feeExclusive);
  return { collected, decode, calls, fetcher };
}
function receiptId(x: Awaited<ReturnType<typeof fixture>>, method: string) {
  return Object.entries(x.collected.requests).find(([, r]) => r.method === method)![0];
}
function assertIncomplete(decode: () => ReturnType<typeof decodeAdvisoryWindow>) {
  let history: ReturnType<typeof decodeAdvisoryWindow>;
  try { history = decode(); } catch (error) { assert.match(String(error), /ADVISORY_WINDOW_/); return; }
  assert.equal(history.complete, false); assert.notEqual(deriveO28Window(history, []).quality, 'KNOWN');
}

test('complete selected-pool trailing hour uses exact quote amounts and half-open boundaries', async () => {
  const references = [row(1, endSeconds), row(2, endSeconds - 1), row(3, startSeconds), row(4, startSeconds - 1)];
  const x = await fixture([references], new Map([[references[2]!.signature, swap(references[2]!, 'SELL', '3')]]));
  const history = x.decode();
  assert.equal(history.complete, true); assert.equal(history.sourceUniverseComplete, false);
  assert.equal(history.trades.length, 2); assert.equal(history.buyQuoteAtomic, '9007199254740993');
  assert.equal(history.sellQuoteAtomic, '3'); assert.equal(history.netQuoteAtomic, '9007199254740990');
  assert.deepEqual(x.calls.filter(r => r.method === 'getTransaction').map(r => r.params[0]), [references[1]!.signature, references[2]!.signature]);
  assert.ok(x.calls.filter(r => r.method === 'getTransaction').every(r => (r.params[1] as any).maxSupportedTransactionVersion === 1));
  assert.equal(x.calls.at(-1)?.method, 'getAccountInfo');
  const metric = deriveO28Window(history, ['raw-window']); assert.equal(metric.quality, 'KNOWN'); assert.deepEqual(metric.evidenceIds, ['raw-window']);
});

test('complete empty finalized window establishes zero while failed transactions need no reads', async () => {
  for (const references of [[], [row(1, endSeconds - 1, { InstructionError: [0, 'Custom'] }), row(2, startSeconds - 1)]]) {
    const x = await fixture([references]), history = x.decode();
    assert.equal(history.complete, true); assert.equal(history.trades.length, 0); assert.equal(history.netQuoteAtomic, '0');
    assert.equal(deriveO28Window(history, []).quality, 'KNOWN'); assert.equal(x.calls.filter(r => r.method === 'getTransaction').length, 0);
  }
});

test('32-row pages follow exact before cursors until an older witness', async () => {
  const first = Array.from({ length: 32 }, (_, i) => row(i + 1, endSeconds - i - 1, { InstructionError: [0, 'Custom'] }));
  const second = [row(33, startSeconds - 1)];
  const x = await fixture([first, second]);
  assert.equal(x.decode().complete, true);
  const calls = x.calls.filter(r => r.method === 'getSignaturesForAddress'); assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.params, [pool, { commitment: 'finalized', limit: 32, minContextSlot: 10_001 }]);
  assert.deepEqual(calls[1]!.params, [pool, { commitment: 'finalized', limit: 32, before: first.at(-1)!.signature, minContextSlot: 10_001 }]);
});

test('page cap and successful transaction cap preserve incomplete coverage', async () => {
  const cappedPages = Array.from({ length: 4 }, (_, page) => Array.from({ length: 32 }, (_, i) => row(page * 32 + i + 1, endSeconds - page * 32 - i - 1, { InstructionError: [0, 'Custom'] })));
  const pages = await fixture(cappedPages); assert.equal(pages.calls.filter(r => r.method === 'getSignaturesForAddress').length, 4);
  assert.equal(pages.decode().complete, false); assert.notEqual(deriveO28Window(pages.decode(), []).quality, 'KNOWN');
  const references = Array.from({ length: 41 }, (_, i) => row(i + 1, endSeconds - i - 1));
  const transactions = await fixture([references.slice(0, 32), [...references.slice(32), row(42, startSeconds - 1)]]);
  assert.equal(transactions.calls.filter(r => r.method === 'getTransaction').length, 40);
  assert.equal(transactions.decode().complete, false); assert.notEqual(deriveO28Window(transactions.decode(), []).quality, 'KNOWN');
});

test('missing receipts, null clocks, failed reads and unsupported transaction versions never become known', async () => {
  const reference = row(1, endSeconds - 1);
  for (const value of [null, { ...swap(reference), version: 2 }, { ...swap(reference), blockTime: null }, { ...swap(reference), meta: { ...swap(reference).meta, err: { InstructionError: [0, 'Custom'] } } }]) {
    const x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, value]]));
    assert.equal(x.decode().complete, false); assert.notEqual(deriveO28Window(x.decode(), []).quality, 'KNOWN');
  }
  const unknownTime = await fixture([[row(1, null), row(2, startSeconds - 1)]]); assert.equal(unknownTime.decode().complete, false);
  const error = await fixture(undefined, undefined, (request, result) => request.method === 'getGenesisHash' ? 'wrong-network' : result);
  assert.equal(error.decode().complete, false); assert.notEqual(deriveO28Window(error.decode(), []).quality, 'KNOWN');
});

test('raw reconstruction binds the token, pool, request, cutoff and every availability clock', async () => {
  for (const method of ['getGenesisHash', 'getSlot', 'getBlockTime', 'getSignaturesForAddress', 'getTransaction', 'getAccountInfo']) {
    const x = await fixture(), id = receiptId(x, method); delete x.collected.rawArtifacts[id];
    assertIncomplete(x.decode);
  }
  let x = await fixture(); x.collected.requests[receiptId(x, 'getSignaturesForAddress')]!.params[0] = token.address;
  assertIncomplete(x.decode);
  x = await fixture(); x.collected.retrievedAt[receiptId(x, 'getTransaction')] = '2026-10-11T11:59:00.000Z';
  assertIncomplete(x.decode);
  x = await fixture(); x.collected.retrievedAt[receiptId(x, 'getAccountInfo')] = '2026-10-11T11:59:00.000Z';
  assertIncomplete(x.decode);
  x = await fixture(); x.collected.retrievedAt[receiptId(x, 'getGenesisHash')] = '2026-10-11T12:02:00.000Z';
  assertIncomplete(x.decode);
  assertIncomplete(() => decodeAdvisoryWindow({ ...token, address: user.toBase58() }, pool, end, x.collected.rawArtifacts, x.collected.retrievedAt, x.collected.requests, cutoff));
  assertIncomplete(() => decodeAdvisoryWindow(token, pool, end, x.collected.rawArtifacts, x.collected.retrievedAt, x.collected.requests, '2026-10-11T11:59:00.000Z'));
});

test('finalized anchor must reach the frozen window end before acquisition can prove coverage', async () => {
  for (const anchorTime of [null, endSeconds - 1, Date.parse(cutoff) / 1000 + 1]) {
    const x = await fixture([[]], undefined, (request, result) => request.method === 'getBlockTime' ? anchorTime : result);
    assert.equal(x.decode().complete, false); assert.notEqual(deriveO28Window(x.decode(), []).quality, 'KNOWN');
  }
  const x = await fixture(), slot = receiptId(x, 'getSlot');
  const nullSlot = await fixture([[]], undefined, (request, result) => request.method === 'getSlot' ? null : result);
  assertIncomplete(nullSlot.decode);
  assert.ok(!nullSlot.calls.some(r => r.method === 'getSignaturesForAddress'));
  assert.deepEqual(x.collected.requests[slot]!.params, [{ commitment: 'finalized' }]);
  assert.deepEqual(x.collected.requests[receiptId(x, 'getBlockTime')]!.params, [10_001]);
  assert.ok(x.calls.findIndex(r => r.method === 'getBlockTime') < x.calls.findIndex(r => r.method === 'getSignaturesForAddress'));
  const poolId = receiptId(x, 'getAccountInfo'), state = JSON.parse(x.collected.rawArtifacts[poolId]!); state.result.context.slot = 10_000;
  x.collected.rawArtifacts[poolId] = JSON.stringify(state); assert.equal(x.decode().complete, false);
  assertIncomplete(() => decodeAdvisoryWindow(token, pool, '2026-10-11T11:59:59.000Z', x.collected.rawArtifacts, x.collected.retrievedAt, x.collected.requests, cutoff));
  await assert.rejects(() => collectAdvisoryWindow(token, pool, 'https://rpc.example', x.fetcher, () => cutoff, '2026-10-11T11:59:59.000Z'), /ADVISORY_WINDOW_TIME/);
});

test('unknown target instructions and malformed event frames block complete coverage', async () => {
  const reference = row(1, endSeconds - 1);
  const mutations = [
    (t: any) => { t.transaction.message.instructions[0].data = encodeSolanaAddress(Buffer.alloc(24)); },
    (t: any) => { t.meta.logMessages.splice(2, 0, t.meta.logMessages[1]); },
    (t: any) => { t.meta.logMessages.pop(); },
    (t: any) => { t.transaction.message.accountKeys.find((k: any) => k.pubkey === user.toBase58()).signer = false; },
    (t: any) => { t.transaction.message.instructions[0].accounts[1] = creator.toBase58(); },
  ];
  for (const mutate of mutations) {
    const tx = swap(reference); mutate(tx);
    const x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
    assert.equal(x.decode().complete, false); assert.notEqual(deriveO28Window(x.decode(), []).quality, 'KNOWN');
  }
});

test('successful pinned-IDL CPI authorizes the bound account without claiming a top-level signature', async () => {
  const reference = row(1, endSeconds - 1), tx = swap(reference), router = creator.toBase58();
  const ix = tx.transaction.message.instructions[0], event = tx.meta.logMessages[1];
  tx.transaction.message.accountKeys.find((key: any) => key.pubkey === user.toBase58()).signer = false;
  tx.transaction.message.accountKeys.push({ pubkey: router, signer: true });
  tx.transaction.message.instructions = [{ programId: router, accounts: [user.toBase58()], data: '1' }];
  tx.meta.innerInstructions = [{ index: 0, instructions: [{ ...ix, stackHeight: 2 }] }];
  tx.meta.logMessages = [`Program ${router} invoke [1]`, `Program ${program} invoke [2]`, event, `Program ${program} success`, `Program ${router} success`];
  const x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
  assert.equal(x.decode().complete, true); assert.equal(x.decode().trades.length, 1);
  assert.ok(x.decode().cpiAuthorizedAccounts.includes(user.toBase58()));
  for (const mutate of [
    (t: any) => { t.meta.innerInstructions[0].instructions[0].stackHeight = 3; },
    (t: any) => { t.meta.logMessages[t.meta.logMessages.length - 1] = `Program ${router} failed: custom`; },
    (t: any) => { t.meta.err = { InstructionError: [0, 'Custom'] }; },
    (t: any) => { t.meta.innerInstructions[0].instructions[0].accounts[1] = router; },
  ]) {
    const broken = structuredClone(tx); mutate(broken);
    const rejected = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, broken]]));
    assert.equal(rejected.decode().complete, false); assert.notEqual(deriveO28Window(rejected.decode(), []).quality, 'KNOWN');
  }
});

test('foreign pool event binds its own instruction and is excluded from selected-pool amounts', async () => {
  const reference = row(1, endSeconds - 1), tx = swap(reference), foreign = new PublicKey(Buffer.alloc(32, 9)).toBase58();
  const foreignIx = structuredClone(tx.transaction.message.instructions[0]); foreignIx.accounts[0] = foreign;
  const foreignEvent = sdk.coder.events.decode(tx.meta.logMessages[1].slice(14))!;
  (foreignEvent.data as any).pool = new PublicKey(foreign);
  const payload = Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === foreignEvent.name)!.discriminator), sdk.coder.types.encode(foreignEvent.name, foreignEvent.data)]).toString('base64');
  tx.transaction.message.accountKeys.push({ pubkey: foreign, signer: false });
  tx.transaction.message.instructions.push(foreignIx);
  tx.meta.logMessages.push(`Program ${program} invoke [1]`, `Program data: ${payload}`, `Program ${program} success`);
  const x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
  assert.equal(x.decode().complete, true); assert.equal(x.decode().trades.length, 1);
  assert.equal(x.decode().foreignSwapLegs, 1); assert.equal(x.decode().netQuoteAtomic, '9007199254740993');
  // A selected-pool event cannot be laundered by labeling its instruction as foreign.
  tx.meta.logMessages[4] = tx.meta.logMessages[1];
  const mismatched = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
  assert.equal(mismatched.decode().complete, false); assert.notEqual(deriveO28Window(mismatched.decode(), []).quality, 'KNOWN');
});

test('Anchor self-CPI emitter reconciles exact authority, parent event payload and frame depth', async () => {
  const reference = row(1, endSeconds - 1), tx = swap(reference);
  const authority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_AMM_PROGRAM_ID)[0].toBase58();
  const encodedEvent = Buffer.from(tx.meta.logMessages[1].slice(14), 'base64');
  const emitterData = Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), encodedEvent]);
  tx.transaction.message.accountKeys.push({ pubkey: authority, signer: false });
  tx.meta.innerInstructions = [{ index: 0, instructions: [{ programId: program, accounts: [authority], stackHeight: 2, data: encodeSolanaAddress(emitterData) }] }];
  tx.meta.logMessages.splice(2, 0, `Program ${program} invoke [2]`, `Program ${program} success`);
  const x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
  assert.equal(x.decode().complete, true); assert.equal(x.decode().trades.length, 1); assert.equal(x.decode().netQuoteAtomic, '9007199254740993');
  for (const mutate of [
    (t: any) => { const bytes = Buffer.from(emitterData); bytes[0] = bytes[0]! ^ 1; t.meta.innerInstructions[0].instructions[0].data = encodeSolanaAddress(bytes); },
    (t: any) => { const bytes = Buffer.from(emitterData); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; t.meta.innerInstructions[0].instructions[0].data = encodeSolanaAddress(bytes); },
    (t: any) => { t.meta.innerInstructions[0].instructions[0].accounts[0] = user.toBase58(); },
    (t: any) => { t.meta.innerInstructions[0].instructions[0].stackHeight = 3; },
    (t: any) => { t.meta.logMessages.splice(1, 1); },
  ]) {
    const broken = structuredClone(tx); mutate(broken);
    const rejected = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, broken]]));
    assertIncomplete(rejected.decode);
  }
});

test('overlapping pages, cursor edits and weakened finality requests remain incomplete', async () => {
  const first = Array.from({ length: 32 }, (_, i) => row(i + 1, endSeconds - i - 1, { InstructionError: [0, 'Custom'] }));
  const overlap = await fixture([first, [first.at(-1)!, row(33, startSeconds - 1)]]);
  assert.equal(overlap.decode().complete, false);
  const malformedFullPage = [first.at(-1)!, ...Array.from({ length: 31 }, (_, i) => row(i + 33, endSeconds - i - 33, { InstructionError: [0, 'Custom'] }))];
  const halted = await fixture([first, malformedFullPage, [row(65, startSeconds - 1)]]);
  assertIncomplete(halted.decode); assert.equal(halted.calls.filter(r => r.method === 'getSignaturesForAddress').length, 2);
  for (const mutate of [
    (request: RpcRequest) => { (request.params[1] as any).before = sig(999); },
    (request: RpcRequest) => { delete (request.params[1] as any).minContextSlot; },
    (request: RpcRequest) => { (request.params[1] as any).commitment = 'confirmed'; },
  ]) {
    const x = await fixture([first, [row(33, startSeconds - 1)]]), pages = Object.entries(x.collected.requests).filter(([, r]) => r.method === 'getSignaturesForAddress');
    mutate(pages[1]![1]); assert.equal(x.decode().complete, false);
  }
});

test('collector retains safe failed RPC receipts and hides endpoint credentials', async () => {
  const result = await collectAdvisoryWindow(token, pool, 'https://rpc.example?key=SECRET', async () => { throw new Error('SECRET'); }, () => cutoff, end);
  assert.ok(Object.keys(result.rawArtifacts).length > 0); assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.notEqual(deriveO28Window(decodeAdvisoryWindow(token, pool, end, result.rawArtifacts, result.retrievedAt, result.requests, cutoff), []).quality, 'KNOWN');
});

test('identical retained chain transaction receipt avoids duplicate RPC while incompatible versions do not', async () => {
  const x = await fixture(), genesis = receiptId(x, 'getGenesisHash'), transaction = receiptId(x, 'getTransaction');
  const reuse = { rawArtifacts: { 'advisory-chain-genesis': x.collected.rawArtifacts[genesis]!, 'advisory-chain-transaction-0': x.collected.rawArtifacts[transaction]! },
    retrievedAt: { 'advisory-chain-genesis': x.collected.retrievedAt[genesis]!, 'advisory-chain-transaction-0': x.collected.retrievedAt[transaction]! },
    requests: { 'advisory-chain-genesis': x.collected.requests[genesis]!, 'advisory-chain-transaction-0': x.collected.requests[transaction]! } };
  x.calls.length = 0;
  const result = await collectAdvisoryWindow(token, pool, 'https://rpc.example', x.fetcher, () => cutoff, end, undefined, reuse);
  assert.equal(x.calls.filter(r => r.method === 'getTransaction').length, 0); assert.equal(x.calls.filter(r => r.method === 'getGenesisHash').length, 0);
  assert.equal(decodeAdvisoryWindow(token, pool, end, result.rawArtifacts, result.retrievedAt, result.requests, cutoff).complete, true);
  assert.ok(x.calls.some(r => r.method === 'getSignaturesForAddress'));
  const incompatible = structuredClone(reuse); (incompatible.requests['advisory-chain-transaction-0'].params[1] as any).maxSupportedTransactionVersion = 0;
  x.calls.length = 0;
  await collectAdvisoryWindow(token, pool, 'https://rpc.example', x.fetcher, () => cutoff, end, undefined, incompatible);
  assert.equal(x.calls.filter(r => r.method === 'getTransaction').length, 1);
});

test('three current swap methods preserve exact fee-exclusive quote amounts under explicitly versioned decoding', async () => {
  const reference = row(1, endSeconds - 1);
  for (const method of v2Methods) {
    const tx = swapV2(reference, method), x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
    const history = x.decode(); assert.equal(history.method, 'pumpswap-selected-pool-window-v3'); assert.equal(history.complete, true, method);
    assert.equal(history.trades.length, 1); assert.equal(history.trades[0]!.baseAtomic, '500'); assert.equal(history.trades[0]!.quoteAtomic, '9007199254740993');
    assert.equal(history.netQuoteAtomic, method === 'sell_v2' ? '-9007199254740993' : '9007199254740993');
    assert.equal(deriveO28Window(history, []).quality, 'KNOWN');
    const old = x.decode(false); assert.equal(old.method, 'pumpswap-selected-pool-window-v1'); assert.equal(old.complete, false); assert.equal(old.trades.length, 0);
    const historical = x.decode(true, false); assert.equal(historical.method, 'pumpswap-selected-pool-window-v2'); assert.equal(historical.complete, true);
    assert.equal(historical.trades[0]!.quoteAtomic, method === 'buy_exact_quote_in_v2' ? '9007199254741000' : '9007199254740993');
    assert.equal(historical.trades[0]!.instructionName, undefined); assert.equal(historical.trades[0]!.quoteAccounting, undefined);
    // The common event prefix is independently retained by the pinned SDK and also remains supported.
    const prefixOnly = structuredClone(tx), payload = Buffer.from(prefixOnly.meta.logMessages[1].slice(14), 'base64');
    prefixOnly.meta.logMessages[1] = `Program data: ${payload.subarray(0, payload.length - 24).toString('base64')}`;
    const prefix = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, prefixOnly]])); assert.equal(prefix.decode().complete, true);
  }
});

test('current swaps fail closed on amount limits, account roles, malformed ABI and event shape', async () => {
  const reference = row(1, endSeconds - 1);
  for (const method of v2Methods) {
    const mutations = [
      (t: any) => { t.transaction.message.instructions[0].data = currentArguments(method, method === 'buy_exact_quote_in_v2' ? 1n : method === 'sell_v2' ? 499n : 499n, method === 'buy_v2' ? 9007199254741000n : 500n); },
      (t: any) => { t.transaction.message.instructions[0].data = currentArguments(method, method === 'buy_exact_quote_in_v2' ? 9007199254741000n : 500n, method === 'buy_v2' ? 1n : method === 'sell_v2' ? 9007199254740993n : 501n); },
      (t: any) => { t.transaction.message.instructions[0].data = encodeSolanaAddress(Buffer.concat([Buffer.from(currentDiscriminators[method]), Buffer.alloc(17)])); },
      (t: any) => { t.transaction.message.instructions[0].accounts[1] = pool; },
      (t: any) => { t.transaction.message.instructions[0].accounts[3] = user.toBase58(); },
      (t: any) => { t.transaction.message.instructions[0].accounts[4] = user.toBase58(); },
      (t: any) => { t.transaction.message.instructions[0].accounts[7] = quoteVault.toBase58(); },
      (t: any) => { t.transaction.message.instructions[0].accounts[8] = baseVault.toBase58(); },
      (t: any) => { t.transaction.message.instructions[0].accounts[16] = user.toBase58(); },
      (t: any) => { t.transaction.message.instructions[0].accounts[12] = user.toBase58(); },
      (t: any) => { t.transaction.message.instructions[0].accounts[13] = user.toBase58(); },
      (t: any) => { t.transaction.message.accountKeys.find((k: any) => k.pubkey === user.toBase58()).signer = false; },
      (t: any) => { mutateSwapEvent(t, e => { e.pool = user; }); },
      (t: any) => { mutateSwapEvent(t, e => { e.user = new PublicKey(pool); }); },
      (t: any) => { mutateSwapEvent(t, e => { e.userBaseTokenAccount = quoteVault; }); },
      (t: any) => { mutateSwapEvent(t, e => { e.timestamp = new BN(reference.blockTime! - 1); }); },
      (t: any) => { const payload = Buffer.from(t.meta.logMessages[1].slice(14), 'base64'); t.meta.logMessages[1] = `Program data: ${payload.subarray(0, payload.length - 1).toString('base64')}`; },
      (t: any) => { t.meta.logMessages.splice(1, 1); },
    ];
    for (const mutate of mutations) {
      const tx = swapV2(reference, method); mutate(tx);
      const x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]])); assertIncomplete(x.decode);
    }
  }
});

test('current swap CPI preserves executed signer privileges and whole-transaction success guards', async () => {
  const reference = row(1, endSeconds - 1), router = creator.toBase58();
  for (const method of v2Methods) {
    const tx = swapV2(reference, method), ix = tx.transaction.message.instructions[0], payload = tx.meta.logMessages[1];
    tx.transaction.message.accountKeys.find((k: any) => k.pubkey === user.toBase58()).signer = false;
    tx.transaction.message.accountKeys.push({ pubkey: router, signer: true });
    tx.transaction.message.instructions = [{ programId: router, accounts: [user.toBase58()], data: '1' }];
    tx.meta.innerInstructions = [{ index: 0, instructions: [{ ...ix, stackHeight: 2 }] }];
    tx.meta.logMessages = [`Program ${router} invoke [1]`, `Program ${program} invoke [2]`, payload, `Program ${program} success`, `Program ${router} success`];
    const valid = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
    assert.equal(valid.decode().complete, true); assert.deepEqual(valid.decode().cpiAuthorizedAccounts, [user.toBase58()]);
    for (const mutate of [(t: any) => { t.meta.err = { InstructionError: [0, 'Custom'] }; }, (t: any) => { t.meta.innerInstructions[0].instructions[0].stackHeight = 3; }, (t: any) => { t.meta.logMessages[4] = `Program ${router} failed: custom`; }]) {
      const broken = structuredClone(tx); mutate(broken); const invalid = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, broken]])); assertIncomplete(invalid.decode);
    }
  }
});

test('current foreign swap legs authenticate their own event pool before scope exclusion', async () => {
  const reference = row(1, endSeconds - 1), foreign = creator.toBase58();
  for (const method of v2Methods) {
    const tx = swapV2(reference, method), ix = tx.transaction.message.instructions[0]; ix.accounts[0] = foreign;
    const payload = Buffer.from(tx.meta.logMessages[1].slice(14), 'base64'), event = sdk.coder.events.decode(payload.toString('base64'))!;
    (event.data as any).pool = creator;
    tx.meta.logMessages[1] = `Program data: ${Buffer.concat([Buffer.from(sdk.idl.events!.find(e => e.name === event.name)!.discriminator), sdk.coder.types.encode(event.name, event.data), payload.subarray(-24)]).toString('base64')}`;
    tx.transaction.message.accountKeys.push({ pubkey: foreign, signer: false });
    const valid = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
    assert.equal(valid.decode().complete, true); assert.equal(valid.decode().foreignSwapLegs, 1); assert.equal(valid.decode().netQuoteAtomic, '0');
    tx.meta.logMessages[1] = swapV2(reference, method).meta.logMessages[1];
    const invalid = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]])); assertIncomplete(invalid.decode);
  }
});

test('both current fee sweeps produce known zero swap flow and retain versioned non-trade evidence', async () => {
  const reference = row(1, endSeconds - 1);
  for (const method of ['sweep_creator_fee', 'sweep_protocol_fee'] as const) {
    const tx = feeSweep(reference, method), valid = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
    assert.equal(valid.decode().complete, true, method); assert.equal(valid.decode().trades.length, 0); assert.equal(valid.decode().nonSwapInvocations, 1);
    assert.equal(valid.decode().netQuoteAtomic, '0'); assert.equal(deriveO28Window(valid.decode(), []).quality, 'KNOWN'); assertIncomplete(() => valid.decode(false));
    // Real sweep events also use Anchor's exact self-CPI emitter envelope.
    const event = Buffer.from(tx.meta.logMessages[1].slice(14), 'base64');
    tx.meta.innerInstructions = [{ index: 0, instructions: [{ programId: program, accounts: [eventAuthority], stackHeight: 2, data: encodeSolanaAddress(Buffer.concat([Buffer.from('e445a52e51cb9a1d', 'hex'), event])) }] }];
    tx.meta.logMessages.splice(2, 0, `Program ${program} invoke [2]`, `Program ${program} success`);
    const emitted = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]])); assert.equal(emitted.decode().complete, true); assert.equal(emitted.decode().netQuoteAtomic, '0');
    const router = creator.toBase58(), sweepIx = tx.transaction.message.instructions[0], emitterIx = tx.meta.innerInstructions[0].instructions[0];
    tx.transaction.message.accountKeys.find((k: any) => k.pubkey === user.toBase58()).signer = false; tx.transaction.message.accountKeys.push({ pubkey: router, signer: true });
    tx.transaction.message.instructions = [{ programId: router, accounts: [user.toBase58()], data: '1' }];
    tx.meta.innerInstructions = [{ index: 0, instructions: [{ ...sweepIx, stackHeight: 2 }, { ...emitterIx, stackHeight: 3 }] }];
    tx.meta.logMessages = [`Program ${router} invoke [1]`, `Program ${program} invoke [2]`, `Program data: ${event.toString('base64')}`, `Program ${program} invoke [3]`, `Program ${program} success`, `Program ${program} success`, `Program ${router} success`];
    const cpi = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]])); assert.equal(cpi.decode().complete, true); assert.equal(cpi.decode().netQuoteAtomic, '0');
  }
});

test('fee sweep account, event and instruction guards prevent unsupported reads from certifying zero', async () => {
  const reference = row(1, endSeconds - 1);
  for (const method of ['sweep_creator_fee', 'sweep_protocol_fee'] as const) {
    for (const mutate of [
      (t: any) => { t.transaction.message.instructions[0].data = encodeSolanaAddress(Buffer.concat([Buffer.from(currentDiscriminators[method]), Buffer.from([0])])); },
      (t: any) => { t.transaction.message.instructions[0].accounts.pop(); },
      (t: any) => { t.transaction.message.instructions[0].accounts[1] = user.toBase58(); },
      (t: any) => { t.transaction.message.instructions[0].accounts[3] = user.toBase58(); },
      (t: any) => { t.transaction.message.instructions[0].accounts[5] = baseVault.toBase58(); t.transaction.message.accountKeys.push({ pubkey: baseVault.toBase58(), signer: false }); },
      (t: any) => { t.transaction.message.instructions[0].accounts[7] = user.toBase58(); },
      (t: any) => { t.transaction.message.accountKeys.find((k: any) => k.pubkey === user.toBase58()).signer = false; },
      (t: any) => { const event = Buffer.from(t.meta.logMessages[1].slice(14), 'base64'); event[event.length - 1] = method === 'sweep_creator_fee' ? 0 : 1; t.meta.logMessages[1] = `Program data: ${event.toString('base64')}`; },
      (t: any) => { const event = Buffer.from(t.meta.logMessages[1].slice(14), 'base64'); event.writeBigInt64LE(BigInt(reference.blockTime! - 1), 8); t.meta.logMessages[1] = `Program data: ${event.toString('base64')}`; },
      (t: any) => { const event = Buffer.from(t.meta.logMessages[1].slice(14), 'base64'); user.toBuffer().copy(event, 16); t.meta.logMessages[1] = `Program data: ${event.toString('base64')}`; },
      (t: any) => { const event = Buffer.from(t.meta.logMessages[1].slice(14), 'base64'); user.toBuffer().copy(event, 16 + 32 * 3); t.meta.logMessages[1] = `Program data: ${event.toString('base64')}`; },
      (t: any) => { t.meta.logMessages.splice(1, 1); },
    ]) {
      const tx = feeSweep(reference, method); mutate(tx); const invalid = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]])); assertIncomplete(invalid.decode);
    }
  }
});

test('fee-exclusive accounting reconciles every old and current swap encoding without changing historical records', async () => {
  const reference = row(1, endSeconds - 1), core = '9007199254740993', grossBuy = '9007199254741000', sellerNet = '9007199254740986';
  for (const shape of feeShapes) {
    const tx = accountingSwap(reference, shape), x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
    const history = x.decode(), name = shape.replace(/-\d+$/, ''), exact = name.includes('exact_quote'), sell = name.startsWith('sell');
    assert.equal(history.complete, true, shape); assert.equal(history.method, 'pumpswap-selected-pool-window-v3');
    const trade = history.trades[0]!; assert.equal(trade.instructionName, name); assert.equal(trade.quoteAtomic, core);
    assert.equal(history.netQuoteAtomic, sell ? `-${core}` : core);
    const accounting = trade.quoteAccounting!;
    assert.equal(accounting.method, 'pumpswap-event-fee-exclusive-v1'); assert.equal(accounting.basis, sell ? 'SELL_CORE' : exact ? 'EXACT_QUOTE_BUY_GROSS' : 'BUY_CORE');
    assert.equal(accounting.coreQuoteAtomic, core); assert.equal(accounting.grossQuoteAtomic, sell ? core : grossBuy);
    assert.equal(accounting.eventQuoteAtomic, exact ? grossBuy : core); assert.equal(accounting.userQuoteAtomic, sell ? sellerNet : exact ? core : grossBuy);
    assert.equal(accounting.totalFeeAtomic, '7'); assert.equal(accounting.buybackFeeAtomic, '1');
    assert.equal(accounting.eventLayout, shape.endsWith('_v2') ? 'CURRENT_APPENDIX' : 'SDK_PREFIX');
    const old = x.decode(true, false); assert.equal(old.complete, true); assert.equal(old.trades[0]!.quoteAtomic, exact ? grossBuy : core);
    assert.equal(old.trades[0]!.instructionName, undefined); assert.equal(old.trades[0]!.quoteAccounting, undefined);
    if (!shape.endsWith('_v2')) { const v1 = x.decode(false, false); assert.equal(v1.complete, true); assert.equal(v1.trades[0]!.quoteAtomic, exact ? grossBuy : core); assert.equal(v1.trades[0]!.quoteAccounting, undefined); }
  }
});

test('nine actual exact-quote BUY fee identities recover the independently observed 42313949-atomic difference', async () => {
  // Numeric fields from the ten retained BUY events, re-encoded with synthetic identities/clocks.
  const exactCases = [
    ['buy_exact_quote_in_v2', '74725889', '73803345', '14761', '686372', '221411'],
    ['buy_exact_quote_in-24', '395380034', '390498798', '78100', '3631639', '1171497'],
    ['buy_exact_quote_in-24', '70688340', '69815643', '13964', '649286', '209447'],
    ['buy_exact_quote_in-24', '483893942', '477919942', '95584', '4444656', '1433760'],
    ['buy_exact_quote_in-24', '880087166', '869221891', '173845', '8083764', '2607666'],
    ['buy_exact_quote_in-24', '243347639', '240343345', '48069', '2235194', '721031'],
    ['buy_exact_quote_in-24', '1256394281', '1240883239', '248177', '11540215', '3722650'],
    ['buy_exact_quote_in-24', '141680', '139930', '28', '1302', '420'],
    ['buy_exact_quote_in_v2', '22769847', '22488736', '4498', '209146', '67467'],
  ] as const;
  const references = Array.from({ length: 10 }, (_, i) => row(i + 1, endSeconds - i - 10)), transactions = new Map<string, any>();
  for (const [i, [shape, gross, core, lp, protocolFee, creatorFee]] of exactCases.entries()) {
    assert.equal(BigInt(core) + BigInt(lp) + BigInt(protocolFee) + BigInt(creatorFee), BigInt(gross));
    transactions.set(references[i]!.signature, accountingSwap(references[i]!, shape, BigInt(core), BigInt(lp), BigInt(protocolFee), BigInt(creatorFee)));
  }
  transactions.set(references[9]!.signature, accountingSwap(references[9]!, 'buy_v2', 8787430n, 1758n, 81724n, 26363n));
  const x = await fixture([[...references, row(11, startSeconds - 1)]], transactions), corrected = x.decode(), old = x.decode(true, false);
  assert.equal(corrected.complete, true); assert.equal(old.complete, true); assert.equal(corrected.trades.length, 10);
  assert.equal(corrected.buyQuoteAtomic, '3393902299'); assert.equal(old.buyQuoteAtomic, '3436216248');
  assert.equal(BigInt(old.buyQuoteAtomic) - BigInt(corrected.buyQuoteAtomic), 42313949n);
  const actualSell = row(1, endSeconds - 1), sell = await fixture([[actualSell, row(2, startSeconds - 1)]], new Map([[actualSell.signature, accountingSwap(actualSell, 'sell-24', 3850556n, 771n, 35811n, 11552n)]]));
  assert.equal(sell.decode().complete, true); assert.equal(sell.decode().sellQuoteAtomic, '3850556'); assert.equal(sell.decode().netQuoteAtomic, '-3850556');
  assert.equal(sell.decode().trades[0]!.quoteAccounting!.userQuoteAtomic, '3802422');
});

test('mismatched fee identities and unexplained rebates cannot certify fee-exclusive flow', async () => {
  const reference = row(1, endSeconds - 1);
  for (const shape of feeShapes) {
    const sell = shape.startsWith('sell'), exact = shape.includes('exact_quote');
    for (const change of [
      (e: any) => { e.lpFee = new BN(3); },
      (e: any) => { e.protocolFee = new BN(4); },
      (e: any) => { e.coinCreatorFee = new BN(3); },
      (e: any) => { e[sell ? 'quoteAmountOut' : 'quoteAmountIn'] = new BN('9007199254740994'); },
      (e: any) => { e[sell ? 'userQuoteAmountOut' : 'userQuoteAmountIn'] = new BN(1); },
      (e: any) => { e[sell ? 'quoteAmountOutWithoutLpFee' : 'quoteAmountInWithLpFee'] = new BN(1); },
      (e: any) => { e.buybackFee = new BN(4); },
      (e: any) => { e.cashback = new BN(1); },
      (e: any) => { e.cashbackFeeBasisPoints = new BN(1); },
      (e: any) => { e.lpFee = new BN('18446744073709551615'); e.protocolFee = new BN('18446744073709551615'); },
      ...(!sell ? [(e: any) => { e.ixName = exact ? 'buy' : 'buy_exact_quote_in'; }] : []),
    ]) {
      const tx = accountingSwap(reference, shape); mutateSwapEvent(tx, change);
      const x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]])); assertIncomplete(x.decode);
    }
  }
});

test('exact-quote BUY checks its gross spending bound while frozen modes retain their original core comparison', async () => {
  const reference = row(1, endSeconds - 1), core = 9007199254740993n;
  for (const shape of ['buy_exact_quote_in-24', 'buy_exact_quote_in-25', 'buy_exact_quote_in_v2'] as const) {
    const tx = accountingSwap(reference, shape);
    tx.transaction.message.instructions[0].data = shape.endsWith('_v2') ? currentArguments('buy_exact_quote_in_v2', core, 500n) : encodeSolanaAddress(sdk.coder.instruction.encode('buyExactQuoteIn', { spendableQuoteIn: new BN(core.toString()), minBaseAmountOut: new BN(500), trackVolume: { 0: true } }).subarray(0, shape.endsWith('-24') ? 24 : undefined));
    const x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
    assertIncomplete(x.decode); assert.equal(x.decode(true, false).complete, true);
  }
});

test('tail accounting retains accrued creator state without adding it and rejects unsupported holder reward bases', async () => {
  const reference = row(1, endSeconds - 1);
  for (const method of v2Methods) {
    const tx = accountingSwap(reference, method), payload = Buffer.from(tx.meta.logMessages[1].slice(14), 'base64');
    payload.writeBigUInt64LE(18446744073709551615n, payload.length - 8); tx.meta.logMessages[1] = `Program data: ${payload.toString('base64')}`;
    const state = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, tx]]));
    assert.equal(state.decode().complete, true); assert.equal(state.decode().trades[0]!.quoteAtomic, '9007199254740993');
    assert.equal(state.decode().trades[0]!.quoteAccounting!.creatorFeeUnclaimedAtomic, '18446744073709551615');
    for (const offset of [24, 16]) {
      const broken = structuredClone(tx), reward = Buffer.from(broken.meta.logMessages[1].slice(14), 'base64'); reward.writeBigUInt64LE(1n, reward.length - offset); broken.meta.logMessages[1] = `Program data: ${reward.toString('base64')}`;
      const x = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, broken]])); assertIncomplete(x.decode); assert.equal(x.decode(true, false).complete, true);
    }
    const prefixOnly = structuredClone(tx); prefixOnly.meta.logMessages[1] = `Program data: ${payload.subarray(0, payload.length - 24).toString('base64')}`;
    const prefix = await fixture([[reference, row(2, startSeconds - 1)]], new Map([[reference.signature, prefixOnly]]));
    assert.equal(prefix.decode().complete, true); assert.equal(prefix.decode().trades[0]!.quoteAccounting!.eventLayout, 'SDK_PREFIX');
    assert.equal(prefix.decode().trades[0]!.quoteAccounting!.holderRewardsAtomic, null); assert.equal(prefix.decode().trades[0]!.quoteAccounting!.creatorFeeUnclaimedAtomic, null);
  }
});
