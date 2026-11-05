import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The unpublished checkpoint stays local and read-only. Each live run has its own
// copied sources, config, database, receipts and test logs outside the checkout.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`MISSING_${name.toUpperCase()}`);
  return result;
};
const digest = text => createHash('sha256').update(text).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const fingerprint = directory => {
  const files = {};
  const walk = (path, stem = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = stem + entry.name;
      if (entry.isDirectory()) walk(join(path, entry.name), name + '/');
      else if (entry.isFile()) files[name] = digest(readFileSync(join(path, entry.name)));
      else throw new Error('REFERENCE_SYMLINK_UNSUPPORTED');
    }
  };
  for (const name of ['src', 'tests', 'examples']) walk(join(directory, name), name + '/');
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) files[name] = digest(readFileSync(join(directory, name)));
  return files;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function inspect(run) {
  const { evaluateEntry } = await import(pathToFileURL(join(repo, 'dist/src/domain/policy.js')));
  const { Service: Checklist2Service } = await import(pathToFileURL(join(repo, 'dist/src/app/service.js')));
  const { Service } = await import(pathToFileURL(join(run, 'reference/dist/src/app/service.js')));
  const snapshot = json(join(run, 'live-entry.json'));
  if (snapshot.checklistKind !== 'ENTRY' || snapshot.analysisKind !== 'LIVE') throw new Error('EXPECTED_LIVE_ENTRY');
  const service = new Service(join(run, 'live.sqlite'));
  try {
    // Never manufacture an episode or relabel an imported bundle as live.
    if (!same(snapshot, service.replay(snapshot.id))) throw new Error('REFERENCE_REPLAY_MISMATCH');
    const currentCase = service.caseFor(snapshot.token);
    if (!currentCase) throw new Error('REFERENCE_CASE_MISSING');
    const profile = snapshot.details.profile;
    const safetyIds = ['SEC-01', 'SEC-02', 'SEC-03', 'SEC-04', 'SEC-05', 'LIQ-01', 'EXE-01', 'EXE-02'];
    const c2 = evaluateEntry(snapshot.features, profile, snapshot.cutoff);
    const compatibility = safetyIds.map(id => ({
      checkId: id,
      checklist1: snapshot.result.checks.find(c => c.checkId === id)?.status,
      checklist2: c2.checks.find(c => c.checkId === id)?.status,
    }));
    if (compatibility.some(c => !c.checklist1 || c.checklist1 !== c.checklist2)) throw new Error('CHECKLIST1_POLICY_MISMATCH');
    const admission = {};
    if (currentCase.status !== 'THESIS_TRACKED') {
      const empty = { token: snapshot.token, cutoff: snapshot.cutoff, analysisKind: 'MANUAL_EMPTY', evidence: [], observations: [], features: [], profile };
      for (const [name, Constructor] of [['checklist1', Service], ['checklist2', Checklist2Service]]) {
        const consumer = new Constructor(join(run, 'live.sqlite'));
        try {
          consumer.reassess(currentCase.id, empty);
          throw new Error('UNEXPECTED_MANAGEMENT_ADMISSION');
        } catch (error) {
          if (error.message !== 'NO_ACTIVE_THESIS') throw error;
          admission[name] = error.message;
        } finally { consumer.close(); }
      }
    }
    const checks = snapshot.result.checks.map(check => ({
      ...check,
      causes: check.featureRefs.flatMap(id => snapshot.details.baseline.find(b => b.id === id)?.causes ?? []),
    }));
    const unknown = checks.filter(c => c.status === 'UNKNOWN');
    const requiredUnknown = unknown.filter(c => c.required);
    const files = fingerprint(join(run, 'reference'));
    const summary = {
      referenceSourceFingerprint: digest(Object.keys(files).sort().map(name => `${files[name]}  ${name}\n`).join('')),
      token: snapshot.token, cutoff: snapshot.cutoff, analysisKind: snapshot.analysisKind,
      profile, profileStatus: 'UNCALIBRATED_RESEARCH_INPUT', collection: snapshot.collection,
      entry: {
        classification: snapshot.result.classification, binary: snapshot.result.binary,
        counts: Object.fromEntries(['PASS', 'FAIL', 'UNKNOWN', 'NOT_APPLICABLE'].map(status => [status, checks.filter(c => c.status === status).length])),
        coverage: snapshot.result.coverage,
        unknownChecks: unknown.map(c => c.checkId), requiredUnknownChecks: requiredUnknown.map(c => c.checkId),
        failedChecks: checks.filter(c => c.status === 'FAIL').map(c => c.checkId), checks,
      },
      replay: 'IDENTICAL_AFTER_REOPEN', reusedSafetyAndExitRows: compatibility,
      management: {
        status: 'NOT_RUN',
        reason: currentCase.status === 'THESIS_TRACKED' ? 'LIVE_V7_SERVICE_AND_EXACT_QUOTE_PRODUCER_NOT_INTEGRATED' : 'NO_ACTIVE_THESIS',
        caseStatus: currentCase.status, stageInputs: snapshot.details.stageInputs,
        admission,
        // Entry-sized PumpSwap simulation receipts do not certify exact holding/leg quantities.
        exactExitQuoteProducer: 'NOT_INTEGRATED', timedManagementPaths: 'NOT_EXERCISED',
      },
      gate: 'INCOMPLETE — ZERO-UNKNOWN GATE NOT MET',
    };
    writeFileSync(join(run, 'reference-summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ ...summary, entry: { ...summary.entry, checks: undefined } }, null, 2));
  } finally { service.close(); }
}

async function main() {
  const inspectPath = value('inspect');
  if (inspectPath) { await inspect(resolve(inspectPath)); return; }
  const reference = resolve(value('reference') ?? join(repo, 'memehunt-incomplete'));
  const ca = value('ca');
  if (!ca || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) throw new Error('SOLANA_CA_REQUIRED');
  const full = args.includes('--full');
  if (full && (!process.env.TINYFISH_API_KEY || !process.env.GEMINI_API_KEY)) throw new Error('FULL_PASS_KEYS_MISSING');
  const profile = value('profile');
  if (profile && !existsSync(resolve(profile))) throw new Error('PROFILE_FILE_MISSING');
  const before = fingerprint(reference);
  const run = mkdtempSync(join(tmpdir(), 'memehunt-c1-c2-'));
  console.log(`RUN=${run}`);
  const copy = join(run, 'reference');
  mkdirSync(copy);
  // Explicit allowlist excludes credentials, operator data and unrelated source notes.
  for (const name of ['src', 'tests', 'examples', 'plans', 'README.md', 'CONTRIBUTING.md', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    if (existsSync(join(reference, name))) cpSync(join(reference, name), join(copy, name), { recursive: true });
  }
  writeFileSync(join(run, 'reference-fingerprint.json'), JSON.stringify(before, null, 2) + '\n');
  const command = (label, executable, argv, cwd, options = {}) => {
    const result = spawnSync(executable, argv, { cwd, encoding: 'utf8', maxBuffer: 24_000_000, env: process.env, timeout: options.timeout });
    writeFileSync(join(run, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.status !== 0) throw new Error(`${label.toUpperCase()}_FAILED: see ${join(run, label + '.log')}`);
    options.validate?.(result);
    console.log(`${label}: PASS`);
    return result;
  };
  try {
    command('checklist2-typecheck', 'npm', ['run', 'typecheck'], repo);
    command('checklist2-tests', 'npm', ['test'], repo);
    command('reference-install', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], copy);
    command('reference-typecheck', 'npm', ['run', 'typecheck'], copy);
    command('reference-tests', 'npm', ['test'], copy);
    // The reference CLI starts runCli without awaiting it. Keep Node alive until
    // the exported promise settles, including between provider requests.
    const liveDriver = `const keepAlive = setInterval(() => {}, 1000);
      try { const { runCli } = await import(process.argv[1]);
        process.exitCode = await runCli(process.argv.slice(2));
      } finally { clearInterval(keepAlive); }`;
    const liveArgs = ['--input-type=module', '-e', liveDriver, pathToFileURL(join(copy, 'dist/src/cli.js')).href, 'analyze', ca, '--chain', 'solana', full ? '--full' : '--partial', '--json', '--entry', '--db', join(run, 'live.sqlite')];
    if (profile) liveArgs.push('--profile', resolve(profile));
    else console.log('Using the documented starter profile provisionally; this is not an accepted final profile.');
    const live = command('live-entry', process.execPath, liveArgs, run, {
      timeout: full ? 660_000 : 180_000,
      validate: result => {
        if (!result.stdout.trim()) throw new Error('LIVE_ENTRY_EMPTY_OUTPUT');
        JSON.parse(result.stdout);
      },
    });
    writeFileSync(join(run, 'live-entry.json'), live.stdout);
    await inspect(run);
    if (args.includes('--free-sources')) {
      const { collectPublicResearch } = await import(pathToFileURL(join(repo, 'dist/src/providers/public-research.js')));
      const candidates = await collectPublicResearch({ chain: 'solana', address: ca });
      writeFileSync(join(run, 'public-research.json'), JSON.stringify(candidates, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ publicSources: candidates.sources, qualification: 'UNREVIEWED', qualifiedFeatures: candidates.qualifiedFeatures }));
    }
  } finally {
    if (!same(before, fingerprint(reference))) throw new Error('REFERENCE_CHANGED_DURING_RUN');
    console.log('Reference contents unchanged. Receipts and database retained in RUN for inspection.');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
