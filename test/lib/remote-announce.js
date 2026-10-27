"use strict";

// Remote side of the announce test. Opens COUNT channels from a to b; b's
// "datachannel" handler records readyState, sends an ack at once and listens
// for the message a sent from its "open" handler. Prints one JSON line. Run
// with NODE_WEBRTC_TEST_REMOTE_STARTS_CONNECTING=1 so every wrapper starts as
// if its native channel had not opened yet.
const { connectedPair, until } = require("./pair");

const COUNT = Number(process.argv[2]);

(async () => {
  const { a, b } = await connectedPair();
  const states = [];
  const errors = [];
  const order = [];
  let acks = 0;
  let hellos = 0;
  b.ondatachannel = ({ channel: remote }) => {
    if (remote.label === "boot") return;
    states.push(remote.readyState);
    order.push(`${remote.label}:datachannel`);
    remote.addEventListener("open", () => order.push(`${remote.label}:open`));
    remote.onmessage = () => hellos++;
    try {
      remote.send("ack");
    } catch (e) {
      errors.push(`${remote.label}:${e.name}`);
    }
  };
  function onAck() {
    acks++;
  }
  for (let i = 0; i < COUNT; i++) {
    const local = a.createDataChannel(`r${i}`);
    local.onmessage = onAck;
    local.onopen = () => local.send("hello");
  }
  await until(
    () => acks + errors.length >= COUNT && hellos >= COUNT,
    15000,
    "acks",
  ).catch(() => {});
  const opened = order.filter((e) => e.endsWith(":open")).length;
  const misordered = order.filter(
    (e, i) =>
      e.endsWith(":open") &&
      !(order.indexOf(e.replace(":open", ":datachannel")) < i),
  );
  console.log(
    JSON.stringify({ states, errors, acks, hellos, opened, misordered }),
  );
  a.close();
  b.close();
  // eslint-disable-next-line no-process-exit
  setTimeout(() => process.exit(0), 100);
})();
