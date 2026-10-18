#!/usr/bin/env node
/* eslint no-console:0 */
"use strict";

// Downloads the Chromium clang that the prebuilt libwebrtc was built with and
// prints its bin directory. The libc++ headers that come with the prebuilt are
// from LLVM's main branch and need a recent clang (21+), which CI images do not
// always have.
//
// Usage: node scripts/download-chromium-clang.js <prebuilt dir>

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOSTS = {
  "darwin-arm64": "Mac_arm64",
  "darwin-x64": "Mac",
  "linux-x64": "Linux_x64",
  "win32-x64": "Win",
};

const GITILES = "https://chromium.googlesource.com";
const CDS = "https://commondatastorage.googleapis.com/chromium-browser-clang";

// On Windows, Git Bash's GNU tar reads "D:\..." as a remote host and cannot
// extract zip files, so use the bsdtar that ships with Windows.
const TAR =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

function readVersions(file) {
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => line.split("=", 2)),
  );
}

async function main() {
  const prebuiltDir = process.argv[2];
  if (!prebuiltDir) {
    throw new Error("Usage: download-chromium-clang.js <prebuilt dir>");
  }
  const host = HOSTS[`${os.platform()}-${os.arch()}`];
  if (!host) {
    throw new Error(`No Chromium clang for ${os.platform()}-${os.arch()}`);
  }

  const tools = readVersions(
    path.join(prebuiltDir, "VERSIONS"),
  ).WEBRTC_SRC_TOOLS_COMMIT;
  const response = await fetch(
    `${GITILES}/chromium/src/tools/+/${tools}/clang/scripts/update.py?format=TEXT`,
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch update.py: ${response.status}`);
  }
  const updatePy = Buffer.from(await response.text(), "base64").toString();
  const revision = updatePy.match(/^CLANG_REVISION = '([^']+)'/m)[1];
  const subRevision = updatePy.match(/^CLANG_SUB_REVISION = (\d+)/m)[1];
  const version = `${revision}-${subRevision}`;

  const dir = path.join(
    __dirname,
    "..",
    "third_party",
    "chromium-clang",
    version,
    host,
  );
  const bin = path.join(dir, "bin");
  if (!fs.existsSync(bin)) {
    const archive = path.join(os.tmpdir(), `clang-${version}-${host}.tar.xz`);
    const download = await fetch(`${CDS}/${host}/clang-${version}.tar.xz`);
    if (!download.ok) {
      throw new Error(`Failed to download clang: ${download.status}`);
    }
    fs.writeFileSync(archive, Buffer.from(await download.arrayBuffer()));
    fs.mkdirSync(dir, { recursive: true });
    const { status } = spawnSync(TAR, ["-xf", archive, "-C", dir], {
      stdio: "inherit",
    });
    if (status) {
      throw new Error(`tar failed with ${status}`);
    }
    fs.rmSync(archive);
  }
  console.log(bin);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
