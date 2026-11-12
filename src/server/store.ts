/** D1 persistence for drafts, revisions, publications, and sessions. */

export interface SceneRow {
  id: string;
  revision: number;
  spec_json: string;
  normalized_json: string;
  edit_token_hash: string;
  owner_token_hash: string;
  edit_generation: number;
  created_at: number;
  updated_at: number;
}

export interface PublicationRow {
  id: string;
  scene_id: string;
  revision: number;
  snapshot_json: string;
  created_at: number;
}

export interface SessionRow {
  id_hash: string;
  scene_id: string;
  role: 'edit' | 'owner';
  generation: number;
  created_at: number;
  expires_at: number;
}

export const REVISIONS_KEPT = 50;
export const DRAFT_RETENTION_DAYS = 180;

export async function getScene(db: D1Database, id: string): Promise<SceneRow | null> {
  return db.prepare('SELECT * FROM scenes WHERE id = ?').bind(id).first<SceneRow>();
}

export async function insertScene(db: D1Database, row: SceneRow): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO scenes (id, revision, spec_json, normalized_json, edit_token_hash, owner_token_hash, edit_generation, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.revision,
        row.spec_json,
        row.normalized_json,
        row.edit_token_hash,
        row.owner_token_hash,
        row.edit_generation,
        row.created_at,
        row.updated_at,
      ),
    db
      .prepare('INSERT INTO scene_revisions (scene_id, revision, spec_json, normalized_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(row.id, row.revision, row.spec_json, row.normalized_json, row.created_at),
  ]);
}

/**
 * Atomic compare-and-swap replacement. Returns the new revision, or null when
 * `expectedRevision` no longer matches (another writer won).
 */
export async function replaceScene(
  db: D1Database,
  id: string,
  expectedRevision: number,
  specJson: string,
  normalizedJson: string,
  now: number,
): Promise<number | null> {
  const next = expectedRevision + 1;
  const [update] = await db.batch([
    db
      .prepare(
        'UPDATE scenes SET revision = ?, spec_json = ?, normalized_json = ?, updated_at = ? WHERE id = ? AND revision = ?',
      )
      .bind(next, specJson, normalizedJson, now, id, expectedRevision),
    // Only copies a row that this batch's UPDATE produced; OR IGNORE keeps a lost race harmless.
    db
      .prepare(
        `INSERT OR IGNORE INTO scene_revisions (scene_id, revision, spec_json, normalized_json, created_at)
         SELECT id, revision, spec_json, normalized_json, updated_at FROM scenes
         WHERE id = ? AND revision = ? AND updated_at = ? AND spec_json = ?`,
      )
      .bind(id, next, now, specJson),
    db
      .prepare('DELETE FROM scene_revisions WHERE scene_id = ? AND revision <= ?')
      .bind(id, next - REVISIONS_KEPT),
  ]);
  return update?.meta.changes === 1 ? next : null;
}

export async function getRevision(
  db: D1Database,
  id: string,
  revision: number,
): Promise<{ revision: number; spec_json: string; normalized_json: string; created_at: number } | null> {
  return db
    .prepare('SELECT revision, spec_json, normalized_json, created_at FROM scene_revisions WHERE scene_id = ? AND revision = ?')
    .bind(id, revision)
    .first();
}

export async function listRevisions(db: D1Database, id: string): Promise<{ revision: number; created_at: number }[]> {
  const r = await db
    .prepare('SELECT revision, created_at FROM scene_revisions WHERE scene_id = ? ORDER BY revision DESC')
    .bind(id)
    .all<{ revision: number; created_at: number }>();
  return r.results;
}

export async function listPublications(db: D1Database, sceneId: string): Promise<Omit<PublicationRow, 'snapshot_json'>[]> {
  const r = await db
    .prepare('SELECT id, scene_id, revision, created_at FROM publications WHERE scene_id = ? ORDER BY created_at DESC, id')
    .bind(sceneId)
    .all<Omit<PublicationRow, 'snapshot_json'>>();
  return r.results;
}

export async function insertPublication(db: D1Database, row: PublicationRow): Promise<void> {
  await db
    .prepare('INSERT INTO publications (id, scene_id, revision, snapshot_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(row.id, row.scene_id, row.revision, row.snapshot_json, row.created_at)
    .run();
}

export async function getPublication(db: D1Database, id: string): Promise<PublicationRow | null> {
  return db.prepare('SELECT * FROM publications WHERE id = ?').bind(id).first<PublicationRow>();
}

export async function isPublicationDeleted(db: D1Database, id: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS x FROM deleted_publications WHERE id = ?').bind(id).first()) !== null;
}

/** Delete a draft and everything derived from it, leaving tombstones for its watch links. */
export async function deleteScene(db: D1Database, id: string, now: number): Promise<number> {
  const results = await db.batch([
    db
      .prepare('INSERT OR IGNORE INTO deleted_publications (id, deleted_at) SELECT id, ? FROM publications WHERE scene_id = ?')
      .bind(now, id),
    db.prepare('DELETE FROM publications WHERE scene_id = ?').bind(id),
    db.prepare('DELETE FROM sessions WHERE scene_id = ?').bind(id),
    db.prepare('DELETE FROM scene_revisions WHERE scene_id = ?').bind(id),
    db.prepare("DELETE FROM idempotency WHERE scope = 'publish:' || ?").bind(id),
    db.prepare("DELETE FROM rate_limits WHERE bucket = 'scene_write:' || ?").bind(id),
    db.prepare('DELETE FROM scenes WHERE id = ?').bind(id),
  ]);
  return results[1]?.meta.changes ?? 0;
}

export async function rotateEditCredential(db: D1Database, id: string, newHash: string): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE scenes SET edit_token_hash = ?, edit_generation = edit_generation + 1 WHERE id = ?')
      .bind(newHash, id),
    db.prepare("DELETE FROM sessions WHERE scene_id = ? AND role = 'edit'").bind(id),
  ]);
}

export async function insertSession(db: D1Database, row: SessionRow): Promise<void> {
  await db
    .prepare('INSERT INTO sessions (id_hash, scene_id, role, generation, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(row.id_hash, row.scene_id, row.role, row.generation, row.created_at, row.expires_at)
    .run();
}

export async function getSession(db: D1Database, idHash: string): Promise<SessionRow | null> {
  return db.prepare('SELECT * FROM sessions WHERE id_hash = ?').bind(idHash).first<SessionRow>();
}

export async function deleteSession(db: D1Database, idHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run();
}

/**
 * Opportunistic cleanup of expired bookkeeping rows and stale unpublished drafts.
 * Drafts with publications are kept so watch links never expire silently.
 */
export async function cleanupExpired(db: D1Database, now: number): Promise<void> {
  const staleBefore = now - DRAFT_RETENTION_DAYS * 86_400_000;
  const stale = `SELECT id FROM scenes WHERE updated_at < ?1 AND NOT EXISTS (SELECT 1 FROM publications p WHERE p.scene_id = scenes.id)`;
  await db.batch([
    db.prepare('DELETE FROM idempotency WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 2 * 86_400_000),
    db.prepare(`DELETE FROM sessions WHERE scene_id IN (${stale})`).bind(staleBefore),
    db.prepare(`DELETE FROM scene_revisions WHERE scene_id IN (${stale})`).bind(staleBefore),
    db.prepare(`DELETE FROM scenes WHERE id IN (${stale})`).bind(staleBefore),
  ]);
}
