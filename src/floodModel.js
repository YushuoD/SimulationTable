function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function indexOf(grid, x, y) {
  return y * grid.resolution + x;
}

export function gridToLonLat(grid, x, y) {
  const tx = x / (grid.resolution - 1);
  const ty = y / (grid.resolution - 1);
  return {
    lon: grid.west + (grid.east - grid.west) * tx,
    lat: grid.south + (grid.north - grid.south) * ty,
  };
}

function sampleHeight(grid, x, y) {
  const clampedX = clamp(x, 0, grid.resolution - 1);
  const clampedY = clamp(y, 0, grid.resolution - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, grid.resolution - 1);
  const y1 = Math.min(y0 + 1, grid.resolution - 1);

  const h00 = grid.heights[indexOf(grid, x0, y0)];
  const h10 = grid.heights[indexOf(grid, x1, y0)];
  const h01 = grid.heights[indexOf(grid, x0, y1)];
  const h11 = grid.heights[indexOf(grid, x1, y1)];

  const tx = clampedX - x0;
  const ty = clampedY - y0;
  const h0 = h00 * (1 - tx) + h10 * tx;
  const h1 = h01 * (1 - tx) + h11 * tx;
  return h0 * (1 - ty) + h1 * ty;
}

function localSlope(grid, x, y) {
  const hL = sampleHeight(grid, x - 1, y);
  const hR = sampleHeight(grid, x + 1, y);
  const hD = sampleHeight(grid, x, y - 1);
  const hU = sampleHeight(grid, x, y + 1);

  const dzdx = (hR - hL) / (2 * grid.dxMeters);
  const dzdy = (hU - hD) / (2 * grid.dyMeters);
  const downhillX = -dzdx;
  const downhillY = -dzdy;
  const mag = Math.hypot(downhillX, downhillY);

  if (mag < 1e-7) {
    return { x: 0, y: 0, slope: 0 };
  }

  return {
    x: downhillX / mag,
    y: downhillY / mag,
    slope: mag,
  };
}

function approximateDistanceKm(aLon, aLat, bLon, bLat) {
  const kmPerDegLat = 111.32;
  const kmPerDegLon = Math.cos(((aLat + bLat) * 0.5 * Math.PI) / 180) * 111.32;
  const dx = (aLon - bLon) * kmPerDegLon;
  const dy = (aLat - bLat) * kmPerDegLat;
  return Math.hypot(dx, dy);
}

function isInBurnScar(grid, x, y, centerLon, centerLat, burnScarKm) {
  const point = gridToLonLat(grid, x, y);
  return approximateDistanceKm(point.lon, point.lat, centerLon, centerLat) <= burnScarKm;
}

function percentile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

export function runFloodSimulation(grid, options) {
  const {
    centerLon,
    centerLat,
    burnScarKm,
    burnSeverity,
    rainMmHr,
    steps,
    dt,
    particleCount,
  } = options;

  const g = 9.81;
  const rainMetersPerSecond = (rainMmHr / 1000) / 3600;
  const cellArea = grid.dxMeters * grid.dyMeters;
  const infiltrationBase = 0.0000018;
  const infiltration = infiltrationBase * (1 - burnSeverity * 0.85);
  const friction = 0.22 + burnSeverity * 0.06;
  const diffusion = 0.22;

  const particles = [];
  for (let i = 0; i < particleCount; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * (burnScarKm / Math.max(grid.dxMeters, grid.dyMeters)) * 1000;
    const centerX = grid.resolution * 0.5 + Math.cos(angle) * radius;
    const centerY = grid.resolution * 0.5 + Math.sin(angle) * radius;

    particles.push({
      x: clamp(centerX, 0, grid.resolution - 1),
      y: clamp(centerY, 0, grid.resolution - 1),
      vx: 0,
      vy: 0,
      mass: 1,
      active: true,
    });
  }

  const hazard = new Float32Array(grid.resolution * grid.resolution);
  const frames = [];
  const frameStride = Math.max(1, Math.floor(steps / 90));

  for (let step = 0; step < steps; step += 1) {
    const frame = new Array(particles.length);

    for (let i = 0; i < particles.length; i += 1) {
      const p = particles[i];
      if (!p.active) {
        frame[i] = null;
        continue;
      }

      const slope = localSlope(grid, p.x, p.y);
      const accel = g * slope.slope;
      const randomTurnX = (Math.random() - 0.5) * diffusion;
      const randomTurnY = (Math.random() - 0.5) * diffusion;

      p.vx = (p.vx + (slope.x + randomTurnX) * accel * dt) * Math.exp(-friction * dt);
      p.vy = (p.vy + (slope.y + randomTurnY) * accel * dt) * Math.exp(-friction * dt);

      p.x += (p.vx * dt) / grid.dxMeters;
      p.y += (p.vy * dt) / grid.dyMeters;

      if (p.x < 0 || p.x > grid.resolution - 1 || p.y < 0 || p.y > grid.resolution - 1) {
        p.active = false;
        frame[i] = null;
        continue;
      }

      const inBurnScar = isInBurnScar(grid, p.x, p.y, centerLon, centerLat, burnScarKm);
      const rainInput = inBurnScar ? rainMetersPerSecond * cellArea * dt : rainMetersPerSecond * cellArea * dt * 0.2;
      const infilLoss = infiltration * cellArea * dt;
      p.mass = Math.max(0, p.mass + rainInput - infilLoss);

      if (p.mass < 0.001) {
        p.active = false;
        frame[i] = null;
        continue;
      }

      const cellX = clamp(Math.round(p.x), 0, grid.resolution - 1);
      const cellY = clamp(Math.round(p.y), 0, grid.resolution - 1);
      const idx = indexOf(grid, cellX, cellY);
      const speed = Math.hypot(p.vx, p.vy);
      hazard[idx] += p.mass * (0.4 + speed);

      frame[i] = { x: p.x, y: p.y };
    }

    if (step % frameStride === 0 || step === steps - 1) {
      frames.push(frame);
    }
  }

  const positives = Array.from(hazard).filter((v) => v > 0);
  const p50 = percentile(positives, 0.5);
  const p78 = percentile(positives, 0.78);
  const p92 = percentile(positives, 0.92);

  const zones = new Uint8Array(hazard.length);
  for (let i = 0; i < hazard.length; i += 1) {
    const h = hazard[i];
    if (h >= p92) {
      zones[i] = 3;
    } else if (h >= p78) {
      zones[i] = 2;
    } else if (h >= p50 && h > 0) {
      zones[i] = 1;
    } else {
      zones[i] = 0;
    }
  }

  return {
    hazard,
    zones,
    frames,
    stats: {
      activeCells: positives.length,
      highThreshold: p92,
      mediumThreshold: p78,
      lowThreshold: p50,
    },
  };
}
