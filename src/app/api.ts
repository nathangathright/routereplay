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

export function publishScene(sceneId: string, revision: number) {
  return request<PublicationRef & { apiUrl: string }>(`/api/v1/scenes/${sceneId}/publications`, {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ revision }),
  });
}

export function getPublication(id: string) {
  return request<PublicationView>(`/api/v1/publications/${id}`);
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

export interface ComposeQuestion {
  path: string;
  field: string;
  question: string;
  options?: string[];
}

export interface ComposeLeg {
  route: string;
  when: string;
  by: string;
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
  return request<{ id: string; previewUrl: string; credentials: { edit: string; owner: string } }>('/api/v1/scenes', {
    method: 'POST',
    headers: { 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify(spec),
  });
}
