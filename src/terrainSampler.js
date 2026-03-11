/**
 * Terrain elevation sampling for Cesium viewer
 * Samples height from the 3D globe at given lon/lat
 */

export function createTerrainSampler(viewer) {
  const scene = viewer.scene;
  const globe = scene.globe;

  return function getElevationAt(longitude, latitude) {
    return new Promise((resolve) => {
      const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
      const positions = [cartographic];

      Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions)
        .then((updatedPositions) => {
          if (updatedPositions?.[0] != null) {
            resolve(updatedPositions[0].height);
          } else {
            resolve(globe.getHeight(cartographic) ?? 0);
          }
        })
        .catch(() => {
          resolve(globe.getHeight(cartographic) ?? 0);
        });
    });
  };
}
