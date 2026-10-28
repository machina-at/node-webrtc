#!/usr/bin/env node
/* eslint no-console:0 */
"use strict";

// Publishes the tarballs that CI attached to a GitHub Release, so that what
// lands on npm is exactly what CI built and tested. Platform packages go first
// so that the main package's optionalDependencies resolve.
//
// Usage: node scripts/publish-npm.js <tag> [--dist-tag <tag>] [--dry-run]
//
// Needs `gh` (to download the release) and an npm login or NODE_AUTH_TOKEN with
// publish rights on @10p.io. Versions that are already on npm are skipped, so
// the script can be re-run after a partial failure.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const REPO = "machina-at/node-webrtc";
const REGISTRY = "https://registry.npmjs.org/";
const TRIPLES = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-x64"];

function parseArgs(argv) {
  const args = { tag: null, distTag: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dist-tag") {
      args.distTag = argv[++i];
    } else if (argv[i] === "--dry-run") {
      args.dryRun = true;
    } else {
      args.tag = argv[i];
    }
  }
  if (!args.tag) {
    throw new Error(
      "Usage: publish-npm.js <tag> [--dist-tag <tag>] [--dry-run]",
    );
  }
  return args;
}

function isPublished(name, version) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--registry", REGISTRY],
    { encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim() === version;
}

function main() {
  const { tag, distTag, dryRun } = parseArgs(process.argv.slice(2));
  const version = tag.replace(/^v/, "");
  // x.y.z and x.y.z-m<milestone>.<n> (a libwebrtc milestone build) are
  // releases; any other prerelease goes to "next".
  const npmTag =
    distTag ?? (/^\d+\.\d+\.\d+(-m\d+\.\d+)?$/.test(version) ? "latest" : "next");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrtc-publish-"));
  execFileSync(
    "gh",
    [
      "release",
      "download",
      tag,
      "--repo",
      REPO,
      "--pattern",
      "*.tgz",
      "--dir",
      dir,
    ],
    { stdio: "inherit" },
  );

  const packages = [
    ...TRIPLES.map((triple) => [
      `@10p.io/wrtc-${triple}`,
      `10p.io-wrtc-${triple}-${version}.tgz`,
    ]),
    ["@10p.io/wrtc", `10p.io-wrtc-${version}.tgz`],
  ];
  for (const [, file] of packages) {
    if (!fs.existsSync(path.join(dir, file))) {
      throw new Error(`${file} is missing from release ${tag}`);
    }
  }

  for (const [name, file] of packages) {
    if (isPublished(name, version)) {
      console.log(`skip ${name}@${version} (already published)`);
      continue;
    }
    console.log(`publish ${name}@${version} --tag ${npmTag}`);
    execFileSync(
      "npm",
      [
        "publish",
        path.join(dir, file),
        "--access",
        "public",
        "--tag",
        npmTag,
        "--registry",
        REGISTRY,
        ...(dryRun ? ["--dry-run"] : []),
      ],
      { stdio: "inherit" },
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

main();
