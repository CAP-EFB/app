# Observer Log

An offline, iPad-first version of the CAP Observer Mission Log kneeboard card. It runs as a
single-page web app, installs to the iPad home screen, autosaves on the device, and prints a
two-page mission log to PDF.

**Live app:** https://thomasvdv-cap.github.io/efb/

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
- **Output** — Print / Save PDF (two pages, includes the CAP emblem), JSON backup/import and a
  flight-log CSV.
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

**Menu → Print / Save PDF**, then choose **Save to Files** in the print preview. The PDF has:

1. Mission/crew/frequency block, flight times and totals, the flight log table and OPS checks.
2. Notes, sketch, observations and the certification/signature block.

The layout is tuned for US Letter portrait. The app also uses the CAP emblem in the printed
header.

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
| `manifest.webmanifest` | Home-screen metadata |
| `icons/` | App icons and the CAP emblem |

## Deployment

The repo is set up for GitHub Pages from the `main` branch root:

```sh
git add .
git commit -m "Observer Log 1.1"
git push origin main
```

Then in **Settings → Pages**, set the source to **Deploy from a branch → main → / (root)**.
The app appears at `https://thomasvdv-cap.github.io/efb/`.

When you change the app, bump `CACHE` in `sw.js` (for example `observer-log-v1.1.1`) so
installed copies pick up the new files.

## Trademark note

The Civil Air Patrol emblem is a trademark of Civil Air Patrol, Inc. It is included here for a
CAP member's personal mission log and is not an official CAP product. The SVG is the public-domain
US emblem from Wikimedia Commons.
