import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(args) {
  const options = { dist: resolve('dist'), dbDir: null, keepDb: false, dirs: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dist' || arg === '--db-dir') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--dist') options.dist = resolve(value);
      else options.dbDir = resolve(value);
      i++;
    } else if (arg === '--keep-db') {
      options.keepDb = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      options.dirs.push(arg);
    }
  }
  if (!options.dirs.length) throw new Error('At least one capture directory is required');
  options.dirs = options.dirs.map(dir => ({ input: dir, path: resolve(dir) }));
  options.dbDir ??= resolve(`.data/cycle-b/rederive-db-${Date.now()}`);
  return options;
}

function firstLine(error) {
  return error == null ? null : String(error?.stack ?? error).split(/\r?\n/, 1)[0];
}

function prepareDbDir(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(path).length) {
      throw new Error('--db-dir must be a fresh or empty directory');
    }
  } else {
    mkdirSync(path, { recursive: true });
  }
}

function mapRows(rows, value) {
  return new Map((Array.isArray(rows) ? rows : []).map(row => [row.checkId, value(row)]));
}

function compareMaps(capturedRows, replayedRows, value) {
  const captured = mapRows(capturedRows, value);
  const replayed = mapRows(replayedRows, value);
  const ids = [...captured.keys(), ...[...replayed.keys()].filter(id => !captured.has(id))];
  return ids.flatMap(checkId => {
    const left = captured.has(checkId) ? captured.get(checkId) : null;
    const right = replayed.has(checkId) ? replayed.get(checkId) : null;
    return isDeepStrictEqual(left, right) ? [] : [{ checkId, captured: left, replayed: right }];
  });
}

function rowOutcome(row) {
  return row.outcome;
}

function reasonFields(check) {
  return { basis: check.basis, unknownKind: check.unknownKind, causes: check.causes };
}

function captureFiles(dirPath) {
  return readdirSync(dirPath)
    .filter(file => file.endsWith('-bundle.json'))
    .sort()
    .map(file => ({ file, name: file.slice(0, -'-bundle.json'.length) }));
}

function blockNetwork(counter) {
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const originalLookup = dns.lookup;
  globalThis.fetch = (..._args) => {
    counter.calls++;
    throw new Error('NETWORK_BLOCKED: fetch');
  };
  net.Socket.prototype.connect = function (..._args) {
    counter.calls++;
    throw new Error('NETWORK_BLOCKED: net.Socket.connect');
  };
  dns.lookup = function (..._args) {
    counter.calls++;
    throw new Error('NETWORK_BLOCKED: dns.lookup');
  };
  return () => {
    globalThis.fetch = originalFetch;
    net.Socket.prototype.connect = originalConnect;
    dns.lookup = originalLookup;
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [{ Service }, { buildEntryReport }, { fastRouteFacts }, { deriveBaseline }] = await Promise.all([
    import(pathToFileURL(join(options.dist, 'src/app/service.js')).href),
    import(pathToFileURL(join(options.dist, 'src/app/report.js')).href),
    import(pathToFileURL(join(options.dist, 'src/app/live.js')).href),
    import(pathToFileURL(join(options.dist, 'src/domain/baseline.js')).href),
  ]);
  prepareDbDir(options.dbDir);

  const counter = { calls: 0 };
  const restoreNetwork = blockNetwork(counter);
  const skipped = [];
  const tokens = [];
  let databaseIndex = 0;
  try {
    for (const dir of options.dirs) {
      for (const { file, name } of captureFiles(dir.path)) {
        const snapshotPath = join(dir.path, `${name}-snapshot.json`);
        const reportPath = join(dir.path, `${name}-report.json`);
        if (!existsSync(snapshotPath) || !existsSync(reportPath)) {
          skipped.push({ dir: dir.input, name, reason: 'missing snapshot and report' });
          continue;
        }

        let networkCalls = 0;
        let error = null;
        let hashMatches = null;
        let rowDiffs = [];
        let reasonDiffs = [];
        let routeDiffs = [];
        let displayMatches = null;
        counter.calls = 0;
        try {
          const bundle = JSON.parse(readFileSync(join(dir.path, file), 'utf8'));
          const capturedSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
          const capturedReport = JSON.parse(readFileSync(reportPath, 'utf8'));
          const dbPath = join(options.dbDir, `${String(databaseIndex++).padStart(3, '0')}-${basename(name)}.sqlite`);
          if (existsSync(dbPath)) throw new Error(`Database path already exists: ${dbPath}`);
          const service = new Service(dbPath);
          let admitted;
          try {
            admitted = service.analyzeLive(bundle);
          } finally {
            service.close();
          }
          const replayedReport = buildEntryReport(admitted);
          hashMatches = admitted.hash === capturedSnapshot.hash;
          rowDiffs = compareMaps(
            capturedSnapshot.details?.fast?.rows,
            admitted.details?.fast?.rows,
            rowOutcome,
          );
          reasonDiffs = compareMaps(capturedReport.checks, replayedReport.checks, reasonFields);
          displayMatches = isDeepStrictEqual(replayedReport, capturedReport);

          const routeEvidenceIds = Object.keys(bundle.rawArtifacts ?? {}).filter(id => id.startsWith('jupiter-'));
          const availableAt = bundle.evidence?.find(item => item.id === 'jupiter-sol-usd')?.retrievedAt ?? bundle.cutoff;
          const facts = fastRouteFacts(bundle.rawArtifacts ?? {}, bundle.token, bundle.profile, availableAt, routeEvidenceIds);
          const baseline = deriveBaseline({
            rugReportStatus: facts.rugReportStatus,
            ...(facts.rug ? { rugLiquidity: facts.rug } : {}),
            sharedMode: true,
            token: bundle.token,
            cutoff: bundle.cutoff,
            profile: bundle.profile,
            features: bundle.features ?? [],
            evidence: bundle.evidence ?? [],
            observations: bundle.observations ?? [],
            market: bundle.market,
            collection: bundle.collection,
            semantic: bundle.semantic,
            thesis: bundle.thesis,
            origins: bundle.details?.origins,
            venue: facts.venue,
            venueOutcome: facts.failure ?? {
              state: 'NOT_STARTED',
              origin: 'DEPENDENCY',
              code: bundle.collection?.rpc?.code ?? 'LIVE_DEPENDENCY_SKIPPED',
              blockedBy: 'FINALIZE',
              evidenceIds: ['rpc-genesis', 'rpc-account'].filter(id => (bundle.rawArtifacts ?? {})[id] !== undefined),
            },
          });
          const routeIds = Array.from({ length: 9 }, (_, index) => `O${String(index + 8).padStart(2, '0')}`);
          const capturedRoute = new Map((bundle.details?.baseline ?? []).filter(row => routeIds.includes(row.id)).map(row => [row.id, row]));
          const replayedRoute = new Map(baseline.filter(row => routeIds.includes(row.id)).map(row => [row.id, row]));
          routeDiffs = routeIds.flatMap(checkId => {
            const captured = capturedRoute.get(checkId);
            const replayed = replayedRoute.get(checkId);
            const capturedFields = {
              quality: captured?.quality ?? null,
              projectionQuality: captured?.projection?.quality ?? null,
              value: captured?.projection?.value ?? null,
              causeCodes: (captured?.causes ?? []).map(cause => cause.code),
            };
            const replayedFields = {
              quality: replayed?.quality ?? null,
              projectionQuality: replayed?.projection?.quality ?? null,
              value: replayed?.projection?.value ?? null,
              causeCodes: (replayed?.causes ?? []).map(cause => cause.code),
            };
            return Object.keys(capturedFields).flatMap(field => isDeepStrictEqual(capturedFields[field], replayedFields[field])
              ? []
              : [{ checkId, field, captured: capturedFields[field], replayed: replayedFields[field] }]);
          });
        } catch (caught) {
          error = firstLine(caught);
        } finally {
          networkCalls = counter.calls;
        }
        tokens.push({ dir: dir.input, name, hashMatches, rowDiffs, reasonDiffs, routeDiffs, displayMatches, networkCalls, error });
      }
    }
  } finally {
    restoreNetwork();
    if (!options.keepDb) rmSync(options.dbDir, { recursive: true, force: true });
  }

  const summary = {
    tokens: tokens.length,
    skipped: skipped.length,
    hashDiffs: tokens.filter(token => token.hashMatches === false).length,
    rowDiffs: tokens.reduce((count, token) => count + token.rowDiffs.length, 0),
    reasonDiffs: tokens.reduce((count, token) => count + token.reasonDiffs.length, 0),
    routeDiffs: tokens.reduce((count, token) => count + token.routeDiffs.length, 0),
    displayDiffs: tokens.filter(token => token.displayMatches === false).length,
    errors: tokens.filter(token => token.error !== null).length,
    networkCalls: tokens.reduce((count, token) => count + token.networkCalls, 0),
  };
  const result = { dist: options.dist, generatedAt: new Date().toISOString(), summary, skipped, tokens };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (summary.errors || summary.networkCalls || summary.hashDiffs || summary.rowDiffs || summary.reasonDiffs || summary.routeDiffs || summary.displayDiffs) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  process.stderr.write(`${firstLine(error)}\n`);
  process.exitCode = 1;
});
