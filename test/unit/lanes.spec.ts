// assignLanes — side-by-side layout for blocks sharing a calendar column.
import { describe, expect, it } from 'vitest'
import { assignLanes } from '../../app/utils/lanes'

const span = (top: number, h: number) => ({ top, h })

describe('assignLanes', () => {
  it('gives a lone block the whole width', () => {
    expect(assignLanes([span(0, 60)])).toEqual([{ lane: 0, lanes: 1 }])
  })

  it('leaves blocks that never touch at full width', () => {
    // Back to back is not overlapping: the second starts exactly where the first ends.
    expect(assignLanes([span(0, 60), span(60, 30), span(200, 10)])).toEqual([
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 },
      { lane: 0, lanes: 1 }
    ])
  })

  it('puts two overlapping blocks side by side', () => {
    expect(assignLanes([span(0, 60), span(30, 60)])).toEqual([
      { lane: 0, lanes: 2 },
      { lane: 1, lanes: 2 }
    ])
  })

  it('reuses a lane once its block has ended, and sizes the cluster by its busiest moment', () => {
    // A 0–60, B 30–90, C 60–120: C overlaps B but not A, so it can take A's lane —
    // the cluster is never more than two wide.
    expect(assignLanes([span(0, 60), span(30, 60), span(60, 60)])).toEqual([
      { lane: 0, lanes: 2 },
      { lane: 1, lanes: 2 },
      { lane: 0, lanes: 2 }
    ])
  })

  it('needs three lanes for three blocks that all overlap', () => {
    expect(assignLanes([span(0, 100), span(10, 100), span(20, 100)])).toEqual([
      { lane: 0, lanes: 3 },
      { lane: 1, lanes: 3 },
      { lane: 2, lanes: 3 }
    ])
  })

  it('keeps separate clusters independent', () => {
    // Two overlapping in the morning, one alone in the afternoon: the afternoon
    // block is not narrowed by a cluster it has nothing to do with.
    expect(assignLanes([span(0, 60), span(30, 60), span(500, 60)])).toEqual([
      { lane: 0, lanes: 2 },
      { lane: 1, lanes: 2 },
      { lane: 0, lanes: 1 }
    ])
  })

  it('answers in input order, whatever order the blocks start in', () => {
    expect(assignLanes([span(30, 60), span(0, 60)])).toEqual([
      { lane: 1, lanes: 2 },
      { lane: 0, lanes: 2 }
    ])
  })

  it('lets the longer of two blocks that start together keep the first lane', () => {
    expect(assignLanes([span(0, 30), span(0, 120)])).toEqual([
      { lane: 1, lanes: 2 },
      { lane: 0, lanes: 2 }
    ])
  })
})
