"use client";

import dynamic from "next/dynamic";

// R3F touches `window`/WebGL, so load the component client-side only (no SSR).
const ParticlePortrait = dynamic(
  () => import("@/components/ParticlePortrait"),
  { ssr: false },
);

export default function Page() {
  return (
    <main className="demo-wrap">
      <ParticlePortrait
        src="/me.jpg"
        // All knobs are optional — these are the defaults made explicit.
        particleCount={{ high: 60000, mid: 28000, low: 18000 }}
        idleAmplitude={0.14}
        pointerStrength={0.9}
        pointerRadius={0.12}
        bloom
        style={{ width: "min(78vmin, 560px)", height: "min(78vmin, 560px)" }}
      />
      <p className="demo-caption">
        Bouge la souris / le doigt sur le visage — curl-noise idle, traînée du pointeur, bloom desktop.
      </p>
    </main>
  );
}
