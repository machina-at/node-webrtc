"use strict";

const { spawnSync } = require("child_process");
const path = require("path");
const test = require("tape");

// OnDataChannel runs on the signaling thread. DataChannelObserver used to take
// a RefPtr<PeerConnectionFactory> there, i.e. call napi_reference_ref off the
// main thread, racing with the main thread's Ref()/Unref() (GC finalizers of
// RTCDataChannel). The factory's reference count then went wrong: one way it
// was released while channels still used it (SIGSEGV / SIGBUS in
// ~RTCDataChannel), the other way Unref() hit zero and threw inside a
// destructor (std::terminate -> SIGABRT). Remote-created channels plus a busy
// GC make the race likely; it is still a race, so run a few children.
//
// The child marks each phase, and a watchdog thread tells whether the main
// thread is blocked (inside a native call) or just waiting for an event.
const child = `
const { RTCPeerConnection } = require(${JSON.stringify(path.join(__dirname, ".."))});
const { Worker } = require("worker_threads");
const ROUNDS = Number(process.argv[1]);
const PER = Number(process.argv[2]);
const PHASES = ["start", "pair", "offer", "answer", "boot-open", "channels", "close-a", "close-b", "closed"];
const shared = new Int32Array(new SharedArrayBuffer(12));
const mark = (phase, round) => { Atomics.store(shared, 1, PHASES.indexOf(phase)); Atomics.store(shared, 2, round); };
setInterval(() => Atomics.add(shared, 0, 1), 100);
const watchdog = new Worker(\`
  const { workerData } = require("worker_threads");
  const shared = workerData; const phases = \${JSON.stringify(PHASES)};
  let last = -1, still = 0, waiting = 0, lastPhase = -1;
  setInterval(() => {
    const beat = Atomics.load(shared, 0), phase = Atomics.load(shared, 1);
    still = beat === last ? still + 1 : 0; last = beat;
    waiting = phase === lastPhase ? waiting + 1 : 0; lastPhase = phase;
    if (still === 10) process.stdout.write("WATCHDOG main-thread-blocked phase=" + phases[phase] + " round=" + Atomics.load(shared, 2) + "\\\\n");
    if (still === 0 && waiting === 10) process.stdout.write("WATCHDOG waiting-for-event phase=" + phases[phase] + " round=" + Atomics.load(shared, 2) + "\\\\n");
  }, 1000);
\`, { eval: true, workerData: shared });
watchdog.unref();
async function pair(r) {
  mark("pair", r);
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
  let received = 0;
  b.ondatachannel = ({ channel }) => { received++; channel.close(); };
  const boot = a.createDataChannel("boot");
  mark("offer", r);
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  mark("answer", r);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  mark("boot-open", r);
  await new Promise((resolve) => { boot.onopen = resolve; });
  return { a, b, received: () => received };
}
(async () => {
  const gc = setInterval(() => global.gc(), 1);
  for (let r = 0; r < ROUNDS; r++) {
    const p = await pair(r);
    mark("channels", r);
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
    mark("close-a", r);
    p.a.close();
    mark("close-b", r);
    p.b.close();
    mark("closed", r);
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
        `run ${run}: status=${result.status} signal=${result.signal} last=${JSON.stringify(lines.slice(-4))} stderr=${result.stderr.slice(0, 500)}`,
      );
    }
    t.notOk(
      ["SIGSEGV", "SIGBUS", "SIGABRT"].includes(result.signal),
      `run ${run}: the process did not crash (signal=${result.signal})`,
    );
    t.equal(lines.at(-1), "DONE", `run ${run}: every round finished`);
  }
  t.end();
});
