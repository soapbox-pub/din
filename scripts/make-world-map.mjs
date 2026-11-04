/**
 * Writes src/lib/worldMap.ts, the land Settings → Date & Time draws its time
 * zone map with, from world-atlas's land-110m.json (Natural Earth's 1:110m
 * land, public domain; https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json).
 *
 * The map is equirectangular, in tenths of a degree: x is ten times the
 * longitude plus 180, y ten times 90 less the latitude, so a point's place is
 * plain arithmetic, both ways. The path is relative, to keep it small.
 *
 *   node scripts/make-world-map.mjs land-110m.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/make-world-map.mjs land-110m.json");
  process.exit(1);
}
const topology = JSON.parse(readFileSync(input, "utf8"));
const [sx, sy] = topology.transform.scale;
const [tx, ty] = topology.transform.translate;

// TopoJSON's arcs, delta-encoded and quantized, as [lon, lat] points.
const arcs = topology.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [x * sx + tx, y * sy + ty];
  });
});

function ring(indices) {
  const points = [];
  for (const index of indices) {
    const arc = index < 0 ? [...arcs[~index]].reverse() : arcs[index];
    // Each arc starts where the last ended.
    points.push(...(points.length ? arc.slice(1) : arc));
  }
  return points;
}

let path = "";
const geometries = topology.objects.land.geometries ?? [topology.objects.land];
for (const geometry of geometries) {
  const polygons = geometry.type === "Polygon" ? [geometry.arcs] : geometry.arcs;
  for (const polygon of polygons) {
    for (const indices of polygon) {
      // Land across the 180th meridian (Russia's east, Fiji) is unwrapped
      // into one piece, then drawn again a world over, so each side shows.
      const points = [];
      let shift = 0;
      for (const [lon, lat] of ring(indices)) {
        const previous = points.at(-1);
        let x = (lon + 180) * 10 + shift;
        if (previous && x - previous[0] > 1800) shift -= 3600;
        if (previous && x - previous[0] < -1800) shift += 3600;
        x = (lon + 180) * 10 + shift;
        points.push([x, (90 - lat) * 10]);
      }
      let d = "";
      let x0 = 0;
      let y0 = 0;
      let minX = Infinity;
      let maxX = -Infinity;
      for (const [fx, fy] of points) {
        const x = Math.round(fx);
        const y = Math.round(fy);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        if (!d) d = `l`;
        else if (x !== x0 || y !== y0) d += `${x - x0}${y - y0 < 0 ? "" : " "}${y - y0} `;
        else continue;
        x0 = x;
        y0 = y;
      }
      // Antarctica is below the map's edge (TimeZoneMap's BOTTOM, 56°S).
      if (Math.min(...points.map(([, y]) => y)) > 1460) continue;
      const [sx0, sy0] = points[0].map(Math.round);
      const offsets = [0];
      if (minX < 0) offsets.push(3600);
      if (maxX > 3600) offsets.push(-3600);
      for (const offset of offsets) path += `M${sx0 + offset} ${sy0}${d.trimEnd()}z`;
    }
  }
}

writeFileSync(
  join(root, "src/lib/worldMap.ts"),
  `// Made by scripts/make-world-map.mjs from Natural Earth's 1:110m land
// (public domain). Equirectangular, in tenths of a degree:
// x = 10 × (longitude + 180), y = 10 × (90 − latitude).
export const WORLD_LAND_PATH =
  ${JSON.stringify(path)};
`,
);
