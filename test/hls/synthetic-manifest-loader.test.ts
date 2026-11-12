// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import Hls, {type LoaderCallbacks, type LoaderContext} from 'hls.js';
import {SyntheticManifestLoader} from '../../src/hls/synthetic-manifest-loader';
import {SyntheticManifestRegistry} from '../../src/hls/synthetic-manifest-registry';

const origin = 'https://test.omakase.local';
const urls: string[] = [];
const url = () => {
  const created = SyntheticManifestRegistry.createUrl(origin);
  urls.push(created);
  return created;
};
const callbacks = () => ({onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn()}) satisfies LoaderCallbacks<LoaderContext>;
const load = (loader: SyntheticManifestLoader, target: string, handlers = callbacks()) => {
  loader.load({url: target, responseType: 'text'}, {} as never, handlers);
  return handlers;
};

afterEach(() => {
  urls.splice(0).forEach((created) => SyntheticManifestRegistry.clear(created));
  vi.restoreAllMocks();
});

describe('SyntheticManifestRegistry', () => {
  it('recognises every omakase.local origin as synthetic', () => {
    expect(SyntheticManifestRegistry.isSyntheticUrl(url())).toBe(true);
    expect(SyntheticManifestRegistry.isSyntheticUrl('https://tams.omakase.local/a.m3u8')).toBe(true);
    expect(SyntheticManifestRegistry.isSyntheticUrl('https://example.com/a.m3u8')).toBe(false);
    expect(SyntheticManifestRegistry.isSyntheticUrl('not a url')).toBe(false);
  });

  it('builds a lazy playlist once for concurrent requests and keeps the result', async () => {
    const target = url();
    const resolver = vi.fn(async () => '#EXTM3U');
    SyntheticManifestRegistry.registerLazy(target, resolver);
    expect(SyntheticManifestRegistry.has(target)).toBe(true);
    expect(SyntheticManifestRegistry.get(target)).toBeUndefined();
    await Promise.all([SyntheticManifestRegistry.resolve(target), SyntheticManifestRegistry.resolve(target)]);
    expect(resolver).toHaveBeenCalledOnce();
    expect(SyntheticManifestRegistry.get(target)).toBe('#EXTM3U');
  });

  it('retries a failed lazy playlist on the next request', async () => {
    const target = url();
    const resolver = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('index failed')).mockResolvedValueOnce('#EXTM3U');
    SyntheticManifestRegistry.registerLazy(target, resolver);
    await expect(SyntheticManifestRegistry.resolve(target)).rejects.toThrow('index failed');
    await expect(SyntheticManifestRegistry.resolve(target)).resolves.toBe('#EXTM3U');
  });

  it('does not resurrect a playlist cleared while it was being built', async () => {
    const target = url();
    let finish!: (text: string) => void;
    SyntheticManifestRegistry.registerLazy(target, () => new Promise((resolve) => (finish = resolve)));
    const pending = SyntheticManifestRegistry.resolve(target)!;
    SyntheticManifestRegistry.clear(target);
    finish('#EXTM3U');
    await pending;
    expect(SyntheticManifestRegistry.has(target)).toBe(false);
  });
});

describe('SyntheticManifestLoader', () => {
  it('serves registered and lazy playlists asynchronously', async () => {
    const loader = new SyntheticManifestLoader(Hls.DefaultConfig);
    const plain = url();
    const lazy = url();
    SyntheticManifestRegistry.register(plain, 'plain');
    SyntheticManifestRegistry.registerLazy(lazy, async () => 'lazy');
    const first = load(loader, plain);
    expect(first.onSuccess).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(first.onSuccess).toHaveBeenCalledWith({url: plain, data: 'plain'}, expect.anything(), expect.anything(), null));
    const second = load(new SyntheticManifestLoader(Hls.DefaultConfig), lazy);
    await vi.waitFor(() => expect(second.onSuccess).toHaveBeenCalledWith({url: lazy, data: 'lazy'}, expect.anything(), expect.anything(), null));
  });

  it('reports a playlist that cannot be built as a load error carrying the reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = url();
    SyntheticManifestRegistry.registerLazy(target, async () => {
      throw new Error('DASH: HTTP 403');
    });
    const handlers = load(new SyntheticManifestLoader(Hls.DefaultConfig), target);
    await vi.waitFor(() => expect(handlers.onError).toHaveBeenCalledWith({code: 0, text: 'DASH: HTTP 403'}, expect.anything(), null, expect.anything()));
  });

  it('delivers nothing after abort', async () => {
    const target = url();
    SyntheticManifestRegistry.register(target, 'plain');
    const loader = new SyntheticManifestLoader(Hls.DefaultConfig);
    const handlers = load(loader, target);
    loader.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handlers.onSuccess).not.toHaveBeenCalled();
  });

  it('falls through to the default loader for real URLs', () => {
    const superLoad = vi.spyOn(Hls.DefaultConfig.loader.prototype, 'load').mockImplementation(() => {});
    load(new SyntheticManifestLoader(Hls.DefaultConfig), 'https://example.com/real.m3u8');
    expect(superLoad).toHaveBeenCalledOnce();
  });
});
