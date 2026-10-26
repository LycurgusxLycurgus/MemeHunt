import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--ca');
const address = index === -1 ? undefined : process.argv[index + 1];
try {
  if (!address || address.startsWith('--')) throw new Error('Usage: npm run build, then node scripts/free-public-research.mjs --ca <Solana mint>');
  const { collectPublicResearch } = await import(pathToFileURL(join(repo, 'dist/src/providers/public-research.js')));
  const run = mkdtempSync(join(tmpdir(), 'memehunt-free-sources-'));
  const report = await collectPublicResearch({ chain: 'solana', address });
  writeFileSync(join(run, 'public-research.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`RUN=${run}`);
  console.log(JSON.stringify({ ...report, rawArtifacts: undefined }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
