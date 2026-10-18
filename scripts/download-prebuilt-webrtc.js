#!/usr/bin/env node
/* eslint no-console:0, no-process-env:0 */
"use strict";

// Downloads a prebuilt libwebrtc from shiguredo-webrtc-build/webrtc-build and
// lays it out the way CMakeLists.txt expects when LIBWEBRTC_PREBUILT_DIR is
// set:
//
//   <dir>/webrtc/...        headers (so that <webrtc/api/...> resolves)
//   <dir>/lib/libwebrtc.a   (webrtc.lib on Windows)
//   <dir>/libc++/include    libc++ headers at the commit libwebrtc used
//   <dir>/libc++abi/include
//   <dir>/libc++/__config_site, <dir>/libc++/__assertion_handler
//
// The prebuilt archive only ships "*.h" files, so the extension-less libc++
// headers and Chromium's libc++ configuration headers are fetched separately
// at the commits recorded in its VERSIONS file.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { platform, arch } = require("./build-vars.js");

const RELEASE = "m155.8059.4.1";
const REPO = "shiguredo-webrtc-build/webrtc-build";

const ASSETS = {
  "darwin-arm64": "webrtc.macos_arm64.tar.gz",
  "linux-x64": "webrtc.ubuntu-22.04_x86_64.tar.gz",
  "linux-arm64": "webrtc.ubuntu-22.04_armv8.tar.gz",
  "win32-x64": "webrtc.windows_x86_64.zip",
  "win32-arm64": "webrtc.windows_arm64.zip",
};

const GITILES = "https://chromium.googlesource.com";

// On Windows, Git Bash's GNU tar reads "D:\..." as a remote host and cannot
// extract zip files, so use the bsdtar that ships with Windows.
const TAR =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

function run(command, args, options = {}) {
  const { status } = spawnSync(command, args, { stdio: "inherit", ...options });
  if (status) {
    throw new Error(`${command} ${args.join(" ")} failed with ${status}`);
  }
}

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed with ${response.status}`);
  }
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

async function downloadArchive(url, dir) {
  const file = path.join(
    os.tmpdir(),
    `wrtc-${process.pid}-${path.basename(dir)}.tar.gz`,
  );
  await download(url, file);
  fs.mkdirSync(dir, { recursive: true });
  run(TAR, ["-xzf", file, "-C", dir]);
  fs.rmSync(file);
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
  const triple = `${platform}-${arch}`;
  const asset = ASSETS[triple];
  if (!asset) {
    throw new Error(`No prebuilt libwebrtc for ${triple}`);
  }

  const dir = path.resolve(
    process.argv[2] ??
      path.join(
        __dirname,
        "..",
        "third_party",
        "webrtc-prebuilt",
        RELEASE,
        triple,
      ),
  );
  if (fs.existsSync(path.join(dir, "VERSIONS"))) {
    console.log(dir);
    return;
  }

  const work = `${dir}.partial`;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const archive = path.join(work, asset);
  await download(
    `https://github.com/${REPO}/releases/download/${RELEASE}/${asset}`,
    archive,
  );
  run(TAR, ["-xf", archive, "-C", work]);
  fs.rmSync(archive);

  // webrtc/include -> webrtc, webrtc/lib -> lib
  const extracted = path.join(work, "webrtc");
  fs.renameSync(path.join(extracted, "include"), path.join(work, "include"));
  fs.renameSync(path.join(extracted, "lib"), path.join(work, "lib"));
  fs.renameSync(path.join(extracted, "VERSIONS"), path.join(work, "VERSIONS"));
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.renameSync(path.join(work, "include"), path.join(work, "webrtc"));

  const versions = readVersions(path.join(work, "VERSIONS"));
  const libcxx = versions.WEBRTC_SRC_THIRD_PARTY_LIBCXX_SRC_COMMIT;
  const libcxxabi = versions.WEBRTC_SRC_THIRD_PARTY_LIBCXXABI_SRC_COMMIT;
  const buildtools = versions.WEBRTC_SRC_BUILDTOOLS_COMMIT;

  await downloadArchive(
    `${GITILES}/external/github.com/llvm/llvm-project/libcxx.git/+archive/${libcxx}/include.tar.gz`,
    path.join(work, "libc++", "include"),
  );
  await downloadArchive(
    `${GITILES}/external/github.com/llvm/llvm-project/libcxxabi.git/+archive/${libcxxabi}/include.tar.gz`,
    path.join(work, "libc++abi", "include"),
  );
  for (const name of ["__config_site", "__assertion_handler"]) {
    const response = await fetch(
      `${GITILES}/chromium/src/buildtools/+/${buildtools}/third_party/libc++/${name}?format=TEXT`,
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch ${name}: ${response.status}`);
    }
    fs.writeFileSync(
      path.join(work, "libc++", name),
      Buffer.from(await response.text(), "base64"),
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(work, dir);
  console.log(dir);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
