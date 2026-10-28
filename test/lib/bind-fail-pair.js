"use strict";

// Child process for the bind-failure test: with bindSocketsToInterface on and
// every bind attempt failing (NODE_WEBRTC_TEST_BIND_FAIL), a pair must still
// connect and carry data over plainly bound sockets.
const { nonstandard } = require("../..");
const { connectedPair, until, whenOpen } = require("./pair");

async function main() {
  nonstandard.setNetworkOptions({ bindSocketsToInterface: true });
  const { a, b } = await connectedPair();
  const channel = a.createDataChannel("fallback");
  let got = null;
  b.ondatachannel = ({ channel: remote }) => {
    remote.onmessage = ({ data }) => {
      got = data;
    };
  };
  await whenOpen(channel);
  channel.send("hello");
  await until(() => got === "hello", 10000, "message").catch(() => {});
  const stats = nonstandard.getNetworkBindingStats();
  a.close();
  b.close();
  console.log(JSON.stringify({ got, ...stats }));
}

main().catch((error) => {
  console.log(JSON.stringify({ error: String(error) }));
});
