import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const staticDirectory = join(directory, "dist", "static");
const mainAsset = (await readdir(staticDirectory)).find(
  (file) => file.startsWith("main.") && file.endsWith(".js"),
);
if (!mainAsset) throw new Error("Build the basic fixture before creating Coverage JSON.");

const text = await readFile(join(staticDirectory, mainAsset), "utf8");
const coverage = [
  {
    url: `http://127.0.0.1:49920/static/${mainAsset}`,
    text,
    ranges: [{ start: 0, end: Math.floor(text.length * 0.55) }],
  },
];

const output = join(directory, "Coverage-fixture.json");
await writeFile(output, JSON.stringify(coverage), "utf8");
console.log(output);
