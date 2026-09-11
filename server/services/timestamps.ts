import { z } from 'zod';

/**
 * Client timestamps must be ISO-8601 with an explicit offset or Z. Anything looser (a bare
 * number, a locale date, an offset-less ISO string) would be read in the server's own time
 * zone by Date.parse and silently move the event, and with it the exit step.
 */
export const clientTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((s) => !Number.isNaN(Date.parse(s)), 'client_timestamp must be a real date')
  .transform((s) => new Date(Date.parse(s)).toISOString());

/** The normalised UTC ISO string, or null when the value is not an acceptable client timestamp. */
export function toIsoTimestamp(value: unknown): string | null {
  const parsed = clientTimestampSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
