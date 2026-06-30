# Particle Portrait

Un portrait rendu en **particules GPU** avec `@react-three/fiber` + GLSL custom.
Un seul `THREE.Points`, un seul draw call, animation 100 % dans les shaders.

## Lancer

```bash
cd particle-portrait
npm install
npm run dev      # http://localhost:3000
```

Ta photo est dans `public/me.jpg`. Remplace-la (même nom) ou passe `src`.

## Utilisation

```tsx
import dynamic from "next/dynamic";
const ParticlePortrait = dynamic(
  () => import("@/components/ParticlePortrait"),
  { ssr: false }, // R3F = client only
);

<ParticlePortrait
  src="/me.jpg"
  particleCount={{ high: 60000, mid: 28000, low: 18000 }}
  idleAmplitude={0.14}
  pointerStrength={0.9}
  pointerRadius={0.12}
  bloom
  style={{ width: 520, height: 520 }}
/>;
```

### Props

| prop              | défaut                              | rôle                                                        |
| ----------------- | ----------------------------------- | ----------------------------------------------------------- |
| `src`             | —                                   | image source (servie en same-origin, ex. `/me.jpg`)         |
| `particleCount`   | `{high:60k, mid:28k, low:18k}`      | budget de particules (nombre unique ou par tier GPU)        |
| `idleAmplitude`   | `0.14`                              | amplitude de la dérive curl-noise au repos                  |
| `pointerStrength` | `0.9`                               | force de répulsion du pointeur                              |
| `pointerRadius`   | `0.12`                              | rayon d'influence du pointeur (fraction du portrait)        |
| `bloom`           | `true`                              | bloom sélectif (auto-limité aux GPU desktop costauds)       |

## Comment ça marche

1. **Génération** — `public/me.jpg` est dessinée sur un canvas offscreen,
   `getImageData()` lit les pixels. Chaque pixel non-sombre (`r > 34`) devient
   une particule : `position` (x,y du pixel ; z dérivé de la luminance pour le
   volume), `aColor` (RGB), `aRandom` (bruit par particule), `aUV` (uv image).
   Le nombre de pixels échantillonnés s'adapte au budget → sous-échantillonnage
   automatique sur mobile.

2. **Animation (vertex shader)** — position d'origine
   + `curlNoise(origine, uTime) * idleAmp` (dérive organique)
   + « respiration » (sinus lent sur z/taille)
   + répulsion du pointeur lue dans une **texture de traînée** qui décroît dans
     le temps (retour élastique sans FBO).
   Une transition d'**assemblage** au chargement fait converger un nuage de
   bruit vers le visage via `mix()`.

3. **Fragment shader** — sprite circulaire doux (`smoothstep` sur la distance au
   centre), couleur échantillonnée, taille selon la luminance. `AdditiveBlending`,
   `depthWrite:false`, `transparent:true`.

4. **Pointeur souris + tactile** — Pointer Events (`pointermove`/`pointerdown`)
   unifient souris et tactile via un plan invisible raycasté ; `touch-action:none`
   sur le conteneur empêche le scroll quand on touche le portrait. La position du
   pointeur est estampée (gradient radial adouci) dans la texture de traînée.

## Performance

- `<Canvas dpr={[1, 1.5]}>`, `gl={{ antialias:false, powerPreference:'high-performance' }}`.
- **`detect-gpu` (`getGPUTier`)** : tier 3 desktop → ~60k particules + bloom ;
  tier 2 → ~28k + bloom ; tier 1 / mobile → ~18k sans bloom ;
  **tier 0 / pas de WebGL → image statique** (fallback `<img>`).
- **`<PerformanceMonitor>`** : `onDecline` baisse le `dpr` et coupe le bloom ;
  `onFallback` passe en mode basse qualité.
- Aucune allocation d'objet par frame dans `useFrame` (uniforms mutés en place).
  Un seul draw call.
- **Frameloop à la demande** : le rendu se met en pause via `IntersectionObserver`
  quand le portrait sort de l'écran (économie batterie).
- **`prefers-reduced-motion`** : idle figé, portrait assemblé quasi statique,
  rendu seulement sur interaction.

## Intégration dans le portfolio Next.js

Copie `components/ParticlePortrait.tsx` + `components/shaders.ts` dans ton app,
mets ta photo dans `public/`, et rends `<ParticlePortrait src="/me.jpg" />` là où
se trouvait l'ancien portrait. Dépendances à ajouter :

```bash
npm i three @react-three/fiber @react-three/drei @react-three/postprocessing detect-gpu
npm i -D @types/three
```
