/* Copyright (c) 2019 The node-webrtc project authors. All rights reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be found
 * in the LICENSE.md file in the root of the source tree. All contributing
 * project authors may be found in the AUTHORS file in the root of the source
 * tree.
 */
#include "src/interfaces/rtc_data_channel.hh"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <thread>
#include <utility>

#include <webrtc/api/data_channel_interface.h>
#include <webrtc/api/scoped_refptr.h>
#include <webrtc/rtc_base/copy_on_write_buffer.h>

#include "src/enums/node_webrtc/binary_type.hh"
#include "src/enums/webrtc/data_state.hh"
#include "src/interfaces/rtc_peer_connection/peer_connection_factory.hh"
#include "src/node/error_factory.hh"
#include "src/node/events.hh"

namespace node_webrtc {

Napi::FunctionReference &RTCDataChannel::constructor() {
  static Napi::FunctionReference constructor;
  return constructor;
}

DataChannelObserver::DataChannelObserver(
    PeerConnectionFactory *factory,
    webrtc::scoped_refptr<webrtc::DataChannelInterface> jingleDataChannel)
    : _factory(factory), _jingleDataChannel(std::move(jingleDataChannel)) {
  _jingleDataChannel->RegisterObserver(this);
}

void DataChannelObserver::OnStateChange() {
  auto state = _jingleDataChannel->state();
  Enqueue(Callback1<RTCDataChannel>::Create([state](RTCDataChannel &channel) {
    RTCDataChannel::HandleStateChange(channel, state);
  }));
}

void DataChannelObserver::OnMessage(const webrtc::DataBuffer &buffer) {
  Enqueue(Callback1<RTCDataChannel>::Create([buffer](RTCDataChannel &channel) {
    RTCDataChannel::HandleMessage(channel, buffer);
  }));
}

static void requeue(DataChannelObserver &observer, RTCDataChannel &channel) {
  while (auto event = observer.Dequeue()) {
    channel.Dispatch(std::move(event));
  }
}

// Test hook: NODE_WEBRTC_TEST_ADOPT_DELAY_MS widens the window between
// RegisterObserver() and re-queueing the observer's cached events, so tests
// can hit the hand-off deterministically. Unset in production.
static void TestAdoptDelay() {
  static const int delay_ms = [] {
    const char *value = std::getenv("NODE_WEBRTC_TEST_ADOPT_DELAY_MS");
    return value ? std::atoi(value) : 0;
  }();
  if (delay_ms > 0) {
    std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
  }
}

// Test hook: NODE_WEBRTC_TEST_REMOTE_STARTS_CONNECTING makes every wrapper
// start as if its native channel had not opened yet, the way libwebrtc can
// report a remote channel whose DCEP ACK is still queued. Unset in production.
static bool TestStartsConnecting() {
  static const bool on =
      std::getenv("NODE_WEBRTC_TEST_REMOTE_STARTS_CONNECTING") != nullptr;
  return on;
}

RTCDataChannel::RTCDataChannel(const Napi::CallbackInfo &info)
    : AsyncObjectWrapWithLoop<RTCDataChannel>("RTCDataChannel", *this, info),
      _binaryType(BinaryType::kArrayBuffer) {
  auto env = info.Env();

  if (!info.IsConstructCall() || !info[0].IsExternal()) {
    Napi::TypeError::New(
        env, "Use the new operator to construct the RTCDataChannel.")
        .ThrowAsJavaScriptException();
    return;
  }

  auto observer =
      info[0].As<Napi::External<node_webrtc::DataChannelObserver>>().Data();

  _factory = observer->_factory;

  _jingleDataChannel = observer->_jingleDataChannel;
  _ready_state = TestStartsConnecting()
                     ? webrtc::DataChannelInterface::kConnecting
                     : _jingleDataChannel->state();

  // Events delivered to `this` after RegisterObserver() are newer than the
  // ones the observer cached; hold them until the cached ones are queued.
  {
    std::lock_guard<std::mutex> lock(_adopt_mutex);
    _adopting = true;
  }
  _jingleDataChannel->RegisterObserver(this);
  TestAdoptDelay();
  {
    std::lock_guard<std::mutex> lock(_adopt_mutex);
    requeue(*observer, *this);
    for (auto &event : _adopt_pending) {
      Dispatch(std::move(event));
    }
    _adopt_pending.clear();
    _adopting = false;
  }

  delete observer;

  // A channel created on an established SCTP association can already be open
  // before any observer was registered, in which case libwebrtc never reports
  // the transition. Queued after the events above, so a cached "open" wins.
  Dispatch(CreateCallback<RTCDataChannel>([this]() {
    if (!_open_dispatched && _jingleDataChannel != nullptr &&
        _jingleDataChannel->state() == webrtc::DataChannelInterface::kOpen) {
      RTCDataChannel::HandleStateChange(*this,
                                        webrtc::DataChannelInterface::kOpen);
    }
  }));

  // NOTE(mroberts): These doesn't actually matter yet.
  _cached_id = 0;
  _cached_max_packet_life_time = 0;
  _cached_max_retransmits = 0;
  _cached_negotiated = false;
  _cached_ordered = false;
}

void RTCDataChannel::StartAsLocal() {
  if (_ready_state == webrtc::DataChannelInterface::kOpen &&
      !_open_dispatched) {
    _ready_state = webrtc::DataChannelInterface::kConnecting;
  }
}

void RTCDataChannel::AnnounceWhenOpen(std::function<void()> announce) {
  if (_ready_state == webrtc::DataChannelInterface::kOpen) {
    announce();
    return;
  }
  _announce = std::move(announce);
}

void RTCDataChannel::DispatchInOrder(
    std::unique_ptr<Event<RTCDataChannel>> event) {
  std::lock_guard<std::mutex> lock(_adopt_mutex);
  if (_adopting) {
    _adopt_pending.push_back(std::move(event));
    return;
  }
  Dispatch(std::move(event));
}

RTCDataChannel::~RTCDataChannel() { wrap()->Release(this); }

void RTCDataChannel::CleanupInternals() {
  if (_jingleDataChannel == nullptr) {
    return;
  }
  _jingleDataChannel->UnregisterObserver();
  _buffered_amount = _jingleDataChannel->buffered_amount();
  _cached_id = _jingleDataChannel->id();
  _cached_label = _jingleDataChannel->label();
  _cached_max_packet_life_time = static_cast<uint16_t>(
      _jingleDataChannel->maxPacketLifeTime().value_or(-1));
  _cached_max_retransmits = static_cast<uint16_t>(
      _jingleDataChannel->maxRetransmitsOpt().value_or(-1));
  _cached_negotiated = _jingleDataChannel->negotiated();
  _cached_ordered = _jingleDataChannel->ordered();
  _cached_protocol = _jingleDataChannel->protocol();
  _jingleDataChannel = nullptr;
}

void RTCDataChannel::OnPeerConnectionClosed() {
  if (_jingleDataChannel != nullptr) {
    // Since M11x the closed state is delivered asynchronously, after
    // PeerConnection::Close() has returned. Unregister and emit "close" here
    // so the event is not lost when the wrap caches are cleared.
    CleanupInternals();
    Dispatch(CreateCallback<RTCDataChannel>([this]() {
      RTCDataChannel::HandleStateChange(*this,
                                        webrtc::DataChannelInterface::kClosed);
    }));
  }
}

void RTCDataChannel::OnStateChange() {
  auto state = _jingleDataChannel->state();
  // This runs on the network thread. UnregisterObserver() blocks on the
  // signaling thread, which may itself be waiting on the network thread (e.g.
  // inside PeerConnection::Close()), so clean up on the JS thread instead.
  DispatchInOrder(CreateCallback<RTCDataChannel>([this, state]() {
    if (state == webrtc::DataChannelInterface::kClosed) {
      if (_jingleDataChannel == nullptr) {
        // OnPeerConnectionClosed() already emitted "close".
        return;
      }
      CleanupInternals();
    }
    RTCDataChannel::HandleStateChange(*this, state);
  }));
}

void RTCDataChannel::HandleStateChange(
    RTCDataChannel &channel, webrtc::DataChannelInterface::DataState state) {
  if (state == webrtc::DataChannelInterface::kOpen) {
    if (channel._open_dispatched) {
      return;
    }
    channel._open_dispatched = true;
  }
  channel._ready_state = state;
  auto env = channel.Env();
  Napi::HandleScope scope(env);
  if (channel._announce) {
    auto announce = std::move(channel._announce);
    channel._announce = nullptr;
    // A channel that closes before it opens is never announced.
    if (state == webrtc::DataChannelInterface::kOpen) {
      announce();
    }
  }
  auto object = Napi::Object::New(env);
  if (state == webrtc::DataChannelInterface::kClosed) {
    object.Set("type", Napi::String::New(env, "close"));
  } else if (state == webrtc::DataChannelInterface::kOpen) {
    object.Set("type", Napi::String::New(env, "open"));
  }
  channel.MakeCallback("dispatchEvent", {object});
  if (state == webrtc::DataChannelInterface::kClosed) {
    channel.Stop();
  }
}

void RTCDataChannel::OnMessage(const webrtc::DataBuffer &buffer) {
  DispatchInOrder(CreateCallback<RTCDataChannel>(
      [this, buffer]() { RTCDataChannel::HandleMessage(*this, buffer); }));
}

void RTCDataChannel::OnBufferedAmountChange(uint64_t sent_data_size) {
  DispatchInOrder(CreateCallback<RTCDataChannel>([this, sent_data_size]() {
    _buffered_amount -= std::min(_buffered_amount, sent_data_size);
    if (!_low_armed || _jingleDataChannel == nullptr) {
      return;
    }
    if (QueuedAmount() <= _buffered_amount_low_threshold) {
      _low_armed = false;
      auto env = Env();
      Napi::HandleScope scope(env);
      auto object = Napi::Object::New(env);
      object.Set("type", Napi::String::New(env, "bufferedamountlow"));
      MakeCallback("dispatchEvent", {object});
    }
  }));
}

void RTCDataChannel::HandleMessage(RTCDataChannel &channel,
                                   const webrtc::DataBuffer &buffer) {
  bool binary = buffer.binary;
  size_t size = buffer.size();

  auto env = channel.Env();
  Napi::HandleScope scope(env);
  Napi::Value value;
  if (binary) {
    char *message = new char[size];
    memcpy(message, buffer.data.data(), size);
    auto array =
        Napi::ArrayBuffer::New(env, message, size, [](Napi::Env, void *buffer) {
          delete[] static_cast<char *>(buffer);
        });
    value = array;
  } else {
    // SAFETY: this reinterpret_cast is correct; if the message is not binary,
    // it should be a valid UTF-8 string.
    // NOLINTBEGIN(cppcoreguidelines-pro-type-reinterpret-cast)
    auto str = Napi::String::New(
        env, reinterpret_cast<const char *>(buffer.data.data()), size);
    // NOLINTEND(cppcoreguidelines-pro-type-reinterpret-cast)
    value = str;
  }
  auto object = Napi::Object::New(env);
  object.Set("type", "message");
  object.Set("data", value);
  channel.MakeCallback("dispatchEvent", {object});
}

Napi::Value RTCDataChannel::Send(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  // The cached state lags the native one until the "open" event runs; a
  // channel the remote side already uses (its "datachannel" fired) must be
  // writable, so ask the native channel only when the cache says otherwise.
  if (_jingleDataChannel == nullptr ||
      (_ready_state != webrtc::DataChannelInterface::kOpen &&
       _jingleDataChannel->state() != webrtc::DataChannelInterface::kOpen)) {
    Napi::Error(env, ErrorFactory::CreateInvalidStateError(
                         env, "RTCDataChannel.readyState is not 'open'"))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  std::unique_ptr<webrtc::DataBuffer> buffer;
  if (info[0].IsString()) {
    auto str = info[0].ToString();
    buffer = std::make_unique<webrtc::DataBuffer>(str.Utf8Value());
  } else {
    Napi::ArrayBuffer arraybuffer;
    size_t byte_offset = 0;
    size_t byte_length = 0;

    if (info[0].IsTypedArray()) {
      auto typedArray = info[0].As<Napi::TypedArray>();
      arraybuffer = typedArray.ArrayBuffer();
      byte_offset = typedArray.ByteOffset();
      byte_length = typedArray.ByteLength();
    } else if (info[0].IsDataView()) {
      auto dataView = info[0].As<Napi::DataView>();
      arraybuffer = dataView.ArrayBuffer();
      byte_offset = dataView.ByteOffset();
      byte_length = dataView.ByteLength();
    } else if (info[0].IsArrayBuffer()) {
      arraybuffer = info[0].As<Napi::ArrayBuffer>();
      byte_length = arraybuffer.ByteLength();
    } else {
      Napi::TypeError::New(env, "Expected a Blob or ArrayBuffer")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

#pragma clang unsafe_buffer_usage begin
    auto content = static_cast<char *>(arraybuffer.Data());
    webrtc::CopyOnWriteBuffer data(content + byte_offset, byte_length);
#pragma clang unsafe_buffer_usage end

    buffer = std::make_unique<webrtc::DataBuffer>(data, true);
  }

  // libwebrtc closes the channel abruptly when its send queue overflows, which
  // also drops the message. Refuse up front, like blink does. The tracked
  // amount is an upper bound, so the native one is read only near the limit.
  auto size = static_cast<uint64_t>(buffer->size());
  auto limit = webrtc::DataChannelInterface::MaxSendQueueSize();
  if (_buffered_amount + size > limit && QueuedAmount() + size > limit) {
    Napi::Error(env, ErrorFactory::CreateOperationError(
                         env, "RTCDataChannel send queue is full"))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (_buffered_amount + size > _buffered_amount_low_threshold) {
    _low_armed = true;
  }
  // Counted before Send() and kept on failure: libwebrtc adds every message it
  // is handed to its own count, and reports decreases against that.
  _buffered_amount += size;
  if (!_jingleDataChannel->Send(*buffer)) {
    if (_jingleDataChannel->state() !=
        webrtc::DataChannelInterface::DataState::kOpen) {
      Napi::Error(env, ErrorFactory::CreateInvalidStateError(
                           env, "RTCDataChannel.readyState is not 'open'"))
          .ThrowAsJavaScriptException();
    } else {
      Napi::Error(env, ErrorFactory::CreateOperationError(
                           env, "RTCDataChannel failed to send the message"))
          .ThrowAsJavaScriptException();
    }
    return env.Undefined();
  }

  return env.Undefined();
}

Napi::Value RTCDataChannel::Close(const Napi::CallbackInfo &info) {
  if (_jingleDataChannel != nullptr) {
    if (_ready_state == webrtc::DataChannelInterface::kConnecting ||
        _ready_state == webrtc::DataChannelInterface::kOpen) {
      _ready_state = webrtc::DataChannelInterface::kClosing;
    }
    _jingleDataChannel->Close();
  }
  return info.Env().Undefined();
}

// The tracked amount mirrors libwebrtc's own count: it grows on send() and
// shrinks when libwebrtc reports data sent, so it never falls below what is
// really queued. Zero is therefore exact and needs no thread hop. Above zero
// the native value is read as well: libwebrtc reports decreases only in
// 100 KiB steps or at zero, and can skip the report at zero, so the tracked
// value alone could stay above zero after the data has left.
uint64_t RTCDataChannel::QueuedAmount() const {
  if (_jingleDataChannel == nullptr || _buffered_amount == 0) {
    return _buffered_amount;
  }
  return std::min<uint64_t>(_buffered_amount,
                            _jingleDataChannel->buffered_amount());
}

Napi::Value RTCDataChannel::GetBufferedAmount(const Napi::CallbackInfo &info) {
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), QueuedAmount(), result,
                                   Napi::Value)
  return result;
}

Napi::Value
RTCDataChannel::GetBufferedAmountLowThreshold(const Napi::CallbackInfo &info) {
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), _buffered_amount_low_threshold,
                                   result, Napi::Value)
  return result;
}

void RTCDataChannel::SetBufferedAmountLowThreshold(
    const Napi::CallbackInfo &info, const Napi::Value &value) {
  if (!value.IsNumber() || value.As<Napi::Number>().DoubleValue() < 0) {
    Napi::TypeError::New(info.Env(),
                         "bufferedAmountLowThreshold must be a non-negative "
                         "number")
        .ThrowAsJavaScriptException();
    return;
  }
  _buffered_amount_low_threshold =
      static_cast<uint64_t>(value.As<Napi::Number>().Int64Value());
}

Napi::Value RTCDataChannel::GetId(const Napi::CallbackInfo &info) {
  auto id = _jingleDataChannel ? _jingleDataChannel->id() : _cached_id;
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), id, result, Napi::Value)
  return result;
}

Napi::Value RTCDataChannel::GetLabel(const Napi::CallbackInfo &info) {
  auto label = _jingleDataChannel != nullptr ? _jingleDataChannel->label()
                                             : _cached_label;
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), label, result, Napi::Value)
  return result;
}

Napi::Value
RTCDataChannel::GetMaxPacketLifeTime(const Napi::CallbackInfo &info) {
  auto max_packet_life_time =
      _jingleDataChannel
          ? static_cast<uint16_t>(
                _jingleDataChannel->maxPacketLifeTime().value_or(-1))
          : _cached_max_packet_life_time;
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), max_packet_life_time, result,
                                   Napi::Value)
  return result;
}

Napi::Value RTCDataChannel::GetMaxRetransmits(const Napi::CallbackInfo &info) {
  auto max_retransmits =
      _jingleDataChannel
          ? static_cast<uint16_t>(
                _jingleDataChannel->maxRetransmitsOpt().value_or(-1))
          : _cached_max_retransmits;
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), max_retransmits, result,
                                   Napi::Value)
  return result;
}

Napi::Value RTCDataChannel::GetNegotiated(const Napi::CallbackInfo &info) {
  auto negotiated = _jingleDataChannel ? _jingleDataChannel->negotiated()
                                       : _cached_negotiated;
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), negotiated, result, Napi::Value)
  return result;
}

Napi::Value RTCDataChannel::GetOrdered(const Napi::CallbackInfo &info) {
  auto ordered =
      _jingleDataChannel ? _jingleDataChannel->ordered() : _cached_ordered;
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), ordered, result, Napi::Value)
  return result;
}

Napi::Value RTCDataChannel::GetPriority(const Napi::CallbackInfo &info) {
  std::string priority = "high";
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), priority, result, Napi::Value)
  return result;
}

Napi::Value RTCDataChannel::GetProtocol(const Napi::CallbackInfo &info) {
  auto protocol =
      _jingleDataChannel ? _jingleDataChannel->protocol() : _cached_protocol;
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), protocol, result, Napi::Value)
  return result;
}

Napi::Value RTCDataChannel::GetReadyState(const Napi::CallbackInfo &info) {
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), _ready_state, result,
                                   Napi::Value)
  return result;
}

Napi::Value RTCDataChannel::GetBinaryType(const Napi::CallbackInfo &info) {
  CONVERT_OR_THROW_AND_RETURN_NAPI(info.Env(), _binaryType, result, Napi::Value)
  return result;
}

void RTCDataChannel::SetBinaryType(const Napi::CallbackInfo &info,
                                   const Napi::Value &value) {
  auto maybeBinaryType = From<BinaryType>(value);
  if (maybeBinaryType.IsInvalid()) {
    Napi::TypeError::New(info.Env(), maybeBinaryType.ToErrors()[0])
        .ThrowAsJavaScriptException();
    return;
  }
  _binaryType = maybeBinaryType.UnsafeFromValid();
}

Wrap<RTCDataChannel *, webrtc::scoped_refptr<webrtc::DataChannelInterface>,
     node_webrtc::DataChannelObserver *> *
RTCDataChannel::wrap() {
  static auto wrap =
      new node_webrtc::Wrap<RTCDataChannel *,
                            webrtc::scoped_refptr<webrtc::DataChannelInterface>,
                            node_webrtc::DataChannelObserver *>(
          RTCDataChannel::Create);
  return wrap;
}

RTCDataChannel *RTCDataChannel::Create(
    node_webrtc::DataChannelObserver *observer,
    // TODO(jack): see if this is actually needed to keep the ref alive for
    // long enough, or if it can be deleted.
    webrtc::scoped_refptr<webrtc::DataChannelInterface>) { // NOLINT
  auto env = constructor().Env();
  Napi::HandleScope scope(env);

  auto object = constructor().New(
      {Napi::External<node_webrtc::DataChannelObserver>::New(env, observer)});

  auto unwrapped = Unwrap(object);
  return unwrapped;
}

void RTCDataChannel::Init(Napi::Env env, Napi::Object exports) {
  auto func = DefineClass(
      env, "RTCDataChannel",
      {InstanceAccessor("bufferedAmount", &RTCDataChannel::GetBufferedAmount,
                        nullptr),
       InstanceAccessor("bufferedAmountLowThreshold",
                        &RTCDataChannel::GetBufferedAmountLowThreshold,
                        &RTCDataChannel::SetBufferedAmountLowThreshold),
       InstanceAccessor("id", &RTCDataChannel::GetId, nullptr),
       InstanceAccessor("label", &RTCDataChannel::GetLabel, nullptr),
       InstanceAccessor("maxPacketLifeTime",
                        &RTCDataChannel::GetMaxPacketLifeTime, nullptr),
       InstanceAccessor("maxRetransmits", &RTCDataChannel::GetMaxRetransmits,
                        nullptr),
       InstanceAccessor("negotiated", &RTCDataChannel::GetNegotiated, nullptr),
       InstanceAccessor("ordered", &RTCDataChannel::GetOrdered, nullptr),
       InstanceAccessor("priority", &RTCDataChannel::GetPriority, nullptr),
       InstanceAccessor("protocol", &RTCDataChannel::GetProtocol, nullptr),
       InstanceAccessor("binaryType", &RTCDataChannel::GetBinaryType,
                        &RTCDataChannel::SetBinaryType),
       InstanceAccessor("readyState", &RTCDataChannel::GetReadyState, nullptr),
       InstanceMethod("close", &RTCDataChannel::Close),
       InstanceMethod("_send", &RTCDataChannel::Send)});

  constructor() = Napi::Persistent(func);
  constructor().SuppressDestruct();

  exports.Set("RTCDataChannel", func);
}

} // namespace node_webrtc
