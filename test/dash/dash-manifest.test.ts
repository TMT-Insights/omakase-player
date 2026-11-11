// @vitest-environment jsdom
import {describe, expect, it} from 'vitest';
import {parseDashManifest, writeDashMasterPlaylist, writeDashMediaPlaylist} from '../../src/dash/dash-manifest';

const sourceUrl = 'https://example.com/media/manifest.mpd';
const representation = (id = 'v1', bandwidth = 1000000) => `<Representation id="${id}" bandwidth="${bandwidth}" width="640" height="360"/>`;
const template = '<SegmentTemplate timescale="1000" duration="2000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s"/>';
const video = (segmentTemplate = template, representations = representation()) =>
  `<AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e" frameRate="30000/1001">${segmentTemplate}${representations}</AdaptationSet>`;
const mpd = (adaptations = video(), attributes = '') => `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT5S" ${attributes}><Period>${adaptations}</Period></MPD>`;

describe('DASH to HLS bridge', () => {
  it('expands duration templates, startNumber, padding and a shortened final segment', () => {
    const manifest = parseDashManifest(mpd(video(template.replace('duration="2000"', 'duration="2000" startNumber="7"'))), sourceUrl);
    expect(manifest.duration).toBe(5);
    expect(manifest.renditions[0]).toMatchObject({
      type: 'video',
      codecs: 'avc1.4d401e',
      width: 640,
      height: 360,
      frameRate: 30000 / 1001,
      initializationUrl: 'https://example.com/media/v1/init.mp4',
      segments: [
        {url: 'https://example.com/media/v1/seg-007.m4s', duration: 2},
        {url: 'https://example.com/media/v1/seg-008.m4s', duration: 2},
        {url: 'https://example.com/media/v1/seg-009.m4s', duration: 1},
      ],
    });
    expect(writeDashMediaPlaylist(manifest.renditions[0]!)).toBe(
      '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n' +
        '#EXT-X-MAP:URI="https://example.com/media/v1/init.mp4"\n' +
        '#EXTINF:2,\nhttps://example.com/media/v1/seg-007.m4s\n' +
        '#EXTINF:2,\nhttps://example.com/media/v1/seg-008.m4s\n' +
        '#EXTINF:1,\nhttps://example.com/media/v1/seg-009.m4s\n#EXT-X-ENDLIST\n'
    );
  });

  it('inherits templates and resolves BaseURL at every MPD level', () => {
    const xml = `<MPD mediaPresentationDuration="PT5S"><BaseURL>../assets/</BaseURL><Period><BaseURL>period/</BaseURL>
      ${template}<AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e"><BaseURL>video/</BaseURL>
      <SegmentTemplate startNumber="3"/>
      <Representation id="v" bandwidth="100"><BaseURL>high/</BaseURL><SegmentTemplate media="$Bandwidth$-$Number$.m4s"/></Representation>
      </AdaptationSet></Period></MPD>`;
    const rendition = parseDashManifest(xml, sourceUrl).renditions[0]!;
    expect(rendition.initializationUrl).toBe('https://example.com/assets/period/video/high/v/init.mp4');
    expect(rendition.segments[0]!.url).toBe('https://example.com/assets/period/video/high/100-3.m4s');
  });

  it('expands SegmentTimeline, negative repeats and Time tokens with an aligned PTO', () => {
    const segmentTemplate = `<SegmentTemplate timescale="10" presentationTimeOffset="100" initialization="init.mp4" media="$Time$.m4s">
      <SegmentTimeline><S t="100" d="10" r="-1"/><S t="120" d="20" r="-1"/></SegmentTimeline></SegmentTemplate>`;
    const rendition = parseDashManifest(mpd(video(segmentTemplate)), sourceUrl).renditions[0]!;
    expect(rendition.segments).toEqual([
      {url: 'https://example.com/media/100.m4s', duration: 1},
      {url: 'https://example.com/media/110.m4s', duration: 1},
      {url: 'https://example.com/media/120.m4s', duration: 2},
      {url: 'https://example.com/media/140.m4s', duration: 1},
    ]);
  });

  it('handles escaped dollars, numeric formats and namespace prefixes', () => {
    const xml = mpd(video(template.replace('seg-$Number%03d$', () => '$$-$Bandwidth%08X$-$Time%04d$')))
      .replace(/<(\/?)(MPD|Period|AdaptationSet|Representation|SegmentTemplate)(?=[\s>])/g, '<$1d:$2')
      .replace('xmlns=', 'xmlns:d=');
    const rendition = parseDashManifest(xml, sourceUrl).renditions[0]!;
    expect(rendition.segments[1]!.url).toBe('https://example.com/media/v1/$-000F4240-2000.m4s');
  });

  it('writes adaptive video variants and alternate audio with combined codecs and bandwidth', () => {
    const audio = (language: string) => `<AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="${language}">
      <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
      ${template}<Representation id="${language}-low" bandwidth="64000"/><Representation id="${language}" bandwidth="128000"/></AdaptationSet>`;
    const manifest = parseDashManifest(mpd(video(template, representation() + representation('v2', 2000000)) + audio('en') + audio('fr')), sourceUrl);
    expect(manifest.renditions.map((rendition) => rendition.id)).toEqual(['v1', 'v2', 'en', 'fr']);
    const master = writeDashMasterPlaylist(manifest.renditions, ['video1.m3u8', 'video2.m3u8', 'en.m3u8', 'fr.m3u8']);
    expect(master).toContain('TYPE=AUDIO,GROUP-ID="audio",NAME="en (3)",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",CHANNELS="2",URI="en.m3u8"');
    expect(master).toContain('TYPE=AUDIO,GROUP-ID="audio",NAME="fr (4)",DEFAULT=NO');
    expect(master).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1128000,AVERAGE-BANDWIDTH=1128000,CODECS="avc1.4d401e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=29.97,AUDIO="audio"\nvideo1.m3u8');
    expect(master).toContain('#EXT-X-STREAM-INF:BANDWIDTH=2128000');
  });

  it('emits audio-only renditions as selectable audio tracks, not video levels', () => {
    const manifest = parseDashManifest(mpd(`<AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2">${template}<Representation id="a" bandwidth="128000"/></AdaptationSet>`), sourceUrl);
    const master = writeDashMasterPlaylist(manifest.renditions, ['audio.m3u8']);
    expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO');
    expect(master).toContain('#EXT-X-STREAM-INF:BANDWIDTH=128000,AVERAGE-BANDWIDTH=128000,CODECS="mp4a.40.2",AUDIO="audio"\naudio.m3u8');
  });

  it('inherits audio sampling rates and allows representation overrides', () => {
    const audio = (attributes = '') => `<AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" audioSamplingRate="48000">
      ${template}<Representation id="a" bandwidth="128000" ${attributes}/></AdaptationSet>`;
    expect(parseDashManifest(mpd(audio()), sourceUrl).renditions[0]?.audioSamplingRate).toBe(48000);
    expect(parseDashManifest(mpd(audio('audioSamplingRate="24000"')), sourceUrl).renditions[0]?.audioSamplingRate).toBe(24000);
  });

  it.each(['0', '-24000', '24000.5', 'invalid'])('rejects invalid audio sampling rates: %s', (rate) => {
    const audio = `<AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" audioSamplingRate="${rate}">
      ${template}<Representation id="a" bandwidth="128000"/></AdaptationSet>`;
    expect(() => parseDashManifest(mpd(audio), sourceUrl)).toThrow(/invalid audioSamplingRate/);
  });

  it('inherits SegmentBase attributes and initialization ranges across MPD levels', () => {
    const xml = `<MPD mediaPresentationDuration="PT5S"><BaseURL>../assets/</BaseURL><Period>
      <SegmentBase timescale="1000" presentationTimeOffset="2000"><Initialization sourceURL="init.mp4" range="0-99"/></SegmentBase>
      <AdaptationSet mimeType="video/mp4" codecs="avc1.4d401e"><SegmentBase indexRange="100-167"/>
      <Representation id="v" bandwidth="100"><BaseURL>video.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;
    const rendition = parseDashManifest(xml, sourceUrl).renditions[0]!;
    expect(rendition).toMatchObject({
      initializationUrl: 'https://example.com/assets/init.mp4',
      initializationByteRange: {offset: 0, length: 100},
      presentationTimeOffset: 2,
      segmentBase: {indexRange: {offset: 100, length: 68}, mediaUrl: 'https://example.com/assets/video.mp4'},
      segments: [],
    });
    expect(() => writeDashMediaPlaylist(rendition)).toThrow(/no resolved playable segments/);
  });

  it.each(['100', '100-99', '-1-100', '0-9007199254740992'])('rejects invalid SegmentBase ranges: %s', (range) => {
    expect(() => parseDashManifest(mpd(video(`<SegmentBase indexRange="${range}"><Initialization range="0-99"/></SegmentBase>`)), sourceUrl)).toThrow(/byte range|invalid SegmentBase/);
  });

  it.each([
    ['unbounded initialization', '<SegmentBase indexRange="100-167"><Initialization/></SegmentBase>', /range or sourceURL/],
    ['invalid initialization range', '<SegmentBase indexRange="100-167"><Initialization range="100-99"/></SegmentBase>', /Initialization/],
    ['mixed addressing', template + '<SegmentBase indexRange="100-167"><Initialization range="0-99"/></SegmentBase>', /mixed/],
  ])('explicitly rejects SegmentBase with %s', (_name, addressing, error) => {
    expect(() => parseDashManifest(mpd(video(addressing)), sourceUrl)).toThrow(error);
  });

  it.each([
    ['malformed XML', '<MPD>', /invalid MPD/],
    ['dynamic MPD', mpd(video(), 'type="dynamic"'), /live\/dynamic/],
    ['DRM', mpd(video().replace(template, '<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>' + template)), /ContentProtection/],
    ['missing duration', mpd().replace('mediaPresentationDuration="PT5S"', ''), /duration is required/],
    ['SegmentList', mpd(video('<SegmentList/>')), /SegmentList/],
    ['subtitles', mpd(video().replace('video/mp4', 'application/mp4')), /unsupported mimeType/],
    ['WebM', mpd(video().replace('video/mp4', 'video/webm')), /unsupported mimeType/],
    ['essential properties', mpd(video().replace(template, '<EssentialProperty schemeIdUri="unknown"/>' + template)), /EssentialProperty/],
    ['empty MPD', mpd(''), /no audio or video/],
    ['empty AdaptationSet', mpd('<AdaptationSet/>'), /no representations/],
    ['missing initialization', mpd(video(template.replace('initialization="$RepresentationID$/init.mp4"', ''))), /initialization/],
    ['zero segment duration', mpd(video(template.replace('duration="2000"', 'duration="0"'))), /invalid.*duration/],
    ['zero timescale', mpd(video(template.replace('timescale="1000"', 'timescale="0"'))), /invalid timescale/],
    ['huge repeat', mpd(video('<SegmentTemplate initialization="i.mp4" media="$Time$.m4s"><SegmentTimeline><S d="1" r="100000"/></SegmentTimeline></SegmentTemplate>')), /repeat/],
    ['unknown token', mpd(video(template.replace('$Number%03d$', '$SubNumber$'))), /unsupported URL template token/],
    ['unbalanced token', mpd(video(template.replace('$Number%03d$', '$Number'))), /unsupported URL template token/],
    ['unsafe integer', mpd(video(template.replace('timescale="1000"', 'timescale="9007199254740992"'))), /invalid timescale/],
    ['initialization Number token', mpd(video(template.replace('/init.mp4', '/$Number$.mp4'))), /invalid Number/],
    ['multiple BaseURLs', mpd(video().replace(template, '<BaseURL>a/</BaseURL><BaseURL>b/</BaseURL>' + template)), /multiple BaseURL/],
    ['non-HTTP media', mpd(video().replace(template, '<BaseURL>data:video/mp4;base64,abc</BaseURL>' + template)), /HTTP/],
    ['different video adaptations', mpd(video() + video()), /multiple video/],
    ['leading trim', mpd(video(template.replace('duration="2000"', 'duration="2000" presentationTimeOffset="100"'))), /first segment/],
    ['incomplete timeline', mpd(video('<SegmentTemplate initialization="i.mp4" media="$Time$.m4s"><SegmentTimeline><S d="1"/></SegmentTimeline></SegmentTemplate>')), /does not cover/],
    ['timeline gap', mpd(video('<SegmentTemplate initialization="i.mp4" media="$Time$.m4s"><SegmentTimeline><S d="1"/><S t="2" d="3"/></SegmentTimeline></SegmentTemplate>')), /gaps and overlaps/],
  ])('explicitly rejects %s', (_name, xml, error) => {
    expect(() => parseDashManifest(xml, sourceUrl)).toThrow(error);
  });
});
