import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const origin = process.argv[2] || "http://127.0.0.1:49860";
const assetUrl = new URL("/main.js", origin);
const text = await fetch(assetUrl).then((response) => {
  if (!response.ok) throw new Error(`Unable to load ${assetUrl}: ${response.status}`);
  return response.text();
});
const recording = [
  {
    url: assetUrl.href,
    text,
    ranges: [{ start: 0, end: Math.max(1, Math.floor(text.length * 0.58)) }],
  },
];
const output = resolve(directory, "Coverage-browser.json");
await writeFile(output, `${JSON.stringify(recording)}\n`);
console.log(output);
