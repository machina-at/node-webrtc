/* Copyright (c) 2026 The node-webrtc project authors. All rights reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be found
 * in the LICENSE.md file in the root of the source tree. All contributing
 * project authors may be found in the AUTHORS file in the root of the source
 * tree.
 */
#pragma once

#include <node-addon-api/napi.h>

namespace node_webrtc {

/**
 * nonstandard.connectBound(address, port, interfaceName, timeoutMs?) opens a
 * TCP connection whose socket is pinned to `interfaceName` before connect()
 * (IP_BOUND_IF on macOS, SO_BINDTODEVICE on Linux) and resolves with the
 * connected, non-blocking fd for `new net.Socket({ fd })`. Node has no hook
 * between socket() and connect(), so a JS caller cannot do this itself.
 *
 * It never falls back to an unpinned connection: if the socket cannot be
 * pinned the promise rejects without connecting. Not supported on Windows,
 * where node cannot adopt a socket handle.
 */
class ConnectBound {
public:
  static void Init(Napi::Env, Napi::Object);
};

} // namespace node_webrtc
