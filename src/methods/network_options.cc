/* Copyright (c) 2026 The node-webrtc project authors. All rights reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be found
 * in the LICENSE.md file in the root of the source tree. All contributing
 * project authors may be found in the AUTHORS file in the root of the source
 * tree.
 */
#include "src/methods/network_options.hh"

#include <cstdlib>
#include <cstring>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#else
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#endif
#include <algorithm>

#include <webrtc/rtc_base/ip_address.h>
#include <webrtc/rtc_base/network.h>
#include <webrtc/rtc_base/socket_server.h>
#include <webrtc/rtc_base/thread.h>

#include "src/interfaces/rtc_peer_connection/peer_connection_factory.hh"

namespace node_webrtc {

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

#if defined(_WIN32)
template <typename F> static void ForEachAdapter(F visit) {
  ULONG size = 16 * 1024;
  std::vector<unsigned char> buffer;
  for (int attempt = 0; attempt < 3; attempt++) {
    buffer.resize(size);
    auto *first = reinterpret_cast<IP_ADAPTER_ADDRESSES *>(buffer.data());
    auto ret = GetAdaptersAddresses(AF_UNSPEC,
                                    GAA_FLAG_SKIP_ANYCAST |
                                        GAA_FLAG_SKIP_MULTICAST |
                                        GAA_FLAG_SKIP_DNS_SERVER,
                                    nullptr, first, &size);
    if (ret == ERROR_BUFFER_OVERFLOW) {
      continue;
    }
    if (ret != NO_ERROR) {
      return;
    }
    for (auto *adapter = first; adapter != nullptr; adapter = adapter->Next) {
      visit(adapter);
    }
    return;
  }
}

static std::string ToUtf8(const wchar_t *text) {
  if (text == nullptr) {
    return {};
  }
  int length = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr,
                                   nullptr);
  if (length <= 1) {
    return {};
  }
  std::string out(static_cast<size_t>(length - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, text, -1, out.data(), length, nullptr,
                      nullptr);
  return out;
}
#endif

// libwebrtc names a Windows network after its adapter GUID (AdapterName),
// while Node's os.networkInterfaces() reports the friendly name; accept both.
static std::vector<std::string>
ExpandInterfaceNames(const std::vector<std::string> &names) {
  std::vector<std::string> out = names;
#if defined(_WIN32)
  ForEachAdapter([&](IP_ADAPTER_ADDRESSES *adapter) {
    auto friendly = ToUtf8(adapter->FriendlyName);
    if (std::find(names.begin(), names.end(), friendly) != names.end() &&
        adapter->AdapterName != nullptr) {
      out.emplace_back(adapter->AdapterName);
    }
  });
#endif
  return out;
}

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
    ignored = ExpandInterfaceNames(_ignored_interfaces);
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


#if defined(_WIN32)
static int PinSocket(int socket_fd, const webrtc::IPAddress &address) {
  int result = -1;
  bool found = false;
  ForEachAdapter([&](IP_ADAPTER_ADDRESSES *adapter) {
    for (auto *unicast = adapter->FirstUnicastAddress;
         !found && unicast != nullptr; unicast = unicast->Next) {
      if (!SameAddress(unicast->Address.lpSockaddr, address)) {
        continue;
      }
      found = true;
      auto socket = static_cast<SOCKET>(socket_fd);
      if (address.family() == AF_INET6) {
        DWORD index = adapter->Ipv6IfIndex;
        result = setsockopt(socket, IPPROTO_IPV6, IPV6_UNICAST_IF,
                            reinterpret_cast<const char *>(&index),
                            sizeof(index));
      } else {
        DWORD index = htonl(adapter->IfIndex);
        result = setsockopt(socket, IPPROTO_IP, IP_UNICAST_IF,
                            reinterpret_cast<const char *>(&index),
                            sizeof(index));
      }
    }
  });
  return result;
}
#else
static int PinSocket(int socket_fd, const webrtc::IPAddress &address) {
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
    return -1;
  }
#if defined(__APPLE__)
  unsigned int index = if_nametoindex(name.c_str());
  if (index == 0) {
    return -1;
  }
  return address.family() == AF_INET6
             ? setsockopt(socket_fd, IPPROTO_IPV6, IPV6_BOUND_IF, &index,
                          sizeof(index))
             : setsockopt(socket_fd, IPPROTO_IP, IP_BOUND_IF, &index,
                          sizeof(index));
#elif defined(__linux__)
  return setsockopt(socket_fd, SOL_SOCKET, SO_BINDTODEVICE, name.c_str(),
                    static_cast<socklen_t>(name.size()));
#else
  return -1;
#endif
}
#endif

webrtc::NetworkBindingResult
NetworkOptions::BindSocketToNetwork(int socket_fd,
                                    const webrtc::IPAddress &address) {
  if (address.IsNil() || webrtc::IPIsAny(address)) {
    return webrtc::NetworkBindingResult::NOT_IMPLEMENTED;
  }
  _bind_calls++;
  // Any result but SUCCESS / NOT_IMPLEMENTED fails PhysicalSocket::Bind, and
  // the port allocator then retries every port in the range (tens of
  // thousands of attempts per socket). When a socket cannot be pinned (e.g.
  // SO_BINDTODEVICE without the capability), fall back to the plain bind().
  if (std::getenv("NODE_WEBRTC_TEST_BIND_FAIL") != nullptr ||
      PinSocket(socket_fd, address) != 0) {
    _bind_failed++;
    return webrtc::NetworkBindingResult::NOT_IMPLEMENTED;
  }
  _bind_succeeded++;
  return webrtc::NetworkBindingResult::SUCCESS;
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
