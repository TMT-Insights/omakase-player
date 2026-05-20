/*
 * Copyright 2025 ByOmakase, LLC (https://byomakase.org)
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

import {AudioPeakProcessorMessageEvent, Destroyable} from '../types';
import {BehaviorSubject, Observable, Subject, takeUntil} from 'rxjs';
import {AudioMeterStandard, OmpAudioPeakProcessorState} from './model';
import {completeUnsubscribeSubjects, nextCompleteObserver, nextCompleteSubject} from '../util/rxjs-util';
import {BlobUtil} from '../util/blob-util';
import {AudioPeakProcessorApi} from '../api/audio-peak-processor-api';

const peakSampleProcessor = `
class OmpPeakSampleProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const peaks = input.map((channel) => {
      let max = 0;
      for (let s = 0; s < channel.length; s += 1) {
        const abs = Math.abs(channel[s]);
        if (abs > max) max = abs;
      }
      return max;
    });
    this.port.postMessage({type: 'peaks', peaks});
    return true;
  }
}

try {
  registerProcessor('omp-peak-sample-processor', OmpPeakSampleProcessor);
} catch (err) {
  console.info('Failed to register omp-peak-sample-processor. This probably means it was already registered.');
}
`;

const truePeakProcessor = `
function calculateLPFCoefficients(numCoefficients, upsampleFactor) {
  const retCoefs = [];
  const fcRel = 1.0 / (4.0 * upsampleFactor);
  const minCoefN = 1 - Math.ceil(numCoefficients / 2);
  const maxCoefN = Math.floor(numCoefficients / 2);
  for (let n = minCoefN; n <= maxCoefN; n++) {
    const wn = 0.54 + 0.46 * Math.cos(2.0 * Math.PI * n / numCoefficients);
    let hn = 0.0;
    if (n == 0) {
      hn = 2.0 * fcRel;
    } else {
      hn = Math.sin(2.0 * Math.PI * fcRel * n) / (Math.PI * n);
    }
    hn = (wn * hn) * upsampleFactor;
    retCoefs.push(hn);
  }
  return retCoefs;
}

function filterSample(lpfBuffer, lpfCoefficients, upsampleFactor) {
  const upsampled = [];
  for (let nA = 0; nA < upsampleFactor; nA += 1) {
    let nT = 0;
    let retVal = 0;
    for (let nc = nA; nc < lpfCoefficients.length; nc += upsampleFactor) {
      retVal += (lpfCoefficients[nc] * lpfBuffer[lpfBuffer.length - 1 - nT]);
      nT += 1;
    }
    upsampled.push(retVal);
  }
  return upsampled;
}

function truePeakValues(input, lpfBuffers, lpfCoefficients, upsampleFactor) {
  return input.map((channel, i) => {
    const lpfBuffer = lpfBuffers[i];
    let max = 0;
    for (let s = 0; s < channel.length; s++) {
      const sample = channel[s];
      lpfBuffer.push(sample);
      lpfBuffer.shift();
      const upSampled = filterSample(lpfBuffer, lpfCoefficients, upsampleFactor);
      for (let u = 0; u < upSampled.length; u++) {
        const uAbs = Math.abs(upSampled[u]);
        if (uAbs > max) {
          max = uAbs;
        }
      }
    }
    return max;
  });
}

class TruePeakProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.numCoefficients = 33;
    this.sampleRate = sampleRate;
    this.upsampleFactor = this.sampleRate > 80000 ? 2 : 4;
    this.lpfCoefficients = calculateLPFCoefficients(this.numCoefficients, this.upsampleFactor);
    this.lpfBuffers = [];
    this.port.postMessage({type: 'message', message: 'true peak inited? ' + this.sampleRate});
    this.processCount = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input.length > this.lpfBuffers.length) {
      for (let i = 1; i <= input.length; i += 1) {
        if (i > this.lpfBuffers.length) {
          this.lpfBuffers.push(new Array(this.numCoefficients).fill(0));
        }
      }
    }
    const maxes = truePeakValues(input, this.lpfBuffers, this.lpfCoefficients, this.upsampleFactor);
    this.port.postMessage({type: 'peaks', peaks: maxes});
    this.processCount += 1;
    return true;
  }
}

try {
  registerProcessor('omp-true-peak-processor', TruePeakProcessor);
} catch (err) {
  console.info('Failed to register omp-true-peak-processor. This probably means it was already registered.');
}
`;

export class OmpAudioPeakProcessor implements AudioPeakProcessorApi, Destroyable {
  public readonly onAudioWorkletLoaded$: BehaviorSubject<AudioWorkletNode | undefined> = new BehaviorSubject<AudioWorkletNode | undefined>(void 0);
  public readonly onMessage$: Subject<AudioPeakProcessorMessageEvent> = new Subject<AudioPeakProcessorMessageEvent>();

  protected _audioMeterStandard: AudioMeterStandard;

  protected _sourceAudioNode?: AudioNode;
  protected _audioWorkletNode?: AudioWorkletNode;

  protected _destroyed$ = new Subject<void>();

  constructor(audioContext: AudioContext, audioMeterStandard?: AudioMeterStandard) {
    this._audioMeterStandard = audioMeterStandard ? audioMeterStandard : 'peak-sample';

    this.init(audioContext);
  }

  protected init(audioContext: AudioContext) {
    let createAudioWorkletNode: () => Observable<AudioWorkletNode> = () => {
      return new Observable((observer) => {
        let audioWorkletNodeName = `omp-${this._audioMeterStandard}-processor`; // name unique to omakase-player
        try {
          let audioWorkletNode = new AudioWorkletNode(audioContext, audioWorkletNodeName, {
            parameterData: {},
          });
          nextCompleteObserver(observer, audioWorkletNode);
        } catch (e) {
          const workletCode = this._audioMeterStandard === 'true-peak' ? truePeakProcessor : peakSampleProcessor;
          let objectURL = BlobUtil.createObjectURL(BlobUtil.createBlob([workletCode], {type: 'application/javascript'}));

          audioContext.audioWorklet.addModule(objectURL).then(() => {
            let audioWorkletNode = new AudioWorkletNode(audioContext, audioWorkletNodeName, {
              parameterData: {},
            });
            nextCompleteObserver(observer, audioWorkletNode);
          });
        }
      });
    };

    createAudioWorkletNode()
      .pipe(takeUntil(this._destroyed$))
      .subscribe({
        next: (audioWorkletNode) => {
          this._audioWorkletNode = audioWorkletNode;
          this._audioWorkletNode.port.onmessage = (event: MessageEvent) => {
            this.handleAudioPeakProcessorMessage(event);
          };
          this.onAudioWorkletLoaded$.next(this._audioWorkletNode);
        },
        error: (error) => {
          throw new Error(error);
        },
      });
  }

  disconnectSource() {
    if (this.isSourceConnected && this._audioWorkletNode) {
      try {
        this._sourceAudioNode!.disconnect(this._audioWorkletNode);
        this._audioWorkletNode.disconnect();
      } catch (e) {
        console.debug();
      }
    }
  }

  connectSource(audioNode: AudioNode) {
    this.disconnectSource();
    if (this._audioWorkletNode) {
      this._sourceAudioNode = audioNode;
      this._sourceAudioNode.connect(this._audioWorkletNode).connect(this._sourceAudioNode.context.destination);
    } else {
      console.debug(`AudioWorkletNode not initialized`);
    }
  }

  get isSourceConnected(): boolean {
    return !!this._sourceAudioNode;
  }

  get sourceAudioNode(): AudioNode | undefined {
    return this._sourceAudioNode;
  }

  getAudioPeakProcessorState(): OmpAudioPeakProcessorState {
    return {
      audioMeterStandard: this._audioMeterStandard,
    };
  }

  protected handleAudioPeakProcessorMessage = (event: MessageEvent) => {
    this.onMessage$.next({
      data: event.data,
    });
  };

  destroy(): void {
    try {
      if (this._sourceAudioNode) {
        this._sourceAudioNode.disconnect();
      }

      if (this._audioWorkletNode) {
        this._audioWorkletNode.disconnect();
        // this._audioPeakProcessorWorkletNode.port.postMessage('stop')
        this._audioWorkletNode.port.onmessage = null;
        this._audioWorkletNode.port.close();
        this._audioWorkletNode = void 0;
      }

      completeUnsubscribeSubjects(this.onMessage$, this.onAudioWorkletLoaded$);

      nextCompleteSubject(this._destroyed$);
    } catch (e) {
      console.debug(e);
    }
  }
}
