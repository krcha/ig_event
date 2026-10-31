// Natural Earth 1:110m administrative boundaries, public domain.
// Input: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
// Usage: node scripts/build-analytics-world-map.mjs /path/to/ne_110m_admin_0_countries.geojson
import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync(process.argv[2], "utf8"));
function ringPath(ring) {
  return ring.map(([longitude, latitude], index) => `${index ? "L" : "M"}${((longitude + 180) * 2).toFixed(1)},${((85 - latitude) * 2).toFixed(1)}`).join("") + "Z";
}
const countries = data.features.filter((feature) => feature.properties.NAME !== "Antarctica").map((feature) => {
  const polygons = feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const iso = feature.properties.ISO_A2_EH;
  return {
    code: iso === "-99" ? feature.properties.ADM0_A3 : iso,
    name: feature.properties.NAME,
    path: polygons.map((polygon) => polygon.map(ringPath).join("")).join(""),
  };
});
writeFileSync("lib/analytics/world-map.json", JSON.stringify(countries) + "\n");
console.log(`Generated ${countries.length} country outlines.`);
