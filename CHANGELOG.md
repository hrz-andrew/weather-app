# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Versioning rules** (semver):
- **MAJOR** (1.x.x → 2.0.0): breaking change to the data schema, file structure, or anything that would force a reader to relearn the dashboard.
- **MINOR** (1.0.x → 1.1.0): new feature, backwards-compatible (e.g., a new chart row, a new model, a new view).
- **PATCH** (1.0.0 → 1.0.1): bug fix or tightening that doesn't change behavior intent (e.g., color tweak, spacing fix, edge-case repair).

---

## [Unreleased]

_Nothing yet — next change lands here, then graduates to a versioned section on release._

---

## [1.0.0] — 2026-05-18

First versioned release. The dashboard is feature-complete for its original purpose: helping decide when to fish Bay Area freshwater spots, with the Insights view providing the bass-behavior verdict and 72h context.

### Dashboard core

- Six location cards — 3 freshwater (Belmont, Almaden Reservoir, Lake Del Valle, Uvas, Coyote) + 3 saltwater — with Freshwater/Saltwater switcher in the header.
- 3×2 conditions grid per card: temperature, wind, wind direction, precipitation/RH, pressure, cloud base.
- Two chart tabs per card: Temp & Rain / Wind & Gusts.
- Day tabs spanning today through ~6 days out, with a global shared Y-axis across cards so peaks read at the same scale.
- Cloud base displayed in km/m (e.g. `4.9km`, `914m`) with AGL sub-label; null = clear sky.

### Models & data

- Model selector with ECMWF Local (Windy-scraped, daily), ECMWF, GFS, NAM (Open-Meteo).
- Sparse fields (UV index, relative humidity, cloud base) fetched at load time via supplementary Open-Meteo call.
- Cloud base computed via LCL formula: `(T − Td) × 400 ft/°C`.
- Pressure converted hPa → mmHg client-side, displayed with 3-zone color coding (red <750 / steel 750–768 / blue >768).
- Rate-limit handling: locations load sequentially (not `Promise.all`) plus 1.5s retry on 429.

### Insights view (two-lens architecture)

- **Weekly Outlook** (forward-looking) — bass-fishing verdict per day for the next 7 days.
- **Weekend Insights** (backward-looking) — yesterday/today/tomorrow scoring for weekend planning.
- 9-phase taxonomy per location: PRE_FRONT, COLD_FRONT, POST_FRONT, WARM_FRONT, STABLE_HIGH, BLUEBIRD, LOW_STABLE, SETTLED, UNSETTLED.
- 5-tier polarity color spectrum (bad / warn / neutral / good-mild / good) used consistently across the app — yellow ≠ neutral.

### 72h Trajectory section (new in v1.0)

- Three sparklines (pressure, temperature, wind & gust) showing the past 72 hours.
- Explicit `dispWindow` (dawn 72h ago → dusk today) drives the chart frame so it doesn't shrink when today's data caps at the current hour.
- Night-shaded bands and dashed sunrise/sunset crossings drawn from real sun times per location/date.
- 72H / 48H / 24H delta chips aligned to the day-segment bands via a 7-column CSS grid (lead, Day72H, Night, Day48H, Night, Day24H, trail).
- Arrow direction (slate) decoupled from polarity hue (5-tier) — direction and magnitude are orthogonal axes; encoding both in color would lie about drift inside the noise band.

### Daily scraper

- `daily-windy-ecmwf-forecast` skill: opens Chrome, visits 5 Windy ECMWF location URLs, extracts sky icons / temp / rain / wind / gusts / direction / pressure, writes `forecast-data.js`.
- Two Cowork scheduled tasks wired up: `windy` (on-demand) and `windy-monday` (weekly automatic).
- Manual git push workflow documented (sandbox can't access macOS Keychain for credentials).

### Infrastructure

- Git repo at `https://github.com/hrz-andrew/weather-app` with GitHub Pages serving `main`.
- Live dashboard: `https://hrz-andrew.github.io/weather-app/`.
- `.gitignore` configured for the project's secrets/temp files.

---

[Unreleased]: https://github.com/hrz-andrew/weather-app/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/hrz-andrew/weather-app/releases/tag/v1.0.0
