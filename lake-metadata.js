// ─────────────────────────────────────────────────────────────────────────────
// lake-metadata.js — static, per-lake knowledge that does NOT come from forecast
//
// Forecast APIs give us air temp, wind, pressure, rain. They don't know that
// Almaden goes anoxic in late June or that a small urban pond fishes differently
// from a large reservoir. That kind of knowledge lives here, hand-edited.
//
// Pattern: forecast-data + LAKE_META → insights.scoreLocation() → verdict.
//          (Domain knowledge separated from rules and from rendering.)
//
// Fields:
//   type           — small_pond | reservoir | large_reservoir.
//                    Affects how aggressively the anoxic window penalizes summer
//                    midday fishing (small ponds stratify worse than big lakes).
//   anoxicStart    — approximate date the lake stratifies and the bottom layer
//                    starts going low-O2. Triggers ambush-mode bias and kills
//                    midday window quality once we pass it. ISO format YYYY-MM-DD.
//   anoxicEnd      — fall turnover; the lake reoxygenates and bite reopens.
//   notes          — free-text local exceptions worth surfacing as a reason chip.
//   bankBearings   — productive bank compass bearings (degrees, 0=N, 90=E).
//                    Empty array = use geometric default ("fish the bank the wind
//                    is blowing toward"). Fill in per lake when you've learned
//                    which banks actually hold fish — refines the wind reason.
//
// All dates are inclusive. Year is the *current* year; the scoring helper in
// insights.js normalizes to "this year" so we don't have to update annually.
// ─────────────────────────────────────────────────────────────────────────────

window.LAKE_META = {
    1: {  // Belmont — small urban pond
        type: 'small_pond',
        anoxicStart: '2026-06-15',
        anoxicEnd:   '2026-10-01',
        notes: 'Urban pond; small fish, shoreline limited',
        bankBearings: []
    },
    2: {  // Almaden Reservoir
        type: 'reservoir',
        anoxicStart: '2026-06-20',
        anoxicEnd:   '2026-09-30',
        notes: 'Famous late-June lockdown — flips to ambush ~mid-June',
        bankBearings: []
    },
    3: {  // Lake Del Valle — large reservoir
        type: 'large_reservoir',
        anoxicStart: '2026-07-10',
        anoxicEnd:   '2026-10-15',
        notes: 'Deeper, stratifies later — summer fishability better than small lakes',
        bankBearings: []
    },
    4: {  // Uvas Reservoir
        type: 'reservoir',
        anoxicStart: '2026-06-25',
        anoxicEnd:   '2026-10-01',
        notes: '',
        bankBearings: []
    },
    5: {  // Coyote Reservoir
        type: 'reservoir',
        anoxicStart: '2026-06-25',
        anoxicEnd:   '2026-10-01',
        notes: '',
        bankBearings: []
    }
};

// Node-side hook so the test harness can load this file without a browser global.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.LAKE_META;
}
