/** Security headers shared by Function-rendered HTML; public/_headers mirrors them for static files. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Cloudflare Web Analytics: the zone injects its beacon from static.cloudflareinsights.com into every HTML page.
  // The beacon reports to /cdn-cgi/rum on this origin (covered by connect-src 'self') and strips the query and
  // fragment from the URLs it sends, so draft credentials in #k= never leave the page.
  "script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  // Remotion's web renderer reports license usage to remotion.pro (no journey data).
  "connect-src 'self' https://www.remotion.pro",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const HTML_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};
