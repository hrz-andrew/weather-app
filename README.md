# 🌊 Bay Area Weather Dashboard

A personal weather dashboard for freshwater fishing locations in the San Francisco Bay Area. Built for quick daily planning — shows temperature, wind, rain, humidity, pressure, UV index, and cloud base across a 6-day forecast window.

**Live site:** https://hrz-andrew.github.io/weather-app/

---

## Features

- **5 freshwater locations** — Belmont, Almaden Reservoir, Lake Del Valle, Uvas Reservoir, Coyote Reservoir
- **Saltwater locations** switchable from the header
- **Multiple forecast models** — ECMWF Local (daily Windy scrape), ECMWF API, GFS, NAM
- **Interactive charts** — Temperature & Rain / Wind & Gusts with per-segment color gradients
- **Data strips** — Sky conditions, UV index, precipitation, relative humidity, pressure (mmHg), all color-coded
- **Current conditions panel** — Temperature, Wind, Direction, Precip/RH, Pressure (mmHg), Cloud Base (km/m)
- **Day tabs** — navigate across the full forecast window with a shared Y-axis across cards
- **Sunrise/sunset bars** — overlaid on charts with night shading
- **Fishing stability forecast** — ranked best locations and windows per day

---

## Data Sources

| Model | Source | Notes |
|---|---|---|
| ECMWF Local | Windy.com (scraped daily) | Most accurate for Bay Area, updated once per day |
| ECMWF | Open-Meteo API | ~25 km grid, live |
| GFS | Open-Meteo API | ~13 km grid, 10-day range |
| NAM | Open-Meteo API | ~12 km grid, 84h range |

**Supplementary data** (RH, cloud base, UV index) is always fetched from Open-Meteo `best_match` regardless of the active model, since not all models expose these variables.

---

## Files

```
index.html          — the full dashboard (single-file app, no build step)
forecast-data.js    — local ECMWF data written by the daily scheduled task
SKILL.md            — instructions for the Claude scheduled scraper task
README.md           — this file
```

---

## How the Local ECMWF Model Works

A scheduled Claude task runs daily and:
1. Opens Chrome and visits each location on [Windy.com](https://www.windy.com) (ECMWF model)
2. Extracts temperature, rain, wind, gusts, wind direction, sky conditions
3. Switches to the Meteogram view and extracts pressure (inHg → mmHg)
4. Writes `forecast-data.js` to this folder
5. The dashboard reads the file on page load — no API call needed

If `forecast-data.js` is missing or older than 4 days the dashboard automatically falls back to the Open-Meteo ECMWF API.

---

## Running Locally

No build step or server required — just open `index.html` directly in a browser:

```bash
open ~/Claude/Weather\ app/index.html
```

Or visit the live GitHub Pages site.

---

## Updating the Dashboard

After making changes to `index.html`:

```bash
cd ~/Claude/Weather\ app
git add index.html
git commit -m "describe your change"
git push
```

GitHub Pages redeploys automatically within ~2 minutes.

---

## Tech Stack

- Vanilla HTML/CSS/JavaScript — no framework, no build tooling
- [Chart.js 4.4](https://www.chartjs.org/) for interactive charts
- [Open-Meteo API](https://open-meteo.com/) for live forecast data (free, no API key required)
- [Windy.com](https://www.windy.com) for ECMWF local data (scraped via Claude automation)
- Hosted on GitHub Pages
