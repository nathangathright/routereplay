import { RENDERER_VERSION, SUPPORTED_SCHEMA_VERSIONS } from './constants';
import type { NormalizedSceneV1 } from './types';

/**
 * Compatibility policy for stored and published records (see docs/compatibility.md):
 * the current renderer plays any record with a supported schema version and the same
 * renderer major version. Minor/patch renderer changes must keep old fixtures playable.
 */
export function compatibility(record: Pick<NormalizedSceneV1, 'schemaVersion' | 'compatibility'>):
  | { ok: true }
  | { ok: false; reason: string } {
  if (!(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(record.schemaVersion)) {
    return { ok: false, reason: `Scene schema version ${record.schemaVersion} is not supported by this player.` };
  }
  const major = (v: string) => Number(v.split('.')[0]);
  if (major(record.compatibility.rendererVersion) !== major(RENDERER_VERSION)) {
    return {
      ok: false,
      reason: `This journey needs renderer ${record.compatibility.rendererVersion}; this player is ${RENDERER_VERSION}.`,
    };
  }
  return { ok: true };
}
