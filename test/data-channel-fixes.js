"use strict";

const test = require("tape");
const { RTCPeerConnection } = require("..");
const { connectedPair, until, whenOpen } = require("./lib/pair");

// B1: messages that arrive while a remote channel is being handed from its
// DataChannelObserver to the RTCDataChannel wrapper must keep their order.
// RegisterObserver(this) used to run before the cached events were re-queued,
// so a message delivered in between overtook the cached ones. It needs a
// remote sender in another process, a receiver whose JS thread is late (so
// the observer caches), and NODE_WEBRTC_TEST_ADOPT_DELAY_MS to widen the
// microsecond window. Before the fix: 2 of 20 channels reordered every run.
const { spawnSync } = require("child_process");
const path = require("path");

test("messages keep their order across the observer hand-off", (t) => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "lib", "order-receiver.js"), "20", "2000", "100"],
    {
      encoding: "utf8",
      timeout: 120000,
      killSignal: "SIGKILL",
      env: { ...process.env, NODE_WEBRTC_TEST_ADOPT_DELAY_MS: "20" },
    },
  );
  const line = result.stdout.trim().split("\n").at(-1) || "{}";
  const out = JSON.parse(line);
  t.equal(result.signal, null, `the receiver finished (signal=${result.signal})`);
  t.ok(out.complete, `every message arrived (${line})`);
  t.equal(out.reordered, 0, `no channel saw its messages out of order (${line})`);
  t.end();
});

// B2: an RTCSctpTransport / RTCDtlsTransport going to "closed" used to lose its
// statechange event: OnStateChange dispatched it and then called Stop(), and
// the event loop closed without running the queue.
test("sctp and dtls transports fire statechange when they close", async (t) => {
  const { a, b } = await connectedPair();
  const sctp = a.sctp;
  const dtls = sctp.transport;
  const seen = { sctp: [], dtls: [] };
  sctp.addEventListener("statechange", () => seen.sctp.push(sctp.state));
  dtls.addEventListener("statechange", () => seen.dtls.push(dtls.state));
  b.close();
  await until(
    () => seen.sctp.includes("closed") && seen.dtls.includes("closed"),
    15000,
    "closed statechange",
  ).catch(() => {});
  t.ok(seen.sctp.includes("closed"), `sctp statechange to closed (${seen.sctp})`);
  t.ok(seen.dtls.includes("closed"), `dtls statechange to closed (${seen.dtls})`);
  a.close();
  t.end();
});

// B3: connectionstatechange used to piggyback on every ICE connection state
// change, so it fired with the same connectionState several times and never
// fired for DTLS-only transitions.
test("connectionstatechange fires once per connectionState change", async (t) => {
  const fired = [];
  const pair = await connectedPair({}, (a) => {
    a.onconnectionstatechange = () => fired.push(a.connectionState);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  pair.b.close();
  await until(() => fired.length > 0 && fired.at(-1) !== "connected", 40000, "leaves connected").catch(() => {});
  const dup = fired.filter((s, i) => i > 0 && s === fired[i - 1]);
  t.deepEqual(dup, [], `no repeated connectionState in events (${fired})`);
  t.ok(fired.includes("connected"), `saw connected (${fired})`);
  t.ok(fired.at(-1) !== "connected", `remote close moves connectionState off connected (${fired})`);
  pair.a.close();
  t.end();
});

// B8: a channel created on an established SCTP association is open at once;
// the transition happened before any observer was registered, so "open" never
// fired (and readyState was already "open" when createDataChannel returned).
test("a channel created on a connected pc fires open exactly once", async (t) => {
  const { a, b } = await connectedPair();
  b.ondatachannel = () => {};
  const channel = a.createDataChannel("late");
  const initial = channel.readyState;
  let opened = 0;
  let stateAtOpen = null;
  channel.onopen = () => {
    opened++;
    stateAtOpen = channel.readyState;
  };
  await until(() => opened > 0, 5000, "open").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  t.equal(initial, "connecting", "it starts connecting, as in a browser");
  t.equal(opened, 1, `open fired once (readyState=${channel.readyState})`);
  t.equal(stateAtOpen, "open", "readyState is open when open fires");
  a.close();
  b.close();
  t.end();
});

// B4: bufferedamountlow fires when bufferedAmount drops to
// bufferedAmountLowThreshold. bufferedAmount is read from the native channel.
test("bufferedAmount and bufferedamountlow track send()", async (t) => {
  const { a, b } = await connectedPair();
  const channel = a.createDataChannel("bulk");
  b.ondatachannel = ({ channel: remote }) => {
    remote.onmessage = () => {};
  };
  await whenOpen(channel);
  const CHUNK = 64 * 1024;
  channel.bufferedAmountLowThreshold = 256 * 1024;
  t.equal(channel.bufferedAmountLowThreshold, 256 * 1024, "threshold is stored");
  let low = 0;
  let amountAtLow = -1;
  channel.onbufferedamountlow = () => {
    low++;
    amountAtLow = channel.bufferedAmount;
  };
  const before = channel.bufferedAmount;
  channel.send(new Uint8Array(CHUNK));
  t.ok(
    channel.bufferedAmount > before,
    `bufferedAmount grows right after send() (${before} -> ${channel.bufferedAmount})`,
  );
  for (let i = 0; i < 63; i++) channel.send(new Uint8Array(CHUNK));
  await until(() => low > 0, 15000, "bufferedamountlow").catch(() => {});
  t.ok(low > 0, "bufferedamountlow fired");
  t.ok(
    amountAtLow >= 0 && amountAtLow <= 256 * 1024,
    `bufferedAmount <= threshold when it fired (${amountAtLow})`,
  );
  await until(() => channel.bufferedAmount === 0, 15000, "drained").catch(() => {});
  t.equal(channel.bufferedAmount, 0, "bufferedAmount returns to 0 once sent");
  a.close();
  b.close();
  t.end();
});

// B6: send() beyond the 16 MiB send queue used to drop the message silently.
test("send() throws instead of dropping when the send queue is full", async (t) => {
  const { a, b } = await connectedPair();
  const channel = a.createDataChannel("flood");
  let received = 0;
  b.ondatachannel = ({ channel: remote }) => {
    remote.onmessage = () => received++;
  };
  await whenOpen(channel);
  const CHUNK = 256 * 1024;
  let sent = 0;
  let error = null;
  try {
    for (let i = 0; i < 200; i++) {
      channel.send(new Uint8Array(CHUNK));
      sent++;
    }
  } catch (e) {
    error = e;
  }
  t.ok(error, `send() threw once the queue was full (sent ${sent})`);
  t.equal(error && error.name, "OperationError", `it is an OperationError (${error && error.name})`);
  await until(() => received === sent, 30000, "delivery").catch(() => {});
  t.equal(received, sent, `every send() that returned was delivered (${received}/${sent})`);
  a.close();
  b.close();
  t.end();
});

// readyState follows the "open" event, but send() must not refuse a channel
// whose native side is already open while that event is still queued (the
// remote may already be using it). Blocking the JS thread lets the native
// channel open while its "open" event cannot run.
test("send() works once the native channel is open, before 'open' runs", async (t) => {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  function gathered(pc) {
    const found = [];
    return new Promise((resolve) => {
      pc.onicecandidate = (e) => (e.candidate ? found.push(e.candidate) : resolve(found));
    });
  }
  let received = null;
  b.ondatachannel = ({ channel: remote }) => {
    remote.onmessage = ({ data }) => {
      received = data;
    };
  };
  const channel = a.createDataChannel("early");
  const fromA = gathered(a);
  const fromB = gathered(b);
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  const [candidatesA, candidatesB] = await Promise.all([fromA, fromB]);
  // addIceCandidate runs on the JS event loop: wait for every candidate to be
  // applied, then block right away so ICE / DTLS / SCTP and the channel's
  // opening all happen natively while "open" cannot be dispatched.
  await Promise.all([
    ...candidatesA.map((c) => b.addIceCandidate(c).catch(() => {})),
    ...candidatesB.map((c) => a.addIceCandidate(c).catch(() => {})),
  ]);
  const stateBefore = channel.readyState;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  let error = null;
  try {
    channel.send("early");
  } catch (e) {
    error = e;
  }
  t.equal(stateBefore, "connecting", "the channel was still connecting before the JS thread blocked");
  t.equal(error, null, `send() did not throw (readyState=${channel.readyState}, ${error && error.name})`);
  await until(() => received === "early", 10000, "delivery").catch(() => {});
  t.equal(received, "early", "the message arrived");
  a.close();
  b.close();
  t.end();
});

// A remote channel's readyState follows its native state: when it says
// "open" a send() goes through, otherwise "open" follows. Reporting "open"
// before the native channel was open made such sends fail (planx lost the
// l7 CH_ACK it sends from the open handler) while the remote side's sends were
// queued behind other data.
test("a remote channel takes sends whenever readyState is open", async (t) => {
  const { a, b } = await connectedPair();
  const COUNT = 40;
  const errors = [];
  let received = 0;
  // Keep b -> a busy: the DCEP ACK b owes for each new channel queues behind
  // the bulk data, so b's remote channels stay connecting for a while.
  const bulk = b.createDataChannel("bulk");
  await whenOpen(bulk);
  for (let i = 0; i < 32; i++) bulk.send(new Uint8Array(256 * 1024));
  b.ondatachannel = ({ channel: remote }) => {
    function ack() {
      try {
        remote.send("ack");
      } catch (e) {
        errors.push(`${remote.label}:${e.name}`);
      }
    }
    if (remote.readyState === "open") ack();
    else remote.addEventListener("open", ack, { once: true });
  };
  function onAck() {
    received++;
  }
  for (let i = 0; i < COUNT; i++) {
    a.createDataChannel(`r${i}`).onmessage = onAck;
  }
  await until(() => received + errors.length >= COUNT, 15000, "acks").catch(() => {});
  t.deepEqual(errors, [], "no send() failed on a channel that said it was open");
  t.equal(received, COUNT, `every ack arrived (${received}/${COUNT})`);
  a.close();
  b.close();
  t.end();
});
