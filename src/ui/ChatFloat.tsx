import { useEffect, useRef } from "react";
import { useStore, type ChatFloatState } from "../state/store";
import { ChatPanel } from "./ChatPanel";

/** The undocked agent chat: a freely draggable / resizable floating window.
 *  Drag and resize apply straight to the DOM for smoothness and commit to the
 *  persisted layout once on pointerup. */

const MIN_W = 320;
const MIN_H = 260;
/** How much of the window may hang off the left/right edge while dragging. */
const OFFSCREEN = 90;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

export function ChatFloat() {
  const chatFloat = useStore((s) => s.layout.chatFloat);
  const winRef = useRef<HTMLDivElement>(null);

  // Recover from a persisted rect that no longer fits the viewport (e.g. the
  // browser window shrank since the last session).
  useEffect(() => {
    const f = useStore.getState().layout.chatFloat;
    if (!f) return;
    const w = clamp(f.w, MIN_W, window.innerWidth - 16);
    const h = clamp(f.h, MIN_H, window.innerHeight - 16);
    const x = clamp(f.x, 16 - (w - OFFSCREEN), window.innerWidth - OFFSCREEN);
    const y = clamp(f.y, 0, window.innerHeight - 56);
    if (x !== f.x || y !== f.y || w !== f.w || h !== f.h) {
      useStore.getState().setLayout({ chatFloat: { ...f, x, y, w, h } });
    }
  }, []);

  if (!chatFloat?.open) return null;

  const apply = (r: ChatFloatState) => {
    const el = winRef.current;
    if (el) {
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
    }
  };

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // The tab bar doubles as the title bar, so drags may start on its buttons;
    // a real drag suppresses the button's click via the trap below.
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    e.preventDefault();
    const f = useStore.getState().layout.chatFloat;
    if (!f) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const el = winRef.current;
    const bar = e.currentTarget as HTMLElement;
    el?.classList.add("dragging");
    document.body.classList.add("chatfloat-drag");
    let moved = false;
    const trap = (ev: MouseEvent) => {
      if (moved) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    bar.addEventListener("click", trap, true);
    const rectAt = (ev: PointerEvent): ChatFloatState => ({
      ...f,
      x: clamp(f.x + (ev.clientX - startX), 16 - (f.w - OFFSCREEN), window.innerWidth - OFFSCREEN),
      y: clamp(f.y + (ev.clientY - startY), 0, window.innerHeight - 56),
    });
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) moved = true;
      apply(rectAt(ev));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      bar.removeEventListener("click", trap, true);
      el?.classList.remove("dragging");
      document.body.classList.remove("chatfloat-drag");
      if (moved) useStore.getState().setLayout({ chatFloat: rectAt(ev) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const dir = (e.currentTarget as HTMLElement).dataset.dir ?? "";
    e.preventDefault();
    e.stopPropagation();
    const f = useStore.getState().layout.chatFloat;
    if (!f) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const el = winRef.current;
    el?.classList.add("resizing");
    document.body.classList.add("chatfloat-resize");
    const east = dir.includes("e");
    const west = dir.includes("w");
    const north = dir.includes("n");
    const south = dir.includes("s");
    const rectAt = (ev: PointerEvent): ChatFloatState => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let { x, y, w, h } = f;
      if (east) w = clamp(f.w + dx, MIN_W, window.innerWidth - f.x - 8);
      if (south) h = clamp(f.h + dy, MIN_H, window.innerHeight - f.y - 8);
      if (west) {
        w = clamp(f.w - dx, MIN_W, f.x + f.w - 8);
        x = f.x + f.w - w;
      }
      if (north) {
        h = clamp(f.h - dy, MIN_H, f.y + f.h - 8);
        y = f.y + f.h - h;
      }
      return { ...f, x, y, w, h };
    };
    const move = (ev: PointerEvent) => apply(rectAt(ev));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el?.classList.remove("resizing");
      document.body.classList.remove("chatfloat-resize");
      useStore.getState().setLayout({ chatFloat: rectAt(ev) });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={winRef}
      className="chat-float"
      style={{ left: chatFloat.x, top: chatFloat.y, width: chatFloat.w, height: chatFloat.h }}
    >
      <div className="chat-float-inner">
        <ChatPanel floating onHeaderPointerDown={startDrag} />
      </div>
      {HANDLES.map((dir) => (
        <div key={dir} data-dir={dir} className={`float-rz ${dir}`} onPointerDown={startResize} />
      ))}
    </div>
  );
}
