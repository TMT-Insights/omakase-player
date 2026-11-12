/*
 * Copyright 2026 ByOmakase, LLC (https://byomakase.org)
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import {Observable, takeUntil} from 'rxjs';
import * as imsc from 'smp-imsc';
import type {TextTrackState, TimedImscDocument} from '../media/text-track';
import type {PlayerController} from '../player/player-controller-api';
import type {PlayerTextTrackLoadOptions} from '../player/player-text-track';
import {FileFormatType} from '../common';
import {ImscTextTrackController} from './imsc-text-track-controller';

/** Retains each document's styling and timing context instead of flattening TTML into WebVTT. */
export class SegmentedImscTextTrackController extends ImscTextTrackController {
  private _documents: {timing: TimedImscDocument; document: imsc.TTDocument}[] = [];

  constructor(state: TextTrackState, controller: PlayerController, options?: PlayerTextTrackLoadOptions) {
    super(state, controller, {...options, fileFormatType: FileFormatType.TTML});
  }

  override loadSource(): Observable<void> {
    return new Observable<void>((observer) => {
      const controller = new AbortController();
      const run = async () => {
        const documents = [];
        for (const timing of this._trackState.imscDocuments ?? []) {
          if (!Number.isFinite(timing.start) || !Number.isFinite(timing.end) || !Number.isFinite(timing.timeOffset) || timing.end <= timing.start) {
            throw new Error('Invalid timed IMSC document interval');
          }
          const response = await fetch(timing.url, {signal: controller.signal});
          if (!response.ok) throw new Error(`HTTP ${response.status} loading IMSC document`);
          documents.push({timing, document: imsc.fromXML(await response.text())});
        }
        if (!documents.length) throw new Error('No timed IMSC documents');
        controller.signal.throwIfAborted();
        this._documents = documents;
        this._ttDocument = documents[0]!.document;
      };
      run().then(
        () => {
          observer.next();
          observer.complete();
        },
        (error: unknown) => observer.error(error)
      );
      return () => controller.abort();
    }).pipe(takeUntil(this._destroyBreaker.observer));
  }

  protected override generateISD(time: number): imsc.ISD {
    const active = this._documents.find(({timing}) => time >= timing.start && time < timing.end);
    return active ? imsc.generateISD(active.document, time - active.timing.timeOffset) : {contents: []};
  }

  override destroy(): void {
    this._documents = [];
    super.destroy();
  }
}
