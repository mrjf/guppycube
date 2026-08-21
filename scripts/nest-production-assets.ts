import { copyFile, mkdir, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";

const assetRoot = resolve(import.meta.dir, "../dist/client/client");
const deploymentRoot = resolve(assetRoot, "guppycube");

await mkdir(deploymentRoot, { recursive: true });
for (const entry of await readdir(assetRoot, { withFileTypes: true })) {
  if (entry.name === "guppycube" || entry.name === ".assetsignore") continue;
  if (entry.name === "index.html") {
    await copyFile(resolve(assetRoot, entry.name), resolve(deploymentRoot, entry.name));
    continue;
  }
  await rename(resolve(assetRoot, entry.name), resolve(deploymentRoot, entry.name));
}

console.log(JSON.stringify({ event: "production_assets_nested", path: deploymentRoot }));
