import type { SceneWarning } from '../shared/scene/warnings';
import type { NormalizedSceneV1, SceneSpecV1, ValidationIssue } from '../shared/scene/types';

export interface Capabilities {
  role: 'edit' | 'owner';
  read: boolean;
  edit: boolean;
  publish: boolean;
  delete: boolean;
  rotateEditCredential: boolean;
}

export interface PublicationRef {
  id: string;
  revision: number;
  createdAt: string;
  watchUrl: string;
}

export interface SceneView {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  previewUrl: string;
  capabilities: Capabilities;
  spec: SceneSpecV1;
  normalized: NormalizedSceneV1;
  publications: PublicationRef[];
  /** Saves only (PUT): likely mistakes that were still accepted, and suggested next steps. */
  warnings?: SceneWarning[];
  next?: string[];
}

export interface PublicationView {
  id: string;
  createdAt: string;
  watchUrl: string;
  scene: NormalizedSceneV1;
}

export interface ApiErrorInfo {
  status: number;
  code: string;
  message: string;
  hint?: string;
  issues?: ValidationIssue[];
  [k: string]: unknown;
}

export class ApiFailure extends Error {
  constructor(readonly info: ApiErrorInfo) {
    super(info.message);
  }
}

/** Counts API requests so polling cost can be measured (see docs/budgets.md). */
export const requestStats = { total: 0, notModified: 0, since: Date.now() };
if (typeof window !== 'undefined') (window as unknown as { __routereplayStats: typeof requestStats }).__routereplayStats = requestStats;

async function request<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T | null; etag: string | null }> {
  requestStats.total++;
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'x-routereplay-client': 'web', ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  if (res.status === 304) {
    requestStats.notModified++;
    return { status: 304, body: null, etag: res.headers.get('etag') };
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: Partial<ApiErrorInfo> } | null)?.error ?? {};
    throw new ApiFailure({ ...err, status: res.status, code: err.code ?? 'http_error', message: err.message ?? res.statusText });
  }
  return { status: res.status, body: json as T, etag: res.headers.get('etag') };
}

/** Exchange the fragment credential for an HttpOnly session cookie. */
export function startSession(sceneId: string, token: string) {
  return request<{ capabilities: Capabilities; expiresAt: string }>(`/api/v1/scenes/${sceneId}/session`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

export function getScene(sceneId: string, etag?: string | null) {
  return request<SceneView>(`/api/v1/scenes/${sceneId}`, etag ? { headers: { 'if-none-match': etag } } : {});
}

export function putScene(sceneId: string, expectedRevision: number, spec: unknown) {
  return request<SceneView>(`/api/v1/scenes/${sceneId}`, {
    method: 'PUT',
    body: JSON.stringify({ expectedRevision, spec }),
  });
}

/** A watch link for a revision: a new one, or (`existing`) the one it already had. */
export interface Published extends PublicationRef {
  existing: boolean;
  apiUrl: string;
  next: string[];
}

export function publishScene(sceneId: string, revision: number) {
  return request<Published>(`/api/v1/scenes/${sceneId}/publications`, {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ revision }),
  });
}

export interface RevisionRef {
  revision: number;
  createdAt: string;
}

export function listRevisions(sceneId: string) {
  return request<{ currentRevision: number; retained: number; revisions: RevisionRef[] }>(`/api/v1/scenes/${sceneId}/revisions`);
}

export function getRevision(sceneId: string, revision: number) {
  return request<RevisionRef & { spec: SceneSpecV1 }>(`/api/v1/scenes/${sceneId}/revisions/${revision}`);
}

/** An airport by IATA code; with `local` (YYYY-MM-DDTHH:MM), the UTC offset(s) valid for that local time there. */
export function lookupAirport(code: string, local?: string) {
  const query = local ? `?local=${encodeURIComponent(local)}` : '';
  return request<Record<string, unknown>>(`/api/v1/airports/${encodeURIComponent(code)}${query}`);
}

export function getPublication(id: string) {
  return request<PublicationView>(`/api/v1/publications/${id}`);
}

/** Delete a draft and all its watch links (owner only). */
export function deleteScene(sceneId: string) {
  return request<{ deleted: boolean; publicationsDeleted: number }>(`/api/v1/scenes/${sceneId}`, { method: 'DELETE' });
}

export function signOut(sceneId: string) {
  return request<{ signedOut: boolean }>(`/api/v1/scenes/${sceneId}/session`, { method: 'DELETE' });
}

/** How many homepage chat messages this browser has left (POST /api/v1/compose). */
export interface ComposeLimits {
  remaining: number;
  perHour: number;
  resetsAt: string;
  /** Set once a limit stops messages: this browser's hourly limit, or today's limit for everyone. */
  reached?: 'client' | 'everyone';
}

/** What one leg (or the whole trip) still needs; see Question in src/server/compose/resolve.ts. */
export interface ComposeQuestion {
  leg?: number;
  about?: string;
  needs: string[];
  /** Needs answered by picking one option, such as an airport: `need` is the index in `needs`. */
  choices?: { need: number; options: string[] }[];
  question: string;
  fields: string[];
  /** Part of it can be looked up (schedules, timetables, where a place is). */
  lookup: boolean;
}

export interface ComposeLeg {
  route: string;
  when: string;
  by: string;
  /** The aircraft wasn't named: a typical one for the distance. */
  typical?: true;
}

export interface ComposeReply {
  status: 'ready' | 'needs_info';
  questions: ComposeQuestion[];
  /** Present when ready. */
  legs?: ComposeLeg[];
  spec: SceneSpecV1;
  limits: ComposeLimits;
}

export interface ComposeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function getComposeLimits() {
  return request<{ limits: ComposeLimits; maxCharacters: number }>('/api/v1/compose');
}

/** Send the whole conversation; the server keeps none of it. */
export function compose(messages: ComposeMessage[]) {
  return request<ComposeReply>('/api/v1/compose', { method: 'POST', body: JSON.stringify({ messages }) });
}

/** Create a draft as an agent would (POST /api/v1/scenes). The response's credentials are shown only once. */
export function createScene(spec: SceneSpecV1) {
  return request<{
    id: string;
    revision: number;
    previewUrl: string;
    credentials: { edit: string; owner: string };
    normalized: NormalizedSceneV1;
    warnings: SceneWarning[];
  }>('/api/v1/scenes', {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(spec),
  });
}
