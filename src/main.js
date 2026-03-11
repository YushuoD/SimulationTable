import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./style.css";

import {
  buildBurnScarPolygon,
  runFloodSimulation,
  summarizeWarningGrid,
} from "./simulation.js";
import { TerrainSampler } from "./terrain.js";

const USGS_IMAGERY =
  "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";
const TERRARIUM_TILES =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

const PRESETS = [
  {
    id: "sierra-nevada",
    label: "Sierra Nevada foothills, CA",
    center: { lat: 39.35, lng: -120.43 },
    extentKm: 12,
    rainfallMmPerHour: 56,
    durationMinutes: 70,
    burnSeverity: "high",
    soilTexture: "loam",
    roughnessManning: 0.05,
    particleCount: 1800,
    velocityMultiplier: 1.05,
    view: { zoom: 10.2, pitch: 68, bearing: 18 },
  },
  {
    id: "san-gabriel",
    label: "San Gabriel Mountains, CA",
    center: { lat: 34.299, lng: -117.851 },
    extentKm: 10,
    rainfallMmPerHour: 68,
    durationMinutes: 55,
    burnSeverity: "high",
    soilTexture: "clay",
    roughnessManning: 0.04,
    particleCount: 2200,
    velocityMultiplier: 1.12,
    view: { zoom: 10.8, pitch: 70, bearing: 44 },
  },
  {
    id: "front-range",
    label: "Front Range, CO",
    center: { lat: 40.362, lng: -105.612 },
    extentKm: 14,
    rainfallMmPerHour: 44,
    durationMinutes: 80,
    burnSeverity: "moderate",
    soilTexture: "loam",
    roughnessManning: 0.06,
    particleCount: 1600,
    velocityMultiplier: 0.98,
    view: { zoom: 9.8, pitch: 66, bearing: -12 },
  },
  {
    id: "santa-ynez",
    label: "Santa Ynez Mountains, CA",
    center: { lat: 34.513, lng: -119.639 },
    extentKm: 9,
    rainfallMmPerHour: 74,
    durationMinutes: 45,
    burnSeverity: "high",
    soilTexture: "loam",
    roughnessManning: 0.04,
    particleCount: 2400,
    velocityMultiplier: 1.15,
    view: { zoom: 11.2, pitch: 69, bearing: 54 },
  },
];

const elements = {
  presetSelect: document.querySelector("#preset-select"),
  latInput: document.querySelector("#lat-input"),
  lngInput: document.querySelector("#lng-input"),
  extentInput: document.querySelector("#extent-input"),
  rainfallInput: document.querySelector("#rainfall-input"),
  durationInput: document.querySelector("#duration-input"),
  severityInput: document.querySelector("#severity-input"),
  soilInput: document.querySelector("#soil-input"),
  roughnessInput: document.querySelector("#roughness-input"),
  particlesInput: document.querySelector("#particles-input"),
  extentValue: document.querySelector("#extent-value"),
  rainfallValue: document.querySelector("#rainfall-value"),
  durationValue: document.querySelector("#duration-value"),
  roughnessValue: document.querySelector("#roughness-value"),
  particlesValue: document.querySelector("#particles-value"),
  simulateButton: document.querySelector("#simulate-button"),
  flyoverButton: document.querySelector("#flyover-button"),
  status: document.querySelector("#status"),
  summary: document.querySelector("#summary"),
  overlay: document.querySelector("#overlay"),
};

const initialScenario = structuredClone(PRESETS[0]);
const terrainSampler = new TerrainSampler();

const state = {
  scenario: initialScenario,
  mapLoaded: false,
  grid: null,
  simulation: null,
  warning: null,
  animationStart: performance.now(),
  pendingRun: null,
  hazardBuffer: document.createElement("canvas"),
  needsHazardRedraw: true,
};

const overlayContext = elements.overlay.getContext("2d");
const hazardContext = state.hazardBuffer.getContext("2d");

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.borderColor = isError
    ? "rgba(247, 77, 77, 0.4)"
    : "rgba(152, 190, 214, 0.18)";
}

function resizeCanvases() {
  const container = elements.overlay.parentElement;
  const width = container.clientWidth;
  const height = container.clientHeight;
  const ratio = window.devicePixelRatio || 1;

  elements.overlay.width = Math.round(width * ratio);
  elements.overlay.height = Math.round(height * ratio);
  elements.overlay.style.width = `${width}px`;
  elements.overlay.style.height = `${height}px`;
  overlayContext.setTransform(ratio, 0, 0, ratio, 0, 0);

  state.hazardBuffer.width = Math.round(width * ratio);
  state.hazardBuffer.height = Math.round(height * ratio);
  hazardContext.setTransform(ratio, 0, 0, ratio, 0, 0);

  state.needsHazardRedraw = true;
}

function hazardColor(value) {
  const clamped = Math.max(0, Math.min(1, value));
  const anchors = [
    [255, 230, 109],
    [255, 140, 66],
    [214, 40, 40],
  ];
  const scaled = clamped * (anchors.length - 1);
  const index = Math.min(anchors.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const current = anchors[index];
  const next = anchors[index + 1];
  const color = current.map((channel, channelIndex) =>
    Math.round(channel + (next[channelIndex] - channel) * local),
  );
  const alpha = 0.08 + Math.pow(clamped, 1.3) * 0.55;
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
}

function interpolatePath(path, phase) {
  const clamped = Math.max(0, Math.min(0.999, phase));
  const exactIndex = clamped * (path.length - 1);
  const left = Math.floor(exactIndex);
  const right = Math.min(left + 1, path.length - 1);
  const t = exactIndex - left;
  const start = path[left];
  const end = path[right];

  return {
    lng: start.lng + (end.lng - start.lng) * t,
    lat: start.lat + (end.lat - start.lat) * t,
  };
}

function project(map, lng, lat) {
  return map.project([lng, lat]);
}

function redrawHazardBuffer() {
  if (!state.grid || !state.simulation || !state.mapLoaded) {
    hazardContext.clearRect(0, 0, state.hazardBuffer.width, state.hazardBuffer.height);
    state.needsHazardRedraw = false;
    return;
  }

  const map = state.map;
  const width = elements.overlay.parentElement.clientWidth;
  const height = elements.overlay.parentElement.clientHeight;

  hazardContext.clearRect(0, 0, width, height);

  const { grid, simulation } = state;
  for (let row = 0; row < grid.resolution; row += 1) {
    const north = grid.latEdges[row];
    const south = grid.latEdges[row + 1];
    for (let column = 0; column < grid.resolution; column += 1) {
      const score = simulation.normalizedHazard[grid.index(row, column)];
      if (score < 0.12) {
        continue;
      }

      const west = grid.lngEdges[column];
      const east = grid.lngEdges[column + 1];
      const p1 = project(map, west, north);
      const p2 = project(map, east, north);
      const p3 = project(map, east, south);
      const p4 = project(map, west, south);

      hazardContext.fillStyle = hazardColor(score);
      hazardContext.beginPath();
      hazardContext.moveTo(p1.x, p1.y);
      hazardContext.lineTo(p2.x, p2.y);
      hazardContext.lineTo(p3.x, p3.y);
      hazardContext.lineTo(p4.x, p4.y);
      hazardContext.closePath();
      hazardContext.fill();
    }
  }

  state.needsHazardRedraw = false;
}

function drawParticles(time) {
  if (!state.simulation || !state.simulation.paths.length) {
    return;
  }

  const map = state.map;
  overlayContext.lineCap = "round";
  overlayContext.lineJoin = "round";
  overlayContext.lineWidth = 1.1;

  state.simulation.paths.forEach((path, index) => {
    overlayContext.beginPath();
    overlayContext.strokeStyle = "rgba(130, 218, 255, 0.18)";

    path.forEach((point, pointIndex) => {
      const projected = project(map, point.lng, point.lat);
      if (pointIndex === 0) {
        overlayContext.moveTo(projected.x, projected.y);
      } else {
        overlayContext.lineTo(projected.x, projected.y);
      }
    });
    overlayContext.stroke();

    const phase =
      ((time - state.animationStart) * (0.00004 + (index % 11) * 0.0000025) +
        index * 0.047) %
      1;
    const markerPosition = interpolatePath(path, phase);
    const projected = project(map, markerPosition.lng, markerPosition.lat);

    overlayContext.fillStyle = "rgba(170, 235, 255, 0.85)";
    overlayContext.beginPath();
    overlayContext.arc(projected.x, projected.y, 1.9, 0, Math.PI * 2);
    overlayContext.fill();
  });
}

function renderFrame(time) {
  const width = elements.overlay.parentElement.clientWidth;
  const height = elements.overlay.parentElement.clientHeight;
  overlayContext.clearRect(0, 0, width, height);

  if (state.needsHazardRedraw) {
    redrawHazardBuffer();
  }

  overlayContext.drawImage(state.hazardBuffer, 0, 0, width, height);
  drawParticles(time);
  requestAnimationFrame(renderFrame);
}

function buildSummaryMarkup() {
  if (!state.simulation || !state.warning) {
    return "Configure a scenario and run the simulation to estimate likely downslope warning zones.";
  }

  const { summary } = state.simulation;
  const warning = state.warning;

  return `
    <div class="metric"><strong>Runoff depth</strong><span>${summary.runoffDepthMm.toFixed(1)} mm</span></div>
    <div class="metric"><strong>Rainfall excess</strong><span>${summary.rainfallExcessMmHour.toFixed(1)} mm/hr</span></div>
    <div class="metric"><strong>High-risk corridor</strong><span>${summary.highRiskAreaSquareKm.toFixed(2)} km²</span></div>
    <div class="metric"><strong>Moderate-risk area</strong><span>${summary.moderateRiskAreaSquareKm.toFixed(2)} km²</span></div>
    <div class="metric"><strong>Estimated max runout</strong><span>${summary.maxTravelKm.toFixed(1)} km</span></div>
    <div class="metric"><strong>Likely warning lead time</strong><span>${summary.earliestLeadTimeMinutes.toFixed(0)} min</span></div>
    <div class="metric"><strong>Median arrival</strong><span>${summary.medianArrivalMinutes.toFixed(0)} min</span></div>
    <div class="metric"><strong>Peak hazard hotspot</strong><span>${warning.hotspotDistanceKm.toFixed(1)} km downslope</span></div>
  `;
}

function updateSummary() {
  elements.summary.innerHTML = buildSummaryMarkup();
}

function buildSourceData() {
  const burnScar = buildBurnScarPolygon(
    state.scenario.center,
    state.scenario.extentKm * 1000,
    state.scenario.burnSeverity,
  );

  return {
    type: "FeatureCollection",
    features: [
      burnScar,
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Point",
          coordinates: [state.scenario.center.lng, state.scenario.center.lat],
        },
      },
    ],
  };
}

function updateMapData() {
  if (!state.mapLoaded) {
    return;
  }

  const source = state.map.getSource("scenario");
  if (source) {
    source.setData(buildSourceData());
  }
}

function syncFieldDisplays() {
  elements.extentValue.textContent = `${state.scenario.extentKm.toFixed(0)} km`;
  elements.rainfallValue.textContent = `${state.scenario.rainfallMmPerHour.toFixed(0)} mm/hr`;
  elements.durationValue.textContent = `${state.scenario.durationMinutes.toFixed(0)} min`;
  elements.roughnessValue.textContent = state.scenario.roughnessManning.toFixed(2);
  elements.particlesValue.textContent = `${state.scenario.particleCount.toFixed(0)} particles`;
}

function writeScenarioToInputs() {
  elements.latInput.value = state.scenario.center.lat.toFixed(4);
  elements.lngInput.value = state.scenario.center.lng.toFixed(4);
  elements.extentInput.value = String(state.scenario.extentKm);
  elements.rainfallInput.value = String(state.scenario.rainfallMmPerHour);
  elements.durationInput.value = String(state.scenario.durationMinutes);
  elements.severityInput.value = state.scenario.burnSeverity;
  elements.soilInput.value = state.scenario.soilTexture;
  elements.roughnessInput.value = String(Math.round(state.scenario.roughnessManning * 100));
  elements.particlesInput.value = String(state.scenario.particleCount);
  syncFieldDisplays();
}

function readScenarioFromInputs() {
  state.scenario = {
    ...state.scenario,
    center: {
      lat: Number.parseFloat(elements.latInput.value),
      lng: Number.parseFloat(elements.lngInput.value),
    },
    extentKm: Number.parseFloat(elements.extentInput.value),
    rainfallMmPerHour: Number.parseFloat(elements.rainfallInput.value),
    durationMinutes: Number.parseFloat(elements.durationInput.value),
    burnSeverity: elements.severityInput.value,
    soilTexture: elements.soilInput.value,
    roughnessManning: Number.parseFloat(elements.roughnessInput.value) / 100,
    particleCount: Number.parseFloat(elements.particlesInput.value),
  };

  syncFieldDisplays();
  updateMapData();
  state.needsHazardRedraw = true;
}

function populatePresetSelect() {
  PRESETS.forEach((preset) => {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    elements.presetSelect.append(option);
  });
  elements.presetSelect.value = PRESETS[0].id;
}

function applyPreset(presetId) {
  const preset = PRESETS.find((entry) => entry.id === presetId);
  if (!preset) {
    return;
  }

  state.scenario = structuredClone(preset);
  writeScenarioToInputs();
  updateMapData();

  if (state.mapLoaded) {
    state.map.easeTo({
      center: [preset.center.lng, preset.center.lat],
      zoom: preset.view.zoom,
      pitch: preset.view.pitch,
      bearing: preset.view.bearing,
      duration: 1400,
    });
  }
}

async function runScenario() {
  if (state.pendingRun) {
    return;
  }

  readScenarioFromInputs();
  elements.simulateButton.disabled = true;
  setStatus("Sampling elevation grid around the burn scar...");

  const run = (async () => {
    const extentMeters = state.scenario.extentKm * 1000;
    const resolution =
      extentMeters <= 10000 ? 84 : extentMeters <= 18000 ? 72 : 64;

    const grid = await terrainSampler.sampleGrid({
      center: state.scenario.center,
      extentMeters,
      resolution,
    });

    setStatus("Routing post-fire runoff particles downslope...");
    const simulation = runFloodSimulation(grid, state.scenario);
    const warning = summarizeWarningGrid(grid, simulation);

    state.grid = grid;
    state.simulation = simulation;
    state.warning = warning;
    state.animationStart = performance.now();
    state.needsHazardRedraw = true;
    updateSummary();

    setStatus(
      `Simulation updated. Peak hazard is ${warning.hotspotDistanceKm.toFixed(
        1,
      )} km from the burn scar, using DEM zoom ${grid.zoom}.`,
    );
  })();

  state.pendingRun = run;

  try {
    await run;
  } catch (error) {
    console.error(error);
    setStatus(
      "Terrain sampling failed. Check network access to the public imagery and DEM tile services.",
      true,
    );
    elements.summary.textContent =
      "The simulation could not load terrain tiles for this location.";
  } finally {
    state.pendingRun = null;
    elements.simulateButton.disabled = false;
  }
}

function bindInputs() {
  const immediateInputs = [
    elements.latInput,
    elements.lngInput,
    elements.severityInput,
    elements.soilInput,
  ];

  const sliderInputs = [
    elements.extentInput,
    elements.rainfallInput,
    elements.durationInput,
    elements.roughnessInput,
    elements.particlesInput,
  ];

  immediateInputs.forEach((input) => {
    input.addEventListener("change", readScenarioFromInputs);
  });

  sliderInputs.forEach((input) => {
    input.addEventListener("input", readScenarioFromInputs);
  });

  elements.simulateButton.addEventListener("click", runScenario);
  elements.flyoverButton.addEventListener("click", () => {
    readScenarioFromInputs();
    state.map.flyTo({
      center: [state.scenario.center.lng, state.scenario.center.lat],
      zoom: Math.max(state.map.getZoom(), 11),
      pitch: 70,
      bearing: state.map.getBearing() + 40,
      duration: 2200,
      essential: true,
    });
  });

  elements.presetSelect.addEventListener("change", (event) => {
    applyPreset(event.target.value);
    runScenario();
  });
}

function createMap() {
  const map = new maplibregl.Map({
    container: "map",
    center: [state.scenario.center.lng, state.scenario.center.lat],
    zoom: state.scenario.view.zoom,
    pitch: state.scenario.view.pitch,
    bearing: state.scenario.view.bearing,
    antialias: true,
    hash: true,
    style: {
      version: 8,
      sources: {
        imagery: {
          type: "raster",
          tiles: [USGS_IMAGERY],
          tileSize: 256,
          attribution: "USGS National Map",
        },
        terrainSource: {
          type: "raster-dem",
          tiles: [TERRARIUM_TILES],
          tileSize: 256,
          encoding: "terrarium",
          attribution: "Mapzen / AWS elevation tiles",
          maxzoom: 15,
        },
      },
      terrain: {
        source: "terrainSource",
        exaggeration: 1.28,
      },
      layers: [
        {
          id: "imagery",
          type: "raster",
          source: "imagery",
        },
        {
          id: "hillshade",
          type: "hillshade",
          source: "terrainSource",
          paint: {
            "hillshade-shadow-color": "rgba(0, 0, 0, 0.65)",
            "hillshade-highlight-color": "rgba(255, 244, 214, 0.18)",
            "hillshade-accent-color": "rgba(75, 130, 165, 0.22)",
          },
        },
        {
          id: "sky",
          type: "sky",
          paint: {
            "sky-type": "atmosphere",
            "sky-atmosphere-sun": [0, 0],
            "sky-atmosphere-sun-intensity": 8,
          },
        },
      ],
    },
  });

  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", () => {
    state.mapLoaded = true;
    map.addSource("scenario", {
      type: "geojson",
      data: buildSourceData(),
    });

    map.addLayer({
      id: "burn-scar",
      type: "fill",
      source: "scenario",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "fill-color": [
          "match",
          ["get", "severity"],
          "low",
          "#ffdb4d",
          "moderate",
          "#ff9340",
          "#d62828",
        ],
        "fill-opacity": 0.22,
      },
    });

    map.addLayer({
      id: "burn-scar-outline",
      type: "line",
      source: "scenario",
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: {
        "line-color": "#ffd166",
        "line-width": 2,
        "line-opacity": 0.75,
      },
    });

    map.addLayer({
      id: "source-point",
      type: "circle",
      source: "scenario",
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 7,
        "circle-color": "#9ce7ff",
        "circle-stroke-width": 2,
        "circle-stroke-color": "#0a1014",
      },
    });

    updateMapData();
    setStatus("3D terrain loaded. Click a mountain burn scar and run the warning model.");
    runScenario();
  });

  map.on("click", (event) => {
    state.scenario.center = {
      lat: event.lngLat.lat,
      lng: event.lngLat.lng,
    };
    writeScenarioToInputs();
    updateMapData();
    state.needsHazardRedraw = true;
  });

  map.on("move", () => {
    state.needsHazardRedraw = true;
  });

  map.on("resize", resizeCanvases);

  return map;
}

populatePresetSelect();
writeScenarioToInputs();
bindInputs();
resizeCanvases();
state.map = createMap();
requestAnimationFrame(renderFrame);
