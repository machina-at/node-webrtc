/* Copyright (c) 2026 The node-webrtc project authors. All rights reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be found
 * in the LICENSE.md file in the root of the source tree. All contributing
 * project authors may be found in the AUTHORS file in the root of the source
 * tree.
 */
#include "src/methods/network_options.hh"

#include <cstring>

#if !defined(_WIN32)
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#endif

#include <webrtc/rtc_base/ip_address.h>
#include <webrtc/rtc_base/network.h>
#include <webrtc/rtc_base/socket_server.h>
#include <webrtc/rtc_base/thread.h>

#include "src/interfaces/rtc_peer_connection/peer_connection_factory.hh"

namespace node_webrtc {

NetworkOptions &NetworkOptions::Instance() {
  static auto *instance = new NetworkOptions();
  return *instance;
}

void NetworkOptions::ApplyTo(PeerConnectionFactory *factory) {
  if (factory == nullptr) {
    return;
  }
  std::vector<std::string> ignored;
  bool bind = false;
  {
    std::lock_guard<std::mutex> lock(_mutex);
    ignored = _ignored_interfaces;
    bind = _bind_sockets_to_interface;
  }
  auto *network_manager =
      static_cast<webrtc::BasicNetworkManager *>(factory->getNetworkManager());
  factory->WorkerThread()->BlockingCall([&]() {
    network_manager->set_network_ignore_list(ignored);
    factory->WorkerThread()->socketserver()->set_network_binder(
        bind ? this : nullptr);
  });
}

#if !defined(_WIN32)
static bool SameAddress(const sockaddr *addr, const webrtc::IPAddress &ip) {
  if (addr == nullptr) {
    return false;
  }
  if (addr->sa_family == AF_INET && ip.family() == AF_INET) {
    auto in = reinterpret_cast<const sockaddr_in *>(addr)->sin_addr;
    auto want = ip.ipv4_address();
    return std::memcmp(&in, &want, sizeof(in)) == 0;
  }
  if (addr->sa_family == AF_INET6 && ip.family() == AF_INET6) {
    auto in6 = reinterpret_cast<const sockaddr_in6 *>(addr)->sin6_addr;
    auto want = ip.ipv6_address();
    return std::memcmp(&in6, &want, sizeof(in6)) == 0;
  }
  return false;
}
#endif

webrtc::NetworkBindingResult
NetworkOptions::BindSocketToNetwork(int socket_fd,
                                    const webrtc::IPAddress &address) {
#if defined(_WIN32)
  (void)socket_fd;
  (void)address;
  return webrtc::NetworkBindingResult::NOT_IMPLEMENTED;
#else
  if (address.IsNil() || webrtc::IPIsAny(address)) {
    return webrtc::NetworkBindingResult::NOT_IMPLEMENTED;
  }
  _bind_calls++;
  std::string name;
  ifaddrs *addrs = nullptr;
  if (getifaddrs(&addrs) == 0) {
    for (auto *it = addrs; it != nullptr; it = it->ifa_next) {
      if (SameAddress(it->ifa_addr, address)) {
        name = it->ifa_name;
        break;
      }
    }
    freeifaddrs(addrs);
  }
  if (name.empty()) {
    _bind_failed++;
    return webrtc::NetworkBindingResult::ADDRESS_NOT_FOUND;
  }
  int result = -1;
#if defined(__APPLE__)
  unsigned int index = if_nametoindex(name.c_str());
  if (index != 0) {
    result = address.family() == AF_INET6
                 ? setsockopt(socket_fd, IPPROTO_IPV6, IPV6_BOUND_IF, &index,
                              sizeof(index))
                 : setsockopt(socket_fd, IPPROTO_IP, IP_BOUND_IF, &index,
                              sizeof(index));
  }
#elif defined(__linux__)
  result = setsockopt(socket_fd, SOL_SOCKET, SO_BINDTODEVICE, name.c_str(),
                      static_cast<socklen_t>(name.size()));
#endif
  if (result != 0) {
    _bind_failed++;
    return webrtc::NetworkBindingResult::FAILURE;
  }
  _bind_succeeded++;
  return webrtc::NetworkBindingResult::SUCCESS;
#endif
}

Napi::Value NetworkOptions::SetNetworkOptions(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "setNetworkOptions expects an object")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto options = info[0].As<Napi::Object>();
  auto &self = Instance();
  {
    std::lock_guard<std::mutex> lock(self._mutex);
    if (options.Has("ignoredInterfaces")) {
      auto value = options.Get("ignoredInterfaces");
      if (!value.IsArray()) {
        Napi::TypeError::New(env, "ignoredInterfaces must be an array")
            .ThrowAsJavaScriptException();
        return env.Undefined();
      }
      auto array = value.As<Napi::Array>();
      std::vector<std::string> ignored;
      for (uint32_t i = 0; i < array.Length(); i++) {
        auto item = array.Get(i);
        if (!item.IsString()) {
          Napi::TypeError::New(env, "ignoredInterfaces must be strings")
              .ThrowAsJavaScriptException();
          return env.Undefined();
        }
        ignored.push_back(item.As<Napi::String>().Utf8Value());
      }
      self._ignored_interfaces = ignored;
    }
    if (options.Has("bindSocketsToInterface")) {
      self._bind_sockets_to_interface =
          options.Get("bindSocketsToInterface").ToBoolean().Value();
    }
  }
  self.ApplyTo(PeerConnectionFactory::Current());
  return env.Undefined();
}

Napi::Value
NetworkOptions::GetNetworkBindingStats(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  auto &self = Instance();
  auto object = Napi::Object::New(env);
  object.Set("calls", Napi::Number::New(
                          env, static_cast<double>(self._bind_calls.load())));
  object.Set("succeeded",
             Napi::Number::New(
                 env, static_cast<double>(self._bind_succeeded.load())));
  object.Set("failed", Napi::Number::New(
                           env, static_cast<double>(self._bind_failed.load())));
  return object;
}

void NetworkOptions::Init(Napi::Env env, Napi::Object exports) {
  exports.Set("setNetworkOptions",
              Napi::Function::New(env, &NetworkOptions::SetNetworkOptions));
  exports.Set("getNetworkBindingStats",
              Napi::Function::New(env, &NetworkOptions::GetNetworkBindingStats));
}

} // namespace node_webrtc
