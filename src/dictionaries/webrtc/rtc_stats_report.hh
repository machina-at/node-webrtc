#pragma once

#include "src/converters/napi.hh"

namespace webrtc {
template <typename T> class scoped_refptr;
class RTCStatsReport;
}

namespace node_webrtc {

DECLARE_TO_NAPI(webrtc::scoped_refptr<webrtc::RTCStatsReport>)

} // namespace node_webrtc
