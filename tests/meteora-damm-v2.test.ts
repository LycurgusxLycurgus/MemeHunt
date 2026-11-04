import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { starterProfile } from '../src/app/config.js';
import { buildEntryReport, renderSnapshot } from '../src/app/report.js';
import { deriveBaseline } from '../src/domain/baseline.js';
import { deriveEntryGroups } from '../src/domain/entry-groups.js';
import { evaluateEntry } from '../src/domain/policy.js';
import { deriveShared, entryEvidenceGates, sharedWitnesses } from '../src/domain/shared.js';
import { resolveEmptyVenueEntries } from '../src/domain/venue-entry.js';
import type { EntrySnapshot, EvidenceRecord, LiveBundle, LiveCollection } from '../src/domain/contracts.js';
import { decodeDammState, decodeEmptyDammState, inspectDammV2, quoteDamm, validateDammBundle, verifyDammSimulation } from '../src/providers/meteora-damm-v2.js';

type Fixture = {
  token: { chain: string; address: string };
  poolAddress: string;
  minSlot: number;
  stateRetrievedAt: string;
  nativeUsd: string;
  sizeUsd: string;
  expected: {
    slot: number;
    quoteAtomic: string;
    acquiredAtomic: string;
    exitAtomic: string;
    simulationProof: { method: string; wireBase64: string; user: string; setupLamports: string };
  };
  rawArtifacts: Record<string, string>;
};

const fixture = JSON.parse(readFileSync('tests/fixtures/meteora-damm-v2.json', 'utf8')) as Fixture;
const bundleFixture = JSON.parse(readFileSync('tests/fixtures/damm-bundle-validation.json', 'utf8')) as {
  token: { chain: string; address: string }; cutoff: string; profile: ReturnType<typeof starterProfile>;
  evidence: Array<{ id: string; contentHash: string }>; features: unknown[]; observations: unknown[];
  rawArtifacts: Record<string, string>;
};
const emptyStateFixture = JSON.parse(readFileSync('tests/fixtures/damm-native-empty-token-2022.json', 'utf8')) as {
  capturedAt: string; genesisAvailableAt: string; genesisResponse: unknown;
  token: { chain: string; address: string }; poolAddress: string; minSlot: number;
  poolResponse: any; stateResponse: any;
};
const poolKey = new PublicKey(fixture.poolAddress);
const profile = { ...starterProfile(), sizeUsd: fixture.sizeUsd };
const parsed = (id: string) => JSON.parse(fixture.rawArtifacts[id]) as Record<string, any>;
const contentHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const actualEmptyToken = emptyStateFixture.token;
const actualEmptyPool = new PublicKey(emptyStateFixture.poolAddress);
const poolLayout = (new CpAmm(new Connection('https://rpc.invalid/', { fetch: async () => { throw new Error('TEST_NETWORK_FORBIDDEN'); } })) as any)
  ._program.coder.accounts.accountLayouts.get('pool').layout as { fields: Array<{ property?: string; span: number; fields?: Array<{ property?: string; span: number }> }> };
const poolOffsets = (() => {
  const offsets: Record<string, number> = {};
  let cursor = 8;
  for (const field of poolLayout.fields) {
    if (field.property) offsets[field.property] = cursor;
    if (field.property === 'poolFees' && field.fields) {
      let nested = cursor;
      for (const child of field.fields) {
        if (child.property) offsets[child.property] = nested;
        nested += child.span;
      }
    }
    cursor += field.span;
  }
  return offsets;
})();
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const swapBytes = (data: Buffer, first: number, second: number, size: number) => {
  const left = Buffer.from(data.subarray(first, first + size));
  data.copy(data, first, second, second + size);
  left.copy(data, second);
};
function emptyStateForSide(side: 'A' | 'B') {
  const response = structuredClone(emptyStateFixture.stateResponse);
  if (side === 'A') {
    const pool = Buffer.from(response.result.value[0].data[0], 'base64');
    swapBytes(pool, poolOffsets.tokenAMint!, poolOffsets.tokenBMint!, 32);
    swapBytes(pool, poolOffsets.tokenAVault!, poolOffsets.tokenBVault!, 32);
    pool[poolOffsets.tokenAFlag!] = 1;
    pool[poolOffsets.tokenBFlag!] = 0;
    response.result.value[0].data[0] = pool.toString('base64');
    [response.result.value[3], response.result.value[4]] = [response.result.value[4], response.result.value[3]];
  }
  return JSON.stringify(response);
}
function withPoolMutation(raw: string, mutate: (pool: Buffer) => void) {
  const response = JSON.parse(raw) as any;
  const pool = Buffer.from(response.result.value[0].data[0], 'base64');
  mutate(pool);
  response.result.value[0].data[0] = pool.toString('base64');
  return JSON.stringify(response);
}
function withMintMutation(raw: string, mutate: (mint: Buffer) => Buffer | number | void) {
  const response = JSON.parse(raw) as any;
  const mint = Buffer.from(response.result.value[1].data[0], 'base64');
  const result = mutate(mint) ?? mint;
  response.result.value[1].data[0] = (Buffer.isBuffer(result) ? result : mint).toString('base64');
  return JSON.stringify(response);
}
function freshValidationBundle(): LiveBundle {
  const bundle = structuredClone(bundleFixture);
  for (const record of bundle.evidence) {
    const raw = bundle.rawArtifacts[record.id];
    if (raw !== undefined) record.contentHash = contentHash(raw);
  }
  return bundle as unknown as LiveBundle;
}

test('sanitized native DAMM fixture decodes, quotes the full acquired amount, and verifies complete simulation vectors', () => {
  const state = decodeDammState(fixture.rawArtifacts['damm-state']!, fixture.token as any, poolKey, fixture.minSlot);
  const quote = quoteDamm(state, profile, fixture.nativeUsd, fixture.stateRetrievedAt);

  assert.equal(state.slot, fixture.expected.slot);
  assert.equal(state.removable, '1');
  assert.equal(quote.quote.toString(), fixture.expected.quoteAtomic);
  assert.equal(quote.buy.consumedInAmount.toString(), fixture.expected.quoteAtomic);
  assert.equal(quote.buy.swapOutAmount.toString(), fixture.expected.acquiredAtomic);
  assert.equal(quote.sell.consumedInAmount.toString(), fixture.expected.acquiredAtomic);
  assert.equal(quote.sell.swapOutAmount.toString(), fixture.expected.exitAtomic);
  assert.ok(BigInt(quote.sell.swapOutAmount.toString()) > 0n);

  const tx = VersionedTransaction.deserialize(Buffer.from(fixture.expected.simulationProof.wireBase64, 'base64'));
  const simulation = parsed('damm-simulation').result;
  const user = new PublicKey(fixture.expected.simulationProof.user);
  const userRequest = parsed('damm-requests').requests['damm-user-accounts'].params[0] as string[];
  const baseAta = getAssociatedTokenAddressSync(state.pool.tokenAMint, user, true).toBase58();
  const baseIndex = userRequest.indexOf(baseAta);
  assert.notEqual(baseIndex, -1, 'the canonical account request includes the selected payer base ATA');
  const baseAccount = parsed('damm-user-accounts').result.value[baseIndex] as {
    owner: string; executable: boolean; lamports: number; data: [string, string];
  };
  assert.ok(baseAccount, 'the sanitized fixture includes the payer base ATA needed for pre-state comparison');
  const baseBefore = {
    owner: new PublicKey(baseAccount.owner), executable: baseAccount.executable,
    lamports: baseAccount.lamports, data: Buffer.from(baseAccount.data[0], 'base64'), rentEpoch: 0,
  };
  const proof = verifyDammSimulation(
    state, quote, simulation, tx, user, baseBefore,
  );
  assert.equal(proof.setupLamports, fixture.expected.simulationProof.setupLamports);
  assert.equal(fixture.expected.simulationProof.method, 'damm-pre-post-v1');
});

test('DAMM state and simulation proof reject mismatched owners, mints, vaults, slots, and vectors', async t => {
  const makeState = () => JSON.parse(fixture.rawArtifacts['damm-state']!) as Record<string, any>;
  const decode = (raw: Record<string, any>, minSlot = fixture.minSlot) =>
    decodeDammState(JSON.stringify(raw), fixture.token as any, poolKey, minSlot);

  await t.test('pool owner and selected token mint are bound to the decoded state', () => {
    const wrongOwner = makeState();
    wrongOwner.result.value[0].owner = SystemProgram.programId.toBase58();
    assert.throws(() => decode(wrongOwner), /DAMM_ACCOUNT_BINDING/);

    const wrongToken = { ...fixture.token, address: 'So11111111111111111111111111111111111111112' };
    assert.throws(() => decodeDammState(fixture.rawArtifacts['damm-state']!, wrongToken as any, poolKey, fixture.minSlot), /DAMM_ACCOUNT_BINDING/);
  });

  await t.test('vault owner and minimum context slot are checked', () => {
    const wrongVaultOwner = makeState();
    wrongVaultOwner.result.value[3].owner = SystemProgram.programId.toBase58();
    assert.throws(() => decode(wrongVaultOwner), /DAMM_ACCOUNT_BINDING/);
    assert.throws(() => decode(makeState(), fixture.expected.slot + 1), /DAMM_STATE_MISSING/);
  });

  await t.test('complete simulation succeeds while error and altered balance vectors fail', () => {
    const state = decode(makeState());
    const quote = quoteDamm(state, profile, fixture.nativeUsd, fixture.stateRetrievedAt);
    const simulation = parsed('damm-simulation').result;
    const tx = VersionedTransaction.deserialize(Buffer.from(fixture.expected.simulationProof.wireBase64, 'base64'));
    const user = new PublicKey(fixture.expected.simulationProof.user);
    const userRequest = parsed('damm-requests').requests['damm-user-accounts'].params[0] as string[];
    const baseAta = getAssociatedTokenAddressSync(state.pool.tokenAMint, user, true).toBase58();
    const baseAccount = parsed('damm-user-accounts').result.value[userRequest.indexOf(baseAta)] as {
      owner: string; executable: boolean; lamports: number; data: [string, string];
    };
    const baseBefore = {
      owner: new PublicKey(baseAccount.owner), executable: baseAccount.executable,
      lamports: baseAccount.lamports, data: Buffer.from(baseAccount.data[0], 'base64'), rentEpoch: 0,
    };
    assert.equal(verifyDammSimulation(state, quote, simulation, tx, user, baseBefore).setupLamports, '0');

    const failed = structuredClone(simulation);
    failed.value.err = { InstructionError: [0, 'Custom'] };
    assert.throws(() => verifyDammSimulation(state, quote, failed, tx, user, baseBefore), /DAMM_SIMULATION_REJECTED/);

    const altered = structuredClone(simulation);
    altered.value.postBalances[0] += 1;
    assert.throws(() => verifyDammSimulation(state, quote, altered, tx, user, baseBefore), /DAMM_SIMULATION_DELTA_MISMATCH/);
  });
});

test('validateDammBundle reconstructs the native route, exact fees, simulation, and derived venue baselines', async t => {
  const accepted = freshValidationBundle();
  assert.doesNotThrow(() => validateDammBundle(accepted), 'the sanitized public-account fixture re-admits the actual selected route');

  await t.test('an altered entry fee is rejected after its evidence hash is refreshed', () => {
    const bundle = freshValidationBundle();
    const fee = JSON.parse(bundle.rawArtifacts['damm-entry-fee']!) as { result: { value: number } };
    fee.result.value += 1;
    bundle.rawArtifacts['damm-entry-fee'] = JSON.stringify(fee);
    const record = bundle.evidence.find(row => row.id === 'damm-entry-fee')!;
    record.contentHash = contentHash(bundle.rawArtifacts['damm-entry-fee']!);
    assert.equal(record.contentHash, contentHash(bundle.rawArtifacts['damm-entry-fee']!));
    assert.throws(() => validateDammBundle(bundle), /DAMM_PROOF_INVALID/);
  });

  await t.test('an altered measured setup amount is rejected after its evidence hash is refreshed', () => {
    const bundle = freshValidationBundle();
    const calculation = JSON.parse(bundle.rawArtifacts['damm-calculation']!) as {
      simulationProof: { setupLamports: string };
    };
    calculation.simulationProof.setupLamports = (BigInt(calculation.simulationProof.setupLamports) + 1n).toString();
    bundle.rawArtifacts['damm-calculation'] = JSON.stringify(calculation);
    bundle.evidence.find(row => row.id === 'damm-calculation')!.contentHash = contentHash(bundle.rawArtifacts['damm-calculation']!);
    assert.throws(() => validateDammBundle(bundle), /DAMM_PROOF_INVALID/);
  });

  await t.test('a changed pool account owner cannot remain selected as a valid native route', () => {
    const bundle = freshValidationBundle();
    const state = JSON.parse(bundle.rawArtifacts['damm-state']!) as {
      result: { value: Array<{ owner: string }> };
    };
    state.result.value[0]!.owner = SystemProgram.programId.toBase58();
    bundle.rawArtifacts['damm-state'] = JSON.stringify(state);
    bundle.evidence.find(row => row.id === 'damm-state')!.contentHash = contentHash(bundle.rawArtifacts['damm-state']!);
    assert.throws(() => validateDammBundle(bundle), /DAMM_ACCOUNT_BINDING/);
  });

  await t.test('a changed derived baseline is rejected after its evidence hash is refreshed', () => {
    const bundle = freshValidationBundle();
    const derived = JSON.parse(bundle.rawArtifacts['shared-derivation']!) as {
      baseline: Array<{ id: string; projection?: { value: unknown } }>;
    };
    const liquidityDecision = derived.baseline.find(row => row.id === 'O09')!;
    liquidityDecision.projection!.value = '0.5';
    bundle.rawArtifacts['shared-derivation'] = JSON.stringify(derived);
    bundle.evidence.find(row => row.id === 'shared-derivation')!.contentHash = contentHash(bundle.rawArtifacts['shared-derivation']!);
    assert.throws(() => validateDammBundle(bundle), /DAMM_PROOF_INVALID/);
  });
});

test('the empty-state decoder accepts only the observed native pair and bounded static mint metadata', async t => {
  const actual = decodeEmptyDammState(JSON.stringify(emptyStateFixture.stateResponse), actualEmptyToken as any, actualEmptyPool, emptyStateFixture.minSlot);
  assert.equal(actual.assetSide, 'B', 'the retained live account pair has target Token-2022 on B and native SOL on A');
  assert.equal(actual.assetProgram, TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(actual.slot, emptyStateFixture.stateResponse.result.context.slot);
  assert.equal(actual.pool.liquidity.toString(), '0');
  assert.equal(actual.pool.permanentLockLiquidity.toString(), '0');

  await t.test('the same Token-2022 pair validates when the target is on A', () => {
    const state = decodeEmptyDammState(emptyStateForSide('A'), actualEmptyToken as any, actualEmptyPool, emptyStateFixture.minSlot);
    assert.equal(state.assetSide, 'A');
    assert.equal(state.assetVault, state.pool.tokenAVault.toBase58());
    assert.equal(state.nativeVault, state.pool.tokenBVault.toBase58());
  });

  await t.test('the established legacy target-A fixture remains an eligible empty read when only active amounts are zeroed', () => {
    const legacy = withPoolMutation(fixture.rawArtifacts['damm-state']!, pool => {
      pool.fill(0, poolOffsets.liquidity!, poolOffsets.liquidity! + 16);
      pool.fill(0, poolOffsets.permanentLockLiquidity!, poolOffsets.permanentLockLiquidity! + 16);
    });
    const state = decodeEmptyDammState(legacy, fixture.token as any, poolKey, fixture.minSlot);
    assert.equal(state.assetSide, 'A');
  });

  await t.test('both-token axes retain strict owner, mint, vault, mode, and empty-state checks', () => {
    const actualRaw = JSON.stringify(emptyStateFixture.stateResponse);
    const rejects = (raw: string, token = actualEmptyToken as any, minimum = emptyStateFixture.minSlot) =>
      assert.throws(() => decodeEmptyDammState(raw, token, actualEmptyPool, minimum));
    const wrongOwner = structuredClone(emptyStateFixture.stateResponse);
    wrongOwner.result.value[0].owner = SystemProgram.programId.toBase58();
    rejects(JSON.stringify(wrongOwner));
    rejects(actualRaw, { chain: 'solana', address: 'So11111111111111111111111111111111111111112' });
    rejects(actualRaw, actualEmptyToken as any, emptyStateFixture.stateResponse.result.context.slot + 1);
    rejects(withPoolMutation(actualRaw, pool => { pool[poolOffsets.tokenBFlag!] = 0; }));
    rejects(withPoolMutation(actualRaw, pool => { pool.writeBigUInt64LE(1n, poolOffsets.liquidity!); }));
    rejects(withPoolMutation(actualRaw, pool => { pool.writeBigUInt64LE(1n, poolOffsets.permanentLockLiquidity!); }));
    rejects(withPoolMutation(actualRaw, pool => { pool.writeUInt16LE(1, poolOffsets.compoundingFeeBps!); }));
    rejects(withPoolMutation(actualRaw, pool => { pool[poolOffsets.collectFeeMode!] = 0; }));
    const wrongVault = structuredClone(emptyStateFixture.stateResponse);
    wrongVault.result.value[4].owner = SystemProgram.programId.toBase58();
    rejects(JSON.stringify(wrongVault));
    const missing = structuredClone(emptyStateFixture.stateResponse);
    missing.result.value[4] = null;
    rejects(JSON.stringify(missing));
  });

  await t.test('unknown, duplicate, mutable, malformed, and trailing Token-2022 TLVs stay unsupported', () => {
    const raw = JSON.stringify(emptyStateFixture.stateResponse);
    const rejects = (candidate: string) => assert.throws(() => decodeEmptyDammState(candidate, actualEmptyToken as any, actualEmptyPool, emptyStateFixture.minSlot), /DAMM_TOKEN_MODE_UNSUPPORTED/);
    rejects(withMintMutation(raw, mint => mint.writeUInt16LE(99, 166)));
    rejects(withMintMutation(raw, mint => mint.writeUInt16LE(18, 234)));
    rejects(withMintMutation(raw, mint => { mint[238] = 1; }));
    rejects(withMintMutation(raw, mint => mint.writeUInt16LE(0xffff, 236)));
    rejects(withMintMutation(raw, mint => Buffer.concat([mint, Buffer.from([0])])));
  });
});

test('the production empty DAMM inspection retains its read-only proof and routes seven criteria through the same O08 witness', async () => {
  const program = JSON.parse(bundleFixture.rawArtifacts['damm-program']!) as any;
  const programData = JSON.parse(bundleFixture.rawArtifacts['damm-program-data']!) as any;
  const slot = emptyStateFixture.stateResponse.result.context.slot;
  program.result.context.slot = slot;
  programData.result.context.slot = slot;
  const calls: Array<{ url: string; method?: string; addresses?: string[] }> = [];
  let programRead = 0;
  let clock = Date.parse(emptyStateFixture.capturedAt);
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://api.dexscreener.com/')) return jsonResponse([]);
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const addresses = request.method === 'getMultipleAccounts' ? request.params[0] as string[] : undefined;
    calls.push({ url, method: request.method, addresses });
    if (request.method === 'getMultipleAccounts' && addresses?.length === 1) return jsonResponse(emptyStateFixture.poolResponse);
    if (request.method === 'getMultipleAccounts' && addresses?.length === 5) return jsonResponse(emptyStateFixture.stateResponse);
    if (request.method === 'getAccountInfo') return jsonResponse(programRead++ === 0 ? program : programData);
    throw new Error(`UNEXPECTED_EMPTY_DAMM_REQUEST:${request.method}`);
  };
  const read = await inspectDammV2(
    actualEmptyToken as any, emptyStateFixture.poolAddress, { ...starterProfile(), sizeUsd: '25' }, undefined,
    emptyStateFixture.minSlot, 'https://rpc.fixture/', fetcher,
    () => new Date(clock++).toISOString(),
  );
  const inspection = read.inspection as typeof read.inspection & { screening?: Record<string, any> };
  assert.equal(inspection.version, 'meteora-damm-v2-sdk-1.5.1-native-empty-v1');
  assert.equal(inspection.certificateId, `meteora-damm-v2-native-empty:${emptyStateFixture.poolAddress}`);
  assert.equal(inspection.bindingVerified, true);
  assert.equal(inspection.screening?.assetSide, 'B');
  assert.equal(read.venue, undefined, 'the empty route does not manufacture VenueFacts or a quote');
  assert.equal(read.rawArtifacts['damm-calculation'], JSON.stringify(inspection.screening));
  assert.ok(read.rawArtifacts['damm-program']);
  assert.ok(read.rawArtifacts['damm-program-data']);
  assert.equal(Object.keys(read.rawArtifacts).some(id => /damm-(?:simulation|entry-fee|exit-fee|payers|user-accounts|blockhash)/.test(id)), false,
    'the empty branch produces no fees, payer setup, or simulated swap');
  assert.ok(calls.some(call => call.method === 'getMultipleAccounts' && call.addresses?.length === 5));

  const at = inspection.screening!.availableAt as string;
  const cutoff = new Date(Date.parse(at) + 10_000).toISOString();
  const evidence: EvidenceRecord[] = inspection.evidenceIds.map(id => {
    const derived = id === 'damm-calculation' || id === 'damm-requests';
    const sourceId = derived ? 'meteora-damm-derived' : id === 'rpc-genesis' ? 'solana-rpc' : id === 'pump-sol-usd' ? 'dexscreener' : 'meteora-damm-direct';
    const raw = id === 'rpc-genesis' ? JSON.stringify(emptyStateFixture.genesisResponse) : read.rawArtifacts[id];
    assert.equal(typeof raw, 'string', `the portable fixture retains raw evidence for ${id}`);
    const actualAt = id === 'rpc-genesis' ? emptyStateFixture.genesisAvailableAt : read.retrievedAt[id]!;
    const oldObservation = id === 'rpc-genesis' || id === 'pump-sol-usd';
    const evidenceAt = oldObservation ? new Date(Date.parse(cutoff) - 600_000).toISOString() : actualAt;
    return {
      id, sourceId, sourceType: derived ? 'CALCULATION' : id === 'pump-sol-usd' ? 'MARKET_API' : 'JSON_RPC',
      retrievedAt: evidenceAt, availableAt: evidenceAt, contentHash: contentHash(raw!),
      adapterVersion: 'live-v1', accessMode: derived ? 'LOCAL_DERIVED' as const : 'PUBLIC_API' as const, scope: {},
    };
  });
  const baseline = deriveBaseline({ sharedMode: true, token: actualEmptyToken as any, cutoff, profile: starterProfile(), features: [], evidence, observations: [], venueInspection: inspection as any });
  const features = baseline.flatMap(row => row.projection ? [row.projection] : []);
  const resolved = resolveEmptyVenueEntries(baseline, starterProfile(), cutoff);
  assert.deepEqual(Object.keys(resolved ?? {}).sort(), ['ADV-05', 'CAP-01', 'EXE-01', 'EXE-02', 'EXE-03', 'LIQ-01', 'SEC-05']);
  assert.deepEqual(Object.values(resolved!).map(row => row.outcome), [
    'SUPPORTED', 'SUPPORTED', 'INSUFFICIENT', 'CONTRADICTED', 'INSUFFICIENT', 'INSUFFICIENT', 'INSUFFICIENT',
  ]);
  assert.ok(Object.values(resolved!).every(row => row.featureIds.length === 1 && row.featureIds[0] === 'O08'));
  assert.ok(Object.values(resolved!).every(row => row.evidenceIds.join(',') === inspection.screening!.evidenceIds.join(',')),
    'each fixed decision retains the full underlying O08 source links');

  const gates = entryEvidenceGates(baseline, true, starterProfile(), cutoff)!;
  const expectedStatuses = new Map([
    ['CAP-01', 'PASS'], ['SEC-05', 'PASS'], ['LIQ-01', 'FAIL'], ['EXE-01', 'FAIL'],
    ['EXE-02', 'FAIL'], ['EXE-03', 'FAIL'], ['ADV-05', 'FAIL'],
  ]);
  const collection: LiveCollection = {
    rpc: { state: 'OBSERVED' }, dex: { state: 'NO_RESULTS' }, web: { state: 'NO_RESULTS' },
  };
  const groupInput = { token: actualEmptyToken as any, cutoff, profile: starterProfile(), baseline, evidence, collection };
  const groups = deriveEntryGroups(groupInput);
  const result = evaluateEntry(features, starterProfile(), cutoff, 'QUALIFIED_V4', undefined, true, undefined, gates, groups);
  for (const [id, status] of expectedStatuses) assert.equal(result.checks.find(row => row.checkId === id)?.status, status);

  const shared = deriveShared({ qualityMode: 'ENTRY_GROUPS_V1', groups, token: actualEmptyToken as any, cutoff, profile: starterProfile(), baseline, features, evidence, observations: [], claims: [], sources: [], audit: null, semanticReceiptIds: [] });
  const sharedRows = shared.facts.witnesses.filter(row => expectedStatuses.has(row.checkId));
  assert.equal(sharedRows.length, expectedStatuses.size);
  assert.ok(sharedRows.every(row => row.route === 'qualified-venue'));
  assert.ok(sharedRows.every(row => row.evidenceIds.join(',') === inspection.screening!.evidenceIds.join(',')));
  const sharedO08Freshness = shared.facts.freshness.find(row => row.featureId === 'O08')!;
  assert.equal(sharedO08Freshness.fresh, true, 'old genesis and native-price references do not age out the direct empty-pool inspection');
  assert.ok(sharedO08Freshness.evidenceIds.includes('damm-state') && sharedO08Freshness.evidenceIds.includes('damm-program'));
  assert.equal(sharedO08Freshness.evidenceIds.includes('rpc-genesis'), false);
  assert.equal(sharedO08Freshness.evidenceIds.includes('pump-sol-usd'), false);

  const freshGroup = deriveEntryGroups(groupInput).groups.find(row => row.checkId === 'ADV-05')!;
  assert.deepEqual([freshGroup.status, freshGroup.code], ['FAIL', 'DAMM_NO_ACTIVE_LIQUIDITY']);
  assert.deepEqual(freshGroup.evidenceIds, inspection.screening!.evidenceIds,
    'the fixed group keeps every original provenance link even though only direct state controls its freshness');
  const staleDirectEvidence = evidence.map(row => row.id === 'damm-state'
    ? { ...row, availableAt: new Date(Date.parse(cutoff) - 31_000).toISOString(), retrievedAt: new Date(Date.parse(cutoff) - 31_000).toISOString() }
    : row);
  const staleGroup = deriveEntryGroups({ ...groupInput, evidence: staleDirectEvidence }).groups.find(row => row.checkId === 'ADV-05')!;
  assert.deepEqual([staleGroup.status, staleGroup.code], ['UNKNOWN', 'GROUP_SOURCE_STALE_OR_MISSING'],
    'a direct pool-state observation older than thirty seconds cannot retain the completed group outcome');
  assert.deepEqual(staleGroup.evidenceIds, inspection.screening!.evidenceIds,
    'freshness changes the result without dropping its original evidence links');

  const snapshot = {
    id: 'empty-damm-test', caseId: 'empty-damm-case', checklistKind: 'ENTRY', token: actualEmptyToken, cutoff,
    analysisKind: 'FIXTURE', features, evidence, result, hash: 'a'.repeat(64),
    details: { version: 1, profile: starterProfile(), thesis: null, origins: {}, stageInputs: { circulatingMarketCapUsd: null, tokenCreatedAt: null }, baseline },
  } as unknown as EntrySnapshot;
  const report = buildEntryReport(snapshot);
  const reported = new Map(report.checks.filter(row => expectedStatuses.has(row.checkId)).map(row => [row.checkId, row.outcome]));
  assert.deepEqual(Object.fromEntries(reported), {
    'ADV-05': 'INSUFFICIENT', 'CAP-01': 'SUPPORTED', 'EXE-01': 'CONTRADICTED', 'EXE-02': 'INSUFFICIENT',
    'EXE-03': 'INSUFFICIENT', 'LIQ-01': 'INSUFFICIENT', 'SEC-05': 'SUPPORTED',
  });
  const fullText = renderSnapshot(snapshot, { details: snapshot.details });
  assert.match(fullText, /The selected pool has no active liquidity\. No quote, fee estimate, removable-liquidity fraction or round-trip simulation was produced\./,
    'a fresh recognized empty resolution explains the unmeasured execution facts in the full report');
  const checkText = renderSnapshot(snapshot, { details: snapshot.details, check: 'EXE-01' });
  assert.match(checkText, /Evidence assessment: The verified empty selected pool cannot quote the configured nonzero entry\./,
    'a check view reports the fixed code-owned resolver rationale');

  const legacyDetails = structuredClone(snapshot.details!);
  const legacyO08 = legacyDetails.baseline.find(row => row.id === 'O08')!;
  const legacyInspection = legacyO08.data as { version: string; screening?: unknown };
  legacyInspection.version = 'meteora-damm-v2-sdk-1.5.1-native-b-v1';
  delete legacyInspection.screening;
  const legacyText = renderSnapshot({ ...snapshot, details: legacyDetails }, { details: legacyDetails });
  assert.doesNotMatch(legacyText, /The selected pool has no active liquidity\./,
    'the new empty-route explanation does not leak into legacy snapshots');

  const expiredCutoff = new Date(Date.parse(inspection.screening!.expiresAt as string) + 1).toISOString();
  const expiredGates = entryEvidenceGates(baseline, true, starterProfile(), expiredCutoff);
  assert.ok(expiredGates?.venueResolutions);
  assert.ok(Object.values(expiredGates.venueResolutions!).every(row => row.status === 'UNKNOWN'),
    'a recognized expired marker retains explicit UNKNOWN decisions instead of disappearing');
  const expiredGroups = deriveEntryGroups({ ...groupInput, cutoff: expiredCutoff });
  const expired = evaluateEntry(features, starterProfile(), expiredCutoff, 'QUALIFIED_V4', undefined, true, undefined, expiredGates, expiredGroups);
  assert.equal(expired.checks.find(row => row.checkId === 'LIQ-01')?.status, 'UNKNOWN');
  assert.equal(expired.checks.find(row => row.checkId === 'EXE-01')?.status, 'UNKNOWN');
  assert.equal(expired.checks.find(row => row.checkId === 'ADV-05')?.status, 'UNKNOWN');
  assert.equal(resolveEmptyVenueEntries(baseline, starterProfile(), expiredCutoff)?.['EXE-01']?.outcome, 'UNKNOWN');
  assert.doesNotMatch(renderSnapshot({ ...snapshot, cutoff: expiredCutoff }, { details: snapshot.details }),
    /The selected pool has no active liquidity\./,
    'expired empty-pool evidence cannot display the completed empty-pool explanation');
});
