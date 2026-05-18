export interface TtmlCaptionTrack {
  regions: TtmlRegion[];
  cues: TtmlCue[];
}

export interface TtmlRegion {
  id: string;
  origin?: {x: number; y: number};
  extent?: {x: number; y: number};
  displayAlign?: 'before' | 'center' | 'after' | string;
  textAlign?: 'start' | 'center' | 'end' | 'left' | 'right' | string;
  writingMode?: 'lrtb' | 'rltb' | 'tb' | string;
  xmlSpace?: 'default' | 'preserve';
  padding?: string;
  style?: Record<string, string>;
}

export interface TtmlCue {
  id: string;
  startTime: number;
  endTime: number;
  regionId?: string;
  textAlign?: 'start' | 'center' | 'end' | 'left' | 'right' | string;
  displayAlign?: 'before' | 'center' | 'after' | string;
  writingMode?: 'lrtb' | 'rltb' | 'tb' | string;
  xmlSpace?: 'default' | 'preserve';
  style?: Record<string, string>;
  content: TtmlContentNode[];
}

export type TtmlContentNode = TtmlTextNode | TtmlBreakNode | TtmlSpanNode;

export interface TtmlTextNode {
  kind: 'text';
  text: string;
}

export interface TtmlBreakNode {
  kind: 'br';
}

export interface TtmlSpanNode {
  kind: 'span';
  children: TtmlContentNode[];
  style?: Record<string, string>;
}
