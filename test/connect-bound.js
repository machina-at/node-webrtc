"use strict";

const net = require("net");
const os = require("os");
const test = require("tape");
const { nonstandard } = require("..");

// connectBound opens a TCP connection whose socket is pinned to a network
// interface before connect() (IP_BOUND_IF / SO_BINDTODEVICE), so it leaves
// through that interface whatever the routing table says, and resolves with
// the connected fd for `new net.Socket({ fd })`. Node has no hook between
// socket() and connect(), which is why this lives in native code.
const LOOPBACK = Object.entries(os.networkInterfaces()).find(([, addrs]) =>
  addrs.some((a) => a.internal && a.family === "IPv4"),
)[0];
const POSIX = process.platform !== "win32";

function listen() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.pipe(socket));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("connectBound connects a pinned socket that node can use", { skip: !POSIX }, async (t) => {
  const server = await listen();
  const fd = await nonstandard.connectBound("127.0.0.1", server.address().port, LOOPBACK);
  t.ok(Number.isInteger(fd) && fd >= 0, `resolves with an fd (${fd})`);
  const socket = new net.Socket({ fd, readable: true, writable: true });
  const echoed = await new Promise((resolve, reject) => {
    socket.once("data", (data) => resolve(String(data)));
    socket.once("error", reject);
    socket.write("ping");
  });
  t.equal(echoed, "ping", "data round-trips over the pinned socket");
  socket.destroy();
  server.close();
  t.end();
});

test("connectBound refuses to connect when the socket cannot be pinned", { skip: !POSIX }, async (t) => {
  const server = await listen();
  let accepted = 0;
  server.on("connection", () => accepted++);
  const error = await nonstandard
    .connectBound("127.0.0.1", server.address().port, "no-such-if0")
    .then(() => null, (e) => e);
  await new Promise((resolve) => setTimeout(resolve, 100));
  t.ok(error, `rejects (${error && error.message})`);
  t.equal(accepted, 0, "no connection was made on the routing table's interface instead");
  server.close();
  t.end();
});

// TEST-NET-1 over an external interface: SYNs go unanswered, so the timeout
// ends the attempt (or the network reports it unreachable right away).
const EXTERNAL = (Object.entries(os.networkInterfaces()).find(([, addrs]) =>
  addrs.some((a) => !a.internal && a.family === "IPv4"),
) || [LOOPBACK])[0];

test("connectBound gives up after the timeout", { skip: !POSIX }, async (t) => {
  const started = Date.now();
  const error = await nonstandard
    .connectBound("192.0.2.1", 9, EXTERNAL, 300)
    .then(() => null, (e) => e);
  t.ok(error, `rejects (${error && error.message})`);
  t.ok(Date.now() - started < 5000, `within the timeout (${Date.now() - started} ms)`);
  t.end();
});

test("connectBound validates its arguments", { skip: !POSIX }, (t) => {
  t.throws(() => nonstandard.connectBound("not-an-ip", 80, LOOPBACK), /address/, "an address must be an IP literal");
  t.throws(() => nonstandard.connectBound("127.0.0.1", 0, LOOPBACK), /port/, "a port must be 1-65535");
  t.end();
});
