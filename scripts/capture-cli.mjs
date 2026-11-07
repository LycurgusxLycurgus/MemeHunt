import { existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    process.stderr.write('ENV_FILE_ERROR: Could not load the local .env file.\n');
    process.exitCode = 2;
    process.exit();
  }
}

const prefix = resolve(process.cwd(), process.env.GROUNDING_CAPTURE_PREFIX ?? `.data/grounding-normal-cli-${randomUUID()}`);
const [{ Service }, { buildEntryReport }, { runCli }] = await Promise.all([
  import('../dist/src/app/service.js'),
  import('../dist/src/app/report.js'),
  import('../dist/src/cli.js'),
]);

const analyzeLive = Service.prototype.analyzeLive;
Service.prototype.analyzeLive = function (bundle) {
  writeFileSync(`${prefix}-bundle.json`, JSON.stringify(bundle, null, 2), { flag: 'wx' });
  const snapshot = analyzeLive.call(this, bundle);
  writeFileSync(`${prefix}-snapshot.json`, JSON.stringify(snapshot, null, 2), { flag: 'wx' });
  if (snapshot.checklistKind === 'ENTRY') {
    writeFileSync(`${prefix}-report.json`, JSON.stringify(buildEntryReport(snapshot), null, 2), { flag: 'wx' });
  }
  return snapshot;
};

const exitCode = await runCli(process.argv.slice(2));
if (exitCode !== 0) process.exitCode = exitCode;
