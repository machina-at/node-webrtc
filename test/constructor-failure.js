"use strict";

const test = require("tape");
const { spawnSync } = require("child_process");

// A constructor that throws (invalid configuration) used to leave its
// uv_async_t registered in the event loop after the object was deleted: the
// process never exited and libuv held a dangling handle.
const CONFIGS = [
  { iceTransportPolicy: "bogus" },
  { iceServers: [{ urls: "turns:x:1", tlsCertPolicy: "bogus" }] },
];

CONFIGS.forEach((config) => {
  test(`the process exits after new RTCPeerConnection(${JSON.stringify(config)}) throws`, (t) => {
    const script = `
      const { RTCPeerConnection } = require(${JSON.stringify(require.resolve(".."))});
      let threw = false;
      for (let i = 0; i < 20; i++) {
        try { new RTCPeerConnection(${JSON.stringify(config)}); } catch (e) { threw = true; }
      }
      if (global.gc) global.gc();
      console.log(threw ? "threw" : "did not throw");
    `;
    const result = spawnSync(process.execPath, ["--expose-gc", "-e", script], {
      encoding: "utf8",
      timeout: 15000,
      killSignal: "SIGKILL",
    });
    t.equal(result.stdout.trim(), "threw", "the constructor threw");
    t.equal(result.signal, null, `the process exited on its own (signal=${result.signal})`);
    t.equal(result.status, 0, `exit code 0 (${result.status})`);
    t.end();
  });
});
