-- Route Replay Web: drafts, revisions, publications, browser sessions, idempotency, rate limits.
-- Credentials are stored only as SHA-256 hashes of high-entropy bearer tokens.

CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  edit_token_hash TEXT NOT NULL,
  owner_token_hash TEXT NOT NULL,
  -- Incremented when the owner rotates the edit credential; edit sessions from older generations stop working.
  edit_generation INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE scene_revisions (
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scene_id, revision)
);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX publications_by_scene ON publications(scene_id);

-- Tombstones let deleted watch links answer 410 Gone instead of an ambiguous 404.
CREATE TABLE deleted_publications (
  id TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('edit', 'owner')),
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_scene ON sessions(scene_id);

CREATE TABLE idempotency (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  -- 0 while the original request is in progress.
  status INTEGER NOT NULL,
  -- Create responses contain credentials and are AES-GCM encrypted with a key derived
  -- from the client's idempotency key, which the service never stores.
  response TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
