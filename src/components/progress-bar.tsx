"use client";

import { useEffect, useRef } from "react";

const N = 12;
const BASE_SPEED = 0.012;
const BURST_SPEED = 0.075;

function randBurstGap() {
  return 150 + Math.random() * 220;
}

export function ProgressBar() {
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const track = trackRef.current;
    if (!track) return;

    const segs = Array.from(track.children) as HTMLDivElement[];

    let phase = 0;
    let burstTarget = 0;
    let burstEnergy = 0;
    let nextBurstIn = randBurstGap();
    let rafId: number;

    function tick() {
      nextBurstIn -= 1;
      if (nextBurstIn <= 0 && burstTarget < 0.5) {
        burstTarget = 1;
        nextBurstIn = randBurstGap();
        setTimeout(() => { burstTarget = 0; }, 350 + Math.random() * 250);
      }

      const rate = burstTarget > burstEnergy ? 0.05 : 0.035;
      burstEnergy += (burstTarget - burstEnergy) * rate;
      const currentSpeed = BASE_SPEED + burstEnergy * (BURST_SPEED - BASE_SPEED);
      phase += currentSpeed;

      for (let i = 0; i < N; i++) {
        const pos = i / N;
        let d = pos - (phase % 1);
        d = ((d % 1) + 1.5) % 1 - 0.5;
        const band = Math.exp(-Math.pow(d * 6, 2));
        const value = 0.2 + band * 0.8;
        segs[i].style.setProperty("--v", value.toFixed(3));
      }

      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <div
      ref={trackRef}
      className="flex w-full gap-[2px]"
      style={{
        height: 4,
        background: "var(--color-progress-track)",
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      {Array.from({ length: N }).map((_, i) => (
        <div
          key={i}
          className="flex-1 h-full"
          style={{
            background: "color-mix(in oklch, var(--color-progress-segment-bright) calc(var(--v, 0.2) * 100%), var(--color-progress-segment-dim))",
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}
