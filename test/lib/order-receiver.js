"use strict";

// Receiver side of the hand-off ordering test (B1). Forks remote-sender.js,
// blocks its own JS thread for SPIN_MS right after asking the sender to start
// (so the observer caches messages), and prints how many channels saw their
// messages out of order. Run with NODE_WEBRTC_TEST_ADOPT_DELAY_MS set.
const path = require("path");
const { fork } = require("child_process");
const { RTCPeerConnection } = require("../..");

const CHANNELS = Number(process.argv[2]);
const PER = Number(process.argv[3]);
const SPIN_MS = Number(process.argv[4]);

const child = fork(path.join(__dirname, "remote-sender.js"), [
  String(CHANNELS),
  String(PER),
]);
const pc = new RTCPeerConnection();
const pending = [];
pc.onicecandidate = (e) =>
  e.candidate && child.send({ candidate: e.candidate.toJSON() });
const got = new Map();
pc.ondatachannel = ({ channel }) => {
  const seen = [];
  got.set(channel.label, seen);
  channel.onmessage = ({ data }) => seen.push(Number(data));
};
child.on("message", async (msg) => {
  if (msg.answer) {
    await pc.setRemoteDescription(msg.answer);
    pending.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
  } else if (msg.candidate) {
    if (pc.remoteDescription) pc.addIceCandidate(msg.candidate).catch(() => {});
    else pending.push(msg.candidate);
  }
});
const boot = pc.createDataChannel("boot");
boot.onopen = () => {
  child.send({ start: true });
  const until = Date.now() + SPIN_MS;
  while (Date.now() < until) {
    // Keep the JS thread busy while messages arrive.
  }
};
(async () => {
  await pc.setLocalDescription(await pc.createOffer());
  child.send({ offer: pc.localDescription.toJSON() });
  const start = Date.now();
  function done() {
    return (
      got.size === CHANNELS &&
      [...got.values()].every((seen) => seen.length === PER)
    );
  }
  while (!done() && Date.now() - start < 60000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const reordered = [...got.values()].filter((seen) =>
    seen.some((n, i) => n !== i),
  ).length;
  console.log(JSON.stringify({ complete: done(), reordered }));
  child.send({ stop: true });
  pc.close();
  // eslint-disable-next-line no-process-exit
  setTimeout(() => process.exit(0), 200);
})();
