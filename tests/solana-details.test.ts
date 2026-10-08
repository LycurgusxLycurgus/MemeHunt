import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import { deriveBaseline, deriveHolderBounds } from '../src/domain/baseline.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { starterProfile } from '../src/app/config.js';
import {
  decodeHolderPopulation, decodeProgramHeader, decodeRawMintControls, decodeSolanaAddress,
  inspectSolanaDetails, resolveProgramData,
  LEGACY_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, UPGRADEABLE_LOADER, type SolanaMint,
} from '../src/providers/solana.js';

const MINT = '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump';
const TOKEN_ACCOUNT = 'So11111111111111111111111111111111111111112';
const SLOT = 100;
const PROGRAM_DATA = '11111111111111111111111111111111';

function baseMint(length = 82): Buffer {
  const bytes = Buffer.alloc(length);
  bytes.writeUInt32LE(0, 0); // no mint authority
  bytes.writeUInt32LE(0, 46); // no freeze authority
  bytes.writeBigUInt64LE(100n, 36);
  bytes[44] = 6;
  bytes[45] = 1;
  return bytes;
}
function extension(type: number, data: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt16LE(type, 0);
  prefix.writeUInt16LE(data.length, 2);
  return Buffer.concat([prefix, data]);
}
function token2022Mint(extensions: Array<[number, Buffer]> = []): Buffer {
  const tlv = Buffer.concat(extensions.map(([type, data]) => extension(type, data)));
  const bytes = Buffer.alloc(166 + tlv.length);
  baseMint().copy(bytes, 0);
  bytes[165] = 1; // Mint account type after the 82-byte base and 83-byte padding.
  tlv.copy(bytes, 166);
  return bytes;
}
function transferHook(authority: Buffer = Buffer.alloc(32), program: Buffer = Buffer.alloc(32)): Buffer {
  return Buffer.concat([authority, program]);
}
function accountResult(bytes: Buffer, owner = TOKEN_2022_PROGRAM, slot = SLOT, executable = false) {
  return { context: { slot }, value: { owner, executable, data: [bytes.toString('base64'), 'base64'] } };
}
function upgradeableProgramHeader(dataAddress = PROGRAM_DATA): Buffer {
  const bytes = Buffer.alloc(36);
  bytes.writeUInt32LE(2, 0);
  decodeSolanaAddress(dataAddress).copy(bytes, 4);
  return bytes;
}
function programData(authority: string | null, deploymentSlot = 90): Buffer {
  const bytes = Buffer.alloc(45);
  bytes.writeUInt32LE(3, 0);
  bytes.writeBigUInt64LE(BigInt(deploymentSlot), 4);
  bytes[12] = authority === null ? 0 : 1;
  if (authority !== null) decodeSolanaAddress(authority).copy(bytes, 13);
  return bytes;
}
function rawTokenAccount(amount: bigint, options: { mint?: string; owner?: string; state?: number; length?: number } = {}): Buffer {
  const bytes = Buffer.alloc(options.length ?? 165);
  decodeSolanaAddress(options.mint ?? MINT).copy(bytes, 0);
  decodeSolanaAddress(options.owner ?? TOKEN_ACCOUNT).copy(bytes, 32);
  bytes.writeBigUInt64LE(amount, 64);
  bytes[108] = options.state ?? 1;
  return bytes;
}

test('Solana address parsing requires a canonical base58 key decoding to exactly 32 bytes', () => {
  assert.equal(decodeSolanaAddress(MINT).length, 32);
  assert.equal(decodeSolanaAddress(TOKEN_ACCOUNT).length, 32);
  assert.equal(decodeSolanaAddress('1'.repeat(32)).length, 32);
  for (const invalid of ['', '0'.repeat(32), '1'.repeat(31), '1'.repeat(45), 'z'.repeat(44)]) {
    assert.throws(() => decodeSolanaAddress(invalid), /INVALID_SOLANA_ADDRESS/);
  }
});

test('raw Token and Token-2022 mint parsing distinguishes base accounts, metadata, and unknown mechanisms', () => {
  const legacy = decodeRawMintControls(accountResult(baseMint(), LEGACY_TOKEN_PROGRAM), ['mint-evidence']);
  assert.equal(legacy.complete, true);
  assert.equal(legacy.supplyAllowed, true);
  assert.equal(legacy.transferAllowed, true);
  assert.equal(legacy.currentFeeBps, '0');
  assert.deepEqual(legacy.evidenceIds, ['mint-evidence']);

  const metadata = token2022Mint([[18, Buffer.alloc(64, 1)], [19, Buffer.alloc(80, 2)]]);
  assert.equal(decodeRawMintControls(accountResult(metadata)).complete, true);

  const fee = Buffer.alloc(108);
  fee[0] = 9; // configured fee authority makes the next fee mutable.
  fee.writeUInt16LE(250, 88);
  fee.writeUInt16LE(750, 106);
  const mutableFee = decodeRawMintControls(accountResult(token2022Mint([[1, fee]])));
  assert.equal(mutableFee.currentFeeBps, '750', 'use the greater configured older/newer fee');
  assert.equal(mutableFee.feeImmutable, false);
  assert.ok(mutableFee.controls.includes('TRANSFER_FEE_AUTHORITY'));

  const frozen = decodeRawMintControls(accountResult(token2022Mint([[6, Buffer.from([2])]])));
  assert.equal(frozen.transferAllowed, false);
  assert.ok(frozen.controls.includes('DEFAULT_FROZEN'));
  const nonTransferable = decodeRawMintControls(accountResult(token2022Mint([[9, Buffer.alloc(0)]])));
  assert.equal(nonTransferable.transferAllowed, false);
  assert.equal(nonTransferable.surfaceSupported, false);
  const delegate = decodeRawMintControls(accountResult(token2022Mint([[12, Buffer.alloc(32, 1)]])));
  assert.ok(delegate.controls.includes('PERMANENT_DELEGATE'));
  assert.equal(delegate.transferAllowed, false);

  const hook = transferHook(undefined, decodeSolanaAddress(TOKEN_2022_PROGRAM));
  const unknown = decodeRawMintControls(accountResult(token2022Mint([[14, hook], [99, Buffer.from([1])]])));
  assert.equal(unknown.complete, false);
  assert.deepEqual(unknown.unsupported, ['TRANSFER_HOOK', 'EXTENSION_99']);
  assert.ok(unknown.controls.includes(`TRANSFER_HOOK_PROGRAM:${TOKEN_2022_PROGRAM}`));
  assert.equal(unknown.supplyAllowed, true, 'unsupported extensions do not erase the raw base authority field');
});

test('TransferHook type 14 keeps each optional address and blocks only favorable scalar qualification when incomplete', () => {
  const cutoff = '2026-09-29T03:00:00.000Z';
  const evidence = {
    id: 'mint-evidence', sourceId: 'solana-rpc', sourceType: 'RPC', retrievedAt: cutoff,
    availableAt: cutoff, contentHash: 'a'.repeat(64), adapterVersion: 'solana-rpc-v1', accessMode: 'PUBLIC_API' as const, scope: {},
  };
  const authority = decodeSolanaAddress(TOKEN_ACCOUNT);
  const program = decodeSolanaAddress(TOKEN_2022_PROGRAM);
  const cases = [
    { name: 'authority only', hook: transferHook(authority), expected: [`TRANSFER_HOOK_AUTHORITY:${TOKEN_ACCOUNT}`], unsupported: ['MUTABLE_TRANSFER_HOOK'] },
    { name: 'program only', hook: transferHook(undefined, program), expected: [`TRANSFER_HOOK_PROGRAM:${TOKEN_2022_PROGRAM}`], unsupported: ['TRANSFER_HOOK'] },
    { name: 'both addresses', hook: transferHook(authority, program), expected: [`TRANSFER_HOOK_AUTHORITY:${TOKEN_ACCOUNT}`, `TRANSFER_HOOK_PROGRAM:${TOKEN_2022_PROGRAM}`], unsupported: ['MUTABLE_TRANSFER_HOOK', 'TRANSFER_HOOK'] },
    { name: 'both null addresses', hook: transferHook(), expected: [], unsupported: [] },
  ];

  for (const scenario of cases) {
    const controls = decodeRawMintControls(accountResult(token2022Mint([[14, scenario.hook]])), ['mint-evidence']);
    assert.equal(controls.complete, scenario.expected.length === 0, scenario.name);
    for (const expected of scenario.expected) assert.ok(controls.controls.includes(expected), `${scenario.name} preserves ${expected}`);
    assert.deepEqual(controls.unsupported, scenario.unsupported, scenario.name);

    const rows = deriveBaseline({
      token: { chain: 'solana', address: MINT }, cutoff, profile: starterProfile(), features: [], evidence: [evidence],
      observations: [], controls,
    });
    const get = (id: string) => rows.find(row => row.id === id)!;
    const features = rows.flatMap(row => row.projection ? [row.projection] : []);
    const checks = evaluateEntry(features, starterProfile(), cutoff).checks;
    const status = (id: string) => checks.find(check => check.checkId === id)!.status;

    if (scenario.expected.length) {
      for (const id of ['O03', 'O04', 'O06']) {
        assert.equal(get(id).quality, 'UNSUPPORTED', `${scenario.name}: ${id} is not a qualified positive fact`);
        assert.equal(get(id).projection?.value, true, `${scenario.name}: raw positive observation remains visible`);
        assert.equal(get(id).projection?.quality, 'UNSUPPORTED', `${scenario.name}: policy cannot use the partial positive projection`);
      }
      assert.equal(status('SEC-01'), 'UNKNOWN', `${scenario.name}: mutable hook cannot pass supply-control review`);
      assert.equal(status('SEC-02'), 'UNKNOWN', `${scenario.name}: mutable hook cannot pass transfer-surface review`);
    } else {
      for (const id of ['O03', 'O04', 'O06']) {
        assert.equal(get(id).quality, 'KNOWN', `${scenario.name}: absent optional addresses are complete`);
        assert.equal(get(id).projection?.quality, 'KNOWN');
      }
      assert.equal(status('SEC-01'), 'PASS');
      assert.equal(status('SEC-02'), 'PASS');
    }
  }

  const frozenMint = token2022Mint([[14, transferHook(authority)]]);
  frozenMint.writeUInt32LE(1, 46); // explicit freeze authority makes transferAllowed false.
  const frozen = decodeRawMintControls(accountResult(frozenMint), ['mint-evidence']);
  const frozenRows = deriveBaseline({
    token: { chain: 'solana', address: MINT }, cutoff, profile: starterProfile(), features: [], evidence: [evidence],
    observations: [], controls: frozen,
  });
  const transfer = frozenRows.find(row => row.id === 'O04')!;
  assert.equal(transfer.quality, 'KNOWN', 'an explicit negative remains actionable despite a separate unsupported extension');
  assert.equal(transfer.projection?.value, false);
});

test('malformed raw layouts fail closed on uninitialized mints, wrong programs, padding, duplicate TLVs, and truncation', () => {
  const uninitialized = baseMint();
  uninitialized[45] = 0;
  assert.throws(() => decodeRawMintControls(accountResult(uninitialized, LEGACY_TOKEN_PROGRAM)), /RPC_SHAPE/);
  assert.throws(() => decodeRawMintControls(accountResult(baseMint(), 'System1111111111111111111111111111111111')), /RPC_SHAPE/);

  const wrongType = token2022Mint();
  wrongType[165] = 2;
  assert.throws(() => decodeRawMintControls(accountResult(wrongType)), /RPC_SHAPE/);
  const badPadding = token2022Mint();
  badPadding[82] = 1;
  assert.throws(() => decodeRawMintControls(accountResult(badPadding)), /RPC_SHAPE/);
  const duplicate = token2022Mint([[9, Buffer.alloc(0)], [9, Buffer.alloc(0)]]);
  assert.throws(() => decodeRawMintControls(accountResult(duplicate)), /RPC_SHAPE/);
  const validBase = token2022Mint();
  const truncated = Buffer.alloc(validBase.length + 4);
  validBase.copy(truncated);
  truncated.writeUInt16LE(18, 166);
  truncated.writeUInt16LE(64, 168);
  assert.throws(() => decodeRawMintControls(accountResult(truncated)), /RPC_SHAPE/);
  const badKnownLength = token2022Mint([[18, Buffer.alloc(63)]]);
  assert.throws(() => decodeRawMintControls(accountResult(badKnownLength)), /RPC_SHAPE/);
});

test('upgradeable program facts require the canonical loader headers and resolve immutable versus mutable authority', () => {
  const header = decodeProgramHeader(accountResult(upgradeableProgramHeader(), UPGRADEABLE_LOADER, 105, true), TOKEN_2022_PROGRAM, ['program']);
  assert.equal(header.address, TOKEN_2022_PROGRAM);
  assert.equal(header.programDataAddress, PROGRAM_DATA);
  assert.equal(header.authorityResolved, undefined);
  assert.equal(header.immutable, false);

  const mutable = resolveProgramData(header, accountResult(programData(TOKEN_ACCOUNT, 100), UPGRADEABLE_LOADER, 105), ['program', 'program-data']);
  assert.equal(mutable.upgradeAuthority, TOKEN_ACCOUNT);
  assert.equal(mutable.authorityResolved, true);
  assert.equal(mutable.immutable, false);
  assert.equal(mutable.deploymentSlot, 100);
  assert.deepEqual(mutable.evidenceIds, ['program', 'program-data']);

  const immutable = resolveProgramData(header, accountResult(programData(null, 100), UPGRADEABLE_LOADER, 105), ['program', 'program-data']);
  assert.equal(immutable.upgradeAuthority, null);
  assert.equal(immutable.authorityResolved, true);
  assert.equal(immutable.immutable, true);

  const native = decodeProgramHeader(accountResult(Buffer.alloc(0), 'BPFLoader1111111111111111111111111111111111', 105, true), TOKEN_2022_PROGRAM);
  assert.equal(native.authorityResolved, true);
  assert.equal(native.immutable, true);

  assert.throws(() => decodeProgramHeader(accountResult(upgradeableProgramHeader(), UPGRADEABLE_LOADER, 105, false), TOKEN_2022_PROGRAM), /RPC_SHAPE/);
  assert.throws(() => decodeProgramHeader(accountResult(Buffer.alloc(36), UPGRADEABLE_LOADER, 105, true), TOKEN_2022_PROGRAM), /RPC_SHAPE/);
  assert.throws(() => decodeProgramHeader(accountResult(upgradeableProgramHeader(), 'System11111111111111111111111111111111', 105, true), TOKEN_2022_PROGRAM), /RPC_SHAPE/);
  assert.throws(() => resolveProgramData(header, accountResult(programData(TOKEN_ACCOUNT, 106), UPGRADEABLE_LOADER, 105), []), /RPC_SHAPE/);
  assert.throws(() => resolveProgramData(header, accountResult(programData(TOKEN_ACCOUNT), UPGRADEABLE_LOADER, 105, true), []), /RPC_SHAPE/);
  const badOption = programData(null);
  badOption[12] = 2;
  assert.throws(() => resolveProgramData(header, accountResult(badOption, UPGRADEABLE_LOADER, 105), []), /RPC_SHAPE/);
});

test('complete holder population binds exact mint, token program, state, unique accounts, slot, and full supply', () => {
  const entry = (pubkey: string, account: Buffer) => ({ pubkey, account: { owner: TOKEN_2022_PROGRAM, executable: false, data: [account.toString('base64'), 'base64'] } });
  const valid = {
    context: { slot: 120 },
    value: [entry('11111111111111111111111111111111', rawTokenAccount(40n)), entry('SysvarRent111111111111111111111111111111111', rawTokenAccount(60n, { owner: PROGRAM_DATA }))],
  };
  const holders = decodeHolderPopulation(valid, MINT, TOKEN_2022_PROGRAM, '100', 110);
  assert.equal(holders.complete, true);
  assert.equal(holders.slot, 120);
  assert.equal(holders.accounts.length, 2);
  assert.equal(holders.accounts[0]?.amount, '40');
  assert.equal(holders.accounts[1]?.owner, PROGRAM_DATA);
  assert.deepEqual(holders.evidenceIds, ['rpc-genesis', 'rpc-holder-population', 'rpc-mint-raw']);
  assert.deepEqual(deriveHolderBounds(holders).sampledAtomic, '100');

  const good = entry('11111111111111111111111111111111', rawTokenAccount(100n));
  const rejects = (caseName: string, value: unknown, expected = 'RPC_SHAPE') => {
    assert.throws(() => decodeHolderPopulation(value, MINT, TOKEN_2022_PROGRAM, '100', 110), new RegExp(expected), caseName);
  };
  rejects('old context cannot claim a same-state population', { ...valid, context: { slot: 109 } });
  rejects('a second account for the same pubkey is rejected', { context: valid.context, value: [good, good] });
  rejects('wrong mint account rows are rejected', { context: valid.context, value: [entry(good.pubkey, rawTokenAccount(100n, { mint: TOKEN_ACCOUNT }))] });
  rejects('wrong token program account rows are rejected', { context: valid.context, value: [{ ...good, account: { ...good.account, owner: LEGACY_TOKEN_PROGRAM } }] });
  rejects('uninitialized/frozen account states are rejected', { context: valid.context, value: [entry(good.pubkey, rawTokenAccount(100n, { state: 0 }))] });
  rejects('short account layouts are rejected', { context: valid.context, value: [entry(good.pubkey, rawTokenAccount(100n, { length: 164 }))] });
  rejects('tail accounts cannot be omitted while declaring a complete supply', { context: valid.context, value: [entry(good.pubkey, rawTokenAccount(99n))] }, 'HOLDER_SUPPLY_UNRECONCILED');
  rejects('aggregate oversupply cannot be accepted as a complete population', { context: valid.context, value: [entry(good.pubkey, rawTokenAccount(101n))] }, 'HOLDER_SUPPLY_UNRECONCILED');
});

test('complete holder decoding accepts more than ten thousand accounts and rejects populations above fifty thousand', () => {
  const accountData = rawTokenAccount(0n).toString('base64');
  const population = Array.from({ length: 20_001 }, (_, index) => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(index + 1, 28);
    return {
      pubkey: new PublicKey(bytes).toBase58(),
      account: { owner: TOKEN_2022_PROGRAM, executable: false, data: [accountData, 'base64'] },
    };
  });
  const holders = decodeHolderPopulation({ context: { slot: 120 }, value: population }, MINT, TOKEN_2022_PROGRAM, '0', 110);
  assert.equal(holders.complete, true);
  assert.equal(holders.accounts.length, 20_001);
  assert.equal(holders.accounts[0]?.amount, '0');
  assert.equal(holders.accounts.at(-1)?.amount, '0');

  assert.throws(() => decodeHolderPopulation({ context: { slot: 120 }, value: Array(50_001).fill(null) }, MINT, TOKEN_2022_PROGRAM, '0', 110), /RPC_SHAPE/);
});

function mintDescriptor(): SolanaMint {
  return { kind: 'MINT_TOKEN_2022_PARTIAL', programId: TOKEN_2022_PROGRAM, supplyAtomic: '100', decimals: 6, mintAuthority: null, freezeAuthority: null, slot: SLOT };
}
function tokenAccountBytes(amount: bigint, wrongMint = false): Buffer {
  return rawTokenAccount(amount, { mint: wrongMint ? TOKEN_ACCOUNT : MINT, owner: encodeFixtureOwner() });
}
function encodeFixtureOwner(): string { return 'SysvarRent111111111111111111111111111111111'; }
function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });
}

test('Solana detail collection uses exact bounded methods and validates sampled account mint, program, amount, and slot', async () => {
  const rawMint = token2022Mint();
  rawMint.writeBigUInt64LE(100n, 36);
  const requestLog: Array<{ method: string; params: unknown[] }> = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    requestLog.push(request);
    if (request.method === 'getAccountInfo' && request.params[0] === MINT) return rpcResponse(accountResult(rawMint, TOKEN_2022_PROGRAM, 102));
    if (request.method === 'getProgramAccounts') return rpcResponse({ context: { slot: 104 }, value: [] });
    if (request.method === 'getTokenLargestAccounts') return rpcResponse({ context: { slot: 103 }, value: [{ address: TOKEN_ACCOUNT, amount: '60', decimals: 6 }] });
    if (request.method === 'getMultipleAccounts') return rpcResponse({ context: { slot: 104 }, value: [{
      owner: TOKEN_2022_PROGRAM, executable: false, data: [tokenAccountBytes(60n).toString('base64'), 'base64'],
    }] });
    if (request.method === 'getAccountInfo' && request.params[0] === TOKEN_2022_PROGRAM) return rpcResponse(accountResult(upgradeableProgramHeader(), UPGRADEABLE_LOADER, 104, true));
    if (request.method === 'getAccountInfo' && request.params[0] === PROGRAM_DATA) return rpcResponse(accountResult(programData(TOKEN_ACCOUNT, 99), UPGRADEABLE_LOADER, 104));
    throw new Error(`UNEXPECTED_RPC_METHOD_${request.method}`);
  };
  const details = await inspectSolanaDetails(mintDescriptor(), MINT, 'https://rpc.example', fetcher);
  assert.equal(Object.hasOwn(details, 'retrievedAt'), false, 'legacy detail inspection keeps its original result shape');
  assert.equal(details.controls?.complete, true);
  assert.equal(details.controls?.evidenceIds.includes('rpc-mint-raw'), true);
  assert.equal(details.holders?.complete, false);
  const bounds = details.holders && deriveHolderBounds(details.holders);
  assert.equal(bounds?.sampledAtomic, '60');
  assert.equal(bounds?.sampledSupplyFraction, '0.6');
  assert.equal(details.holders?.accounts[0]?.amount, '60');
  assert.equal(details.program?.immutable, false);
  assert.equal(details.program?.authorityResolved, true);
  assert.equal(details.program?.upgradeAuthority, TOKEN_ACCOUNT);
  assert.equal(details.program?.deploymentSlot, 99);
  assert.equal(details.errors.holderPopulation, 'HOLDER_SUPPLY_UNRECONCILED');

  const largest = requestLog.find(request => request.method === 'getTokenLargestAccounts');
  assert.deepEqual(largest?.params, [MINT, { commitment: 'finalized' }]);
  const multiple = requestLog.find(request => request.method === 'getMultipleAccounts');
  assert.deepEqual(multiple?.params, [[TOKEN_ACCOUNT], { encoding: 'base64', commitment: 'finalized', minContextSlot: 103 }]);
  const population = requestLog.find(request => request.method === 'getProgramAccounts');
  assert.deepEqual(population?.params, [TOKEN_2022_PROGRAM, {
    encoding: 'base64', commitment: 'finalized', minContextSlot: SLOT, withContext: true,
    dataSlice: { offset: 0, length: 165 }, filters: [{ memcmp: { offset: 0, bytes: MINT } }],
  }]);
  const rawRead = requestLog.find(request => request.method === 'getAccountInfo' && request.params[0] === MINT);
  assert.deepEqual(rawRead?.params[1], { encoding: 'base64', commitment: 'finalized', minContextSlot: SLOT });
  const programHeader = requestLog.find(request => request.method === 'getAccountInfo' && request.params[0] === TOKEN_2022_PROGRAM);
  assert.deepEqual(programHeader?.params[1], { encoding: 'base64', commitment: 'finalized', minContextSlot: SLOT, dataSlice: { offset: 0, length: 36 } });
  const programDataRead = requestLog.find(request => request.method === 'getAccountInfo' && request.params[0] === PROGRAM_DATA);
  assert.deepEqual(programDataRead?.params[1], { encoding: 'base64', commitment: 'finalized', minContextSlot: SLOT, dataSlice: { offset: 0, length: 45 } });
  assert.equal(Object.keys(details.rawArtifacts).sort().join(','), 'rpc-holder-accounts,rpc-holder-population,rpc-largest,rpc-mint-raw,rpc-program,rpc-program-data');

  let fakeNow = Date.parse('2026-10-06T12:00:00.000Z');
  const timedFetcher: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    fakeNow += 310_000;
    return response;
  };
  const timed = await inspectSolanaDetails(mintDescriptor(), MINT, 'https://rpc.example', timedFetcher, undefined,
    () => new Date(fakeNow).toISOString());
  const artifactIds = Object.keys(timed.rawArtifacts);
  assert.deepEqual(Object.keys(timed.retrievedAt ?? {}).sort(), [...artifactIds].sort(), 'every retained RPC body has one retrieval instant');
  assert.deepEqual(Object.values(timed.retrievedAt ?? {}).sort(), Array.from({ length: artifactIds.length }, (_, index) =>
    new Date(Date.parse('2026-10-06T12:00:00.000Z') + 310_000 * (index + 1)).toISOString()).sort(),
  'each response is stamped once as it arrives, even when details span more than the state TTL');
  assert.ok(Date.parse(timed.retrievedAt?.['rpc-program-data'] ?? '') - Date.parse(timed.retrievedAt?.['rpc-mint-raw'] ?? '') > 300_000,
    'later program reads do not refresh the earlier raw mint response');
});

test('complete holder scan is attempted before the top-account fallback and reconciles exact mint supply', async () => {
  const rawMint = token2022Mint();
  rawMint.writeBigUInt64LE(100n, 36);
  const requestLog: Array<{ method: string; params: unknown[] }> = [];
  const entry = (pubkey: string, amount: bigint) => ({
    pubkey, account: { owner: TOKEN_2022_PROGRAM, executable: false, data: [rawTokenAccount(amount).toString('base64'), 'base64'] },
  });
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    requestLog.push(request);
    if (request.method === 'getAccountInfo' && request.params[0] === MINT) return rpcResponse(accountResult(rawMint, TOKEN_2022_PROGRAM, 102));
    if (request.method === 'getProgramAccounts') return rpcResponse({ context: { slot: 111 }, value: [entry('11111111111111111111111111111111', 40n), entry('SysvarRent111111111111111111111111111111111', 60n)] });
    if (request.method === 'getAccountInfo' && request.params[0] === TOKEN_2022_PROGRAM) return rpcResponse(accountResult(upgradeableProgramHeader(), UPGRADEABLE_LOADER, 112, true));
    if (request.method === 'getAccountInfo' && request.params[0] === PROGRAM_DATA) return rpcResponse(accountResult(programData(null, 99), UPGRADEABLE_LOADER, 112));
    if (request.method === 'getTokenLargestAccounts') throw new Error('COMPLETE_POPULATION_MUST_SKIP_SAMPLE_FALLBACK');
    throw new Error(`UNEXPECTED_RPC_METHOD_${request.method}`);
  };
  const details = await inspectSolanaDetails(mintDescriptor(), MINT, 'https://rpc.example', fetcher);
  assert.equal(details.holders?.complete, true);
  assert.equal(details.holders?.slot, 111);
  assert.equal(details.holders?.accounts.reduce((sum, row) => sum + BigInt(row.amount), 0n), 100n);
  assert.equal(details.errors.holderPopulation, undefined);
  assert.equal(details.rawArtifacts['rpc-holder-population'] !== undefined, true);
  assert.equal(requestLog.some(request => request.method === 'getTokenLargestAccounts'), false);
  const population = requestLog.find(request => request.method === 'getProgramAccounts');
  assert.deepEqual(population?.params, [TOKEN_2022_PROGRAM, {
    encoding: 'base64', commitment: 'finalized', minContextSlot: SLOT, withContext: true,
    dataSlice: { offset: 0, length: 165 }, filters: [{ memcmp: { offset: 0, bytes: MINT } }],
  }]);
});

test('holder reconciliation uses current raw mint supply after a burn while retaining raw program and decimal checks', async t => {
  await t.test('a legitimate burn between parsed mint discovery and the finalized raw read is accepted', async () => {
    const rawMint = token2022Mint();
    rawMint.writeBigUInt64LE(90n, 36);
    const population = [{
      pubkey: '11111111111111111111111111111111',
      account: { owner: TOKEN_2022_PROGRAM, executable: false, data: [rawTokenAccount(90n).toString('base64'), 'base64'] },
    }];
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      methods.push(request.method);
      if (request.method === 'getAccountInfo' && request.params[0] === MINT) return rpcResponse(accountResult(rawMint, TOKEN_2022_PROGRAM, 102));
      if (request.method === 'getProgramAccounts') return rpcResponse({ context: { slot: 111 }, value: population });
      if (request.method === 'getAccountInfo' && request.params[0] === TOKEN_2022_PROGRAM) return rpcResponse(accountResult(upgradeableProgramHeader(), UPGRADEABLE_LOADER, 112, true));
      if (request.method === 'getAccountInfo' && request.params[0] === PROGRAM_DATA) return rpcResponse(accountResult(programData(null, 99), UPGRADEABLE_LOADER, 112));
      throw new Error(`UNEXPECTED_RPC_METHOD_${request.method}`);
    };

    const details = await inspectSolanaDetails(mintDescriptor(), MINT, 'https://rpc.example', fetcher);
    assert.equal(details.controls?.complete, true);
    assert.equal(details.holders?.complete, true);
    assert.equal(details.holders?.supplyAtomic, '90');
    assert.equal(details.holders?.accounts.reduce((sum, item) => sum + BigInt(item.amount), 0n), 90n);
    assert.equal(details.errors.holderPopulation, undefined);
    assert.equal(methods.includes('getTokenLargestAccounts'), false, 'a complete scan does not fall back to a top-owner sample');
  });

  for (const scenario of [
    {
      name: 'raw mint program differs from the parsed mint',
      owner: LEGACY_TOKEN_PROGRAM,
      bytes: token2022Mint(),
    },
    {
      name: 'raw mint decimals differ from the parsed mint',
      owner: TOKEN_2022_PROGRAM,
      bytes: (() => { const bytes = token2022Mint(); bytes[44] = 9; return bytes; })(),
    },
  ]) {
    await t.test(scenario.name, async () => {
      const methods: string[] = [];
      const fetcher: typeof fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        methods.push(request.method);
        if (request.method === 'getAccountInfo' && request.params[0] === MINT) return rpcResponse(accountResult(scenario.bytes, scenario.owner, 102));
        if (request.method === 'getTokenLargestAccounts') return rpcResponse({ context: { slot: 103 }, value: [] });
        if (request.method === 'getAccountInfo' && request.params[0] === TOKEN_2022_PROGRAM) return rpcResponse(accountResult(upgradeableProgramHeader(), UPGRADEABLE_LOADER, 104, true));
        if (request.method === 'getAccountInfo' && request.params[0] === PROGRAM_DATA) return rpcResponse(accountResult(programData(null, 99), UPGRADEABLE_LOADER, 104));
        throw new Error(`UNEXPECTED_RPC_METHOD_${request.method}`);
      };

      const details = await inspectSolanaDetails(mintDescriptor(), MINT, 'https://rpc.example', fetcher);
      assert.equal(details.errors.controls, 'RPC_SHAPE');
      assert.equal(details.controls, undefined);
      assert.equal(details.holders, undefined);
      assert.equal(methods.includes('getProgramAccounts'), false, 'complete population requires raw mint control validation first');
    });
  }
});

test('sampled holder mismatch and empty lists remain unknown instead of manufacturing owner coverage', async t => {
  await t.test('wrong mint association rejects holder projection', async () => {
    const rawMint = token2022Mint();
    const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (request.method === 'getAccountInfo' && request.params[0] === MINT) return rpcResponse(accountResult(rawMint));
      if (request.method === 'getProgramAccounts') return rpcResponse({ context: { slot: 103 }, value: [] });
      if (request.method === 'getTokenLargestAccounts') return rpcResponse({ context: { slot: 103 }, value: [{ address: TOKEN_ACCOUNT, amount: '60', decimals: 6 }] });
      if (request.method === 'getMultipleAccounts') return rpcResponse({ context: { slot: 104 }, value: [{ owner: TOKEN_2022_PROGRAM, executable: false, data: [tokenAccountBytes(60n, true).toString('base64'), 'base64'] }] });
      if (request.method === 'getAccountInfo' && request.params[0] === TOKEN_2022_PROGRAM) return rpcResponse(accountResult(upgradeableProgramHeader(), UPGRADEABLE_LOADER, 104, true));
      if (request.method === 'getAccountInfo' && request.params[0] === PROGRAM_DATA) return rpcResponse(accountResult(programData(null, 99), UPGRADEABLE_LOADER, 104));
      throw new Error('UNEXPECTED_RPC_METHOD');
    };
    const details = await inspectSolanaDetails(mintDescriptor(), MINT, 'https://rpc.example', fetcher);
    assert.equal(details.holders, undefined);
    assert.equal(details.errors.holders, 'RPC_SHAPE');
  });

  await t.test('empty largest-account response is named and bounded', async () => {
    const rawMint = token2022Mint();
    let multipleCalls = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (request.method === 'getAccountInfo' && request.params[0] === MINT) return rpcResponse(accountResult(rawMint));
      if (request.method === 'getProgramAccounts') return rpcResponse({ context: { slot: 103 }, value: [] });
      if (request.method === 'getTokenLargestAccounts') return rpcResponse({ context: { slot: 103 }, value: [] });
      if (request.method === 'getMultipleAccounts') { multipleCalls++; throw new Error('EMPTY_SAMPLE_MUST_NOT_FETCH'); }
      if (request.method === 'getAccountInfo' && request.params[0] === TOKEN_2022_PROGRAM) return rpcResponse(accountResult(upgradeableProgramHeader(), UPGRADEABLE_LOADER, 104, true));
      if (request.method === 'getAccountInfo' && request.params[0] === PROGRAM_DATA) return rpcResponse(accountResult(programData(null, 99), UPGRADEABLE_LOADER, 104));
      throw new Error(`UNEXPECTED_RPC_METHOD_${request.method}`);
    };
    const details = await inspectSolanaDetails(mintDescriptor(), MINT, 'https://rpc.example', fetcher);
    assert.equal(details.holders, undefined);
    assert.equal(details.errors.holders, 'HOLDER_SAMPLE_EMPTY');
    assert.equal(multipleCalls, 0);
  });
});
