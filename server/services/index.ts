import type { Db } from '../db';
import { createVersionsService, type VersionsService } from './versions';

export interface Services {
  versions: VersionsService;
}

export function createServices(db: Db): Services {
  const versions = createVersionsService(db);
  return { versions };
}
