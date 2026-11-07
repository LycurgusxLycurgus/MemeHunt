import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const PROFILE_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
const PAIRS_URL = 'https://api.dexscreener.com/tokens/v1/solana/';
const SELECTION_RULE = [
  'Fetch the DexScreener latest profiles list https://api.dexscreener.com/token-profiles/latest/v1. Keep the solana entries, first 30 unique.',
  'For those, fetch the best pair by liquidity from https://api.dexscreener.com/tokens/v1/solana/<mints>.',
  'Drop excluded mints. Keep pairs with volume.h24 > min-volume. Take the first N in order.',
].join('\n');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const captureScript = resolve(repoRoot, 'scripts/capture-cli.mjs');

function valueAfter(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args) {
  const options = { out: null, resumeDir: null, rebuildSummary: null, n: null, minVolume: 10000, excludeDirs: [], mintsFile: null, config: resolve(repoRoot, '.data/config.json'), dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--out') {
      options.out = resolve(valueAfter(args, i++, arg));
    } else if (arg === '--resume') {
      options.resumeDir = resolve(valueAfter(args, i++, arg));
    } else if (arg === '--rebuild-summary') {
      options.rebuildSummary = resolve(valueAfter(args, i++, arg));
    } else if (arg === '--n') {
      const raw = valueAfter(args, i++, arg);
      options.n = Number(raw);
      if (!Number.isSafeInteger(options.n) || options.n < 1) throw new Error('--n must be a positive integer');
    } else if (arg === '--min-volume') {
      options.minVolume = Number(valueAfter(args, i++, arg));
      if (!Number.isFinite(options.minVolume)) throw new Error('--min-volume must be a number');
    } else if (arg === '--exclude-dirs') {
      let count = 0;
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        options.excludeDirs.push(resolve(args[++i]));
        count++;
      }
      if (!count) throw new Error('--exclude-dirs requires at least one directory');
    } else if (arg === '--mints') {
      options.mintsFile = resolve(valueAfter(args, i++, arg));
    } else if (arg === '--config') {
      options.config = resolve(repoRoot, valueAfter(args, i++, arg));
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.rebuildSummary) {
    if (options.out || options.resumeDir || options.dryRun) throw new Error('--rebuild-summary cannot be combined with --out, --resume, or --dry-run');
    return options;
  }
  if (options.resumeDir) {
    if (options.out && options.out !== options.resumeDir) throw new Error('--out must match --resume when both are supplied');
    options.out = options.resumeDir;
    if (!existsSync(join(options.out, 'selection.json')) || !existsSync(join(options.out, 'summary.jsonl'))) {
      throw new Error('--resume requires selection.json and summary.jsonl');
    }
  } else if (options.out && existsSync(options.out) && readdirSync(options.out).length) {
    throw new Error('--out must not exist or must be empty');
  }
  if (!options.out) throw new Error('--out is required unless --resume or --rebuild-summary is used');
  if (options.n === null && !options.resumeDir) throw new Error('--n is required');
  return options;
}

function readMints(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function bundleFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...bundleFiles(path));
    else if (entry.isFile() && entry.name.endsWith('-bundle.json')) files.push(path);
  }
  return files;
}

function excludedMints(dirs) {
  const mints = new Set();
  for (const dir of dirs) {
    for (const path of bundleFiles(dir)) {
      try {
        const bundle = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof bundle?.token?.address === 'string') mints.add(bundle.token.address);
      } catch (error) {
        process.stderr.write(`Skipping unreadable bundle ${path}: ${firstLine(error)}\n`);
      }
    }
  }
  return mints;
}

function firstLine(error) {
  return error == null ? null : String(error?.stack ?? error).split(/\r?\n/, 1)[0];
}

function transientNetworkError(error) {
  const code = error?.cause?.code ?? error?.code;
  return [
    'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
    'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT', 'UND_ERR_REQUEST_TIMEOUT',
  ].includes(code);
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (error) {
      if (attempt === 0 && transientNetworkError(error)) continue;
      throw error;
    }
    if (response.status === 429 && attempt === 0) continue;
    if (!response.ok) throw new Error(`DexScreener HTTP ${response.status} for ${url}`);
    return response.json();
  }
  throw new Error(`DexScreener retry exhausted for ${url}`);
}

function numericField(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value);
  const number = Number(text);
  return /^(0|[1-9]\d*)(\.\d+)?$/.test(text) && Number.isFinite(number) ? number : null;
}

function pairSymbol(pair, mint) {
  const token = pair?.baseToken?.address === mint ? pair.baseToken : pair?.quoteToken?.address === mint ? pair.quoteToken : null;
  return typeof token?.symbol === 'string' ? token.symbol : null;
}

async function selectMints(options, excluded) {
  const profiles = await fetchJson(PROFILE_URL);
  if (!Array.isArray(profiles)) throw new Error('DexScreener latest profiles response is not an array');
  const seen = new Set();
  const tokens = [];
  for (const profile of profiles) {
    if (profile?.chainId !== 'solana' || typeof profile.tokenAddress !== 'string' || seen.has(profile.tokenAddress)) continue;
    seen.add(profile.tokenAddress);
    tokens.push({ mint: profile.tokenAddress, symbol: null, dexId: null });
    if (tokens.length === 30) break;
  }
  if (!tokens.length) return [];

  const pairs = await fetchJson(`${PAIRS_URL}${tokens.map(token => token.mint).join(',')}`);
  if (!Array.isArray(pairs)) throw new Error('DexScreener tokens response is not an array');
  const bestByMint = new Map(tokens.map(token => [token.mint, null]));
  for (const pair of pairs) {
    if (pair?.chainId !== 'solana') continue;
    const addresses = [pair?.baseToken?.address, pair?.quoteToken?.address];
    for (const mint of addresses) {
      if (!bestByMint.has(mint)) continue;
      const current = bestByMint.get(mint);
      const liquidity = numericField(pair?.liquidity?.usd) ?? -Infinity;
      const currentLiquidity = current ? numericField(current.liquidity?.usd) ?? -Infinity : -Infinity;
      if (!current || liquidity > currentLiquidity) bestByMint.set(mint, pair);
    }
  }

  return tokens.map(token => {
    const pair = bestByMint.get(token.mint);
    if (!pair) return null;
    const volume24hUsd = numericField(pair?.volume?.h24);
    if (excluded.has(token.mint) || volume24hUsd === null || volume24hUsd <= options.minVolume) return null;
    return {
      mint: token.mint,
      symbol: pairSymbol(pair, token.mint),
      dexId: typeof pair.dexId === 'string' ? pair.dexId : null,
      liquidityUsd: numericField(pair?.liquidity?.usd),
      volume24hUsd,
    };
  }).filter(Boolean).slice(0, options.n);
}

function planCommand(token, options) {
  const prefix = join(options.out, token.mint);
  return {
    mint: token.mint,
    command: [process.execPath, captureScript, 'analyze', token.mint, '--fast', '--db', join(options.out, `${token.mint}.sqlite`), '--config', options.config],
    cwd: repoRoot,
    env: { GROUNDING_CAPTURE_PREFIX: prefix },
  };
}

function runCapture(token, options) {
  const prefix = join(options.out, token.mint);
  const dbPath = join(options.out, `${token.mint}.sqlite`);
  const logPath = join(options.out, `${token.mint}-cli.log`);
  const command = [captureScript, 'analyze', token.mint, '--fast', '--db', dbPath, '--config', options.config];
  const startedAt = performance.now();
  let spawnError = null;
  let logError = null;
  const log = createWriteStream(logPath, { flags: 'wx' });
  log.on('error', error => { logError = error; });

  return new Promise(resolveRun => {
    let child;
    try {
      child = spawn(process.execPath, command, {
        cwd: repoRoot,
        env: { ...process.env, GROUNDING_CAPTURE_PREFIX: prefix },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error;
      log.end(() => resolveRun({ exit: null, seconds: elapsedSeconds(startedAt), error: firstLine(error) }));
      return;
    }
    child.stdout.on('data', chunk => log.write(chunk));
    child.stderr.on('data', chunk => log.write(chunk));
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => {
      log.end(() => resolveRun({
        exit: code,
        seconds: elapsedSeconds(startedAt),
        error: firstLine(spawnError ?? logError) ?? (signal ? `Process terminated by ${signal}` : null),
      }));
    });
  });
}

function elapsedSeconds(startedAt) {
  return Number(((performance.now() - startedAt) / 1000).toFixed(3));
}

function optionalJson(path) {
  if (!existsSync(path)) return { present: false, value: null };
  return { present: true, value: JSON.parse(readFileSync(path, 'utf8')) };
}

function captureMetadata(bundle, snapshot, selected) {
  const token = bundle?.token ?? snapshot?.token;
  const pairs = bundle?.market?.pairs ?? snapshot?.market?.pairs ?? [];
  const matchingPair = Array.isArray(pairs) ? pairs.find(pair => pair.baseAddress === token?.address || pair.quoteAddress === token?.address) : null;
  return {
    symbol: selected?.symbol ?? token?.symbol ?? null,
    dexId: selected?.dexId ?? matchingPair?.dexId ?? null,
  };
}

function outcomeCounts(rows) {
  const counts = {};
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  return counts;
}

let reportToolsPromise;
async function reportTools() {
  reportToolsPromise ??= import(pathToFileURL(join(repoRoot, 'dist/src/app/report.js')).href);
  return reportToolsPromise;
}

function renderedReason(snapshot, checkId, renderSnapshot) {
  const lines = renderSnapshot(snapshot).split('\n');
  const index = lines.findIndex(line => line === `${checkId}: UNKNOWN`);
  const match = lines[index + 1]?.match(/^\s*Reason:\s*(.*)$/);
  return match?.[1] ?? null;
}

function checkCauseCodes(check, explanation) {
  const causes = [
    ...(Array.isArray(check?.causes) ? check.causes : []),
    ...(Array.isArray(explanation?.causes) ? explanation.causes : []),
  ];
  return [...new Set(causes.map(cause => cause?.code).filter(code => typeof code === 'string'))];
}

function readSummaryLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function createSummaryLine(token, directory, metrics = {}) {
  let bundle = null;
  let snapshot = null;
  let report = null;
  let missingReport = true;
  let error = metrics.error ?? null;
  try {
    bundle = optionalJson(join(directory, `${token.mint}-bundle.json`)).value;
    snapshot = optionalJson(join(directory, `${token.mint}-snapshot.json`)).value;
    const reportPath = join(directory, `${token.mint}-report.json`);
    missingReport = !existsSync(reportPath);
    if (!missingReport) report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch (readError) {
    error ??= firstLine(readError);
  }
  const rows = Array.isArray(snapshot?.details?.fast?.rows) ? snapshot.details.fast.rows : [];
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const checksById = new Map(checks.map(check => [check.checkId, check]));
  let explanationsById = new Map();
  let renderSnapshot = null;
  if (snapshot) {
    const tools = await reportTools();
    renderSnapshot = tools.renderSnapshot;
    explanationsById = new Map(tools.explainChecks(snapshot).map(check => [check.checkId, check]));
  }
  const metadata = captureMetadata(bundle, snapshot, token);
  const line = {
    mint: token.mint,
    symbol: metadata.symbol,
    dexId: metadata.dexId,
    exit: metrics.exit ?? null,
    seconds: metrics.seconds ?? null,
    classification: snapshot?.details?.fast?.classification ?? null,
    outcomes: outcomeCounts(rows),
    unknownRows: rows.filter(row => row.outcome === 'UNKNOWN').map(row => {
      const check = checksById.get(row.checkId);
      const explanation = explanationsById.get(row.checkId);
      return {
        checkId: row.checkId,
        basis: check?.basis ?? null,
        codes: checkCauseCodes(check, explanation),
        reason: renderSnapshot ? renderedReason(snapshot, row.checkId, renderSnapshot) : null,
      };
    }),
    missingReport,
    ...(error ? { error } : {}),
  };
  return { line, snapshot };
}

function round(value) {
  return value === null ? null : Number(value.toFixed(3));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function summarizeDirectory(directory, selection, { refreshLines = false } = {}) {
  const summaryLinesPath = join(directory, 'summary.jsonl');
  const existingLines = readSummaryLines(summaryLinesPath);
  const priorByMint = new Map(existingLines.map(line => [line.mint, line]));
  const results = [];
  const regeneratedLines = [];
  for (const token of selection.selected) {
    const prior = priorByMint.get(token.mint);
    if (refreshLines || !prior) {
      const result = await createSummaryLine(token, directory, prior ?? {});
      results.push(result);
      regeneratedLines.push(result.line);
    } else {
      const snapshot = optionalJson(join(directory, `${token.mint}-snapshot.json`)).value;
      results.push({ line: prior, snapshot });
      regeneratedLines.push(prior);
    }
  }
  if (refreshLines) writeFileSync(summaryLinesPath, `${regeneratedLines.map(line => JSON.stringify(line)).join('\n')}${regeneratedLines.length ? '\n' : ''}`);

  const withSnapshot = results.filter(result => result.snapshot !== null);
  const seconds = results.map(result => result.line.seconds).filter(Number.isFinite);
  const causeCounts = new Map();
  const checkCounts = new Map();
  const checkPerToken = new Map();
  let rows = 0;
  let unknown = 0;
  let zeroUnknown = 0;
  for (const result of withSnapshot) {
    const tokenRows = Array.isArray(result.snapshot?.details?.fast?.rows) ? result.snapshot.details.fast.rows : [];
    rows += tokenRows.length;
    const unknownRows = tokenRows.filter(row => row.outcome === 'UNKNOWN');
    unknown += unknownRows.length;
    if (!unknownRows.length) zeroUnknown++;
    for (const row of tokenRows) {
      const outcomes = checkCounts.get(row.checkId) ?? {};
      outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
      checkCounts.set(row.checkId, outcomes);
      const perToken = checkPerToken.get(row.checkId) ?? [];
      perToken.push(row.outcome);
      checkPerToken.set(row.checkId, perToken);
    }
    for (const row of unknownRows) {
      const basis = result.line.unknownRows?.find(item => item.checkId === row.checkId)?.basis ?? null;
      const key = JSON.stringify([row.checkId, basis]);
      causeCounts.set(key, (causeCounts.get(key) ?? 0) + 1);
    }
  }
  const exits = {};
  for (const { line } of results) {
    const code = String(line.exit);
    exits[code] = (exits[code] ?? 0) + 1;
  }
  // Any identical non-positive outcome on every token means the check carries no information.
  const negativeOutcomes = new Set(['CONTRADICTED', 'FAIL', 'INSUFFICIENT', 'UNKNOWN']);
  const sameNegativeEveryToken = [...checkPerToken].flatMap(([checkId, outcomes]) => {
    if (outcomes.length !== withSnapshot.length || outcomes.length < 3) return [];
    const outcome = outcomes[0];
    return negativeOutcomes.has(outcome) && outcomes.every(item => item === outcome)
      ? [{ checkId, outcome, n: outcomes.length }]
      : [];
  });
  const summary = {
    tokens: withSnapshot.length,
    zeroUnknown,
    rows,
    unknown,
    unknownCauses: [...causeCounts].map(([key, count]) => {
      const [checkId, basis] = JSON.parse(key);
      return { checkId, basis, count };
    }),
    missingReport: results.filter(result => result.line.missingReport).length,
    exits,
    seconds: {
      median: round(median(seconds)),
      min: seconds.length ? round(Math.min(...seconds)) : null,
      max: seconds.length ? round(Math.max(...seconds)) : null,
    },
    perStage: null,
    checkOutcomes: Object.fromEntries([...checkCounts].map(([checkId, outcomes]) => [checkId, outcomes])),
    sameNegativeEveryToken,
  };
  writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.rebuildSummary) {
    const selection = JSON.parse(readFileSync(join(options.rebuildSummary, 'selection.json'), 'utf8'));
    await summarizeDirectory(options.rebuildSummary, selection, { refreshLines: true });
    return;
  }

  let selection;
  let selected = [];
  if (options.resumeDir) {
    selection = JSON.parse(readFileSync(join(options.out, 'selection.json'), 'utf8'));
    options.n ??= selection.requested;
    const completed = new Set(readSummaryLines(join(options.out, 'summary.jsonl')).map(line => line.mint));
    selected = selection.selected.filter(token => !completed.has(token.mint));
  } else {
    const excluded = options.excludeDirs.length ? excludedMints(options.excludeDirs) : new Set();
    if (options.mintsFile) selected = readMints(options.mintsFile).filter(mint => !excluded.has(mint)).map(mint => ({ mint, symbol: null, dexId: null }));
    else if (!options.dryRun) selected = await selectMints(options, excluded);
  }

  if (options.dryRun) {
    const plan = {
      options: { ...options, dryRun: true },
      selectionRule: SELECTION_RULE,
      captureCommands: selected.map(token => planCommand(token, options)),
    };
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }

  if (!options.resumeDir) {
    if (!existsSync(options.out)) mkdirSync(options.out, { recursive: true });
    selection = {
      rule: SELECTION_RULE,
      source: options.mintsFile ? 'mints-file' : 'dexscreener',
      minVolume: options.minVolume,
      requested: options.n,
      excludedDirs: options.excludeDirs,
      selected,
    };
    writeFileSync(join(options.out, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(join(options.out, 'summary.jsonl'), '', { flag: 'wx' });
  }
  const summaryLinesPath = join(options.out, 'summary.jsonl');
  for (const token of selected) {
    const capture = await runCapture(token, options);
    const { line } = await createSummaryLine(token, options.out, capture);
    appendFileSync(summaryLinesPath, `${JSON.stringify(line)}\n`);
  }
  await summarizeDirectory(options.out, selection, { refreshLines: !!options.resumeDir });
}

main().catch(error => {
  process.stderr.write(`${firstLine(error)}\n`);
  process.exitCode = 1;
});
