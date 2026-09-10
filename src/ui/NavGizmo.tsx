import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { Engine, ViewAxis } from "../core/engine";
import { useT } from "../i18n";

interface AxisDef {
  /** World axis handed to engine.setEditorView when the dot is clicked. */
  id: ViewAxis;
  dir: [number, number, number];
  color: string;
  labelKey: string;
  /** Positive display axes carry a letter and render slightly larger. */
  letter?: string;
}

// Displayed in Blender's Z-up convention: the labeled Z is the world's up axis
// (+Y), labeled Y is depth (∓Z), X is unchanged. The scene document itself
// stays Y-up — this is purely the navigation widget's presentation.
const AXES: AxisDef[] = [
  { id: "px", dir: [1, 0, 0], color: "#ff5964", labelKey: "gizmo.right", letter: "X" },
  { id: "nx", dir: [-1, 0, 0], color: "#7e2f36", labelKey: "gizmo.left" },
  { id: "nz", dir: [0, 0, -1], color: "#8adb4f", labelKey: "gizmo.back", letter: "Y" },
  { id: "pz", dir: [0, 0, 1], color: "#43702a", labelKey: "gizmo.front" },
  { id: "py", dir: [0, 1, 0], color: "#4f8fe8", labelKey: "gizmo.top", letter: "Z" },
  { id: "ny", dir: [0, -1, 0], color: "#2c5187", labelKey: "gizmo.bottom" },
];

const SIZE = 88;
const CENTER = SIZE / 2;
const RADIUS = 30;

/** Blender-style orientation widget: a ball of axis dots that tracks the editor
 *  camera. Hovering a dot names the view ("Bottom (−Y)"); clicking snaps the
 *  editor camera to that axis. The SVG is built once and animated per frame
 *  without React re-renders. */
export function NavGizmo({ engine }: { engine: Engine }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<ViewAxis | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(SIZE));
    svg.setAttribute("height", String(SIZE));
    svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);

    const circle = (r: string, fill: string): SVGCircleElement => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", String(CENTER));
      c.setAttribute("cy", String(CENTER));
      c.setAttribute("r", r);
      c.setAttribute("fill", fill);
      return c;
    };
    svg.appendChild(circle("40", "rgba(20,20,26,0.72)")).setAttribute("stroke", "rgba(255,255,255,0.14)");
    svg.appendChild(circle("1.6", "rgba(255,255,255,0.35)"));

    const lines = new Map<ViewAxis, SVGLineElement>();
    const dots: Array<{ ax: AxisDef; dot: SVGCircleElement; text: SVGTextElement | null }> = AXES.map((ax) => {
      const line = document.createElementNS(NS, "line");
      line.setAttribute("stroke", ax.color);
      line.setAttribute("stroke-width", "2");
      line.setAttribute("pointer-events", "none");
      svg.appendChild(line);
      lines.set(ax.id, line);
      const g = document.createElementNS(NS, "g");
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("r", ax.letter ? "6.5" : "5");
      dot.setAttribute("fill", ax.color);
      dot.setAttribute("class", "nav-gizmo-dot");
      dot.addEventListener("pointerenter", () => setHover(ax.id));
      dot.addEventListener("pointerleave", () => setHover((h) => (h === ax.id ? null : h)));
      dot.addEventListener("click", (ev) => {
        ev.stopPropagation();
        engine.setEditorView(ax.id);
      });
      g.appendChild(dot);
      let text: SVGTextElement | null = null;
      if (ax.letter) {
        text = document.createElementNS(NS, "text");
        text.textContent = ax.letter;
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dominant-baseline", "central");
        text.setAttribute("font-size", "7");
        text.setAttribute("font-weight", "700");
        text.setAttribute("fill", "#101014");
        text.setAttribute("pointer-events", "none");
        g.appendChild(text);
      }
      svg.appendChild(g);
      return { ax, dot, text };
    });

    host.appendChild(svg);

    const v = new THREE.Vector3();
    const pos = new Map<ViewAxis, { x: number; y: number; front: boolean }>();
    let raf = 0;
    let lastOrder = "";
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const q = engine.getEditorCamera().quaternion;
      for (const { ax } of dots) {
        v.set(ax.dir[0], ax.dir[1], ax.dir[2]).applyQuaternion(q);
        // Camera-local axes: +z points at the viewer, -y flips SVG's downward y.
        pos.set(ax.id, { x: CENTER + v.x * RADIUS, y: CENTER - v.y * RADIUS, front: v.z > 0 });
        const line = lines.get(ax.id);
        if (line && ax.letter) {
          const p = pos.get(ax.id)!;
          line.setAttribute("x1", String(CENTER));
          line.setAttribute("y1", String(CENTER));
          line.setAttribute("x2", p.x.toFixed(2));
          line.setAttribute("y2", p.y.toFixed(2));
          line.setAttribute("opacity", p.front ? "0.85" : "0.3");
        }
      }
      // Reorder back→front so front dots overlap back ones — but only when the
      // order actually changes: re-appending mid-click breaks the click target.
      const ordered = [...dots].sort((a, b) => {
        const pa = pos.get(a.ax.id)!;
        const pb = pos.get(b.ax.id)!;
        return Number(pa.front) - Number(pb.front);
      });
      const order = ordered.map(({ ax }) => ax.id).join();
      if (order !== lastOrder) {
        lastOrder = order;
        for (const { dot } of ordered) svg.appendChild(dot.parentNode as SVGElement);
      }
      for (const { ax, dot, text } of dots) {
        const p = pos.get(ax.id)!;
        dot.setAttribute("cx", p.x.toFixed(2));
        dot.setAttribute("cy", p.y.toFixed(2));
        dot.setAttribute("opacity", p.front ? "1" : "0.5");
        text?.setAttribute("x", p.x.toFixed(2));
        text?.setAttribute("y", p.y.toFixed(2));
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      svg.remove();
    };
  }, [engine]);

  const hovered = hover ? AXES.find((a) => a.id === hover) : undefined;

  return (
    <div className="nav-gizmo" ref={hostRef}>
      {hovered && <div className="nav-gizmo-tip">{t(hovered.labelKey)}</div>}
    </div>
  );
}
