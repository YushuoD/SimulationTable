# Post-Fire Flood Warning Simulator

Interactive web prototype for exploring how intense rainfall can trigger fast
downslope runoff after wildfire damage in mountain terrain across the USA.

## What this app does

- Renders a 3D terrain map in the browser using public USA imagery and DEM tiles.
- Lets you place a burn scar by clicking on the map.
- Samples the local terrain grid around the burn scar.
- Routes thousands of runoff particles downslope to show likely flood corridors.
- Highlights concentrated flow paths as hazard heat zones for warning and planning.

## Why this does not extract Google Earth terrain

This project does **not** extract or copy Google Earth 3D terrain. That would be
legally and technically inappropriate for a redistributable web app. Instead, it
uses public terrain and imagery sources that provide a similar planning workflow:

- **USGS Imagery Only** for the base map
- **Terrarium / Mapzen AWS elevation tiles** for terrain heights

That keeps the app deployable while still grounding the simulation on real USA
terrain data.

## Modeling approach

The simulation uses a physically informed, lightweight browser model:

1. **Terrain sampling**
   - Pull a local DEM grid from Terrarium elevation tiles.
   - Decode heights per cell and derive local slope vectors.

2. **Post-fire runoff generation**
   - Estimate infiltration-excess runoff from:
     - rainfall intensity
     - storm duration
     - soil texture
     - burn severity
   - Burn severity reduces infiltration and increases runoff efficiency.

3. **Flow routing**
   - Blend:
     - continuous terrain gradient following
     - D8 downslope fallback routing
     - Manning-style velocity scaling
   - Emit particles from the burn scar and move them downslope over time.

4. **Hazard scoring**
   - Count repeated particle passage through each terrain cell.
   - Normalize the counts into a warning heat field.
   - Report likely runout distance, corridor area, and indicative arrival timing.

## Important limitations

This is a **planning and educational prototype**, not a certified debris-flow,
floodplain, or evacuation model. It does not currently include:

- dynamic channel hydraulics
- sediment bulking and debris entrainment
- culverts, roads, levees, or storm drains
- calibrated rainfall-runoff parameters for a named watershed
- soil moisture assimilation or gauge/radar data
- regulatory-grade uncertainty analysis

For life-safety decisions, use calibrated local hydrology and emergency
management workflows.

## Run locally

```bash
npm install
npm run dev
```

Open the local Vite URL shown in the terminal.

## Build

```bash
npm run build
```

## Suggested next upgrades

- Import burn scar polygons from GeoJSON.
- Add NOAA precipitation forecasts or design-storm presets.
- Allow GeoTIFF DEM upload for higher-resolution local studies.
- Add channel extraction and watershed boundary delineation.
- Export warning maps and scenario summaries.
