/* Copyright (c) 2026 The node-webrtc project authors. All rights reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be found
 * in the LICENSE.md file in the root of the source tree. All contributing
 * project authors may be found in the AUTHORS file in the root of the source
 * tree.
 */
#include "src/methods/connect_bound.hh"

#include <cerrno>
#include <cstring>
#include <string>

#if !defined(_WIN32)
#include <arpa/inet.h>
#include <fcntl.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace node_webrtc {

namespace {

constexpr int kDefaultTimeoutMs = 10000;

#if !defined(_WIN32)
bool ParseAddress(const std::string &text, uint16_t port,
                  sockaddr_storage *out, socklen_t *length) {
  std::memset(out, 0, sizeof(*out));
  auto *v4 = reinterpret_cast<sockaddr_in *>(out);
  if (inet_pton(AF_INET, text.c_str(), &v4->sin_addr) == 1) {
    v4->sin_family = AF_INET;
    v4->sin_port = htons(port);
    *length = sizeof(sockaddr_in);
    return true;
  }
  auto *v6 = reinterpret_cast<sockaddr_in6 *>(out);
  if (inet_pton(AF_INET6, text.c_str(), &v6->sin6_addr) == 1) {
    v6->sin6_family = AF_INET6;
    v6->sin6_port = htons(port);
    *length = sizeof(sockaddr_in6);
    return true;
  }
  return false;
}

std::string Describe(const char *step, int error) {
  return std::string(step) + ": " + std::strerror(error);
}

// Pins `fd` to `interface_name`; returns 0 or an errno.
int Pin(int fd, int family, const std::string &interface_name) {
#if defined(__APPLE__)
  unsigned int index = if_nametoindex(interface_name.c_str());
  if (index == 0) {
    return ENXIO;
  }
  int result = family == AF_INET6
                   ? setsockopt(fd, IPPROTO_IPV6, IPV6_BOUND_IF, &index,
                                sizeof(index))
                   : setsockopt(fd, IPPROTO_IP, IP_BOUND_IF, &index,
                                sizeof(index));
  return result == 0 ? 0 : errno;
#elif defined(__linux__)
  (void)family;
  int result = setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE,
                          interface_name.c_str(),
                          static_cast<socklen_t>(interface_name.size()));
  return result == 0 ? 0 : errno;
#else
  (void)fd;
  (void)family;
  (void)interface_name;
  return ENOTSUP;
#endif
}
#endif

class ConnectBoundWorker : public Napi::AsyncWorker {
public:
  ConnectBoundWorker(Napi::Env env, std::string address, uint16_t port,
                     std::string interface_name, int timeout_ms)
      : Napi::AsyncWorker(env), _deferred(Napi::Promise::Deferred::New(env)),
        _address(std::move(address)), _port(port),
        _interface_name(std::move(interface_name)), _timeout_ms(timeout_ms) {}

  Napi::Promise Promise() { return _deferred.Promise(); }

  void Execute() override {
#if defined(_WIN32)
    SetError("connectBound is not supported on Windows");
#else
    sockaddr_storage target{};
    socklen_t length = 0;
    if (!ParseAddress(_address, _port, &target, &length)) {
      SetError("connectBound: address must be an IP literal");
      return;
    }
    int fd = socket(target.ss_family, SOCK_STREAM, 0);
    if (fd < 0) {
      SetError(Describe("socket", errno));
      return;
    }
    fcntl(fd, F_SETFD, FD_CLOEXEC);
    int error = Pin(fd, target.ss_family, _interface_name);
    if (error != 0) {
      close(fd);
      SetError(Describe(("pin to " + _interface_name).c_str(), error));
      return;
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    if (connect(fd, reinterpret_cast<sockaddr *>(&target), length) != 0) {
      if (errno != EINPROGRESS) {
        error = errno;
        close(fd);
        SetError(Describe("connect", error));
        return;
      }
      pollfd waiting{fd, POLLOUT, 0};
      int ready = poll(&waiting, 1, _timeout_ms);
      if (ready <= 0) {
        error = ready == 0 ? ETIMEDOUT : errno;
        close(fd);
        SetError(Describe("connect", error));
        return;
      }
      socklen_t size = sizeof(error);
      if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) != 0) {
        error = errno;
      }
      if (error != 0) {
        close(fd);
        SetError(Describe("connect", error));
        return;
      }
    }
    _fd = fd;
#endif
  }

  void OnOK() override {
    _deferred.Resolve(Napi::Number::New(Env(), _fd));
  }

  void OnError(const Napi::Error &error) override {
    _deferred.Reject(error.Value());
  }

private:
  Napi::Promise::Deferred _deferred;
  std::string _address;
  uint16_t _port;
  std::string _interface_name;
  int _timeout_ms;
  int _fd = -1;
};

Napi::Value ConnectBoundMethod(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  if (info.Length() < 3 || !info[0].IsString() || !info[1].IsNumber() ||
      !info[2].IsString()) {
    Napi::TypeError::New(
        env, "connectBound(address, port, interfaceName, timeoutMs?)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto address = info[0].As<Napi::String>().Utf8Value();
#if !defined(_WIN32)
  sockaddr_storage probe{};
  socklen_t probe_length = 0;
  if (!ParseAddress(address, 1, &probe, &probe_length)) {
    Napi::TypeError::New(env, "connectBound: address must be an IP literal")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
#endif
  auto port = info[1].As<Napi::Number>().Int32Value();
  if (port < 1 || port > 65535) {
    Napi::TypeError::New(env, "connectBound: port must be 1-65535")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  auto timeout_ms = info.Length() > 3 && info[3].IsNumber()
                        ? info[3].As<Napi::Number>().Int32Value()
                        : kDefaultTimeoutMs;
  auto *worker = new ConnectBoundWorker(
      env, address, static_cast<uint16_t>(port),
      info[2].As<Napi::String>().Utf8Value(),
      timeout_ms > 0 ? timeout_ms : kDefaultTimeoutMs);
  auto promise = worker->Promise();
  worker->Queue();
  return promise;
}

} // namespace

void ConnectBound::Init(Napi::Env env, Napi::Object exports) {
  exports.Set("connectBound", Napi::Function::New(env, &ConnectBoundMethod));
}

} // namespace node_webrtc
