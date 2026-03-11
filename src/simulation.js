import { haversineMeters, offsetLngLat } from "./terrain.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const SEVERITY_PROFILES = {
  low: {
    infiltrationMultiplier: 0.75,
    runoffBoost: 0.95,
    dispersion: 0.06,
    burnRadiusScale: 0.9,
  },
  moderate: {
    infiltrationMultiplier: 0.45,
    runoffBoost: 1.15,
    dispersion: 0.1,
    burnRadiusScale: 1,
  },
  high: {
    infiltrationMultiplier: 0.2,
    runoffBoost: 1.35,
    dispersion: 0.16,
    burnRadiusScale: 1.1,
  },
};

const SOIL_INFILTRATION_MM_HOUR = {
  sandy: 32,
  loam: 18,
  clay: 8,
};

function makeSeededRandom(seed) {
  let state = Math.abs(Math.floor(seed)) % 2147483647;
  if (state === 0) {
    state = 1;
  }

  return () => {
    state = (state * 48271) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function sampleHeight(grid, x, y) {
  const maxIndex = grid.resolution - 1;
  const clampedX = clamp(x, 0, maxIndex);
  const clampedY = clamp(y, 0, maxIndex);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, maxIndex);
  const y1 = Math.min(y0 + 1, maxIndex);
  const tx = clampedX - x0;
  const ty = clampedY - y0;

  const h00 = grid.height(y0, x0);
  const h10 = grid.height(y0, x1);
  const h01 = grid.height(y1, x0);
  const h11 = grid.height(y1, x1);

  return (
    h00 * (1 - tx) * (1 - ty) +
    h10 * tx * (1 - ty) +
    h01 * (1 - tx) * ty +
    h11 * tx * ty
  );
}

function gradientAt(grid, x, y) {
  const dx = grid.localDxMeters || grid.cellSizeMeters;
  const dy = grid.localDyMeters || grid.cellSizeMeters;
  const east = sampleHeight(grid, x + 1, y);
  const west = sampleHeight(grid, x - 1, y);
  const south = sampleHeight(grid, x, y + 1);
  const north = sampleHeight(grid, x, y - 1);

  return {
    x: (east - west) / (2 * dx),
    y: (south - north) / (2 * dy),
  };
}

function d8Direction(grid, row, column) {
  const currentHeight = grid.height(row, column);
  let bestDrop = 0;
  let direction = { x: 0, y: 0, slope: 0 };

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) {
        continue;
      }

      const nextRow = row + dy;
      const nextColumn = column + dx;
      if (
        nextRow < 0 ||
        nextColumn < 0 ||
        nextRow >= grid.resolution ||
        nextColumn >= grid.resolution
      ) {
        continue;
      }

      const neighborHeight = grid.height(nextRow, nextColumn);
      const distance = Math.hypot(
        dx * (grid.localDxMeters || grid.cellSizeMeters),
        dy * (grid.localDyMeters || grid.cellSizeMeters),
      );
      const drop = currentHeight - neighborHeight;

      if (drop > bestDrop) {
        const slope = drop / distance;
        bestDrop = drop;
        direction = {
          x: dx / Math.hypot(dx, dy),
          y: dy / Math.hypot(dx, dy),
          slope,
        };
      }
    }
  }

  return direction;
}

function cellToLngLat(grid, x, y) {
  const column = clamp(x, 0, grid.resolution - 1);
  const row = clamp(y, 0, grid.resolution - 1);
  const lng =
    grid.lngEdges[0] +
    (column / (grid.resolution - 1)) *
      (grid.lngEdges[grid.resolution] - grid.lngEdges[0]);
  const lat =
    grid.latEdges[0] +
    (row / (grid.resolution - 1)) *
      (grid.latEdges[grid.resolution] - grid.latEdges[0]);

  return { lng, lat };
}

function buildBurnScar(grid, severity) {
  const profile = SEVERITY_PROFILES[severity];
  const radiusX = grid.extentMeters * 0.17 * profile.burnRadiusScale;
  const radiusY = grid.extentMeters * 0.12 * profile.burnRadiusScale;
  const centerCell = (grid.resolution - 1) / 2;
  const burnMask = new Float32Array(grid.resolution * grid.resolution);
  const candidates = [];

  for (let row = 0; row < grid.resolution; row += 1) {
    for (let column = 0; column < grid.resolution; column += 1) {
      const east = (column - centerCell) * (grid.localDxMeters || grid.cellSizeMeters);
      const north = (centerCell - row) * (grid.localDyMeters || grid.cellSizeMeters);
      const ellipseDistance =
        (east * east) / (radiusX * radiusX) +
        (north * north) / (radiusY * radiusY);
      const burnWeight = clamp(1 - ellipseDistance, 0, 1);
      burnMask[grid.index(row, column)] = burnWeight;
      if (burnWeight > 0) {
        candidates.push({ row, column, burnWeight });
      }
    }
  }

  return {
    burnMask,
    candidates,
    radiusX,
    radiusY,
  };
}

function percentile(values, target) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(clamp(target, 0, 1) * (sorted.length - 1));
  return sorted[index];
}

export function buildBurnScarPolygon(center, extentMeters, severity) {
  const profile = SEVERITY_PROFILES[severity];
  const radiusX = extentMeters * 0.17 * profile.burnRadiusScale;
  const radiusY = extentMeters * 0.12 * profile.burnRadiusScale;
  const coordinates = [];

  for (let step = 0; step <= 64; step += 1) {
    const angle = (step / 64) * Math.PI * 2;
    const east = Math.cos(angle) * radiusX;
    const north = Math.sin(angle) * radiusY;
    const point = offsetLngLat(center, east, north);
    coordinates.push([point.lng, point.lat]);
  }

  return {
    type: "Feature",
    properties: {
      severity,
    },
    geometry: {
      type: "Polygon",
      coordinates: [coordinates],
    },
  };
}

export function runFloodSimulation(grid, scenario) {
  const severityProfile = SEVERITY_PROFILES[scenario.burnSeverity];
  const baseInfiltration =
    SOIL_INFILTRATION_MM_HOUR[scenario.soilTexture] ?? SOIL_INFILTRATION_MM_HOUR.loam;
  const effectiveInfiltration =
    baseInfiltration * severityProfile.infiltrationMultiplier;
  const rainfallExcess =
    Math.max(0, scenario.rainfallMmPerHour - effectiveInfiltration) *
    severityProfile.runoffBoost;
  const rainfallDurationHours = scenario.durationMinutes / 60;
  const runoffDepthMeters = (rainfallExcess * rainfallDurationHours) / 1000;
  const roughness = scenario.roughnessManning;
  const hydraulicRadius = clamp(runoffDepthMeters * 0.5, 0.008, 0.09);
  const burnScar = buildBurnScar(grid, scenario.burnSeverity);
  const hazard = new Float32Array(grid.resolution * grid.resolution);
  const arrival = new Float32Array(grid.resolution * grid.resolution);
  arrival.fill(Number.POSITIVE_INFINITY);

  const candidateWeights = burnScar.candidates
    .map((candidate) => {
      const direction = d8Direction(grid, candidate.row, candidate.column);
      const slopeBias = clamp(direction.slope * 45, 0, 3.2);
      const weight =
        candidate.burnWeight *
        (0.5 + slopeBias) *
        Math.max(runoffDepthMeters * 1000, 1);

      return {
        ...candidate,
        direction,
        weight,
      };
    })
    .filter((candidate) => candidate.weight > 0);

  const weightTotal = candidateWeights.reduce(
    (sum, candidate) => sum + candidate.weight,
    0,
  );
  const seed =
    scenario.center.lat * 1e5 +
    scenario.center.lng * 1e4 +
    scenario.rainfallMmPerHour * 37 +
    scenario.durationMinutes * 13;
  const random = makeSeededRandom(seed);
  const emissionCount = Math.max(
    100,
    Math.floor(scenario.particleCount * clamp(rainfallExcess / 20, 0.65, 2)),
  );
  const renderedParticleLimit = Math.min(800, scenario.particleCount);
  const renderedStepStride = emissionCount > 1800 ? 4 : 2;
  const timeStepSeconds = 4;
  const maxSteps = Math.round(120 + (grid.extentMeters / 1000) * 12);
  let maxTravelMeters = 0;

  const paths = [];

  const chooseEmitter = () => {
    if (!candidateWeights.length || weightTotal === 0) {
      return null;
    }

    let threshold = random() * weightTotal;
    for (const candidate of candidateWeights) {
      threshold -= candidate.weight;
      if (threshold <= 0) {
        return candidate;
      }
    }

    return candidateWeights[candidateWeights.length - 1];
  };

  for (let index = 0; index < emissionCount; index += 1) {
    const emitter = chooseEmitter();
    if (!emitter) {
      break;
    }

    let x = emitter.column + (random() - 0.5) * 0.7;
    let y = emitter.row + (random() - 0.5) * 0.7;
    let distanceMeters = 0;
    let stagnationSteps = 0;
    const shouldRenderPath = index < renderedParticleLimit;
    const path = shouldRenderPath ? [] : null;

    for (let step = 0; step < maxSteps; step += 1) {
      if (x < 0 || y < 0 || x >= grid.resolution - 1 || y >= grid.resolution - 1) {
        break;
      }

      const gradient = gradientAt(grid, x, y);
      const gradientMagnitude = Math.hypot(gradient.x, gradient.y);
      const cellRow = clamp(Math.floor(y), 0, grid.resolution - 1);
      const cellColumn = clamp(Math.floor(x), 0, grid.resolution - 1);
      const fallback = d8Direction(grid, cellRow, cellColumn);

      let flowX = -gradient.x;
      let flowY = -gradient.y;
      let flowMagnitude = Math.hypot(flowX, flowY);

      if (flowMagnitude < 1e-6) {
        flowX = fallback.x;
        flowY = fallback.y;
        flowMagnitude = Math.hypot(flowX, flowY);
      } else {
        flowX = flowX / flowMagnitude + fallback.x * 0.35;
        flowY = flowY / flowMagnitude + fallback.y * 0.35;
        flowMagnitude = Math.hypot(flowX, flowY);
      }

      if (flowMagnitude < 1e-5) {
        stagnationSteps += 1;
        if (stagnationSteps > 5) {
          break;
        }
        continue;
      }

      const localSlope = Math.max(gradientMagnitude, fallback.slope, 1e-4);
      const velocityMetersSecond = clamp(
        ((1 / roughness) * Math.pow(hydraulicRadius, 2 / 3) * Math.sqrt(localSlope) + 0.18) *
          scenario.velocityMultiplier,
        0.45,
        22,
      );

      const lateralJitter = severityProfile.dispersion * (random() - 0.5);
      const directionX = flowX / flowMagnitude;
      const directionY = flowY / flowMagnitude;
      const movedX =
        ((directionX + directionY * lateralJitter) * velocityMetersSecond * timeStepSeconds) /
        (grid.localDxMeters || grid.cellSizeMeters);
      const movedY =
        ((directionY - directionX * lateralJitter) * velocityMetersSecond * timeStepSeconds) /
        (grid.localDyMeters || grid.cellSizeMeters);

      x += movedX;
      y += movedY;
      distanceMeters += velocityMetersSecond * timeStepSeconds;
      maxTravelMeters = Math.max(maxTravelMeters, distanceMeters);

      const hazardRow = clamp(Math.floor(y), 0, grid.resolution - 1);
      const hazardColumn = clamp(Math.floor(x), 0, grid.resolution - 1);
      const hazardIndex = grid.index(hazardRow, hazardColumn);
      const visitIntensity =
        1 +
        severityProfile.runoffBoost * 0.45 +
        clamp(localSlope * 6, 0, 2.2);
      hazard[hazardIndex] += visitIntensity;
      arrival[hazardIndex] = Math.min(arrival[hazardIndex], step * timeStepSeconds);

      if (shouldRenderPath && step % renderedStepStride === 0) {
        path.push(cellToLngLat(grid, x, y));
      }
    }

    if (path && path.length > 1) {
      paths.push(path);
    }
  }

  const hazardValues = Array.from(hazard).filter((value) => value > 0);
  const upperReference = Math.max(percentile(hazardValues, 0.98), 1);
  const normalizedHazard = Float32Array.from(hazard, (value) =>
    clamp(Math.log1p(value) / Math.log1p(upperReference), 0, 1),
  );

  const highRiskThreshold = 0.58;
  const moderateRiskThreshold = 0.32;
  const cellAreaSquareKm =
    ((grid.localDxMeters || grid.cellSizeMeters) *
      (grid.localDyMeters || grid.cellSizeMeters)) /
    1e6;

  let highRiskArea = 0;
  let moderateRiskArea = 0;
  const arrivalTimes = [];

  for (let i = 0; i < normalizedHazard.length; i += 1) {
    if (normalizedHazard[i] >= moderateRiskThreshold) {
      moderateRiskArea += cellAreaSquareKm;
      if (arrival[i] < Number.POSITIVE_INFINITY) {
        arrivalTimes.push(arrival[i] / 60);
      }
    }

    if (normalizedHazard[i] >= highRiskThreshold) {
      highRiskArea += cellAreaSquareKm;
    }
  }

  const sortedArrivalMinutes = arrivalTimes.sort((a, b) => a - b);
  const leadTimeMinutes =
    sortedArrivalMinutes[Math.floor(sortedArrivalMinutes.length * 0.2)] ?? 0;
  const medianArrivalMinutes =
    sortedArrivalMinutes[Math.floor(sortedArrivalMinutes.length * 0.5)] ?? 0;

  return {
    normalizedHazard,
    rawHazard: hazard,
    arrivalSeconds: arrival,
    paths,
    burnScar,
    summary: {
      runoffDepthMm: runoffDepthMeters * 1000,
      rainfallExcessMmHour: rainfallExcess,
      effectiveInfiltrationMmHour: effectiveInfiltration,
      highRiskAreaSquareKm: highRiskArea,
      moderateRiskAreaSquareKm: moderateRiskArea,
      maxTravelKm: maxTravelMeters / 1000,
      earliestLeadTimeMinutes: leadTimeMinutes,
      medianArrivalMinutes,
      cellAreaSquareKm,
    },
  };
}

export function summarizeWarningGrid(grid, simulation) {
  let peakIndex = 0;
  let peakValue = 0;

  for (let index = 0; index < simulation.normalizedHazard.length; index += 1) {
    const value = simulation.normalizedHazard[index];
    if (value > peakValue) {
      peakValue = value;
      peakIndex = index;
    }
  }

  const row = Math.floor(peakIndex / grid.resolution);
  const column = peakIndex % grid.resolution;
  const hotspot = grid.point(row, column);
  const distanceMeters = haversineMeters(grid.center, hotspot);

  return {
    hotspot,
    hotspotDistanceKm: distanceMeters / 1000,
    peakHazard: peakValue,
  };
}
