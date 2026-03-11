# Post-Fire Flood Simulation

A web-based particle simulation of post-fire flood movement on 3D terrain. The model predicts where floodwaters might flow after wildfires in mountainous areas, helping warn people in at-risk zones.

![Simulation](https://img.shields.io/badge/3D-Terrain-blue) ![USA](https://img.shields.io/badge/Coverage-USA-green)

## Features

- **3D Terrain**: Cesium World Terrain (USA mountains) or Google Maps 3D–compatible base
- **Particle-based flood simulation** using established hydrology algorithms
- **Post-fire factors**: Burn severity (unburned → high) affects runoff and flow velocity
- **Flood path visualization**: Red/orange/green risk zones show where water may flow
- **Interactive**: Click anywhere on terrain to set flood source, adjust parameters, run simulation

## Algorithms & Models

The simulation incorporates methods from peer-reviewed research:

| Model/Algorithm | Source | Purpose |
|-----------------|--------|---------|
| **D8 Flow Direction** | TauDEM, USGS | Routes water to steepest of 8 neighbors |
| **Kinematic Wave** | KINEROS2, PFHydro, USGS | Velocity ∝ √slope for flood timing |
| **Post-fire runoff** | PFHydro, USGS | Runoff multipliers 2–100× by burn severity |
| **Burn severity** | NIFC, MTBS | Low/Moderate/High severity categories |

### Post-Fire Hydrology Factors

- **Vegetation loss**: Reduced interception → more surface runoff
- **Soil-water repellency**: Reduced infiltration capacity
- **Runoff increase**: 2–40× on plots, 100×+ on hillslopes (high severity)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Cesium Ion token (for 3D USA terrain)

1. Sign up at [cesium.com/ion](https://cesium.com/ion) (free)
2. Copy your default access token
3. Create `.env`:

```bash
cp .env.example .env
# Edit .env and add: VITE_CESIUM_TOKEN=your_token
```

Without a token, the app uses basic ellipsoid terrain (no real mountains).

### 3. Run the app

```bash
npm run dev
```

Open http://localhost:5173

## Usage

1. **Pan/zoom** to a mountain area (e.g., Colorado Rockies, California Sierras)
2. **Click** on the terrain to set the flood source point
3. **Adjust** burn severity and rainfall intensity
4. **Start** the simulation
5. **Interpret**:
   - **Red** = high flood risk (immediate flow paths)
   - **Orange** = medium risk (secondary paths)
   - **Green** = lower risk (potential accumulation)

## Alternative: Google Maps 3D

For Google Maps 3D (Map3DElement) instead of Cesium:

- Use [Google Maps Platform 3D Maps API](https://mapsplatform.google.com/maps-products/3d-maps/)
- Requires a Google Cloud project and Maps JavaScript API key
- 3D coverage: 2,500+ cities in 50+ countries (includes USA)

The simulation engine (`src/floodSimulation.js`) is map-agnostic and can be adapted to any 3D terrain provider that exposes elevation sampling.

## Project structure

```
├── src/
│   ├── main.js           # Cesium viewer, UI, simulation loop
│   ├── floodSimulation.js # D8, kinematic wave, post-fire engine
│   ├── terrainSampler.js  # Elevation sampling from terrain
│   └── styles.css
├── index.html
├── vite.config.js
└── package.json
```

## References

- [PFHydro: Post-fire runoff model](https://pubs.usgs.gov/publication/70223156)
- [USGS: Flood/debris flow timing after wildfire](https://www.usgs.gov/publications/model-simulations-flood-and-debris-flow-timing-steep-catchments-after-wildfire)
- [TauDEM D8 flow directions](https://hydrology.usu.edu/taudem/taudem5/help/d8flowdirections.html)
- [Cesium World Terrain](https://cesium.com/learn/cesiumjs-learn/cesiumjs-terrain/)

## License

MIT
