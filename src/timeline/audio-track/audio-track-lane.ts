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
import {ALL_FORMATS, AudioBufferSink, Input, InputAudioTrack, UrlSource} from 'mediabunny';

type ProgressiveAudioCueStore = {
  cues: AudioVttCue[];
  cueKeys: Set<string>;
};

type ProgressiveWaveformSession = {
  sourceUrl: string;
  abortController: AbortController;
  input: Input;
  audioTrack?: InputAudioTrack;
  cursorTimestamp: number;
  duration: number;
};

function computeBufferPeaks(buffer: AudioBuffer, startSample = 0, endSample = buffer.length) {
  let minSample = 1;
  let maxSample = -1;
  const sampleCount = Math.max(1, endSample - startSample);
  const maxSamplesToInspectPerChannel = 2048;
  const sampleStep = Math.max(1, Math.floor(sampleCount / maxSamplesToInspectPerChannel));

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let i = startSample; i < endSample; i += sampleStep) {
      const sample = samples[i];
      if (sample < minSample) minSample = sample;
      if (sample > maxSample) maxSample = sample;
    }

    const lastSample = samples[endSample - 1];
    if (lastSample < minSample) minSample = lastSample;
    if (lastSample > maxSample) maxSample = lastSample;
  }

  return {
    minSample: Number(minSample.toFixed(3)),
    maxSample: Number(maxSample.toFixed(3)),
  };
}

function normalizeWaveformCues(cues: AudioVttCue[]) {
  const normalizedCues: AudioVttCue[] = [];
  const chunkSeconds = AudioTrackLane.waveformChunkSeconds;

  for (const cue of cues) {
    for (let startTime = cue.startTime; startTime < cue.endTime; startTime += chunkSeconds) {
      const endTime = Math.min(cue.endTime, startTime + chunkSeconds);
      normalizedCues.push({
        ...cue,
        id: `${cue.id}-${normalizedCues.length}`,
        index: normalizedCues.length,
        startTime,
        endTime,
      });
    }
  }

  return normalizedCues;
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
  private _pendingProgressiveVisibleCues: AudioVttCue[] = [];
  private _progressiveMode = false;
  private _progressiveRequestedEndTimestamp = 0;
  private _progressiveDemandResolver?: () => void;
  private _progressiveSession?: ProgressiveWaveformSession;
  static readonly waveformChunkSeconds = 3;
  static readonly progressiveWaveformChunkSeconds = 16;
  private static readonly progressiveWaveformRenderIntervalMs = 1000 / 16;
  private static readonly progressiveWaveformPendingLanes: Set<AudioTrackLane> = new Set<AudioTrackLane>();
  private static readonly progressiveWaveformPendingLayers: Set<Konva.Layer> = new Set<Konva.Layer>();
  private static progressiveWaveformRenderTimeoutId: number | null = null;
  private static progressiveWaveformLastRenderAt = 0;

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
        this.resetProgressiveWaveformSession();
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
      this._progressiveMode = true;
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

  private getVisibleCuesForInterpolation(): AudioVttCue[] {
    let visibleTimeRange = this._timeline!.getVisibleTimeRange();
    let cues = this.vttFile!.findCues(visibleTimeRange.start, visibleTimeRange.end);
    return cues;
  }

  private getVisibleCues(): AudioVttCue[] {
    return this._pendingCues ?? this.vttFile?.cues ?? [];
  }

  private getVisibleCueSubset(cues: AudioVttCue[]): AudioVttCue[] {
    if (!this._timeline) return [] as AudioVttCue[];

    const visibleTimeRange = this._timeline.getVisibleTimeRange();
    return cues.filter((cue) => cue.endTime >= visibleTimeRange.start && cue.startTime <= visibleTimeRange.end);
  }

  private renderCues(cues: AudioVttCue[]) {
    if (!this._timeline || !this._itemsGroup) {
      return 0;
    }

    const normalizedCues = normalizeWaveformCues(cues);

    this.clearItems();

    for (let i = 0; i < normalizedCues.length; i++) {
      const cue = normalizedCues[i];
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

  private getProgressiveVisibleCues() {
    if (!this._timeline) return [] as AudioVttCue[];

    return this.getVisibleCueSubset(this._progressiveCueStore.cues);
  }

  private appendProgressiveCue(cue: AudioVttCue) {
    if (!this._timeline || !this._itemsGroup) return;

    const visibleTimeRange = this._timeline.getVisibleTimeRange();
    this._progressiveCueStore.cues.push(cue);
    if (cue.endTime < visibleTimeRange.start || cue.startTime > visibleTimeRange.end) {
      return;
    }
    this._pendingProgressiveVisibleCues.push(cue);
    this.scheduleProgressiveDraw();
  }

  private scheduleProgressiveDraw() {
    if (this._destroyed$.isStopped) {
      return;
    }

    AudioTrackLane.progressiveWaveformPendingLanes.add(this);
    const layer = this._itemsGroup?.getLayer();
    if (layer) {
      AudioTrackLane.progressiveWaveformPendingLayers.add(layer);
    }

    if (AudioTrackLane.progressiveWaveformRenderTimeoutId !== null) {
      return;
    }

    const now = performance.now();
    const delay = Math.max(0, AudioTrackLane.progressiveWaveformRenderIntervalMs - (now - AudioTrackLane.progressiveWaveformLastRenderAt));

    AudioTrackLane.progressiveWaveformRenderTimeoutId = window.setTimeout(() => {
      AudioTrackLane.progressiveWaveformRenderTimeoutId = null;

      const layersToRender = [...AudioTrackLane.progressiveWaveformPendingLayers];
      const lanesToRender = [...AudioTrackLane.progressiveWaveformPendingLanes];
      AudioTrackLane.progressiveWaveformPendingLanes.clear();
      AudioTrackLane.progressiveWaveformPendingLayers.clear();

      if (layersToRender.length === 0) {
        return;
      }

      AudioTrackLane.progressiveWaveformLastRenderAt = performance.now();
      lanesToRender.forEach((lane) => lane.flushPendingProgressiveCues());
      layersToRender.forEach((drawLayer) => drawLayer.batchDraw());
    }, delay);
  }

  private flushPendingProgressiveCues() {
    if (!this._timeline || !this._itemsGroup || this._pendingProgressiveVisibleCues.length === 0) {
      this._pendingProgressiveVisibleCues = [];
      return;
    }

    for (const cue of this._pendingProgressiveVisibleCues) {
      if (this._itemsMap.has(cue.index)) {
        continue;
      }

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

      this._itemsMap.set(cue.index, audioTrackLaneItem);
      this._itemsGroup.add(audioTrackLaneItem.konvaNode);
    }

    this._pendingProgressiveVisibleCues = [];
    this._itemsGroup.getLayer()?.batchDraw();
  }

  private renderProgressiveVisibleCues() {
    if (!this._timeline || !this._itemsGroup) {
      return 0;
    }

    const visibleCues = this.getProgressiveVisibleCues();
    const visibleCueIndexes = new Set<number>();

    for (const cue of visibleCues) {
      visibleCueIndexes.add(cue.index);

      const existingItem = this._itemsMap.get(cue.index);
      if (existingItem) {
        existingItem.setPosition({x: this._timeline.timeToTimelinePosition(cue.startTime)});
        continue;
      }

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

      this._itemsMap.set(cue.index, audioTrackLaneItem);
      this._itemsGroup.add(audioTrackLaneItem.konvaNode);
    }

    for (const [cueIndex, item] of [...this._itemsMap.entries()]) {
      if (!visibleCueIndexes.has(cueIndex)) {
        item.destroy();
        this._itemsMap.delete(cueIndex);
      }
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

    if (!this._timeline) {
      throw new Error('TimelineLane not initalized. Maybe you forgot to add TimelineLane to Timeline?');
    }

    this.clearItems();

    let timecodedContainerWidth = this._timeline.getTimecodedContainerDimension().width;

    let numOfInterpolations = new Decimal(timecodedContainerWidth + this.style.itemMinPadding)
      .div(this.style.itemWidth + this.style.itemMinPadding)
      .floor()
      .toNumber();

    let itemPadding = new Decimal(timecodedContainerWidth - numOfInterpolations * this.style.itemWidth).div(numOfInterpolations - 1).toNumber();

    let cuesInterpolations = this.resolveCuesInterpolations(numOfInterpolations, itemPadding);

    for (let i = 0; i < numOfInterpolations; i++) {
      let cue = cuesInterpolations.get(i);
      if (cue) {
        let itemPosition = this.resolveInterpolatedItemPosition(i, itemPadding);

        let audioTrackLaneItem = new AudioTrackLaneItem({
          x: itemPosition,
          width: this.style.itemWidth,
          audioVttCue: cue,
          style: {
            cornerRadius: this.style.itemCornerRadius,
            height: this._itemsGroup!.height(),
            visible: true,
            maxSampleFillLinearGradientColorStops: this.style.maxSampleFillLinearGradientColorStops,
            minSampleFillLinearGradientColorStops: this.style.minSampleFillLinearGradientColorStops,
          },
        });

        this._itemsMap.set(i, audioTrackLaneItem);
        this._itemsGroup!.add(audioTrackLaneItem.konvaNode);
      }
    }
  }

  private resolveCuesInterpolations(numOfInterpolations: number, paddingWidth: number): Map<number, AudioVttCue> {
    let visibleCues = this.getVisibleCuesForInterpolation();

    let barWidth = this.style.itemWidth;

    let cuesInterpolations: Map<number, AudioVttCue> = new Map<number, AudioVttCue>();

    for (let i = 0; i < numOfInterpolations; i++) {
      let isFirst = i === 0;
      let isLast = i === numOfInterpolations - 1;
      let interpolationStartX: number;
      let interpolationEndX: number;

      if (isFirst) {
        // first interpolation
        interpolationStartX = 0;
        interpolationEndX = new Decimal(barWidth).plus(new Decimal(paddingWidth).div(2)).toNumber();
      } else if (isLast) {
        // last interpolation
        interpolationStartX = new Decimal(i)
          .mul(barWidth + paddingWidth)
          .minus(new Decimal(paddingWidth).div(2))
          .toNumber();
        interpolationEndX = this._timeline!.getTimecodedContainerDimension().width;
      } else {
        // every interpolation in between first and last
        interpolationStartX = new Decimal(i)
          .mul(barWidth + paddingWidth)
          .minus(new Decimal(paddingWidth).div(2))
          .toNumber();
        interpolationEndX = new Decimal(interpolationStartX).plus(barWidth).plus(paddingWidth).toNumber();
      }

      let interpolationStartTime = this._timeline!.timelineContainerPositionToTime(interpolationStartX);
      let interpolationEndTime = this._timeline!.timelineContainerPositionToTime(interpolationEndX);

      let cuesForInterpolation = visibleCues.filter((cue) => {
        let inside = cue.startTime >= interpolationStartTime && (isLast ? cue.endTime <= interpolationEndTime : cue.endTime < interpolationEndTime);
        let leftIntersection = cue.startTime < interpolationStartTime && cue.endTime >= interpolationStartTime && (isLast ? cue.endTime <= interpolationEndTime : cue.endTime < interpolationEndTime);
        let rightIntersection =
          cue.startTime >= interpolationStartTime && (isLast ? cue.startTime <= interpolationEndTime : cue.startTime < interpolationEndTime) && cue.endTime > interpolationEndTime;
        let completeIntersection = cue.startTime < interpolationStartTime && cue.endTime > interpolationEndTime;
        return inside || leftIntersection || rightIntersection || completeIntersection;
      });

      let cue: AudioVttCue = {
        index: i,
        id: `${i}`,
        text: '',
        minSample: 0,
        maxSample: 0,
        startTime: interpolationStartTime,
        endTime: interpolationEndTime,
      };

      if (cuesForInterpolation.length > 0) {
        let minSampleSum = 0,
          maxSampleSum = 0;
        cuesForInterpolation.forEach((cue) => {
          minSampleSum += cue.minSample;
          maxSampleSum += cue.maxSample;
        });

        cue = {
          ...cue,
          minSample: new Decimal(minSampleSum).div(cuesForInterpolation.length).toDecimalPlaces(3).toNumber(),
          maxSample: new Decimal(maxSampleSum).div(cuesForInterpolation.length).toDecimalPlaces(3).toNumber(),
        };
      }

      cuesInterpolations.set(i, cue);
    }

    return cuesInterpolations;
  }

  private settleAll() {
    if (!this._videoController!.isVideoLoaded() || !this.vttFile) {
      return;
    }

    if (this._progressiveMode && !this.vttUrl) {
      this.renderProgressiveVisibleCues();
      return;
    }

    this.createEntities();
  }

  private resolveInterpolatedItemPosition(itemIndex: number, itemPadding: number) {
    return Math.abs(this._timeline!.getTimecodedFloatingHorizontals().x) + itemIndex * this.style.itemWidth + itemIndex * itemPadding;
  }

  private settlePosition() {
    if (!this._videoController!.isVideoLoaded() || !this.vttFile) {
      return;
    }

    if (this._itemsMap.size > 0) {
      let visibleTimeRange = this._timeline!.getVisibleTimeRange();
      for (const [cueIndex, item] of [...this._itemsMap.entries()]) {
        let cue = item.getAudioVttCue();
        if ((cue.startTime >= visibleTimeRange.start && cue.startTime <= visibleTimeRange.end) || (cue.endTime >= visibleTimeRange.start && cue.endTime <= visibleTimeRange.end)) {
          let x = this._timeline!.timeToTimelinePosition(cue.startTime);
          item.setPosition({x});
        } else {
          item.destroy();
          this._itemsMap.delete(cueIndex);
        }
      }
    }

    if (this._progressiveMode && !this.vttUrl) {
      this.renderProgressiveVisibleCues();
    }

  }

  private startProgressiveWaveform(startTimestamp: number) {
    this._progressiveMode = true;
    this.requestProgressiveWaveform(startTimestamp);
  }

  private getProgressiveTargetEndTimestamp(startTimestamp: number) {
    return startTimestamp + 30;
  }

  private requestProgressiveWaveform(startTimestamp: number) {
    const sourceUrl = this._config.progressiveSourceUrl;
    if (!sourceUrl || this.vttUrl) {
      return;
    }

    this._progressiveRequestedEndTimestamp = Math.max(this._progressiveRequestedEndTimestamp, this.getProgressiveTargetEndTimestamp(startTimestamp));
    this._progressiveDemandResolver?.();
    this._progressiveDemandResolver = undefined;

    if (this._progressiveSession && this._progressiveSession.sourceUrl === sourceUrl) {
      this.renderProgressiveVisibleCues();
      return;
    }

    if (this._progressiveSession) {
      this._progressiveSession.abortController.abort();
    }

    const abortController = new AbortController();
    const session: ProgressiveWaveformSession = {
      sourceUrl,
      abortController,
      input: new Input({source: new UrlSource(sourceUrl), formats: ALL_FORMATS}),
      cursorTimestamp: startTimestamp,
      duration: this._videoController!.getDuration(),
    };
    this._progressiveSession = session;

    void this.buildProgressiveWaveform(session)
      .catch((error) => {
        if (!abortController.signal.aborted) {
          console.error(error);
        }
      })
      .finally(() => {
        if (this._progressiveSession === session) {
          this._progressiveSession = undefined;
        }
      });
  }

  private async waitForProgressiveDemand(signal: AbortSignal) {
    if (signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      this._progressiveDemandResolver = resolve;
    });
  }

  private async yieldProgressiveWork() {
    // Flush any visible chunks we already generated before handing control back.
    this.flushPendingProgressiveCues();

    await new Promise<void>((resolve) => {
      const requestIdle = window.requestIdleCallback as undefined | ((callback: IdleRequestCallback, options?: IdleRequestOptions) => number);
      if (requestIdle) {
        requestIdle(() => {
          this.flushPendingProgressiveCues();
          resolve();
        }, {timeout: 250});
        return;
      }

      window.requestAnimationFrame(() => {
        this.flushPendingProgressiveCues();
        resolve();
      });
    });
  }

  private async buildProgressiveWaveform(session: ProgressiveWaveformSession) {
    const input = session.input;

    try {
      const audioTrack = await input.getPrimaryAudioTrack();
      if (!audioTrack) {
        throw new Error('No audio track available for waveform generation');
      }

      session.audioTrack = audioTrack;
      session.duration = this._videoController!.getDuration();
      let chunksSinceYield = 0;
      let lastYieldAt = performance.now();

      while (!session.abortController.signal.aborted) {
        if (session.cursorTimestamp >= this._progressiveRequestedEndTimestamp) {
          if (this._progressiveRequestedEndTimestamp < session.duration) {
            this._progressiveRequestedEndTimestamp = Math.min(
              session.duration,
              this._progressiveRequestedEndTimestamp + AudioTrackLane.progressiveWaveformChunkSeconds
            );
            continue;
          }

          await this.waitForProgressiveDemand(session.abortController.signal);
          continue;
        }

        const chunkEndTimestamp = Math.min(this._progressiveRequestedEndTimestamp, session.cursorTimestamp + AudioTrackLane.progressiveWaveformChunkSeconds);

        for await (const wrappedBuffer of new AudioBufferSink(audioTrack).buffers(session.cursorTimestamp, chunkEndTimestamp)) {
          if (session.abortController.signal.aborted) {
            break;
          }

          const bufferStartTimestamp = wrappedBuffer.timestamp;
          const bufferEndTimestamp = wrappedBuffer.timestamp + wrappedBuffer.duration;
          const sampleRate = wrappedBuffer.buffer.sampleRate;

          for (let chunkStartTimestamp = bufferStartTimestamp; chunkStartTimestamp < bufferEndTimestamp && !session.abortController.signal.aborted; ) {
            const chunkEndTimestamp = Math.min(bufferEndTimestamp, chunkStartTimestamp + AudioTrackLane.progressiveWaveformChunkSeconds);
            const startSample = Math.max(0, Math.floor((chunkStartTimestamp - bufferStartTimestamp) * sampleRate));
            const endSample = Math.min(wrappedBuffer.buffer.length, Math.max(startSample + 1, Math.ceil((chunkEndTimestamp - bufferStartTimestamp) * sampleRate)));
            const peaks = computeBufferPeaks(wrappedBuffer.buffer, startSample, endSample);
            const cueKey = `${chunkStartTimestamp.toFixed(3)}:${chunkEndTimestamp.toFixed(3)}:${peaks.minSample}:${peaks.maxSample}`;

            if (!this._progressiveCueStore.cueKeys.has(cueKey)) {
              this._progressiveCueStore.cueKeys.add(cueKey);
              const cue = {
                id: `waveform-${this._progressiveCueStore.cues.length}`,
                index: this._progressiveCueStore.cues.length,
                startTime: chunkStartTimestamp,
                endTime: chunkEndTimestamp,
                text: '',
                minSample: peaks.minSample,
                maxSample: peaks.maxSample,
              };
              this.appendProgressiveCue(cue);
            }

            chunkStartTimestamp = chunkEndTimestamp;

            chunksSinceYield += 1;
            const now = performance.now();
            if (chunksSinceYield >= 192 || now - lastYieldAt >= 32) {
              chunksSinceYield = 0;
              lastYieldAt = now;
              await this.yieldProgressiveWork();
            }
          }

          session.cursorTimestamp = bufferEndTimestamp;
        }

      }

    } finally {
      input.dispose();
      this.renderProgressiveVisibleCues();
    }
  }

  private resetProgressiveWaveformSession() {
    this._progressiveDemandResolver?.();
    this._progressiveDemandResolver = undefined;
    this._progressiveRequestedEndTimestamp = 0;
    this._progressiveCueStore = {cues: [], cueKeys: new Set<string>()};

    if (this._progressiveSession) {
      this._progressiveSession.abortController.abort();
      this._progressiveSession = undefined;
    }
  }

  override destroy() {
    AudioTrackLane.progressiveWaveformPendingLanes.delete(this);
    this.resetProgressiveWaveformSession();
    destroyer(...this._itemsMap.values());
    super.destroy();
  }
}
