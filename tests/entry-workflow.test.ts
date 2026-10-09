import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.js';
import { starterConfig } from '../src/app/config.js';
import { fixtureBundle } from '../examples/fixtures.js';
import type { Bundle, EvidenceRecord, TokenRef } from '../src/domain/contracts.js';

const CUTOFF = '2026-09-29T12:00:00.000Z';
const TOKEN: TokenRef = { chain: 'solana', address: '3kmygWKZBkCYrgZHKfiuB9UFKTcDLTFFsKo3BWpmpump' };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function temporaryDirectory(): string { return mkdtempSync(join(tmpdir(), 'dd-entry-workflow-')); }

async function invoke(directory: string, argv: string[], options: Parameters<typeof runCli>[1] = {}, json = true, database = 'workflow.sqlite') {
  const args = [...argv, '--db', join(directory, database), '--config', join(directory, 'config.json')];
  if (json && !args.includes('--json')) args.push('--json');
  const stdout: string[] = [], stderr: string[] = [];
  const exitCode = await runCli(args, {
    env: {}, now: () => CUTOFF,
    fetcher: async () => { throw new Error('OFFLINE_TEST_MUST_NOT_FETCH'); },
    isInteractive: false,
    stdout: value => stdout.push(value), stderr: value => stderr.push(value),
    ...options,
  });
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

function userImportWithDirectClaim(): Bundle {
  const raw = JSON.stringify({ source: 'operator-supplied illustrative note' });
  const evidence: EvidenceRecord = {
    id: 'user-note', sourceId: 'user-file', sourceType: 'USER_IMPORT', retrievedAt: CUTOFF,
    availableAt: CUTOFF, contentHash: sha256(raw), adapterVersion: 'test-v1', accessMode: 'USER_IMPORT', scope: {},
  };
  return {
    token: TOKEN, cutoff: CUTOFF, analysisKind: 'USER_IMPORT', evidence: [evidence], rawArtifacts: { 'user-note': raw }, observations: [],
    features: [{ id: 'O03', value: true, unit: 'bool', quality: 'KNOWN', availableAt: CUTOFF, evidenceIds: ['user-note'], applicability: 'APPLICABLE' }],
    profile: starterConfig().profile,
  };
}

test('saved configuration commands validate, guide, cancel safely, and round-trip edited values', async () => {
  const directory = temporaryDirectory();
  try {
    const configPath = join(directory, 'config.json');
    const missing = await invoke(directory, ['config', 'show']);
    assert.equal(missing.exitCode, 4);
    assert.equal(missing.stderr, 'CONFIG_NOT_FOUND\n');
    assert.equal(existsSync(configPath), false);

    const cancelled = await invoke(directory, ['config', 'init'], { isInteractive: true, ask: async () => undefined });
    assert.equal(cancelled.exitCode, 2);
    assert.equal(existsSync(configPath), false, 'a cancelled guided draft does not create saved settings');

    const initialized = await invoke(directory, ['config', 'init']);
    assert.equal(initialized.exitCode, 0);
    assert.equal(initialized.stdout.trim().split('\n').length, 1);
    const starter = JSON.parse(initialized.stdout) as ReturnType<typeof starterConfig>;
    assert.equal(starter.profile.sizeUsd, '25');
    assert.equal(starter.preset?.selectedBy, 'USER_REQUEST');
    assert.deepEqual(JSON.parse((await invoke(directory, ['config', 'show'])).stdout), starter);
    assert.deepEqual(JSON.parse((await invoke(directory, ['config', 'validate'])).stdout), starter);

    const edited = structuredClone(starter);
    edited.profile.sizeUsd = '40';
    edited.profile.horizonSeconds = 28800;
    edited.preset!.selectedBy = 'USER_EDIT';
    const editPath = join(directory, 'edited.json');
    writeFileSync(editPath, JSON.stringify(edited), 'utf8');
    const overwritten = await invoke(directory, ['config', 'init', '--file', editPath, '--overwrite']);
    assert.equal(overwritten.exitCode, 0);
    assert.deepEqual(JSON.parse(overwritten.stdout), edited);
    const human = await invoke(directory, ['config', 'show'], {}, false);
    assert.equal(human.exitCode, 0);
    assert.match(human.stdout, /Scenario \$40, 8 hours/);
    assert.doesNotMatch(human.stdout.trim(), /^\{/);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), edited);
    assert.equal(readFileSync(configPath, 'utf8').includes('apiKey'), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI imports cannot promote direct user facts; human reports and JSON replay stay offline and exact', async () => {
  const directory = temporaryDirectory();
  try {
    const inputPath = join(directory, 'user-import.json');
    writeFileSync(inputPath, JSON.stringify(userImportWithDirectClaim()), 'utf8');
    const imported = await invoke(directory, ['analyze', TOKEN.address, '--bundle', inputPath]);
    assert.equal(imported.exitCode, 0);
    assert.equal(imported.stdout.trim().split('\n').length, 1);
    const snapshot = JSON.parse(imported.stdout) as {
      id: string; analysisKind: string; features: Array<{ id: string; value: unknown; quality: string }>;
      result: { binary: string; classification: string };
    };
    assert.equal(snapshot.analysisKind, 'USER_IMPORT');
    const direct = snapshot.features.find(feature => feature.id === 'O03');
    assert.equal(direct?.value, true, 'the imported assertion remains visible for review');
    assert.equal(direct?.quality, 'MISSING', 'user supplied direct facts cannot satisfy a mechanical check');
    assert.equal(snapshot.result.binary, 'FAIL');
    assert.equal(snapshot.result.classification, 'INSUFFICIENT_DATA');

    const human = await invoke(directory, ['show', snapshot.id], {}, false);
    assert.equal(human.exitCode, 0);
    assert.match(human.stdout, /^ENTRY — INSUFFICIENT DATA/);
    assert.match(human.stdout, /Unknown is missing evidence, not a detected-rug finding/);
    assert.match(human.stdout, /SAVED_DEFAULT|FROZEN_INPUT/);
    assert.doesNotMatch(human.stdout.trim(), /^\{/);

    const calls: string[] = [];
    const offline = { env: {}, fetcher: async (input: string | URL | Request) => { calls.push(String(input)); throw new Error('REPLAY_MUST_STAY_OFFLINE'); } };
    const shown = await invoke(directory, ['show', snapshot.id], offline);
    const replayed = await invoke(directory, ['replay', snapshot.id], offline);
    assert.deepEqual(JSON.parse(shown.stdout), snapshot);
    assert.deepEqual(JSON.parse(replayed.stdout), snapshot);
    assert.equal(calls.length, 0);

    const explain = await invoke(directory, ['explain', snapshot.id, '--check', 'SEC-01', '--evidence'], {}, false);
    assert.equal(explain.exitCode, 0);
    assert.match(explain.stdout, /SEC-01 .*UNKNOWN/);
    assert.match(explain.stdout, /O03 .*true .*MISSING/);
    assert.match(explain.stdout, /Supply qualified, fresh evidence/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('fixture output is visibly synthetic and bundle analysis does not require providers', async () => {
  const directory = temporaryDirectory();
  try {
    const bundle = fixtureBundle();
    bundle.token = TOKEN;
    const path = join(directory, 'fixture.json');
    writeFileSync(path, JSON.stringify(bundle), 'utf8');
    const human = await invoke(directory, ['analyze', TOKEN.address, '--bundle', path], {}, false);
    assert.equal(human.exitCode, 0);
    assert.match(human.stdout, /Evidence mode: FIXTURE — SYNTHETIC TEST SCENARIO; not a live token assessment/);
    assert.match(human.stdout, /Required coverage:/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a saved EVM chain choice reuses a mixed-case imported packet for a lowercase CA', async () => {
  const directory = temporaryDirectory();
  try {
    const mixedCase = `0x${'A'.repeat(40)}`;
    const lowercase = mixedCase.toLowerCase();
    const config = { ...starterConfig(), defaultChain: 'bsc' as const };
    writeFileSync(join(directory, 'config.json'), JSON.stringify(config), 'utf8');
    const text = `Reviewed project activity directly names ${mixedCase} in the bounded public source.`;
    const packet = {
      schemaVersion: 1,
      token: { chain: 'bsc', address: mixedCase },
      records: [{
        id: 'evm-call', platform: 'public-forum', url: 'https://public.example/posts/evm-call', text,
        publishedAt: '2026-09-29T11:30:00.000Z', availableAt: CUTOFF, authorId: 'reviewed-author', communityId: 'reviewed-community',
        tokenRefs: [{ chain: 'bsc', address: mixedCase }],
      }],
      reviews: [{
        recordId: 'evm-call', quote: text, reviewedBy: 'reviewer', reviewedAt: CUTOFF, methodVersion: 'human-adjudication-v1',
        rationale: 'Human review of the exact source and contract binding.', role: 'CALL', binding: 'EXACT_CONTRACT', entailment: 'DIRECT',
      }],
    };
    const packetPath = join(directory, 'research-packet.json');
    writeFileSync(packetPath, JSON.stringify(packet), 'utf8');
    const saved = await invoke(directory, ['research', 'import', packetPath]);
    assert.equal(saved.exitCode, 0);
    const storedPath = join(directory, 'research', `bsc-${lowercase}.json`);
    assert.equal(existsSync(storedPath), true, 'EVM research storage uses the chain-qualified lowercase address');
    assert.equal(JSON.parse(readFileSync(storedPath, 'utf8')).packet.token.address, mixedCase);

    const requests: string[] = [];
    const fetcher: typeof fetch = async input => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith('https://api.dexscreener.com/')) return new Response('[]');
      throw new Error(`UNEXPECTED_PROVIDER_${url}`);
    };
    const analysis = await invoke(directory, ['analyze', lowercase, '--partial'], { fetcher });
    assert.equal(analysis.exitCode, 0);
    const snapshot = JSON.parse(analysis.stdout) as {
      token: TokenRef; analysisKind: string; evidence: Array<{ id: string; sourceId: string; accessMode: string; contentHash: string }>;
      collection: { rpc: { state: string; code?: string } };
    };
    assert.deepEqual(snapshot.token, { chain: 'bsc', address: lowercase }, 'the saved chain resolves an otherwise ambiguous EVM address');
    assert.equal(snapshot.analysisKind, 'LIVE');
    assert.deepEqual(snapshot.collection.rpc, { state: 'UNAVAILABLE', code: 'EVM_READER_UNIMPLEMENTED' });
    const importedEvidence = snapshot.evidence.find(item => item.sourceId === 'curated-research');
    assert.equal(importedEvidence?.accessMode, 'USER_IMPORT');
    assert.ok(importedEvidence);
    const sourcePath = join(directory, 'artifacts', importedEvidence.contentHash);
    assert.equal(existsSync(sourcePath), true);
    assert.equal(readFileSync(sourcePath, 'utf8').includes(mixedCase), true, 'the frozen record retains the artifact-bound packet bytes');
    assert.equal(requests.length, 1, 'saved research reuse only makes the explicitly requested bounded market request');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
