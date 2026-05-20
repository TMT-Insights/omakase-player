/*
 * Copyright 2024 ByOmakase, LLC (https://byomakase.org)
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

import {TIMELINE_LANE_CONFIG_DEFAULT, timelineLaneComposeConfig, TimelineLaneConfigDefaultsExcluded, TimelineLaneStyle, VTT_DOWNSAMPLE_CONFIG_DEFAULT} from '../timeline-lane';
import Konva from 'konva';
import {fillLinearGradientAudioPeak} from '../../constants';
import {combineLatest, debounceTime, filter, takeUntil, zip} from 'rxjs';
import {AudioVttCue} from '../../types';
import {AudioTrackLaneItem} from './audio-track-lane-item';
import Decimal from 'decimal.js';
import {ColorUtil} from '../../util/color-util';
import {Timeline} from '../timeline';
import {destroyer} from '../../util/destroy-util';
import {AxiosRequestConfig} from 'axios';
import {KonvaFactory} from '../../konva/konva-factory';
import {VideoControllerApi} from '../../video';
import {AudioTrackLaneApi} from '../../api';
import {AudioVttFile} from '../../vtt';
import {VttAdapter, VttAdapterConfig} from '../../common/vtt-adapter';
import {VttTimelineLane, VttTimelineLaneConfig} from '../vtt-timeline-lane';
import {ALL_FORMATS, AudioBufferSink, Input, UrlSource} from 'mediabunny';

type ProgressiveAudioCueStore = {
  cues: AudioVttCue[];
  cueKeys: Set<string>;
};

function computeBufferPeaks(buffer: AudioBuffer) {
  let minSample = 1;
  let maxSample = -1;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      if (sample < minSample) minSample = sample;
      if (sample > maxSample) maxSample = sample;
    }
  }

  return {
    minSample: Number(minSample.toFixed(3)),
    maxSample: Number(maxSample.toFixed(3)),
  };
}

export interface AudioTrackLaneConfig extends VttTimelineLaneConfig<AudioTrackLaneStyle>, VttAdapterConfig<AudioVttFile> {
  axiosConfig?: AxiosRequestConfig;
  progressiveSourceUrl?: string;
}

export interface AudioTrackLaneStyle extends TimelineLaneStyle {
  paddingTop: number;
  paddingBottom: number;

  itemWidth: number;
  itemMinPadding: number;
  itemCornerRadius: number;
  maxSampleFillLinearGradientColorStops: (number | string)[];
  minSampleFillLinearGradientColorStops: (number | string)[];
}

const configDefault: AudioTrackLaneConfig = {
  ...TIMELINE_LANE_CONFIG_DEFAULT,
  ...VTT_DOWNSAMPLE_CONFIG_DEFAULT,
  downsampleStrategy: 'max',
  style: {
    ...TIMELINE_LANE_CONFIG_DEFAULT.style,
    height: 40,
    paddingTop: 0,
    paddingBottom: 0,
    itemWidth: 5,
    itemMinPadding: 2,
    itemCornerRadius: 5,
    maxSampleFillLinearGradientColorStops: fillLinearGradientAudioPeak,
    minSampleFillLinearGradientColorStops: ColorUtil.inverseFillGradient(fillLinearGradientAudioPeak),
  },
};

export class AudioTrackLane extends VttTimelineLane<AudioTrackLaneConfig, AudioTrackLaneStyle, AudioVttCue, AudioVttFile> implements AudioTrackLaneApi {
  protected readonly _vttAdapter: VttAdapter<AudioVttFile> = new VttAdapter(AudioVttFile);

  protected readonly _itemsMap: Map<number, AudioTrackLaneItem> = new Map<number, AudioTrackLaneItem>();

  protected _timecodedEventCatcher?: Konva.Rect;
  protected _itemsGroup?: Konva.Group;
  private _pendingCues: AudioVttCue[] | null = null;
  private _progressiveCueStore: ProgressiveAudioCueStore = {cues: [], cueKeys: new Set<string>()};
  private _progressiveAbortControllers: Set<AbortController> = new Set<AbortController>();

  constructor(config: TimelineLaneConfigDefaultsExcluded<AudioTrackLaneConfig>) {
    super(timelineLaneComposeConfig(configDefault, config));

    this._vttAdapter.initFromConfig(this._config);
  }

  override prepareForTimeline(timeline: Timeline, videoController: VideoControllerApi) {
    super.prepareForTimeline(timeline, videoController);

    let timecodedRect = this.getTimecodedRect();

    this._timecodedGroup = KonvaFactory.createGroup({
      ...timecodedRect,
    });

    this._timecodedEventCatcher = KonvaFactory.createEventCatcherRect({
      ...this._timecodedGroup.getSize(),
    });

    this._itemsGroup = KonvaFactory.createGroup({
      y: this._config.style.paddingTop,
      width: this._timecodedGroup.width(),
      height: this._config.style.height - (this._config.style.paddingTop + this._config.style.paddingBottom),
    });

    this._timecodedGroup.add(this._timecodedEventCatcher);
    this._timecodedGroup.add(this._itemsGroup);

    this._timeline!.addToTimecodedFloatingContent(this._timecodedGroup, 3);

    this._onSettleLayout$.pipe(takeUntil(this._destroyed$)).subscribe({
      next: () => {
        this.settlePosition();
      },
    });

    combineLatest([this._onSettleLayout$, this._timeline!.onScroll$])
      .pipe(debounceTime(100))
      .pipe(takeUntil(this._destroyed$))
      .subscribe(() => {
        this.settleAll();
      });

    zip([this._videoController!.onVideoLoaded$.pipe(filter((p) => !!p && !(p.isAttaching || p.isDetaching))), this._vttAdapter.vttFileLoaded$])
      .pipe(takeUntil(this._destroyed$))
      .subscribe({
        next: () => {
          this.createEntities();
        },
      });

    this._videoController!.onVideoLoading$.pipe(
      filter((p) => !(p.isAttaching || p.isDetaching)),
      takeUntil(this._destroyed$)
    ).subscribe({
      next: (event) => {
        this.clearContent();
      },
    });

    if (this.vttUrl) {
      this.loadVtt(this.vttUrl, this.getVttLoadOptions(this._config.axiosConfig));
    }

    if (this._videoController!.isVideoLoaded() && this.vttFile) {
      this.settleAll();
    }

    if (this._config.progressiveSourceUrl && !this.vttUrl) {
      this.startProgressiveWaveform(this._videoController!.getCurrentTime());
      this._videoController!.onSeeked$.pipe(takeUntil(this._destroyed$)).subscribe({
        next: () => {
          this.startProgressiveWaveform(this._videoController!.getCurrentTime());
        },
      });
    }
  }

  setCues(cues: AudioVttCue[]): number {
    this._pendingCues = cues;
    return this.renderPendingCues();
  }

  override onMeasurementsChange() {
    super.onMeasurementsChange();
    this.renderPendingCues();
  }

  protected settleLayout() {
    let timecodedRect = this.getTimecodedRect();

    this._timecodedGroup!.setAttrs({
      x: timecodedRect.x,
      y: timecodedRect.y,
    });

    this._timecodedGroup!.clipFunc((ctx) => {
      ctx.rect(0, 0, timecodedRect.width, timecodedRect.height);
    });

    [this._timecodedGroup, this._timecodedEventCatcher, this._itemsGroup].forEach((node) => {
      node!.width(timecodedRect.width);
    });

    this._onSettleLayout$.next();
  }

  override clearContent() {
    this.clearItems();
  }

  protected override createLoadingGroupObjects(): Array<Konva.Shape | Konva.Group> {
    const rects: Konva.Rect[] = [];

    const range = this._timeline!.getVisiblePositionRange();
    for (let x = range.start; x <= range.end; x += 4) {
      const height = Math.round(((Math.sin((rects.length * 173 * Math.PI) / 16) + 1.5) * this._timecodedGroup!.height()) / 8);

      const rect = KonvaFactory.createRect({
        x,
        y: this._loadingGroup!.height() / 2 - height / 2,
        width: 3,
        height,
        fill: this.resolveLoadingAnimationColor(),
        opacity: 1,
        cornerRadius: 5,
      });
      this._loadingGroup!.add(rect);
      rects.push(rect);
    }
    return rects;
  }

  protected override createLoadingAnimation(): Konva.Animation {
    return new Konva.Animation((frame) => {
      this._loadingGroup!.getChildren().forEach((rect, index) => {
        const frameTime = Math.round((frame?.time ?? 0) / 50);
        const height = (Math.sin((index / 16 + frameTime * Math.PI) / 32) / 4 + 0.8) * Math.round(((Math.sin(((index * 173 + frameTime) * Math.PI) / 16) + 1.5) * this._timecodedGroup!.height()) / 8);
        rect.setAttrs({
          height,
          y: this._timecodedGroup!.height() / 2 - height / 2,
        });
      });
    });
  }

  private clearItems() {
    this._itemsMap.forEach((p) => p.destroy());
    this._itemsMap.clear();
    this._itemsGroup!.destroyChildren();
  }

  private getVisibleCues(): AudioVttCue[] {
    return this._pendingCues ?? this.vttFile?.cues ?? [];
  }

  private renderCues(cues: AudioVttCue[]) {
    if (!this._timeline || !this._itemsGroup) {
      return 0;
    }

    this.clearItems();

    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const audioTrackLaneItem = new AudioTrackLaneItem({
        x: this._timeline.timeToTimelinePosition(cue.startTime),
        width: this.style.itemWidth,
        audioVttCue: cue,
        style: {
          cornerRadius: this.style.itemCornerRadius,
          height: this._itemsGroup.height(),
          visible: true,
          maxSampleFillLinearGradientColorStops: this.style.maxSampleFillLinearGradientColorStops,
          minSampleFillLinearGradientColorStops: this.style.minSampleFillLinearGradientColorStops,
        },
      });

      this._itemsMap.set(i, audioTrackLaneItem);
      this._itemsGroup.add(audioTrackLaneItem.konvaNode);
    }

    this._itemsGroup.getLayer()?.batchDraw();
    return this._itemsMap.size;
  }

  private renderPendingCues() {
    if (!this._timeline || !this._itemsGroup) {
      return 0;
    }

    const cues = this.getVisibleCues();
    if (!cues) {
      return 0;
    }

    const timecodedContainerWidth = this._timeline.getTimecodedContainerDimension().width;
    if (timecodedContainerWidth <= 0) {
      return 0;
    }

    return this.renderCues(cues);
  }

  private createEntities() {
    if (!this.vttFile) {
      throw new Error('VTT file not loaded');
    }

    if (!this._timeline || !this._itemsGroup) {
      throw new Error('TimelineLane not initalized. Maybe you forgot to add TimelineLane to Timeline?');
    }

    this._pendingCues = this.vttFile.cues;
    this.renderPendingCues();
  }

  private settleAll() {
    if (!this._videoController!.isVideoLoaded() || (!this.vttFile && !this._pendingCues)) {
      return;
    }

    this.renderPendingCues();
  }

  private settlePosition() {
    if (this._itemsMap.size > 0) {
      for (let item of this._itemsMap.values()) {
        let cue = item.getAudioVttCue();
        let x = this._timeline!.timeToTimelinePosition(cue.startTime);
        item.setPosition({x});
      }
    }
  }

  private startProgressiveWaveform(startTimestamp: number) {
    if (!this._config.progressiveSourceUrl || this.vttUrl) {
      return;
    }

    const abortController = new AbortController();
    this._progressiveAbortControllers.add(abortController);

    void this.buildProgressiveWaveform(this._config.progressiveSourceUrl, startTimestamp, abortController.signal)
      .catch((error) => {
        if (!abortController.signal.aborted) {
          console.error(error);
        }
      })
      .finally(() => {
        this._progressiveAbortControllers.delete(abortController);
      });
  }

  private async buildProgressiveWaveform(sourceUrl: string, startTimestamp: number, signal?: AbortSignal) {
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const input = new Input({source: new UrlSource(sourceUrl), formats: ALL_FORMATS});
    let updateInFlight = false;
    let updateQueued = false;

    const flushWaveform = async () => {
      if (updateInFlight) {
        updateQueued = true;
        return;
      }

      updateInFlight = true;

      try {
        do {
          updateQueued = false;
          this.setCues(this._progressiveCueStore.cues.slice());
          await nextFrame();
        } while (updateQueued && !signal?.aborted);
      } finally {
        updateInFlight = false;
      }
    };

    try {
      const audioTrack = await input.getPrimaryAudioTrack();
      if (!audioTrack) {
        throw new Error('No audio track available for waveform generation');
      }

      for await (const wrappedBuffer of new AudioBufferSink(audioTrack).buffers(startTimestamp)) {
        if (signal?.aborted) break;

        const peaks = computeBufferPeaks(wrappedBuffer.buffer);
        const startTime = wrappedBuffer.timestamp;
        const endTime = wrappedBuffer.timestamp + wrappedBuffer.duration;
        const cueKey = `${startTime.toFixed(3)}:${endTime.toFixed(3)}:${peaks.minSample}:${peaks.maxSample}`;

        if (!this._progressiveCueStore.cueKeys.has(cueKey)) {
          this._progressiveCueStore.cueKeys.add(cueKey);
          this._progressiveCueStore.cues.push({
            id: `waveform-${this._progressiveCueStore.cues.length}`,
            index: this._progressiveCueStore.cues.length,
            startTime,
            endTime,
            text: '',
            minSample: peaks.minSample,
            maxSample: peaks.maxSample,
          });
          this._progressiveCueStore.cues.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
        }

        void flushWaveform();
      }

      while (updateInFlight && !signal?.aborted) {
        await nextFrame();
      }

      this.setCues(this._progressiveCueStore.cues.slice());
    } finally {
      input.dispose();
      this.setCues(this._progressiveCueStore.cues.slice());
    }
  }

  override destroy() {
    this._progressiveAbortControllers.forEach((controller) => controller.abort());
    this._progressiveAbortControllers.clear();
    destroyer(...this._itemsMap.values());
    super.destroy();
  }
}
