import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const iosRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(join(iosRoot, "Design", "AppIcon.svg"));
const outputDirectory = join(
  iosRoot,
  "Guppycube",
  "Resources",
  "Assets.xcassets",
  "AppIcon.appiconset",
);

const icons = [
  ["AppIcon-20.png", 20],
  ["AppIcon-20@2x.png", 40],
  ["AppIcon-20@3x.png", 60],
  ["AppIcon-29.png", 29],
  ["AppIcon-29@2x.png", 58],
  ["AppIcon-29@3x.png", 87],
  ["AppIcon-40.png", 40],
  ["AppIcon-40@2x.png", 80],
  ["AppIcon-40@3x.png", 120],
  ["AppIcon-60@2x.png", 120],
  ["AppIcon-60@3x.png", 180],
  ["AppIcon-76@2x.png", 152],
  ["AppIcon-83.5@2x.png", 167],
  ["AppIcon-1024.png", 1024],
];

await Promise.all(icons.map(async ([filename, size]) => {
  await sharp(source)
    .resize(size, size)
    .flatten({ background: "#ed5b3a" })
    .png({ compressionLevel: 9 })
    .toFile(join(outputDirectory, filename));
}));

await writeFile(join(outputDirectory, ".generated"), "Generated from ios/Design/AppIcon.svg\n");
