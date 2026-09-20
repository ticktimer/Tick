// assignLanes — side-by-side layout for blocks sharing a calendar column — and
// clusterSpans, which folds each cluster of overlapping blocks into one span.
import { describe, expect, it } from 'vitest'
import type { Span } from '../../app/utils/lanes'
import { assignLanes, clusterSpans } from '../../app/utils/lanes'

const span = (top: number, h: number) => ({ top, h })
const L = (lane: number, lanes: number, cluster: number) => ({ lane, lanes, cluster })
/** The spans of `items` as the calendar computes them: from their own lanes. */
const spansOf = (items: Span[]) => clusterSpans(items, assignLanes(items))

describe('assignLanes', () => {
  it('gives a lone block the whole width', () => {
    expect(assignLanes([span(0, 60)])).toEqual([L(0, 1, 0)])
  })

  it('leaves blocks that never touch at full width', () => {
    // Back to back is not overlapping: the second starts exactly where the first ends.
    expect(assignLanes([span(0, 60), span(60, 30), span(200, 10)])).toEqual([
      L(0, 1, 0),
      L(0, 1, 1),
      L(0, 1, 2)
    ])
  })

  it('puts two overlapping blocks side by side', () => {
    expect(assignLanes([span(0, 60), span(30, 60)])).toEqual([
      L(0, 2, 0),
      L(1, 2, 0)
    ])
  })

  it('reuses a lane once its block has ended, and sizes the cluster by its busiest moment', () => {
    // A 0–60, B 30–90, C 60–120: C overlaps B but not A, so it can take A's lane —
    // the cluster is never more than two wide.
    expect(assignLanes([span(0, 60), span(30, 60), span(60, 60)])).toEqual([
      L(0, 2, 0),
      L(1, 2, 0),
      L(0, 2, 0)
    ])
  })

  it('needs three lanes for three blocks that all overlap', () => {
    expect(assignLanes([span(0, 100), span(10, 100), span(20, 100)])).toEqual([
      L(0, 3, 0),
      L(1, 3, 0),
      L(2, 3, 0)
    ])
  })

  it('keeps separate clusters independent', () => {
    // Two overlapping in the morning, one alone in the afternoon: the afternoon
    // block is not narrowed by a cluster it has nothing to do with.
    expect(assignLanes([span(0, 60), span(30, 60), span(500, 60)])).toEqual([
      L(0, 2, 0),
      L(1, 2, 0),
      L(0, 1, 1)
    ])
  })

  it('answers in input order, whatever order the blocks start in', () => {
    expect(assignLanes([span(30, 60), span(0, 60)])).toEqual([
      L(1, 2, 0),
      L(0, 2, 0)
    ])
  })

  it('lets the longer of two blocks that start together keep the first lane', () => {
    expect(assignLanes([span(0, 30), span(0, 120)])).toEqual([
      L(1, 2, 0),
      L(0, 2, 0)
    ])
  })

  it('numbers clusters in start order, not input order', () => {
    // The afternoon block is listed first but starts last: it is cluster 1.
    expect(assignLanes([span(500, 60), span(0, 60), span(30, 60)])).toEqual([
      L(0, 1, 1),
      L(0, 2, 0),
      L(1, 2, 0)
    ])
  })

  it('has nothing to say about an empty column', () => {
    expect(assignLanes([])).toEqual([])
  })
})

describe('clusterSpans', () => {
  it('makes a lone block its own cluster', () => {
    expect(spansOf([span(0, 60)])).toEqual([
      { cluster: 0, lanes: 1, top: 0, h: 60, members: [0] }
    ])
  })

  it('folds a chained pair into one span with the union envelope', () => {
    // A 0–60 and B 30–90: one span from A's top to B's bottom, two lanes wide.
    expect(spansOf([span(0, 60), span(30, 60)])).toEqual([
      { cluster: 0, lanes: 2, top: 0, h: 90, members: [0, 1] }
    ])
    // Through a chain as well — C only touches B, and the envelope still runs
    // down to C's end while the width stays at the busiest moment.
    expect(spansOf([span(0, 60), span(30, 60), span(60, 60)])).toEqual([
      { cluster: 0, lanes: 2, top: 0, h: 120, members: [0, 1, 2] }
    ])
  })

  it('numbers two independent clusters 0 and 1 in start order', () => {
    expect(spansOf([span(0, 60), span(30, 60), span(500, 60)])).toEqual([
      { cluster: 0, lanes: 2, top: 0, h: 90, members: [0, 1] },
      { cluster: 1, lanes: 1, top: 500, h: 60, members: [2] }
    ])
    // Same answer when the afternoon block is listed first: the spans come
    // back in cluster order, and only the member indices move.
    expect(spansOf([span(500, 60), span(0, 60), span(30, 60)])).toEqual([
      { cluster: 0, lanes: 2, top: 0, h: 90, members: [1, 2] },
      { cluster: 1, lanes: 1, top: 500, h: 60, members: [0] }
    ])
  })

  it('lists members in start order, input order among equals', () => {
    expect(spansOf([span(30, 60), span(0, 60), span(15, 60)])[0]!.members).toEqual([1, 2, 0])
    // Two that start together keep input order — not the taller-first tiebreak
    // the lanes use, which would list the long one ahead of the short one.
    expect(spansOf([span(0, 30), span(0, 120)])[0]!.members).toEqual([0, 1])
  })

  it('keeps back-to-back blocks in separate clusters', () => {
    // The second starts exactly where the first ends (top >= clusterEnd):
    // not overlapping, so two spans, each the block itself.
    expect(spansOf([span(0, 60), span(60, 30)])).toEqual([
      { cluster: 0, lanes: 1, top: 0, h: 60, members: [0] },
      { cluster: 1, lanes: 1, top: 60, h: 30, members: [1] }
    ])
  })

  it('has nothing to say about an empty column', () => {
    expect(spansOf([])).toEqual([])
  })

  it('refuses lanes that were not computed for these items', () => {
    expect(() => clusterSpans([span(0, 60)], [])).toThrow(RangeError)
  })
})
