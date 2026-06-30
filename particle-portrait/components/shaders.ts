/**
 * GLSL for the particle portrait.
 *
 * Everything that moves lives here — the CPU only feeds time, the pointer
 * position and a decaying "trail" texture. One draw call, no per-frame JS
 * object allocation, no FBO (curl-noise is cheap enough at this scale).
 *
 * Per-particle attributes:
 *   position : vec3  origin/target (x,y from the pixel, z from luminance → volume)
 *   aColor   : vec3  sampled RGB (0..1)
 *   aRandom  : vec3  per-particle noise in [-1,1] (scatter dir + phase)
 *   aUV      : vec2  the pixel's image UV (0..1, y down) — used to read the trail
 */

// ── Ashima/Stefan Gustavson simplex noise (3D) + curl ─────────────────────────
const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

vec3 snoiseVec3(vec3 x){
  return vec3(
    snoise(x),
    snoise(vec3(x.y - 19.1, x.z + 33.4, x.x + 47.2)),
    snoise(vec3(x.z + 74.2, x.x - 124.5, x.y + 99.4))
  );
}

// Divergence-free curl noise → organic, swirling, never "puffs outward".
vec3 curlNoise(vec3 p){
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);
  vec3 p_x0 = snoiseVec3(p - dx), p_x1 = snoiseVec3(p + dx);
  vec3 p_y0 = snoiseVec3(p - dy), p_y1 = snoiseVec3(p + dy);
  vec3 p_z0 = snoiseVec3(p - dz), p_z1 = snoiseVec3(p + dz);
  float x = (p_y1.z - p_y0.z) - (p_z1.y - p_z0.y);
  float y = (p_z1.x - p_z0.x) - (p_x1.z - p_x0.z);
  float z = (p_x1.y - p_x0.y) - (p_y1.x - p_y0.x);
  return normalize(vec3(x, y, z) / (2.0 * e));
}
`;

export const vertexShader = /* glsl */ `
${NOISE_GLSL}

uniform float uTime;
uniform float uAssembly;       // 0 = scattered cloud, 1 = portrait
uniform float uIdleAmp;        // idle curl amplitude
uniform float uScatter;        // cloud spread distance at assembly = 0
uniform float uSize;           // particle radius in WORLD units (~0.03)
uniform float uFocal;          // framebufferHeight / (2*tan(fov/2)) → world→px
uniform float uReduced;        // 1 = prefers-reduced-motion
uniform vec2  uPointer;        // pointer position in the portrait's local plane (world xy)
uniform float uPointerStrength;
uniform sampler2D uTouch;      // decaying pointer-trail texture (r = intensity)

attribute vec3 aColor;
attribute vec3 aRandom;
attribute vec2 aUV;

varying vec3  vColor;
varying float vLum;

void main(){
  vColor = aColor;
  vLum = dot(aColor, vec3(0.299, 0.587, 0.114));

  vec3 origin = position;                       // baked target (z = volume)
  float reduced = uReduced;

  // ── assembly: converge from a noise cloud toward the face ──
  vec3 scattered = origin + aRandom * uScatter;
  vec3 pos = mix(scattered, origin, clamp(uAssembly, 0.0, 1.0));

  // ── idle: curl-noise drift + slow breathing (kept small so the face reads) ──
  float idle = uIdleAmp * (1.0 - reduced * 0.92);
  vec3 drift = curlNoise(origin * 1.4 + vec3(0.0, 0.0, uTime * 0.18)) * idle;
  pos += drift;

  float breathe = sin(uTime * 0.8 + aRandom.x * 6.2831853);
  pos.z += breathe * idle * 0.5;

  // ── pointer: read the soft decaying trail and push particles away ──
  float trail = texture2D(uTouch, aUV).r;       // 0..1, smoothed over time
  vec2 away = pos.xy - uPointer;
  float d = max(length(away), 0.0001);
  pos.xy += (away / d) * trail * uPointerStrength * (1.0 - reduced * 0.85);
  // a touch of lift on z too, so the disturbance feels 3D
  pos.z += trail * uPointerStrength * 0.25 * (1.0 - reduced);

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // brighter pixels = bigger; breathing nudges size; pops under the pointer.
  float size = uSize * (0.5 + 0.9 * vLum) * (0.85 + 0.3 * (breathe * 0.5 + 0.5));
  size *= 1.0 + trail * 0.8;
  // world radius → device pixels with correct perspective attenuation.
  gl_PointSize = max(1.0, size * uFocal / -mvPosition.z);
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;

uniform float uOpacity;

varying vec3  vColor;
varying float vLum;

void main(){
  // soft circular sprite (no texture needed)
  vec2 c = gl_PointCoord - 0.5;
  float dist = length(c);
  float alpha = smoothstep(0.5, 0.08, dist);
  if (alpha <= 0.001) discard;

  // a little extra glow in the core of brighter particles
  vec3 col = vColor + vColor * vLum * 0.35;
  gl_FragColor = vec4(col, alpha * uOpacity);
}
`;
