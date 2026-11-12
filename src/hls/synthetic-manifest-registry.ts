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

/** Produces a playlist on first request; see {@link SyntheticManifestRegistry.registerLazy}. */
export type SyntheticManifestResolver = () => Promise<string>;

interface LazyEntry {
  resolver: SyntheticManifestResolver;
  pending?: Promise<string> | undefined;
}

/** Every synthetic host is a subdomain of this, so one check recognises all of them. */
const SYNTHETIC_HOST_SUFFIX = '.omakase.local';

/**
 * HLS playlists that Omakase builds itself (from TAMS, DASH, ...) keyed by a synthetic URL.
 *
 * {@link SyntheticManifestLoader} (the hls.js `pLoader`) serves these instead of hitting the network;
 * segment URLs are real and never enter the registry. Unlike `blob:` URLs, synthetic URLs mean the
 * same thing in every window that has the loader, so playlists can be handed between windows.
 */
export class SyntheticManifestRegistry {
  private static readonly manifests = new Map<string, string>();
  private static readonly lazy = new Map<string, LazyEntry>();

  /**
   * @param origin e.g. `https://dash.omakase.local`; must be a subdomain of `omakase.local`
   */
  static createUrl(origin: string): string {
    return `${origin}/${crypto.randomUUID()}.m3u8`;
  }

  static isSyntheticUrl(url: string): boolean {
    try {
      return new URL(url).hostname.endsWith(SYNTHETIC_HOST_SUFFIX);
    } catch {
      return false;
    }
  }

  /** Resolved playlists only; lazy entries appear once they have resolved. */
  static entries(): [string, string][] {
    return [...this.manifests.entries()];
  }

  static register(url: string, content: string): void {
    this.lazy.delete(url);
    this.manifests.set(url, content);
  }

  /**
   * Registers a playlist that is only built when first requested, so hls.js pays for the renditions
   * it actually plays. Concurrent requests share one resolution; a failed one is retried by the next
   * request, and a successful one is kept as a plain entry.
   */
  static registerLazy(url: string, resolver: SyntheticManifestResolver): void {
    this.manifests.delete(url);
    this.lazy.set(url, {resolver});
  }

  /**
   * Registers playlists resolved elsewhere - another window, or an earlier load - verbatim.
   */
  static restore(manifests: Record<string, string>): void {
    Object.entries(manifests).forEach(([url, content]) => this.register(url, content));
  }

  static has(url: string): boolean {
    return this.manifests.has(url) || this.lazy.has(url);
  }

  /** The playlist text if it is available synchronously, ie. registered or already resolved. */
  static get(url: string): string | undefined {
    return this.manifests.get(url);
  }

  /** The playlist text, building it if it is lazy; `undefined` if the URL is not registered. */
  static resolve(url: string): Promise<string> | undefined {
    const content = this.manifests.get(url);
    if (content !== undefined) {
      return Promise.resolve(content);
    }

    const entry = this.lazy.get(url);
    if (!entry) {
      return undefined;
    }

    entry.pending ??= entry.resolver().then(
      (resolved) => {
        // a clear() or re-registration while resolving wins over this result
        if (this.lazy.get(url) === entry) {
          this.register(url, resolved);
        }
        return resolved;
      },
      (error: unknown) => {
        entry.pending = undefined;
        throw error;
      }
    );
    return entry.pending;
  }

  static clear(url: string): void {
    this.manifests.delete(url);
    this.lazy.delete(url);
  }
}
