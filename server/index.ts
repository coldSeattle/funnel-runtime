import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { ensureSeed } from './seed';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), 'data');

const app = buildApp({
  dbPath: join(dataDir, 'funnel.db'),
  adminToken: process.env.ADMIN_TOKEN || null,
  // When bundled, this file lives in dist/ next to dist/web. In dev Vite serves the web app.
  staticDir: join(here, 'web'),
  logger: true,
});

try {
  // An empty database (fresh disk on the free host) gets v1 published before the first request.
  // The traffic generator hook is added by the generator task.
  await ensureSeed(app, { configsDir: join(process.cwd(), 'configs') });
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
