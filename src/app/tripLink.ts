/**
 * A trip handed to the homepage in its address, `/#trip=<percent-encoded text>`, as the Route Replay shortcut sends one
 * (scripts/shortcut.mjs). The chat opens with the text in its message box, for the person to read and send; nothing is
 * sent on its own, so a link can't spend someone's messages. As a fragment the text never reaches the server, and the
 * analytics beacon strips fragments; the page takes it out of the address and history at once, like a draft's `#k=`.
 */

/** The trip in a `#trip=` fragment, or null. `+` stays a plus: the shortcut encodes spaces as %20. */
export function tripFromHash(hash: string): string | null {
  const m = /^#trip=(.*)$/s.exec(hash);
  if (!m) return null;
  let text: string;
  try {
    text = decodeURIComponent(m[1]!);
  } catch {
    // A stray % that isn't an escape: keep the text as it came.
    text = m[1]!;
  }
  text = text.replace(/\r\n?/g, '\n').trim();
  return text || null;
}

let taken: string | null | undefined;

/** The homepage's trip from its address, read once (React's Strict Mode renders twice) and removed from it. */
export function takeTripFromLink(): string | null {
  if (taken === undefined) {
    taken = location.pathname === '/' ? tripFromHash(location.hash) : null;
    if (/^#trip=/.test(location.hash)) history.replaceState(history.state, '', location.pathname + location.search);
  }
  return taken;
}
