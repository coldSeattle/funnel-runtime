import { z } from 'zod';
import type { EventRow, EventsRepo } from '../repos/events';
import type { SessionRow, SessionsRepo } from '../repos/sessions';
import type { VersionsService } from './versions';
import { clientTimestampSchema } from './timestamps';
import { allowedEvents, filterEventProperties } from '../../shared/engine';
import type { IngestResponse, IngestResult } from '../../shared/api';

export const MAX_BATCH_SIZE = 500;

export interface IngestService {
  ingestBatch(events: unknown[]): IngestResponse;
}

const incomingEventSchema = z
  .object({
    event_id: z.string().min(1),
    session_id: z.string(),
    name: z.string(),
    client_timestamp: clientTimestampSchema,
    step_id: z.string().nullish(),
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

type Prepared = { kind: 'row'; index: number; row: EventRow } | { kind: 'rejected'; index: number; result: IngestResult };

export function createIngestService(
  sessions: SessionsRepo,
  events: EventsRepo,
  versions: VersionsService,
): IngestService {
  return {
    ingestBatch(batch) {
      const serverTimestamp = new Date().toISOString();
      // Per batch caches: a tracker flush is almost always one session and one version.
      const sessionCache = new Map<string, SessionRow | null>();
      const allowedCache = new Map<number, Map<string, Set<string>> | null>();

      const prepared: Prepared[] = batch.map((raw, index) => {
        const reject = (reason: string): Prepared => ({
          kind: 'rejected',
          index,
          result: { event_id: readEventId(raw), status: 'rejected', reason },
        });

        const parsed = incomingEventSchema.safeParse(raw);
        if (!parsed.success) return reject('invalid_shape');
        const event = parsed.data;

        let session = sessionCache.get(event.session_id);
        if (session === undefined) {
          session = sessions.getById(event.session_id) ?? null;
          sessionCache.set(event.session_id, session);
        }
        if (!session) return reject('unknown_session');

        let allowed = allowedCache.get(session.version);
        if (allowed === undefined) {
          const config = versions.getConfig(session.version);
          allowed = config ? allowedEvents(config) : null;
          allowedCache.set(session.version, allowed);
        }
        // Raw answers can never reach analytics: only whitelisted properties survive.
        const properties = allowed ? filterEventProperties(allowed, event.name, event.properties) : null;
        if (properties === null) return reject('unknown_event');

        return {
          kind: 'row',
          index,
          row: {
            event_id: event.event_id,
            session_id: session.id,
            name: event.name,
            client_timestamp: event.client_timestamp,
            server_timestamp: serverTimestamp,
            // Everything below comes from the session row; the client is never trusted with it.
            funnel_id: session.funnel_id,
            funnel_version: session.version,
            experiment_id: session.experiment_id,
            variant: session.variant,
            assignment_source: session.assignment_source,
            step_id: event.step_id ?? null,
            utm_source: session.utm_source,
            utm_medium: session.utm_medium,
            utm_campaign: session.utm_campaign,
            properties_json: JSON.stringify(properties),
          },
        };
      });

      const results: IngestResult[] = new Array(batch.length);
      // One transaction for the whole batch: rejected items never made it this far, so
      // nothing here can roll back an accepted insert.
      events.transaction(() => {
        for (const item of prepared) {
          if (item.kind === 'rejected') {
            results[item.index] = item.result;
            continue;
          }
          const inserted = events.insert(item.row);
          results[item.index] = { event_id: item.row.event_id, status: inserted ? 'accepted' : 'duplicate' };
        }
      });

      let accepted = 0;
      let duplicates = 0;
      let rejected = 0;
      for (const result of results) {
        if (result.status === 'accepted') accepted++;
        else if (result.status === 'duplicate') duplicates++;
        else rejected++;
      }
      return { accepted, duplicates, rejected, results };
    },
  };
}

function readEventId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const id = (raw as { event_id?: unknown }).event_id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
