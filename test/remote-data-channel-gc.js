"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const test = require("tape");

// OnDataChannel runs on the signaling thread. DataChannelObserver used to take
// a RefPtr<PeerConnectionFactory> there, i.e. call napi_reference_ref off the
// main thread, racing with the main thread's Ref()/Unref() (GC finalizers of
// RTCDataChannel). The factory's reference count then went wrong: one way it
// was released while channels still used it (SIGSEGV in ~RTCDataChannel on
// macOS), the other way Unref() hit zero and threw inside a destructor
// (std::terminate -> SIGABRT on Linux). Remote-created channels plus a busy
// GC make the race likely; it is still a race, so run a few children.
const child = `
const { RTCPeerConnection } = require(${JSON.stringify(path.join(__dirname, ".."))});
const ROUNDS = Number(process.argv[1]);
const PER = Number(process.argv[2]);
async function pair() {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
  let received = 0;
  b.ondatachannel = ({ channel }) => { received++; channel.close(); };
  const boot = a.createDataChannel("boot");
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  await new Promise((resolve) => { boot.onopen = resolve; });
  return { a, b, received: () => received };
}
(async () => {
  const gc = setInterval(() => global.gc(), 1);
  for (let r = 0; r < ROUNDS; r++) {
    const p = await pair();
    for (let i = 0; i < PER; i++) {
      const channel = p.a.createDataChannel("c" + i);
      channel.onopen = () => channel.close();
      if (i % 20 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const start = Date.now();
    while (p.received() < PER && Date.now() - start < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    console.log("round " + r + " received " + p.received() + "/" + PER + " in " + (Date.now() - start) + "ms");
    p.a.close();
    p.b.close();
  }
  clearInterval(gc);
  console.log("DONE");
  process.exit(0);
})();
`;

test("remote data channels collected by GC do not crash the process", (t) => {
  for (let run = 0; run < 3; run++) {
    const result = spawnSync(
      process.execPath,
      ["--expose-gc", "-e", child, "30", "200"],
      { encoding: "utf8", timeout: 180000, killSignal: "SIGKILL" },
    );
    const lines = result.stdout.trim().split("\n");
    if (result.signal !== null || lines.at(-1) !== "DONE") {
      t.comment(
        `run ${run}: status=${result.status} signal=${result.signal} last=${JSON.stringify(lines.slice(-3))} stderr=${result.stderr.slice(0, 500)}`,
      );
    }
    t.equal(result.signal, null, `run ${run}: the process was not killed by a signal`);
    t.equal(lines.at(-1), "DONE", `run ${run}: every round finished`);
  }
  t.end();
});
