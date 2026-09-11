import type { Db } from '../db';
import { createEventsRepo } from '../repos/events';
import { createSessionsRepo } from '../repos/sessions';
import { createVersionsService, type VersionsService } from './versions';
import { createSessionsService, type SessionsService } from './sessions';
import { createIngestService, type IngestService } from './ingest';
import { createAnalyticsService, type AnalyticsService } from './analytics';

export interface Services {
  versions: VersionsService;
  sessions: SessionsService;
  ingest: IngestService;
  analytics: AnalyticsService;
}

export function createServices(db: Db): Services {
  const sessionsRepo = createSessionsRepo(db);
  const eventsRepo = createEventsRepo(db);
  const versions = createVersionsService(db);
  const sessions = createSessionsService(sessionsRepo, eventsRepo, versions);
  const ingest = createIngestService(sessionsRepo, eventsRepo, versions);
  const analytics = createAnalyticsService(eventsRepo, sessionsRepo, versions);
  return { versions, sessions, ingest, analytics };
}
