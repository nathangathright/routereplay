/**
 * On phones, while the chat drawer fills the screen, the stage shrinks into a floating window over it, like a video's
 * picture-in-picture. It can be dragged anywhere and settles against the nearer side; a tap brings the scene back.
 *
 * The stage is scaled with a CSS transform, never resized, so the canvas, the player's composition, and the labels'
 * layout stay as they are, and the move in and out animates on the compositor. The position lives in CSS variables on
 * the workspace (`--pip-x`, `--pip-y`, `--pip-scale`), which the stage and the window's touch target both read.
 */
import { type PointerEvent, type RefObject, useCallback, useEffect, useRef } from 'react';

/** Gap to the screen's sides, the chat's title bar, and the message box, px. */
const MARGIN = 12;
/** The chat's title bar below the status bar, px (h-14 in ChatPanel.tsx). */
const TITLE_BAR = 56;
/** The window's longer side, px, at most, and its largest share of the stage. */
const LONGEST = 260;
const MAX_SCALE = 0.34;
/** Travel that still counts as a tap, px. */
const TAP_SLOP = 6;
/** How far a fling carries the window, in ms of its release speed. */
const FLING_MS = 150;

interface Layout {
  scale: number;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The status bar and notch's height: the page uses `viewport-fit=cover`. */
function safeTop() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top)';
  document.body.append(probe);
  const v = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return v;
}

/** Where the window can sit: between the title bar and the message box, beside either side of the screen. */
function measure(stage: HTMLElement): Layout {
  // Layout sizes, which ignore the stage's own transform.
  const scale = Math.min(MAX_SCALE, LONGEST / Math.max(stage.offsetWidth, stage.offsetHeight, 1));
  const width = stage.offsetWidth * scale;
  const height = stage.offsetHeight * scale;
  const vv = window.visualViewport;
  // The keyboard's top edge, or the screen's bottom: the drawer ends there, and its footer sits at its bottom.
  const visibleBottom = vv ? vv.height + vv.offsetTop : window.innerHeight;
  const footer = document.querySelector<HTMLElement>('#chat-panel [data-chat-footer]');
  const top = safeTop() + TITLE_BAR + MARGIN;
  const bottom = Math.max(top, visibleBottom - (footer?.offsetHeight ?? 140) - MARGIN - height);
  return { scale, width, height, left: MARGIN, right: document.documentElement.clientWidth - MARGIN - width, top, bottom };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The floating window's position and gestures. `enabled` is the phone layout; `active`, whether the drawer covers the
 * stage. Returns the handlers for the window's touch target.
 */
export function usePip(root: RefObject<HTMLElement | null>, stage: RefObject<HTMLElement | null>, enabled: boolean, active: boolean, onExpand: () => void) {
  // Which side it rests against, and how far down; `y: null` keeps it just above the message box as that moves.
  const rest = useRef<{ side: 'left' | 'right'; y: number | null }>({ side: 'right', y: null });
  const drag = useRef<{ id: number; dx: number; dy: number; x: number; y: number; moved: boolean; t: number; vx: number; vy: number } | null>(null);
  const dragged = useRef(false);

  const place = useCallback((x: number, y: number, scale: number) => {
    const el = root.current;
    if (!el) return;
    el.style.setProperty('--pip-x', `${x}px`);
    el.style.setProperty('--pip-y', `${y}px`);
    el.style.setProperty('--pip-scale', String(scale));
  }, [root]);

  const settle = useCallback(() => {
    const s = stage.current;
    if (!s || drag.current) return;
    const l = measure(s);
    const { side, y } = rest.current;
    place(side === 'left' ? l.left : l.right, y === null ? l.bottom : clamp(y, l.top, l.bottom), l.scale);
  }, [stage, place]);

  // Keep the resting place current as the screen turns, the keyboard opens, or the message box grows.
  useEffect(() => {
    const s = stage.current;
    const rail = document.getElementById('chat-panel');
    if (!enabled || !s) return;
    settle();
    const observed = new Set<Element>();
    const ro = new ResizeObserver(() => {
      const footer = document.querySelector('#chat-panel [data-chat-footer]');
      if (footer && !observed.has(footer)) {
        observed.add(footer);
        ro.observe(footer);
      }
      settle();
    });
    for (const el of [s, rail]) {
      if (el) {
        observed.add(el);
        ro.observe(el);
      }
    }
    const vv = window.visualViewport;
    window.addEventListener('resize', settle);
    vv?.addEventListener('resize', settle);
    vv?.addEventListener('scroll', settle);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', settle);
      vv?.removeEventListener('resize', settle);
      vv?.removeEventListener('scroll', settle);
    };
  }, [enabled, stage, settle]);

  // The chat's footer only has a size once the drawer is open.
  useEffect(() => {
    if (enabled && active) settle();
  }, [enabled, active, settle]);

  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    const el = root.current;
    if (!el || !e.isPrimary) return;
    dragged.current = false;
    const x = parseFloat(el.style.getPropertyValue('--pip-x')) || 0;
    const y = parseFloat(el.style.getPropertyValue('--pip-y')) || 0;
    drag.current = { id: e.pointerId, dx: e.clientX - x, dy: e.clientY - y, x, y, moved: false, t: e.timeStamp, vx: 0, vy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [root]);

  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const s = stage.current;
    if (!d || d.id !== e.pointerId || !s) return;
    const l = measure(s);
    const x = clamp(e.clientX - d.dx, 0, l.right + MARGIN);
    const y = clamp(e.clientY - d.dy, l.top - MARGIN, l.bottom + MARGIN);
    if (!d.moved && Math.hypot(x - d.x, y - d.y) < TAP_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      root.current?.setAttribute('data-pip-dragging', '');
    }
    const dt = Math.max(1, e.timeStamp - d.t);
    // A smoothed speed, px/ms, for the fling.
    d.vx = 0.6 * ((x - d.x) / dt) + 0.4 * d.vx;
    d.vy = 0.6 * ((y - d.y) / dt) + 0.4 * d.vy;
    d.x = x;
    d.y = y;
    d.t = e.timeStamp;
    place(x, y, l.scale);
  }, [stage, root, place]);

  const onPointerEnd = useCallback((e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    const s = stage.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    root.current?.removeAttribute('data-pip-dragging');
    if (!d.moved || !s) return;
    dragged.current = true;
    const l = measure(s);
    const x = d.x + d.vx * FLING_MS;
    const y = clamp(d.y + d.vy * FLING_MS, l.top, l.bottom);
    rest.current = { side: x + l.width / 2 < document.documentElement.clientWidth / 2 ? 'left' : 'right', y: y >= l.bottom - 8 ? null : y };
    settle();
  }, [stage, root, settle]);

  // A tap, Enter, or Space brings the scene back; the click that ends a drag doesn't.
  const onClick = useCallback(() => {
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onExpand();
  }, [onExpand]);

  return { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onClick };
}
