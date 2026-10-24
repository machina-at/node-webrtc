"use strict";

// Child process side of a two-process peer pair: answers the parent's offer,
// then opens CHANNELS channels and streams PER numbered messages on each.
// Running the sender in another process keeps messages arriving while the
// receiver's JS thread is busy (as with a real remote peer).
const { RTCPeerConnection } = require("../..");

const CHANNELS = Number(process.argv[2]);
const PER = Number(process.argv[3]);

const pc = new RTCPeerConnection();
const pending = [];
pc.onicecandidate = (e) =>
  e.candidate && process.send({ candidate: e.candidate.toJSON() });

process.on("message", async (msg) => {
  if (msg.offer) {
    await pc.setRemoteDescription(msg.offer);
    pending.splice(0).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
    await pc.setLocalDescription(await pc.createAnswer());
    process.send({ answer: pc.localDescription.toJSON() });
  } else if (msg.candidate) {
    if (pc.remoteDescription) pc.addIceCandidate(msg.candidate).catch(() => {});
    else pending.push(msg.candidate);
  } else if (msg.start) {
    for (let i = 0; i < CHANNELS; i++) {
      const channel = pc.createDataChannel(`c${i}`);
      async function go() {
        for (let n = 0; n < PER; n++) {
          channel.send(String(n));
          if (n % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
        }
      }
      if (channel.readyState === "open") go();
      else channel.addEventListener("open", go);
    }
  } else if (msg.stop) {
    pc.close();
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  }
});
