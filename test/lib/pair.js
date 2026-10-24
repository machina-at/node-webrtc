"use strict";

const { RTCPeerConnection } = require("../..");

// Two connected peers on loopback. Candidates are held until the other side
// has a remote description (addIceCandidate before that fails), and the boot
// channel's open is awaited from the moment it is created.
async function connectedPair(config = {}, onCreate = () => {}) {
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  onCreate(a, b);
  function relay(to) {
    const pending = [];
    return {
      add: (c) =>
        to.remoteDescription
          ? to.addIceCandidate(c).catch(() => {})
          : pending.push(c),
      flush: () =>
        pending.splice(0).forEach((c) => to.addIceCandidate(c).catch(() => {})),
    };
  }
  const toA = relay(a);
  const toB = relay(b);
  a.onicecandidate = (e) => e.candidate && toB.add(e.candidate);
  b.onicecandidate = (e) => e.candidate && toA.add(e.candidate);
  const boot = a.createDataChannel("boot");
  const bootOpen = new Promise((resolve) => {
    boot.onopen = resolve;
  });
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  toB.flush();
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  toA.flush();
  await bootOpen;
  return { a, b, boot };
}

function until(cond, ms, label) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    function tick() {
      if (cond()) {
        resolve();
      } else if (Date.now() > deadline) {
        reject(new Error(`timeout: ${label}`));
      } else {
        setTimeout(tick, 5);
      }
    }
    tick();
  });
}

function whenOpen(channel) {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve) => channel.addEventListener("open", resolve));
}

module.exports = { connectedPair, until, whenOpen };
