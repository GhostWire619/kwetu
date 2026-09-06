// Kwetu — AoI cell grid (Go port of the normative spike spec).
//
// This is the Phase-5 Go runtime port of shared/aoi.ts, which
// ADR-009 Decision 3 declares the NORMATIVE ALGORITHM SPEC: the port must
// reproduce it step for step. The mapping from the TS spec is:
//
//	TS Map iteration (insertion order)  -> Go map range (randomized): outputs
//	                                       are identical AS SETS (ADR-009
//	                                       Decision 3 caveat); consumers that
//	                                       need order sort explicitly.
//	TS thrown Error                     -> Go returned error (same conditions).
//	TS interest buffers (buf.length=0)  -> Go slices (buf = buf[:0] reuse).
//	TS cell member arrays (push/pop)    -> Go slices with the same swap-remove.
//	Math.floor / arithmetic             -> math.Floor / identical f64 ops in
//	                                       the same order (IEEE-754 double).
//	TS cellKey number (exact in f64)    -> Go uint64 (identical values).
//
// ALGORITHM (verbatim rules from the spec header)
// ----------------------------------------------
//  1. Static square cell grid over the region. Cell of a position is
//     (cx, cz) = (floor(x / cellSize), floor(z / cellSize)) — floor, so the
//     grid extends over negative coordinates; cell k spans [k·c, (k+1)·c) and
//     a position exactly on a boundary belongs to the positive-side cell.
//  2. Presence membership: every presence id lives in exactly one cell's
//     member array. add / remove / move maintain the invariant; emptied cells
//     are pruned from the map.
//  3. Per tick — REBUILD semantics: every presence is an observer; its area of
//     interest is the member ids of all cells whose closed rectangle
//     intersects the disc of radius aoiRadius around it (nearest-point clamp
//     test, f64), EXCLUDING itself.
//  4. Candidate cell range before the rectangle test is padded one ring beyond
//     the raw floor bounds; the rectangle test is the sole membership
//     authority (it keeps exact tangency and f64 rounding correct).
//  5. Interest buffers are REUSED across ticks (cleared, never reallocated by
//     intent) so a rebuild tick allocates nothing when capacities allow.
//  6. Interest sets are SETS: element order is unspecified.
//
// CELL KEY PACKING (identical values in TS as f64 and Go as uint64):
// key = (cx + 2^20)·2^21 + (cz + 2^20): injective for |cx|,|cz| < 2^20 and
// exact in f64 (max < 2^42 << 2^53).
//
// Numbers are f64 throughout (ADR-002 canonical state). Any wire quantization
// is a Phase-5 protocol concern (snapshot.go owns the groundwork ledger here).
package main

import (
	"fmt"
	"math"
)

const (
	aoiKeyOffset = 1 << 20 // 1048576
	aoiKeyRow    = 1 << 21 // 2097152
)

// AoiParams parameterises one grid.
type AoiParams struct {
	// CellSize is the cell edge length in metres (must be > 0). Adopted
	// value: 250 m, ADR-009 Decision 1 [MEASURED 2026-09-06].
	CellSize float64
	// AoiRadius is the area-of-interest radius in metres (must be > 0).
	// Adopted value: 500 m, the benchmark's fixed input
	// [PLACEHOLDER — gate: Phase 3/5 for the production radius, ADR-009].
	AoiRadius float64
}

// AoiGrid is the rebuild-per-tick interest grid. It lives in match state and
// is touched only by the owning match's MatchLoop (NETWORKING.md §5) — no
// synchronization is provided or specified.
type AoiGrid struct {
	cellSize  float64
	aoiRadius float64
	radiusSq  float64

	// cells: packed cell key -> member ids (long-lived; swap-remove; emptied
	// cells pruned).
	cells map[uint64][]int64
	// cellOfID: presence id -> its current cell key.
	cellOfID map[int64]uint64
	// pos: presence id -> [x, z] in f64 canonical metres. Doubles as the
	// presence set.
	pos map[int64][2]float64
	// interests: presence id -> reused interest buffer (cleared per tick).
	interests map[int64][]int64
}

// NewAoiGrid builds a grid. Both dimensions must be > 0 (the TS spec throws;
// this port returns an error under the same conditions).
func NewAoiGrid(params AoiParams) (*AoiGrid, error) {
	if !(params.CellSize > 0) {
		return nil, fmt.Errorf("aoi: cellSize must be > 0, got %v", params.CellSize)
	}
	if !(params.AoiRadius > 0) {
		return nil, fmt.Errorf("aoi: aoiRadius must be > 0, got %v", params.AoiRadius)
	}
	return &AoiGrid{
		cellSize:  params.CellSize,
		aoiRadius: params.AoiRadius,
		radiusSq:  params.AoiRadius * params.AoiRadius,
		cells:     make(map[uint64][]int64),
		cellOfID:  make(map[int64]uint64),
		pos:       make(map[int64][2]float64),
		interests: make(map[int64][]int64),
	}, nil
}

// AoiCellKey is the packed, f64-exact, injective cell key for |cx|,|cz| < 2^20.
func AoiCellKey(cx, cz int64) uint64 {
	return uint64((cx+aoiKeyOffset)*aoiKeyRow + (cz + aoiKeyOffset))
}

// AoiCellCoordOf returns the floor cell coordinates of a position (boundary
// belongs to the positive-side cell).
func AoiCellCoordOf(x, z, cellSize float64) (cx, cz int64) {
	return int64(math.Floor(x / cellSize)), int64(math.Floor(z / cellSize))
}

// Add indexes a new presence. Duplicate ids are a caller bug and error.
func (g *AoiGrid) Add(id int64, x, z float64) error {
	if _, dup := g.cellOfID[id]; dup {
		return fmt.Errorf("aoi: presence %d is already indexed", id)
	}
	key := AoiCellKey(int64(math.Floor(x/g.cellSize)), int64(math.Floor(z/g.cellSize)))
	g.cellOfID[id] = key
	g.pos[id] = [2]float64{x, z}
	g.interests[id] = nil
	g.cells[key] = append(g.cells[key], id)
	return nil
}

// Has reports whether the id is indexed.
func (g *AoiGrid) Has(id int64) bool {
	_, ok := g.cellOfID[id]
	return ok
}

// Drop removes a presence (TS remove()). Unknown ids are a caller bug and
// error. O(population of the cell) via indexOf + swap-with-last — the
// spec'd tradeoff.
func (g *AoiGrid) Drop(id int64) error {
	key, ok := g.cellOfID[id]
	if !ok {
		return fmt.Errorf("aoi: presence %d is not indexed", id)
	}
	delete(g.cellOfID, id)
	delete(g.pos, id)
	delete(g.interests, id)
	members := g.cells[key]
	if members != nil {
		i := -1
		for k, mid := range members {
			if mid == id {
				i = k
				break
			}
		}
		if i >= 0 {
			last := len(members) - 1
			members[i] = members[last]
			members = members[:last]
		}
		if len(members) == 0 {
			delete(g.cells, key)
		} else {
			g.cells[key] = members
		}
	}
	return nil
}

// Move updates a presence's position; reindexes membership only when the
// floor cell changes. Unknown ids are a caller bug and error.
func (g *AoiGrid) Move(id int64, x, z float64) error {
	p, ok := g.pos[id]
	if !ok {
		return fmt.Errorf("aoi: presence %d is not indexed", id)
	}
	oldKey, ok := g.cellOfID[id]
	if !ok {
		return fmt.Errorf("aoi: presence %d is not indexed", id)
	}
	p[0] = x
	p[1] = z
	g.pos[id] = p
	newKey := AoiCellKey(int64(math.Floor(x/g.cellSize)), int64(math.Floor(z/g.cellSize)))
	if newKey == oldKey {
		return nil
	}
	oldMembers := g.cells[oldKey]
	if oldMembers != nil {
		i := -1
		for k, mid := range oldMembers {
			if mid == id {
				i = k
				break
			}
		}
		if i >= 0 {
			last := len(oldMembers) - 1
			oldMembers[i] = oldMembers[last]
			oldMembers = oldMembers[:last]
		}
		if len(oldMembers) == 0 {
			delete(g.cells, oldKey)
		} else {
			g.cells[oldKey] = oldMembers
		}
	}
	g.cells[newKey] = append(g.cells[newKey], id)
	g.cellOfID[id] = newKey
	return nil
}

// RebuildTick runs one full rebuild: every presence's interest buffer is
// cleared and refilled with the member ids of the cells intersecting its AoI
// disc, excluding itself (rules 3/4 above). The returned map is READ-ONLY by
// contract: the buffers are reused next tick. Consumers needing a stable
// order must sort (rule 6).
func (g *AoiGrid) RebuildTick() map[int64][]int64 {
	cs := g.cellSize
	rSq := g.radiusSq
	radius := g.aoiRadius
	for id, p := range g.pos {
		buf := g.interests[id][:0]
		x := p[0]
		z := p[1]
		minCx := int64(math.Floor((x-radius)/cs)) - 1
		maxCx := int64(math.Floor((x+radius)/cs)) + 1
		minCz := int64(math.Floor((z-radius)/cs)) - 1
		maxCz := int64(math.Floor((z+radius)/cs)) + 1
		for cz := minCz; cz <= maxCz; cz++ {
			zLo := float64(cz) * cs
			zHi := zLo + cs
			dz := 0.0
			if z < zLo {
				dz = zLo - z
			} else if z > zHi {
				dz = z - zHi
			}
			if dz*dz > rSq {
				continue
			}
			for cx := minCx; cx <= maxCx; cx++ {
				xLo := float64(cx) * cs
				xHi := xLo + cs
				dx := 0.0
				if x < xLo {
					dx = xLo - x
				} else if x > xHi {
					dx = x - xHi
				}
				if dx*dx+dz*dz > rSq {
					continue
				}
				for _, mid := range g.cells[AoiCellKey(cx, cz)] {
					if mid != id {
						buf = append(buf, mid)
					}
				}
			}
		}
		g.interests[id] = buf
	}
	return g.interests
}

// AoiCellCount returns the number of cells whose rectangle intersects the AoI
// disc of one presence (the size of the cell set the rebuild walks for that
// observer). Unknown ids error.
func (g *AoiGrid) AoiCellCount(id int64) (int, error) {
	p, ok := g.pos[id]
	if !ok {
		return 0, fmt.Errorf("aoi: presence %d is not indexed", id)
	}
	cs := g.cellSize
	rSq := g.radiusSq
	radius := g.aoiRadius
	x := p[0]
	z := p[1]
	minCx := int64(math.Floor((x-radius)/cs)) - 1
	maxCx := int64(math.Floor((x+radius)/cs)) + 1
	minCz := int64(math.Floor((z-radius)/cs)) - 1
	maxCz := int64(math.Floor((z+radius)/cs)) + 1
	n := 0
	for cz := minCz; cz <= maxCz; cz++ {
		zLo := float64(cz) * cs
		zHi := zLo + cs
		dz := 0.0
		if z < zLo {
			dz = zLo - z
		} else if z > zHi {
			dz = z - zHi
		}
		if dz*dz > rSq {
			continue
		}
		for cx := minCx; cx <= maxCx; cx++ {
			xLo := float64(cx) * cs
			xHi := xLo + cs
			dx := 0.0
			if x < xLo {
				dx = xLo - x
			} else if x > xHi {
				dx = x - xHi
			}
			if dx*dx+dz*dz <= rSq {
				n++
			}
		}
	}
	return n, nil
}

// InterestOf returns the observer's current interest buffer (reused next
// tick — do not mutate, do not retain beyond the tick). Unknown ids error.
func (g *AoiGrid) InterestOf(id int64) ([]int64, error) {
	buf, ok := g.interests[id]
	if !ok {
		return nil, fmt.Errorf("aoi: presence %d is not indexed", id)
	}
	return buf, nil
}

// Count returns the presence count.
func (g *AoiGrid) Count() int {
	return len(g.pos)
}

// CellCount returns the occupied cell count.
func (g *AoiGrid) CellCount() int {
	return len(g.cells)
}

// Populations returns a snapshot copy of cell key -> population. Stats use
// only — never in a tick.
func (g *AoiGrid) Populations() map[uint64]int {
	out := make(map[uint64]int, len(g.cells))
	for key, members := range g.cells {
		out[key] = len(members)
	}
	return out
}

// MaxCellPopulation returns the largest cell population (and one of its
// keys). Stats use only — never in a tick.
func (g *AoiGrid) MaxCellPopulation() (key uint64, population int) {
	best := 0
	bestKey := uint64(0)
	for k, members := range g.cells {
		if len(members) > best {
			best = len(members)
			bestKey = k
		}
	}
	return bestKey, best
}
