/*
 * Copyright 2026 ByOmakase, LLC (https://byomakase.org)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Represents an M3U8 Playlist containing various streams, media, and segments.
 */

type M3U8SegmentWithGap = M3U8Segment & {gap?: boolean};
export class M3U8Playlist {
  /**
   * The version of the HLS protocol (e.g., 3).
   */
  version: number;

  /**
   * Whether the playlist has independent segments.
   */
  independentSegments: boolean;

  /**
   * The maximum duration of any segment in the playlist (in seconds).
   */
  targetDuration: number | null = null;

  /**
   * The sequence number of the first segment in the playlist.
   */
  mediaSequence: number | null = null;

  /**
   * Program date-time in ISO 8601 format.
   */
  programDateTime: string | null = null;

  /**
   * Playlist type, which can be 'VOD' (Video on Demand) or 'EVENT'.
   */
  playlistType: 'VOD' | 'EVENT' | null = null;

  /**
   * List of stream information (video/audio variants).
   */
  streams: M3U8StreamInfo[] = [];

  /**
   * List of media options (AUDIO, VIDEO, SUBTITLES, CLOSED-CAPTIONS).
   */
  media: M3U8Media[] = [];

  /**
   * List of individual segments in the playlist.
   */

  segments: M3U8SegmentWithGap[] = [];

  /**
   * Whether to mark the end of the playlist (EXT-X-ENDLIST).
   */
  endList: boolean = false;

  startOffset?: number; // New property for EXT-X-START offset

  constructor(version: number = 3, independentSegments: boolean = false) {
    this.version = version;
    this.independentSegments = independentSegments;
  }
}

/**
 * Represents information about a specific video/audio stream variant.
 */
export class M3U8StreamInfo {
  /**
   * Maximum bandwidth for the stream in bits per second.
   */
  bandwidth: number;

  /**
   * Average bandwidth for the stream in bits per second.
   */
  averageBandwidth: number;

  /**
   * Resolution of the stream as width and height. Null if not specified.
   */
  resolution: {width: number; height: number} | null;

  /**
   * Frame rate of the stream. Null if not specified.
   */
  frameRate: number | null;

  /**
   * URI pointing to the specific stream playlist.
   */
  uri: string | null;

  /**
   * RFC 6381 codec list of every media type the variant carries. Omitted from the playlist when undefined.
   */
  codecs?: string | undefined;

  constructor(bandwidth: number, averageBandwidth: number, resolution: {width: number; height: number} | null, frameRate: number | null, uri: string | null, codecs?: string | undefined) {
    this.bandwidth = bandwidth;
    this.averageBandwidth = averageBandwidth;
    this.resolution = resolution;
    this.frameRate = frameRate;
    this.uri = uri;
    if (codecs !== undefined) {
      this.codecs = codecs;
    }
  }
}

/**
 * Represents a media option such as AUDIO, VIDEO, SUBTITLES, or CLOSED-CAPTIONS.
 */
export class M3U8Media {
  /**
   * Type of media (e.g., AUDIO, VIDEO, SUBTITLES, CLOSED-CAPTIONS).
   */
  type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';

  /**
   * Group identifier to link this media with a stream.
   */
  groupId: string;

  /**
   * Descriptive name for the media track.
   */
  name: string;

  /**
   * Indicates if this is the default media track.
   */
  isDefault: boolean;

  /**
   * Indicates if the media track should auto-select if not explicitly selected.
   */
  autoSelect: boolean;

  /**
   * Number of audio channels (e.g., "2" for stereo). Null if not applicable.
   */
  channels: string | null;

  /**
   * URI pointing to the specific media playlist.
   */
  uri: string;

  /**
   * RFC 5646 language tag of the media track. Null when the flow declares none.
   */
  language: string | null;

  constructor(
    type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS',
    groupId: string,
    name: string,
    isDefault: boolean,
    autoSelect: boolean,
    channels: string | null,
    uri: string,
    language: string | null = null
  ) {
    this.type = type;
    this.groupId = groupId;
    this.name = name;
    this.isDefault = isDefault;
    this.autoSelect = autoSelect;
    this.channels = channels;
    this.uri = uri;
    this.language = language;
  }
}

/**
 * Media Initialization Section a segment needs before it can be decoded (EXT-X-MAP).
 */
export type M3U8SegmentMap = {
  /**
   * URI pointing to the initialisation segment.
   */
  uri: string;

  /**
   * Sub-range of the resource holding the initialisation segment.
   */
  byteRange?: M3U8ByteRange | undefined;
};

/**
 * Sub-range of a resource (EXT-X-BYTERANGE / BYTERANGE attribute).
 */
export type M3U8ByteRange = {
  /** Number of bytes in the sub-range. */
  length: number;
  /** Byte offset of the sub-range from the start of the resource. */
  offset: number;
};

/**
 * Represents an individual segment within the playlist.
 */
export class M3U8Segment {
  /**
   * Duration of the segment in seconds.
   */
  duration: number;

  /**
   * URI pointing to the segment file.
   */
  uri: string;

  /**
   * Initialisation segment required to decode this segment, for CMAF / fMP4 sources. Undefined for
   * self-contained segments; the writer emits one EXT-X-MAP per run of segments that share it.
   */
  map?: M3U8SegmentMap;

  /**
   * Sub-range of {@link uri} holding this segment, for byte-range addressed media.
   */
  byteRange?: M3U8ByteRange;

  /**
   * Marks an encoding discontinuity before this segment (EXT-X-DISCONTINUITY). The writer re-emits
   * this segment's EXT-X-MAP after it, even when the URI is unchanged.
   */
  discontinuity?: boolean;

  constructor(duration: number, uri: string, map?: M3U8SegmentMap, byteRange?: M3U8ByteRange, discontinuity?: boolean) {
    this.duration = duration;
    this.uri = uri;
    if (map) {
      this.map = map;
    }
    if (byteRange) {
      this.byteRange = byteRange;
    }
    if (discontinuity) {
      this.discontinuity = discontinuity;
    }
  }
}
