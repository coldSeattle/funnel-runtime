import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { ensureSeed, runBootDemo } from './seed';

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

// The demo runs after listen so the host's health check passes while it seeds. Only a database
// without sessions gets it (v1 traffic, then the iteration-2 scenario ending on v1); it never throws.
if (process.env.SEED_ON_BOOT === '1') {
  void runBootDemo(app, { configsDir }).catch((err: unknown) => app.log.error(err));
}
