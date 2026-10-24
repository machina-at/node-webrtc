#include "src/dictionaries/webrtc/rtc_stats_member_interface.hh"

#include <cstdint>
#include <map>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include <node-addon-api/napi.h>
#include <webrtc/api/stats/attribute.h>

#include "src/converters.hh"

namespace node_webrtc {

TO_NAPI_IMPL(const webrtc::Attribute *, pair) {
  auto env = pair.first;
  return std::visit(
      [env](const auto *stat) -> Validation<Napi::Value> {
        return From<Napi::Value>(std::make_pair(env, **stat));
      },
      pair.second->as_variant());
}

} // namespace node_webrtc
