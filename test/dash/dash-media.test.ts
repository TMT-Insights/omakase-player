// @vitest-environment jsdom
import {describe, expect, it, vi} from 'vitest';

vi.hoisted(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    'VTTCue',
    class {
      constructor(
        public startTime: number,
        public endTime: number,
        public text: string
      ) {}
    }
  );
  vi.stubGlobal('matchMedia', () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
});

import {firstValueFrom} from 'rxjs';
import {MediaFactory} from '../../src/media/media-factory';
import {MediaDeserializer} from '../../src/media/media-deserializer';
import {MainMediaType} from '../../src/media/main-media';
import {DashMainMedia} from '../../src/dash/dash-main-media';
import {FileFormatType} from '../../src/common/file-format';
import {UrlSource} from '../../src/source';
import {PlayerControllerFactory} from '../../src/player/player-controller-factory';
import {CompositePlayerController} from '../../src/player/composite-player-controller';
import {DashPlayerController} from '../../src/dash/dash-player-controller';
import type {PlayerDomController} from '../../src/player/player-controller-api';

describe('DASH media integration', () => {
  it('detects an MPD URL as DASH', async () => {
    const media = await firstValueFrom(MediaFactory.createMainMedia(UrlSource.of('https://example.com/manifest.mpd')));
    expect(media).toBeInstanceOf(DashMainMedia);
    expect(media.mainMediaType).toBe(MainMediaType.DASH);
    expect(media.sourceFileFormatType).toBe(FileFormatType.DASH);
  });

  it('accepts explicit DASH without probing or an extension, including skip-metadata mode', async () => {
    const media = await firstValueFrom(MediaFactory.createMainMedia(UrlSource.of('https://example.com/playback'), {mainMediaType: MainMediaType.DASH, forceSkipMetadataResolution: true}));
    expect(media).toBeInstanceOf(DashMainMedia);
    expect(media.sourceFileFormatType).toBe(FileFormatType.DASH);
  });

  it('creates DASH from an explicit file format', async () => {
    const media = await firstValueFrom(MediaFactory.createMainMedia(UrlSource.of('https://example.com/playback'), {fileFormatType: FileFormatType.DASH}));
    expect(media).toBeInstanceOf(DashMainMedia);
  });

  it('rejects incompatible format overrides', () => {
    expect(() => MediaFactory.createMainMedia(UrlSource.of('https://example.com/playback'), {mainMediaType: MainMediaType.DASH, fileFormatType: FileFormatType.HLS})).toThrow(/not compatible/);
  });

  it('serializes the original MPD source and restores the DASH media type', async () => {
    const media = await firstValueFrom(MediaFactory.createMainMedia(UrlSource.of('https://example.com/manifest.mpd'), {mainMediaType: MainMediaType.DASH, frameRate: 25}));
    media.updateAttrs({duration: 42, hasVideo: true, hasAudio: true, isLive: false});
    const state = JSON.parse(JSON.stringify(media.state));
    const restored = MediaDeserializer.createMainMedia(state);
    expect(restored).toBeInstanceOf(DashMainMedia);
    expect(restored.state).toMatchObject({
      id: media.id,
      source: media.source.state,
      sourceFileFormatType: FileFormatType.DASH,
      mainMediaType: MainMediaType.DASH,
      duration: 42,
      hasVideo: true,
      hasAudio: true,
      isLive: false,
      loadOptions: {mainMediaType: MainMediaType.DASH, frameRate: 25},
    });
  });

  it('mounts the DASH controller inside the existing composite playback path', () => {
    const video = document.createElement('video');
    const parent = document.createElement('div');
    parent.append(video);
    const dom = {mainMediaVideoElement: video, resetMainMediaVideoElement() {}} as PlayerDomController;
    const controller = PlayerControllerFactory.create(MainMediaType.DASH, dom, {hlsConfig: {startLevel: 1}});
    expect(controller).toBeInstanceOf(CompositePlayerController);
    expect((controller as CompositePlayerController).forward).toBeInstanceOf(DashPlayerController);
    controller.destroy();
  });
});
