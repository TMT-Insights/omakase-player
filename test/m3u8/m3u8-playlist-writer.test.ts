import {describe, expect, it} from 'vitest';
import {M3U8PlaylistBuilder, M3U8PlaylistWriter} from '../../src/m3u8/m3u8-playlist-writer';
import {M3U8Media, M3U8Segment, M3U8StreamInfo} from '../../src/m3u8/m3u8-playlist.model';

describe('M3U8PlaylistWriter', () => {
  it('writes TAMS-style playlists as before: one map per run, gaps, plain decimals', () => {
    const map = {uri: 'init.mp4'};
    const playlist = new M3U8PlaylistBuilder()
      .setVersion(6)
      .setIndependentSegments(true)
      .setTargetDuration(2)
      .addSegment(new M3U8Segment(1.92, 'a.mp4', map))
      .addSegment(new M3U8Segment(2, 'b.mp4', map), true)
      .setEndList()
      .build();
    expect(M3U8PlaylistWriter.write(playlist)).toBe(
      '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1.92,\na.mp4\n#EXT-X-GAP\n#EXTINF:2,\nb.mp4\n#EXT-X-ENDLIST\n'
    );
  });

  it('writes byte ranges, restates the map after a discontinuity and never uses exponent notation', () => {
    const map = {uri: 'v.mp4', byteRange: {length: 100, offset: 0}};
    const playlist = new M3U8PlaylistBuilder()
      .addSegment(new M3U8Segment(2, 'v.mp4', map, {length: 50, offset: 100}))
      .addSegment(new M3U8Segment(1e-7, 'v.mp4', map, {length: 60, offset: 150}, true))
      .build();
    const output = M3U8PlaylistWriter.write(playlist);
    expect(output.match(/#EXT-X-MAP:URI="v.mp4",BYTERANGE="100@0"/g)).toHaveLength(2);
    expect(output).toContain('#EXT-X-DISCONTINUITY\n#EXT-X-MAP');
    expect(output).toContain('#EXT-X-BYTERANGE:50@100');
    expect(output).toContain('#EXTINF:0.0000001,');
  });

  it('writes variant codecs and rounds frame rates', () => {
    const output = M3U8PlaylistWriter.write(
      new M3U8PlaylistBuilder()
        .addStreamInfo(new M3U8StreamInfo(100, 90, {width: 640, height: 360}, 30000 / 1001, 'v.m3u8', 'avc1.4d401e,mp4a.40.2'))
        .addMedia(new M3U8Media('AUDIO', 'audio', 'en', true, true, '2', 'a.m3u8', 'en'))
        .build()
    );
    expect(output).toContain('#EXT-X-STREAM-INF:BANDWIDTH=100,AVERAGE-BANDWIDTH=90,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=29.97,AUDIO="audio"\nv.m3u8');
    expect(output).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="en",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",CHANNELS="2",URI="a.m3u8"');
  });

  it('rejects attribute values that cannot be quoted', () => {
    const playlist = new M3U8PlaylistBuilder().addMedia(new M3U8Media('AUDIO', 'audio', 'say "hi"', true, true, null, 'a.m3u8')).build();
    expect(() => M3U8PlaylistWriter.write(playlist)).toThrow(/quoted-string/);
  });
});
