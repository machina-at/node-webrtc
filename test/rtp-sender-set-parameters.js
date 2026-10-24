"use strict";

const test = require("tape");
const { RTCPeerConnection, nonstandard } = require("..");

// C2: after negotiation every setParameters() failed with "modified SSRC":
// the encodings JS gets back have no SSRC, so passing them back looked like a
// change. Only the fields JS may change are applied now.
test("setParameters() after negotiation applies maxBitrate", async (t) => {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  const source = new nonstandard.RTCVideoSource();
  const track = source.createTrack();
  const sender = a.addTrack(track);
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);

  const params = sender.getParameters();
  params.encodings[0].maxBitrate = 2000000;
  let error = null;
  try {
    await sender.setParameters(params);
  } catch (e) {
    error = e;
  }
  t.equal(error, null, `setParameters resolved (${error && error.message})`);
  t.equal(sender.getParameters().encodings[0].maxBitrate, 2000000, "maxBitrate is applied");

  const stale = sender.getParameters();
  void sender.getParameters();
  let staleError = null;
  try {
    await sender.setParameters(stale);
  } catch (e) {
    staleError = e;
  }
  t.equal(staleError && staleError.name, "InvalidModificationError", "a stale transactionId is rejected");

  track.stop();
  a.close();
  b.close();
  t.end();
});
