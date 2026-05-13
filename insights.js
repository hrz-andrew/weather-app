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
//   INSIGHTS.seasonBucket(date)                       → 'post_spawn' | ...
//
// Math architecture (matches the framework):
//   base       = seasonalWindowQuality(date, hour)       — Step 6
//   trend_mul  = tempTrendMultiplier(temp history)        — Step 2  (multiplicative)
//   front_mul  = pressureMultiplier(pressure trajectory)  — Step 3  (multiplicative — has veto power)
//   bonuses    = windScore + rainScore                    — Steps 4 + 5  (additive)
//   score      = clamp(base × trend_mul × front_mul + bonuses, 0, 100)
//   mode       = classifyMode(...)                        — Step 1  (derived, not scored)
//
// Multiplicative + additive is intentional: a passing front should kill an
// otherwise-perfect day (multiply by 0.2), but a windy day shouldn't single-
// handedly save a bad-season hour (it's a bonus, not a multiplier).
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
        5: { preferred: [11, 21], label: 'Friday midday–evening' },
        6: { preferred: [5,  11], label: 'Saturday morning' },
        0: { preferred: [5,  11], label: 'Sunday morning' }
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
            up_strong:  'bass move shallower, feed aggressively',
            up:         'bass move shallower, feed more aggressively',
            flat:       'pattern holds — fish where the season says',
            down:       'bass move deeper, bite softens',
            down_strong:'bite shuts down for 24–48h'
        },
        pressure: {
            pre_front:  'feeding window opens — best window of the week',
            stable:     'baseline pattern — fish where the season says',
            slow_rise:  'pressure recovering — bite improving',
            post_front: 'post-frontal — bite likely poor, skip if you can',
            fresh_front:'sharp post-front rise — toughest fishing of the season'
        },
        wind: {
            ideal:    'riffles surface, concentrates bait, oxygenates',
            light:    'riffles surface, concentrates bait',
            heavy:    'bite is on but technique is hard from shore',
            calm:     'glass kills the bite outside dawn/dusk'
        },
        rain: {
            light:    'stains water mildly, washes food in',
            heavy:    'fresh inflow — creek arms may be magic',
            heavy_winter:'cold inflow — bite suppressed'
        },
        season: {
            post_spawn_morning: 'post-spawn morning window — shallow males chasing',
            post_spawn_evening: 'post-spawn evening window — topwater hour',
            summer_dawn:        'summer dawn — only viable window before thermal cap',
            summer_dusk:        'summer dusk — only viable window before thermal cap',
            fall_feed:          'fall feed — bass loading up before winter',
            spawn:              'spawn period — sight-fishing window',
            pre_spawn:          'pre-spawn — bass staging shallow',
            wintering:          'wintering — narrow midday-only window'
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

    // Season buckets and their per-hour-of-day window quality curves.
    // Each curve is a 24-element array (hour 0-23). Numbers represent the base
    // score (0-100) a 3-hour window centered on that hour starts with.
    //
    // These curves encode Step 6 of the framework. Tune by experience.
    const SEASONS = [
        {
            name: 'wintering',
            months: [11, 12, 1, 2],
            defaultMode: 'ambush',
            // Only midday viable; water is coldest at dawn.
            curve: [
                0, 0, 0, 0, 0, 0,   //  0– 5
                5, 10, 15, 25, 40, 50,  // 6–11
                55, 50, 40, 25, 15, 10, // 12–17
                5, 5, 0, 0, 0, 0    // 18–23
            ]
        },
        {
            name: 'pre_spawn',
            months: [2, 3],
            defaultMode: 'mixed',
            // Broad daytime; lean midday-evening.
            curve: [
                0, 0, 0, 0, 5, 15,
                30, 45, 55, 60, 65, 70,
                72, 70, 65, 60, 55, 50,
                40, 30, 15, 5, 0, 0
            ]
        },
        {
            name: 'spawn',
            months: [3, 4],
            defaultMode: 'mixed',
            // Mid-morning to mid-afternoon, sight-dependent.
            curve: [
                0, 0, 0, 0, 5, 15,
                30, 45, 55, 65, 72, 75,
                75, 72, 65, 55, 45, 35,
                25, 15, 10, 5, 0, 0
            ]
        },
        {
            name: 'post_spawn',
            months: [4, 5],
            defaultMode: 'active',
            // BIMODAL: dawn + dusk peaks. Midday valley.
            // Morning peak at hour 7 (~6:30am post-dawn shallow male window).
            // Evening peak at hour 20 (~8pm "topwater hour" before May sunset).
            curve: [
                5, 5, 5, 10, 25, 50,
                78, 85, 80, 60, 45, 38,
                38, 40, 45, 50, 58, 68,
                75, 82, 85, 60, 30, 15
            ]
        },
        {
            name: 'summer',
            months: [6, 7, 8, 9],
            defaultMode: 'conditional',
            // Tight peaks dawn ±90min and dusk ±90min. Midday is brutal.
            curve: [
                5, 5, 10, 30, 60, 75,
                80, 70, 50, 25, 15, 10,
                10, 10, 10, 15, 25, 50,
                70, 75, 65, 40, 20, 10
            ]
        },
        {
            name: 'fall',
            months: [9, 10, 11],
            defaultMode: 'active',
            // Broad, mid-morning peak.
            curve: [
                5, 5, 5, 10, 25, 50,
                65, 75, 80, 80, 75, 70,
                65, 60, 55, 50, 45, 40,
                30, 20, 10, 5, 0, 0
            ]
        }
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

    // Return season bucket for a given ISO date.
    function seasonBucket(isoDate) {
        const d = parseISODate(isoDate);
        const m = d.getUTCMonth() + 1; // 1–12
        for (const s of SEASONS) {
            if (s.months.includes(m)) return s;
        }
        return SEASONS[0]; // fallback
    }

    // ── Step 6: seasonal window quality ─────────────────────────────────────

    // Score a 3-hour window centered on hourCenter (0-23) for the given date.
    // Returns 0-100. This is the BASE score before multipliers and bonuses.
    function seasonalWindowQuality(isoDate, hourCenter) {
        const s = seasonBucket(isoDate);
        // Average the curve across the 3-hour window (hourCenter-1, hourCenter, hourCenter+1).
        const hours = [(hourCenter + 23) % 24, hourCenter, (hourCenter + 1) % 24];
        const sum = hours.reduce((a, h) => a + s.curve[h], 0);
        return sum / 3;
    }

    // ── Step 2: temp-trend multiplier (uses air temp as water-temp proxy) ──

    // Returns { mul: 0.5–1.3, direction: 'up_strong'|'up'|'flat'|'down'|'down_strong', deltaC }
    //
    // We use air temp dampened ~70% as a stand-in for water temp. Water lags air
    // by 3-5 days and responds with reduced amplitude, so the 3-day air-temp
    // delta tells us about water-temp DIRECTION (which is what matters per Step 2)
    // even if it overstates magnitude. We dampen the delta we report in the
    // reason text so we're not lying to the user.
    function tempTrendMultiplier(internalData, targetIsoDate) {
        // Build a per-day mean air temp lookup from internalData.
        const dayMeans = new Map(); // isoDate → mean °C
        const buckets = new Map(); // isoDate → temps[]
        for (let i = 0; i < internalData.timestamps.length; i++) {
            const d = new Date(internalData.timestamps[i]);
            // Convert UTC → PDT (-7) for date keying (matches forecast-data.js dates)
            const pdt = new Date(d.getTime() - 7 * 3600 * 1000);
            const iso = toISODate(pdt);
            if (!buckets.has(iso)) buckets.set(iso, []);
            buckets.get(iso).push(kToC(internalData.temp[i]));
        }
        for (const [iso, arr] of buckets) {
            dayMeans.set(iso, arr.reduce((a, b) => a + b, 0) / arr.length);
        }

        // Look at the target day and the day 3 back.
        const target = parseISODate(targetIsoDate);
        const back3  = toISODate(addDays(target, -3));
        const tMean  = dayMeans.get(targetIsoDate);
        const bMean  = dayMeans.get(back3);

        // If we don't have 3 days of history yet (early in the forecast), look at
        // the earliest day we have and scale accordingly.
        let deltaC, dampened;
        if (tMean == null) return { mul: 1.0, direction: 'flat', deltaC: 0 };
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
        dampened = deltaC * 0.7; // water-temp proxy

        if (dampened > 3)   return { mul: 1.30, direction: 'up_strong',   deltaC: dampened };
        if (dampened > 1)   return { mul: 1.15, direction: 'up',          deltaC: dampened };
        if (dampened > -1)  return { mul: 1.00, direction: 'flat',        deltaC: dampened };
        if (dampened > -3)  return { mul: 0.85, direction: 'down',        deltaC: dampened };
        return                    { mul: 0.50, direction: 'down_strong', deltaC: dampened };
    }

    // ── Step 3: pressure multiplier (the veto-power one) ────────────────────

    // Returns { mul: 0.2–1.2, direction: 'pre_front'|'stable'|'slow_rise'|'post_front'|'fresh_front', delta12h }
    //
    // We look at pressure CHANGE over the 12 hours preceding the window.
    // - Falling sharply → pre-front (best)
    // - Stable          → baseline
    // - Rising sharply  → post-front (worst, often "bluebird sky" next day)
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

        if (delta < -1.5) return { mul: 1.20, direction: 'pre_front',   delta12h: delta };
        if (delta < -0.3) return { mul: 1.08, direction: 'pre_front',   delta12h: delta };
        if (delta <  0.3) return { mul: 1.00, direction: 'stable',      delta12h: delta };
        if (delta <  1.5) return { mul: 0.70, direction: 'slow_rise',   delta12h: delta };
        if (delta <  3.0) return { mul: 0.40, direction: 'post_front',  delta12h: delta };
        return                  { mul: 0.20, direction: 'fresh_front', delta12h: delta };
    }

    // ── Step 4: wind score (additive bonus) ─────────────────────────────────

    // Returns { score: -20..+15, direction: 'ideal'|'light'|'heavy'|'calm', wind_ms, compass }
    //
    // Note on tuning: penalties here are calibrated for SHORE fishing.
    // From-a-boat the curve would shift right (5–8 m/s still excellent), but
    // Andrew fishes from the bank, so 7+ m/s is where casting/standing starts
    // to fall apart — hence the steeper negative slope after that. Gusts are
    // handled separately by fishabilityMultiplier (multiplicative veto), not
    // here, because a gust-only spike shouldn't double-penalize sustained wind.
    function windScore(windMs, gusts, windDir, hourCenter) {
        const dir = compassFromBearing(windDir);
        const isLowLight = (hourCenter <= 7 || hourCenter >= 18);
        if (windMs == null) return { score: 0, direction: 'light', wind_ms: 0, compass: null };

        if (windMs >= 2 && windMs <= 5) return { score: 15, direction: 'ideal', wind_ms: windMs, compass: dir };
        if (windMs > 5  && windMs <= 7) return { score: 5,  direction: 'light', wind_ms: windMs, compass: dir };
        if (windMs > 7  && windMs <= 10) return { score: -8, direction: 'heavy', wind_ms: windMs, compass: dir };
        if (windMs > 10) return { score: -20, direction: 'heavy', wind_ms: windMs, compass: dir };
        if (windMs < 1)  return { score: isLowLight ? 0 : -8, direction: 'calm', wind_ms: windMs, compass: dir };
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

    // Sum of precip over the 48h BEFORE the window. Negative = none.
    function rainScore(internalData, windowTsIdx, seasonName) {
        const ts = internalData.timestamps;
        const r  = internalData.precip;
        const targetTs = ts[windowTsIdx];
        const fortyEightHrMs = 48 * 3600 * 1000;
        let sum = 0;
        for (let i = 0; i < windowTsIdx; i++) {
            if (ts[i] >= targetTs - fortyEightHrMs) sum += (r[i] || 0);
        }
        // Light rain (0.5–5mm): mild benefit.
        // Heavy (>15mm) in winter: cold inflow hurts.
        // Heavy in spring: creek arm magic.
        if (sum < 0.3) return { score: 0,  direction: 'none',  mm: sum };
        if (sum <= 5)  return { score: 6,  direction: 'light', mm: sum };
        if (sum <= 15) return { score: 3,  direction: 'light', mm: sum };
        if (seasonName === 'wintering' || seasonName === 'pre_spawn') {
            return { score: -3, direction: 'heavy_winter', mm: sum };
        }
        return { score: 4, direction: 'heavy', mm: sum };
    }

    // ── Step 1: mode classifier ─────────────────────────────────────────────

    // Returns 'active' or 'ambush'. Built from season default + overrides:
    //   - Pressure post-front → ambush (front trumps season)
    //   - Temp >27°C in window → ambush (thermal ceiling)
    //   - Temp <13°C in window → ambush (thermal floor)
    //   - Summer + midday → ambush; summer + dawn/dusk → active
    //   - Past anoxic start for this lake → ambush bias
    function classifyMode({ season, tempCAvg, pressureDir, hourCenter, isAnoxic }) {
        if (pressureDir === 'post_front' || pressureDir === 'fresh_front') return 'ambush';
        if (tempCAvg != null && tempCAvg > 27) return 'ambush';
        if (tempCAvg != null && tempCAvg < 13) return 'ambush';
        if (isAnoxic) return 'ambush';
        if (season.name === 'summer') {
            // Summer is conditional — dawn/dusk active, midday ambush.
            if (hourCenter >= 9 && hourCenter <= 17) return 'ambush';
            return 'active';
        }
        if (season.defaultMode === 'mixed') {
            // Pre-spawn / spawn: lean active in warmer windows.
            return (tempCAvg != null && tempCAvg >= 15) ? 'active' : 'ambush';
        }
        return season.defaultMode; // 'active' or 'ambush'
    }

    // ── Main scoring ────────────────────────────────────────────────────────

    // Score one 3-hour window centered on the given timestamp index.
    function scoreWindow(loc, internalData, idx, meta) {
        const ts = internalData.timestamps[idx];
        const date = new Date(ts);
        const pdt = new Date(date.getTime() - 7 * 3600 * 1000);
        const isoDate = toISODate(pdt);
        const hourCenter = pdt.getUTCHours();

        const season = seasonBucket(isoDate);
        const base = seasonalWindowQuality(isoDate, hourCenter);
        const tempCAvg = kToC(internalData.temp[idx]);             // window snapshot (display)
        const tempCDaily = dailyMeanTempC(internalData, isoDate);  // water-temp proxy (mode)

        const trend = tempTrendMultiplier(internalData, isoDate);
        const press = pressureMultiplier(internalData, idx);
        const wind  = windScore(internalData.windSpeed[idx], internalData.gusts[idx], internalData.windDir[idx], hourCenter);
        const rain  = rainScore(internalData, idx, season.name);
        const fish  = fishabilityMultiplier(internalData.windSpeed[idx], internalData.gusts[idx]);

        // Anoxic check: is target date past this lake's stratification start?
        const m = meta || {};
        const isAnoxic = m.anoxicStart && m.anoxicEnd &&
            isoDate >= m.anoxicStart && isoDate <= m.anoxicEnd;

        const mode = classifyMode({ season, tempCAvg: tempCDaily, pressureDir: press.direction, hourCenter, isAnoxic });

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
            reasons.push({
                rule: 'fishability',
                direction: fish.level,
                signal: label,
                why: RULE_WHYS.fishability[fish.level] || ''
            });
        }

        // Pressure — highest-leverage bass signal.
        if (press.direction !== 'stable') {
            reasons.push({
                rule: 'pressure',
                direction: press.direction,
                signal: pressureSignalText(press),
                why: RULE_WHYS.pressure[press.direction] || ''
            });
        }
        // Temp trend.
        if (trend.direction !== 'flat') {
            reasons.push({
                rule: 'temp_trend',
                direction: trend.direction,
                signal: tempSignalText(trend),
                why: RULE_WHYS.temp_trend[trend.direction] || ''
            });
        }
        // Wind — include compass action.
        if (wind.direction !== 'light' || Math.abs(wind.score) >= 5) {
            const action = wind.compass && wind.score > 0 ? ` — fish the ${wind.compass} bank` : '';
            reasons.push({
                rule: 'wind',
                direction: wind.direction,
                signal: `${windDescriptor(wind)} (${wind.wind_ms.toFixed(0)} m/s)${action}`,
                why: RULE_WHYS.wind[wind.direction] || ''
            });
        }
        // Rain — only if it moved the needle.
        if (rain.direction !== 'none' && Math.abs(rain.score) >= 3) {
            reasons.push({
                rule: 'rain',
                direction: rain.direction,
                signal: `${rain.mm.toFixed(1)}mm rain in last 48h`,
                why: RULE_WHYS.rain[rain.direction] || ''
            });
        }
        // Season context — added if no other strong signal carries the day.
        if (reasons.length < 2) {
            const seasonKey = inferSeasonKey(season.name, hourCenter);
            if (seasonKey) {
                reasons.push({
                    rule: 'season',
                    direction: seasonKey,
                    signal: humanSeasonName(season.name),
                    why: RULE_WHYS.season[seasonKey] || ''
                });
            }
        }
        // Anoxic note (mainly Almaden in late June).
        if (isAnoxic && m.notes) {
            reasons.push({
                rule: 'lake_note',
                direction: 'anoxic',
                signal: m.notes,
                why: 'lake is past summer stratification — oxygen low near surface'
            });
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

        // Trim reasons to top 3 (already in priority order).
        best.reasons = best.reasons.slice(0, 3);

        return {
            loc,
            score: best.score,
            rawScore: best.rawScore,
            mode: best.mode,
            window: best.window,
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
        const d = press.delta12h.toFixed(1);
        const sign = press.delta12h >= 0 ? '+' : '';
        if (press.direction === 'pre_front')   return `Pressure falling (${sign}${d} mmHg/12h)`;
        if (press.direction === 'post_front')  return `Pressure rising (${sign}${d} mmHg/12h) — post-front`;
        if (press.direction === 'fresh_front') return `Pressure spiking (${sign}${d} mmHg/12h) — fresh front`;
        if (press.direction === 'slow_rise')   return `Pressure recovering (${sign}${d} mmHg/12h)`;
        return `Pressure stable`;
    }

    function tempSignalText(trend) {
        const d = trend.deltaC.toFixed(1);
        const sign = trend.deltaC >= 0 ? '+' : '';
        const dir = trend.deltaC > 0 ? 'Rising' : 'Falling';
        return `${dir} 3-day temp trend (${sign}${d}°C est. water)`;
    }

    function windDescriptor(wind) {
        if (wind.direction === 'ideal') return `${wind.compass || ''} wind`.trim();
        if (wind.direction === 'calm')  return 'Glass calm';
        if (wind.direction === 'heavy') return `Strong ${wind.compass || ''} wind`.trim();
        return `Light ${wind.compass || ''} wind`.trim();
    }

    function inferSeasonKey(seasonName, hourCenter) {
        if (seasonName === 'post_spawn' && hourCenter <= 9) return 'post_spawn_morning';
        if (seasonName === 'post_spawn' && hourCenter >= 17) return 'post_spawn_evening';
        if (seasonName === 'summer' && hourCenter <= 7) return 'summer_dawn';
        if (seasonName === 'summer' && hourCenter >= 18) return 'summer_dusk';
        if (seasonName === 'fall') return 'fall_feed';
        if (seasonName === 'spawn') return 'spawn';
        if (seasonName === 'pre_spawn') return 'pre_spawn';
        if (seasonName === 'wintering') return 'wintering';
        return null;
    }

    function humanSeasonName(s) {
        return ({
            wintering: 'Wintering',
            pre_spawn: 'Pre-spawn',
            spawn: 'Spawn',
            post_spawn: 'Post-spawn',
            summer: 'Summer thermal cap',
            fall: 'Fall feed'
        })[s] || s;
    }

    // ── Expose ──────────────────────────────────────────────────────────────

    const INSIGHTS = {
        scoreLocation,
        scoreAllLocations,
        getWeekend,
        seasonBucket,
        // Exposed for tests + tuning:
        _internal: {
            seasonalWindowQuality,
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
