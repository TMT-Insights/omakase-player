import { AudioVttCue } from '../types'
import { AudioVttFile } from './audio-vtt-file'
import { VttLoadOptions } from '../api/vtt-aware-api'

export class MutableAudioVttFile extends AudioVttFile {
  constructor() {
    super('', {} as VttLoadOptions)
  }

  setCues(cues: AudioVttCue[]) {
    this._extensionVersion = void 0
    this._cues = []
    this._cuesByStartTime = new Map<number, AudioVttCue[]>()
    this._cuesStartTimesSorted = []

    cues.forEach((cue) => {
      this._cues.push(cue)
      this._cuesStartTimesSorted.push(cue.startTime)

      const cuesWithStartTime = this._cuesByStartTime.get(cue.startTime)
      this._cuesByStartTime.set(cue.startTime, cuesWithStartTime ? cuesWithStartTime.concat(cue) : [cue])
    })

    this._cuesStartTimesSorted.sort((a, b) => a - b)
  }
}
