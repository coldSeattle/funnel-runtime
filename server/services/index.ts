import type { Db } from '../db';
import { createEventsRepo } from '../repos/events';
import { createSessionsRepo } from '../repos/sessions';
import { createVersionsService, type VersionsService } from './versions';
import { createSessionsService, type SessionsService } from './sessions';
import { createIngestService, type IngestService } from './ingest';

export interface Services {
  versions: VersionsService;
  sessions: SessionsService;
  ingest: IngestService;
}

export function createServices(db: Db): Services {
  const sessionsRepo = createSessionsRepo(db);
  const eventsRepo = createEventsRepo(db);
  const versions = createVersionsService(db);
  const sessions = createSessionsService(sessionsRepo, eventsRepo, versions);
  const ingest = createIngestService(sessionsRepo, eventsRepo, versions);
  return { versions, sessions, ingest };
}
