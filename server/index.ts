import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { ensureSeed } from './seed';
import { generateTraffic } from '../scripts/traffic/generator';
import { injectTransport } from '../scripts/traffic/transport';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const configsDir = join(process.cwd(), 'configs');

const app = buildApp({
  dbPath: join(dataDir, 'funnel.db'),
  adminToken: process.env.ADMIN_TOKEN || null,
  // When bundled, this file lives in dist/ next to dist/web. In dev Vite serves the web app.
  staticDir: join(here, 'web'),
  logger: true,
});

try {
  // An empty database (fresh disk on the free host) gets v1 published before the first request.
  await ensureSeed(app, { configsDir });
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// Demo traffic runs after listen so the host's health check passes while it seeds;
// ensureSeed only runs it on a database without sessions.
if (process.env.SEED_ON_BOOT === '1') {
  void ensureSeed(app, {
    configsDir,
    runTraffic: (a) =>
      generateTraffic({ transport: injectTransport(a), sessions: 120, seed: 42, log: (line) => a.log.info(line) }).then(
        (summary) => {
          if (!summary.ok) a.log.warn('seed traffic: analytics do not match the simulation');
        },
      ),
  }).catch((err: unknown) => app.log.error(err));
}
