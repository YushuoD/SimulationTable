import * as Cesium from "https://cdn.jsdelivr.net/npm/cesium@1.139.1/+esm";
import { gridToLonLat, runFloodSimulation } from "./floodModel.js";

const statusEl = document.getElementById("status");

const input = {
  ionToken: document.getElementById("ionToken"),
  googleApiKey: document.getElementById("googleApiKey"),
  centerLat: document.getElementById("centerLat"),
  centerLon: document.getElementById("centerLon"),
  extentKm: document.getElementById("extentKm"),
  burnScarKm: document.getElementById("burnScarKm"),
  rainMmHr: document.getElementById("rainMmHr"),
  burnSeverity: document.getElementById("burnSeverity"),
  resolution: document.getElementById("resolution"),
  particleCount: document.getElementById("particleCount"),
  steps: document.getElementById("steps"),
  dt: document.getElementById("dt"),
};

const buttons = {
  initViewer: document.getElementById("initViewerBtn"),
  loadTerrain: document.getElementById("loadTerrainBtn"),
  run: document.getElementById("runBtn"),
};

let viewer = null;
let googleTileset = null;
let terrainGrid = null;
let boundaryEntity = null;
let burnScarEntity = null;
let hazardEntities = [];
let particlePoints = null;
let animationToken = 0;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setStatus(message) {
  const stamp = new Date().toLocaleTimeString();
  statusEl.textContent = `[${stamp}] ${message}`;
}

function parseNum(element) {
  return Number.parseFloat(element.value);
}

function getScenario() {
  return {
    centerLat: parseNum(input.centerLat),
    centerLon: parseNum(input.centerLon),
    extentKm: parseNum(input.extentKm),
    burnScarKm: parseNum(input.burnScarKm),
    rainMmHr: parseNum(input.rainMmHr),
    burnSeverity: parseNum(input.burnSeverity),
    resolution: Math.round(parseNum(input.resolution)),
    particleCount: Math.round(parseNum(input.particleCount)),
    steps: Math.round(parseNum(input.steps)),
    dt: parseNum(input.dt),
  };
}

function boundsFromScenario(scenario) {
  const latRad = (scenario.centerLat * Math.PI) / 180;
  const dLat = scenario.extentKm / 111.32;
  const dLon = scenario.extentKm / (111.32 * Math.max(0.2, Math.cos(latRad)));
  return {
    west: scenario.centerLon - dLon,
    east: scenario.centerLon + dLon,
    south: scenario.centerLat - dLat,
    north: scenario.centerLat + dLat,
  };
}

function clearRenderLayers() {
  animationToken += 1;
  if (particlePoints && viewer) {
    viewer.scene.primitives.remove(particlePoints);
    particlePoints = null;
  }

  if (viewer) {
    for (const entity of hazardEntities) {
      viewer.entities.remove(entity);
    }
  }
  hazardEntities = [];
}

async function initializeViewer() {
  const ionToken = input.ionToken.value.trim();
  if (ionToken) {
    Cesium.Ion.defaultAccessToken = ionToken;
  }

  let terrainProvider;
  try {
    terrainProvider = await Cesium.createWorldTerrainAsync();
  } catch (_error) {
    terrainProvider = new Cesium.EllipsoidTerrainProvider();
    setStatus("World terrain unavailable; using ellipsoid fallback.");
  }

  if (viewer) {
    clearRenderLayers();
    viewer.destroy();
  }

  viewer = new Cesium.Viewer("cesiumContainer", {
    terrainProvider,
    timeline: false,
    animation: false,
    infoBox: false,
    selectionIndicator: false,
  });
  viewer.scene.globe.depthTestAgainstTerrain = true;

  const scenario = getScenario();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      scenario.centerLon,
      scenario.centerLat,
      25000,
    ),
  });

  if (googleTileset) {
    viewer.scene.primitives.remove(googleTileset);
    googleTileset = null;
  }

  const key = input.googleApiKey.value.trim();
  if (key && typeof Cesium.createGooglePhotorealistic3DTileset === "function") {
    try {
      googleTileset = await Cesium.createGooglePhotorealistic3DTileset({ key });
      viewer.scene.primitives.add(googleTileset);
      setStatus("Viewer initialized. Google photorealistic layer loaded.");
      return;
    } catch (_err) {
      setStatus("Viewer initialized. Google 3D layer could not be loaded with the current key.");
      return;
    }
  }

  setStatus("Viewer initialized with 3D terrain.");
}

async function loadTerrainGrid() {
  if (!viewer) {
    setStatus("Initialize the 3D map first.");
    return;
  }

  clearRenderLayers();

  const scenario = getScenario();
  const bounds = boundsFromScenario(scenario);
  const resolution = clamp(scenario.resolution, 20, 100);

  const points = [];
  for (let y = 0; y < resolution; y += 1) {
    const ty = y / (resolution - 1);
    const lat = bounds.south + (bounds.north - bounds.south) * ty;
    for (let x = 0; x < resolution; x += 1) {
      const tx = x / (resolution - 1);
      const lon = bounds.west + (bounds.east - bounds.west) * tx;
      points.push(Cesium.Cartographic.fromDegrees(lon, lat));
    }
  }

  setStatus(`Sampling terrain elevations for ${resolution}x${resolution} grid...`);
  let sampled;
  try {
    sampled = await Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, points);
  } catch (_error) {
    sampled = points;
  }

  const heights = new Float32Array(sampled.length);
  for (let i = 0; i < sampled.length; i += 1) {
    const h = sampled[i].height;
    heights[i] = Number.isFinite(h) ? h : 0;
  }

  const midLat = (bounds.south + bounds.north) * 0.5;
  const dxGeo = new Cesium.EllipsoidGeodesic(
    Cesium.Cartographic.fromDegrees(bounds.west, midLat),
    Cesium.Cartographic.fromDegrees(bounds.east, midLat),
  );
  const dyGeo = new Cesium.EllipsoidGeodesic(
    Cesium.Cartographic.fromDegrees((bounds.west + bounds.east) * 0.5, bounds.south),
    Cesium.Cartographic.fromDegrees((bounds.west + bounds.east) * 0.5, bounds.north),
  );

  terrainGrid = {
    ...bounds,
    resolution,
    heights,
    dxMeters: dxGeo.surfaceDistance / (resolution - 1),
    dyMeters: dyGeo.surfaceDistance / (resolution - 1),
  };

  if (boundaryEntity) {
    viewer.entities.remove(boundaryEntity);
  }
  boundaryEntity = viewer.entities.add({
    rectangle: {
      coordinates: Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
      fill: false,
      outline: true,
      outlineColor: Cesium.Color.WHITE.withAlpha(0.6),
    },
  });

  if (burnScarEntity) {
    viewer.entities.remove(burnScarEntity);
  }
  burnScarEntity = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(scenario.centerLon, scenario.centerLat, 0),
    ellipse: {
      semiMajorAxis: scenario.burnScarKm * 1000,
      semiMinorAxis: scenario.burnScarKm * 1000,
      material: Cesium.Color.DARKORANGE.withAlpha(0.22),
      heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    },
  });

  await viewer.camera.flyTo({
    destination: Cesium.Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
  });

  setStatus(`Terrain grid loaded (${resolution}x${resolution}). Ready to run simulation.`);
}

function colorFromZone(zone) {
  if (zone === 3) {
    return Cesium.Color.RED.withAlpha(0.78);
  }
  if (zone === 2) {
    return Cesium.Color.ORANGE.withAlpha(0.62);
  }
  return Cesium.Color.CORNFLOWERBLUE.withAlpha(0.48);
}

function renderHazardZones(result) {
  const { zones } = result;
  const resolution = terrainGrid.resolution;
  let high = 0;
  let medium = 0;
  let low = 0;

  for (let i = 0; i < zones.length; i += 1) {
    const zone = zones[i];
    if (zone === 0) {
      continue;
    }
    const x = i % resolution;
    const y = Math.floor(i / resolution);

    if (zone === 1 && (x + y) % 2 === 0) {
      continue;
    }

    const { lon, lat } = gridToLonLat(terrainGrid, x, y);
    const h = terrainGrid.heights[i] + 2;
    const entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, h),
      point: {
        pixelSize: zone === 3 ? 8 : 6,
        color: colorFromZone(zone),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    hazardEntities.push(entity);
    if (zone === 3) high += 1;
    else if (zone === 2) medium += 1;
    else low += 1;
  }

  return { high, medium, low };
}

function animateParticles(frames) {
  if (!frames.length || !viewer) {
    return;
  }

  const token = ++animationToken;
  particlePoints = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const particleSlots = frames[0].length;

  for (let i = 0; i < particleSlots; i += 1) {
    particlePoints.add({
      pixelSize: 4,
      color: Cesium.Color.CYAN.withAlpha(0.7),
      show: false,
    });
  }

  let frameIndex = 0;
  let lastTime = 0;

  const draw = (time) => {
    if (token !== animationToken || !particlePoints) {
      return;
    }
    if (time - lastTime < 45) {
      requestAnimationFrame(draw);
      return;
    }
    lastTime = time;

    const frame = frames[frameIndex];
    for (let i = 0; i < particleSlots; i += 1) {
      const primitive = particlePoints.get(i);
      const state = frame[i];
      if (!state) {
        primitive.show = false;
        continue;
      }

      const x = clamp(state.x, 0, terrainGrid.resolution - 1);
      const y = clamp(state.y, 0, terrainGrid.resolution - 1);
      const gx = clamp(Math.round(x), 0, terrainGrid.resolution - 1);
      const gy = clamp(Math.round(y), 0, terrainGrid.resolution - 1);
      const idx = gy * terrainGrid.resolution + gx;
      const { lon, lat } = gridToLonLat(terrainGrid, x, y);
      primitive.position = Cesium.Cartesian3.fromDegrees(lon, lat, terrainGrid.heights[idx] + 1.5);
      primitive.show = true;
    }

    frameIndex = (frameIndex + 1) % frames.length;
    requestAnimationFrame(draw);
  };

  requestAnimationFrame(draw);
}

async function runScenario() {
  if (!viewer || !terrainGrid) {
    setStatus("Load map and terrain grid before running simulation.");
    return;
  }

  clearRenderLayers();

  const scenario = getScenario();
  const simulationInput = {
    centerLon: scenario.centerLon,
    centerLat: scenario.centerLat,
    burnScarKm: scenario.burnScarKm,
    burnSeverity: clamp(scenario.burnSeverity, 0, 1),
    rainMmHr: Math.max(1, scenario.rainMmHr),
    steps: Math.max(40, scenario.steps),
    dt: Math.max(0.4, scenario.dt),
    particleCount: Math.max(80, scenario.particleCount),
  };

  setStatus("Running particle flood simulation...");
  const result = runFloodSimulation(terrainGrid, simulationInput);
  const count = renderHazardZones(result);
  animateParticles(result.frames);

  setStatus(
    `Simulation complete.\n` +
      `High hazard points: ${count.high}\n` +
      `Medium hazard points: ${count.medium}\n` +
      `Low hazard points: ${count.low}\n` +
      `Active routed cells: ${result.stats.activeCells}`,
  );
}

buttons.initViewer.addEventListener("click", () => {
  initializeViewer();
});

buttons.loadTerrain.addEventListener("click", () => {
  loadTerrainGrid();
});

buttons.run.addEventListener("click", () => {
  runScenario();
});

setStatus("Press “Initialize 3D Map” to begin.");
