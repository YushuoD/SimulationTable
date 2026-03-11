/**
 * Post-Fire Flood Simulation Engine
 * 
 * Based on established models and algorithms:
 * - D8 Flow Direction (TauDEM): Routes water to steepest of 8 neighbors
 * - Kinematic Wave Approximation (KINEROS2, PFHydro): v ∝ S^0.5 for flood timing
 * - Post-fire hydrology (PFHydro, USGS): Runoff multipliers by burn severity
 * 
 * References:
 * - PFHydro watershed-scale post-fire runoff model
 * - USGS: Model simulations of flood and debris flow timing in steep catchments after wildfire
 * - D8/D-Infinity flow algorithms (TauDEM)
 */

// D8 flow direction encoding: 1=E, 2=NE, 3=N, 4=NW, 5=W, 6=SW, 7=S, 8=SE
const D8_OFFSETS = [
  [0, 1],   // 1: East
  [1, 1],   // 2: NE
  [1, 0],   // 3: North
  [1, -1],  // 4: NW
  [0, -1],  // 5: West
  [-1, -1], // 6: SW
  [-1, 0],  // 7: South
  [-1, 1],  // 8: SE
];

// Post-fire runoff multipliers by burn severity (from PFHydro, KINEROS2 studies)
// Unburned baseline; fire reduces infiltration, increases surface runoff 2-100x
export const BURN_SEVERITY_FACTORS = {
  unburned: { runoffMultiplier: 1.0, infiltrationFactor: 1.0, velocityMultiplier: 1.0 },
  low: { runoffMultiplier: 2.5, infiltrationFactor: 0.6, velocityMultiplier: 1.3 },
  moderate: { runoffMultiplier: 8.0, infiltrationFactor: 0.25, velocityMultiplier: 1.8 },
  high: { runoffMultiplier: 25.0, infiltrationFactor: 0.1, velocityMultiplier: 2.5 },
};

// Approximate meters per degree at given latitude (for gradient calculation)
const METERS_PER_DEGREE_LAT = 111320;
const getMetersPerDegreeLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

/**
 * Compute gradient (rise/run) to each of 8 neighbors for D8 flow direction
 * Returns direction index (1-8) and slope magnitude
 */
export function computeD8FlowDirection(elevations, centerIdx, gridSize) {
  const center = elevations[centerIdx];
  if (center == null) return { direction: -1, slope: 0 };

  const row = Math.floor(centerIdx / gridSize);
  const col = centerIdx % gridSize;
  let maxDrop = -Infinity;
  let bestDir = -1;

  for (let d = 0; d < 8; d++) {
    const [dr, dc] = D8_OFFSETS[d];
    const nr = row + dr;
    const nc = col + dc;
    if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize) continue;

    const neighborIdx = nr * gridSize + nc;
    const neighbor = elevations[neighborIdx];
    if (neighbor == null) continue;

    const drop = center - neighbor;
    const dist = dr !== 0 && dc !== 0 ? Math.SQRT2 : 1; // diagonal = sqrt(2)
    const slope = drop / dist;

    if (drop > 0 && slope > maxDrop) {
      maxDrop = slope;
      bestDir = d + 1;
    }
  }

  return { direction: bestDir, slope: maxDrop > 0 ? maxDrop : 0 };
}

/**
 * Kinematic wave velocity: v = k * S^0.5 (Manning's simplified)
 * S = slope, k = coefficient (includes roughness, post-fire factor)
 */
export function kinematicWaveVelocity(slope, burnSeverity = 'moderate') {
  if (slope <= 0) return 0;
  const factors = BURN_SEVERITY_FACTORS[burnSeverity] || BURN_SEVERITY_FACTORS.moderate;
  const baseVelocity = Math.sqrt(slope) * 2.5; // m/s scale factor
  return baseVelocity * factors.velocityMultiplier;
}

/**
 * Particle state for flood simulation
 */
export class FloodParticle {
  constructor(lon, lat, height, id) {
    this.lon = lon;
    this.lat = lat;
    this.height = height;
    this.id = id;
    this.age = 0;
    this.path = [{ lon, lat, height }];
    this.active = true;
    this.flowIntensity = 1.0; // 1 = high, decreases as particle spreads
  }

  clone() {
    const p = new FloodParticle(this.lon, this.lat, this.height, this.id);
    p.path = [...this.path];
    p.age = this.age;
    p.flowIntensity = this.flowIntensity;
    return p;
  }
}

/**
 * Flood simulation engine - particle-based with D8 and kinematic wave
 */
export class FloodSimulationEngine {
  constructor(options = {}) {
    this.burnSeverity = options.burnSeverity || 'moderate';
    this.rainfallIntensity = options.rainfallIntensity || 25; // mm/hr
    this.particleCount = options.particleCount || 500;
    this.simSpeed = options.simSpeed || 1.0;
    this.particles = [];
    this.pathCells = new Map(); // "lat,lon" -> { count, maxIntensity }
    this.sampleRadius = 0.00015; // ~15m in degrees for elevation sampling
    this.gridResolution = 5; // 5x5 grid for D8
  }

  setBurnSeverity(severity) {
    this.burnSeverity = severity;
  }

  setRainfallIntensity(mmPerHr) {
    this.rainfallIntensity = mmPerHr;
  }

  /**
   * Spawn particles at source location with slight random spread
   */
  async spawnParticles(centerLon, centerLat, centerHeight, getElevationAt) {
    this.particles = [];
    const factors = BURN_SEVERITY_FACTORS[this.burnSeverity];
    const spread = this.rainfallIntensity * 0.00001 * factors.runoffMultiplier;

    for (let i = 0; i < this.particleCount; i++) {
      const angle = (i / this.particleCount) * 2 * Math.PI + Math.random() * 0.5;
      const r = spread * (0.3 + Math.random() * 0.7);
      const lon = centerLon + (r * Math.cos(angle)) / Math.cos((centerLat * Math.PI) / 180);
      const lat = centerLat + r * Math.sin(angle);
      const height = getElevationAt ? await getElevationAt(lon, lat) : centerHeight;
      this.particles.push(new FloodParticle(lon, lat, height ?? centerHeight, i));
    }
  }

  /**
   * Sample elevation grid around a point for D8 flow direction
   */
  async sampleElevationGrid(lon, lat, getElevationAt) {
    const gridSize = this.gridResolution;
    const dLat = this.sampleRadius * 2 / (gridSize - 1);
    const dLon = (this.sampleRadius * 2 / Math.cos((lat * Math.PI) / 180)) / (gridSize - 1);
    const elevations = [];

    for (let r = 0; r < gridSize; r++) {
      for (let c = 0; c < gridSize; c++) {
        const sampleLon = lon + (c - (gridSize - 1) / 2) * dLon;
        const sampleLat = lat + (r - (gridSize - 1) / 2) * dLat;
        const h = await getElevationAt(sampleLon, sampleLat);
        elevations.push(h ?? 0);
      }
    }

    return elevations;
  }

  /**
   * Move particle one step using D8 flow direction and kinematic wave velocity
   */
  async stepParticle(particle, getElevationAt, dt) {
    if (!particle.active) return;

    const elevations = await this.sampleElevationGrid(particle.lon, particle.lat, getElevationAt);
    const centerIdx = Math.floor(this.gridResolution * this.gridResolution / 2);
    const { direction, slope } = computeD8FlowDirection(
      elevations,
      centerIdx,
      this.gridResolution
    );

    if (direction < 0) {
      particle.active = false; // Sink / no outflow
      return;
    }

    const velocity = kinematicWaveVelocity(slope, this.burnSeverity);
    const metersPerDegLat = METERS_PER_DEGREE_LAT;
    const metersPerDegLon = getMetersPerDegreeLon(particle.lat);

    const [dr, dc] = D8_OFFSETS[direction - 1];
    const moveDist = velocity * dt * this.simSpeed;
    const moveLat = (dr * moveDist) / metersPerDegLat;
    const moveLon = (dc * moveDist) / (metersPerDegLon * Math.cos((particle.lat * Math.PI) / 180));

    particle.lon += moveLon;
    particle.lat += moveLat;
    particle.height = await getElevationAt(particle.lon, particle.lat) ?? particle.height;
    particle.age += dt;
    particle.flowIntensity *= 0.998; // Slight decay

    particle.path.push({ lon: particle.lon, lat: particle.lat, height: particle.height });

    const key = `${particle.lat.toFixed(6)},${particle.lon.toFixed(6)}`;
    const existing = this.pathCells.get(key) || { count: 0, maxIntensity: 0 };
    existing.count += 1;
    existing.maxIntensity = Math.max(existing.maxIntensity, particle.flowIntensity);
    this.pathCells.set(key, existing);

    if (particle.path.length > 500) particle.active = false;
  }

  /**
   * Run one simulation step for all particles
   */
  async step(getElevationAt, dt = 0.1) {
    const stepPromises = this.particles
      .filter((p) => p.active)
      .map((p) => this.stepParticle(p, getElevationAt, dt));
    await Promise.all(stepPromises);
  }

  getActiveParticles() {
    return this.particles.filter((p) => p.active);
  }

  getAllParticles() {
    return this.particles;
  }

  getPathCells() {
    return this.pathCells;
  }

  clear() {
    this.particles = [];
    this.pathCells.clear();
  }
}
