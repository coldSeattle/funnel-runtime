// npm run iteration2 -- [--url https://host] [--traffic 60] [--seed 3] [--keep-v3] [--admin-token T]
// CLI for scripts/iteration2/check.ts. Without --url it runs against a fresh in-memory app with v1
// published. The check itself lives in its own module because the server bundles it for the boot
// demo: bundled, this file's main guard would see dist/server.js as "invoked directly".
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp } from '../server/app';
import { ensureSeed } from '../server/seed';
import { errorMessage, runIteration2Check, type Iteration2Result } from './iteration2/check';
import { httpTransport, injectTransport } from './traffic/transport';

export {
  runIteration2Check,
  type Iteration2Check,
  type Iteration2Options,
  type Iteration2Recovery,
  type Iteration2Result,
} from './iteration2/check';

const USAGE = 'Usage: npm run iteration2 -- [--url https://host] [--traffic 60] [--seed 3] [--keep-v3] [--admin-token T]';

function parseCount(raw: string, flag: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}, got "${raw}"\n${USAGE}`);
  return n;
}

async function main(): Promise<Iteration2Result> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      traffic: { type: 'string', default: '0' },
      seed: { type: 'string', default: '3' },
      'keep-v3': { type: 'boolean', default: false },
      'admin-token': { type: 'string' },
    },
  });
  const traffic = parseCount(values.traffic, '--traffic', 0);
  const seed = parseCount(values.seed, '--seed', 0);
  // The env var keeps the token out of shell history and the process list.
  const adminToken = values['admin-token'] || process.env.ADMIN_TOKEN || null;
  const configsDir = fileURLToPath(new URL('../configs', import.meta.url));
  const log = (line: string) => console.log(line);
  const common = { configsDir, traffic, seed, keepV3: values['keep-v3'], log };

  if (values.url) {
    log(`Target: ${values.url}`);
    return runIteration2Check({ ...common, transport: httpTransport(values.url, { adminToken }) });
  }
  log('Target: fresh in-memory app with v1 published (pass --url to check a deployment)');
  const app = buildApp({ adminToken });
  try {
    await ensureSeed(app, { configsDir });
    return await runIteration2Check({ ...common, transport: injectTransport(app, { adminToken }) });
  } finally {
    await app.close();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Importing the module (tests) must not start a run.
if (invokedDirectly()) {
  main().then(
    (result) => {
      process.exitCode = result.ok ? 0 : 1;
    },
    (err: unknown) => {
      console.error(errorMessage(err));
      process.exitCode = 1;
    },
  );
}
