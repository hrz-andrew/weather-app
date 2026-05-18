// ─────────────────────────────────────────────────────────────────────────────
// insights.js — Bay Area bass fishing decision engine
//
// Takes a location's processed weather data (the internal shape produced by
// processData() / processLocalData() in index.html) and returns a verdict:
// best 3-hour window across the upcoming weekend, mode call, and reasons.
//
// Pattern: pure functions that consume data, return a verdict object.
// No DOM, no fetching, no side effects. Easy to test, easy to swap, easy to
// reason about. The renderer in index.html takes the verdict and paints pixels.
//
// Public API:
//   INSIGHTS.scoreLocation(loc, internalData, today)  → verdict object
//   INSIGHTS.scoreAllLocations(locs, weatherData, today) → ranked array
//   INSIGHTS.getWeekend(today)                        → next Fri/Sat/Sun dates
//
// Math architecture:
//   base       = neutralWindowQuality(hour)               — universal crepuscular curve
//   trend_mul  = tempTrendMultiplier(temp history)        — Step 2  (multiplicative)
//   front_mul  = pressureMultiplier(pressure trajectory)  — Step 3  (multiplicative — has veto power)
//   bonuses    = windScore + rainScore                    — Steps 4 + 5  (additive)
//   score      = clamp(base × trend_mul × front_mul + bonuses, 0, 100)
//   mode       = classifyMode(...)                        — Step 1  (derived, not scored)
//
// Multiplicative + additive is intentional: a passing front should kill an
// otherwise-perfect day (multiply by 0.35), but a windy day shouldn't single-
// handedly save a bad-bite hour (it's a bonus, not a multiplier).
//
// NOTE: seasonal modulation is intentionally absent. The framework's Step 6
// (season-tuned hour curves) is left as a user-side judgment — the engine
// scores the environmental data, the user reads the calendar. The neutral
// curve below is the universal crepuscular pattern (Section 1: bass are
// always crepuscular; the *intensity* varies by season — that variation is
// the user's call, not the engine's).
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    // ── User availability preference (soft bias) ─────────────────────────────
    //
    // Per-day-of-week preferred fishing hours. Soft bias only — windows OUTSIDE
    // these hours can still surface in the verdict if their bass-rules score is
    // significantly higher, but the model will lean toward the user's rhythm.
    //
    // Day-of-week numbers match JS Date.getDay(): 0=Sun, 5=Fri, 6=Sat.
    // Hours are 0–23 in local PDT.
    //
    // Structure: { dow: { preferred: [startHour, endHour], label } }.
    // Days omitted from this object get neutral treatment (no bias).
    //
    // Bias strength:
    //   inside preferred range     → ×1.00
    //   within 2h of the range     → ×0.85  (edge zone)
    //   outside both               → ×0.60  (still scored, just demoted)
    //
    // Eventually this could move to its own file or come from UI settings,
    // but for v1 it lives here as a constant.
    const USER_AVAILABILITY = {
        5: { preferred: [13, 21], label: 'Friday afternoon–evening' },  // 1pm–9pm
        6: { preferred: [5,  21], label: 'Saturday all day' },           // dawn–dusk
        0: { preferred: [5,  14], label: 'Sunday morning–early afternoon' }  // dawn–2pm
    };

    function availabilityMultiplier(dayOfWeek, hour) {
        const slot = USER_AVAILABILITY[dayOfWeek];
        if (!slot || !slot.preferred) return 1.0;
        const [start, end] = slot.preferred;
        if (hour >= start && hour <= end) return 1.00;
        if (hour >= start - 2 && hour <= end + 2) return 0.85;
        return 0.60;
    }

    function availabilityLabel(dayOfWeek) {
        return (USER_AVAILABILITY[dayOfWeek] || {}).label || null;
    }

    // ── Constants ────────────────────────────────────────────────────────────

    // Mechanism explanations keyed by (rule, direction). The "why" line of
    // each reason. Kept here so we can re-tune copy in one place without
    // touching the scoring math, and so the same string serves every lake.
    const RULE_WHYS = {
        temp_trend: {
            up_strong:   'bass move shallower, feed aggressively',
            up:          'bass move shallower, feed more aggressively',
            soft_up:     'modest warmup — bass shading toward shallower lies',
            flat:        'no thermal trigger — fish hold seasonal depth',
            soft_down:   'modest cooldown — bass shading deeper, bite mellows',
            down:        'bass move deeper, bite softens',
            down_strong: 'bite shuts down for 24–48h',
            sudden_drop: '24h cold front — bite shuts down for 24–48h'
        },
        pressure: {
            storm_front:     'major front incoming — bite intense but short',
            pre_front:       'pre-frontal feeding window — best window of the week',
            soft_fall:       'pressure trending down — modest signal',
            stable:          'no front in play — neither feeding push nor shutdown',
            post_front_soft: 'post-front recovery — bite still softer than baseline',
            bluebird:        'bluebird high — toughest fishing of the season'
        },
        wind: {
            ideal:    'riffles surface, concentrates bait, oxygenates',
            light:    'riffles surface, concentrates bait',
            strong:   'good bite, but heavier weights and shorter casts',
            extreme:  'biology still positive but shore fishing very tough',
            calm:     'glass kills the bite outside dawn/dusk'
        },
        rain: {
            light:    'stains water mildly, washes food in',
            heavy:    'fresh inflow — creek arms may be magic (cold inflow penalty in winter)'
        },
        // Fishability — separate from bite quality. Bass may bite well in a
        // gusty pre-front window, but a shore angler can't physically fish it:
        // casts get blown back, line bows, footing on the bank gets dangerous.
        fishability: {
            rough:       'sustained wind + gusts make shore casting tough',
            very_rough:  'gusts strong enough to blow casts back at you',
            unfishable:  'gusts too strong to stand on the bank safely'
        }
    };

    // Polarity map: every (rule, direction) → one of five tiers.
    // The 5-tier system lets the dot color carry a real spectrum instead of
    // collapsing "baseline / no signal" and "mild headwind" into the same
    // amber bucket. Tiers, in order:
    //   good       — strong positive signal (use the lake, plan the trip)
    //   good-mild  — direction is right but signal is small (cautious yes)
    //   neutral    — true baseline, no signal either way (calm grey)
    //   warn       — mild headwind, conditions trending the wrong way
    //   bad        — strong negative signal (skip or pivot)
    // Keep this aligned with how each rule affects the composite score:
    // a +0.15 multiplier should not look the same as a -0.50 multiplier.
    function polarityFor(rule, direction) {
        if (rule === 'fishability')  return 'bad';
        if (rule === 'lake_note')    return 'bad';
        if (rule === 'pressure') {
            if (direction === 'storm_front' || direction === 'pre_front')         return 'good';
            if (direction === 'soft_fall')                                        return 'good-mild';
            if (direction === 'stable')                                           return 'neutral';
            if (direction === 'post_front_soft')                                  return 'warn';
            if (direction === 'bluebird')                                         return 'bad';
            return 'neutral';
        }
        if (rule === 'temp_trend') {
            if (direction === 'up_strong')                                        return 'good';
            if (direction === 'up')                                               return 'good-mild';
            if (direction === 'soft_up')                                          return 'good-mild';
            if (direction === 'flat')                                             return 'neutral';
            if (direction === 'soft_down')                                        return 'warn';
            if (direction === 'down')                                             return 'warn';
            if (direction === 'down_strong' || direction === 'sudden_drop')       return 'bad';
            return 'neutral';
        }
        if (rule === 'wind') {
            if (direction === 'ideal')                                            return 'good';
            if (direction === 'light' || direction === 'strong')                  return 'good-mild';
            if (direction === 'extreme')                                          return 'warn';
            if (direction === 'calm')                                             return 'bad';
            return 'neutral';
        }
        if (rule === 'rain') {
            if (direction === 'light')                                            return 'good';
            if (direction === 'heavy')                                            return 'good-mild';
            if (direction === 'none')                                             return 'neutral';
            return 'neutral';
        }
        return 'neutral';
    }

    // Universal crepuscular hour curve (Step 1 of the framework — bass are
    // ALWAYS crepuscular; intensity and width are the seasonal part, which
    // the user owns). 24-element array, hour 0–23.
    //
    // A 3-hour scoring window centered on hour H averages [H-1, H, H+1] from
    // this curve to get its base score (0–100). The shape:
    //   - dead overnight (0–3am, 10pm onward)
    //   - sharp dawn ramp 4–7am, peak 6–7am
    //   - midday lull 10am–2pm (still fishable, just not peak)
    //   - dusk peak 6–8pm, sharp falloff
    const NEUTRAL_HOUR_CURVE = [
        0,  0,  0,  0,    //  0– 3
        20, 55, 75, 80,   //  4– 7
        70, 55, 45, 40,   //  8–11
        40, 40, 45, 50,   // 12–15
        55, 65, 75, 80,   // 16–19
        70, 40, 15, 5     // 20–23
    ];

    // ── Pure helpers ─────────────────────────────────────────────────────────

    function kToC(k) { return k - 273.15; }

    // Daily mean air temp — the right proxy for "water temp at this lake on this
    // day," because water lags air by 3–5 days and dampens the swing. Using the
    // window's instantaneous air temp would falsely flag ambush at 6am even on
    // a May morning when the actual lake water is in the active range.
    function dailyMeanTempC(internalData, isoDate) {
        const samples = [];
        for (let i = 0; i < internalData.timestamps.length; i++) {
            const d = new Date(internalData.timestamps[i]);
            const pdt = new Date(d.getTime() - 7 * 3600 * 1000);
            if (toISODate(pdt) === isoDate) samples.push(kToC(internalData.temp[i]));
        }
        if (!samples.length) return null;
        return samples.reduce((a, b) => a + b, 0) / samples.length;
    }

    // Convert "wind FROM" bearing to "wind TOWARD" bearing → compass label.
    // Wind direction is reported as the direction it's COMING FROM, but for
    // fishing we care which bank the wind is pushing bait TOWARD (windward bank).
    function compassFromBearing(deg) {
        if (deg == null || !isFinite(deg)) return null;
        const toward = (deg + 180) % 360;
        const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const idx = Math.round(toward / 45) % 8;
        return dirs[idx];
    }

    // Parse 'YYYY-MM-DD' → Date at noon UTC (avoids timezone slippage).
    function parseISODate(s) {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d, 12));
    }

    function toISODate(d) {
        const pad = n => String(n).padStart(2, '0');
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }

    // Add N days to a Date, returning a new Date.
    function addDays(d, n) {
        const r = new Date(d);
        r.setUTCDate(r.getUTCDate() + n);
        return r;
    }

    // Given a date, return the next Fri/Sat/Sun as ISO strings.
    // If today IS Fri/Sat/Sun, "weekend" starts today (so on Sat morning we
    // show Sat + Sun, not next week's Fri).
    function getWeekend(todayISO) {
        const today = parseISODate(todayISO);
        const dow = today.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
        let fri;
        if (dow === 5) fri = today;
        else if (dow === 6) fri = addDays(today, -1);
        else if (dow === 0) fri = addDays(today, -2);
        else fri = addDays(today, (5 - dow + 7) % 7);
        const sat = addDays(fri, 1);
        const sun = addDays(fri, 2);
        // If today is past Friday, only return remaining days
        const all = [fri, sat, sun].map(toISODate);
        return all.filter(d => parseISODate(d) >= parseISODate(todayISO));
    }

    // ── Base score: universal crepuscular curve ──────────────────────────────

    // Score a 3-hour window centered on hourCenter (0-23). Returns 0-100.
    // Date is unused — this is the season-agnostic base. (User reads the
    // calendar themselves and adjusts mentally.)
    function neutralWindowQuality(hourCenter) {
        const hours = [(hourCenter + 23) % 24, hourCenter, (hourCenter + 1) % 24];
        const sum = hours.reduce((a, h) => a + NEUTRAL_HOUR_CURVE[h], 0);
        return sum / 3;
    }

    // ── Step 2: temp-trend multiplier (uses air temp as water-temp proxy) ──

    // Returns { mul, direction, deltaC } where direction is one of:
    //   up_strong | up | flat | down | down_strong | sudden_drop
    //
    // We use air temp dampened ~70% as a stand-in for water temp. Water lags
    // air by 3-5 days and responds with reduced amplitude, so the 3-day
    // air-temp delta tells us about water-temp DIRECTION (which is what
    // matters per Step 2) even if it overstates magnitude. We dampen the
    // delta we report in the reason text so we're not lying to the user.
    //
    // The 24h sudden-drop check is intentionally SEPARATE from the 3-day
    // trend. They're different time-constant signals — a 3-day trend is
    // "what metabolic mode are bass in," a 24h drop is "did a front just pass
    // through." Averaging them into one delta loses the front-event signal.
    function tempTrendMultiplier(internalData, targetIsoDate) {
        // Build a per-day mean air temp lookup from internalData.
        const dayMeans = new Map(); // isoDate → mean °C
        const buckets = new Map(); // isoDate → temps[]
        for (let i = 0; i < internalData.timestamps.length; i++) {
            const d = new Date(internalData.timestamps[i]);
            const pdt = new Date(d.getTime() - 7 * 3600 * 1000);
            const iso = toISODate(pdt);
            if (!buckets.has(iso)) buckets.set(iso, []);
            buckets.get(iso).push(kToC(internalData.temp[i]));
        }
        for (const [iso, arr] of buckets) {
            dayMeans.set(iso, arr.reduce((a, b) => a + b, 0) / arr.length);
        }

        const target = parseISODate(targetIsoDate);
        const tMean  = dayMeans.get(targetIsoDate);
        if (tMean == null) return { mul: 1.0, direction: 'flat', deltaC: 0 };

        // ── 24h sudden-drop check (overrides 3-day trend if shutdown-grade) ─
        // Framework: 5°F (2.8°C) water drop in 24h post-front → 24–48h shutdown.
        // With 0.7 damping that's a ~4°C air-temp drop → dampened ~2.8°C drop.
        // We trigger slightly more sensitive (−2.0 dampened) to catch the
        // shoulder of the shutdown event, not just its center.
        const back1 = toISODate(addDays(target, -1));
        const bMean24 = dayMeans.get(back1);
        if (bMean24 != null) {
            const delta24 = (tMean - bMean24) * 0.7;
            if (delta24 < -2.0) {
                return { mul: 0.50, direction: 'sudden_drop', deltaC: delta24 };
            }
        }

        // ── 3-day trend (the slower metabolic signal) ───────────────────────
        const back3 = toISODate(addDays(target, -3));
        const bMean = dayMeans.get(back3);

        let deltaC;
        if (bMean == null) {
            // Use the earliest available day as a fallback baseline.
            let earliest = null, earliestIso = null;
            for (const [iso, mean] of dayMeans) {
                if (!earliestIso || iso < earliestIso) { earliestIso = iso; earliest = mean; }
            }
            if (earliest == null) return { mul: 1.0, direction: 'flat', deltaC: 0 };
            deltaC = tMean - earliest;
        } else {
            deltaC = tMean - bMean;
        }
        const dampened = deltaC * 0.7; // water-temp proxy

        // 7-band classifier — mirrors pressure's 3-tier-per-side sensitivity.
        // The middle ±0.5°C "flat" zone is true noise; ±0.5–1.5 captures the
        // metabolic-drift signal (bass shading shallower/deeper without a
        // hard feeding-push trigger); ±1.5–3 is the framework's "modest
        // signal" tier; >±3 is the strong-trigger / shutdown tier.
        if (dampened >  3.0) return { mul: 1.30, direction: 'up_strong',   deltaC: dampened };
        if (dampened >  1.5) return { mul: 1.15, direction: 'up',          deltaC: dampened };
        if (dampened >  0.5) return { mul: 1.05, direction: 'soft_up',     deltaC: dampened };
        if (dampened > -0.5) return { mul: 1.00, direction: 'flat',        deltaC: dampened };
        if (dampened > -1.5) return { mul: 0.95, direction: 'soft_down',   deltaC: dampened };
        if (dampened > -3.0) return { mul: 0.85, direction: 'down',        deltaC: dampened };
        return                     { mul: 0.50, direction: 'down_strong', deltaC: dampened };
    }

    // ── Step 3: pressure multiplier (the veto-power one) ────────────────────

    // Returns { mul, direction, delta12h } where direction is one of:
    //   storm_front | pre_front | soft_fall | stable | post_front_soft | bluebird
    //
    // 12h delta of pressure preceding the scoring window. Thresholds map to
    // the framework's 24h bands halved (e.g., framework's "falling 3–6 mmHg
    // over 24h = pre-frontal sweet spot" → 1.5–4 mmHg over 12h here).
    //
    // The "stable" band (±0.75 mmHg/12h = ±1.5 mmHg/24h) matches the
    // framework's explicit "drift <1.5 mmHg/24h = negligible, no signal"
    // tier. Anything inside this band shouldn't drive recommendations.
    function pressureMultiplier(internalData, windowTsIdx) {
        const ts = internalData.timestamps;
        // Pressure now comes from Open-Meteo for every model view (local
        // ECMWF, ECMWF API, GFS, NAM) — Windy no longer scrapes pressure.
        // The old `pressure_windy` frozen-snapshot path was removed; trying
        // to prefer it produced an all-null array → every window scored
        // "stable" regardless of the actual forecast.
        const p  = internalData.pressure;
        const targetTs = ts[windowTsIdx];
        const twelveHrMs = 12 * 3600 * 1000;
        // Find the index closest to (targetTs - 12h).
        let backIdx = windowTsIdx;
        for (let i = windowTsIdx; i >= 0; i--) {
            if (ts[i] <= targetTs - twelveHrMs) { backIdx = i; break; }
            if (i === 0) backIdx = 0;
        }
        const pNow  = p[windowTsIdx];
        const pBack = p[backIdx];
        if (pNow == null || pBack == null) {
            return { mul: 1.0, direction: 'stable', delta12h: 0 };
        }
        const delta = pNow - pBack; // mmHg over 12h

        if (delta < -4.0)  return { mul: 1.15, direction: 'storm_front',     delta12h: delta };
        if (delta < -1.5)  return { mul: 1.20, direction: 'pre_front',       delta12h: delta };
        if (delta < -0.75) return { mul: 1.05, direction: 'soft_fall',       delta12h: delta };
        if (delta < +0.75) return { mul: 1.00, direction: 'stable',          delta12h: delta };
        if (delta < +2.0)  return { mul: 0.85, direction: 'post_front_soft', delta12h: delta };
        return                  { mul: 0.35, direction: 'bluebird',         delta12h: delta };
    }

    // ── Step 4: wind score (additive bonus) ─────────────────────────────────

    // Returns { score, direction, wind_ms, compass } where direction is one of:
    //   ideal | light | strong | extreme | calm
    //
    // CRITICAL: this function scores BIOLOGY only (does wind help or hurt the
    // bite). The fishability multiplier below scores PHYSICS (can a shore
    // angler actually cast in this). Framework Step 4 explicitly says 7+ m/s
    // is biologically GOOD ("the fishing is good if you can manage heavier
    // weights and shorter casts") — only the human casting side suffers. So
    // this function stays positive across 7–13 m/s; fishabilityMultiplier
    // carries the cost of the rough water on the angler.
    function windScore(windMs, gusts, windDir, hourCenter) {
        const dir = compassFromBearing(windDir);
        const isLowLight = (hourCenter <= 7 || hourCenter >= 18);
        if (windMs == null) return { score: 0, direction: 'light', wind_ms: 0, compass: null };

        if (windMs >= 2  && windMs <= 5)  return { score: 15, direction: 'ideal',   wind_ms: windMs, compass: dir };
        if (windMs > 5   && windMs <= 7)  return { score: 12, direction: 'light',   wind_ms: windMs, compass: dir };
        if (windMs > 7   && windMs <= 10) return { score: 8,  direction: 'strong',  wind_ms: windMs, compass: dir };
        if (windMs > 10  && windMs <= 13) return { score: 5,  direction: 'strong',  wind_ms: windMs, compass: dir };
        if (windMs > 13)                  return { score: 0,  direction: 'extreme', wind_ms: windMs, compass: dir };
        if (windMs < 1)                   return { score: isLowLight ? 0 : -8, direction: 'calm', wind_ms: windMs, compass: dir };
        return { score: 5, direction: 'light', wind_ms: windMs, compass: dir }; // 1–2 m/s
    }

    // Fishability multiplier — separate from bite quality.
    //
    // A pre-front pressure drop ramps up the bite (pressure ×1.20), but if it
    // comes with 12+ m/s gusts a shore angler simply can't fish it. Without
    // this veto the model picks "great bite + impossible to fish" windows over
    // "good bite + actually fishable" ones — exactly the failure mode that hit
    // the 5/12 dashboard run where every lake chose Fri 7-9pm.
    //
    // Multiplicative on the whole composite so it overrides additive bonuses,
    // and reads the WORSE of sustained wind / peak gust within the window.
    function fishabilityMultiplier(windMs, gustMs) {
        const peak = Math.max(windMs || 0, gustMs || 0);
        if (peak >= 13) return { mul: 0.25, level: 'unfishable', peak };
        if (peak >= 11) return { mul: 0.45, level: 'very_rough', peak };
        if (peak >= 9)  return { mul: 0.70, level: 'rough',      peak };
        return { mul: 1.0, level: 'ok', peak };
    }

    // ── Step 5: rain score (additive bonus) ─────────────────────────────────

    // Sum of precip over the 48h BEFORE the window. Season-agnostic — user
    // overrides mentally for cold inflow in winter (framework's "more
    // complicated" case for heavy spring runoff vs. winter cold inflow is a
    // calendar judgment, not an environmental measurement).
    function rainScore(internalData, windowTsIdx) {
        const ts = internalData.timestamps;
        const r  = internalData.precip;
        const targetTs = ts[windowTsIdx];
        const fortyEightHrMs = 48 * 3600 * 1000;
        let sum = 0;
        for (let i = 0; i < windowTsIdx; i++) {
            if (ts[i] >= targetTs - fortyEightHrMs) sum += (r[i] || 0);
        }
        if (sum < 0.3) return { score: 0, direction: 'none',  mm: sum };
        if (sum <= 5)  return { score: 6, direction: 'light', mm: sum };
        if (sum <= 15) return { score: 4, direction: 'light', mm: sum };
        return              { score: 3, direction: 'heavy', mm: sum };
    }

    // ── Step 1: mode classifier ─────────────────────────────────────────────

    // Returns 'active' or 'ambush'. Pure environmental triggers, no season.
    //   - Post-front rising pressure → ambush (front trumps everything)
    //   - Temp >27°C (80°F) → ambush (thermal ceiling, low-oxygen surface)
    //   - Temp <13°C (55°F) → ambush (thermal floor)
    //   - Past anoxic-zone start for this lake → ambush
    //   - Otherwise → active (the framework's default mode when conditions
    //     are within the active envelope and no front is passing)
    function classifyMode({ tempCAvg, pressureDir, isAnoxic }) {
        if (pressureDir === 'post_front_soft' || pressureDir === 'bluebird') return 'ambush';
        if (tempCAvg != null && tempCAvg > 27) return 'ambush';
        if (tempCAvg != null && tempCAvg < 13) return 'ambush';
        if (isAnoxic) return 'ambush';
        return 'active';
    }

    // ── Main scoring ────────────────────────────────────────────────────────

    // Score one 3-hour window centered on the given timestamp index.
    function scoreWindow(loc, internalData, idx, meta) {
        const ts = internalData.timestamps[idx];
        const date = new Date(ts);
        const pdt = new Date(date.getTime() - 7 * 3600 * 1000);
        const isoDate = toISODate(pdt);
        const hourCenter = pdt.getUTCHours();

        const base = neutralWindowQuality(hourCenter);
        const tempCAvg = kToC(internalData.temp[idx]);             // window snapshot (display)
        const tempCDaily = dailyMeanTempC(internalData, isoDate);  // water-temp proxy (mode)

        const trend = tempTrendMultiplier(internalData, isoDate);
        const press = pressureMultiplier(internalData, idx);
        const wind  = windScore(internalData.windSpeed[idx], internalData.gusts[idx], internalData.windDir[idx], hourCenter);
        const rain  = rainScore(internalData, idx);
        const fish  = fishabilityMultiplier(internalData.windSpeed[idx], internalData.gusts[idx]);

        // Anoxic check: is target date past this lake's stratification start?
        const m = meta || {};
        const isAnoxic = m.anoxicStart && m.anoxicEnd &&
            isoDate >= m.anoxicStart && isoDate <= m.anoxicEnd;

        const mode = classifyMode({ tempCAvg: tempCDaily, pressureDir: press.direction, isAnoxic });

        // Step A: pure bass-rules score (no user-preference adjustment).
        // fish.mul vetos windows that are biologically prime but physically
        // unfishable from shore (high gusts). Multiplicative so it can
        // override an additive +15 wind bonus + ×1.2 pressure boost.
        const bassScore  = Math.max(0, base * trend.mul * press.mul + wind.score + rain.score);
        const modelScore = bassScore * fish.mul;

        // Step B: apply user availability bias. Soft multiplier, not a hard filter,
        // so a truly exceptional out-of-slot window can still shine through.
        const dayOfWeek = pdt.getUTCDay();
        const availMul = availabilityMultiplier(dayOfWeek, hourCenter);
        const rawScore = modelScore * availMul;
        const composite = Math.min(100, rawScore);

        // Assemble reasons in priority order. We'll trim to top 3 in the verdict.
        const reasons = [];

        // Small helper so every push carries a polarity without repetition.
        const pushReason = (rule, direction, signal, why) => {
            reasons.push({ rule, direction, signal, why, polarity: polarityFor(rule, direction) });
        };

        // Fishability FIRST — if the window is physically rough for shore
        // fishing, that's the headline regardless of how good the bite is.
        // Without this on top, a "great bite, unfishable" window reads as
        // misleading optimism in the UI.
        if (fish.level !== 'ok') {
            const peak = fish.peak.toFixed(0);
            const label =
                fish.level === 'unfishable' ? `Gusts ${peak} m/s — shore fishing unsafe` :
                fish.level === 'very_rough' ? `Gusts ${peak} m/s — shore casting very rough` :
                                              `Gusts ${peak} m/s — shore casting rough`;
            pushReason('fishability', fish.level, label, RULE_WHYS.fishability[fish.level] || '');
        }

        // Display order: temp → pressure → wind → rain.
        // Temp + pressure always surface (including flat / stable), so a
        // quiet reading doesn't look like missing data on the card. The
        // framework treats baselines as actionable info too: "fish where
        // the calendar says."

        // Temp trend.
        pushReason('temp_trend', trend.direction, tempSignalText(trend), RULE_WHYS.temp_trend[trend.direction] || '');
        // Pressure — highest-leverage bass signal.
        pushReason('pressure', press.direction, pressureSignalText(press), RULE_WHYS.pressure[press.direction] || '');
        // Wind — suppressed on truly quiet days (light AND |score| < 5).
        if (wind.direction !== 'light' || Math.abs(wind.score) >= 5) {
            const action = wind.compass && wind.score > 0 ? ` — fish the ${wind.compass} bank` : '';
            pushReason('wind', wind.direction, `${windDescriptor(wind)} (${wind.wind_ms.toFixed(0)} m/s)${action}`, RULE_WHYS.wind[wind.direction] || '');
        }
        // Rain — only if it moved the needle.
        if (rain.direction !== 'none' && Math.abs(rain.score) >= 3) {
            pushReason('rain', rain.direction, `${rain.mm.toFixed(1)}mm rain in last 48h`, RULE_WHYS.rain[rain.direction] || '');
        }
        // Anoxic note (mainly Almaden in late June).
        if (isAnoxic && m.notes) {
            pushReason('lake_note', 'anoxic', m.notes, 'lake is past summer stratification — oxygen low near surface');
        }

        return {
            score: composite,            // 0–100, clamped (for display)
            rawScore,                    // unclamped (for sorting + tie-breaking)
            mode,
            window: { ts, isoDate, hourCenter },
            reasons,
            // Debug data — useful for tuning, hidden in the verdict UI.
            _debug: { base, trend, press, wind, rain, fish, tempCAvg, tempCDaily, bassScore, modelScore, availMul, rawScore }
        };
    }

    // Score a location across multiple days (weekend), return the best window.
    function scoreLocation(loc, internalData, todayISO) {
        const meta = (window.LAKE_META || {})[loc.id] || {};
        const weekend = getWeekend(todayISO);
        const candidates = [];

        for (let i = 0; i < internalData.timestamps.length; i++) {
            const d = new Date(internalData.timestamps[i]);
            const pdt = new Date(d.getTime() - 7 * 3600 * 1000);
            const iso = toISODate(pdt);
            const hour = pdt.getUTCHours();
            // Only score windows that fall on weekend days AND in reasonable hours.
            if (!weekend.includes(iso)) continue;
            // Skip late-night and pre-dawn slots — nobody's fishing 11PM–3AM.
            if (hour < 4 || hour > 22) continue;
            candidates.push(scoreWindow(loc, internalData, i, meta));
        }

        if (!candidates.length) {
            return {
                loc,
                noData: true,
                weekendDates: weekend
            };
        }

        // Pick the best-scoring window. Sort by RAW score so ties at the 100
        // ceiling get broken correctly (a 115 day beats a 105 day).
        candidates.sort((a, b) => b.rawScore - a.rawScore);
        const best = candidates[0];

        // Find a meaningfully-different second-best window — i.e. on a
        // DIFFERENT weekend day if possible (so we surface "Sun 7-9 or Fri
        // 7-9pm", not "Sun 7-9 or Sun 8-10"). If only one weekend day is
        // left in the horizon, fall back to a window with ≥4h separation
        // from the primary so the two recommendations are temporally
        // distinct.
        //
        // Reasons stay tied to `best` only — the alternate is just a "if
        // primary doesn't work for you" option, not its own scored verdict.
        let alternate = null;
        const bestDate = best.window.isoDate;
        const bestHour = best.window.hourCenter;
        for (let i = 1; i < candidates.length; i++) {
            const c = candidates[i];
            const differentDay   = c.window.isoDate !== bestDate;
            const meaningfulGap  = Math.abs(c.window.hourCenter - bestHour) >= 4;
            if (differentDay || meaningfulGap) { alternate = c; break; }
        }

        // Trim reasons to top 3 (already in priority order).
        best.reasons = best.reasons.slice(0, 3);

        return {
            loc,
            score: best.score,
            rawScore: best.rawScore,
            mode: best.mode,
            window: best.window,
            alternateWindow: alternate ? alternate.window : null,
            alternateScore:  alternate ? alternate.score  : null,
            reasons: best.reasons,
            weekendDates: weekend,
            _debug: best._debug,
            _allCandidates: candidates  // for analytics expander later
        };
    }

    function scoreAllLocations(locs, weatherData, todayISO) {
        const verdicts = locs
            .map(loc => {
                const data = weatherData[loc.id];
                if (!data) return { loc, noData: true };
                return scoreLocation(loc, data, todayISO);
            })
            .filter(v => !v.noData);
        verdicts.sort((a, b) => (b.rawScore || 0) - (a.rawScore || 0));
        return verdicts;
    }

    // ── Signal text helpers ─────────────────────────────────────────────────

    function pressureSignalText(press) {
        const d = Math.abs(press.delta12h).toFixed(1);
        if (press.direction === 'storm_front')     return `Pressure ↓ ${d} mmHg/12h — major front`;
        if (press.direction === 'pre_front')       return `Pressure ↓ ${d} mmHg/12h`;
        if (press.direction === 'soft_fall')       return `Pressure ↓ ${d} mmHg/12h`;
        if (press.direction === 'post_front_soft') return `Pressure ↑ ${d} mmHg/12h — post-front`;
        if (press.direction === 'bluebird')        return `Pressure ↑ ${d} mmHg/12h — bluebird high`;
        return `Pressure stable`;
    }

    function tempSignalText(trend) {
        // Mirror pressureSignalText's format: "Temp ↑ 1.7°C/3d (est. water)"
        // and "Temp flat" — arrow carries direction so we drop the leading
        // +/- sign and the "Rising / Falling" prefix. "(est. water)" is kept
        // as a methodology note (the deltaC is already dampened to ~0.7× of
        // the air-temp swing to approximate lake water response).
        if (trend.direction === 'flat') return 'Temp flat';
        const d = Math.abs(trend.deltaC).toFixed(1);
        const arrow = trend.deltaC >= 0 ? '↑' : '↓';
        if (trend.direction === 'sudden_drop') {
            return `Temp ↓ ${d}°C/24h (est. water)`;
        }
        return `Temp ${arrow} ${d}°C/3d (est. water)`;
    }

    function windDescriptor(wind) {
        if (wind.direction === 'ideal')   return `${wind.compass || ''} wind`.trim();
        if (wind.direction === 'calm')    return 'Glass calm';
        if (wind.direction === 'strong')  return `Strong ${wind.compass || ''} wind`.trim();
        if (wind.direction === 'extreme') return `Extreme ${wind.compass || ''} wind`.trim();
        return `Light ${wind.compass || ''} wind`.trim();
    }

    // ── 7-phase frontal classifier + week-pattern detector ─────────────────
    //
    // Spec: weather-app-scoring-rules.md §2. Three pure functions:
    //
    //   dailyAggregate(data, dayList, todayISO) → per-day pressure/wind/precip/cloud stats
    //   classifyAllPhases(series)               → [{ date, phase, confidence }, ...]
    //   detectWeekPattern(perDay, series)       → { tag, confidence, evidence }
    //
    // Spec is written in mb (hPa). Internal data is mmHg throughout the
    // pipeline (CLAUDE.md decision). All thresholds below are converted
    // (1 mb = 0.750062 mmHg) with the mb equivalent in comments so the spec
    // is still followable line-for-line.

    // Pressure anchors — absolute level
    const PRES_HIGH_ANCHOR = 765.06;  // 1020 mb — STABLE_HIGH / RIDGE floor
    const PRES_LOW_ANCHOR  = 757.56;  // 1010 mb — atmospheric river ceiling
    const PRES_MID_LOW     = 759.06;  // 1012 mb — UNSTABLE middle band low
    const PRES_MID_HIGH    = 763.56;  // 1018 mb — UNSTABLE middle band high

    // Pressure 24h Δ bands
    const DRIFT_MMHG      = 1.13;  // ±1.5 mb — STABLE_HIGH / RIDGE drift
    const WIDE_DRIFT_MMHG = 2.25;  // ±3 mb  — UNSTABLE upper drift bound
    const FALL_MIN_MMHG   = 3.00;  // 4 mb falling — PRE_FRONT band low edge
    const FALL_MAX_MMHG   = 6.00;  // 8 mb falling — PRE_FRONT band high edge
    const RISE_MIN_MMHG   = 3.00;  // 4 mb rising  — DAY_1_POST band low edge
    const RISE_MAX_MMHG   = 4.50;  // 6 mb rising  — DAY_1_POST band high edge

    // ── Small numeric helpers (null-aware) ───────────────────────────────
    function safeMean(arr) {
        let s = 0, n = 0;
        for (const v of arr) {
            if (v == null || isNaN(v)) continue;
            s += v; n++;
        }
        return n ? s / n : null;
    }
    function safeMax(arr) {
        let m = -Infinity, found = false;
        for (const v of arr) {
            if (v == null || isNaN(v)) continue;
            if (v > m) { m = v; found = true; }
        }
        return found ? m : null;
    }
    // Circular mean of degrees (for wind direction). Standard atan2 method.
    function circularMean(degArr) {
        let sumSin = 0, sumCos = 0, n = 0;
        for (const d of degArr) {
            if (d == null || isNaN(d)) continue;
            const r = d * Math.PI / 180;
            sumSin += Math.sin(r); sumCos += Math.cos(r); n++;
        }
        if (n === 0) return null;
        let deg = Math.atan2(sumSin / n, sumCos / n) * 180 / Math.PI;
        if (deg < 0) deg += 360;
        return deg;
    }

    // ── dailyAggregate ───────────────────────────────────────────────────
    //
    // Bucket forward-looking hourly data into per-day stats, anchored on
    // `dayList` (chronological ISO dates from the caller — keeps the day
    // order stable across functions). Returns an array in dayList order.
    //
    // p24Delta / p48Delta are filled in a second pass. They are null for
    // the first day and first-two days respectively (forward-only data,
    // no yesterday). The classifier reads null as "insufficient history"
    // and degrades confidence to low — that is the spec's intent, not a
    // bug. We do NOT synthesize fake history.
    function dailyAggregate(data, dayList, todayISO) {
        const byDate = new Map();
        for (const iso of dayList) {
            byDate.set(iso, {
                date: iso,
                pressureSamples: [], windSamples: [], gustSamples: [],
                dirSamples: [], precipSum: 0, cloudSamples: [], tempCSamples: []
            });
        }

        for (let i = 0; i < data.timestamps.length; i++) {
            const d = new Date(data.timestamps[i]);
            const pdt = new Date(d.getTime() - 7 * 3600 * 1000);
            const iso = toISODate(pdt);
            // Forward-only cutoff for weeklyOutlook (don't aggregate yesterday's
            // tail into today's bucket). dailyInsights passes todayISO=null to
            // bypass this cutoff because it WANTS the past-72h hours.
            if (todayISO != null && iso < todayISO) continue;
            const b = byDate.get(iso);
            if (!b) continue;
            if (data.pressure  && data.pressure[i]  != null) b.pressureSamples.push(data.pressure[i]);
            if (data.windSpeed && data.windSpeed[i] != null) b.windSamples.push(data.windSpeed[i]);
            if (data.gusts     && data.gusts[i]     != null) b.gustSamples.push(data.gusts[i]);
            if (data.windDir   && data.windDir[i]   != null) b.dirSamples.push(data.windDir[i]);
            if (data.precip    && data.precip[i]    != null) b.precipSum += data.precip[i];
            if (data.cloud     && data.cloud[i]     != null) b.cloudSamples.push(data.cloud[i]);
            if (data.temp      && data.temp[i]      != null) b.tempCSamples.push(kToC(data.temp[i]));
        }

        const series = dayList.map(iso => {
            const b = byDate.get(iso);
            return {
                date: iso,
                meanPressure: safeMean(b.pressureSamples),
                meanWindMS:   safeMean(b.windSamples),
                maxGustMS:    safeMax(b.gustSamples),
                meanWindDir:  circularMean(b.dirSamples),
                totalPrecip:  b.precipSum,
                meanCloud:    safeMean(b.cloudSamples),
                meanTempC:    safeMean(b.tempCSamples),
                maxTempC:     safeMax(b.tempCSamples),
                p24Delta:     null,
                p48Delta:     null
            };
        });

        // Second pass — fill 24h and 48h pressure deltas (today − N-days-ago).
        // Negative = falling. Positive = rising.
        for (let i = 0; i < series.length; i++) {
            if (i >= 1 && series[i].meanPressure != null && series[i-1].meanPressure != null) {
                series[i].p24Delta = series[i].meanPressure - series[i-1].meanPressure;
            }
            if (i >= 2 && series[i].meanPressure != null && series[i-2].meanPressure != null) {
                series[i].p48Delta = series[i].meanPressure - series[i-2].meanPressure;
            }
        }
        return series;
    }

    // ── classifyDayPhase ─────────────────────────────────────────────────
    //
    // One day at a time, with access to ±1 day for trough/peak detection
    // and to the today's own p24Delta / p48Delta for trend reading.
    //
    // Returns { phase, confidence }. UNSTABLE is the honest fallback —
    // see spec §2: "It is not a 'bad' or 'good' day by itself … but the
    // classifier is telling you it can't read the system."
    function classifyDayPhase(series, i) {
        const today = series[i];
        const prev  = i >= 1 ? series[i-1] : null;
        const next  = i < series.length - 1 ? series[i+1] : null;

        if (today.meanPressure == null) {
            return { phase: 'UNSTABLE', confidence: 'low' };
        }
        const p   = today.meanPressure;
        const d24 = today.p24Delta;
        const d48 = today.p48Delta;

        // Spec §Confidence: "forecast horizon too short to read 48h context"
        // is an explicit low-confidence criterion. No yesterday → no Δ24.
        if (d24 == null) {
            return { phase: 'UNSTABLE', confidence: 'low' };
        }
        const abs24 = Math.abs(d24);

        // Local trough: prev and next both clearly higher than today.
        const isTrough = prev && next
            && prev.meanPressure != null && next.meanPressure != null
            && (prev.meanPressure - p) > DRIFT_MMHG
            && (next.meanPressure - p) > DRIFT_MMHG;

        // Did yesterday hit a trough? (used for DAY_1_POST confidence boost)
        const prevWasTroughFall = prev && prev.p24Delta != null
            && prev.p24Delta < -FALL_MIN_MMHG
            && d24 > 0;

        // ── PASSAGE ── today is the trough; pressure descending into it.
        if (isTrough && d24 < 0) {
            const conf = (d48 != null && d48 < -FALL_MIN_MMHG) ? 'high' : 'medium';
            return { phase: 'PASSAGE', confidence: conf };
        }

        // ── PRE_FRONT ── falling 4–8 mb, 48h trending down.
        if (d24 <= -FALL_MIN_MMHG && d24 >= -FALL_MAX_MMHG) {
            let conf;
            if (d48 != null && d48 < -FALL_MIN_MMHG) conf = 'high';
            else if (d48 == null || d48 < 0)         conf = 'medium';
            else                                     conf = 'low';
            return { phase: 'PRE_FRONT', confidence: conf };
        }

        // ── DAY_1_POST ── rising ≥ 4 mb (3.0 mmHg) with post-front context.
        // Spec canonical band is rising 4–6 mb. Real Pacific post-front rises
        // can exceed 6 mb (8+ mb is common after a strong passage); we accept
        // those as DAY_1_POST/medium since the meteorological pattern
        // (passage 24–48h ago → rising today) is unambiguous even when the
        // magnitude exceeds the spec's canonical example.
        //
        // Post-front context is any of:
        //   - prev day was a trough fall (the textbook D-1 case)
        //   - prev day's d24 was descending (we're still inside the recovery)
        //   - d48 shows recovery from 2 days ago (the rise is extending into a
        //     second day; prev day was already rising, not falling)
        //
        // High confidence is reserved for canonical band AND prev was trough.
        if (d24 >= RISE_MIN_MMHG) {
            const postFrontContext = prevWasTroughFall
                || (prev && prev.p24Delta != null && prev.p24Delta <= -FALL_MIN_MMHG)
                || (d48 != null && d48 > RISE_MIN_MMHG);
            if (postFrontContext) {
                const inCanonicalBand = d24 <= RISE_MAX_MMHG;
                const conf = (inCanonicalBand && prevWasTroughFall) ? 'high' : 'medium';
                return { phase: 'DAY_1_POST', confidence: conf };
            }
        }

        // ── DAY_2_POST ── drift, at recent peak, ~48h after trough.
        // Spec says "at peak, drift slowing / 48h after trough". "At peak" is
        // a LOCAL peak (today ≥ both neighbors), not strictly p > 1020 mb —
        // real recoveries often top out at 1015–1018 mb. High confidence when
        // p also exceeds the high anchor (cleanest read).
        const isLocalPeak = prev && next
            && prev.meanPressure != null && next.meanPressure != null
            && p >= prev.meanPressure - DRIFT_MMHG
            && p >= next.meanPressure - DRIFT_MMHG;
        if (abs24 <= DRIFT_MMHG && d48 != null && d48 > RISE_MIN_MMHG
            && (isLocalPeak || p > PRES_HIGH_ANCHOR)) {
            return {
                phase: 'DAY_2_POST',
                confidence: p > PRES_HIGH_ANCHOR ? 'high' : 'medium'
            };
        }

        // ── RIDGE / STABLE_HIGH ── drift ±1.5 mb, parked > 1020 mb.
        // v0.1 split rule:
        //   • d48 small (or null) → STABLE_HIGH  — flat regime continues
        //   • d48 strongly rising → RIDGE        — just settled in post-passage
        // Both labels are valid; confidence reflects how clean the read is.
        if (abs24 <= DRIFT_MMHG && p > PRES_HIGH_ANCHOR) {
            if (d48 == null || Math.abs(d48) <= DRIFT_MMHG) {
                return { phase: 'STABLE_HIGH', confidence: d48 == null ? 'medium' : 'high' };
            }
            if (d48 > RISE_MIN_MMHG) {
                return { phase: 'RIDGE', confidence: 'medium' };
            }
            return { phase: 'STABLE_HIGH', confidence: 'medium' };
        }

        // ── SETTLED ── mid-band, small daily drift. Stable but featureless —
        // no front signal in either direction. Distinct from UNSTABLE: this
        // is a positive finding (we read the system as quiet), not a gap.
        //
        // Spec divergence note: weather-app-scoring-rules.md §2 defines 7
        // phases. We added SETTLED as an 8th on 2026-05-16 after discovering
        // that UNSTABLE was conflating "I can't read this" (a confidence gap)
        // with "the system is genuinely featureless mid-band" (a positive
        // read of a quiet week). For Bay Area May data parked at ~761 mmHg
        // with small daily drift, the old code returned UNSTABLE/medium for
        // every day and the week-detector labeled the whole week "Unsettled
        // · high" — exactly opposite the meteorological truth.
        //
        // Higher confidence when both drift AND 48h trend are tight.
        if (abs24 <= WIDE_DRIFT_MMHG && p >= PRES_MID_LOW && p <= PRES_MID_HIGH) {
            const tightDrift = abs24 <= DRIFT_MMHG;
            const tight48    = d48 == null || Math.abs(d48) <= WIDE_DRIFT_MMHG;
            const conf = (tightDrift && tight48) ? 'high' : 'medium';
            return { phase: 'SETTLED', confidence: conf };
        }

        // ── LOW_STABLE ── below mid-band, small daily drift. "Parked in a
        // weak low" — meteorologically distinct from SETTLED (mid-band) and
        // from PASSAGE (active trough). Symmetric counterpart to STABLE_HIGH:
        // STABLE_HIGH is "parked > 1020 mb"; LOW_STABLE is "parked at
        // 1010–1012 mb without active front signal."
        //
        // Spec divergence note: 9th phase. Added 2026-05-16 after
        // discovering that real Bay Area May data sits in this regime for
        // multi-day stretches without matching any of the 8 prior phases.
        // Failure mode it fixes: pressure parked at 758.5–759.0 mmHg with
        // |d24| < 1 mmHg fell through every band — including by 0.06 mmHg
        // below the SETTLED floor, well inside the model's noise floor —
        // and the renderer showed a wall of UNSURE chips for a meteorologically
        // legible regime. LOW_STABLE names that regime explicitly so the
        // renderer can tone it (warn/amber) distinctly from SETTLED's green.
        //
        // Polarity rationale: bass behavior in sustained sub-1010 mb regimes
        // is sluggish even without active fronts (overcast, diffuse light,
        // low oxygen exchange). Amber, not green.
        if (abs24 <= WIDE_DRIFT_MMHG && p >= PRES_LOW_ANCHOR && p < PRES_MID_LOW) {
            const tightDrift = abs24 <= DRIFT_MMHG;
            const tight48    = d48 == null || Math.abs(d48) <= WIDE_DRIFT_MMHG;
            const conf = (tightDrift && tight48) ? 'high' : 'medium';
            return { phase: 'LOW_STABLE', confidence: conf };
        }

        // Fallthrough — no band matched cleanly. Honest fallback.
        // UNSTABLE means "classifier can't read the system" (missing data,
        // ambiguous deltas, edge cases) — NOT "quiet week", which is now
        // SETTLED above, and NOT "weak low parked", which is LOW_STABLE.
        return { phase: 'UNSTABLE', confidence: 'low' };
    }

    function classifyAllPhases(series) {
        return series.map((day, i) => ({
            date: day.date,
            ...classifyDayPhase(series, i)
        }));
    }

    // Returns "Mon", "Tue", … from a "YYYY-MM-DD" ISO date string. Engine-
    // local (we can't reach into index.html's ptWeekday helper from here).
    // Uses noon UTC + getUTCDay() which is safe — the calendar weekday is
    // the same in every timezone for midday-UTC on a given calendar date.
    function dayShort(iso) {
        if (!iso) return '';
        const [y, m, d] = iso.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
        return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getUTCDay()];
    }

    // ── buildNarrative ───────────────────────────────────────────────────
    //
    // Generates a multi-day prose rationale from the classifier's per-day
    // output across the past window. Replaces the static phase-keyed line
    // ("Cold high just crashed in...") when the recent days tell a richer
    // story ("A front passed Fri, cooled the weekend, lifting by Mon").
    //
    // Returns a sentence string OR null. Renderer falls back to the static
    // PHASE_RATIONALE map when this returns null — so quiet/typical days
    // still get a useful one-liner, and the narrative only fires when the
    // data has something specific to say.
    //
    // Detection patterns in priority order:
    //   A — Front passed in past window + recovery in progress
    //   B — Today is PRE_FRONT after a stable stretch (front building)
    //   C — Sustained quiet across the whole window
    //   D — Notable temperature climb or drop across the window
    //
    // First match wins. Returns null if none fire (renderer falls back).
    function buildNarrative(series, dayList, todayIdx) {
        const start = Math.max(0, todayIdx - 3);
        const window = [];
        for (let i = start; i <= todayIdx; i++) {
            window.push({
                iso:          dayList[i],
                day:          dayShort(dayList[i]),
                isToday:      i === todayIdx,
                phase:        classifyDayPhase(series, i).phase,
                meanTempC:    series[i].meanTempC,
                meanPressure: series[i].meanPressure
            });
        }
        if (window.length < 2) return null;

        const today = window[window.length - 1];
        const past  = window.slice(0, -1);
        const tName = today.isToday ? 'today' : today.day;

        // ── A: front passed → recovery (or still settling) ──────────────
        // Find the MOST RECENT PASSAGE / PRE_FRONT day in the past window.
        // "Past window" excludes today on purpose — if today itself is the
        // front, that's pattern B's job.
        let frontDay = null;
        for (let i = past.length - 1; i >= 0; i--) {
            if (past[i].phase === 'PASSAGE' || past[i].phase === 'PRE_FRONT') {
                frontDay = past[i]; break;
            }
        }
        if (frontDay) {
            // Find the coolest day in the window — that's the trough of the dip.
            let minTemp = Infinity;
            for (const w of window) {
                if (w.meanTempC != null && w.meanTempC < minTemp) minTemp = w.meanTempC;
            }
            const todayTemp = today.meanTempC;
            const recovery  = (todayTemp != null && minTemp !== Infinity)
                ? todayTemp - minTemp : null;

            if (recovery != null && recovery >= 2) {
                return `A front passed ${frontDay.day}, cooled the period, lifting by ${tName}.`;
            }
            if (today.phase === 'DAY_1_POST') {
                return `Front passed ${frontDay.day} — cold high crashed in, still settling.`;
            }
            return `Front passed ${frontDay.day} — air still recovering.`;
        }

        // ── B: building toward a front ──────────────────────────────────
        if (today.phase === 'PRE_FRONT') {
            const QUIET_BEFORE = new Set(['STABLE_HIGH','SETTLED','RIDGE','DAY_2_POST']);
            const stableBefore = past.length > 0 && past.every(w => QUIET_BEFORE.has(w.phase));
            if (stableBefore) {
                const lastBefore = past[past.length - 1];
                return `Steady through ${lastBefore.day} — pressure now falling into a front.`;
            }
        }

        // ── C: sustained quiet ──────────────────────────────────────────
        const QUIET = new Set(['STABLE_HIGH','SETTLED','RIDGE','LOW_STABLE','DAY_2_POST']);
        if (window.length >= 3 && window.every(w => QUIET.has(w.phase))) {
            return `Quiet pattern through ${window.length} days — no front signal in the period.`;
        }

        // ── D: notable temperature swing ────────────────────────────────
        if (window.length >= 3) {
            const first = window[0].meanTempC;
            const last  = today.meanTempC;
            if (first != null && last != null) {
                const swing = last - first;
                if (swing >= 4) {
                    return `Temperature climbing — ${swing.toFixed(0)}°C warmer than ${window[0].day}.`;
                }
                if (swing <= -4) {
                    return `Temperature dropping — ${(-swing).toFixed(0)}°C cooler than ${window[0].day}.`;
                }
            }
        }

        return null;
    }

    // ── dailyInsights ────────────────────────────────────────────────────
    //
    // Per-card daily lens. Distinct from weeklyOutlook (forward, macro) and
    // scoreLocation (backward, micro window-of-the-week). This is the
    // "right now" view: today's phase + 72h pressure trajectory.
    //
    // Why a 3rd function instead of a flag on the existing two:
    //   • weeklyOutlook is forward-only and skews to dayList without past
    //   • scoreLocation produces a triplet of weekend windows, not a single
    //     status snapshot
    // Mixing either would corrupt their semantics. dailyInsights is the
    // third lens — see the project memory on two-lens insights architecture,
    // now extended to three.
    //
    // Inputs:
    //   data  — the internal hourly object (timestamps, pressure, ...).
    //           Should include ≥3 days of past hours (fetchWeather past_days:3
    //           or JSON sliding-window archive). With less, p72Delta degrades
    //           to null and confidence drops to 'low'.
    //   nowMs — wall-clock ms in UTC. Defaults to Date.now(). Pass for tests.
    //
    // Returns:
    //   {
    //     todayDate, phase, confidence, rationale,
    //     pressure: { now, mean, deltas: {p24,p48,p72}, trend, sparkline, unit:'mmHg' },
    //     temp:     { now, mean, deltas: {p24,p48,p72}, trend, sparkline, unit:'°C'   },
    //     wind:     { now, mean, peakGust, deltas: {p24,p48,p72}, trend, sparkline, unit:'m/s' }
    //   }
    //
    // Returns null if data is unusable (no timestamps).
    function dailyInsights(data, nowMs) {
        if (!data || !data.timestamps || !data.timestamps.length) return null;
        if (nowMs == null) nowMs = Date.now();

        // PT date for "today". data.timestamps are UTC ms.
        const todayPT = new Date(nowMs - 7 * 3600 * 1000);
        const todayISO = toISODate(todayPT);

        // Build 5-day window centered on today: [D-3, D-2, D-1, D-0, D+1].
        // Past 3 days for p72Delta + classifier history; D+1 gives the
        // classifier access to "next" for trough/peak detection.
        const dayList = [];
        for (let off = -3; off <= 1; off++) {
            const d = new Date(todayPT);
            d.setUTCDate(d.getUTCDate() + off);
            dayList.push(toISODate(d));
        }

        // Aggregate without forward-only filter (we WANT the past days).
        const series = dailyAggregate(data, dayList, null);
        const todayIdx = 3;  // dayList[3] is today
        const today    = series[todayIdx];

        // Phase classification on the centered series.
        const cls = classifyDayPhase(series, todayIdx);

        // ── Per-category trend bands ────────────────────────────────────────
        // Each metric needs its own "small enough to be noise" threshold so
        // that a 0.3°C wiggle in temperature doesn't get flagged as a trend
        // change. The pressure band reuses the classifier's own DRIFT_MMHG
        // so the chip and the delta tile arrows stay in lockstep.
        const TREND_BANDS = {
            pressure: { drift: DRIFT_MMHG,      wide: WIDE_DRIFT_MMHG },  // 1.13 / 2.25 mmHg
            temp:     { drift: 1.0,             wide: 3.0             },  // °C (diurnal swing is ~6°C, daily mean delta ~1–3°C is meaningful)
            wind:     { drift: 0.5,             wide: 1.5             }   // m/s (light → moderate boundary)
        };

        function classifyTrend(d24, band) {
            if (d24 == null) return 'steady';
            if (d24 <= -band.wide)  return 'falling-fast';
            if (d24 <= -band.drift) return 'falling';
            if (d24 >=  band.wide)  return 'rising-fast';
            if (d24 >=  band.drift) return 'rising';
            return 'steady';
        }

        // ── Per-series deltas ───────────────────────────────────────────────
        // dailyAggregate only fills p24/p48 for pressure (via meanPressure).
        // For temp + wind we need our own deltas. Generic helper.
        function deltas(field) {
            const t = series[todayIdx][field];
            const d1 = series[todayIdx - 1] ? series[todayIdx - 1][field] : null;
            const d2 = series[todayIdx - 2] ? series[todayIdx - 2][field] : null;
            const d3 = series[todayIdx - 3] ? series[todayIdx - 3][field] : null;
            return {
                p24: (t != null && d1 != null) ? t - d1 : null,
                p48: (t != null && d2 != null) ? t - d2 : null,
                p72: (t != null && d3 != null) ? t - d3 : null
            };
        }

        const pressureDeltas = deltas('meanPressure');
        const tempDeltas     = deltas('meanTempC');
        const windDeltas     = deltas('meanWindMS');

        // ── Past-72h sparklines ─────────────────────────────────────────────
        // Generic walker — pulls hourly samples in [now-72h, now]. Reads from
        // a value array on `data` by key. Temp gets a K→C conversion lambda.
        const cutoffMs = nowMs - 72 * 3600 * 1000;
        function sparklineFrom(valueKey, transform) {
            const out = [];
            const arr = data[valueKey];
            if (!arr) return out;
            for (let i = 0; i < data.timestamps.length; i++) {
                const t = data.timestamps[i];
                if (t < cutoffMs || t > nowMs) continue;
                let v = arr[i];
                if (v == null) continue;
                if (transform) v = transform(v);
                out.push({ t, v });
            }
            return out;
        }

        const pressureSpark = sparklineFrom('pressure');
        const tempSpark     = sparklineFrom('temp', kToC);
        const windSpark     = sparklineFrom('windSpeed');

        // ── Display-only sparkline: dawn(72h-ago) → dusk(today) ─────────────
        // The 72h sparkline above is the engine's source of truth — it feeds
        // latest(), peakGust (via aggregates), bounds, etc. Mutating its
        // window would shift those numbers (e.g. extending forward past nowMs
        // would make latest() return a future value).
        //
        // For the Insights view we want the chart to FRAME the natural
        // fishing day — from sunrise at the start of the 72h-ago day to
        // sunset of today — instead of slicing arbitrarily at 2 PM on both
        // ends. So we build a parallel sparkline with a wider window that
        // is purely for rendering. The renderer prefers this; the engine
        // ignores it.
        //
        // Numbers preserved by construction: nothing reads `sparklineDisplay`
        // except sparkSvg().
        const sun = data && data.sunByDate;
        function dispWindowFor() {
            if (!sun) return null;
            // PT date string for an absolute UTC ms timestamp. Same trick
            // todayPT uses above: subtract 7h then read UTC fields.
            const ptDate = (ts) => {
                const pt = new Date(ts - 7 * 3600 * 1000);
                return toISODate(pt);
            };
            const startDate = ptDate(cutoffMs);   // day containing nowMs-72h
            const endDate   = ptDate(nowMs);      // anchor day
            const startSun  = sun[startDate];
            const endSun    = sun[endDate];
            // Fall back to the strict 72h range if sun data is missing for
            // either edge — better to show the original view than to render
            // a half-extended chart.
            if (!startSun || !startSun.sunrise) return null;
            if (!endSun   || !endSun.sunset)    return null;
            return { start: startSun.sunrise, end: endSun.sunset };
        }
        const dispWin = dispWindowFor();

        // Same shape as sparklineFrom but takes an explicit [start, end].
        // Kept separate so the original stays trivially auditable — no
        // optional-param branching to muddy the "engine-truth" path.
        function displaySparklineFrom(valueKey, transform, win) {
            if (!win) return null;
            const arr = data[valueKey];
            if (!arr) return null;
            const out = [];
            for (let i = 0; i < data.timestamps.length; i++) {
                const t = data.timestamps[i];
                if (t < win.start || t > win.end) continue;
                let v = arr[i];
                if (v == null) continue;
                if (transform) v = transform(v);
                out.push({ t, v });
            }
            return out.length >= 2 ? out : null;
        }
        const pressureSparkDisp = displaySparklineFrom('pressure',  null,  dispWin);
        const tempSparkDisp     = displaySparklineFrom('temp',      kToC,  dispWin);
        const windSparkDisp     = displaySparklineFrom('windSpeed', null,  dispWin);

        // ── Full-window bounds ──────────────────────────────────────────────
        // Min/max across the ENTIRE data window (past 3d + 7d forward), not
        // just the 72h sparkline slice. This lets the renderer share a y-axis
        // across every day-tab selection — a flat Today and a Wed heatwave
        // peak end up at very different vertical positions on the same scale,
        // making "shape of the week" visually scannable just by clicking
        // through days. Returns null if the field is absent (UI then falls
        // back to local auto-scale).
        function fullBounds(valueKey, transform) {
            const arr = data[valueKey];
            if (!arr) return null;
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < arr.length; i++) {
                let v = arr[i];
                if (v == null) continue;
                if (transform) v = transform(v);
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            if (!isFinite(lo)) return null;
            return { min: lo, max: hi };
        }

        const pressureBounds = fullBounds('pressure');
        const tempBounds     = fullBounds('temp', kToC);
        // Wind sparkline shows windSpeed only, but for scale we include gusts
        // so the curve has visual headroom on gusty days without clipping.
        const windBoundsRaw  = fullBounds('windSpeed');
        const gustBoundsRaw  = fullBounds('gusts');
        const windBounds = (windBoundsRaw && gustBoundsRaw)
            ? { min: Math.min(windBoundsRaw.min, gustBoundsRaw.min),
                max: Math.max(windBoundsRaw.max, gustBoundsRaw.max) }
            : (windBoundsRaw || gustBoundsRaw);

        // "now" = most recent past-or-equal sample. If sparkline has at least
        // one point, that's the last one. Falls back to today's daily mean
        // when the past window is empty (JSON path pre-Monday).
        function latest(spark, fallbackMean) {
            return spark.length ? spark[spark.length - 1].v : fallbackMean;
        }

        // Rationale copy — two layers. Static one-liner keyed off phase is
        // the floor (always emits something useful). On top of that, we run
        // buildNarrative() across the past window to produce a multi-day
        // story when the data has one ("A front passed Fri, cooled the
        // weekend, lifting by Mon"). When the narrative fires, it replaces
        // the static line. When the days are typical, the static line takes
        // over. Designer-friendly: edit copy here, no DOM hunt.
        const PHASE_RATIONALE = {
            PRE_FRONT:   'Pressure falling — feeding window before the front.',
            PASSAGE:     'Front passing — choppy and unpredictable.',
            DAY_1_POST:  'Cold high just crashed in — bass shut down.',
            DAY_2_POST:  'Pressure stabilizing — bass starting to recover.',
            STABLE_HIGH: 'High parked overhead — classic stable regime.',
            SETTLED:     'Mid-band pressure, small drift — settled and quiet.',
            LOW_STABLE:  'Parked weak low — sluggish but no front signal.',
            RIDGE:       'Slow building ridge — improving but not yet ideal.',
            UNSTABLE:    "Pressure signal unclear — can't read the system."
        };
        const narrative = buildNarrative(series, dayList, todayIdx);
        const rationale = narrative
            || PHASE_RATIONALE[cls.phase]
            || PHASE_RATIONALE.UNSTABLE;

        return {
            todayDate:  todayISO,
            phase:      cls.phase,
            confidence: cls.confidence,
            rationale,

            pressure: {
                now:              latest(pressureSpark, today.meanPressure),
                mean:             today.meanPressure,
                deltas:           pressureDeltas,
                trend:            classifyTrend(pressureDeltas.p24, TREND_BANDS.pressure),
                sparkline:        pressureSpark,
                sparklineDisplay: pressureSparkDisp,   // dawn→dusk frame; renderer-only
                dispWindow:       dispWin,             // explicit { start, end } for chart x-axis
                bounds:           pressureBounds,
                unit:             'mmHg'
            },
            temp: {
                now:              latest(tempSpark, today.meanTempC),
                mean:             today.meanTempC,
                deltas:           tempDeltas,
                trend:            classifyTrend(tempDeltas.p24, TREND_BANDS.temp),
                sparkline:        tempSpark,
                sparklineDisplay: tempSparkDisp,
                dispWindow:       dispWin,
                bounds:           tempBounds,
                unit:             '°C'
            },
            wind: {
                now:              latest(windSpark, today.meanWindMS),
                mean:             today.meanWindMS,
                peakGust:         today.maxGustMS,
                deltas:           windDeltas,
                trend:            classifyTrend(windDeltas.p24, TREND_BANDS.wind),
                sparkline:        windSpark,
                sparklineDisplay: windSparkDisp,
                dispWindow:       dispWin,
                bounds:           windBounds,
                unit:             'm/s'
            }
        };
    }

    // ── detectWeekPattern ────────────────────────────────────────────────
    //
    // Runs across the week and emits a single meta-tag. Rules in priority
    // order, first match wins. Returns { tag, confidence, evidence }.
    function detectWeekPattern(perDay, series) {
        const phases = perDay.map(d => d.phase);
        const n = phases.length;

        const maxRunOf = (phase) => {
            let max = 0, run = 0;
            for (const p of phases) {
                if (p === phase) { run++; if (run > max) max = run; }
                else run = 0;
            }
            return max;
        };
        const maxRunWhere = (pred) => {
            let max = 0, run = 0;
            for (const d of series) {
                if (pred(d)) { run++; if (run > max) max = run; }
                else run = 0;
            }
            return max;
        };

        // ── Atmospheric river ──
        // ≥3 days with mean daily pressure < 1010 mb, OR ≥2 PRE_FRONT/PASSAGE
        // pulses without a DAY_1_POST recovery between them.
        const lowPressureDays = series.filter(d =>
            d.meanPressure != null && d.meanPressure < PRES_LOW_ANCHOR
        ).length;

        // Walk the phases, mark pulse-starts and recovery indices, then
        // check if any two adjacent pulses lack a recovery between them.
        const pulseStarts = [];
        const recoveryIdx = [];
        let inPulse = false;
        for (let k = 0; k < phases.length; k++) {
            const p = phases[k];
            if (p === 'PRE_FRONT' || p === 'PASSAGE') {
                if (!inPulse) { pulseStarts.push(k); inPulse = true; }
            } else {
                inPulse = false;
                if (p === 'DAY_1_POST') recoveryIdx.push(k);
            }
        }
        let pulsesWithoutRecovery = false;
        for (let k = 1; k < pulseStarts.length; k++) {
            const a = pulseStarts[k-1], b = pulseStarts[k];
            const hasRecovery = recoveryIdx.some(r => r > a && r < b);
            if (!hasRecovery) { pulsesWithoutRecovery = true; break; }
        }

        if (lowPressureDays >= 3 || pulsesWithoutRecovery) {
            const conf = lowPressureDays >= 4 ? 'high'
                       : lowPressureDays >= 3 ? 'medium'
                       : 'low';
            return {
                tag: 'Atmospheric river',
                confidence: conf,
                evidence: lowPressureDays >= 3
                    ? `${lowPressureDays} days with mean pressure < 1010 mb`
                    : `multiple frontal pulses with no Day-1 recovery between them`
            };
        }

        // ── Heat dome ──
        // ≥4 consecutive RIDGE days, OR pressure > 1020 mb for 4+ consecutive days.
        const ridgeRun        = maxRunOf('RIDGE');
        const highPressureRun = maxRunWhere(d => d.meanPressure != null && d.meanPressure > PRES_HIGH_ANCHOR);
        if (ridgeRun >= 4 || highPressureRun >= 4) {
            return {
                tag: 'Heat dome',
                confidence: (ridgeRun >= 5 || highPressureRun >= 5) ? 'high' : 'medium',
                evidence: ridgeRun >= 4
                    ? `${ridgeRun} consecutive Ridge days`
                    : `pressure > 1020 mb for ${highPressureRun} consecutive days`
            };
        }

        // ── Diablo event ──
        // ≥2 consecutive RIDGE + wind NE (30–70°) + temp peak > 28 °C
        // + 0 mm rain in the preceding 7 days. v0.1 only sees the forward
        // window for the rain check — flag as medium confidence accordingly.
        const totalRainInWindow = series.reduce((s, d) => s + (d.totalPrecip || 0), 0);
        let diabloRun = 0, diabloMax = 0;
        for (let k = 0; k < series.length; k++) {
            const d = series[k], p = phases[k];
            const neWind = d.meanWindDir != null && d.meanWindDir >= 30 && d.meanWindDir <= 70;
            const hot    = d.maxTempC != null && d.maxTempC > 28;
            if (p === 'RIDGE' && neWind && hot) {
                diabloRun++;
                if (diabloRun > diabloMax) diabloMax = diabloRun;
            } else {
                diabloRun = 0;
            }
        }
        if (diabloMax >= 2 && totalRainInWindow === 0) {
            return {
                tag: 'Diablo event',
                confidence: 'medium',
                evidence: `${diabloMax} consecutive Ridge days, NE wind, peaks > 28 °C, no rain in window`
            };
        }

        // ── Typical Pacific cycle ──
        // Exactly 1 clean PRE_FRONT → PASSAGE → DAY_1_POST → DAY_2_POST arc.
        let cycleCount = 0;
        for (let k = 0; k <= phases.length - 4; k++) {
            if (phases[k]   === 'PRE_FRONT'
             && phases[k+1] === 'PASSAGE'
             && phases[k+2] === 'DAY_1_POST'
             && phases[k+3] === 'DAY_2_POST') {
                cycleCount++;
            }
        }
        if (cycleCount === 1) {
            return {
                tag: 'Typical Pacific cycle',
                confidence: 'high',
                evidence: 'one clean PRE_FRONT → PASSAGE → DAY_1_POST → DAY_2_POST arc visible'
            };
        }

        // ── Settled ──
        // ≥4 SETTLED days = the system is parked in the mid-pressure band
        // with no front activity. Distinct from Unsettled below: Settled
        // means "we read it as quiet" (positive finding); Unsettled means
        // "we can't read it" (gap). Added on 2026-05-16 — see SETTLED note
        // in classifyDayPhase for context.
        const settledCount = phases.filter(p => p === 'SETTLED').length;
        if (settledCount >= 4) {
            return {
                tag: 'Settled',
                confidence: settledCount >= 6 ? 'high' : 'medium',
                evidence: `${settledCount} days mid-band with small daily drift — no front signal`
            };
        }

        // ── Unsettled ──
        // ≥4 UNSTABLE days. UNSTABLE specifically means "classifier can't
        // read the system" — missing data, ambiguous edges, or fallthrough.
        // The old "no clean 48h trend" fallback was removed: it fired on
        // genuinely quiet (Settled) weeks and was the source of the original
        // misclassification of Bay Area May data as "Unsettled · high".
        const unstableCount = phases.filter(p => p === 'UNSTABLE').length;
        if (unstableCount >= 4) {
            return {
                tag: 'Unsettled',
                confidence: unstableCount >= 5 ? 'high' : 'medium',
                evidence: `${unstableCount} days where classifier couldn't read the system`
            };
        }

        // ── Mixed (default) ──
        return {
            tag: 'Mixed',
            confidence: 'low',
            evidence: 'no week-scale pattern matched cleanly'
        };
    }

    // ── Weekly outlook: macro pattern across the forecast horizon ──────────
    //
    // Different job from scoreLocation: that one scores discrete weekend
    // windows for biology (3-day BACKWARD trend feeds the multiplier — what
    // bass have already metabolized). This one finds the WEEK-LEVEL pattern
    // across the FORWARD horizon (warming, cooling, midweek peak, front
    // passage, steady) and ranks lakes by range so the dashboard can name
    // which lake is most/least impacted by the macro pattern.
    //
    // Returns null when there isn't enough data (< 3 forward days, < 2 lakes).
    function weeklyOutlook(locationsArr, weatherDataMap, todayISO) {
        const perLake = [];

        for (const loc of locationsArr) {
            const data = weatherDataMap[loc.id];
            if (!data || !data.timestamps) continue;

            const buckets = new Map();
            for (let i = 0; i < data.timestamps.length; i++) {
                const d = new Date(data.timestamps[i]);
                const pdt = new Date(d.getTime() - 7 * 3600 * 1000);
                const iso = toISODate(pdt);
                if (iso < todayISO) continue; // forward-looking only
                if (!buckets.has(iso)) buckets.set(iso, []);
                buckets.get(iso).push(kToC(data.temp[i]));
            }

            const means = new Map();
            for (const [iso, arr] of buckets) {
                means.set(iso, arr.reduce((a, b) => a + b, 0) / arr.length);
            }
            if (means.size < 3) continue;

            let minC = Infinity, maxC = -Infinity, peakDay = null, valleyDay = null;
            for (const [iso, m] of means) {
                if (m > maxC) { maxC = m; peakDay = iso; }
                if (m < minC) { minC = m; valleyDay = iso; }
            }
            perLake.push({
                loc, minC, maxC, peakDay, valleyDay,
                range: maxC - minC,
                dayList: [...means.keys()].sort()
            });
        }

        if (perLake.length < 2) return null;

        const sorted = [...perLake].sort((a, b) => b.range - a.range);
        const mostImpacted  = sorted[0];
        const leastImpacted = sorted[sorted.length - 1];

        // Use the most-impacted lake's curve as the pattern reference — that's
        // where the macro signal shows up clearest. Other lakes have flatter
        // versions of the same shape.
        const ref       = mostImpacted;
        const dayList   = ref.dayList;
        const total     = dayList.length;
        const peakIdx   = dayList.indexOf(ref.peakDay);
        const valleyIdx = dayList.indexOf(ref.valleyDay);

        // Pattern classification.
        // "warming" = peak in last two days AND valley in first two days
        // "cooling" = mirror
        // "midweek_peak" = peak strictly interior (front buildup-and-pass)
        // "midweek_valley" = valley strictly interior (front passage proper)
        // "steady" = total range < 2°C (no macro signal)
        // "mixed" = anything else (shape doesn't fit a named pattern)
        let pattern;
        if (ref.range < 2.0) {
            pattern = 'steady';
        } else if (peakIdx >= total - 2 && valleyIdx <= 1) {
            pattern = 'warming';
        } else if (valleyIdx >= total - 2 && peakIdx <= 1) {
            pattern = 'cooling';
        } else if (peakIdx > 0 && peakIdx < total - 1) {
            pattern = 'midweek_peak';
        } else if (valleyIdx > 0 && valleyIdx < total - 1) {
            pattern = 'midweek_valley';
        } else {
            pattern = 'mixed';
        }

        // Only show the lake-impact comparison when there's real divergence.
        // If most and least are within 1°C of each other, all lakes are
        // moving together and the callout would feel forced.
        const showSpread = (mostImpacted.range - leastImpacted.range) >= 1.0;

        // Horizon-edge detection: if the peak / valley lands on the LAST day
        // of the forecast window, we can't honestly claim it's the apex —
        // the curve might still be climbing (or falling) past our data.
        // Renderer uses these flags to swap to honest copy ("through end of
        // forecast") and to mark the day name with a continuation arrow.
        const peakAtHorizon   = peakIdx   === total - 1;
        const valleyAtHorizon = valleyIdx === total - 1;

        // ── Phase classifier + week-pattern ──
        //
        // Run on the most-impacted lake (`ref`) — synoptic weather doesn't
        // differ meaningfully across Bay Area lakes ~30 miles apart, and the
        // most-impacted lake's signal is cleanest.
        //
        // Wrapped in try/catch: if any new code throws, the existing
        // temp-curve return shape is preserved (renderer keeps working).
        let phases = null, weekTag = null;
        try {
            const refData = weatherDataMap[ref.loc.id];
            if (refData && refData.timestamps) {
                const series = dailyAggregate(refData, dayList, todayISO);
                phases  = classifyAllPhases(series);
                weekTag = detectWeekPattern(phases, series);
            }
        } catch (e) {
            // Don't break the existing return shape if the new classifier
            // hits an unexpected edge case. Surface via console for debug.
            console.warn('weeklyOutlook: phase classifier failed —', e);
        }

        return {
            pattern,
            peakDay:   ref.peakDay,
            peakC:     ref.maxC,
            valleyDay: ref.valleyDay,
            valleyC:   ref.minC,
            rangeC:    ref.range,
            showSpread,
            peakAtHorizon,
            valleyAtHorizon,
            mostImpacted:  { name: mostImpacted.loc.name,  rangeC: mostImpacted.range  },
            leastImpacted: { name: leastImpacted.loc.name, rangeC: leastImpacted.range },
            dayList,
            // NEW — additive, per spec §2. Renderer can opt in gradually.
            phases,    // [{ date, phase, confidence }, ...] or null on error
            weekTag    // { tag, confidence, evidence } or null on error
        };
    }

    // ── Expose ──────────────────────────────────────────────────────────────

    const INSIGHTS = {
        scoreLocation,
        scoreAllLocations,
        weeklyOutlook,
        dailyInsights,
        getWeekend,
        // Exposed for tests + tuning:
        _internal: {
            neutralWindowQuality,
            tempTrendMultiplier,
            pressureMultiplier,
            windScore,
            rainScore,
            classifyMode,
            compassFromBearing,
            // 7-phase classifier (spec §2)
            dailyAggregate,
            classifyDayPhase,
            classifyAllPhases,
            detectWeekPattern
        }
    };

    if (typeof window !== 'undefined') window.INSIGHTS = INSIGHTS;
    if (typeof module !== 'undefined' && module.exports) module.exports = INSIGHTS;
})();
