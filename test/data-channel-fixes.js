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
// bufferedAmountLowThreshold. bufferedAmount is capped by the native value,
// so how much piles up depends on how fast the platform drains loopback (on
// the Windows runner nothing does); the event is required only when it did.
test("bufferedAmount and bufferedamountlow track send()", async (t) => {
  const { a, b } = await connectedPair();
  const channel = a.createDataChannel("bulk");
  b.ondatachannel = ({ channel: remote }) => {
    remote.onmessage = () => {};
  };
  await whenOpen(channel);
  const CHUNK = 64 * 1024;
  const THRESHOLD = 256 * 1024;
  channel.bufferedAmountLowThreshold = THRESHOLD;
  t.equal(channel.bufferedAmountLowThreshold, THRESHOLD, "threshold is stored");
  let low = 0;
  let amountAtLow = -1;
  channel.onbufferedamountlow = () => {
    low++;
    amountAtLow = channel.bufferedAmount;
  };
  let peak = 0;
  for (let i = 0; i < 64; i++) {
    channel.send(new Uint8Array(CHUNK));
    peak = Math.max(peak, channel.bufferedAmount);
  }
  await until(() => channel.bufferedAmount === 0, 15000, "drained").catch(() => {});
  t.equal(channel.bufferedAmount, 0, `bufferedAmount returns to 0 once sent (peak ${peak})`);
  if (peak > THRESHOLD) {
    await until(() => low > 0, 15000, "bufferedamountlow").catch(() => {});
    t.ok(low > 0, `bufferedamountlow fired after bufferedAmount reached ${peak}`);
    t.ok(amountAtLow >= 0 && amountAtLow <= THRESHOLD, `bufferedAmount <= threshold when it fired (${amountAtLow})`);
  } else {
    t.equal(low, 0, `no bufferedamountlow while bufferedAmount stayed at or below the threshold (peak ${peak})`);
  }
  a.close();
  b.close();
  t.end();
});

// B6: send() beyond the 16 MiB send queue used to drop the message silently.
// Whether a flood fills the queue depends on the platform, so either send()
// threw an OperationError or every message arrived; one message larger than
// the whole queue is refused everywhere.
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
  if (error) {
    t.equal(error.name, "OperationError", `a full queue throws an OperationError (sent ${sent})`);
  }
  await until(() => received === sent, 60000, "delivery").catch(() => {});
  t.equal(received, sent, `every send() that returned was delivered (${received}/${sent})`);
  let oversized = null;
  try {
    channel.send(new Uint8Array(16 * 1024 * 1024 + 1));
  } catch (e) {
    oversized = e;
  }
  t.equal(oversized && oversized.name, "OperationError", "a message larger than the send queue is refused");
  t.equal(channel.readyState, "open", "the channel stays open");
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

// bufferedAmount on a channel with nothing queued must not wait on a libwebrtc
// thread: planx reads it for every channel of a peer on each send, and each
// native read is a blocking hop (20000 reads took ~650 ms, readyState ~3 ms).
test("bufferedAmount of an idle channel does not wait on a libwebrtc thread", async (t) => {
  const { a, b } = await connectedPair();
  b.ondatachannel = () => {};
  const channel = a.createDataChannel("idle");
  await whenOpen(channel);
  channel.send("x");
  await until(() => channel.bufferedAmount === 0, 5000, "drained").catch(() => {});
  // Let libwebrtc's "sent" report reach the JS thread; a synchronous loop
  // right after the drain would read before it can run.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const start = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) void channel.bufferedAmount;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  t.equal(channel.bufferedAmount, 0, "nothing is queued");
  t.ok(ms < 30, `20000 reads of an idle bufferedAmount take ${ms.toFixed(1)}ms`);
  a.close();
  b.close();
  t.end();
});

// A remote channel is announced only once its native side is open, so the
// "datachannel" handler sees readyState "open" (as the spec requires) and can
// send at once; "open" follows, and nothing the remote sent first is lost.
// libwebrtc can report a remote channel while it is still connecting (its DCEP
// ACK not yet sent); NODE_WEBRTC_TEST_REMOTE_STARTS_CONNECTING makes every
// wrapper start that way.
test("a remote channel is announced open and writable", (t) => {
  const COUNT = 20;
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "lib", "remote-announce.js"), String(COUNT)],
    {
      encoding: "utf8",
      timeout: 60000,
      killSignal: "SIGKILL",
      env: { ...process.env, NODE_WEBRTC_TEST_REMOTE_STARTS_CONNECTING: "1" },
    },
  );
  const line = result.stdout.trim().split("\n").at(-1) || "{}";
  const out = JSON.parse(line);
  t.equal(result.signal, null, `the script finished (signal=${result.signal})`);
  t.deepEqual((out.states || []).filter((s) => s !== "open"), [], `datachannel sees readyState open (${line})`);
  t.deepEqual(out.errors, [], "send() from the datachannel handler goes through");
  t.equal(out.acks, COUNT, `every ack arrived (${out.acks}/${COUNT})`);
  t.equal(out.hellos, COUNT, `every message sent first arrived (${out.hellos}/${COUNT})`);
  t.equal(out.opened, COUNT, `open fired on every remote channel (${out.opened}/${COUNT})`);
  t.deepEqual(out.misordered, [], "open follows datachannel");
  t.end();
});

// send() hands the message to libwebrtc without waiting on its network thread
// (SendAsync); a blocking Send() cost one thread hop per message.
test("send() does not wait on a libwebrtc thread", async (t) => {
  const { a, b } = await connectedPair();
  let received = 0;
  b.ondatachannel = ({ channel: remote }) => {
    remote.onmessage = () => received++;
  };
  const channel = a.createDataChannel("fast");
  await whenOpen(channel);
  const COUNT = 2000;
  const start = process.hrtime.bigint();
  for (let i = 0; i < COUNT; i++) channel.send("x");
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  t.ok(ms < 15, `${COUNT} sends take ${ms.toFixed(1)}ms`);
  await until(() => received === COUNT, 10000, "delivery").catch(() => {});
  t.equal(received, COUNT, `every message arrived (${received}/${COUNT})`);
  a.close();
  b.close();
  t.end();
});

// bufferedAmount includes a message as soon as send() returns, as the spec
// requires, even while libwebrtc has not taken it yet; under-reporting would
// let a sender ignore backpressure.
test("bufferedAmount covers a message as soon as send() returns", async (t) => {
  const { a, b } = await connectedPair();
  b.ondatachannel = ({ channel: remote }) => {
    remote.onmessage = () => {};
  };
  const channel = a.createDataChannel("covered");
  await whenOpen(channel);
  const CHUNK = 64 * 1024;
  const short = [];
  let sent = 0;
  for (let i = 0; i < 32; i++) {
    const before = channel.bufferedAmount;
    channel.send(new Uint8Array(CHUNK));
    sent += CHUNK;
    const after = channel.bufferedAmount;
    if (after < before + CHUNK && after < sent) short.push(`${i}:${before}->${after}`);
  }
  t.deepEqual(short, [], "bufferedAmount grew by the message right after send()");
  await until(() => channel.bufferedAmount === 0, 15000, "drained").catch(() => {});
  t.equal(channel.bufferedAmount, 0, "and returns to 0 once sent");
  a.close();
  b.close();
  t.end();
});

// Messages keep their order when send() no longer waits for each one.
test("messages sent back to back arrive in order", async (t) => {
  const { a, b } = await connectedPair();
  const got = [];
  b.ondatachannel = ({ channel: remote }) => {
    remote.onmessage = ({ data }) => got.push(Number(data));
  };
  const channel = a.createDataChannel("ordered");
  await whenOpen(channel);
  const COUNT = 5000;
  for (let i = 0; i < COUNT; i++) channel.send(String(i));
  await until(() => got.length === COUNT, 15000, "delivery").catch(() => {});
  const misplaced = got.filter((n, i) => n !== i).length;
  t.equal(got.length, COUNT, `every message arrived (${got.length}/${COUNT})`);
  t.equal(misplaced, 0, "in the order they were sent");
  a.close();
  b.close();
  t.end();
});
