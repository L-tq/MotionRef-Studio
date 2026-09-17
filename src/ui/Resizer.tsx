import { useT } from "../i18n";

/** Draggable splitter between layout regions. dir="col" resizes horizontally
 *  (vertical bar), dir="row" vertically (horizontal bar). Double-click resets.
 *  onStart fires once on pointerdown — lets callers capture a drag baseline. */
export function Resizer({
  dir,
  onMove,
  onReset,
  onStart,
}: {
  dir: "col" | "row";
  onMove: (e: PointerEvent) => void;
  onReset?: () => void;
  onStart?: (e: PointerEvent) => void;
}) {
  const t = useT();
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    onStart?.(e.nativeEvent);
    document.body.classList.add(dir === "col" ? "resizing-col" : "resizing-row");
    const move = (ev: PointerEvent) => onMove(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col", "resizing-row");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className={`resizer ${dir}`}
      onPointerDown={start}
      onDoubleClick={onReset}
      title={t("layout.resize")}
    />
  );
}
