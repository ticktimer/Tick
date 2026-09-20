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
//
// Clusters are also numbered (`cluster`, 0-based in start order) so a caller
// can treat one as a unit: clusterSpans() folds each into its envelope. That is
// how the calendar draws a whole overlapping group as one block once its lanes
// would be too narrow to carry a name — the fold (ticktimer/Tick#37).

export interface Span {
  top: number
  h: number
}

export interface Lane {
  /** 0-based column within the cluster. */
  lane: number
  /** How many columns the cluster needs; 1 means the block has the width to itself. */
  lanes: number
  /** Which cluster the block belongs to — 0-based, numbered in start order. */
  cluster: number
}

/** One cluster as a unit: its envelope, and which input items it holds. */
export interface ClusterSpan {
  cluster: number
  lanes: number
  /** Top of the member that starts first. */
  top: number
  /** Down to the bottom of the member that ends last. */
  h: number
  /** Indices into the input, sorted by top, then input order. */
  members: number[]
}

export function assignLanes(items: readonly Span[]): Lane[] {
  const order = items
    .map((s, i) => ({ i, top: s.top, bottom: s.top + s.h }))
    // Earlier first; among equals the taller first, so the long one keeps lane 0.
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom)

  const out: Lane[] = items.map(() => ({ lane: 0, lanes: 1, cluster: 0 }))
  let cluster: number[] = []
  let laneEnds: number[] = []
  let clusterEnd = -Infinity
  let clusters = 0

  const close = () => {
    if (!cluster.length) return // before the first item (or with none at all): nothing to number
    for (const i of cluster) {
      out[i]!.lanes = laneEnds.length
      out[i]!.cluster = clusters
    }
    clusters++
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

/**
 * Every cluster folded to one span — the union envelope of its members, and
 * the members themselves as indices into `items`. `lanes` is what
 * assignLanes(items) returned for the same items. Spans come back in cluster
 * order (= start order), members by top then input order: the same answer for
 * any input order.
 */
export function clusterSpans(items: readonly Span[], lanes: readonly Lane[]): ClusterSpan[] {
  if (lanes.length !== items.length) {
    throw new RangeError(`clusterSpans: ${lanes.length} lanes for ${items.length} items`)
  }
  const byCluster = new Map<number, ClusterSpan>()
  items.forEach((s, i) => {
    const { cluster, lanes: width } = lanes[i]!
    const span = byCluster.get(cluster)
    if (!span) {
      byCluster.set(cluster, { cluster, lanes: width, top: s.top, h: s.h, members: [i] })
      return
    }
    const bottom = Math.max(span.top + span.h, s.top + s.h)
    span.top = Math.min(span.top, s.top)
    span.h = bottom - span.top
    span.members.push(i)
  })
  const out = [...byCluster.values()].sort((a, b) => a.cluster - b.cluster)
  for (const span of out) span.members.sort((a, b) => items[a]!.top - items[b]!.top || a - b)
  return out
}
