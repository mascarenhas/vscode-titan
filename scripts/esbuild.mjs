import * as esbuild from "esbuild";
import { writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const buildContext = await esbuild.context({
  entryPoints: ["src/extension/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  logLevel: "info",
  metafile: true,
  minify: false,
  outfile: "dist/extension.js",
  platform: "node",
  sourcemap: true,
  sourcesContent: false,
  target: "node20"
});

if (watch) {
  await buildContext.watch();
} else {
  const result = await buildContext.rebuild();
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const marker = input.indexOf("node_modules/");
    if (marker < 0) continue;
    const components = input.slice(marker + "node_modules/".length).split("/");
    packages.add(
      components[0].startsWith("@")
        ? components.slice(0, 2).join("/")
        : components[0]
    );
  }
  await writeFile(
    "dist/bundled-packages.json",
    `${JSON.stringify([...packages].sort(), null, 2)}\n`,
    "utf8"
  );
  await buildContext.dispose();
}
