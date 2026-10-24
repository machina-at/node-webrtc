#pragma once

#include <webrtc/rtc_base/buffer.h>

#include "src/converters/napi.hh"

namespace node_webrtc {

DECLARE_TO_NAPI(webrtc::Buffer *)

} // namespace node_webrtc
