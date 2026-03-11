/**
 * Post-Fire Flood Simulation - Main Application
 * 3D terrain visualization with particle-based flood path prediction
 */

import * as Cesium from 'cesium';
import { FloodSimulationEngine } from './floodSimulation.js';
import { createTerrainSampler } from './terrainSampler.js';

// Cesium ion access token - Get free token at https://cesium.com/ion/tokens
// Required for Cesium World Terrain (3D USA/mountain elevation data)
Cesium.Ion.defaultAccessToken = import.meta.env.VITE_CESIUM_TOKEN || '';

const USA_MOUNTAIN_VIEW = {
  // Colorado Rockies - common post-fire flood area
  longitude: -105.5,
  latitude: 39.7,
  height: 150000,
  heading: 0,
  pitch: -45,
};

let viewer;
let floodEngine;
let getElevationAt;
let simulationRunning = false;
let animationFrameId;
let floodSource = null;
let particleEntities = [];
let pathEntities = [];
let pathCellPoints = [];

async function initViewer() {
  viewer = new Cesium.Viewer('cesiumContainer', {
    terrainProvider: await Cesium.createWorldTerrainAsync(),
    baseLayerPicker: false,
    geocoder: true,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: true,
    vrButton: false,
    animation: false,
    timeline: false,
    imageryProvider: new Cesium.IonImageryProvider({ assetId: 2 }), // Bing aerial
    useDefaultRenderLoop: true,
  });

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      USA_MOUNTAIN_VIEW.longitude,
      USA_MOUNTAIN_VIEW.latitude,
      USA_MOUNTAIN_VIEW.height
    ),
    orientation: {
      heading: USA_MOUNTAIN_VIEW.heading,
      pitch: Cesium.Math.toRadians(USA_MOUNTAIN_VIEW.pitch),
      roll: 0,
    },
  });

  getElevationAt = createTerrainSampler(viewer);
  return viewer;
}

async function initViewerWithFallback() {
  try {
    return await initViewer();
  } catch (e) {
    console.warn('Cesium Ion terrain failed, using ellipsoid fallback:', e.message);
    viewer = new Cesium.Viewer('cesiumContainer', {
      baseLayerPicker: false,
      geocoder: true,
      imageryProvider: new Cesium.IonImageryProvider({ assetId: 2 }),
    });
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        USA_MOUNTAIN_VIEW.longitude,
        USA_MOUNTAIN_VIEW.latitude,
        USA_MOUNTAIN_VIEW.height
      ),
      orientation: {
        heading: USA_MOUNTAIN_VIEW.heading,
        pitch: Cesium.Math.toRadians(USA_MOUNTAIN_VIEW.pitch),
        roll: 0,
      },
    });
    getElevationAt = createTerrainSampler(viewer);
    document.getElementById('statusText').textContent =
      'Using basic terrain. Add VITE_CESIUM_TOKEN for 3D USA terrain.';
    return viewer;
  }
}

function addFloodSourceMarker(lon, lat, height) {
  if (floodSource) {
    viewer.entities.remove(floodSource);
  }
  floodSource = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat, height + 5),
    point: {
      pixelSize: 12,
      color: Cesium.Color.RED,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 2,
    },
    label: {
      text: 'Flood Source',
      font: '14px Outfit',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      pixelOffset: new Cesium.Cartesian2(0, -15),
    },
  });
}

function clearParticleVisualization() {
  particleEntities.forEach((e) => viewer.entities.remove(e));
  particleEntities = [];
  pathEntities.forEach((e) => viewer.entities.remove(e));
  pathEntities = [];
  pathCellPoints.forEach((e) => viewer.entities.remove(e));
  pathCellPoints = [];
}

function updateParticleVisualization() {
  clearParticleVisualization();

  const particles = floodEngine?.getAllParticles() ?? [];
  const pathCells = floodEngine?.getPathCells() ?? new Map();

  particles.forEach((p) => {
    if (!p.active && p.path.length < 2) return;
    const positions = p.path.map((pt) =>
      Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.height + 2)
    );
    if (positions.length >= 2) {
      const entity = viewer.entities.add({
        polyline: {
          positions,
          width: 2,
          material: Cesium.Color.fromCssColorString('#69db7c').withAlpha(0.6),
        },
      });
      pathEntities.push(entity);
    }
    if (p.active) {
      const entity = viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height + 3),
        point: {
          pixelSize: 4,
          color: Cesium.Color.CYAN,
        },
      });
      particleEntities.push(entity);
    }
  });

  pathCells.forEach((cell, key) => {
    const [lat, lon] = key.split(',').map(Number);
    const intensity = Math.min(1, cell.count / 50);
    let color;
    if (intensity > 0.6) color = Cesium.Color.fromCssColorString('#ff6b6b');
    else if (intensity > 0.3) color = Cesium.Color.fromCssColorString('#ffa94d');
    else color = Cesium.Color.fromCssColorString('#69db7c');

    const entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize: 8,
        color: color.withAlpha(0.7),
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
      },
    });
    pathCellPoints.push(entity);
  });

  document.getElementById('particleStats').textContent =
    `Particles: ${particles.length} | Path cells: ${pathCells.size}`;
}

async function runSimulationStep() {
  if (!simulationRunning || !floodEngine || !getElevationAt) return;

  await floodEngine.step(getElevationAt, 0.15);
  updateParticleVisualization();

  const active = floodEngine.getActiveParticles().length;
  if (active === 0) {
    simulationRunning = false;
    document.getElementById('statusText').textContent =
      'Simulation complete. Red/orange = high flood risk areas.';
    return;
  }

  animationFrameId = requestAnimationFrame(runSimulationStep);
}

async function startSimulation() {
  if (!floodSource) {
    document.getElementById('statusText').textContent = 'Click on terrain first to set flood source';
    return;
  }

  const pos = floodSource.position.getValue(Cesium.JulianDate.now());
  const carto = Cesium.Cartographic.fromCartesian(pos);
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  const height = carto.height;

  floodEngine = new FloodSimulationEngine({
    burnSeverity: document.getElementById('burnSeverity').value,
    rainfallIntensity: Number(document.getElementById('rainfallIntensity').value),
    particleCount: Number(document.getElementById('particleCount').value),
    simSpeed: Number(document.getElementById('simSpeed').value),
  });

  await floodEngine.spawnParticles(lon, lat, height, getElevationAt);
  simulationRunning = true;
  document.getElementById('statusText').textContent = 'Simulating flood path...';

  runSimulationStep();
}

function stopSimulation() {
  simulationRunning = false;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  document.getElementById('statusText').textContent = 'Simulation stopped.';
}

function clearSimulation() {
  stopSimulation();
  if (floodEngine) floodEngine.clear();
  clearParticleVisualization();
  document.getElementById('particleStats').textContent = 'Particles: 0 | Path cells: 0';
  document.getElementById('statusText').textContent = 'Click on terrain to set flood source';
}

function setupClickHandler() {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    const ray = viewer.camera.getPickRay(click.position);
    const position = viewer.scene.globe.pick(ray, viewer.scene);
    if (position) {
      const carto = Cesium.Cartographic.fromCartesian(position);
      const lon = Cesium.Math.toDegrees(carto.longitude);
      const lat = Cesium.Math.toDegrees(carto.latitude);
      getElevationAt(lon, lat).then((height) => {
        addFloodSourceMarker(lon, lat, height);
        document.getElementById('statusText').textContent =
          `Source set at ${lat.toFixed(4)}°, ${lon.toFixed(4)}°. Click Start to simulate.`;
      });
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function setupControls() {
  document.getElementById('rainfallIntensity').oninput = (e) => {
    document.getElementById('rainfallValue').textContent = `${e.target.value} mm/hr`;
  };
  document.getElementById('particleCount').oninput = (e) => {
    document.getElementById('particleCountValue').textContent = e.target.value;
  };
  document.getElementById('simSpeed').oninput = (e) => {
    document.getElementById('simSpeedValue').textContent = `${e.target.value}x`;
  };

  document.getElementById('startSim').addEventListener('click', startSimulation);
  document.getElementById('stopSim').addEventListener('click', stopSimulation);
  document.getElementById('clearSim').addEventListener('click', clearSimulation);
}

async function main() {
  await initViewerWithFallback();
  setupClickHandler();
  setupControls();
}

main().catch(console.error);
