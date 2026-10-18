"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const test = require("tape");

// libwebrtc used select() on macOS until M126. Once a socket got a descriptor
// >= FD_SETSIZE (1024), select() failed and the worker thread exited, which
// left every later proxy call blocked forever.
const child = `
const fs = require("fs");
const { negotiateRTCPeerConnections } = require(${JSON.stringify(path.join(__dirname, "lib", "pc"))});
for (let i = 0; i < Number(process.argv[1]); i++) {
  try { fs.openSync("/dev/null", "r"); } catch (error) {
    if (error.code === "EMFILE") { console.log("SKIP"); process.exit(0); }
    throw error;
  }
}
(async () => {
  let dc1;
  const received = new Promise((resolve) => {
    negotiateRTCPeerConnections({
      withPc1(pc1) {
        dc1 = pc1.createDataChannel("x");
        dc1.onopen = () => dc1.send("hello");
      },
      withPc2(pc2) {
        pc2.ondatachannel = ({ channel }) => {
          channel.onmessage = ({ data }) => resolve(data);
        };
      },
    }).then(([pc1, pc2]) => received.then(() => { pc1.close(); pc2.close(); }));
  });
  console.log(await received);
  process.exit(0);
})();
`;

test("a data channel works when descriptors exceed FD_SETSIZE", (t) => {
  const result = spawnSync(process.execPath, ["-e", child, "1100"], {
    encoding: "utf8",
    timeout: 60000,
    killSignal: "SIGKILL",
  });
  if (result.stdout.includes("SKIP")) {
    t.skip("the file descriptor limit is below 1100");
    t.end();
    return;
  }
  if (result.signal !== null || result.stdout.trim() !== "hello") {
    t.comment(`child: ${result.error} stderr=${result.stderr.slice(0, 500)}`);
  }
  t.equal(result.signal, null, "the process did not hang");
  t.equal(result.stdout.trim(), "hello", "the message arrived");
  t.end();
});
