---
name: daily-windy-ecmwf-forecast
description: Fetch daily ECMWF forecast from Windy for Bay Area freshwater locations and save to forecast-data.js
---

You are a scheduled weather data agent. Fetch ECMWF forecast data from Windy.com for Bay Area freshwater locations and save the results to a JavaScript file that the local weather dashboard reads on open.

## Output file (write this every run, regardless of partial failures)

Canonical user path:  /Users/andrew.horuzhiy/Claude/Weather app/forecast-data.js
Write from bash via:  /sessions/nifty-funny-cannon/mnt/Weather app/forecast-data.js
(The system prompt's workspace folder path is always correct — prefer it over the hardcoded session path above.)

## Locations to fetch — process in order

| id | name               | lat     | lon       | Windy URL                                                              |
|----|--------------------|---------|-----------|------------------------------------------------------------------------|
| 1  | Belmont            | 37.504  | -122.301  | https://www.windy.com/37.504/-122.301?ecmwf,37.504,-122.301,5         |
| 2  | Almaden Reservoir  | 37.163  | -121.836  | https://www.windy.com/37.163/-121.836?ecmwf,37.163,-121.836,5         |
| 3  | Lake Del Valle     | 37.591  | -121.737  | https://www.windy.com/37.591/-121.737?ecmwf,37.591,-121.737,5         |
| 4  | Uvas Reservoir     | 37.073  | -121.701  | https://www.windy.com/37.073/-121.701?ecmwf,37.073,-121.701,5         |
| 5  | Coyote Reservoir   | 37.096  | -121.540  | https://www.windy.com/37.096/-121.540?ecmwf,37.096,-121.540,5         |

---

## Per-location steps (repeat for each location in order)

### Step 1 — Navigate
Open the location's URL in Chrome (reuse the same tab for all locations — navigate, do not open new tabs). Wait for the forecast panel to fully load (the table with temperature, rain, wind rows should be visible). Confirm the ECMWF model is active (check the bottom bar or forecast header for "ECMWF").

### Step 2 — Verify units
The forecast table must show: Temperature °C | Rain mm | Wind m/s | Gusts m/s.
If any unit is wrong, open Windy Settings (gear icon) and correct it before extracting.

### Step 3 — Extract Basic forecast data with JavaScript

Run this single script — it captures weather values **and** sky icon codes in one pass:

```javascript
const table = document.querySelector('.main-table__data-table');
const rows = [...table.querySelectorAll('tr')];

// --- Date headers (with colspan expansion) ---
const dateCells = [...rows[0].querySelectorAll('td, th')];
const dates = [];
dateCells.forEach(cell => {
    const colspan = parseInt(cell.getAttribute('colspan') || '1');
    const text = cell.textContent.trim();
    for (let i = 0; i < colspan; i++) dates.push(text);
});

// --- Time labels ---
const times = [...rows[1].querySelectorAll('td, th')].map(td => td.textContent.trim());

// --- Sky icons (row 2) — Windy pictocode filenames ---
const skyIcons = [...rows[2].querySelectorAll('td, th')].map(td => {
    const img = td.querySelector('img');
    if (!img) return null;
    const m = img.getAttribute('src').match(/\/([^/]+)\.png$/);
    return m ? m[1] : null;
});

// --- Numeric rows ---
const temp  = [...rows[3].querySelectorAll('td, th')].map(td => parseFloat(td.textContent.trim().replace('°','')) || 0);
const rain  = [...rows[4].querySelectorAll('td, th')].map(td => { const t = td.textContent.trim(); return t===''||t==='-'?0:parseFloat(t)||0; });
const wind  = [...rows[5].querySelectorAll('td, th')].map(td => { const t = td.textContent.trim(); return t===''||t==='-'?0:parseFloat(t)||0; });
const gust  = [...rows[6].querySelectorAll('td, th')].map(td => { const t = td.textContent.trim(); return t===''||t==='-'?0:parseFloat(t)||0; });

// --- Wind direction (degrees from CSS rotate) ---
const dirs = [...document.querySelectorAll('[style*="rotate"]')].map(el => {
    const m = (el.style.transform || '').match(/rotate\(([-\d.]+)deg\)/);
    return m ? Math.round(parseFloat(m[1])) : null;
}).filter(v => v !== null);

[dates.join('|'), times.join('|'), skyIcons.join('|'),
 temp.join(','), rain.join(','), wind.join(','), gust.join(','), dirs.join(',')].join('\n---\n');
```

Capture the full output. If `rows` is undefined (table not yet rendered), wait 2s and retry. If the table structure differs, adapt row indices as needed.

### Step 3b — Switch to Meteogram and extract pressure

After capturing the Basic data above, click the **Meteogram** tab (visible in the bottom navigation bar alongside "Basic", "Pollen & Air Quality", etc.). Wait for the Meteogram table to render.

Run this script to extract pressure only:

```javascript
const table = document.querySelector('table');
if (!table) throw new Error('Meteogram table not found');
const rows = [...table.querySelectorAll('tr')];
// Row 5: tr--pressure — inHg values (sparse; empty cells = unchanged)

const pressRaw = [...rows[5].querySelectorAll('td,th')].map(td => {
    const t = td.textContent.trim();
    return (t === '' || t === '--') ? null : parseFloat(t);
});

JSON.stringify({ pressRaw });
```

**Post-processing:**
- **Pressure**: values are in **inHg**. Convert to mmHg: `mmHg = round(inHg × 25.4)`. Forward-fill sparse nulls from the last known value; if no prior value exists, back-fill from the next non-null.

Store the `pressure_mmhg` array alongside the Basic data for this location.

> **Note:** Humidity (RH), cloud base, and UV index are fetched separately from the Open-Meteo API by the dashboard at load time — do **not** scrape them from Windy.

If this is **not** the last location, navigate to the next Basic URL in the same tab and repeat from Step 1.

---

### Step 4 — Parse the extracted data

From the output, map each date+time slot into the structured format below.

**Date parsing:** Windy shows dates like "Wed 22", "Thu 23". Combine with the current year and month to get YYYY-MM-DD. The first day typically starts at 8AM and has 6 slots (8AM–11PM); subsequent days have 8 slots (2AM–11PM). Times are in local PT (PDT = UTC-7, PST = UTC-8).

**Numeric row mapping (Basic tab):**
- Temperature → `temp_c` (°C, numbers)
- Rain / Precip → `rain_mm` (mm; treat blank/dash as 0)
- Wind speed → `wind_ms` (m/s)
- Gusts → `gusts_ms` (m/s)
- Wind direction → `wind_dir` (degrees from CSS-rotate; align by slot index)

**Additional fields (Meteogram tab):**
- Pressure → `pressure_mmhg` (integer mmHg, converted from inHg via × 25.4, forward-filled)

**Sky icon mapping — convert Windy pictocode → WMO code + cloud %:**

Strip the `_night_N` suffix (e.g. `"1_night_7"` → base code `1`), then look up:

| Windy code | WMO code | Cloud % | Condition |
|-----------|----------|---------|-----------|
| 1  | 0  | 5   | Clear / Sunny |
| 2  | 1  | 20  | Mostly Clear |
| 3  | 2  | 45  | Partly Cloudy |
| 4  | 3  | 75  | Mostly Cloudy |
| 5  | 3  | 90  | Overcast |
| 6  | 45 | 90  | Fog |
| 7  | 80 | 70  | Light Rain Showers |
| 8  | 81 | 80  | Rain Showers |
| 9  | 82 | 90  | Heavy Rain Showers |
| 10 | 67 | 85  | Freezing Rain |
| 11 | 85 | 75  | Light Snow Showers |
| 12 | 86 | 85  | Snow Showers |
| 13 | 82 | 90  | Hail |
| 14 | 95 | 90  | Light Thunderstorm |
| 15 | 95 | 95  | Thunderstorm |
| 16 | 99 | 100 | Heavy Thunderstorm |
| 17 | 95 | 90  | Thunderstorm with Rain |
| 18 | 51 | 75  | Light Drizzle |
| 19 | 61 | 85  | Rain / Heavy Overcast |
| 20 | 63 | 90  | Moderate Rain |
| 21 | 65 | 95  | Heavy Rain |
| 22 | 71 | 80  | Light Sleet / Snow Mix |
| 23 | 73 | 85  | Snow |
| 24 | 75 | 90  | Heavy Snow |
| 25 | 77 | 100 | Blizzard |
| 26 | 67 | 90  | Rain and Snow Mix |
| 27 | 65 | 100 | Violent Rain |

Store `wmo_code` and `cloud_pct` as parallel arrays alongside the other data.

Store the result for this location in memory. Do **not** write partial files per location.

---

## After all locations are processed

### Step 5 — Close the browser tab
After storing all location data in memory, close the tab immediately using `tabs_close_mcp`. Do this **once**, after the final location — not between locations.

### Step 6 — Write forecast-data.js

Use bash to write the file. The file must be valid JavaScript assigning to `window.FORECAST_DATA`.

Template (fill in real extracted data — all array values must be numbers or null, not strings):

```javascript
window.FORECAST_DATA = {
  "generated": "YYYY-MM-DDTHH:MM:SS-07:00",
  "source": "Windy ECMWF 9km",
  "locations": [
    {
      "id": 1,
      "name": "Belmont",
      "lat": 37.504,
      "lon": -122.301,
      "model": "ECMWF",
      "forecast": [
        {
          "date": "YYYY-MM-DD",
          "day": "Wednesday",
          "hours_pdt":    ["8AM","11AM","2PM","5PM","8PM","11PM"],
          "temp_c":        [10, 14, 16, 16, 12, 10],
          "rain_mm":       [2.2, 0.5, 0.7, 0.0, 0.0, 0.0],
          "wind_ms":       [3, 3, 2, 3, 2, 1],
          "gusts_ms":      [6, 9, 8, 8, 7, 4],
          "wind_dir":      [183, 196, 248, 283, 291, 234],
          "pressure_mmhg": [763, 763, 762, 761, 761, 762],
          "wmo_code":      [63, 61, 61, 2, 0, 0],
          "cloud_pct":     [90, 85, 85, 45, 5, 5]
        }
      ]
    }
  ]
};
```

Rules:
- Include all successfully fetched locations (skip any that failed).
- Each location has an array of day objects covering the full Windy forecast window (~6 days).
- Include all slots for every day, including past hours on the current day.
- `wmo_code` and `cloud_pct` must be included for every day; use `null` for any slot where the icon could not be parsed.
- `pressure_mmhg` must be included for every day; use `null` for any slot where the Meteogram step failed for this location.
- Write using bash heredoc to avoid quote-escaping issues:

```bash
cat > "/sessions/nifty-funny-cannon/mnt/Weather app/forecast-data.js" << 'ENDOFFILE'
<the full file content here>
ENDOFFILE
```

After writing, verify with:
```bash
wc -l "/sessions/nifty-funny-cannon/mnt/Weather app/forecast-data.js"
head -3 "/sessions/nifty-funny-cannon/mnt/Weather app/forecast-data.js"
```

---

## Error handling

- If Chrome / Claude in Chrome is unavailable: skip all browser steps, do not write the file, and exit gracefully.
- If a single location fails to load or yields no data: skip it, continue with the remaining locations, and still write forecast-data.js with the successful locations.
- If sky icon extraction fails for a location but numeric data succeeded: write `null` for all `wmo_code` / `cloud_pct` slots for that location (do not skip the location entirely).
- If the Meteogram step (Step 3b) fails for a location but Basic data succeeded: write `null` for all `pressure_mmhg` slots for that location (do not skip the location entirely).
- Never write a partial or malformed forecast-data.js — if zero locations succeeded, skip writing the file entirely.
