#!/usr/bin/env node
/* eslint no-console:0 */
"use strict";

// Packs the built addon. CI runs this and attaches the tarballs to a GitHub
// Release; scripts/publish-npm.js publishes the platform and main ones.
//
//   node scripts/package-prebuilt.js platform <version> <out dir>
//     Copies this platform's wrtc.node into prebuilds/<platform>-<arch>/ and
//     packs that directory as @10p.io/wrtc-<platform>-<arch>.
//
//   node scripts/package-prebuilt.js main <version> <out dir>
//     Packs @10p.io/wrtc for npm. It carries no binary and depends on the
//     platform packages of the same version.
//
//   node scripts/package-prebuilt.js bundle <version> <out dir>
//     Packs @10p.io/wrtc with every prebuilds/*/wrtc.node inside it, so that it
//     can be installed from a tarball URL without the npm registry.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { platform, arch, buildFolder } = require("./build-vars.js");

const root = path.join(__dirname, "..");
const PLATFORM_PREFIX = "@10p.io/wrtc-";

function npmPack(dir, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(
    npm,
    ["pack", dir, "--pack-destination", outDir, "--ignore-scripts"],
    { cwd: root, encoding: "utf8", shell: process.platform === "win32" },
  );
  return path.join(outDir, output.trim().split(/\r?\n/).pop());
}

// Rewrites package.json for the duration of `pack`, then restores it.
function withPackageJson(edit, pack) {
  const packageFile = path.join(root, "package.json");
  const original = fs.readFileSync(packageFile, "utf8");
  const pkg = JSON.parse(original);
  edit(pkg);
  delete pkg.scripts.prepare;
  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  try {
    return pack();
  } finally {
    fs.writeFileSync(packageFile, original);
  }
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

function packMain(version, outDir) {
  const tarball = withPackageJson(
    (pkg) => {
      pkg.version = version;
      for (const name of Object.keys(pkg.optionalDependencies)) {
        if (name.startsWith(PLATFORM_PREFIX)) {
          pkg.optionalDependencies[name] = version;
        }
      }
    },
    () => npmPack("./", outDir),
  );
  console.log(tarball);
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

  // `npm pack` names both this and the main tarball after the package, so
  // pack into a scratch directory and rename.
  const scratch = path.join(outDir, ".bundle");
  const tarball = withPackageJson(
    (pkg) => {
      pkg.version = version;
      pkg.files = [
        ...pkg.files,
        ...triples.map((triple) => `prebuilds/${triple}`),
      ];
      for (const name of Object.keys(pkg.optionalDependencies)) {
        if (name.startsWith(PLATFORM_PREFIX)) {
          delete pkg.optionalDependencies[name];
        }
      }
    },
    () => npmPack("./", scratch),
  );
  const bundle = path.join(
    outDir,
    path.basename(tarball).replace(/\.tgz$/, "-bundle.tgz"),
  );
  fs.renameSync(tarball, bundle);
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`bundled ${triples.join(", ")}: ${bundle}`);
}

const MODES = { platform: packPlatform, main: packMain, bundle: packBundle };
const [mode, version, outDir] = process.argv.slice(2);
if (!MODES[mode] || !version || !outDir) {
  throw new Error(
    "Usage: package-prebuilt.js <platform|main|bundle> <version> <out dir>",
  );
}
MODES[mode](version, path.resolve(outDir));
