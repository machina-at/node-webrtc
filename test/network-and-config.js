"use strict";

const os = require("os");
const test = require("tape");
const { RTCPeerConnection, nonstandard } = require("..");
const { connectedPair, until, whenOpen } = require("./lib/pair");

// B5: pc.sctp and RTCSctpTransport's getters used to wait on the network
// thread on every read; they are cached now and must still be right.
test("pc.sctp and its state are readable and stable", async (t) => {
  const { a, b } = await connectedPair();
  const sctp = a.sctp;
  t.ok(sctp, "sctp is available once connected");
  t.equal(a.sctp, sctp, "the same RTCSctpTransport each time");
  t.equal(sctp.state, "connected", "state is connected");
  t.ok(sctp.maxMessageSize > 0, `maxMessageSize is known (${sctp.maxMessageSize})`);
  const start = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) void a.sctp.state;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  t.ok(ms < 2000, `20000 reads of pc.sctp.state take ${ms.toFixed(1)}ms`);
  a.close();
  b.close();
  t.end();
});

// B7: ICE timing knobs and tlsCertPolicy are accepted and reported back.
test("ICE timing options and tlsCertPolicy round-trip through getConfiguration", (t) => {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "turns:127.0.0.1:5349", username: "u", credential: "p", tlsCertPolicy: "insecure-no-check" },
    ],
    iceConnectionReceivingTimeout: 5000,
    iceUnwritableTimeout: 3000,
    iceInactiveTimeout: 8000,
    iceCheckMinInterval: 100,
  });
  const config = pc.getConfiguration();
  t.equal(config.iceConnectionReceivingTimeout, 5000, "iceConnectionReceivingTimeout");
  t.equal(config.iceUnwritableTimeout, 3000, "iceUnwritableTimeout");
  t.equal(config.iceInactiveTimeout, 8000, "iceInactiveTimeout");
  t.equal(config.iceCheckMinInterval, 100, "iceCheckMinInterval");
  t.equal(config.iceServers[0].tlsCertPolicy, "insecure-no-check", "tlsCertPolicy");
  pc.close();
  t.throws(
    () => new RTCPeerConnection({ iceServers: [{ urls: "turns:x:1", tlsCertPolicy: "bogus" }] }),
    /tlsCertPolicy/,
    "an unknown tlsCertPolicy is rejected",
  );
  t.end();
});

function hostCandidates(pc) {
  return new Promise((resolve) => {
    const found = [];
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        resolve(found);
      } else if (/ typ host/.test(e.candidate.candidate)) {
        found.push(e.candidate.candidate);
      }
    };
    pc.createDataChannel("x");
    pc.createOffer().then((offer) => pc.setLocalDescription(offer));
  });
}

// B7': interfaces on the ignore list gather no candidates.
test("setNetworkOptions({ ignoredInterfaces }) drops host candidates of those interfaces", async (t) => {
  const external = Object.entries(os.networkInterfaces()).filter(([, addrs]) =>
    addrs.some((a) => !a.internal),
  );
  const names = external.map(([name]) => name);
  const addresses = new Set(external.flatMap(([, addrs]) => addrs.map((a) => a.address)));
  function usesIgnored(candidates) {
    return candidates.filter((c) => addresses.has(c.split(" ")[4]));
  }
  const before = new RTCPeerConnection();
  const withAll = usesIgnored(await hostCandidates(before));
  before.close();
  nonstandard.setNetworkOptions({ ignoredInterfaces: names });
  try {
    const after = new RTCPeerConnection();
    const withNone = usesIgnored(await hostCandidates(after));
    after.close();
    t.ok(withAll.length > 0, `host candidates on those interfaces without the option (${withAll.length})`);
    t.deepEqual(withNone, [], "none once they are ignored");
  } finally {
    nonstandard.setNetworkOptions({ ignoredInterfaces: [] });
    // The network manager re-enumerates every 2 s; let the restored networks
    // come back before the next test.
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  t.end();
});

// B7': with bindSocketsToInterface every bound socket is pinned to the NIC
// that owns its address; connections keep working.
test("setNetworkOptions({ bindSocketsToInterface }) pins sockets and still connects", async (t) => {
  nonstandard.setNetworkOptions({ bindSocketsToInterface: true });
  try {
    const before = nonstandard.getNetworkBindingStats();
    const { a, b } = await connectedPair();
    const channel = a.createDataChannel("pinned");
    let got = null;
    b.ondatachannel = ({ channel: remote }) => {
      remote.onmessage = ({ data }) => {
        got = data;
      };
    };
    await whenOpen(channel);
    channel.send("hello");
    await until(() => got === "hello", 10000, "message").catch(() => {});
    const after = nonstandard.getNetworkBindingStats();
    t.equal(got, "hello", "data flows over pinned sockets");
    t.ok(after.calls > before.calls, `the binder ran for bound sockets (${after.calls - before.calls})`);
    if (process.platform === "darwin") {
      t.ok(after.succeeded > before.succeeded, `IP_BOUND_IF applied (${after.succeeded - before.succeeded})`);
    }
    a.close();
    b.close();
  } finally {
    nonstandard.setNetworkOptions({ bindSocketsToInterface: false });
  }
  t.end();
});
