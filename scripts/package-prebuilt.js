#!/usr/bin/env node
/* eslint no-console:0 */
"use strict";

// Packs the built addon for distribution outside the npm registry.
//
//   node scripts/package-prebuilt.js platform <version> <out dir>
//     Copies this platform's wrtc.node into prebuilds/<platform>-<arch>/ and
//     packs that directory as @roamhq/wrtc-<platform>-<arch>.
//
//   node scripts/package-prebuilt.js bundle <version> <out dir>
//     Packs @roamhq/wrtc with every prebuilds/*/wrtc.node inside it, so that it
//     can be installed from a tarball URL without the per-platform packages
//     (which would otherwise be fetched from npm at the upstream version).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { platform, arch, buildFolder } = require("./build-vars.js");

const root = path.join(__dirname, "..");

function npmPack(dir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(
    npm,
    ["pack", dir, "--pack-destination", outDir, "--ignore-scripts"],
    { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
  );
  return output.trim().split(/\r?\n/).pop();
}

function packPlatform(version, outDir) {
  const triple = `${platform}-${arch}`;
  const candidates = [
    path.join(root, buildFolder, "Release", "wrtc.node"),
    path.join(root, buildFolder, "wrtc.node"),
  ];
  const binary = candidates.find((candidate) => fs.existsSync(candidate));
  if (!binary) {
    throw new Error(`wrtc.node not found in ${candidates}`);
  }

  const dir = path.join(root, "prebuilds", triple);
  fs.copyFileSync(binary, path.join(dir, "wrtc.node"));
  const packageFile = path.join(dir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  pkg.version = version;
  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);

  console.log(npmPack(`./${path.relative(root, dir)}`, outDir));
}

function packBundle(version, outDir) {
  const triples = fs
    .readdirSync(path.join(root, "prebuilds"))
    .filter((triple) =>
      fs.existsSync(path.join(root, "prebuilds", triple, "wrtc.node")),
    );
  if (!triples.length) {
    throw new Error("No prebuilds/*/wrtc.node to bundle");
  }

  const packageFile = path.join(root, "package.json");
  const original = fs.readFileSync(packageFile, "utf8");
  const pkg = JSON.parse(original);
  pkg.version = version;
  pkg.files = [...pkg.files, ...triples.map((triple) => `prebuilds/${triple}`)];
  for (const name of Object.keys(pkg.optionalDependencies)) {
    if (name.startsWith("@roamhq/wrtc-")) {
      delete pkg.optionalDependencies[name];
    }
  }
  delete pkg.scripts.prepare;

  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  try {
    console.log(`bundled: ${triples.join(", ")}`);
    console.log(npmPack("./", outDir));
  } finally {
    fs.writeFileSync(packageFile, original);
  }
}

const [mode, version, outDir] = process.argv.slice(2);
if (!["platform", "bundle"].includes(mode) || !version || !outDir) {
  throw new Error(
    "Usage: package-prebuilt.js <platform|bundle> <version> <out dir>",
  );
}
(mode === "platform" ? packPlatform : packBundle)(
  version,
  path.resolve(outDir),
);
