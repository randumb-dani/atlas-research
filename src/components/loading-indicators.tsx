"use client";

import { useEffect, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";

// ─── Standard loading indicator ────────────────────────────
// Morphing square→circle that spins (sp-08). Pure CSS.

interface LoadingStandardProps {
  size?: number;
  className?: string;
}

export function LoadingStandard({ size = 14, className }: LoadingStandardProps) {
  const outerSize = Math.round(size * 1.3);
  const borderWidth = Math.max(2, Math.round(size * 0.15));
  return (
    <span
      className={cn("relative inline-flex items-center justify-center shrink-0", className)}
      style={{ width: outerSize, height: outerSize }}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{ border: "1px solid color-mix(in oklab, var(--color-primary) 10%, transparent)" }}
      />
      <span
        className="block shrink-0"
        style={{
          width: size,
          height: size,
          border: `${borderWidth}px solid var(--color-primary)`,
          filter: `drop-shadow(0 0 ${Math.round(size * 0.35)}px var(--color-primary-glow))`,
          animation: "sp08-morph 2s ease-in-out infinite, sp08-spin 2s linear infinite",
        }}
      />
    </span>
  );
}

// ─── Researching swirl indicator ─────────────────────────
// A flat, base-down triangular pyramid (3 rows, 9 small triangles: 6
// pointing up, 3 pointing down) with noise-driven swirl (sp-11), inspired
// by the 3-bladed Atlas logo mark. Uses rAF + SVG.
//
// Each triangle is carried by its own rotation phase, speed, and radius
// jitter, so it drifts through the noise field on its own path — reads as
// each piece "looking around" independently, rather than moving in
// lockstep.
//
// Each triangle's tilt direction is derived from the SAME angle driving
// its brightness sample (not a separate, unrelated rotation), so it
// visually leans toward the direction it's currently brightening from.
// The pyramid itself sits flat on its base (no outer rotation) so the
// overall silhouette stays perfectly level.

interface TrianglePoint {
  row: number;
  k: number;
  up: boolean; // true = points up (base-down orientation: apex at top)
  total: number; // total triangles in this row
}

// 3 rows of a triangular subdivision, base at the bottom: row 0 (single
// triangle) is the apex at the top, row (ROWS-1) is the widest base row.
function buildTrianglePoints(rows: number): TrianglePoint[] {
  const pts: TrianglePoint[] = [];
  for (let row = 0; row < rows; row++) {
    const total = row + 1 + row; // (row+1) up + row down
    for (let k = 0; k < total; k++) {
      pts.push({ row, k, up: k % 2 === 0, total });
    }
  }
  return pts;
}

const TRI_ROWS = 3;
const TRIANGLE_POINTS = buildTrianglePoints(TRI_ROWS);

// Computes the resting (non-swirling) triangle geometry for a given point —
// used both to render the static "done" state and as the base shape the
// tick loop offsets from. Keeping this in one place avoids the done-state
// paths silently drifting out of sync with the animated ones.
function computeTriangleGeometry(
  p: TrianglePoint,
  SIDE: number,
  H: number,
  startY: number,
  GAP_SCALE: number
) {
  const y0 = startY + p.row * H;
  const y1 = y0 + H;
  const rowWidth = p.total * (SIDE / 2);
  const xStart = -rowWidth / 2;
  const x0 = xStart + Math.floor(p.k / 2) * SIDE + (p.up ? 0 : SIDE / 2);

  let vx1: number, vy1: number, vx2: number, vy2: number, vx3: number, vy3: number;
  if (p.up) {
    vx1 = x0; vy1 = y1;
    vx2 = x0 + SIDE; vy2 = y1;
    vx3 = x0 + SIDE / 2; vy3 = y0;
  } else {
    vx1 = x0; vy1 = y0;
    vx2 = x0 + SIDE; vy2 = y0;
    vx3 = x0 + SIDE / 2; vy3 = y1;
  }

  const cx = (vx1 + vx2 + vx3) / 3;
  const cy = (vy1 + vy2 + vy3) / 3;

  // shrink toward centroid to create a visible gap between neighbors
  vx1 = cx + (vx1 - cx) * GAP_SCALE; vy1 = cy + (vy1 - cy) * GAP_SCALE;
  vx2 = cx + (vx2 - cx) * GAP_SCALE; vy2 = cy + (vy2 - cy) * GAP_SCALE;
  vx3 = cx + (vx3 - cx) * GAP_SCALE; vy3 = cy + (vy3 - cy) * GAP_SCALE;

  const d = `M ${vx1.toFixed(2)} ${vy1.toFixed(2)} L ${vx2.toFixed(2)} ${vy2.toFixed(2)} L ${vx3.toFixed(2)} ${vy3.toFixed(2)} Z`;
  return { d, cx, cy };
}

export function ResearchingSwirl({ size = 80, done = false }: { size?: number; done?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const tOffsetRef = useRef(Math.random() * 1000);

  const SIDE = size * 0.36;
  const GAP_SCALE = 0.82;
  const H = (SIDE * Math.sqrt(3)) / 2;
  const totalHeight = TRI_ROWS * H;
  const startY = -totalHeight / 2;
  const viewBoxSize = size;

  const restGeometry = useMemo(() => TRIANGLE_POINTS.map((p) =>
    computeTriangleGeometry(p, SIDE, H, startY, GAP_SCALE)
  ), [SIDE, H, startY, GAP_SCALE]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const tris = Array.from(svg.querySelectorAll("path[data-tri]")) as SVGPathElement[];

    if (done) {
      for (let i = 0; i < TRIANGLE_POINTS.length; i++) {
        const tri = tris[i];
        tri.style.fill = "var(--color-success)";
        tri.style.opacity = "0.6";
        tri.style.transform = "none";
        tri.style.willChange = "auto";
      }
      return;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (let i = 0; i < TRIANGLE_POINTS.length; i++) {
        const tri = tris[i];
        tri.style.fill = "var(--color-primary)";
        tri.style.opacity = "0.4";
        tri.style.transform = "none";
        tri.style.willChange = "auto";
      }
      return;
    }

    // Per-triangle randomization so each piece drifts independently
    // through the noise field on its own path.
    const seeds = restGeometry.map((g) => {
      const dist = Math.sqrt(g.cx * g.cx + g.cy * g.cy) / (size * 0.5);
      return {
        baseAngle: Math.atan2(g.cy, g.cx),
        dist,
        phaseOffset: Math.random() * Math.PI * 2,
        speedMult: 0.6 + Math.random() * 0.8,
        radiusMult: 0.5 + Math.random() * 1.0,
        sampleOffsetX: Math.random() * 100,
        sampleOffsetY: Math.random() * 100,
      };
    });

    function hash(x: number, y: number): number {
      const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
      return s - Math.floor(s);
    }
    function smooth(t: number): number { return t * t * (3 - 2 * t); }
    function noise2D(x: number, y: number): number {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const a = hash(xi, yi), b = hash(xi + 1, yi);
      const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      const u = smooth(xf), v = smooth(yf);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
    function fbm(x: number, y: number): number {
      let total = 0, amp = 0.5, freq = 1;
      for (let i = 0; i < 2; i++) {
        total += noise2D(x * freq, y * freq) * amp;
        freq *= 2;
        amp *= 0.5;
      }
      return total;
    }

    const SPEED = 0.035;
    const PEAK_BOOST = 3.0;
    const CONTRAST = 1.8;
    const TILT_MAX = 26;

    let rafId: number;
    let t = tOffsetRef.current;

    function tick() {
      t += SPEED;
      for (let i = 0; i < TRIANGLE_POINTS.length; i++) {
        const seed = seeds[i];
        const tri = tris[i];

        const swirlAngle = seed.baseAngle + t * seed.speedMult + seed.phaseOffset;
        const radius = 0.9 * seed.radiusMult;

        const lookX = Math.cos(swirlAngle);
        const lookY = Math.sin(swirlAngle);

        const sx = lookX * seed.dist * radius + seed.sampleOffsetX;
        const sy = lookY * seed.dist * radius + seed.sampleOffsetY;

        let n = fbm(sx * 0.8, sy * 0.8);
        n = Math.max(0, Math.min(1, n));
        const value = Math.min(1, Math.pow(n, CONTRAST) * PEAK_BOOST);

        const tiltX = lookY * TILT_MAX * value;
        const tiltY = -lookX * TILT_MAX * value;

        tri.style.setProperty("--v", value.toFixed(3));
        tri.style.transform = `rotateX(${tiltX.toFixed(2)}deg) rotateY(${tiltY.toFixed(2)}deg)`;
      }
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [done, size, SIDE, H, startY, GAP_SCALE, restGeometry]);

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={`${-viewBoxSize / 2} ${-viewBoxSize / 2} ${viewBoxSize} ${viewBoxSize}`}
      style={{ overflow: "visible", perspective: `${size * 4}px` }}
    >
      {TRIANGLE_POINTS.map((_, i) => (
        <path
          key={i}
          data-tri={i}
          d={restGeometry[i].d}
            style={
            done
              ? { fill: "var(--color-success)", opacity: 0.6, transform: "none" }
              : {
                  fill: "color-mix(in oklch, var(--color-primary) calc(var(--v, 0.4) * 100%), var(--color-surface-3))",
                  filter: "drop-shadow(0 0 calc(var(--v, 0) * 2.5px) var(--color-primary-glow))",
                  transformOrigin: `${restGeometry[i].cx}px ${restGeometry[i].cy}px`,
                  transformStyle: "preserve-3d",
                  willChange: "transform",
                }
            }
        />
      ))}
    </svg>
  );
}