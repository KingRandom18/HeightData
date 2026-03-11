import express from "express";
import dotenv from "dotenv";
import * as GeoTIFF from "geotiff";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const OPENTOPOGRAPHY_API_KEY = process.env.OPENTOPOGRAPHY_API_KEY;

if (!OPENTOPOGRAPHY_API_KEY) {
  throw new Error("Missing OPENTOPOGRAPHY_API_KEY in environment variables.");
}

const DEFAULT_POINTS_PER_KM = 10;

// Pick a DEM source.
// Good starter choice:
// SRTMGL3 = coarser global
// SRTMGL1 = finer where available
const DEFAULT_DEM = "SRTMGL1";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function metersPerDegreeLat() {
  return 111320;
}

function metersPerDegreeLon(lat) {
  return 111320 * Math.cos(degToRad(lat));
}

function makeBoundingBox(lat, lon, scaleKm) {
  const halfMeters = (scaleKm * 1000) / 2;
  const latDelta = halfMeters / metersPerDegreeLat();
  const lonDelta = halfMeters / metersPerDegreeLon(lat);

  return {
    south: lat - latDelta,
    north: lat + latDelta,
    west: lon - lonDelta,
    east: lon + lonDelta
  };
}

function buildOpenTopoUrl({ south, north, west, east, demType }) {
  const params = new URLSearchParams({
    demtype: demType,
    south: String(south),
    north: String(north),
    west: String(west),
    east: String(east),
    outputFormat: "GTiff",
    API_Key: OPENTOPOGRAPHY_API_KEY
  });

  return `https://portal.opentopography.org/API/globaldem?${params.toString()}`;
}

async function downloadGeoTiff(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`OpenTopography request failed: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return arrayBuffer;
}

async function sampleGeoTiff(arrayBuffer, sampleCount) {
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();

  const width = image.getWidth();
  const height = image.getHeight();

  const bbox = image.getBoundingBox(); // [minX, minY, maxX, maxY]
  const [minX, minY, maxX, maxY] = bbox;

  const rasters = await image.readRasters({ interleave: true });
  const noData = image.getGDALNoData();

  function getPixelValue(px, py) {
    const x = clamp(Math.floor(px), 0, width - 1);
    const y = clamp(Math.floor(py), 0, height - 1);
    const idx = y * width + x;

    const value = rasters[idx];

    if (value === undefined || value === null) return null;
    if (Number.isFinite(noData) && value === noData) return null;
    if (!Number.isFinite(value)) return null;

    return value;
  }

  const heights = [];

  for (let row = 0; row < sampleCount; row++) {
    const rowHeights = [];
    const ty = sampleCount === 1 ? 0 : row / (sampleCount - 1);

    // GeoTIFF bbox y increases upward, image row increases downward
    const geoY = maxY - (maxY - minY) * ty;
    const py = ((maxY - geoY) / (maxY - minY)) * (height - 1);

    for (let col = 0; col < sampleCount; col++) {
      const tx = sampleCount === 1 ? 0 : col / (sampleCount - 1);
      const geoX = minX + (maxX - minX) * tx;
      const px = ((geoX - minX) / (maxX - minX)) * (width - 1);

      let value = getPixelValue(px, py);

      // Very simple fallback for missing pixels:
      if (value === null) {
        const neighbors = [
          getPixelValue(px - 1, py),
          getPixelValue(px + 1, py),
          getPixelValue(px, py - 1),
          getPixelValue(px, py + 1)
        ].filter(v => v !== null);

        value = neighbors.length > 0
          ? neighbors.reduce((a, b) => a + b, 0) / neighbors.length
          : 0;
      }

      rowHeights.push(Math.round(value * 10) / 10);
    }

    heights.push(rowHeights);
  }

  return {
    imageWidth: width,
    imageHeight: height,
    tiffBounds: {
      minX,
      minY,
      maxX,
      maxY
    },
    heights
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "OpenTopography Roblox height API is running"
  });
});

app.get("/terrain", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const scale = Number(req.query.scale || 1);
    const pointsPerKm = Number(req.query.pointsPerKm || DEFAULT_POINTS_PER_KM);
    const demType = String(req.query.demType || DEFAULT_DEM);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "lat and lon must be valid numbers" });
    }

    if (!Number.isFinite(scale) || scale <= 0) {
      return res.status(400).json({ error: "scale must be a positive number" });
    }

    if (!Number.isFinite(pointsPerKm) || pointsPerKm <= 0) {
      return res.status(400).json({ error: "pointsPerKm must be a positive number" });
    }

    const safeLat = clamp(lat, -85, 85);
    const safeLon = ((lon + 180) % 360 + 360) % 360 - 180;
    const safeScale = clamp(scale, 0.25, 20);
    const safePointsPerKm = clamp(pointsPerKm, 2, 50);
    const sampleCount = Math.max(2, Math.round(safeScale * safePointsPerKm));

    const bbox = makeBoundingBox(safeLat, safeLon, safeScale);
    const url = buildOpenTopoUrl({
      ...bbox,
      demType
    });

    const geoTiffBuffer = await downloadGeoTiff(url);
    const sampled = await sampleGeoTiff(geoTiffBuffer, sampleCount);

    res.json({
      ok: true,
      center: {
        lat: safeLat,
        lon: safeLon
      },
      scaleKm: safeScale,
      pointsPerKm: safePointsPerKm,
      sampleCount,
      demType,
      bbox,
      heights: sampled.heights,
      sourceImage: {
        width: sampled.imageWidth,
        height: sampled.imageHeight
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: "Failed to generate terrain data",
      details: error.message
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
