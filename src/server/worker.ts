/**
 * Cloudflare Worker entry. Static assets are served without invoking the Worker unless a
 * path matches assets.run_worker_first in wrangler.toml.
 */
import { type Env, handle } from './index';

export { SceneLive } from './live';

export default {
  fetch(request, env, ctx) {
    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
