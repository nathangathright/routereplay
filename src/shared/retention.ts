/** How long drafts and sessions last: enforced by the server (store.ts), and quoted by the chat's questions and answers. */

/** A draft that nobody has changed for this many days is deleted, unless it was published. */
export const DRAFT_RETENTION_DAYS = 180;
/** How long a browser session made from a draft credential lasts. */
export const SESSION_DAYS = 7;
