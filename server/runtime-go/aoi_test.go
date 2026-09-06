// Kwetu — AoI port parity tests.
//
// These are the Go-side reproduction of the 12 probe tests that pin the
// normative spec tools/spikes/s0.8/aoi.test.ts (ADR-009 Decision 3: the port
// must reproduce the algorithm step for step), plus the three benchmark-
// shape population-parity tests: the port must produce the SAME measured
// populations as the TS bench (max cell population / max interest-set size)
// for the ADR-009 headline rows. Those golden values were extracted from the
// committed TS spec + bench placement by running the TS implementation live
// (Node 24, seeded mulberry32 — fully deterministic) and match the ADR-009
// evidence table and tools/spikes/s0.8/report.json.
//
// The RNG port itself is pinned against Node reference values before the
// parity tests, so a broken RNG cannot silently "agree".
package main

import (
	"fmt"
	"math"
	"sort"
	"testing"
)

// mulberry32 is the exact TS generator (tools/spikes/s0.8 bench.mjs +
// aoi.test.ts): uint32 arithmetic, >>> unsigned shift, 32-bit multiply
// wraparound (Math.imul), division by 2^32. Both Math.imul steps are load-
// bearing: the generator's second and third lines run on the RESULT of the
// first multiply, not on the pre-multiply operand.
type mulberry32 struct{ a uint32 }

func newMulberry32(seed uint32) *mulberry32 { return &mulberry32{a: seed} }

func (r *mulberry32) next() float64 {
	r.a += 0x6d2b79f5
	t := imul32(r.a^(r.a>>15), 1|r.a) // Math.imul(a ^ (a >>> 15), 1 | a)
	t = (t + imul32(t^(t>>7), 61|t)) ^ t
	return float64(t^(t>>14)) / 4294967296.0
}

// imul32 is Math.imul: 32-bit wraparound multiply.
func imul32(a, b uint32) uint32 { return a * b }

// TestMulberry32MatchesNode pins the RNG port against values produced by the
// TS generator under Node 24.13.0 (printed to 17 significant digits).
func TestMulberry32MatchesNode(t *testing.T) {
	r := newMulberry32(1)
	want := []float64{
		0.627073940588161349,
		0.00273572118021547794,
		0.527447039959952235,
		0.981050967471674085,
	}
	for i, w := range want {
		got := r.next()
		if got != w {
			t.Fatalf("mulberry32(1)[%d] = %.17g, want %.17g (TS reference)", i, got, w)
		}
	}
	r2 := newMulberry32(20260906)
	if got, want := r2.next(), 0.329146706266328692; got != want {
		t.Fatalf("mulberry32(20260906)[0] = %.17g, want %.17g (TS reference)", got, want)
	}
}

// sortedIDs copies+sorts an interest buffer for order-independent comparison
// (the port returns sets; ADR-009 rule 6).
func sortedIDs(ids []int64) []int64 {
	out := make([]int64, len(ids))
	copy(out, ids)
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func idsEqual(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// --- rule: cell key + floor semantics (TS tests 1-2) -------------------------

func TestCellKeyInjectiveAcrossNegativeWindow(t *testing.T) {
	keys := make(map[uint64]struct{})
	for cx := int64(-3); cx <= 3; cx++ {
		for cz := int64(-3); cz <= 3; cz++ {
			keys[AoiCellKey(cx, cz)] = struct{}{}
		}
	}
	if len(keys) != 49 {
		t.Fatalf("cellKey is not injective on the -3..3 window: %d unique keys, want 49", len(keys))
	}
}

func TestCellCoordOfFloorSemantics(t *testing.T) {
	cases := []struct {
		x, z, cs float64
		cx, cz   int64
	}{
		{250, 0, 100, 2, 0},
		{-0.0001, -100, 100, -1, -1},
		{-250.5, 99.9, 100, -3, 0},
		{0, 0, 100, 0, 0},
	}
	for _, c := range cases {
		cx, cz := AoiCellCoordOf(c.x, c.z, c.cs)
		if cx != c.cx || cz != c.cz {
			t.Errorf("cellCoordOf(%v, %v, %v) = (%d, %d), want (%d, %d)", c.x, c.z, c.cs, cx, cz, c.cx, c.cz)
		}
	}
}

// --- rule: membership invariants (TS tests 3-6) ------------------------------

func TestMembershipPopulationsInvariant(t *testing.T) {
	grid, err := NewAoiGrid(AoiParams{CellSize: 100, AoiRadius: 250})
	if err != nil {
		t.Fatal(err)
	}
	rng := newMulberry32(1)
	for i := 0; i < 50; i++ {
		if err := grid.Add(int64(i+1), rng.next()*1000, rng.next()*1000); err != nil {
			t.Fatal(err)
		}
	}
	if grid.Count() != 50 {
		t.Fatalf("count = %d, want 50", grid.Count())
	}
	sum := 0
	for _, pop := range grid.Populations() {
		if pop <= 0 {
			t.Fatalf("empty cell stored (population %d)", pop)
		}
		sum += pop
	}
	if sum != 50 {
		t.Fatalf("summed populations = %d, want 50", sum)
	}
}

func TestRemoveDropsFromInterestSetsAndPrunes(t *testing.T) {
	grid, _ := NewAoiGrid(AoiParams{CellSize: 100, AoiRadius: 250})
	rng := newMulberry32(2)
	for i := 0; i < 40; i++ {
		if err := grid.Add(int64(i+1), rng.next()*800, rng.next()*800); err != nil {
			t.Fatal(err)
		}
	}
	cellsBefore := grid.CellCount()
	removed := []int64{3, 11, 27}
	for _, id := range removed {
		if err := grid.Drop(id); err != nil {
			t.Fatal(err)
		}
	}
	interests := grid.RebuildTick()
	sum := 0
	for _, pop := range grid.Populations() {
		if pop <= 0 {
			t.Fatal("empty cell stored after remove")
		}
		sum += pop
	}
	if sum != 37 {
		t.Fatalf("summed populations = %d, want 37", sum)
	}
	if grid.CellCount() > cellsBefore {
		t.Fatalf("cell count grew on remove: %d > %d", grid.CellCount(), cellsBefore)
	}
	if grid.Has(11) {
		t.Fatal("removed id still indexed")
	}
	removedSet := map[int64]struct{}{3: {}, 11: {}, 27: {}}
	for id, buf := range interests {
		for _, mid := range buf {
			if _, gone := removedSet[mid]; gone {
				t.Fatalf("removed id %d still in interest set of %d", mid, id)
			}
			if mid == id {
				t.Fatalf("self %d in own interest set", id)
			}
		}
	}
	if err := grid.Drop(11); err == nil {
		t.Fatal("removing an unknown id must error")
	}
}

func TestMoveReindexesAcrossCellChanges(t *testing.T) {
	grid, _ := NewAoiGrid(AoiParams{CellSize: 100, AoiRadius: 200})
	mustAdd(t, grid, 1, 500, 500) // observer
	mustAdd(t, grid, 2, 520, 520) // neighbour, same cell as observer
	mustAdd(t, grid, 3, 900, 900) // far away, other cell
	grid.RebuildTick()
	if got := sortedIDs(grid.interests[1]); !idsEqual(got, []int64{2}) {
		t.Fatalf("interest(1) = %v, want [2]", got)
	}
	if got := sortedIDs(grid.interests[3]); len(got) != 0 {
		t.Fatalf("interest(3) = %v, want []", got)
	}

	mustMove(t, grid, 3, 515, 518) // into the observer's neighbourhood
	grid.RebuildTick()
	if got := sortedIDs(grid.interests[1]); !idsEqual(got, []int64{2, 3}) {
		t.Fatalf("interest(1) = %v, want [2 3]", got)
	}
	if got := sortedIDs(grid.interests[3]); !idsEqual(got, []int64{1, 2}) {
		t.Fatalf("interest(3) = %v, want [1 2]", got)
	}

	cellsBefore := grid.CellCount()
	mustMove(t, grid, 2, 521, 522) // same cell: position-only update
	grid.RebuildTick()
	if got := sortedIDs(grid.interests[1]); !idsEqual(got, []int64{2, 3}) {
		t.Fatalf("interest(1) after same-cell move = %v, want [2 3]", got)
	}
	if grid.CellCount() != cellsBefore {
		t.Fatalf("cell count changed on same-cell move: %d -> %d", cellsBefore, grid.CellCount())
	}

	mustMove(t, grid, 2, 100, 100) // far away
	grid.RebuildTick()
	if got := sortedIDs(grid.interests[1]); !idsEqual(got, []int64{3}) {
		t.Fatalf("interest(1) = %v, want [3]", got)
	}
	sum := 0
	for _, pop := range grid.Populations() {
		sum += pop
	}
	if sum != 3 {
		t.Fatalf("summed populations = %d, want 3", sum)
	}
}

func TestGridErrorsOnMisuse(t *testing.T) {
	grid, _ := NewAoiGrid(AoiParams{CellSize: 100, AoiRadius: 250})
	if err := grid.Add(1, 10, 10); err != nil {
		t.Fatal(err)
	}
	if err := grid.Add(1, 20, 20); err == nil {
		t.Fatal("duplicate add must error")
	}
	if err := grid.Move(9, 20, 20); err == nil {
		t.Fatal("unknown move must error")
	}
	if err := grid.Drop(9); err == nil {
		t.Fatal("unknown remove must error")
	}
	if _, err := grid.InterestOf(9); err == nil {
		t.Fatal("interestOf on unknown id must error")
	}
	if _, err := grid.AoiCellCount(9); err == nil {
		t.Fatal("aoiCellCount on unknown id must error")
	}
	if _, err := NewAoiGrid(AoiParams{CellSize: 0, AoiRadius: 250}); err == nil {
		t.Fatal("cellSize must be > 0")
	}
	if _, err := NewAoiGrid(AoiParams{CellSize: 100, AoiRadius: 0}); err == nil {
		t.Fatal("aoiRadius must be > 0")
	}
}

// --- rule: interest = cells whose rectangle intersects the disc --------------

// expectedInterest is an INDEPENDENT brute-force computation that does not
// use the grid's range logic (mirrors the TS test's helper).
func expectedInterest(ox, oz float64, xs, zs []float64, selfID int64, cellSize, radius float64) []int64 {
	var out []int64
	rSq := radius * radius
	for i := range xs {
		id := int64(i + 1)
		if id == selfID {
			continue
		}
		cx := math.Floor(xs[i] / cellSize)
		cz := math.Floor(zs[i] / cellSize)
		nx := math.Min(math.Max(ox, cx*cellSize), (cx+1)*cellSize)
		nz := math.Min(math.Max(oz, cz*cellSize), (cz+1)*cellSize)
		dx := ox - nx
		dz := oz - nz
		if dx*dx+dz*dz <= rSq {
			out = append(out, id)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func TestInterestMatchesIndependentBruteForce(t *testing.T) {
	cellSize, radius := 100.0, 250.0
	grid, _ := NewAoiGrid(AoiParams{CellSize: cellSize, AoiRadius: radius})
	rng := newMulberry32(42)
	xs := make([]float64, 400)
	zs := make([]float64, 400)
	for i := 0; i < 400; i++ {
		xs[i] = rng.next() * 2000
		zs[i] = rng.next() * 2000
		if err := grid.Add(int64(i+1), xs[i], zs[i]); err != nil {
			t.Fatal(err)
		}
	}
	grid.RebuildTick()
	for o := 0; o < 25; o++ {
		selfID := int64(o*16 + 1)
		want := expectedInterest(xs[selfID-1], zs[selfID-1], xs, zs, selfID, cellSize, radius)
		got := sortedIDs(grid.interests[selfID])
		if !idsEqual(got, want) {
			t.Fatalf("interest(%d) = %v, want %v", selfID, got, want)
		}
	}
}

func TestInterestIsCellRectSuperset(t *testing.T) {
	cellSize, radius := 250.0, 500.0
	maxOverinclusion := radius + cellSize*math.Sqrt2
	grid, _ := NewAoiGrid(AoiParams{CellSize: cellSize, AoiRadius: radius})
	rng := newMulberry32(7)
	xs := make([]float64, 300)
	zs := make([]float64, 300)
	for i := 0; i < 300; i++ {
		xs[i] = rng.next() * 3000
		zs[i] = rng.next() * 3000
		if err := grid.Add(int64(i+1), xs[i], zs[i]); err != nil {
			t.Fatal(err)
		}
	}
	grid.RebuildTick()
	ox, oz := xs[0], zs[0]
	inSet := make(map[int64]struct{})
	for _, id := range grid.interests[1] {
		inSet[id] = struct{}{}
	}
	rSq := radius * radius
	maxSq := maxOverinclusion * maxOverinclusion
	nearChecked, farChecked := 0, 0
	for i := 1; i < len(xs); i++ {
		id := int64(i + 1)
		dx := ox - xs[i]
		dz := oz - zs[i]
		d2 := dx*dx + dz*dz
		if d2 <= rSq {
			nearChecked++
			if _, ok := inSet[id]; !ok {
				t.Fatalf("presence %d within radius missing from interest set", id)
			}
		}
		if d2 > maxSq {
			farChecked++
			if _, ok := inSet[id]; ok {
				t.Fatalf("presence %d beyond radius+diagonal wrongly in interest set", id)
			}
		}
	}
	if nearChecked == 0 || farChecked == 0 {
		t.Fatalf("degenerate scenario: near=%d far=%d", nearChecked, farChecked)
	}
}

func TestExactTangencyPaddedRange(t *testing.T) {
	grid, _ := NewAoiGrid(AoiParams{CellSize: 1000, AoiRadius: 500})
	mustAdd(t, grid, 1, 2500, 2500)  // observer at a 4-cell corner point, cell (2,2)
	mustAdd(t, grid, 2, 3050, 2500)  // cell (3,2): rect tangent east at exactly 500 m
	mustAdd(t, grid, 3, 3050, 2550)  // same cell (3,2) -> included by over-inclusion
	mustAdd(t, grid, 4, 1950, 2500)  // cell (1,2): rect tangent west
	mustAdd(t, grid, 5, 1950, 2450)  // same cell (1,2) -> included by over-inclusion
	mustAdd(t, grid, 6, 2500, 3050)  // cell (2,3): rect tangent north
	mustAdd(t, grid, 7, 2500, 1950)  // cell (2,1): rect tangent south
	mustAdd(t, grid, 8, 2501, 2501)  // own cell (2,2)
	mustAdd(t, grid, 9, 1950, 1950)  // cell (1,1): nearest point (2000,2000) = 707 m -> out
	mustAdd(t, grid, 10, 3050, 3050) // cell (3,3): diagonal, 707 m -> out
	mustAdd(t, grid, 11, 4500, 4500) // cell (4,4): far -> out
	grid.RebuildTick()
	if got := sortedIDs(grid.interests[1]); !idsEqual(got, []int64{2, 3, 4, 5, 6, 7, 8}) {
		t.Fatalf("interest(1) = %v, want [2 3 4 5 6 7 8]", got)
	}
	if n, err := grid.AoiCellCount(1); err != nil || n != 5 {
		t.Fatalf("aoiCellCount(1) = %d (%v), want 5 — the plus-shape of own cell + 4 tangent cells", n, err)
	}
	if n, err := grid.AoiCellCount(9); err != nil || n != 4 {
		t.Fatalf("aoiCellCount(9) = %d (%v), want 4", n, err)
	}
}

func TestFinerGridsNeverAddInterest(t *testing.T) {
	rng := newMulberry32(99)
	xs := make([]float64, 250)
	zs := make([]float64, 250)
	for i := 0; i < 250; i++ {
		xs[i] = rng.next() * 2500
		zs[i] = rng.next() * 2500
	}
	var sets []map[int64]struct{}
	for _, cs := range []float64{100, 500, 1000} {
		grid, _ := NewAoiGrid(AoiParams{CellSize: cs, AoiRadius: 500})
		for i := range xs {
			if err := grid.Add(int64(i+1), xs[i], zs[i]); err != nil {
				t.Fatal(err)
			}
		}
		grid.RebuildTick()
		set := make(map[int64]struct{})
		for _, id := range grid.interests[1] {
			set[id] = struct{}{}
		}
		sets = append(sets, set)
	}
	fine, mid, coarse := sets[0], sets[1], sets[2]
	for id := range fine {
		if _, ok := mid[id]; !ok {
			t.Fatalf("interest(100) has %d but interest(500) does not", id)
		}
	}
	for id := range mid {
		if _, ok := coarse[id]; !ok {
			t.Fatalf("interest(500) has %d but interest(1000) does not", id)
		}
	}
}

func TestRebuildDeterministicAsSetAndBuffersReused(t *testing.T) {
	grid, _ := NewAoiGrid(AoiParams{CellSize: 250, AoiRadius: 500})
	rng := newMulberry32(1234)
	for i := 0; i < 120; i++ {
		if err := grid.Add(int64(i+1), rng.next()*2000, rng.next()*2000); err != nil {
			t.Fatal(err)
		}
	}
	grid.RebuildTick()
	first := sortedIDs(grid.interests[5])
	if len(first) == 0 {
		t.Fatal("degenerate scenario: interest(5) empty")
	}
	p1 := &grid.interests[5][0]
	grid.RebuildTick()
	second := sortedIDs(grid.interests[5])
	if !idsEqual(second, first) {
		t.Fatalf("rebuild changed the interest set as a set: %v -> %v", first, second)
	}
	p2 := &grid.interests[5][0]
	if p1 != p2 {
		// The Go port of the TS buffer-reuse rule: the buffer is reused
		// (buf = buf[:0]), so an unchanged rebuild keeps the backing array.
		t.Fatal("interest buffer was reallocated across an unchanged rebuild")
	}
}

// --- benchmark-shape smoke (TS test 12) --------------------------------------

func TestBenchmarkShapeSmoke(t *testing.T) {
	grid, _ := NewAoiGrid(AoiParams{CellSize: 250, AoiRadius: 500})
	rng := newMulberry32(20260906)
	count := 5000
	area := 5000.0
	hotspotSide := math.Sqrt(0.1) * area
	for i := 0; i < count; i++ {
		var x, z float64
		if rng.next() < 0.8 {
			x = area/2 + (rng.next()-0.5)*hotspotSide
			z = area/2 + (rng.next()-0.5)*hotspotSide
		} else {
			x = rng.next() * area
			z = rng.next() * area
		}
		if err := grid.Add(int64(i+1), x, z); err != nil {
			t.Fatal(err)
		}
	}
	if grid.Count() != count {
		t.Fatalf("count = %d, want %d", grid.Count(), count)
	}
	interests := grid.RebuildTick()
	if len(interests) != count {
		t.Fatalf("interest map size = %d, want %d", len(interests), count)
	}
	sum := 0
	for _, pop := range grid.Populations() {
		sum += pop
	}
	if sum != count {
		t.Fatalf("summed populations = %d, want %d", sum, count)
	}
	_, maxPop := grid.MaxCellPopulation()
	if maxPop <= 60 || maxPop >= 160 {
		t.Fatalf("max cell population = %d, want in (60, 160) — dense hotspot cells at 250 m hold on the order of a hundred presences", maxPop)
	}
	// Sampled set hygiene: no duplicates, no self in any sampled interest set.
	checked, violations := 0, 0
	for id, buf := range interests {
		if checked >= 200 {
			break
		}
		checked++
		seen := make(map[int64]struct{}, len(buf))
		for _, mid := range buf {
			if mid == id {
				violations++
				break
			}
			if _, dup := seen[mid]; dup {
				violations++
				break
			}
			seen[mid] = struct{}{}
		}
	}
	if violations != 0 {
		t.Fatalf("%d sampled interest sets had duplicates or self-membership", violations)
	}
}

// --- golden population parity vs the TS bench (the port-parity proof) -------
//
// The three ADR-009 headline configs, reproduced against the committed TS
// spec + bench placement. Expected values extracted from a live run of
// tools/spikes/s0.8/aoi.ts (Node 24.13.0, 2026-09-06, fully seeded) and
// equal to the ADR-009 evidence table / report.json rows:
//
//	N5000 cs250 uniform   -> max cell pop 23,   max interest set 334
//	N5000 cs250 clustered -> max cell pop 129,  max interest set 2411
//	N5000 cs1000 clustered-> max cell pop 1686, max interest set 2921
//
// The bench tracks both extremes over all 330 ticks (30 warmup + 300
// measured — its stats pass runs unconditionally), with one random-direction
// 0.07 m step per presence per tick and reflection at the 5x5 km boundary.
// The area/radius/step constants and the per-config seed derivation below
// are copied verbatim from bench.mjs.

func TestAoiParityWithTsBenchPopulations(t *testing.T) {
	type golden struct {
		count      int
		cellSize   float64
		clustered  bool
		distIndex  uint32
		maxCellPop int
		maxInterst int
	}
	cases := []golden{
		{5000, 250, false, 0, 23, 334},
		{5000, 250, true, 1, 129, 2411},
		{5000, 1000, true, 1, 1686, 2921},
	}
	for _, c := range cases {
		name := fmt.Sprintf("N%d-cs%.0f-%s", c.count, c.cellSize, map[bool]string{false: "uniform", true: "clustered"}[c.clustered])
		t.Run(name, func(t *testing.T) {
			gotMaxPop, gotMaxInterest := runBenchConfig(c.count, c.cellSize, c.clustered, c.distIndex)
			if gotMaxPop != c.maxCellPop || gotMaxInterest != c.maxInterst {
				t.Fatalf("population parity broken for %s: got (maxCellPop %d, maxInterest %d), want (%d, %d)",
					name, gotMaxPop, gotMaxInterest, c.maxCellPop, c.maxInterst)
			}
		})
	}
}

// runBenchConfig is bench.mjs's runConfig population pass (movement + full
// rebuild per tick; stats over all 330 ticks).
func runBenchConfig(count int, cellSize float64, clustered bool, distIndex uint32) (maxCellPop, maxInterest int) {
	const (
		seed         = uint32(20260906)
		area         = 5000.0
		aoiRadius    = 500.0
		warmupXMeas  = 30 + 300
		hotspotFrac  = 0.1
		hotspotShare = 0.8
	)
	seedCfg := seed ^ imul32(cellSizeUintBits(cellSize), 0x9e3779b1) ^ imul32(uint32(count), 0x85ebca77) ^ imul32(distIndex+1, 0xc2b2ae3d)
	rng := newMulberry32(seedCfg)
	grid, _ := NewAoiGrid(AoiParams{CellSize: cellSize, AoiRadius: aoiRadius})
	xs := make([]float64, count)
	zs := make([]float64, count)
	centre := area / 2
	hotspotSide := math.Sqrt(hotspotFrac) * area
	for i := 0; i < count; i++ {
		if clustered && rng.next() < hotspotShare {
			xs[i] = centre + (rng.next()-0.5)*hotspotSide
			zs[i] = centre + (rng.next()-0.5)*hotspotSide
		} else {
			xs[i] = rng.next() * area
			zs[i] = rng.next() * area
		}
		_ = grid.Add(int64(i+1), xs[i], zs[i])
	}
	step := 1.4 / 20.0
	for tick := 0; tick < warmupXMeas; tick++ {
		for i := 0; i < count; i++ {
			ang := rng.next() * 2 * math.Pi
			x := xs[i] + math.Cos(ang)*step
			z := zs[i] + math.Sin(ang)*step
			if x < 0 {
				x = -x
			} else if x > area {
				x = 2*area - x
			}
			if z < 0 {
				z = -z
			} else if z > area {
				z = 2*area - z
			}
			xs[i] = x
			zs[i] = z
			_ = grid.Move(int64(i+1), x, z)
		}
		interests := grid.RebuildTick()
		_, pop := grid.MaxCellPopulation()
		if pop > maxCellPop {
			maxCellPop = pop
		}
		for _, buf := range interests {
			if len(buf) > maxInterest {
				maxInterest = len(buf)
			}
		}
	}
	return maxCellPop, maxInterest
}

// cellSizeUintBits converts a float cell size to the uint32 the bench seed
// derivation feeds into Math.imul (250 and 1000 are exact integers).
func cellSizeUintBits(f float64) uint32 {
	return uint32(int64(f))
}

func mustAdd(t *testing.T, g *AoiGrid, id int64, x, z float64) {
	t.Helper()
	if err := g.Add(id, x, z); err != nil {
		t.Fatalf("add(%d): %v", id, err)
	}
}

func mustMove(t *testing.T, g *AoiGrid, id int64, x, z float64) {
	t.Helper()
	if err := g.Move(id, x, z); err != nil {
		t.Fatalf("move(%d): %v", id, err)
	}
}
