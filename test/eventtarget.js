"use strict";

const test = require("tape");
const { RTCPeerConnection } = require("..");
const { connectedPair, until } = require("./lib/pair");

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// addEventListener used to ignore its options: a listener registered with an
// AbortSignal stayed attached after abort(), and { once: true } fired every
// time. Code written against the standard EventTarget (hipw detaches a
// replaced main channel's listeners with an AbortController) kept reacting to
// a channel it had let go.
test("addEventListener honours signal and once", async (t) => {
  const { a, b } = await connectedPair();
  const channel = a.createDataChannel("events");
  const calls = { aborted: 0, preAborted: 0, once: 0, plain: 0, removedOnce: 0 };
  const controller = new AbortController();
  channel.addEventListener("message", () => calls.aborted++, { signal: controller.signal });
  channel.addEventListener("message", () => calls.preAborted++, { signal: AbortSignal.abort() });
  channel.addEventListener("message", () => calls.once++, { once: true });
  channel.addEventListener("message", () => calls.plain++);
  function removed() {
    calls.removedOnce++;
  }
  channel.addEventListener("message", removed, { once: true });
  channel.removeEventListener("message", removed);
  let remoteChannel = null;
  b.ondatachannel = ({ channel: remote }) => {
    remoteChannel = remote;
    remote.onopen = () => remote.send("1");
  };
  await until(() => calls.plain >= 1, 10000, "first message").catch(() => {});
  controller.abort();
  remoteChannel.send("2");
  await until(() => calls.plain >= 2, 10000, "second message").catch(() => {});
  await tick();
  t.equal(calls.plain, 2, "a plain listener sees both messages");
  t.equal(calls.aborted, 1, "an aborted signal detaches its listener");
  t.equal(calls.preAborted, 0, "a listener with an already aborted signal is never added");
  t.equal(calls.once, 1, "a once listener fires once");
  t.equal(calls.removedOnce, 0, "a once listener can be removed before it fires");
  a.close();
  b.close();
  t.end();
});

test("the same listener is added once per type, as with a browser", (t) => {
  const pc = new RTCPeerConnection();
  let count = 0;
  function listener() {
    count++;
  }
  pc.addEventListener("negotiationneeded", listener);
  pc.addEventListener("negotiationneeded", listener, { once: true });
  pc.createDataChannel("x");
  setTimeout(() => {
    t.equal(count, 1, "the second registration of the same listener is ignored");
    pc.close();
    t.end();
  }, 200);
});
