#pragma once

#include <utility>

#include <optional>
#include <node-addon-api/napi.h>

#include "src/converters.hh"
#include "src/functional/validation.hh"

namespace node_webrtc {

template <typename T>
struct Converter<std::pair<Napi::Env, std::optional<T>>, Napi::Value> {
  static Validation<Napi::Value>
  Convert(std::pair<Napi::Env, std::optional<T>> pair) {
    return pair.second
               ? From<Napi::Value>(std::make_pair(pair.first, *pair.second))
               : Pure(pair.first.Null());
  }
};

} // namespace node_webrtc
