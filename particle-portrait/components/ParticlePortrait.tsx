"use client";

/**
 * <ParticlePortrait />
 * ────────────────────
 * A portrait rendered as a single THREE.Points cloud driven by a custom
 * GLSL ShaderMaterial. The photo is sampled on an offscreen canvas; every
 * non-dark pixel becomes one particle (origin = pixel xy, z from luminance,
 * colour from the pixel). All motion happens in the vertex shader:
 *   • idle curl-noise drift + slow breathing (looks alive with no input)
 *   • assembly transition (a noise cloud converges onto the face on load)
 *   • pointer repulsion read from a decaying "trail" texture (mouse === touch)
 *
 * Performance: one draw call, no per-frame allocations, additive blending,
 * GPU tiering via detect-gpu, dpr/bloom backed off by <PerformanceMonitor>,
 * frameloop paused when off-screen, and prefers-reduced-motion respected.
 */

import * as THREE from "three";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { EffectComposer, Bloom } from "@react-three/postprocessing";
import { getGPUTier } from "detect-gpu";
import { vertexShader, fragmentShader } from "./shaders";

// World-space height of the portrait plane; everything is scaled to it.
const PLANE_HEIGHT = 6;
const DEPTH = 1.0; // how much luminance pushes particles along z (volume)
const RED_THRESHOLD = 34; // pixels with red <= this are treated as background

type CountTiers = { high: number; mid: number; low: number };

export interface ParticlePortraitProps {
  /** Image to turn into particles (served same-origin, e.g. /me.jpg). */
  src: string;
  /** Particle budget. A single number, or per-GPU-tier counts. */
  particleCount?: number | CountTiers;
  /** Idle curl-noise amplitude (small keeps the face readable). */
  idleAmplitude?: number;
  /** How hard the pointer pushes particles. */
  pointerStrength?: number;
  /** Pointer influence radius, as a fraction of the portrait (0..1). */
  pointerRadius?: number;
  /** Enable selective bloom (auto-limited to capable desktop GPUs). */
  bloom?: boolean;
  className?: string;
  style?: CSSProperties;
}

const DEFAULT_COUNTS: CountTiers = { high: 60000, mid: 28000, low: 18000 };

function normalizeCounts(c?: number | CountTiers): CountTiers {
  if (c == null) return DEFAULT_COUNTS;
  if (typeof c === "number") return { high: c, mid: c, low: c };
  return c;
}

type SampledData = {
  positions: Float32Array;
  colors: Float32Array;
  randoms: Float32Array;
  uvs: Float32Array;
  count: number;
  aspect: number;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * Draw the photo on an offscreen canvas at a resolution chosen to land near
 * `targetCount`, then emit one particle per non-dark pixel. Sub-sampling for
 * mobile happens naturally because the caller passes a smaller targetCount.
 */
async function sampleImage(
  src: string,
  targetCount: number,
): Promise<SampledData> {
  const img = await loadImage(src);
  const aspect = img.width / img.height;

  // Faces fill ~55% of the frame; size the working canvas accordingly.
  const totalPx = targetCount / 0.55;
  let h = Math.round(Math.sqrt(totalPx / aspect));
  h = Math.max(48, Math.min(420, h));
  const w = Math.round(h * aspect);

  const cvs = document.createElement("canvas");
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  // First pass: count kept pixels so we can allocate exact typed arrays.
  let n = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i] > RED_THRESHOLD) n++;

  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const randoms = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);

  let k = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = data[idx];
      if (r <= RED_THRESHOLD) continue; // drop dark background
      const g = data[idx + 1];
      const b = data[idx + 2];
      const u = w > 1 ? x / (w - 1) : 0;
      const v = h > 1 ? y / (h - 1) : 0;
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

      positions[k * 3] = (u - 0.5) * PLANE_HEIGHT * aspect;
      positions[k * 3 + 1] = (0.5 - v) * PLANE_HEIGHT;
      positions[k * 3 + 2] = (lum - 0.5) * DEPTH;

      colors[k * 3] = r / 255;
      colors[k * 3 + 1] = g / 255;
      colors[k * 3 + 2] = b / 255;

      randoms[k * 3] = Math.random() * 2 - 1;
      randoms[k * 3 + 1] = Math.random() * 2 - 1;
      randoms[k * 3 + 2] = Math.random() * 2 - 1;

      uvs[k * 2] = u;
      uvs[k * 2 + 1] = v;
      k++;
    }
  }

  return { positions, colors, randoms, uvs, count: n, aspect };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

// ── The actual scene (lives inside <Canvas>) ──────────────────────────────────
const TRAIL_SIZE = 256;

function Portrait({
  data,
  idleAmplitude,
  pointerStrength,
  pointerRadius,
  reduced,
}: {
  data: SampledData;
  idleAmplitude: number;
  pointerStrength: number;
  pointerRadius: number;
  reduced: boolean;
}) {
  const { aspect } = data;
  const { invalidate } = useThree();

  // Offscreen pointer-trail texture: pointer stamps fade over time → elastic
  // return without per-particle state (no FBO needed at this scale).
  const trail = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = TRAIL_SIZE;
    canvas.height = TRAIL_SIZE;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, TRAIL_SIZE, TRAIL_SIZE);
    const tex = new THREE.CanvasTexture(canvas);
    tex.flipY = false; // match aUV (y-down) directly
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return { canvas, ctx, tex };
  }, []);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute("aColor", new THREE.BufferAttribute(data.colors, 3));
    g.setAttribute("aRandom", new THREE.BufferAttribute(data.randoms, 3));
    g.setAttribute("aUV", new THREE.BufferAttribute(data.uvs, 2));
    g.computeBoundingSphere();
    return g;
  }, [data]);

  // Created once and then MUTATED each frame (no new objects in useFrame).
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAssembly: { value: 0 },
      uIdleAmp: { value: idleAmplitude },
      uScatter: { value: 3.0 },
      uSize: { value: 0.032 }, // particle radius in world units
      uFocal: { value: 500 }, // recomputed each frame from the framebuffer
      uReduced: { value: reduced ? 1 : 0 },
      uPointer: { value: new THREE.Vector2(999, 999) },
      uPointerStrength: { value: pointerStrength },
      uTouch: { value: trail.tex },
      uOpacity: { value: 1 },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Keep prop-driven uniforms live without recreating the material.
  useEffect(() => void (uniforms.uIdleAmp.value = idleAmplitude), [idleAmplitude, uniforms]);
  useEffect(() => void (uniforms.uPointerStrength.value = pointerStrength), [pointerStrength, uniforms]);
  useEffect(() => void (uniforms.uReduced.value = reduced ? 1 : 0), [reduced, uniforms]);

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
      }),
    [uniforms],
  );

  // Stamp a soft additive dot into the trail canvas at image-UV (u,v).
  const stamp = (u: number, v: number) => {
    const ctx = trail.ctx;
    const x = u * TRAIL_SIZE;
    const y = v * TRAIL_SIZE;
    const rad = Math.max(3, pointerRadius * TRAIL_SIZE);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    trail.tex.needsUpdate = true;
  };

  // Pointer Events unify mouse + touch. e.point is on the plane (z = 0).
  const onPointer = (e: ThreeEvent<PointerEvent>) => {
    const px = e.point.x;
    const py = e.point.y;
    uniforms.uPointer.value.set(px, py);
    const u = px / (PLANE_HEIGHT * aspect) + 0.5;
    const v = 0.5 - py / PLANE_HEIGHT;
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) stamp(u, v);
    invalidate(); // needed when frameloop === 'demand' (reduced motion)
  };

  const startTime = useRef<number | null>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    uniforms.uTime.value = t;
    // world→pixel scale for gl_PointSize (framebuffer px, accounts for dpr/fov).
    const cam = state.camera as THREE.PerspectiveCamera;
    const fbH = state.gl.domElement.height;
    uniforms.uFocal.value = fbH / (2 * Math.tan((cam.fov * Math.PI) / 360));

    // Assembly: cloud → face, eased; near-instant for reduced motion.
    if (startTime.current === null) startTime.current = t;
    const dur = reduced ? 0.6 : 2.4;
    const p = Math.min(1, (t - startTime.current) / dur);
    uniforms.uAssembly.value = 1 - Math.pow(1 - p, 3);

    // Decay the pointer trail a little every frame → particles ease back.
    const ctx = trail.ctx;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(0,0,0,0.07)";
    ctx.fillRect(0, 0, TRAIL_SIZE, TRAIL_SIZE);
    trail.tex.needsUpdate = true;
  });

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
      trail.tex.dispose();
    };
  }, [geometry, material, trail]);

  return (
    <>
      <points geometry={geometry} material={material} frustumCulled={false} />
      {/* Invisible plane: the raycast target that feeds pointer UVs. */}
      <mesh onPointerMove={onPointer} onPointerDown={onPointer}>
        <planeGeometry args={[PLANE_HEIGHT * aspect, PLANE_HEIGHT]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </>
  );
}

export default function ParticlePortrait({
  src,
  particleCount,
  idleAmplitude = 0.14,
  pointerStrength = 0.9,
  pointerRadius = 0.12,
  bloom = true,
  className,
  style,
}: ParticlePortraitProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  const [data, setData] = useState<SampledData | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [visible, setVisible] = useState(true);
  const [dpr, setDpr] = useState(1.5);
  const [bloomOn, setBloomOn] = useState(false);

  // ── GPU tiering: choose particle budget + whether bloom is affordable ──
  useEffect(() => {
    let alive = true;
    (async () => {
      const counts = normalizeCounts(particleCount);
      let count = counts.low;
      let allowBloom = false;
      try {
        const gpu = await getGPUTier();
        if (gpu.tier >= 3 && !gpu.isMobile) {
          count = counts.high;
          allowBloom = true;
        } else if (gpu.tier === 2 && !gpu.isMobile) {
          count = counts.mid;
          allowBloom = true;
        } else if (gpu.tier >= 1) {
          count = counts.low;
        } else {
          // tier 0 / no WebGL → static fallback
          if (alive) setUnsupported(true);
          return;
        }
        if (alive) setDpr(gpu.isMobile ? 1.25 : 1.5);
      } catch {
        // detect-gpu failed → assume a modest device
        count = counts.low;
      }
      try {
        const sampled = await sampleImage(src, count);
        if (alive) {
          setData(sampled);
          setBloomOn(bloom && allowBloom);
        }
      } catch {
        if (alive) setUnsupported(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [src, particleCount, bloom]);

  // ── pause the render loop when the portrait is off-screen ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Static fallback (no WebGL / weakest GPUs).
  if (unsupported) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt="portrait"
        className={className}
        style={{ objectFit: "cover", borderRadius: 8, ...style }}
      />
    );
  }

  return (
    <div
      ref={wrapRef}
      className={className}
      style={{ position: "relative", touchAction: "none", ...style }}
    >
      {data && (
        <Canvas
          // Idle animation needs continuous frames; reduced-motion only renders
          // on demand (pointer), and we stop entirely when off-screen.
          frameloop={!visible ? "never" : reduced ? "demand" : "always"}
          dpr={[1, dpr]}
          gl={{ antialias: false, powerPreference: "high-performance", alpha: true }}
          camera={{ position: [0, 0, 7], fov: 50, near: 0.1, far: 100 }}
        >
          <PerformanceMonitor
            onDecline={() => {
              setDpr((d) => Math.max(1, d - 0.25));
              setBloomOn(false);
            }}
            onFallback={() => {
              setDpr(1);
              setBloomOn(false);
            }}
          />
          <Portrait
            data={data}
            idleAmplitude={idleAmplitude}
            pointerStrength={pointerStrength}
            pointerRadius={pointerRadius}
            reduced={reduced}
          />
          {bloomOn && (
            <EffectComposer>
              <Bloom
                intensity={0.7}
                luminanceThreshold={0.2}
                luminanceSmoothing={0.3}
                mipmapBlur
              />
            </EffectComposer>
          )}
        </Canvas>
      )}
    </div>
  );
}
