/* Copyright (c) 2026 The node-webrtc project authors. All rights reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be found
 * in the LICENSE.md file in the root of the source tree. All contributing
 * project authors may be found in the AUTHORS file in the root of the source
 * tree.
 */
#pragma once

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

#include <node-addon-api/napi.h>
#include <webrtc/rtc_base/network_monitor.h>

namespace node_webrtc {

class PeerConnectionFactory;

/**
 * Process-wide network options (non-standard). The network manager and socket
 * server belong to the shared PeerConnectionFactory, so these apply to every
 * RTCPeerConnection:
 *
 * - ignoredInterfaces: interface names left out of network enumeration (no
 *   candidates are gathered on them), e.g. VM bridges.
 * - bindSocketsToInterface: every socket libwebrtc binds to a local address is
 *   also pinned to the interface that owns that address (IP_BOUND_IF on
 *   macOS, SO_BINDTODEVICE on Linux, IP_UNICAST_IF on Windows), so its
 *   packets leave through that NIC whatever the routing table says (e.g.
 *   while a VPN / exit node captures the default route).
 */
class NetworkOptions : public webrtc::NetworkBinderInterface {
public:
  static NetworkOptions &Instance();

  static void Init(Napi::Env, Napi::Object);

  // Applies the current options to a factory (its network manager and socket
  // server). Safe to call on the JS thread.
  void ApplyTo(PeerConnectionFactory *factory);

  webrtc::NetworkBindingResult
  BindSocketToNetwork(int socket_fd, const webrtc::IPAddress &address) override;

private:
  static Napi::Value SetNetworkOptions(const Napi::CallbackInfo &);
  static Napi::Value GetNetworkBindingStats(const Napi::CallbackInfo &);

  std::mutex _mutex;
  std::vector<std::string> _ignored_interfaces;
  bool _bind_sockets_to_interface = false;

  std::atomic<uint64_t> _bind_calls{0};
  std::atomic<uint64_t> _bind_succeeded{0};
  std::atomic<uint64_t> _bind_failed{0};
};

} // namespace node_webrtc
