/* Copyright (c) 2019 The node-webrtc project authors. All rights reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be found
 * in the LICENSE.md file in the root of the source tree. All contributing
 * project authors may be found in the AUTHORS file in the root of the source
 * tree.
 */
#pragma once

#include <functional>
#include <memory>
#include <mutex>
#include <vector>

#include <webrtc/api/data_channel_interface.h>
#include <webrtc/api/scoped_refptr.h>

#include "src/enums/node_webrtc/binary_type.hh"
#include "src/interfaces/rtc_peer_connection/peer_connection_factory.hh"
#include "src/node/async_object_wrap_with_loop.hh"
#include "src/node/event_queue.hh"
#include "src/node/ref_ptr.hh"
#include "src/node/wrap.hh"

namespace node_webrtc {

class DataChannelObserver;

class RTCDataChannel : public AsyncObjectWrapWithLoop<RTCDataChannel>,
                       public webrtc::DataChannelObserver {
  friend class node_webrtc::DataChannelObserver;

public:
  explicit RTCDataChannel(const Napi::CallbackInfo &);
  ~RTCDataChannel() override;

  RTCDataChannel(const RTCDataChannel &) = delete;
  RTCDataChannel(RTCDataChannel &&) = delete;
  RTCDataChannel &operator=(const RTCDataChannel &) = delete;
  RTCDataChannel &operator=(RTCDataChannel &&) = delete;

  static Napi::FunctionReference &constructor();

  static void Init(Napi::Env, Napi::Object);

  // createDataChannel() hands out a channel that starts "connecting", as in a
  // browser, even when the native channel is already open; "open" follows.
  void StartAsLocal();

  // Runs `announce` (the remote side's "datachannel") once the channel is
  // open, right before its "open" event, so the handler sees readyState
  // "open" and can send. libwebrtc can report a remote channel while its DCEP
  // ACK is still queued; announcing it then made sends from the handler fail.
  // Dropped if the channel closes first.
  void AnnounceWhenOpen(std::function<void()> announce);

  //
  // DataChannelObserver implementation.
  //
  void OnStateChange() override;
  void OnMessage(const webrtc::DataBuffer &buffer) override;
  void OnBufferedAmountChange(uint64_t sent_data_size) override;
  // Without this, libwebrtc routes callbacks through an adapter whose
  // SetDelegate() drops callbacks that are still in flight when the observer
  // is replaced, so messages arriving during the hand-off were lost.
  bool IsOkToCallOnTheNetworkThread() override { return true; }

  void OnPeerConnectionClosed();

  static ::node_webrtc::Wrap<
      RTCDataChannel *, webrtc::scoped_refptr<webrtc::DataChannelInterface>,
      node_webrtc::DataChannelObserver *> *
  wrap();

private:
  static RTCDataChannel *
  Create(node_webrtc::DataChannelObserver *,
         webrtc::scoped_refptr<webrtc::DataChannelInterface>);

  static void HandleStateChange(RTCDataChannel &,
                                webrtc::DataChannelInterface::DataState);
  static void HandleMessage(RTCDataChannel &, const webrtc::DataBuffer &buffer);

  Napi::Value Send(const Napi::CallbackInfo &);
  Napi::Value Close(const Napi::CallbackInfo &);

  Napi::Value GetBufferedAmount(const Napi::CallbackInfo &);
  Napi::Value GetId(const Napi::CallbackInfo &);
  Napi::Value GetLabel(const Napi::CallbackInfo &);
  Napi::Value GetMaxPacketLifeTime(const Napi::CallbackInfo &);
  Napi::Value GetMaxRetransmits(const Napi::CallbackInfo &);
  Napi::Value GetNegotiated(const Napi::CallbackInfo &);
  Napi::Value GetOrdered(const Napi::CallbackInfo &);
  Napi::Value GetPriority(const Napi::CallbackInfo &);
  Napi::Value GetProtocol(const Napi::CallbackInfo &);
  Napi::Value GetBinaryType(const Napi::CallbackInfo &);
  Napi::Value GetReadyState(const Napi::CallbackInfo &);
  Napi::Value GetBufferedAmountLowThreshold(const Napi::CallbackInfo &);
  void SetBinaryType(const Napi::CallbackInfo &, const Napi::Value &);
  void SetBufferedAmountLowThreshold(const Napi::CallbackInfo &,
                                     const Napi::Value &);

  void CleanupInternals();
  // bufferedAmount: the tracked amount, capped by the native one while it is
  // above zero (see GetBufferedAmount).
  uint64_t QueuedAmount() const;
  // Callbacks from libwebrtc go through here. While the constructor hands the
  // channel over from its DataChannelObserver, events delivered to `this` are
  // held back until the observer's cached (older) events have been queued.
  void DispatchInOrder(std::unique_ptr<Event<RTCDataChannel>> event);

  BinaryType _binaryType;
  int _cached_id;
  std::string _cached_label;
  uint16_t _cached_max_packet_life_time;
  uint16_t _cached_max_retransmits;
  bool _cached_negotiated;
  bool _cached_ordered;
  std::string _cached_protocol;
  // JS-visible state, only touched on the JS thread. The tracked
  // bufferedAmount grows when send() hands data to libwebrtc and shrinks when
  // libwebrtc reports it sent (as a task), like blink does; once the native
  // channel is gone it holds the last native value. readyState follows the
  // events delivered to JS.
  uint64_t _buffered_amount = 0;
  uint64_t _buffered_amount_low_threshold = 0;
  // Set by a send() that takes bufferedAmount above the threshold; the next
  // OnBufferedAmountChange that finds it at or below fires bufferedamountlow.
  bool _low_armed = false;
  webrtc::DataChannelInterface::DataState _ready_state =
      webrtc::DataChannelInterface::kConnecting;
  bool _open_dispatched = false;
  std::function<void()> _announce;
  std::mutex _adopt_mutex;
  bool _adopting = false;
  std::vector<std::unique_ptr<Event<RTCDataChannel>>> _adopt_pending;
  RefPtr<PeerConnectionFactory> _factory;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> _jingleDataChannel;
};

class DataChannelObserver : public EventQueue<RTCDataChannel>,
                            public webrtc::DataChannelObserver {
  friend class RTCDataChannel;

public:
  DataChannelObserver(
      PeerConnectionFactory *factory,
      webrtc::scoped_refptr<webrtc::DataChannelInterface> jingleDataChannel);
  ~DataChannelObserver() override = default;

  DataChannelObserver(const DataChannelObserver &) = delete;
  DataChannelObserver(DataChannelObserver &&) = delete;
  DataChannelObserver &operator=(const DataChannelObserver &) = delete;
  DataChannelObserver &operator=(DataChannelObserver &&) = delete;

  bool IsOkToCallOnTheNetworkThread() override { return true; }
  void OnStateChange() override;
  void OnMessage(const webrtc::DataBuffer &buffer) override;

  webrtc::scoped_refptr<webrtc::DataChannelInterface> channel() {
    return _jingleDataChannel;
  }

private:
  // Raw, not RefPtr: OnDataChannel constructs this on the signaling thread,
  // and RefPtr's Ref()/Unref() are N-API calls that must only run on the main
  // thread. RTCDataChannel takes the strong reference when it adopts this
  // observer on the main thread. The RTCPeerConnection that created this
  // observer keeps the factory alive until then.
  PeerConnectionFactory *_factory;
  webrtc::scoped_refptr<webrtc::DataChannelInterface> _jingleDataChannel;
};

} // namespace node_webrtc
