/* Copyright (c) 2023 The node-webrtc project authors. All rights reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be found
 * in the LICENSE.md file in the root of the source tree. All contributing
 * project authors may be found in the AUTHORS file in the root of the source
 * tree.
 */

export interface RTCVideoFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export const i420ToRgba: (i420: RTCVideoFrame, rgba: RTCVideoFrame) => void;
export const rgbaToI420: (rgba: RTCVideoFrame, i420: RTCVideoFrame) => void;

export interface RTCAudioSink extends EventTarget {
  stop(): void;
  readonly stopped: boolean;
  ondata: EventHandler;
};

export const RTCAudioSink: {
  prototype: RTCAudioSink;
  new (track: MediaStreamTrack): RTCAudioSink;
}

export interface RTCAudioData {
  samples: Int16Array;
  sampleRate: number;
  bitsPerSample?: number; // default = 16
  channelCount?: number; // default = 1
  numberOfFrames?: number; // default = 10ms of audio at the given sampleRate
}

export interface RTCAudioSource {
  createTrack(): MediaStreamTrack;
  onData(data: RTCAudioData): void;
}

export const RTCAudioSource: {
  prototype: RTCAudioSource;
  new (): RTCAudioSource;
}

export interface RTCVideoSink extends EventTarget {
  stop(): void;
  readonly stopped: boolean;
  onframe: EventHandler;
};

export const RTCVideoSink: {
  prototype: RTCVideoSink;
  new (track: MediaStreamTrack): RTCVideoSink;
}

export interface RTCVideoData {
  samples: Int16Array;
  sampleRate: number;
  bitsPerSample?: number; // default = 16
  channelCount?: number; // default = 1
  numberOfFrames?: number; // default = 10ms of audio at the given sampleRate
}

export interface RTCVideoSourceInit {
  isScreencast?: boolean; // default = false
  needsDenoising?: boolean;
}

export interface RTCVideoSource {
  readonly isScreencast: boolean;
  readonly needsDenoising?: boolean;
  createTrack(): MediaStreamTrack;
  onFrame(data: RTCVideoFrame): void;
}

export const RTCVideoSource: {
  prototype: RTCVideoSource;
  new (init?: RTCVideoSourceInit): RTCVideoSource;
}

/**
 * Process-wide network options. They apply to every RTCPeerConnection, since
 * all of them share one network manager and socket server. Set them before
 * creating peer connections: a change to ignoredInterfaces is picked up at the
 * network manager's next enumeration (every 2 s).
 */
export interface NetworkOptions {
  /**
   * Interface names whose networks gather no candidates (e.g. VM bridges), as
   * os.networkInterfaces() reports them (on Windows the adapter GUID works
   * too).
   */
  ignoredInterfaces?: string[];
  /**
   * Pin every socket libwebrtc binds to a local address to the interface that
   * owns the address (IP_BOUND_IF on macOS, SO_BINDTODEVICE on Linux,
   * IP_UNICAST_IF on Windows), so it leaves through that NIC whatever the
   * routing table says. A socket that cannot be pinned (no such interface, or
   * SO_BINDTODEVICE refused) is bound as usual and counted in
   * getNetworkBindingStats().failed.
   */
  bindSocketsToInterface?: boolean;
}

export const setNetworkOptions: (options: NetworkOptions) => void;

export interface NetworkBindingStats {
  calls: number;
  succeeded: number;
  failed: number;
}

export const getNetworkBindingStats: () => NetworkBindingStats;

/**
 * Non-standard RTCConfiguration members (milliseconds). Unset keeps
 * libwebrtc's defaults.
 */
export interface RTCConfigurationExtensions {
  portRange?: { min?: number; max?: number };
  iceConnectionReceivingTimeout?: number;
  iceUnwritableTimeout?: number;
  iceInactiveTimeout?: number;
  iceCheckMinInterval?: number;
}

/** Non-standard RTCIceServer member: "insecure-no-check" accepts any certificate on turns:. */
export interface RTCIceServerExtensions {
  tlsCertPolicy?: "secure" | "insecure-no-check";
}
