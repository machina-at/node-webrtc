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

// googlesource.com and GitHub occasionally answer 5xx; retry those.
async function fetchWithRetry(url, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.status < 500 || attempt === attempts) {
      return response;
    }
    console.error(`GET ${url} returned ${response.status}, retrying`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
  }
}

function log(message) {
  console.error(
    `[download-chromium-clang ${new Date().toISOString()}] ${message}`,
  );
}

function run(command, args) {
  log(`${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: ["ignore", 2, 2] });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? result.signal}`,
    );
  }
}

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
  const response = await fetchWithRetry(
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
    const download = await fetchWithRetry(
      `${CDS}/${host}/clang-${version}.tar.xz`,
    );
    if (!download.ok) {
      throw new Error(`Failed to download clang: ${download.status}`);
    }
    log(`downloading clang ${version} for ${host}`);
    fs.writeFileSync(archive, Buffer.from(await download.arrayBuffer()));
    log(`downloaded ${fs.statSync(archive).size} bytes`);
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === "win32") {
      // Windows' tar.exe hangs on .tar.xz, so unpack the xz layer with 7-Zip
      // (present on GitHub's Windows runners) and let tar.exe read the .tar.
      run("7z", ["x", "-y", `-o${os.tmpdir()}`, archive]);
      const tarball = archive.replace(/\.xz$/, "");
      run(TAR, ["-xf", tarball, "-C", dir]);
      fs.rmSync(tarball);
    } else {
      run(TAR, ["-xf", archive, "-C", dir]);
    }
    log("extracted");
    fs.rmSync(archive);
  }
  console.log(bin);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
