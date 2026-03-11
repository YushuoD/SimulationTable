const EARTH_RADIUS_METERS = 6378137;
const TERRARIUM_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function offsetLngLat(center, eastMeters, northMeters) {
  const latRadians = (center.lat * Math.PI) / 180;
  const deltaLat = northMeters / EARTH_RADIUS_METERS;
  const deltaLng = eastMeters / (EARTH_RADIUS_METERS * Math.cos(latRadians));

  return {
    lat: center.lat + (deltaLat * 180) / Math.PI,
    lng: center.lng + (deltaLng * 180) / Math.PI,
  };
}

export function haversineMeters(a, b) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const c =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
}

export function estimateZoomForExtent(lat, extentMeters, resolution) {
  const desiredMetersPerPixel = extentMeters / resolution;
  const zoom =
    Math.log2(
      (156543.03392 * Math.cos((lat * Math.PI) / 180)) /
        Math.max(desiredMetersPerPixel, 1),
    ) + 0.5;

  return clamp(Math.round(zoom), 10, 13);
}

function lngLatToTile(lng, lat, zoom) {
  const scale = 2 ** zoom;
  const latRadians = (lat * Math.PI) / 180;
  const x = ((lng + 180) / 360) * scale;
  const y =
    ((1 -
      Math.log(
        Math.tan(latRadians) + 1 / Math.cos(latRadians),
      ) /
        Math.PI) /
      2) *
    scale;

  return { x, y };
}

function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

async function imageToImageData(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height);
}

export class TerrainSampler {
  constructor() {
    this.cache = new Map();
  }

  async fetchTile(z, x, y) {
    const scale = 2 ** z;
    const wrappedX = ((x % scale) + scale) % scale;
    const clampedY = clamp(y, 0, scale - 1);
    const key = tileKey(z, wrappedX, clampedY);

    if (!this.cache.has(key)) {
      const url = TERRARIUM_URL
        .replace("{z}", String(z))
        .replace("{x}", String(wrappedX))
        .replace("{y}", String(clampedY));

      const tilePromise = new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = async () => {
          try {
            const imageData = await imageToImageData(image);
            resolve(imageData);
          } catch (error) {
            reject(error);
          }
        };
        image.onerror = () =>
          reject(new Error(`Unable to load terrain tile ${key}`));
        image.src = url;
      });

      this.cache.set(key, tilePromise);
    }

    return this.cache.get(key);
  }

  async heightAt(lng, lat, zoom) {
    const coordinates = lngLatToTile(lng, lat, zoom);
    const tileX = Math.floor(coordinates.x);
    const tileY = Math.floor(coordinates.y);
    const tile = await this.fetchTile(zoom, tileX, tileY);
    const pixelX = clamp(Math.floor((coordinates.x - tileX) * 256), 0, 255);
    const pixelY = clamp(Math.floor((coordinates.y - tileY) * 256), 0, 255);
    const offset = (pixelY * 256 + pixelX) * 4;

    return decodeTerrarium(
      tile.data[offset],
      tile.data[offset + 1],
      tile.data[offset + 2],
    );
  }

  async sampleGrid({
    center,
    extentMeters,
    resolution = 80,
    zoom = estimateZoomForExtent(center.lat, extentMeters, resolution),
  }) {
    const halfExtent = extentMeters / 2;
    const cellSizeMeters = extentMeters / resolution;
    const lngEdges = new Float64Array(resolution + 1);
    const latEdges = new Float64Array(resolution + 1);

    for (let i = 0; i <= resolution; i += 1) {
      const eastOffset = -halfExtent + i * cellSizeMeters;
      const northOffset = halfExtent - i * cellSizeMeters;
      lngEdges[i] = offsetLngLat(center, eastOffset, 0).lng;
      latEdges[i] = offsetLngLat(center, 0, northOffset).lat;
    }

    const cornerSamples = [
      { lng: lngEdges[0], lat: latEdges[0] },
      { lng: lngEdges[resolution], lat: latEdges[0] },
      { lng: lngEdges[0], lat: latEdges[resolution] },
      { lng: lngEdges[resolution], lat: latEdges[resolution] },
    ].map(({ lng, lat }) => lngLatToTile(lng, lat, zoom));

    const minX = Math.floor(Math.min(...cornerSamples.map((sample) => sample.x)));
    const maxX = Math.floor(Math.max(...cornerSamples.map((sample) => sample.x)));
    const minY = Math.floor(Math.min(...cornerSamples.map((sample) => sample.y)));
    const maxY = Math.floor(Math.max(...cornerSamples.map((sample) => sample.y)));

    const tileLoads = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        tileLoads.push(this.fetchTile(zoom, x, y));
      }
    }
    await Promise.all(tileLoads);

    const heights = new Float32Array(resolution * resolution);
    const lngCenters = new Float64Array(resolution);
    const latCenters = new Float64Array(resolution);

    for (let i = 0; i < resolution; i += 1) {
      lngCenters[i] = (lngEdges[i] + lngEdges[i + 1]) / 2;
      latCenters[i] = (latEdges[i] + latEdges[i + 1]) / 2;
    }

    const centerIndex = Math.floor(resolution / 2);
    const eastPoint = { lng: lngCenters[centerIndex + 1], lat: center.lat };
    const westPoint = { lng: lngCenters[centerIndex], lat: center.lat };
    const northPoint = { lng: center.lng, lat: latCenters[centerIndex - 1] };
    const southPoint = { lng: center.lng, lat: latCenters[centerIndex] };

    const localDxMeters = haversineMeters(westPoint, eastPoint);
    const localDyMeters = haversineMeters(southPoint, northPoint);

    for (let row = 0; row < resolution; row += 1) {
      for (let column = 0; column < resolution; column += 1) {
        heights[row * resolution + column] = await this.heightAt(
          lngCenters[column],
          latCenters[row],
          zoom,
        );
      }
    }

    return {
      center,
      extentMeters,
      cellSizeMeters,
      resolution,
      zoom,
      heights,
      lngEdges,
      latEdges,
      lngCenters,
      latCenters,
      localDxMeters,
      localDyMeters,
      index(row, column) {
        return row * resolution + column;
      },
      height(row, column) {
        return heights[row * resolution + column];
      },
      point(row, column) {
        return {
          lng: lngCenters[column],
          lat: latCenters[row],
        };
      },
    };
  }
}
