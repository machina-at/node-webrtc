/* Copyright (c) 2019 The node-webrtc project authors. All rights reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be found
 * in the LICENSE.md file in the root of the source tree. All contributing
 * project authors may be found in the AUTHORS file in the root of the source
 * tree.
 */
#pragma once

#include <memory>
#include <mutex>
#include <optional>

#include <node-addon-api/napi.h>
#include <webrtc/api/environment/environment.h>
#include <webrtc/api/peer_connection_interface.h>
#include <webrtc/api/scoped_refptr.h>
#include <webrtc/modules/audio_device/include/audio_device.h>
#include <webrtc/rtc_base/thread.h>

namespace node_webrtc {

class PeerConnectionFactory : public Napi::ObjectWrap<PeerConnectionFactory> {
public:
  PeerConnectionFactory(const PeerConnectionFactory &) = delete;
  PeerConnectionFactory(PeerConnectionFactory &&) = delete;
  PeerConnectionFactory &operator=(const PeerConnectionFactory &) = delete;
  PeerConnectionFactory &operator=(PeerConnectionFactory &&) = delete;
  explicit PeerConnectionFactory(const Napi::CallbackInfo &);

  ~PeerConnectionFactory() override;

  /**
   * Get or create the default PeerConnectionFactory. The default uses
   * webrtc::AudioDeviceModule::AudioLayer::kDummyAudio. Call {@link Release}
   * when done.
   */
  static PeerConnectionFactory *GetOrCreateDefault();

  /**
   * Release a reference to the default PeerConnectionFactory.
   */
  static void Release();

  // The current default factory, or nullptr if none is alive.
  static PeerConnectionFactory *Current();

  /**
   * Get the underlying webrtc::PeerConnectionFactoryInterface.
   */
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory() {
    return _factory;
  }

  std::unique_ptr<webrtc::Thread> &SignalingThread() { return _signalingThread; }

  std::unique_ptr<webrtc::Thread> &WorkerThread() { return _workerThread; }

  const webrtc::Environment &getEnvironment() { return *_environment; }

  webrtc::NetworkManager *getNetworkManager() { return _networkManager.get(); }

  webrtc::PacketSocketFactory *getSocketFactory() { return _socketFactory.get(); }

  static void Init(Napi::Env, Napi::Object);

  static Napi::FunctionReference &constructor();

  static void Dispose();

private:
  std::optional<webrtc::Environment> _environment;
  std::unique_ptr<webrtc::Thread> _signalingThread;
  std::unique_ptr<webrtc::Thread> _workerThread;

  static PeerConnectionFactory *_default; // NOLINT
  static std::mutex _mutex;               // NOLINT
  static int _references;                 // NOLINT

  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> _factory;
  webrtc::scoped_refptr<webrtc::AudioDeviceModule> _audioDeviceModule;

  std::unique_ptr<webrtc::NetworkManager> _networkManager;
  std::unique_ptr<webrtc::PacketSocketFactory> _socketFactory;
};

} // namespace node_webrtc
