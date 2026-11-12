import {describe, expect, it} from 'vitest';
import {parseSccCaptions} from '../../src/text/scc-caption-parser';

describe('parseSccCaptions', () => {
  it('decodes text and closes a cue at the end-of-caption control code', () => {
    const cues = parseSccCaptions(`Scenarist_SCC V1.0

00:00:00:00 9420 c8e5 6c6c 6f80
00:00:02:00 942f`);

    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({
      startTime: 0,
      endTime: 2,
      text: 'Hello',
    });
  });

  it('decodes CEA-608 special characters and safely escapes cue markup', () => {
    const cues = parseSccCaptions(`Scenarist_SCC V1.0

00:00:00:00 9420 3c26`);

    expect(cues[0]?.text).toBe('&lt;&amp;');
  });

  it('ignores malformed timecodes and returns no cues for an empty caption file', () => {
    const cues = parseSccCaptions(`Scenarist_SCC V1.0
00:00:99:00 9420 c8e5`);

    expect(cues).toEqual([]);
  });
});
