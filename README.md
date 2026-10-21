# Observer Log

An offline, iPad-first version of the CAP Observer Mission Log kneeboard card. It runs as a
single-page web app, installs to the iPad home screen, autosaves on the device, and prints a
two-page mission log to PDF (long logs can add a continuation page).

**Live app:** https://cap-efb.github.io/app/

## What it does

- **Mission details** — mission, sortie, aircraft, callsign, base, CAP flight, sectional, grid,
  altitude/airspeed, entry/exit points, crew and radios.
- **Checkpoints** — Engine Start, Wheels Up, In Area, On Target, Out of Area, Wheels Down,
  Shut Down and Custom entries. Each tap stamps the current UTC time and carries Hobbs and
  the last position forward.
- **GPS** — Use the iPad's location to fill entry/exit points, log entries and observations.
  Optional **Auto-capture GPS** stamps every checkpoint and new observation. Accuracy is stored
  and shown on the entry.
- **Times** — the six flight times, tach start/end, computed flight time, engine run, tach and
  Hobbs used.
- **OPS status** — 30-minute checks with time, Hobbs, fuel, altimeter and an OPS-normal flag,
  plus a next-due reminder on the log tab.
- **Notes & sketch** — free text plus a graph-paper canvas that works with Apple Pencil or a
  finger, with undo and red/black pens.
- **Observations** — time, Hobbs, position and free text, with optional GPS.
- **Sign-off** — printed name, CAPID, UTC date/time and a signature pad.
- **Output** — Print / Save PDF. On iPad this builds a PDF and opens the share sheet (Save to Files or
  Print); on a computer it uses the browser print dialog. Also JSON backup/import and a flight-log CSV.
- **Offline** — a service worker caches the whole app. After the first load it works with no
  signal. Data never leaves the iPad unless you export it.

## Install on the iPad

1. Open the live URL in **Safari** on the iPad.
2. Tap **Share → Add to Home Screen**.
3. Launch it from the new icon.
4. When prompted, allow **Location** if you want GPS. (Settings → Privacy & Security →
   Location Services must be on. On a Wi-Fi-only iPad the fix comes from Wi-Fi positioning and
   may be coarse; cellular iPads have a real GPS receiver.)

The first load requires a connection so Safari can install the service worker. Everything after
that, including the sketch pad and GPS *after* permission is granted, works offline.

## Data and backups

Logs are stored in IndexedDB, with a localStorage mirror as a fallback. There is no account and
no server; nothing is uploaded. Autosave runs about half a second after each change.

Safari can evict website data after long periods of disuse. Export a JSON backup after each
mission from **Menu → Export backup**, and save the PDF to Files. The JSON backup can be
re-imported on the same or another iPad.

## Printing

**Menu → Print / Save PDF**, then choose **Save to Files** or **Print** in the share sheet. On a computer,
the browser print dialog opens. The PDF has:

1. Mission/crew/frequency block, flight times and totals, the flight log table and OPS checks.
2. Notes, sketch, observations and the certification/signature block.

The layout is tuned for US Letter portrait; a long flight log can add a continuation page.
The app uses an original propeller mark in the app and printed headers.

## Development

No build step. Serve the folder over HTTP (the service worker and GPS need a secure origin;
`localhost` counts):

```sh
cd observer-log
python3 -m http.server 4173
# open http://localhost:4173
```

On an iPad on the same network, use an HTTPS host (GitHub Pages, Netlify, Cloudflare Pages,
etc.) — plain `http://192.168.x.x` will not register the service worker or allow GPS.

### Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell, top bar, tab bar |
| `styles.css` | Screen layout, dark mode, print stylesheet |
| `app.js` | State, storage, GPS, sketch/signature, rendering, PDF builder |
| `sw.js` | Offline cache (bump `CACHE` when shipping changes) |
| `vendor/` | Bundled jsPDF + AutoTable for in-app PDF export |
| `manifest.webmanifest` | Home-screen metadata |
| `icons/` | App icons and the propeller mark |

## Deployment

`main` holds the source. The live site is served from the **`gh-pages`** branch root
(`CAP-EFB/app`), because the legacy Pages builder on `main` was unreliable after the repo move.

Edit and commit on `main`, then publish the static files:

```sh
git add .
git commit -m "Observer Log 1.2.0"
git push origin main
./deploy-pages.sh
```

The script copies `index.html`, `app.js`, `styles.css`, `sw.js`, the manifest and `icons/` to
`gh-pages` and pushes it. Pages then serves `https://cap-efb.github.io/app/`.

When you change the app, bump `CACHE` in `sw.js` (for example `observer-log-v1.1.6`) so
installed copies pick up the new files. The `deploy-pages.sh` script also copies `vendor/`.

## Trademark note

This is a personal mission-log tool, not an official Civil Air Patrol product. It is not affiliated
with or endorsed by Civil Air Patrol, Inc. CAP names and emblems are trademarks of Civil Air Patrol,
Inc.; this app uses an original propeller mark, not the CAP emblem.

PDF generation uses [jsPDF](https://github.com/parallax/jsPDF) and
[jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable), both MIT licensed.
