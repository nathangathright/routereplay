# Runbook

Short operational notes for one maintainer.

## Production

- Worker `routereplay-web` (static assets, API, `SceneLive` Durable Object) at https://routereplay.video, a custom domain on the `routereplay.video` zone in the same account. It also still serves https://routereplay-web.resonantconcepts.workers.dev. Keep `workers_dev = true` in `wrangler.toml`: with a route configured, a deploy otherwise switches the `workers.dev` address off and breaks earlier links.
- Old Pages project `routereplay-web` (https://routereplay-web.pages.dev): redirect only. Its deployment is a single `_redirects` file sending every path with a 308 to the Worker's `workers.dev` address; keep it so earlier links work.
- D1 database `routereplay` (`786bdf85-d8da-41c8-9efb-f2c4fd42bc1e`, region ENAM), migrations through `0001_init.sql`
- Worker secret: `RATE_LIMIT_SALT` (`npx wrangler secret put RATE_LIMIT_SALT`). `PUBLIC_ORIGIN` in `wrangler.toml` is `https://routereplay.video`, so generated links use the custom domain whichever address a request arrives on. `npm run dev:worker` overrides it with the local address.
- Deploy: `npm run deploy` (build, tests, `wrangler deploy`), then `BASE_URL=https://routereplay.video npm run smoke`. The smoke test includes the live-update WebSocket.
- Logs: `npx wrangler tail routereplay-web --format json`.
- Agent access: Cloudflare's Browser Integrity Check rejects some HTTP-library User-Agents (`Python-urllib/*` gets `403 error code: 1010`). On `*.workers.dev` and `*.pages.dev` the setting can't be changed, so the agent docs tell agents to send a descriptive User-Agent. On the `routereplay.video` zone, turn it off in the zone's Security settings (or add a WAF skip rule for `/api/*`, `/agent-docs*`, `/schemas/*`, and `/llms.txt`). Check with `curl -A Python-urllib/3.12 https://routereplay.video/agent-docs`, which should return 200.
- Usage: `npm run usage` prints the last 24 hours of Worker requests (this Worker and account-wide), Durable Object requests, and D1 rows and storage against the free limits. It exits with status 1 at 70% (`--threshold` to change), so it can run from cron or CI as an alert. It uses the wrangler login or `CLOUDFLARE_API_TOKEN` (Account Analytics Read, D1 Read).

## Local development

```sh
npm install
npm test                       # unit + API integration tests (local D1 via Miniflare)
npm run dev:worker             # build, apply local D1 migrations, run the Worker (assets, API, Durable Object) on http://127.0.0.1:8788
BASE_URL=http://127.0.0.1:8788 npm run smoke   # end-to-end HTTP checks against the running server
```

`npm run dev` serves the frontend with hot reload on port 5173 and proxies the API and the live-update WebSocket to `dev:worker` on 8788.

A watch page opened with `?measure` (for example `/w/{id}?measure`) shows a device measurement panel on the device itself, uploading nothing. It records load and first-frame times, transfer, the rendered frame rate during 6 s of playback, GPU details, and a full local export. Use it for phone budget checks.

The preview at `/s/{id}?debug` shows request counts and renders at export pixel ratio with a readable canvas. `scripts/browser/compare-frames.js` compares decoded export frames with the live preview.

## Rebuilding the environment from scratch

1. Confirm Remotion license eligibility (see [assets.md](assets.md)). The Free License key is the default; set `VITE_REMOTION_LICENSE_KEY` only for a Company License.
2. `npx wrangler d1 create routereplay` and put the returned `database_id` in `wrangler.toml` (already recorded for the current database).
3. `npx wrangler d1 migrations apply routereplay --remote`
4. `npm run deploy` (creates or updates the Worker, its Durable Object class, and its assets).
5. Set the secret salt used to hash client addresses: `npx wrangler secret put RATE_LIMIT_SALT`. The custom domain route and `PUBLIC_ORIGIN` are in `wrangler.toml`; the domain's zone must be in the same Cloudflare account, and its Browser Integrity Check off (see Production).
6. Run `BASE_URL=https://<deployment> npm run smoke` and the browser checks in [verification.md](verification.md) against the deployed URL. Then run one real agent walkthrough using the Get Started prompt.
7. Turn on Cloudflare usage notifications for Workers requests and D1 at about 70% of the free limits, in the dashboard under Notifications. **Still to do:** the wrangler token gets "Authentication error" from the alerting API. Until then, `npm run usage` provides the same thresholds on demand.

## Routine maintenance

- **Dependencies:** update monthly. Rerun `npm test`, the smoke script, and a manual export check. Recheck the Remotion license on Remotion upgrades.
- **Migrations:** add `migrations/000N_*.sql`. Apply with `--local`, run the tests, then `--remote`. Never edit an applied migration.
- **Backups:** D1 Time Travel keeps 30 days of point-in-time history. A first export and restore test was done on November 11, 2026; see [verification.md](verification.md). Also keep a monthly logical export: `npx wrangler d1 export routereplay --remote --output backups/routereplay-YYYY-MM.sql` (the `backups/` folder is ignored by git). Exports contain only credential hashes, but they do include journey specs, so store them privately.
- **Restore verification (quarterly):**
  1. `npx wrangler d1 time-travel info routereplay`.
  2. Restore the latest export into a scratch database: `wrangler d1 create routereplay-restore-test`, then `wrangler d1 execute routereplay-restore-test --remote --file backups/…sql`.
  3. Confirm that row counts match and that a known publication loads, then delete the scratch database.
- **Retention:** expired idempotency records, sessions, rate-limit windows, and unpublished drafts untouched for 180 days are cleaned up opportunistically on about 2% of creates. To force a cleanup:

  ```sql
  DELETE FROM idempotency WHERE expires_at < strftime('%s','now')*1000;
  ```

## Live channel

Each draft has a `SceneLive` Durable Object (`src/server/live.ts`; rules in `src/server/liveState.ts`).

- **What it holds:**
  - The open preview sockets, each with the creator's last reported position as its socket attachment. That state disappears when the socket closes, and it is never written to D1 or storage.
  - At most one `activity` key in Durable Object storage: the agent's status line, up to 80 characters. It lapses after 3 minutes, and a storage alarm then deletes it. `{"state": "idle"}` deletes it immediately.
- **Stuck "Your agent is working" banner:** it can't outlast 3 minutes without the agent renewing it. The page's own timer hides it even if the socket drops.
- **Who asks the object:**
  - Every successful write, which notifies it.
  - Agent (bearer) reads of a draft, which fetch viewer and activity.
  - Seek and activity posts.
  - The page's own reads skip it. If `npm run usage` shows Durable Object requests climbing, look for one draft whose agent reads in a tight loop: `wrangler tail`, filtered on `/api/v1/scenes/`.
- **Verification:** `npm run smoke` drives a real socket through viewer reports, seek, activity (including a second preview connecting mid-activity), and idle.

## Requests from owners

- **Delete a journey:** the owner's agent calls `DELETE /api/v1/scenes/{id}` with the owner credential. Watch links then answer `410`. Browsers revalidate on every view, so the deletion is visible on the next load.
- **Lost owner credential:** there is no recovery path by design. Do not delete drafts by hand without proof of ownership. Abuse removal is the exception (below).
- **Leaked edit credential:** the owner rotates it with `POST /api/v1/scenes/{id}/credentials/edit`.

## Abuse and incidents

- **Illegal or abusive published content:** find the publication with `SELECT scene_id FROM publications WHERE id = ?`, then delete through the same path as owner deletion. The SQL equivalent is in `src/server/store.ts` `deleteScene`; it writes tombstones so links answer 410.
- **Creation floods:** lower `CREATE_LIMIT_PER_HOUR` / `CREATE_LIMIT_PER_DAY` (Worker variables: `[vars]` in `wrangler.toml` or the dashboard) and redeploy, or add a Cloudflare WAF rate-limiting rule on `POST /api/v1/scenes`. Do not add a human CAPTCHA to the agent path.
- **Quota exhaustion:** requests fail with Cloudflare errors, and no scene is partially written. Open previews no longer poll, so usage tracks agent activity. Find heavy drafts with `wrangler tail` before considering a paid plan; a per-draft write limit already applies (`WRITE_LIMIT_PER_HOUR`).
- **Credential exposure in logs:** the Worker never logs request bodies or headers, and unexpected errors pass through `redact()`. If a token is found in any log, rotate it (edit) or ask the owner to delete and recreate (owner).

## Supporting obsolete versions

See [compatibility.md](compatibility.md). Before removing an `/assets/<version>/` directory or a renderer major version, query `SELECT COUNT(*) FROM publications WHERE snapshot_json LIKE '%"rendererVersion":"1.%'` and keep it while any remain.
