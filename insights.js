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
            flat:        'pattern holds — fish where the calendar says',
            down:        'bass move deeper, bite softens',
            down_strong: 'bite shuts down for 24–48h',
            sudden_drop: '24h cold front — bite shuts down for 24–48h'
        },
        pressure: {
            storm_front:     'major front incoming — bite intense but short',
            pre_front:       'pre-frontal feeding window — best window of the week',
            soft_fall:       'pressure trending down — modest signal',
            stable:          'baseline pattern — fish where the calendar says',
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
            if (direction === 'flat')                                             return 'neutral';
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

        if (dampened > 3)   return { mul: 1.30, direction: 'up_strong',   deltaC: dampened };
        if (dampened > 1.5) return { mul: 1.15, direction: 'up',          deltaC: dampened };
        if (dampened > -1.5)return { mul: 1.00, direction: 'flat',        deltaC: dampened };
        if (dampened > -3)  return { mul: 0.85, direction: 'down',        deltaC: dampened };
        return                    { mul: 0.50, direction: 'down_strong', deltaC: dampened };
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
        // Prefer the frozen Windy snapshot (set by processLocalData on the
        // local-ECMWF view) so the engine scores a single, consistent forecast.
        // For API-model views (GFS / NAM / ECMWF-API) pressure_windy is
        // undefined — fall through to the API's pressure for those.
        const p  = internalData.pressure_windy || internalData.pressure;
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

        // Pressure — highest-leverage bass signal. Always surfaced (including
        // stable), so a quiet pressure reading doesn't look like missing data
        // on the card. Framework treats stable as actionable info too:
        // "fish where the calendar says."
        pushReason('pressure', press.direction, pressureSignalText(press), RULE_WHYS.pressure[press.direction] || '');
        // Temp trend.
        if (trend.direction !== 'flat') {
            pushReason('temp_trend', trend.direction, tempSignalText(trend), RULE_WHYS.temp_trend[trend.direction] || '');
        }
        // Wind — include compass action.
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
        const d = trend.deltaC.toFixed(1);
        const sign = trend.deltaC >= 0 ? '+' : '';
        if (trend.direction === 'sudden_drop') {
            return `24h temp drop (${sign}${d}°C est. water)`;
        }
        const dir = trend.deltaC > 0 ? 'Rising' : 'Falling';
        return `${dir} 3-day temp trend (${sign}${d}°C est. water)`;
    }

    function windDescriptor(wind) {
        if (wind.direction === 'ideal')   return `${wind.compass || ''} wind`.trim();
        if (wind.direction === 'calm')    return 'Glass calm';
        if (wind.direction === 'strong')  return `Strong ${wind.compass || ''} wind`.trim();
        if (wind.direction === 'extreme') return `Extreme ${wind.compass || ''} wind`.trim();
        return `Light ${wind.compass || ''} wind`.trim();
    }

    // ── Expose ──────────────────────────────────────────────────────────────

    const INSIGHTS = {
        scoreLocation,
        scoreAllLocations,
        getWeekend,
        // Exposed for tests + tuning:
        _internal: {
            neutralWindowQuality,
            tempTrendMultiplier,
            pressureMultiplier,
            windScore,
            rainScore,
            classifyMode,
            compassFromBearing
        }
    };

    if (typeof window !== 'undefined') window.INSIGHTS = INSIGHTS;
    if (typeof module !== 'undefined' && module.exports) module.exports = INSIGHTS;
})();
