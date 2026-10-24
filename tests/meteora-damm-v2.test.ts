import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { starterProfile } from '../src/app/config.js';
import type { LiveBundle } from '../src/domain/contracts.js';
import { decodeDammState, quoteDamm, validateDammBundle, verifyDammSimulation } from '../src/providers/meteora-damm-v2.js';

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
const poolKey = new PublicKey(fixture.poolAddress);
const profile = { ...starterProfile(), sizeUsd: fixture.sizeUsd };
const parsed = (id: string) => JSON.parse(fixture.rawArtifacts[id]) as Record<string, any>;
const contentHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
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
