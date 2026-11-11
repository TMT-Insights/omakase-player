// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import Hls, {Fragment, type FragmentLoaderContext, type HlsConfig, type LoaderCallbacks, type LoaderConfiguration, type LoaderContext, type LoaderResponse, type LoaderStats} from 'hls.js';
import {createRangeFragmentLoader, isRangeFragmentLoader} from '../../src/hls/hls-range-fragment-loader';
import {createAuthFetchSetup} from '../../src/hls/hls-request-setup';
import {HlsPlayerController} from '../../src/hls/hls-player-controller';
import {AuthConfig} from '../../src/common/authentication';

const load = vi.fn<(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) => void>();
class TestLoader extends Hls.DefaultConfig.loader {
  override load = load;
}

const context: FragmentLoaderContext = {
  url: 'https://example.com/video.mp4',
  responseType: 'arraybuffer',
  rangeStart: 2,
  rangeEnd: 5,
  frag: new Fragment('main' as Fragment['type'], 'https://example.com/'),
  part: null,
};
const config: LoaderConfiguration = {
  loadPolicy: Hls.DefaultConfig.fragLoadPolicy.default,
  maxRetry: 0,
  timeout: 10000,
  retryDelay: 0,
  maxRetryDelay: 0,
};
const stats: LoaderStats = {
  aborted: false,
  loaded: 8,
  total: 8,
  retry: 0,
  chunkCount: 0,
  bwEstimate: 0,
  loading: {start: 1, first: 2, end: 3},
  parsing: {start: 0, end: 0},
  buffering: {start: 0, first: 0, end: 0},
};

function run(response: LoaderResponse, request = context) {
  const callbacks: LoaderCallbacks<FragmentLoaderContext> = {onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onProgress: vi.fn()};
  load.mockImplementation((loaderContext, _config, loaderCallbacks) => loaderCallbacks.onSuccess(response, stats, loaderContext, {status: response.code}));
  const Loader = createRangeFragmentLoader(TestLoader);
  const loader = new Loader(Hls.DefaultConfig);
  loader.load(request, config, callbacks);
  return {callbacks, loader};
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  AuthConfig.authentication = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function streamRange(response: Response, request = context, hlsConfig = Hls.DefaultConfig, loaderConfig = config) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  const Loader = createRangeFragmentLoader();
  const loader = new Loader(hlsConfig);
  const callbacks: LoaderCallbacks<FragmentLoaderContext> = {onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn(), onProgress: vi.fn()};
  loader.load(request, loaderConfig, callbacks);
  return {loader, callbacks, fetchMock};
}

describe('streaming byte ranges', () => {
  it('discards the prefix and cancels a multi-gigabyte HTTP 200 response after the requested range', async () => {
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunks++;
        if (chunks > 3) {
          return new Promise<void>(() => {});
        }
        const bytes = new Uint8Array(64 * 1024);
        bytes.fill(chunks);
        controller.enqueue(bytes);
      },
    });
    const response = new Response(body, {headers: {'Content-Length': String(3 * 1024 ** 3)}});
    const buffer = vi.spyOn(response, 'arrayBuffer');
    const request = {...context, rangeStart: 2 * 64 * 1024, rangeEnd: 2 * 64 * 1024 + 3};
    const {loader, callbacks, fetchMock} = streamRange(response, request);
    await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
    const fetchRequest = fetchMock.mock.calls[0]![0] as Request;
    expect(fetchRequest.headers.get('Range')).toBe(`bytes=${request.rangeStart}-${request.rangeEnd - 1}`);
    expect(fetchRequest.signal.aborted).toBe(true);
    expect(buffer).not.toHaveBeenCalled();
    expect(chunks).toBeLessThanOrEqual(5);
    expect(callbacks.onSuccess).toHaveBeenCalledWith(
      expect.objectContaining({data: new Uint8Array([3, 3, 3]).buffer}),
      expect.objectContaining({aborted: false, loaded: 3 * 64 * 1024, total: 3 * 64 * 1024}),
      request,
      response
    );
    expect(callbacks.onProgress).toHaveBeenCalledOnce();
    expect(callbacks.onAbort).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    loader.destroy();
  });

  it.each([200, 206])('retains the correct initialization/media bytes from HTTP %s', async (code) => {
    const response = new Response(code === 200 ? new Uint8Array([0, 1, 2, 3, 4, 5]) : new Uint8Array([2, 3, 4]), {status: code});
    const {loader, callbacks} = streamRange(response);
    await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
    expect(callbacks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({data: new Uint8Array([2, 3, 4]).buffer}), loader.stats, context, response);
    loader.destroy();
  });

  it('streams an initialization range starting at zero', async () => {
    const {loader, callbacks} = streamRange(new Response(new Uint8Array([0, 1, 2, 3, 4])), {...context, rangeStart: 0, rangeEnd: 2});
    await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
    expect(callbacks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({data: new Uint8Array([0, 1]).buffer}), loader.stats, expect.anything(), expect.anything());
    loader.destroy();
  });

  it.each([
    [200, 4],
    [206, 2],
    [206, 4],
  ])('rejects incomplete or oversized responses (%s, %s bytes)', async (status, size) => {
    const {loader, callbacks} = streamRange(new Response(new Uint8Array(size), {status}));
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onProgress).not.toHaveBeenCalled();
    loader.destroy();
  });

  it('sends ranged requests through the configured fetchSetup, where authentication is applied', async () => {
    AuthConfig.authentication = {type: 'custom', headers: () => ({headers: {'X-Auth': 'test'}})};
    const fetchSetup = vi.fn<NonNullable<HlsConfig['fetchSetup']>>((context, init) => new Request(context.url, {...init, credentials: 'include'}));
    const hlsConfig = {...Hls.DefaultConfig, fetchSetup: createAuthFetchSetup(fetchSetup)};
    const {loader, callbacks, fetchMock} = streamRange(new Response(new Uint8Array(5)), {...context, headers: {'X-Context': 'value'}}, hlsConfig);
    await vi.waitFor(() => expect(callbacks.onSuccess).toHaveBeenCalledOnce());
    const request = fetchMock.mock.calls[0]![0] as Request;
    expect(request.headers.get('X-Auth')).toBe('test');
    expect(request.headers.get('X-Context')).toBe('value');
    expect(request.credentials).toBe('include');
    expect(fetchSetup).toHaveBeenCalledOnce();
    loader.destroy();
  });

  it('forwards HTTP errors without reporting success', async () => {
    const {loader, callbacks} = streamRange(new Response(null, {status: 403, statusText: 'Forbidden'}));
    await vi.waitFor(() => expect(callbacks.onError).toHaveBeenCalledOnce());
    expect(callbacks.onError).toHaveBeenCalledWith({code: 403, text: 'Forbidden'}, context, expect.anything(), loader.stats);
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    loader.destroy();
  });

  it('aborts pending streaming requests without a late success or error', async () => {
    const {loader, callbacks, fetchMock} = streamRange(new Response(new ReadableStream()));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    loader.abort();
    expect((fetchMock.mock.calls[0]![0] as Request).signal.aborted).toBe(true);
    expect(callbacks.onAbort).toHaveBeenCalledOnce();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    loader.destroy();
  });

  it('forwards streaming timeouts once and cancels the request', async () => {
    vi.useFakeTimers();
    const {loader, callbacks, fetchMock} = streamRange(new Response(new ReadableStream()), context, Hls.DefaultConfig, {
      ...config,
      loadPolicy: {...config.loadPolicy, maxTimeToFirstByteMs: 10, maxLoadTimeMs: 20},
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(callbacks.onTimeout).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0]![0] as Request).signal.aborted).toBe(true);
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    loader.destroy();
  });
});

describe('byte-range fragment loader', () => {
  it('slices full HTTP 200 responses before forwarding progress or success to hls.js', () => {
    const file = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer;
    const {callbacks} = run({url: context.url, code: 200, data: file});
    const expected = new Uint8Array([2, 3, 4]).buffer;
    expect(callbacks.onProgress).toHaveBeenCalledWith(stats, expect.anything(), expected, {status: 200});
    expect(callbacks.onSuccess).toHaveBeenCalledWith({url: context.url, code: 200, data: expected}, stats, expect.anything(), {status: 200});
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(load.mock.calls[0]?.[0].progressData).toBe(false);
    expect(load.mock.calls[0]?.[2].onProgress).toBeUndefined();
  });

  it('slices initialization ranges starting at zero', () => {
    const {callbacks} = run({url: context.url, code: 200, data: new Uint8Array([0, 1, 2, 3, 4, 5]).buffer}, {...context, rangeStart: 0, rangeEnd: 2});
    expect(callbacks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({data: new Uint8Array([0, 1]).buffer}), stats, expect.anything(), expect.anything());
  });

  it('preserves correct HTTP 206 responses without slicing them twice', () => {
    const data = new Uint8Array([2, 3, 4]).buffer;
    const {callbacks} = run({url: context.url, code: 206, data});
    expect(callbacks.onSuccess).toHaveBeenCalledWith({url: context.url, code: 206, data}, stats, expect.anything(), expect.anything());
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it.each([
    [200, new ArrayBuffer(4), /truncated/],
    [206, new ArrayBuffer(2), /invalid fragment/],
    [206, new ArrayBuffer(4), /invalid fragment/],
  ])('reports invalid range bodies (%s) rather than forwarding corrupt data', (code, data, error) => {
    const {callbacks} = run({url: context.url, code, data});
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({text: expect.stringMatching(error)}), expect.anything(), expect.anything(), stats);
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onProgress).not.toHaveBeenCalled();
  });

  it.each([undefined, 0])('leaves non-range SegmentTemplate requests and progressive callbacks unchanged (rangeEnd=%s)', (rangeEnd) => {
    const request = {url: context.url, responseType: 'arraybuffer', frag: context.frag, part: null, ...(rangeEnd === undefined ? {} : {rangeStart: 0, rangeEnd})};
    const {callbacks} = run({url: context.url, code: 200, data: new ArrayBuffer(8)}, request);
    expect(load).toHaveBeenCalledWith(request, config, expect.objectContaining({onProgress: expect.any(Function)}));
    expect(callbacks.onSuccess).toHaveBeenCalledOnce();
  });

  it('preserves configured loader options and inherited abort/destroy behavior', () => {
    const abort = vi.spyOn(TestLoader.prototype, 'abort');
    const destroy = vi.spyOn(TestLoader.prototype, 'destroy');
    const customConfig: HlsConfig = {...Hls.DefaultConfig};
    const Loader = createRangeFragmentLoader(TestLoader);
    const loader = new Loader(customConfig);
    loader.abort();
    loader.destroy();
    expect(abort).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('forwards errors, timeouts, abort notifications, statistics and response headers from a custom loader', () => {
    class CustomLoader extends TestLoader {
      override getCacheAge = () => 12;
      override getResponseHeader = (name: string) => {
        return name === 'Content-Type' ? 'video/mp4' : null;
      };
    }
    const callbacks: LoaderCallbacks<FragmentLoaderContext> = {onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn(), onAbort: vi.fn()};
    load.mockImplementation((loaderContext, _config, forwarded) => {
      forwarded.onError({code: 403, text: 'Forbidden'}, loaderContext, null, stats);
      forwarded.onTimeout(stats, loaderContext, null);
      forwarded.onAbort?.(stats, loaderContext, null);
    });
    const Loader = createRangeFragmentLoader(CustomLoader);
    const loader = new Loader(Hls.DefaultConfig);
    loader.load(context, config, callbacks);
    expect(callbacks.onError).toHaveBeenCalledWith({code: 403, text: 'Forbidden'}, context, null, stats);
    expect(callbacks.onTimeout).toHaveBeenCalledWith(stats, context, null);
    expect(callbacks.onAbort).toHaveBeenCalledWith(stats, context, null);
    expect(loader.context).toBe(context);
    expect(loader.stats).toBeDefined();
    expect(loader.getCacheAge?.()).toBe(12);
    expect(loader.getResponseHeader?.('Content-Type')).toBe('video/mp4');
  });
});

describe('range fragment loader wiring', () => {
  it('does not wrap a range fragment loader twice', () => {
    const Loader = createRangeFragmentLoader(TestLoader);
    expect(isRangeFragmentLoader(Loader)).toBe(true);
    expect(createRangeFragmentLoader(Loader)).toBe(Loader);
    expect(isRangeFragmentLoader(TestLoader)).toBe(false);
  });

  it('keeps ranged fragments on the base loader, sliced, when streaming is disabled', () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const callbacks: LoaderCallbacks<FragmentLoaderContext> = {onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn()};
    load.mockImplementation((loaderContext, _config, loaderCallbacks) =>
      loaderCallbacks.onSuccess({url: context.url, code: 200, data: new Uint8Array([0, 1, 2, 3, 4, 5]).buffer}, stats, loaderContext, null)
    );
    const Loader = createRangeFragmentLoader(Hls.DefaultConfig.loader, {stream: false});
    vi.spyOn(Hls.DefaultConfig.loader.prototype, 'load').mockImplementation(load as never);
    new Loader(Hls.DefaultConfig).load(context, config, callbacks);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).toHaveBeenCalledWith(expect.objectContaining({data: new Uint8Array([2, 3, 4]).buffer}), stats, context, null);
    vi.restoreAllMocks();
  });

  it('composes authentication with an application fetchSetup once, and builds a plain Request otherwise', async () => {
    AuthConfig.authentication = {type: 'custom', headers: () => ({headers: {'X-Auth': 'test'}})};
    const setup = createAuthFetchSetup();
    expect(createAuthFetchSetup(setup)).toBe(setup);
    const request = (await setup({...context}, {headers: new Headers({'X-Context': 'value'})})) as Request;
    expect(request.headers.get('X-Auth')).toBe('test');
    expect(request.headers.get('X-Context')).toBe('value');
    AuthConfig.authentication = undefined;
    expect(((await setup({...context}, {})) as Request).headers.get('X-Auth')).toBeNull();
  });

  it('gives every HLS controller the range loader and authenticated fetches, keeping the application config', () => {
    const resolve = (hlsConfig: Partial<HlsConfig>) => (HlsPlayerController as unknown as {resolveHlsConfig(config: Partial<HlsConfig>): Partial<HlsConfig>}).resolveHlsConfig(hlsConfig);
    const rangeLoader = (hlsConfig: Partial<HlsConfig>) => (new (resolve(hlsConfig).fLoader!)(Hls.DefaultConfig as HlsConfig) as unknown as {_rangeLoader?: unknown})._rangeLoader;
    const fetchSetup = vi.fn<NonNullable<HlsConfig['fetchSetup']>>((context, init) => new Request(context.url, init));
    const resolved = resolve({...Hls.DefaultConfig, fetchSetup});
    expect(isRangeFragmentLoader(resolved.fLoader)).toBe(true);
    resolved.fetchSetup!({...context}, {});
    expect(fetchSetup).toHaveBeenCalledOnce();
    expect(rangeLoader({...Hls.DefaultConfig})).toBeDefined();
    // an application xhrSetup must keep applying to ranged fragments
    expect(rangeLoader({...Hls.DefaultConfig, xhrSetup: () => {}})).toBeUndefined();
    expect(rangeLoader({...Hls.DefaultConfig, xhrSetup: () => {}, fetchSetup})).toBeDefined();
  });
});
