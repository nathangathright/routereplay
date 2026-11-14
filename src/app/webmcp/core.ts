/**
 * WebMCP: tools a page offers an agent working in a browser that supports it (`document.modelContext`). Each page
 * offers its own set: the homepage makes a draft (home.ts); a draft's page reads, changes, shows, publishes and
 * exports it, and a watch page shows and exports a published journey (scene.ts). They call the same HTTP API as
 * agents over HTTP, with the page's session, so validation, revisions and authorization are identical, and they
 * share the page with its chat and the person using it: tools wait for the chat rather than change the trip under
 * it, and the chat says what the agent did. The HTTP API stays the primary path; these are optional.
 *
 * This module only finds WebMCP and registers tools, so every page can offer them for almost nothing; the tools
 * themselves load only in a browser that supports it (`offerTools`).
 */

/** Hints for the agent's host. Chrome reports them as `readOnly`, `consequential` and `untrustedContent`. */
export interface ToolAnnotations {
  /** Reads only: changes nothing the person or anyone else sees. */
  readOnlyHint?: boolean;
  /** Has effects beyond this page that are hard to take back, such as a public link. */
  consequentialHint?: boolean;
  /** The result includes text someone else wrote, which isn't instructions. */
  untrustedContentHint?: boolean;
}

export interface ToolDef {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

interface ModelContextLike {
  registerTool: (tool: ToolDef, options?: { signal?: AbortSignal }) => unknown;
  unregisterTool?: (name: string) => void;
}

export function webMcpAvailable(): ModelContextLike | null {
  if (typeof document === 'undefined') return null;
  const doc = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (doc && typeof doc.registerTool === 'function') return doc;
  // Earlier preview builds exposed the API on navigator.
  const nav = (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (nav && typeof nav.registerTool === 'function') return nav;
  return null;
}

/** Offer tools until the returned function is called. A tool that fails to register is skipped: the page works without it. */
export function registerTools(tools: ToolDef[]): () => void {
  const mc = webMcpAvailable();
  if (!mc) return () => undefined;
  const controller = new AbortController();
  const registered: string[] = [];
  for (const tool of tools) {
    try {
      const r = mc.registerTool(tool, { signal: controller.signal });
      if (r && typeof (r as Promise<unknown>).catch === 'function') (r as Promise<unknown>).catch(() => undefined);
      registered.push(tool.name);
    } catch {
      // Already registered elsewhere, or refused: the HTTP API remains.
    }
  }
  return () => {
    controller.abort();
    if (mc.unregisterTool) for (const name of registered) try { mc.unregisterTool(name); } catch { /* already gone */ }
  };
}

/**
 * Offer the tools `load` builds until the returned function is called. `load` imports their module, so a page loads
 * the tools' code only in a browser that supports WebMCP.
 */
export function offerTools(load: () => Promise<ToolDef[]>): () => void {
  if (!webMcpAvailable()) return () => undefined;
  let stop: (() => void) | null = null;
  let cancelled = false;
  load().then(
    (tools) => {
      if (!cancelled) stop = registerTools(tools);
    },
    () => undefined,
  );
  return () => {
    cancelled = true;
    stop?.();
  };
}
