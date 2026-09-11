// npm run seed -- --sessions 120 --seed 42 [--url https://host]
// Without --url the generator runs in-process against the SQLite file in DATA_DIR.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildApp } from '../server/app';
import { ensureSeed } from '../server/seed';
import { generateTraffic, type GeneratorSummary } from './traffic/generator';
import { httpTransport, injectTransport } from './traffic/transport';

const USAGE = 'Usage: npm run seed -- [--sessions 120] [--seed 42] [--url https://host]';

function parseCount(raw: string, flag: string, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}, got "${raw}"\n${USAGE}`);
  return n;
}

async function main(): Promise<GeneratorSummary> {
  const { values } = parseArgs({
    options: {
      sessions: { type: 'string', default: '120' },
      seed: { type: 'string', default: '42' },
      url: { type: 'string' },
    },
  });
  const sessions = parseCount(values.sessions, '--sessions', 1);
  const seed = parseCount(values.seed, '--seed', 0);
  const log = (line: string) => console.log(line);

  if (values.url) {
    log(`Sending traffic to ${values.url}`);
    return generateTraffic({ transport: httpTransport(values.url), sessions, seed, log });
  }

  const dbPath = join(process.env.DATA_DIR ?? './data', 'funnel.db');
  log(`Sending traffic in-process to ${dbPath}`);
  const app = buildApp({ dbPath });
  try {
    await ensureSeed(app, { configsDir: fileURLToPath(new URL('../configs', import.meta.url)) });
    return await generateTraffic({ transport: injectTransport(app), sessions, seed, log });
  } finally {
    await app.close();
  }
}

main().then(
  (summary) => {
    process.exitCode = summary.ok ? 0 : 1;
  },
  (err: unknown) => {
    // fetch() reports network failures as "fetch failed" with the real reason in `cause`.
    const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : '';
    console.error(err instanceof Error ? `${err.message}${cause}` : err);
    process.exitCode = 1;
  },
);
