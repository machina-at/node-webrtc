#include "src/dictionaries/node_webrtc/extended_rtc_configuration.hh"

#include "src/converters/object.hh"
#include "src/dictionaries/macros/napi.hh"
#include "src/dictionaries/webrtc/ice_server.hh"
#include "src/dictionaries/webrtc/rtc_configuration.hh"
#include "src/enums/webrtc/bundle_policy.hh"
#include "src/enums/webrtc/ice_transports_type.hh"
#include "src/enums/webrtc/rtcp_mux_policy.hh"
#include "src/enums/webrtc/sdp_semantics.hh"
#include "src/functional/curry.hh"

namespace node_webrtc {

// Non-standard ICE timing knobs (milliseconds; -1 keeps libwebrtc's
// default): how long without packets before a connection is "not receiving"
// (iceConnectionReceivingTimeout), "unwritable" (iceUnwritableTimeout) and
// "inactive" (iceInactiveTimeout), and the minimum interval between STUN
// checks (iceCheckMinInterval).
static ExtendedRTCConfiguration CreateExtendedRTCConfiguration(
    const webrtc::PeerConnectionInterface::RTCConfiguration &configuration,
    const UnsignedShortRange portRange, const int iceConnectionReceivingTimeout,
    const int iceUnwritableTimeout, const int iceInactiveTimeout,
    const int iceCheckMinInterval) {
  auto extended = ExtendedRTCConfiguration(configuration, portRange);
  if (iceConnectionReceivingTimeout >= 0) {
    extended.configuration.ice_connection_receiving_timeout =
        iceConnectionReceivingTimeout;
  }
  if (iceUnwritableTimeout >= 0) {
    extended.configuration.ice_unwritable_timeout = iceUnwritableTimeout;
  }
  if (iceInactiveTimeout >= 0) {
    extended.configuration.ice_inactive_timeout = iceInactiveTimeout;
  }
  if (iceCheckMinInterval >= 0) {
    extended.configuration.ice_check_min_interval = iceCheckMinInterval;
  }
  return extended;
}

FROM_NAPI_IMPL(ExtendedRTCConfiguration, value) {
  return From<Napi::Object>(value).FlatMap<ExtendedRTCConfiguration>(
      [value](auto object) {
        return curry(CreateExtendedRTCConfiguration) %
               From<webrtc::PeerConnectionInterface::RTCConfiguration>(value) *
               GetOptional<UnsignedShortRange>(object, "portRange",
                                               UnsignedShortRange()) *
               GetOptional<int>(object, "iceConnectionReceivingTimeout", -1) *
               GetOptional<int>(object, "iceUnwritableTimeout", -1) *
               GetOptional<int>(object, "iceInactiveTimeout", -1) *
               GetOptional<int>(object, "iceCheckMinInterval", -1);
      });
}

static Validation<Napi::Value> ExtendedRTCConfigurationToJavaScript(
    const Napi::Value iceServers, const Napi::Value iceTransportPolicy,
    const Napi::Value bundlePolicy, const Napi::Value rtcpMuxPolicy,
    const Napi::Value iceCandidatePoolSize, const Napi::Value portRange,
    const Napi::Value sdpSemantics,
    const Napi::Value iceConnectionReceivingTimeout,
    const Napi::Value iceUnwritableTimeout, const Napi::Value iceInactiveTimeout,
    const Napi::Value iceCheckMinInterval) {
  auto env = iceServers.Env();
  Napi::EscapableHandleScope scope(iceServers.Env());
  NODE_WEBRTC_CREATE_OBJECT_OR_RETURN(env, object)
  NODE_WEBRTC_CONVERT_AND_SET_OR_RETURN(env, object, "iceServers", iceServers)
  NODE_WEBRTC_CONVERT_AND_SET_OR_RETURN(env, object, "iceTransportPolicy",
                                        iceTransportPolicy)
  NODE_WEBRTC_CONVERT_AND_SET_OR_RETURN(env, object, "bundlePolicy",
                                        bundlePolicy)
  NODE_WEBRTC_CONVERT_AND_SET_OR_RETURN(env, object, "rtcpMuxPolicy",
                                        rtcpMuxPolicy)
  NODE_WEBRTC_CONVERT_AND_SET_OR_RETURN(env, object, "iceCandidatePoolSize",
                                        iceCandidatePoolSize)
  NODE_WEBRTC_CONVERT_AND_SET_OR_RETURN(env, object, "portRange", portRange)
  NODE_WEBRTC_CONVERT_AND_SET_OR_RETURN(env, object, "sdpSemantics",
                                        sdpSemantics)
  // Only report the non-standard timing knobs that were set.
  auto setIfSet = [&object](const char *name, const Napi::Value &value) {
    if (value.IsNumber() && value.As<Napi::Number>().Int32Value() >= 0) {
      object.Set(name, value);
    }
  };
  setIfSet("iceConnectionReceivingTimeout", iceConnectionReceivingTimeout);
  setIfSet("iceUnwritableTimeout", iceUnwritableTimeout);
  setIfSet("iceInactiveTimeout", iceInactiveTimeout);
  setIfSet("iceCheckMinInterval", iceCheckMinInterval);
  return Pure(scope.Escape(object));
}

TO_NAPI_IMPL(ExtendedRTCConfiguration, pair) {
  return Validation<Napi::Value>::Join(
      curry(ExtendedRTCConfigurationToJavaScript) %
      From<Napi::Value>(
          std::make_pair(pair.first, pair.second.configuration.servers)) *
      From<Napi::Value>(
          std::make_pair(pair.first, pair.second.configuration.type)) *
      From<Napi::Value>(
          std::make_pair(pair.first, pair.second.configuration.bundle_policy)) *
      From<Napi::Value>(std::make_pair(
          pair.first, pair.second.configuration.rtcp_mux_policy)) *
      From<Napi::Value>(std::make_pair(
          pair.first, pair.second.configuration.ice_candidate_pool_size)) *
      From<Napi::Value>(std::make_pair(pair.first, pair.second.portRange)) *
      From<Napi::Value>(
          std::make_pair(pair.first, pair.second.configuration.sdp_semantics)) *
      From<Napi::Value>(std::make_pair(
          pair.first,
          pair.second.configuration.ice_connection_receiving_timeout)) *
      From<Napi::Value>(std::make_pair(
          pair.first,
          pair.second.configuration.ice_unwritable_timeout.value_or(-1))) *
      From<Napi::Value>(std::make_pair(
          pair.first,
          pair.second.configuration.ice_inactive_timeout.value_or(-1))) *
      From<Napi::Value>(std::make_pair(
          pair.first,
          pair.second.configuration.ice_check_min_interval.value_or(-1))));
}

} // namespace node_webrtc
