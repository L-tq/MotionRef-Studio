import { useEffect, useRef } from "react";
import { Box, Video } from "lucide-react";
import { useT } from "../i18n";
import type { MentionItem } from "../agent/mentions";

const SECTION_KEY: Record<MentionItem["section"], string> = {
  objects: "chat.mentionObjects",
  cameras: "chat.mentionCameras",
  snapshots: "chat.mentionSnapshots",
  images: "chat.mentionImages",
};

/** Floating `@` suggestion list, anchored at the caret (viewport coordinates
 *  measured by the composer's mirror div). Keyboard handling lives in the
 *  composer — focus never leaves the textarea, rows accept on click. */
export function MentionPopup({
  items,
  activeIndex,
  x,
  y,
  above,
  onHover,
  onAccept,
  onClose,
}: {
  items: MentionItem[];
  activeIndex: number;
  x: number;
  y: number;
  above: boolean;
  onHover: (i: number) => void;
  onAccept: (item: MentionItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Dismiss on any pointer press outside the popup; a press on the textarea
  // re-syncs the mention via its own onSelect handler.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [onClose]);

  // Keep the highlighted row visible while arrowing through the list.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items]);

  const left = Math.min(Math.max(6, x), window.innerWidth - 306);
  const style: React.CSSProperties = above
    ? { left, top: y, transform: "translateY(-100%)" }
    : { left, top: y };

  return (
    <div ref={rootRef} className="mention-pop" style={style}>
      <div ref={listRef} className="mention-list">
        {items.length === 0 && <div className="mention-empty">{t("chat.mentionEmpty")}</div>}
        {items.map((item, i) => {
          const prev = items[i - 1];
          const header = i === 0 || prev.section !== item.section ? SECTION_KEY[item.section] : null;
          return (
            <div key={`${item.section}-${i}`} style={{ display: "contents" }}>
              {header && <div className="mention-section">{t(header)}</div>}
              <button
                type="button"
                data-idx={i}
                className={`mention-item ${i === activeIndex ? "active" : ""}`}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => onAccept(item)}
                onMouseEnter={() => onHover(i)}
              >
                {item.dataUrl ? (
                  <img className="mention-thumb" src={item.dataUrl} alt="" />
                ) : (
                  <span className="mention-glyph">{item.kind === "camera" ? <Video size={11} /> : <Box size={11} />}</span>
                )}
                <span className="mention-label">{item.label}</span>
                {item.sublabel && <span className="mention-sub">{item.sublabel}</span>}
              </button>
            </div>
          );
        })}
      </div>
      <div className="mention-hint">{t("chat.mentionHint")}</div>
    </div>
  );
}
