// Lane layout for blocks that share a column — the calendar's day column, where
// several entries (or running timers, ticktimer/Tick#37) can occupy the same
// hour. Overlapping blocks are placed side by side instead of on top of each
// other, the way every calendar does it.
//
// Pure geometry: each item is a vertical span in px. Items that overlap,
// directly or through a chain (A overlaps B, B overlaps C), form a cluster; a
// cluster is as wide as its busiest moment (`lanes`), and every item in it
// takes one `lane`. Two clusters that never touch each other both get the full
// width. Input order is preserved in the result.

export interface Span {
  top: number
  h: number
}

export interface Lane {
  /** 0-based column within the cluster. */
  lane: number
  /** How many columns the cluster needs; 1 means the block has the width to itself. */
  lanes: number
}

export function assignLanes(items: readonly Span[]): Lane[] {
  const order = items
    .map((s, i) => ({ i, top: s.top, bottom: s.top + s.h }))
    // Earlier first; among equals the taller first, so the long one keeps lane 0.
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom)

  const out: Lane[] = items.map(() => ({ lane: 0, lanes: 1 }))
  let cluster: number[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity

  const close = () => {
    for (const i of cluster) out[i]!.lanes = laneEnds.length
    cluster = []
    laneEnds = []
  }

  for (const s of order) {
    if (s.top >= clusterEnd) close() // nothing still running here: a new cluster
    // First lane that has ended by the time this one starts; else a new one.
    let lane = laneEnds.findIndex(end => end <= s.top)
    if (lane < 0) lane = laneEnds.push(s.bottom) - 1
    else laneEnds[lane] = s.bottom
    out[s.i]!.lane = lane
    cluster.push(s.i)
    clusterEnd = Math.max(clusterEnd, s.bottom)
  }
  close()
  return out
}
