# Post-Fire Flood Simulation (Web + 3D Terrain)

This project provides a browser-based **post-fire flood routing simulator** for mountain terrain in the USA.

It combines:
- 3D terrain visualization (Cesium)
- optional Google photorealistic 3D tiles (with your own API key)
- a particle flood model that routes runoff downslope and highlights likely hazard corridors

---

## Important note on "Google Earth extraction"

This app **does not extract or redistribute raw Google Earth data**.

Instead, it uses:
- Cesium World Terrain for elevation sampling (simulation input)
- optional Google Photorealistic 3D Tiles API (visual context only, when user supplies a valid Google key)

This is the safe/legal way to integrate Google 3D visuals in a web application.

---

## Features

- Interactive control panel for:
  - scenario center (lat/lon)
  - study extent
  - burn scar radius
  - rainfall intensity
  - burn severity
  - grid resolution
  - particle count
  - simulation steps and time-step
- Terrain grid sampling directly from 3D globe terrain
- Particle-based runoff simulation with:
  - downhill acceleration from terrain slope
  - friction damping
  - diffusion (micro-topography/debris uncertainty proxy)
  - rain input and post-fire infiltration reduction
- Hazard map outputs:
  - high / medium / low likely flood routing cells
- Animated particle movement overlay to explain flood pathways

---

## Run locally

```bash
npm install
npm run dev
```

Open the Vite URL (usually `http://localhost:5173`).

---

## Suggested workflow

1. Click **Initialize 3D Map**
   - optionally provide a Cesium ion token for better terrain availability
   - optionally provide a Google Map Tiles API key to load photorealistic 3D tiles
2. Click **Load Terrain Grid** for your scenario extent
3. Click **Run Flood Simulation**
4. Interpret hazard points:
   - red = high likely routing
   - orange = medium
   - blue = lower routed runoff

---

## Modeling approach (high level)

The simulation is a pragmatic warning-oriented model, not a full hydraulic solver:

1. Sample terrain heights on a regular grid over the study area.
2. Estimate local slope gradients from neighboring cells.
3. Move particles downhill each step using:
   - gravity-driven acceleration from slope
   - damping/friction
   - small stochastic diffusion
4. Adjust water mass per particle by:
   - rainfall input
   - infiltration loss reduced by burn severity
5. Accumulate routed flux into a hazard raster.
6. Convert hazard raster to percentile-based warning classes (high/medium/low).

---

## Disclaimer

This tool is for **planning, education, and rapid screening**.
It is **not** a replacement for calibrated hydrology/hydraulics models, gauge data assimilation, or official emergency management forecasts.
