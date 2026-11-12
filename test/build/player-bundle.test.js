import {afterEach, expect, it, vi} from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('imports the built player in a DOM environment without consumer-provided Node polyfills', async () => {
  // JSDOM does not implement these native browser APIs.
  vi.stubGlobal('VTTCue', class extends EventTarget {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal('matchMedia', (media) => ({
    media,
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  }));
  const {OmakasePlayer} = await import('../../dist/omakase-player.es.js');

  expect(OmakasePlayer).toBeTypeOf('function');
});
