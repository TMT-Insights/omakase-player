import {TtmlCaptionTrack, TtmlContentNode, TtmlCue, TtmlRegion} from './ttml-types';

export interface TtmlCaptionsRendererInit {
  dir?: 'ltr' | 'rtl';
}

export class TtmlCaptionsRenderer {
  readonly overlay: HTMLElement;
  private _track?: TtmlCaptionTrack;
  private _currentTime = 0;
  private _dir: 'ltr' | 'rtl' = 'ltr';
  private _resizeObserver: ResizeObserver;

  constructor(overlay: HTMLElement, init?: TtmlCaptionsRendererInit) {
    this.overlay = overlay;
    this.dir = init?.dir ?? 'ltr';
    this.overlay.setAttribute('translate', 'yes');
    this.overlay.setAttribute('aria-live', 'off');
    this.overlay.setAttribute('aria-atomic', 'true');
    this._resizeObserver = new ResizeObserver(() => this.update(true));
    this._resizeObserver.observe(this.overlay);
  }

  get dir() {
    return this._dir;
  }

  set dir(dir: 'ltr' | 'rtl') {
    this._dir = dir;
    this.overlay.setAttribute('dir', dir);
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(time: number) {
    this._currentTime = time;
    this.update();
  }

  changeTrack(track: TtmlCaptionTrack) {
    this._track = track;
    this.update(true);
  }

  update(forceUpdate = false) {
    if (!this._track) {
      this.overlay.replaceChildren();
      return;
    }

    const activeCues = this._track.cues
      .filter((cue) => this._currentTime >= cue.startTime && this._currentTime <= cue.endTime)
      .sort((cueA, cueB) => (cueA.startTime !== cueB.startTime ? cueA.startTime - cueB.startTime : cueA.endTime - cueB.endTime));

    if (!activeCues.length) {
      this.overlay.replaceChildren();
      return;
    }

    const overlayBox = this.overlay.getBoundingClientRect();
    this.overlay.replaceChildren();

    const regionCueMap = new Map<string, TtmlCue[]>();
    const rootCues: TtmlCue[] = [];

    for (const cue of activeCues) {
      const region = cue.regionId ? this._track.regions.find((candidate) => candidate.id === cue.regionId) : undefined;
      if (region) {
        const list = regionCueMap.get(region.id) ?? [];
        list.push(cue);
        regionCueMap.set(region.id, list);
      } else {
        rootCues.push(cue);
      }
    }

    for (const cue of rootCues) {
      this.overlay.appendChild(this.createCueElement(cue, void 0));
    }

    for (const region of this._track.regions) {
      const regionCues = regionCueMap.get(region.id);
      if (!regionCues?.length) {
        continue;
      }

      const regionElement = this.createRegionElement(region);
      for (const cue of regionCues) {
        regionElement.appendChild(this.createCueContent(cue, region));
      }
      this.overlay.appendChild(regionElement);
    }
  }

  reset() {
    this._track = void 0;
    this.overlay.replaceChildren();
  }

  destroy() {
    this.reset();
    this._resizeObserver.disconnect();
  }

  private createCueElement(cue: TtmlCue, region: TtmlRegion | undefined): HTMLElement {
    const cueBox = document.createElement('div');
    cueBox.style.position = 'absolute';
    cueBox.style.pointerEvents = 'none';
    cueBox.style.boxSizing = 'border-box';
    cueBox.style.whiteSpace = cue.xmlSpace === 'preserve' || region?.xmlSpace === 'preserve' ? 'pre-wrap' : 'normal';
    cueBox.style.wordBreak = 'break-word';
    cueBox.style.color = 'white';
    cueBox.style.fontFamily = 'Arial, sans-serif';
    cueBox.style.fontSize = 'clamp(20px, 2.6vw, 36px)';
    cueBox.style.textAlign = (cue.textAlign ?? region?.textAlign ?? 'center') as any;

    const geometry = region?.origin && region?.extent ? {left: region.origin.x, top: region.origin.y, width: region.extent.x, height: region.extent.y} : {left: 10, top: 80, width: 80, height: 18};

    cueBox.style.left = `${geometry.left}%`;
    cueBox.style.top = `${geometry.top}%`;
    cueBox.style.width = `${geometry.width}%`;
    cueBox.style.height = `${geometry.height}%`;
    cueBox.style.display = 'flex';
    cueBox.style.flexDirection = 'column';
    cueBox.style.justifyContent = this.getBlockAlignment(cue.displayAlign ?? region?.displayAlign);
    cueBox.style.alignItems = this.getTextAlignment(cue.textAlign ?? region?.textAlign);
    cueBox.style.direction = this._dir;

    if (cue.style) {
      for (const prop of Object.keys(cue.style)) {
        cueBox.style.setProperty(prop, cue.style[prop]);
      }
    }

    if (region?.writingMode) {
      cueBox.style.writingMode = this.getWritingMode(region.writingMode);
    }

    cueBox.appendChild(this.createCueContent(cue, region));
    return cueBox;
  }

  private createRegionElement(region: TtmlRegion): HTMLElement {
    const regionBox = document.createElement('div');
    regionBox.style.position = 'absolute';
    regionBox.style.pointerEvents = 'none';
    regionBox.style.boxSizing = 'border-box';
    regionBox.style.left = `${region.origin?.x ?? 0}%`;
    regionBox.style.top = `${region.origin?.y ?? 0}%`;
    regionBox.style.width = `${region.extent?.x ?? 100}%`;
    regionBox.style.height = `${region.extent?.y ?? 100}%`;
    regionBox.style.display = 'flex';
    regionBox.style.flexDirection = 'column';
    regionBox.style.overflow = 'hidden';
    regionBox.style.justifyContent = this.getBlockAlignment(region.displayAlign);
    regionBox.style.alignItems = this.getTextAlignment(region.textAlign);
    regionBox.style.rowGap = '0.35em';

    if (region.padding) {
      regionBox.style.padding = region.padding;
    }
    if (region.style) {
      for (const prop of Object.keys(region.style)) {
        regionBox.style.setProperty(prop, region.style[prop]);
      }
    }
    if (region.writingMode) {
      regionBox.style.writingMode = this.getWritingMode(region.writingMode);
    }

    return regionBox;
  }

  private createCueContent(cue: TtmlCue, region: TtmlRegion | undefined): HTMLElement {
    const content = document.createElement('div');
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.maxWidth = '100%';
    content.style.width = 'max-content';
    content.style.background = 'rgba(0, 0, 0, 0.82)';
    content.style.padding = '0.35em 0.65em';
    content.style.borderRadius = '0.15em';
    content.style.textAlign = (cue.textAlign ?? region?.textAlign ?? 'center') as any;
    content.style.alignSelf = this.getTextAlignment(cue.textAlign ?? region?.textAlign);
    content.style.whiteSpace = cue.xmlSpace === 'preserve' || region?.xmlSpace === 'preserve' ? 'pre-wrap' : 'normal';
    content.style.wordBreak = 'break-word';
    content.style.lineHeight = '1.2';
    content.style.rowGap = '0.12em';

    if (cue.style) {
      for (const prop of Object.keys(cue.style)) {
        content.style.setProperty(prop, cue.style[prop]);
      }
    }

    for (const line of this.buildCueLines(cue.content)) {
      const lineEl = document.createElement('div');
      lineEl.style.display = 'block';
      lineEl.style.width = 'fit-content';
      lineEl.style.maxWidth = '100%';
      lineEl.style.whiteSpace = cue.xmlSpace === 'preserve' || region?.xmlSpace === 'preserve' ? 'pre-wrap' : 'normal';
      lineEl.style.wordBreak = 'break-word';
      lineEl.style.alignSelf = this.getTextAlignment(cue.textAlign ?? region?.textAlign);
      lineEl.style.textAlign = (cue.textAlign ?? region?.textAlign ?? 'center') as any;

      for (const node of line) {
        lineEl.appendChild(this.renderNode(node));
      }

      content.appendChild(lineEl);
    }

    return content;
  }

  private buildCueLines(nodes: TtmlContentNode[]): TtmlContentNode[][] {
    const lines: TtmlContentNode[][] = [[]];

    for (const node of nodes) {
      if (node.kind === 'br') {
        lines.push([]);
      } else {
        lines[lines.length - 1].push(node);
      }
    }

    return lines.filter((line) => line.length > 0);
  }

  private renderNode(node: TtmlContentNode): Node {
    switch (node.kind) {
      case 'text':
        return document.createTextNode(node.text);
      case 'br':
        return document.createElement('br');
      case 'span': {
        const span = document.createElement('span');
        if (node.style) {
          for (const prop of Object.keys(node.style)) {
            span.style.setProperty(prop, node.style[prop]);
          }
        }
        for (const child of node.children) {
          span.appendChild(this.renderNode(child));
        }
        return span;
      }
    }
  }

  private getBlockAlignment(displayAlign?: string) {
    switch ((displayAlign ?? 'before').toLowerCase()) {
      case 'after':
        return 'flex-end';
      case 'center':
        return 'center';
      default:
        return 'flex-start';
    }
  }

  private getTextAlignment(textAlign?: string) {
    switch ((textAlign ?? 'center').toLowerCase()) {
      case 'left':
      case 'start':
        return 'flex-start';
      case 'right':
      case 'end':
        return 'flex-end';
      case 'center':
      default:
        return 'center';
    }
  }

  private getWritingMode(mode: string) {
    switch (mode.toLowerCase()) {
      case 'rltb':
        return 'vertical-rl';
      case 'tb':
        return 'vertical-lr';
      default:
        return 'horizontal-tb';
    }
  }
}
