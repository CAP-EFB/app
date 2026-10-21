'use strict';

/* =========================================================================
   Observer Log — offline CAP observer mission log
   All data stays in the browser (IndexedDB with a localStorage mirror).
   ========================================================================= */

const APP_VERSION = '1.3.0';
const STATE_KEY = 'observer-log-state-v1';
const STATE_MIRROR_LIMIT = 2000000;
const DB_NAME = 'observer-log';
const DB_STORE = 'kv';

const TIME_DEFS = [
  { key: 'engineStart', label: 'Engine Start', kind: 'engine-start' },
  { key: 'wheelsUp',    label: 'Wheels Up',    kind: 'wheels-up' },
  { key: 'inArea',      label: 'In Area',      kind: 'in-area' },
  { key: 'outOfArea',   label: 'Out of Area',  kind: 'out-of-area' },
  { key: 'wheelsDown',  label: 'Wheels Down',  kind: 'wheels-down' },
  { key: 'shutDown',    label: 'Shut Down',    kind: 'shut-down' }
];

const KIND_TO_TIMEKEY = {
  'engine-start': 'engineStart',
  'wheels-up': 'wheelsUp',
  'in-area': 'inArea',
  'out-of-area': 'outOfArea',
  'wheels-down': 'wheelsDown',
  'shut-down': 'shutDown'
};

const QUICK = [
  { kind: 'engine-start', label: 'Engine Start' },
  { kind: 'wheels-up',    label: 'Wheels Up' },
  { kind: 'in-area',      label: 'In Area' },
  { kind: 'on-target',    label: 'On Target' },
  { kind: 'out-of-area',  label: 'Out of Area' },
  { kind: 'wheels-down',  label: 'Wheels Down' },
  { kind: 'shut-down',    label: 'Shut Down' },
  { kind: '',             label: 'Custom' }
];

const STANDARD_FREQS = [
  ['Flight Watch', '122.0'],
  ['Wx Briefing', '800-WX-BRIEF'],
  ['Flight Service', '122.2'],
  ['CAP Natl Ops', '888.211.1812'],
  ['Air-to-Air', '122.75 / 122.85'],
  ['CAP Ops Fax Back', '334.953.2599'],
  ['Multicom', '122.9 / 123.1'],
  ['AFRCC (missions only)', '804.764.8117']
];

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/* ---------- tiny helpers ---------- */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function deepClone(value) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur[key] == null) cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

/* ---------- time helpers ---------- */

function nowZ() {
  const d = new Date();
  return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
}

function nowMinutes() {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function normTime(value) {
  let digits = String(value == null ? '' : value).toUpperCase().replace(/[^0-9]/g, '').slice(0, 4);
  if (!digits) return '';
  if (digits.length <= 2) return digits.padStart(4, '0');
  if (digits.length === 3) return '0' + digits;
  return digits;
}

function isValidTime(value) {
  if (!/^\d{4}$/.test(value)) return false;
  const h = Number(value.slice(0, 2));
  const m = Number(value.slice(2));
  return h >= 0 && h < 24 && m >= 0 && m < 60;
}

function timeToMin(value) {
  if (!isValidTime(value)) return null;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(2));
}

function diffMin(from, to) {
  const a = timeToMin(from);
  const b = timeToMin(to);
  if (a == null || b == null) return null;
  return (b - a + 1440) % 1440;
}

function addMinutes(value, minutes) {
  const base = timeToMin(value);
  if (base == null) return '';
  const total = ((base + Number(minutes)) % 1440 + 1440) % 1440;
  return pad2(Math.floor(total / 60)) + pad2(total % 60);
}

function fmtZ(value) {
  return isValidTime(value) ? value + 'Z' : '—';
}

function fmtDuration(minutes) {
  if (minutes == null) return '—';
  if (minutes < 60) return minutes + 'm';
  return Math.floor(minutes / 60) + 'h ' + pad2(minutes % 60) + 'm';
}

function fmtDateZ(date) {
  const d = date || new Date();
  return pad2(d.getUTCDate()) + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) +
    'Z ' + MONTHS[d.getUTCMonth()] + ' ' + String(d.getUTCFullYear()).slice(-2);
}

function fmtClock(date) {
  const d = date || new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ---------- numbers / coordinates ---------- */

function num(value) {
  const n = parseFloat(String(value == null ? '' : value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function fmtDecimal(value, places) {
  if (value == null || !Number.isFinite(value)) return '';
  return value.toFixed(places == null ? 1 : places);
}

function parseCoord(raw, isLat, defaultHemisphere) {
  if (raw == null) return null;
  let s = String(raw).trim().toUpperCase();
  if (!s) return null;

  let sign = 1;
  let explicitSign = false;

  // leading hemisphere, e.g. N35 12.3
  if (/^[NSEW]/.test(s)) {
    if (s[0] === 'S' || s[0] === 'W') sign = -1;
    explicitSign = true;
    s = s.slice(1).trim();
  }
  // trailing hemisphere, e.g. 35 12.3 N
  const trailing = s.match(/([NSEW])\s*$/);
  if (trailing) {
    if (trailing[1] === 'S' || trailing[1] === 'W') sign = -1;
    else sign = 1;
    explicitSign = true;
    s = s.slice(0, trailing.index).trim();
  }

  s = s.replace(/[°º]/g, ' ').replace(/['′’]/g, ' ').replace(/["″”]/g, ' ')
       .replace(/\s+/g, ' ').trim();
  if (!s) return null;

  let deg;
  let min = 0;

  if (s.includes(' ')) {
    const parts = s.split(' ');
    deg = parseFloat(parts[0]);
    min = parseFloat(parts[1]);
    if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
    if (deg < 0) {
      sign = -1;
      explicitSign = true;
      deg = Math.abs(deg);
    }
  } else {
    const value = parseFloat(s);
    if (!Number.isFinite(value)) return null;
    if (value < 0) {
      sign = -1;
      explicitSign = true;
    }
    const intPart = String(Math.abs(value)).split('.')[0];
    if (intPart.length >= 4) {
      // aviation DDMM.mmm (e.g. 3512.345)
      deg = Math.trunc(Math.abs(value) / 100);
      min = Math.abs(value) - deg * 100;
    } else {
      deg = Math.abs(value);
    }
  }

  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  if (min < 0 || min >= 60) return null;

  if (!explicitSign && (defaultHemisphere === 'S' || defaultHemisphere === 'W')) {
    sign = -1;
  }

  const absolute = Math.abs(deg) + min / 60;
  const max = isLat ? 90 : 180;
  if (absolute > max) return null;

  return sign * absolute;
}

function parseLat(raw) {
  return parseCoord(raw, true, 'N');
}

function parseLon(raw) {
  return parseCoord(raw, false, 'W');
}

function fmtCoord(value, isLat, format) {
  if (value == null || !Number.isFinite(value)) return '';
  const hemisphere = isLat ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  const absolute = Math.abs(value);
  if (format === 'dd') return absolute.toFixed(6) + '° ' + hemisphere;
  const deg = Math.floor(absolute);
  const min = (absolute - deg) * 60;
  return deg + '° ' + min.toFixed(3).padStart(6, '0') + '′ ' + hemisphere;
}

function coordPair(latRaw, lonRaw, format) {
  const lat = parseLat(latRaw);
  const lon = parseLon(lonRaw);
  if (lat == null || lon == null) return '';
  return fmtCoord(lat, true, format) + '  ' + fmtCoord(lon, false, format);
}

/* ---------- GPS ---------- */

let lastGpsFix = null;
let gpsWarned = false;

function hhmmFromMs(ms) {
  const d = new Date(ms || Date.now());
  return pad2(d.getUTCHours()) + pad2(d.getUTCMinutes());
}

function gpsStatusText(fix) {
  return 'GPS ±' + Math.round(fix.accuracy) + ' m · ' + fmtZ(hhmmFromMs(fix.at));
}

function gpsCoordinateValue(value, isLat, format) {
  const defaultHemi = isLat ? 'N' : 'W';
  const hemisphere = isLat ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  const absolute = Math.abs(value);
  let text;

  if (format === 'dd') {
    text = absolute.toFixed(6);
  } else {
    let deg = Math.floor(absolute);
    let min = (absolute - deg) * 60;
    if (min >= 59.9995) {
      deg += 1;
      min = 0;
    }
    text = deg + ' ' + min.toFixed(3).padStart(6, '0');
  }

  // The form labels are N and W, so omit the matching hemisphere letter.
  return hemisphere === defaultHemi ? text : text + ' ' + hemisphere;
}

function requestGps(force) {
  if (!force && lastGpsFix && Date.now() - lastGpsFix.at < 30000) {
    return Promise.resolve(lastGpsFix);
  }
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) {
      reject({ code: 2, secure: true });
      return;
    }
    if (!navigator.geolocation) {
      reject({ code: 2, unsupported: true });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      position => {
        const fix = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracy: position.coords.accuracy,
          at: position.timestamp || Date.now()
        };
        lastGpsFix = fix;
        resolve(fix);
      },
      error => reject(error),
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 15000 }
    );
  });
}

function gpsErrorText(error) {
  if (error && error.secure) {
    return 'GPS needs a secure page. Use the installed home-screen app or the https address.';
  }
  if (error && error.unsupported) return 'This browser does not support location.';
  const code = error && error.code;
  if (code === 1) {
    return 'Location permission denied. Turn on Location Services for Safari or Observer Log in iPad Settings.';
  }
  if (code === 3) return 'GPS timed out. Move into the open and try again.';
  if (code === 2) return 'Location unavailable. Check that Location Services is on, then try again.';
  return 'Could not get a GPS fix.';
}

function fillCoordPair(latInput, lonInput, fix) {
  if (!latInput || !lonInput) return;
  latInput.value = gpsCoordinateValue(fix.lat, true, state.settings.coordFormat);
  lonInput.value = gpsCoordinateValue(fix.lon, false, state.settings.coordFormat);
  latInput.dispatchEvent(new Event('input', { bubbles: true }));
  lonInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function gpsBusy(button) {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Locating…';
  return () => {
    if (button.isConnected) {
      button.disabled = false;
      button.innerHTML = original;
    }
  };
}

function reportGpsError(error) {
  if (gpsWarned) return;
  gpsWarned = true;
  toast(gpsErrorText(error));
}

function applyGpsToObservation(obs, fix, card) {
  obs.lat = gpsCoordinateValue(fix.lat, true, state.settings.coordFormat);
  obs.lon = gpsCoordinateValue(fix.lon, false, state.settings.coordFormat);
  obs.gpsAccuracy = Math.round(fix.accuracy);
  obs.gpsTime = fmtZ(hhmmFromMs(fix.at));

  if (card) {
    const latInput = card.querySelector('[data-bind$=".lat"]');
    const lonInput = card.querySelector('[data-bind$=".lon"]');
    if (latInput) latInput.value = obs.lat;
    if (lonInput) lonInput.value = obs.lon;
    const status = card.querySelector('.gps-status');
    if (status) status.textContent = 'GPS ±' + obs.gpsAccuracy + ' m · ' + obs.gpsTime;
  }
}

function autoGpsEntry(entry) {
  requestGps(false)
    .then(fix => {
      entry.lat = gpsCoordinateValue(fix.lat, true, state.settings.coordFormat);
      entry.lon = gpsCoordinateValue(fix.lon, false, state.settings.coordFormat);
      entry.gpsAccuracy = Math.round(fix.accuracy);
      entry.gpsTime = fmtZ(hhmmFromMs(fix.at));
      save();
      if (activeTab === 'log' && !$('#overlay').classList.contains('show')) render();
    })
    .catch(reportGpsError);
}

function autoGpsObservation(obs) {
  requestGps(false)
    .then(fix => {
      const index = activeLog().observations.indexOf(obs);
      const card = activeTab === 'obs' ? $$('.obs')[index] : null;
      applyGpsToObservation(obs, fix, card || null);
      save();
    })
    .catch(reportGpsError);
}

/* ---------- state ---------- */

let state = null;
let activeTab = 'log';
let sheetOnClose = null;
let sketchCtl = null;
let sigCtl = null;
let saveTimer = null;
let toastTimer = null;
let saveInFlight = false;

function emptyTimes() {
  return {
    engineStart: { time: '', hobbs: '' },
    wheelsUp: { time: '', hobbs: '' },
    inArea: { time: '', hobbs: '' },
    outOfArea: { time: '', hobbs: '' },
    wheelsDown: { time: '', hobbs: '' },
    shutDown: { time: '', hobbs: '' },
    tachStart: '',
    tachEnd: ''
  };
}

function blankLog() {
  return {
    id: uid(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    mission: '',
    sortie: '',
    aircraft: '',
    callsign: '',
    base: '',
    capFlight: '',
    sectional: '',
    grid: '',
    altitude: '',
    airspeed: '',
    entry: { lat: '', lon: '' },
    exit: { lat: '', lon: '' },
    crew: { pilot: '', observer: '', ap: '', scanner: '' },
    radio: { main: '', guard: '', atis: '', ctaf: '', unicom: '', other: '' },
    navAids: [
      { ident: '', freq: '', radial: '' },
      { ident: '', freq: '', radial: '' },
      { ident: '', freq: '', radial: '' }
    ],
    entries: [],
    times: emptyTimes(),
    ops: [],
    notes: '',
    sketch: '',
    observations: [],
    signoff: { name: '', capid: '', dateTime: '', signature: '' }
  };
}

function newState() {
  const log = blankLog();
  return {
    version: 1,
    savedAt: 0,
    activeId: log.id,
    settings: {
      theme: 'auto',
      coordFormat: 'dm',
      fingerDraw: false,
      keepAwake: false,
      gpsAuto: false,
      opsInterval: 30,
      introDismissed: false
    },
    logs: [log]
  };
}

function normalizeLog(raw) {
  const base = blankLog();
  const log = Object.assign(base, raw || {});
  log.id = (raw && raw.id) || base.id;
  log.times = Object.assign(emptyTimes(), (raw && raw.times) || {});
  TIME_DEFS.forEach(def => {
    log.times[def.key] = Object.assign({ time: '', hobbs: '' }, log.times[def.key] || {});
  });
  log.entry = Object.assign({ lat: '', lon: '' }, (raw && raw.entry) || {});
  log.exit = Object.assign({ lat: '', lon: '' }, (raw && raw.exit) || {});
  log.crew = Object.assign({ pilot: '', observer: '', ap: '', scanner: '' }, (raw && raw.crew) || {});
  log.radio = Object.assign({ main: '', guard: '', atis: '', ctaf: '', unicom: '', other: '' }, (raw && raw.radio) || {});
  log.signoff = Object.assign({ name: '', capid: '', dateTime: '', signature: '' }, (raw && raw.signoff) || {});
  log.navAids = Array.isArray(raw && raw.navAids) && raw.navAids.length
    ? raw.navAids.map(n => Object.assign({ ident: '', freq: '', radial: '' }, n || {}))
    : base.navAids;
  log.entries = Array.isArray(log.entries) ? log.entries.map(e => Object.assign({
    id: uid(), kind: '', time: '', hobbs: '', lat: '', lon: '', event: '', note: '', createdAt: Date.now(),
    gpsAccuracy: null, gpsTime: ''
  }, e || {})) : [];
  log.ops = Array.isArray(log.ops) ? log.ops.map(o => Object.assign({
    id: uid(), time: '', hobbs: '', fuel: '', altimeter: '', normal: true
  }, o || {})) : [];
  log.observations = Array.isArray(log.observations) ? log.observations.map(o => {
    const merged = Object.assign({
      id: uid(), time: '', hobbs: '', lat: '', lon: '', text: '', gpsAccuracy: null, gpsTime: ''
    }, o || {});
    merged.photos = Array.isArray(merged.photos)
      ? merged.photos
          .filter(photo => photo && typeof photo.data === 'string' && photo.data.startsWith('data:image/'))
          .map(photo => ({
            id: photo.id || uid(),
            data: photo.data,
            thumb: typeof photo.thumb === 'string' && photo.thumb.startsWith('data:image/') ? photo.thumb : photo.data,
            w: Number(photo.w) || 0,
            h: Number(photo.h) || 0,
            addedAt: photo.addedAt || 0
          }))
      : [];
    return merged;
  }) : [];
  return log;
}

function normalizeState(raw) {
  const fresh = newState();
  if (!raw || !Array.isArray(raw.logs) || !raw.logs.length) return fresh;
  const normalized = {
    version: 1,
    savedAt: raw.savedAt || 0,
    activeId: raw.activeId,
    settings: Object.assign(fresh.settings, raw.settings || {}),
    logs: raw.logs.map(normalizeLog)
  };
  if (!normalized.logs.some(l => l.id === normalized.activeId)) {
    normalized.activeId = normalized.logs[0].id;
  }
  return normalized;
}

function activeLog() {
  if (!state) return blankLog();
  let log = state.logs.find(l => l.id === state.activeId);
  if (!log) {
    log = state.logs[0];
    state.activeId = log.id;
  }
  return log;
}

/* ---------- persistence ---------- */

let dbPromise = null;

function openDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise(resolve => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch (_) {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

async function readState() {
  let fromLocal = null;
  let fromDb = null;

  // localStorage is synchronous and the most reliable mirror; read it first.
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.logs)) fromLocal = parsed;
    }
  } catch (err) {
    console.warn('localStorage read failed', err);
  }

  try {
    const db = await openDb();
    if (db) {
      const stored = await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const req = tx.objectStore(DB_STORE).get('state');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (stored) {
        const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
        if (parsed && Array.isArray(parsed.logs)) fromDb = parsed;
      }
    }
  } catch (err) {
    console.warn('IndexedDB read failed', err);
  }

  if (fromLocal && fromDb) {
    const localTime = fromLocal.savedAt || fromLocal.updatedAt || 0;
    const dbTime = fromDb.savedAt || fromDb.updatedAt || 0;
    return localTime >= dbTime ? fromLocal : fromDb;
  }
  return fromLocal || fromDb;
}

async function writeState() {
  const json = JSON.stringify(state);
  let ok = true;

  try {
    const db = await openDb();
    if (db) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(json, 'state');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } else if (json.length > STATE_MIRROR_LIMIT) {
      ok = false;
    }
  } catch (err) {
    console.warn('IndexedDB write failed', err);
    ok = false;
  }

  // Photos and sketches can push the state past the small localStorage quota.
  // IndexedDB is the primary store; skip the mirror rather than filling it up.
  try {
    if (json.length <= STATE_MIRROR_LIMIT) localStorage.setItem(STATE_KEY, json);
    else localStorage.removeItem(STATE_KEY);
  } catch (err) {
    if (!(err && err.name === 'QuotaExceededError')) console.warn('localStorage write failed', err);
  }

  return ok;
}

function mirrorState() {
  try {
    const json = JSON.stringify(state);
    if (json.length <= STATE_MIRROR_LIMIT) localStorage.setItem(STATE_KEY, json);
    else localStorage.removeItem(STATE_KEY);
  } catch (_) { /* ignore */ }
}

function setSaveStatus(kind, text) {
  const dot = $('#saveDot');
  const label = $('#saveLabel');
  if (dot) dot.className = 'save-dot' + (kind === 'saving' ? ' saving' : kind === 'error' ? ' error' : '');
  if (label) label.textContent = text;
}

function save() {
  if (!state) return;
  state.updatedAt = Date.now();
  state.savedAt = Date.now();
  activeLog().updatedAt = Date.now();
  setSaveStatus('saving', 'Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (saveInFlight) return;
    saveInFlight = true;
    try {
      const ok = await writeState();
      if (ok) setSaveStatus('saved', 'Saved ' + fmtClock());
      else setSaveStatus('error', 'Save trouble — export a backup');
    } catch (err) {
      console.warn(err);
      setSaveStatus('error', 'Save trouble — export a backup');
    } finally {
      saveInFlight = false;
    }
  }, 420);
}

/* ---------- theme / wake lock ---------- */

let wakeLock = null;

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme() {
  const theme = (state && state.settings.theme) || 'auto';
  const dark = theme === 'dark' || (theme === 'auto' && systemPrefersDark());

  if (theme === 'auto') {
    if (dark) document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0a1118' : '#edf1f6');

  document.body.classList.toggle('finger-draw', !!(state && state.settings.fingerDraw));
}

async function syncWakeLock() {
  const wanted = !!(state && state.settings.keepAwake);
  if (!wanted) {
    if (wakeLock) {
      try { await wakeLock.release(); } catch (_) { /* ignore */ }
      wakeLock = null;
    }
    return;
  }
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) {
    wakeLock = null;
  }
}

/* ---------- toast ---------- */

function toast(message, actionLabel, action) {
  const el = $('#toast');
  if (!el) return;
  el.innerHTML = '<span>' + esc(message) + '</span>' +
    (actionLabel ? '<button type="button" id="toastAction">' + esc(actionLabel) + '</button>' : '');
  el.classList.add('show');
  if (actionLabel) {
    const btn = $('#toastAction');
    if (btn) btn.onclick = () => {
      el.classList.remove('show');
      if (typeof action === 'function') action();
    };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), actionLabel ? 6000 : 2600);
}

/* ---------- derived values ---------- */

function lastHobbs(log) {
  const l = log || activeLog();
  for (let i = l.entries.length - 1; i >= 0; i--) {
    if (l.entries[i].hobbs) return l.entries[i].hobbs;
  }
  if (l.times.shutDown.hobbs) return l.times.shutDown.hobbs;
  if (l.times.engineStart.hobbs) return l.times.engineStart.hobbs;
  if (l.times.tachEnd) return l.times.tachEnd;
  return '';
}

function lastPosition(log) {
  const l = log || activeLog();
  for (let i = l.entries.length - 1; i >= 0; i--) {
    const e = l.entries[i];
    if (e.lat || e.lon) return { lat: e.lat || '', lon: e.lon || '' };
  }
  return { lat: '', lon: '' };
}

function timeTotals(log) {
  const l = log || activeLog();
  const engine = diffMin(l.times.engineStart.time, l.times.shutDown.time);
  const flight = diffMin(l.times.wheelsUp.time, l.times.wheelsDown.time);
  const tachA = num(l.times.tachStart);
  const tachB = num(l.times.tachEnd);
  const tach = tachA != null && tachB != null ? tachB - tachA : null;
  const hobbsA = num(l.times.engineStart.hobbs);
  const hobbsB = num(l.times.shutDown.hobbs);
  const hobbs = hobbsA != null && hobbsB != null ? hobbsB - hobbsA : null;
  return { engine, flight, tach, hobbs };
}

function nextOpsDue(log) {
  const l = log || activeLog();
  const last = l.ops[l.ops.length - 1];
  if (!last || !isValidTime(last.time)) return '';
  return addMinutes(last.time, state.settings.opsInterval || 30);
}

function entryForKind(log, kind) {
  if (!kind) return null;
  return log.entries.find(e => e.kind === kind) || null;
}

function syncLinkedTime(key, field, value) {
  const log = activeLog();
  const def = TIME_DEFS.find(d => d.key === key);
  if (!def) return;
  const entry = entryForKind(log, def.kind);
  if (entry) entry[field] = value;
}

function fmtEntryPosition(entry) {
  return coordPair(entry.lat, entry.lon, state.settings.coordFormat);
}

/* =========================================================================
   Rendering
   ========================================================================= */

function renderStrip() {
  const log = activeLog();
  const main = $('#stripMain');
  const sub = $('#stripSub');
  if (!main || !sub) return;

  const bits = [];
  bits.push(log.mission ? log.mission : 'Untitled mission');
  if (log.sortie) bits.push('Sortie ' + log.sortie);
  if (log.aircraft) bits.push(log.aircraft);
  main.textContent = bits.join('  ·  ');

  const crew = [];
  if (log.crew.pilot) crew.push('P ' + log.crew.pilot);
  if (log.crew.observer) crew.push('O ' + log.crew.observer);
  if (log.crew.ap) crew.push('AP ' + log.crew.ap);
  if (log.crew.scanner) crew.push('S ' + log.crew.scanner);
  sub.textContent = crew.length ? crew.join('  ·  ') : 'Tap to add mission, crew & entry point';
}

function renderTabbar() {
  $$('#tabbar .tab').forEach(btn => {
    const on = btn.dataset.tab === activeTab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function render() {
  if (!state) return;
  renderStrip();
  renderTabbar();
  const view = $('#view');
  if (!view) return;
  const log = activeLog();

  if (activeTab === 'log') view.innerHTML = logView(log);
  else if (activeTab === 'times') view.innerHTML = timesView(log);
  else if (activeTab === 'obs') view.innerHTML = obsView(log);
  else if (activeTab === 'notes') view.innerHTML = notesView(log);

  updateOutputs();

  if (activeTab === 'notes') {
    setupSketch();
    setupSignature();
    autoGrowAll();
  }
  if (activeTab === 'obs') {
    autoGrowAll();
  }
}

function introHTML() {
  return `
    <div class="intro">
      <div class="intro-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3v18M5 8.5 12 3l7 5.5"/><path d="M7.5 21h9"/>
        </svg>
      </div>
      <div>
        <h3>Ready for the sortie</h3>
        <p>Start with the mission details, then tap a checkpoint as each one happens. Everything autosaves on this iPad and works with no signal.</p>
        <div class="btn-row">
          <button class="btn small primary" data-act="edit-mission">Mission details</button>
          <button class="btn small" data-act="dismiss-intro">Got it</button>
        </div>
      </div>
    </div>`;
}

function opsBanner(log) {
  const last = log.ops[log.ops.length - 1];
  if (!last) {
    return `<button class="status-banner none" data-act="tab" data-tab="times">
      <span class="sb-dot"></span>
      <span>No OPS checks yet — <strong>record the first one</strong></span>
    </button>`;
  }

  const next = nextOpsDue(log);
  const interval = state.settings.opsInterval || 30;
  const since = last.time ? (nowMinutes() - timeToMin(last.time) + 1440) % 1440 : null;
  const live = since != null && since < 480;
  const overdue = live && since > interval + 4;

  if (overdue) {
    return `<button class="status-banner due" data-act="tab" data-tab="times">
      <span class="sb-dot"></span>
      <span><strong>OPS check due</strong> — last was ${fmtZ(last.time)} (${fmtDuration(since)} ago)</span>
    </button>`;
  }

  return `<button class="status-banner ok" data-act="tab" data-tab="times">
    <span class="sb-dot"></span>
    <span><strong>OPS ${last.normal ? 'normal' : 'flagged'}</strong> at ${fmtZ(last.time)}${next ? ' · next ' + fmtZ(next) : ''} · ${log.ops.length} check${log.ops.length === 1 ? '' : 's'}</span>
  </button>`;
}

function quickButton(log, item) {
  const entry = item.kind ? entryForKind(log, item.kind) : null;
  const done = !!(entry && entry.time);
  const cls = 'quick' + (done ? ' done' : '') + (item.kind ? '' : ' custom');
  return `<button type="button" class="${cls}" data-act="quick" data-kind="${esc(item.kind)}" data-label="${esc(item.label)}">
    <span class="quick-label">${esc(item.label)}</span>
    <span class="quick-time mono">${done ? fmtZ(entry.time) : (item.kind ? 'Tap to log' : 'New entry')}</span>
  </button>`;
}

function entriesHTML(log) {
  if (!log.entries.length) {
    return `<div class="empty"><strong>No log entries yet</strong>Checkpoints you tap above appear here.</div>`;
  }
  let previous = null;
  const rows = log.entries.map(entry => {
    const delta = previous && previous.time && entry.time ? diffMin(previous.time, entry.time) : null;
    previous = entry;
    const pos = fmtEntryPosition(entry);
    const bits = [];
    if (entry.hobbs) bits.push('Hobbs ' + esc(entry.hobbs));
    if (pos) bits.push(esc(pos));
    if (entry.gpsAccuracy) bits.push('GPS ±' + esc(entry.gpsAccuracy) + ' m');
    if (delta != null && delta > 0) bits.push('<span class="entry-delta">+' + delta + 'm</span>');
    return `<div class="entry-row" data-act="edit-entry" data-id="${esc(entry.id)}" role="button" tabindex="0">
      <div class="entry-time mono">${entry.time ? esc(fmtZ(entry.time)) : '—'}</div>
      <div>
        <div class="entry-title">${esc(entry.event || 'Log entry')}${entry.kind ? '<span class="tag">checkpoint</span>' : ''}</div>
        ${bits.length ? '<div class="entry-sub">' + bits.join(' <span class="muted">·</span> ') + '</div>' : ''}
        ${entry.note ? '<div class="entry-note">' + esc(entry.note) + '</div>' : ''}
      </div>
      <button type="button" class="row-del" data-act="del-entry" data-id="${esc(entry.id)}" aria-label="Delete entry">×</button>
    </div>`;
  }).join('');

  return '<div class="entry-list">' + rows + '</div>';
}

function logView(log) {
  const showIntro = !state.settings.introDismissed && !log.mission && !log.entries.length;
  return `<div class="stack">
    ${showIntro ? introHTML() : ''}
    ${opsBanner(log)}
    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Checkpoints</h2></div>
        <span class="muted small">Tap to stamp UTC</span>
      </div>
      <div class="quick-grid">${QUICK.map(q => quickButton(log, q)).join('')}</div>
      <button type="button" class="btn soft wide gps-mark" data-act="mark-position">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
        Mark current position
      </button>
      <div class="gps-hint">${state.settings.gpsAuto ? 'Auto GPS is on — checkpoints and observations capture a position.' : 'Uses the iPad’s GPS to fill latitude and longitude. Tap a checkpoint to log it, or mark a position here.'}</div>
    </section>
    <section class="card">
      <div class="card-head">
        <div class="head-left">
          <h2>Flight log</h2>
          <span class="count-badge">${log.entries.length}</span>
        </div>
        <button class="btn small" data-act="add-entry">+ Entry</button>
      </div>
      ${entriesHTML(log)}
    </section>
  </div>`;
}

function timeRowHTML(log, def) {
  const value = log.times[def.key] || { time: '', hobbs: '' };
  const path = 'times.' + def.key;
  return `<div class="trow">
    <div class="tlabel">${esc(def.label)}</div>
    <div class="tfield">
      <input class="input time mono" data-bind="${path}.time" data-norm="time" inputmode="numeric" maxlength="4"
        value="${esc(value.time)}" placeholder="HHMM" aria-label="${esc(def.label)} time (UTC)">
      <button type="button" class="mini" data-act="fill-now" data-target="#t-${def.key}">Now</button>
    </div>
    <div class="tfield">
      <input class="input hobbs mono" id="t-${def.key}" data-bind="${path}.hobbs" data-norm="hobbs" inputmode="decimal"
        value="${esc(value.hobbs)}" placeholder="Hobbs" aria-label="${esc(def.label)} Hobbs">
    </div>
  </div>`;
}

function opsRowHTML(log, op, index) {
  return `<div class="ops-row">
    <div class="ops-top">
      <span class="ops-index">Check ${index + 1}</span>
      <span class="muted small mono">${op.time ? esc(fmtZ(op.time)) : ''}</span>
      <span style="flex:1"></span>
      <button type="button" class="toggle ${op.normal ? 'on' : ''}" data-act="toggle-ops" data-id="${esc(op.id)}">
        <span class="tick">✓</span> OPS normal
      </button>
      <button type="button" class="row-del" data-act="del-ops" data-id="${esc(op.id)}" aria-label="Delete OPS check">×</button>
    </div>
    <div class="ops-fields">
      <input class="input mono centered" data-bind="ops.${index}.time" data-norm="time" inputmode="numeric" maxlength="4"
        value="${esc(op.time)}" placeholder="Time" aria-label="OPS time">
      <input class="input mono centered" data-bind="ops.${index}.hobbs" data-norm="hobbs" inputmode="decimal"
        value="${esc(op.hobbs)}" placeholder="Hobbs" aria-label="OPS Hobbs">
      <input class="input" data-bind="ops.${index}.fuel" value="${esc(op.fuel)}" placeholder="Fuel" aria-label="Fuel">
      <input class="input mono centered" data-bind="ops.${index}.altimeter" inputmode="numeric"
        value="${esc(op.altimeter)}" placeholder="Altimeter" aria-label="Altimeter">
    </div>
  </div>`;
}

function timesView(log) {
  const totals = timeTotals(log);
  const ops = log.ops.map((op, i) => opsRowHTML(log, op, i)).reverse().join('');
  const navRows = log.navAids.map((nav, i) => `<div class="nav-row">
    <span class="num">${i + 1}</span>
    <input class="input" data-bind="navAids.${i}.ident" value="${esc(nav.ident)}" placeholder="Identifier" autocapitalize="characters" aria-label="Nav aid ${i + 1} identifier">
    <input class="input mono" data-bind="navAids.${i}.freq" value="${esc(nav.freq)}" placeholder="Frequency" inputmode="decimal" aria-label="Nav aid ${i + 1} frequency">
    <input class="input mono radial" data-bind="navAids.${i}.radial" value="${esc(nav.radial)}" placeholder="Radial" inputmode="numeric" aria-label="Nav aid ${i + 1} radial">
    <button type="button" class="row-del" data-act="del-navaid" data-index="${i}" aria-label="Delete nav aid">×</button>
  </div>`).join('');

  return `<div class="stack">
    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Flight times</h2></div>
        <span class="muted small">UTC</span>
      </div>
      ${TIME_DEFS.map(def => timeRowHTML(log, def)).join('')}
      <div class="totals">
        <div class="total"><div class="tl">Wheels up → down</div><div class="tv" id="tot-flight">${fmtDuration(totals.flight)}</div></div>
        <div class="total"><div class="tl">Engine start → shut</div><div class="tv" id="tot-engine">${fmtDuration(totals.engine)}</div></div>
        <div class="total"><div class="tl">Tach</div><div class="tv" id="tot-tach">${totals.tach == null ? '—' : fmtDecimal(totals.tach, 1)}</div></div>
        <div class="total"><div class="tl">Hobbs used</div><div class="tv" id="tot-hobbs">${totals.hobbs == null ? '—' : fmtDecimal(totals.hobbs, 1)}</div></div>
      </div>
      <div class="note-strip">The Now buttons stamp the current UTC time. Editing a time also updates the matching checkpoint in the flight log.</div>
    </section>

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Tach &amp; totals</h2></div>
      </div>
      <div class="form-grid">
        <label class="field"><span>Tach start</span>
          <input class="input mono" data-bind="times.tachStart" data-norm="hobbs" inputmode="decimal" value="${esc(log.times.tachStart)}" placeholder="e.g. 5123.4">
        </label>
        <label class="field"><span>Tach end</span>
          <input class="input mono" data-bind="times.tachEnd" data-norm="hobbs" inputmode="decimal" value="${esc(log.times.tachEnd)}" placeholder="e.g. 5124.7">
        </label>
      </div>
      <div class="totals" style="grid-template-columns:1fr 1fr">
        <div class="total"><div class="tl">Total tach</div><div class="tv" id="tach-card-total">${totals.tach == null ? '—' : fmtDecimal(totals.tach, 1)}</div></div>
        <div class="total"><div class="tl">Shut-down Hobbs</div><div class="tv" id="tach-card-hobbs">${log.times.shutDown.hobbs ? esc(log.times.shutDown.hobbs) : '—'}</div></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>OPS status</h2><span class="count-badge">${log.ops.length}</span></div>
        <button class="btn small primary" data-act="ops-add">+ Record check</button>
      </div>
      <div class="note-strip" style="margin-top:0;margin-bottom:12px">
        Every ${state.settings.opsInterval || 30} minutes${nextOpsDue(log) ? ' · next due ' + fmtZ(nextOpsDue(log)) : ''}. Fuel and altimeter carry forward from the previous check.
      </div>
      <div class="ops-list">
        ${ops || '<div class="empty"><strong>No OPS checks</strong>Tap “Record check” every 30 minutes.</div>'}
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Nav aids</h2></div>
        <button class="btn small" data-act="add-navaid">+ Row</button>
      </div>
      <div class="nav-grid">${navRows}</div>
    </section>

    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Frequencies</h2></div></div>
      <div class="form-grid">
        <label class="field"><span>Main</span><input class="input mono" data-bind="radio.main" value="${esc(log.radio.main)}" placeholder="e.g. 123.45"></label>
        <label class="field"><span>Guard</span><input class="input mono" data-bind="radio.guard" value="${esc(log.radio.guard)}" placeholder="121.5"></label>
        <label class="field"><span>ATIS / AWOS</span><input class="input mono" data-bind="radio.atis" value="${esc(log.radio.atis)}"></label>
        <label class="field"><span>CTAF</span><input class="input mono" data-bind="radio.ctaf" value="${esc(log.radio.ctaf)}"></label>
        <label class="field"><span>Unicom</span><input class="input mono" data-bind="radio.unicom" value="${esc(log.radio.unicom)}"></label>
        <label class="field"><span>Other</span><input class="input mono" data-bind="radio.other" value="${esc(log.radio.other)}"></label>
      </div>
      <div class="subhead">Standard</div>
      <div class="freq-list">
        ${STANDARD_FREQS.map(([label, value]) => `<div class="freq-row"><span class="fl">${esc(label)}</span><span class="fv">${esc(value)}</span></div>`).join('')}
      </div>
    </section>
  </div>`;
}

function obsCardHTML(log, obs, index) {
  const photos = Array.isArray(obs.photos) ? obs.photos : [];
  return `<article class="obs">
    <div class="obs-head">
      <span class="badge">Obs ${index + 1}</span>
      <span class="obs-time mono">${obs.time ? esc(fmtZ(obs.time)) : ''}</span>
      ${photos.length ? `<span class="obs-time">${photos.length} photo${photos.length === 1 ? '' : 's'}</span>` : ''}
      <span class="spacer"></span>
      <button type="button" class="row-del" data-act="del-obs" data-id="${esc(obs.id)}" aria-label="Delete observation">×</button>
    </div>
    <div class="obs-fields">
      <input class="input mono centered" data-bind="observations.${index}.time" data-norm="time" inputmode="numeric" maxlength="4"
        value="${esc(obs.time)}" placeholder="Time" aria-label="Observation time">
      <input class="input mono centered" data-bind="observations.${index}.hobbs" data-norm="hobbs" inputmode="decimal"
        value="${esc(obs.hobbs)}" placeholder="Hobbs" aria-label="Observation Hobbs">
      <input class="input mono" data-bind="observations.${index}.lat" data-coord="lat"
        value="${esc(obs.lat)}" placeholder="Latitude N" aria-label="Observation latitude">
      <input class="input mono" data-bind="observations.${index}.lon" data-coord="lon"
        value="${esc(obs.lon)}" placeholder="Longitude W" aria-label="Observation longitude">
    </div>
    <div class="gps-row">
      <button type="button" class="mini gps-mini" data-act="gps-obs" data-id="${esc(obs.id)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
        Use GPS
      </button>
      <span class="gps-status">${obs.gpsAccuracy ? 'GPS ±' + esc(obs.gpsAccuracy) + ' m · ' + esc(obs.gpsTime || '') : ''}</span>
    </div>
    <textarea class="input obs-text" data-bind="observations.${index}.text" data-autogrow
      placeholder="What did you see? Include altitude, heading, and anything distinctive.">${esc(obs.text)}</textarea>
    <div class="obs-photos">
      ${photos.map((photo, photoIndex) => `<button type="button" class="obs-photo" data-act="view-photo" data-obs="${esc(obs.id)}" data-index="${photoIndex}" aria-label="View observation photo ${photoIndex + 1}">
        <img src="${esc(photo.thumb || photo.data)}" alt="">
      </button>`).join('')}
      ${photos.length < MAX_OBS_PHOTOS ? `<button type="button" class="obs-photo add" data-act="add-photo" data-obs="${esc(obs.id)}">
        ${PHOTO_ICON}
        <span>Photo</span>
      </button>` : ''}
    </div>
  </article>`;
}

function obsView(log) {
  const list = log.observations.map((obs, i) => obsCardHTML(log, obs, i)).join('');
  return `<div class="stack">
    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Observations</h2><span class="count-badge">${log.observations.length}</span></div>
        <button class="btn small primary" data-act="add-obs">+ New</button>
      </div>
      ${list || `<div class="empty"><strong>No observations yet</strong>Tap “New” after each sighting. Time, Hobbs and position are filled in for you.</div>`}
    </section>
  </div>`;
}

function signoffHTML(log) {
  return `<section class="card">
    <div class="card-head">
      <div class="head-left"><h2>Sign-off</h2></div>
      <button class="btn small" data-act="sign-now">Now (UTC)</button>
    </div>
    <div class="form-grid">
      <label class="field"><span>Printed name</span>
        <input class="input" data-bind="signoff.name" value="${esc(log.signoff.name)}" autocomplete="name">
      </label>
      <label class="field"><span>CAPID</span>
        <input class="input mono" data-bind="signoff.capid" value="${esc(log.signoff.capid)}" inputmode="numeric" autocapitalize="characters">
      </label>
      <label class="field span-2"><span>Date time — DDhhmmZ MMM YY</span>
        <input class="input mono" data-bind="signoff.dateTime" value="${esc(log.signoff.dateTime)}" placeholder="${esc(fmtDateZ(new Date()))}">
      </label>
    </div>
    <div class="sig-wrap"><canvas id="signature" width="1000" height="240" aria-label="Signature pad"></canvas></div>
    <div class="btn-row" style="margin-top:9px">
      <button class="btn small" data-act="clear-sign">Clear signature</button>
    </div>
    <div class="sketch-hint">Sign with a finger or Apple Pencil. The signature is stored only on this device and appears on the printed log.</div>
  </section>`;
}

function notesView(log) {
  return `<div class="stack">
    <section class="card">
      <div class="card-head"><div class="head-left"><h2>Notes</h2></div></div>
      <textarea class="input notes-area" data-bind="notes" data-autogrow
        placeholder="Narrative notes, radio traffic, coordination, anything that does not fit elsewhere.">${esc(log.notes)}</textarea>
    </section>

    <section class="card">
      <div class="card-head">
        <div class="head-left"><h2>Sketch pad</h2></div>
        <div class="sketch-tools">
          <button type="button" class="swatch active" data-act="pen" data-color="#17222e" aria-label="Black pen" title="Black pen"></button>
          <button type="button" class="swatch red" data-act="pen" data-color="#b3261e" aria-label="Red pen" title="Red pen"></button>
          <button type="button" class="swatch eraser" data-act="eraser" aria-label="Eraser" title="Eraser">⌫</button>
          <button type="button" class="mini" data-act="undo-sketch">Undo</button>
          <button type="button" class="mini" data-act="clear-sketch">Clear</button>
        </div>
      </div>
      <div class="sketch-mode">
        <span class="sketch-mode-label">Draw with</span>
        <div class="seg">
          <button type="button" data-act="set-finger-mode" data-value="0" class="${state.settings.fingerDraw ? '' : 'active'}">Apple Pencil</button>
          <button type="button" data-act="set-finger-mode" data-value="1" class="${state.settings.fingerDraw ? 'active' : ''}">Finger</button>
        </div>
        <span class="sketch-mode-note">${state.settings.fingerDraw ? 'Finger draws. Switch to Pencil to scroll.' : 'Pencil draws. A finger scrolls the page.'}</span>
      </div>
      <div class="canvas-wrap">
        <canvas id="sketch" width="1000" height="1250" aria-label="Sketch pad"></canvas>
        ${!state.settings.fingerDraw && !log.sketch ? '<div class="canvas-tip">Using a finger? Choose <strong>Finger</strong> above.</div>' : ''}
      </div>
      <div class="sketch-hint">
        ${state.settings.fingerDraw
          ? 'A finger or Apple Pencil draws. Switch to Apple Pencil mode when you want a finger to scroll the page.'
          : 'Apple Pencil draws. A finger scrolls the page. Choose Finger to sketch with a finger.'}
        Sketches save automatically.
      </div>
    </section>

    ${signoffHTML(log)}
  </div>`;
}

/* ---------- targeted output updates ---------- */

function updateOutputs() {
  const log = activeLog();
  const totals = timeTotals(log);

  const set = (selector, value) => {
    const el = $(selector);
    if (el) el.textContent = value;
  };
  set('#tot-flight', fmtDuration(totals.flight));
  set('#tot-engine', fmtDuration(totals.engine));
  set('#tot-tach', totals.tach == null ? '—' : fmtDecimal(totals.tach, 1));
  set('#tot-hobbs', totals.hobbs == null ? '—' : fmtDecimal(totals.hobbs, 1));
  set('#tach-card-total', totals.tach == null ? '—' : fmtDecimal(totals.tach, 1));
  set('#tach-card-hobbs', log.times.shutDown.hobbs || '—');

  $$('[data-coord]').forEach(input => updateCoordHelp(input));
  updateToolbarState();
}

function updateCoordHelp(input) {
  const field = input.closest('.field') || input.closest('.obs') || input.parentElement;
  if (!field) return;
  const help = field.querySelector('.coord-help');
  if (!help) return;

  const value = input.value.trim();
  if (!value) {
    help.textContent = state.settings.coordFormat === 'dd'
      ? 'Decimal degrees or DDMM.mmm'
      : 'DDMM.mmm or decimal degrees';
    help.classList.remove('error');
    return;
  }
  const isLat = input.dataset.coord === 'lat';
  const parsed = isLat ? parseLat(value) : parseLon(value);
  if (parsed == null) {
    help.textContent = 'Not a valid ' + (isLat ? 'latitude' : 'longitude');
    help.classList.add('error');
  } else {
    help.textContent = fmtCoord(parsed, isLat, state.settings.coordFormat);
    help.classList.remove('error');
  }
}

function updateToolbarState() {
  if (!sketchCtl) return;
  const mode = sketchCtl.mode();
  $$('.swatch[data-act="pen"]').forEach(btn => {
    btn.classList.toggle('active', !mode.eraser && btn.dataset.color === mode.color);
  });
  const eraser = $('.swatch[data-act="eraser"]');
  if (eraser) eraser.classList.toggle('active', mode.eraser);
}

function autoGrow(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.max(el.scrollHeight, 64) + 'px';
}

function autoGrowAll() {
  $$('textarea[data-autogrow]').forEach(autoGrow);
}

/* =========================================================================
   Sketch & signature controllers
   ========================================================================= */

function setupSketch() {
  const canvas = $('#sketch');
  if (!canvas) { sketchCtl = null; return; }
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const log = activeLog();

  let color = '#17222e';
  let eraser = false;
  let drawing = false;
  let dirty = false;
  let last = null;
  let saveSketchTimer = null;
  const undoStack = [];
  const hadSketchAtStart = !!log.sketch;

  function paintGrid() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 25) {
      ctx.strokeStyle = x % 125 === 0 ? '#c9d9e6' : '#e4edf4';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, H);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y += 25) {
      ctx.strokeStyle = y % 125 === 0 ? '#c9d9e6' : '#e4edf4';
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(W, y + 0.5);
      ctx.stroke();
    }
  }

  function loadImage(data) {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
    };
    img.src = data;
  }

  function snapshot() {
    try {
      undoStack.push({
        data: canvas.toDataURL('image/jpeg', 0.7),
        base: undoStack.length === 0 && !hadSketchAtStart && !dirty
      });
      if (undoStack.length > 8) undoStack.shift();
    } catch (_) { /* ignore */ }
  }

  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (W / rect.width),
      y: (event.clientY - rect.top) * (H / rect.height)
    };
  }

  function strokeStyle() {
    ctx.strokeStyle = eraser ? '#ffffff' : color;
    ctx.lineWidth = eraser ? 30 : 3.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  function onDown(event) {
    if (event.pointerType !== 'pen' && !state.settings.fingerDraw) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    const tip = canvas.parentElement.querySelector('.canvas-tip');
    if (tip) tip.remove();
    try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    snapshot();
    dirty = true;
    drawing = true;
    last = pointFrom(event);
    strokeStyle();
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(last.x + 0.01, last.y + 0.01);
    ctx.stroke();
  }

  function onMove(event) {
    if (!drawing) return;
    event.preventDefault();
    const p = pointFrom(event);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }

  function persist() {
    if (!dirty) return;
    try {
      log.sketch = canvas.toDataURL('image/jpeg', 0.82);
      save();
    } catch (err) {
      console.warn('sketch save failed', err);
    }
  }

  function scheduleSave() {
    clearTimeout(saveSketchTimer);
    saveSketchTimer = setTimeout(persist, 500);
  }

  function onUp(event) {
    if (!drawing) return;
    drawing = false;
    last = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    scheduleSave();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  if (log.sketch) loadImage(log.sketch);
  else paintGrid();

  sketchCtl = {
    mode() { return { color, eraser }; },
    setColor(next) { color = next; eraser = false; updateToolbarState(); },
    setEraser() { eraser = true; updateToolbarState(); },
    undo() {
      const item = undoStack.pop();
      if (!item) return;
      if (item.base) {
        paintGrid();
        log.sketch = '';
        dirty = false;
      } else {
        loadImage(item.data);
        log.sketch = item.data;
        dirty = true;
      }
      save();
    },
    clear() {
      paintGrid();
      log.sketch = '';
      undoStack.length = 0;
      dirty = false;
      clearTimeout(saveSketchTimer);
      save();
    },
    flush() {
      clearTimeout(saveSketchTimer);
      persist();
    }
  };

  updateToolbarState();
}

function setupSignature() {
  const canvas = $('#signature');
  if (!canvas) { sigCtl = null; return; }
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const log = activeLog();
  let drawing = false;
  let dirty = false;
  let last = null;
  let saveTimerSig = null;

  function paintBase() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#c7d2dc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(40, H - 30);
    ctx.lineTo(W - 40, H - 30);
    ctx.stroke();
  }

  function loadImage(data) {
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
    };
    img.src = data;
  }

  function pointFrom(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (W / rect.width),
      y: (event.clientY - rect.top) * (H / rect.height)
    };
  }

  function persist() {
    if (!dirty) return;
    try {
      log.signoff.signature = canvas.toDataURL('image/jpeg', 0.85);
      if (!log.signoff.dateTime) {
        log.signoff.dateTime = fmtDateZ(new Date());
        const input = $('[data-bind="signoff.dateTime"]');
        if (input) input.value = log.signoff.dateTime;
      }
      save();
    } catch (err) {
      console.warn('signature save failed', err);
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimerSig);
    saveTimerSig = setTimeout(persist, 450);
  }

  canvas.addEventListener('pointerdown', event => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    dirty = true;
    drawing = true;
    last = pointFrom(event);
    ctx.strokeStyle = '#17222e';
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(last.x + 0.01, last.y + 0.01);
    ctx.stroke();
  });

  canvas.addEventListener('pointermove', event => {
    if (!drawing) return;
    event.preventDefault();
    const p = pointFrom(event);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  });

  function endStroke(event) {
    if (!drawing) return;
    drawing = false;
    last = null;
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
    scheduleSave();
  }
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  if (log.signoff.signature) loadImage(log.signoff.signature);
  else paintBase();

  sigCtl = {
    clear() {
      paintBase();
      log.signoff.signature = '';
      dirty = false;
      clearTimeout(saveTimerSig);
      save();
    },
    flush() {
      clearTimeout(saveTimerSig);
      persist();
    }
  };
}

/* =========================================================================
   Sheets
   ========================================================================= */

function openSheet(options) {
  const overlay = $('#overlay');
  if (!overlay) return;
  sheetOnClose = options.onClose || null;
  overlay.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(options.title)}">
    <div class="sheet-head">
      <div>
        <h2>${options.title}</h2>
        ${options.sub ? '<div class="sheet-sub">' + esc(options.sub) + '</div>' : ''}
      </div>
      <button type="button" class="icon-btn" data-close aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <div class="sheet-body">${options.body || ''}</div>
    ${options.footer ? '<div class="sheet-foot">' + options.footer + '</div>' : ''}
  </div>`;
  overlay.classList.add('show');
  document.documentElement.classList.add('sheet-open');
}

function closeSheet() {
  const overlay = $('#overlay');
  if (!overlay) return;
  overlay.classList.remove('show');
  overlay.innerHTML = '';
  document.documentElement.classList.remove('sheet-open');
  const callback = sheetOnClose;
  sheetOnClose = null;
  if (typeof callback === 'function') callback();
}

function field(label, inner, className) {
  return `<label class="field ${className || ''}"><span>${esc(label)}</span>${inner}</label>`;
}

function textInput(path, value, options) {
  const opts = options || {};
  return `<input class="input ${opts.className || ''}" data-bind="${esc(path)}"
    ${opts.norm ? 'data-norm="' + esc(opts.norm) + '"' : ''}
    ${opts.inputmode ? 'inputmode="' + esc(opts.inputmode) + '"' : ''}
    ${opts.maxlength ? 'maxlength="' + opts.maxlength + '"' : ''}
    ${opts.autocap ? 'autocapitalize="' + esc(opts.autocap) + '"' : ''}
    ${opts.placeholder ? 'placeholder="' + esc(opts.placeholder) + '"' : ''}
    value="${esc(value)}">`;
}

function coordField(label, path, value, isLat) {
  return `<label class="field"><span>${esc(label)}</span>
    <input class="input mono" data-bind="${esc(path)}" data-coord="${isLat ? 'lat' : 'lon'}"
      data-norm="coord" inputmode="decimal" value="${esc(value)}"
      placeholder="${isLat ? '35 12.345 or 35.2057' : '79 03.210 or -79.0535'}">
    <div class="coord-help"></div>
  </label>`;
}

function sheetCoordField(label, id, value, isLat) {
  return `<label class="field"><span>${esc(label)}</span>
    <input class="input mono" id="${esc(id)}" data-coord="${isLat ? 'lat' : 'lon'}"
      inputmode="decimal" value="${esc(value)}"
      placeholder="${isLat ? '35 12.345 or 35.2057' : '79 03.210 or -79.0535'}">
    <div class="coord-help"></div>
  </label>`;
}

function safeImage(source) {
  return typeof source === 'string' && /^data:image\/(png|jpe?g|webp);base64,/i.test(source)
    ? source
    : '';
}

/* ---------- observation photos ---------- */

const MAX_OBS_PHOTOS = 6;
const PHOTO_MAX_EDGE = 1600;
const PHOTO_QUALITY = 0.74;

const PHOTO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l1.4-2h7.2L17 7h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="4"/></svg>';

function loadPhotoBitmap(file) {
  if ('createImageBitmap' in window) {
    return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null)
      .then(bitmap => {
        if (bitmap) return bitmap;
        return loadPhotoElement(file);
      });
  }
  return loadPhotoElement(file);
}

function loadPhotoElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    img.src = url;
  });
}

async function fileToPhoto(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    throw new Error('Not an image');
  }
  const bitmap = await loadPhotoBitmap(file);
  const width = bitmap.width || bitmap.naturalWidth || 0;
  const height = bitmap.height || bitmap.naturalHeight || 0;
  if (!width || !height) throw new Error('Empty image');

  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(bitmap, 0, 0, outW, outH);
  if (typeof bitmap.close === 'function') bitmap.close();

  const thumbScale = Math.min(1, 260 / Math.max(outW, outH));
  const thumbW = Math.max(1, Math.round(outW * thumbScale));
  const thumbH = Math.max(1, Math.round(outH * thumbScale));
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbW;
  thumbCanvas.height = thumbH;
  const thumbCtx = thumbCanvas.getContext('2d');
  thumbCtx.fillStyle = '#ffffff';
  thumbCtx.fillRect(0, 0, thumbW, thumbH);
  thumbCtx.drawImage(canvas, 0, 0, thumbW, thumbH);

  return {
    id: uid(),
    data: canvas.toDataURL('image/jpeg', PHOTO_QUALITY),
    thumb: thumbCanvas.toDataURL('image/jpeg', 0.68),
    w: outW,
    h: outH,
    addedAt: Date.now()
  };
}

function addObservationPhoto(obsId) {
  const log = activeLog();
  const obs = log.observations.find(o => o.id === obsId);
  if (!obs) return;
  if (!Array.isArray(obs.photos)) obs.photos = [];
  if (obs.photos.length >= MAX_OBS_PHOTOS) {
    toast('Up to ' + MAX_OBS_PHOTOS + ' photos per observation');
    return;
  }

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.addEventListener('cancel', () => input.remove());
  setTimeout(() => { if (input.isConnected) input.remove(); }, 300000);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;

    toast('Adding photo…');
    try {
      const photo = await fileToPhoto(file);
      obs.photos.push(photo);
      save();
      if (activeTab === 'obs') render();
      toast('Photo added');
    } catch (err) {
      console.warn('photo import failed', err);
      toast('Could not add that photo');
    }
  });

  input.click();
}

function viewObservationPhoto(obsId, index) {
  const log = activeLog();
  const obs = log.observations.find(o => o.id === obsId);
  if (!obs || !obs.photos || !obs.photos[index]) return;
  const photo = obs.photos[index];
  const obsIndex = log.observations.indexOf(obs);
  const source = safeImage(photo.data);
  if (!source) return;

  openSheet({
    title: 'Observation photo',
    sub: 'Obs ' + (obsIndex + 1) + (obs.time ? ' · ' + fmtZ(obs.time) : ''),
    body: `<img class="photo-full" src="${source}" alt="Observation photo">`,
    footer: `<button type="button" class="btn danger left" data-act="delete-photo" data-obs="${esc(obs.id)}" data-photo="${esc(photo.id)}">Delete photo</button>
      <button type="button" class="btn primary" data-close>Done</button>`
  });
}

function deleteObservationPhoto(obsId, photoId) {
  const log = activeLog();
  const obs = log.observations.find(o => o.id === obsId);
  if (!obs || !Array.isArray(obs.photos)) return;
  const index = obs.photos.findIndex(photo => photo.id === photoId);
  if (index < 0) return;
  const [removed] = obs.photos.splice(index, 1);
  closeSheet();
  save();
  render();
  toast('Photo deleted', 'Undo', () => {
    obs.photos.splice(index, 0, removed);
    save();
    render();
  });
}

function missionSheet() {
  const log = activeLog();
  const crew = log.crew;
  const radio = log.radio;
  openSheet({
    title: 'Mission details',
    sub: 'These carry onto the printed log',
    body: `
      <div class="sheet-section">
        <h3>Mission</h3>
        <div class="form-grid">
          ${field('Mission number', textInput('mission', log.mission, { placeholder: 'e.g. 24-001' }))}
          ${field('Sortie', textInput('sortie', log.sortie, { inputmode: 'numeric', placeholder: '1' }))}
          ${field('Aircraft N#', textInput('aircraft', log.aircraft, { autocap: 'characters', placeholder: 'N12345' }))}
          ${field('Callsign', textInput('callsign', log.callsign, { autocap: 'characters', placeholder: 'CAP 1234' }))}
          ${field('Base', textInput('base', log.base, { placeholder: 'KBUY' }))}
          ${field('CAP flight', textInput('capFlight', log.capFlight, { placeholder: 'NC-123' }))}
        </div>
      </div>

      <div class="sheet-section">
        <h3>Flight profile</h3>
        <div class="form-grid">
          ${field('Sectional', textInput('sectional', log.sectional, { placeholder: 'Charlotte' }))}
          ${field('Grid', textInput('grid', log.grid, { placeholder: '17S' }))}
          ${field('Altitude', textInput('altitude', log.altitude, { placeholder: '3500' }))}
          ${field('Airspeed', textInput('airspeed', log.airspeed, { placeholder: '110' }))}
        </div>
        <div class="subhead">Entry point</div>
        <div class="form-grid">
          ${coordField('Latitude N', 'entry.lat', log.entry.lat, true)}
          ${coordField('Longitude W', 'entry.lon', log.entry.lon, false)}
        </div>
        <div class="gps-row">
          <button type="button" class="mini gps-mini" data-act="gps-mission" data-target="entry">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
            Use current position
          </button>
          <button type="button" class="mini" data-act="copy-entry">Copy to exit</button>
          <span class="gps-status" id="gps-mission-entry-status"></span>
        </div>
        <div class="subhead">Exit point</div>
        <div class="form-grid">
          ${coordField('Latitude N', 'exit.lat', log.exit.lat, true)}
          ${coordField('Longitude W', 'exit.lon', log.exit.lon, false)}
        </div>
        <div class="gps-row">
          <button type="button" class="mini gps-mini" data-act="gps-mission" data-target="exit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
            Use current position
          </button>
          <span class="gps-status" id="gps-mission-exit-status"></span>
        </div>
      </div>

      <div class="sheet-section">
        <h3>Crew</h3>
        <div class="form-grid">
          ${field('Pilot', textInput('crew.pilot', crew.pilot, { autocap: 'characters' }))}
          ${field('Observer', textInput('crew.observer', crew.observer, { autocap: 'characters' }))}
          ${field('AP', textInput('crew.ap', crew.ap, { autocap: 'characters' }))}
          ${field('Scanner', textInput('crew.scanner', crew.scanner, { autocap: 'characters' }))}
        </div>
      </div>

      <div class="sheet-section">
        <h3>Radios</h3>
        <div class="form-grid">
          ${field('Main', textInput('radio.main', radio.main, { className: 'mono', inputmode: 'decimal' }))}
          ${field('Guard', textInput('radio.guard', radio.guard, { className: 'mono', inputmode: 'decimal' }))}
          ${field('ATIS / AWOS', textInput('radio.atis', radio.atis, { className: 'mono', inputmode: 'decimal' }))}
          ${field('CTAF', textInput('radio.ctaf', radio.ctaf, { className: 'mono', inputmode: 'decimal' }))}
          ${field('Unicom', textInput('radio.unicom', radio.unicom, { className: 'mono', inputmode: 'decimal' }))}
          ${field('Other', textInput('radio.other', radio.other, { className: 'mono', inputmode: 'decimal' }))}
        </div>
      </div>

      <div class="sheet-note">Coordinates accept aviation format (35 12.345) or decimal degrees (35.2057). The N/W labels match the paper form.</div>
    `,
    footer: `<button type="button" class="btn primary" data-close>Done</button>`,
    onClose: () => render()
  });
}

function openEntrySheet(entryId, preset) {
  const log = activeLog();
  const existing = entryId ? log.entries.find(e => e.id === entryId) : null;
  const entry = existing || Object.assign({
    id: '',
    kind: '',
    event: '',
    time: nowZ(),
    hobbs: lastHobbs(log),
    lat: lastPosition(log).lat,
    lon: lastPosition(log).lon,
    note: ''
  }, preset || {});

  const all = ['Engine Start', 'Wheels Up', 'In Area', 'On Target', 'Out of Area', 'Wheels Down', 'Shut Down',
    'Radio check', 'Photo', 'Contact', 'Divert', 'Notes'];
  const datalist = '<datalist id="event-options">' + all.map(v => '<option value="' + esc(v) + '"></option>').join('') + '</datalist>';

  openSheet({
    title: existing ? 'Edit log entry' : 'New log entry',
    body: `
      <input type="hidden" id="f-kind" value="${esc(entry.kind || '')}">
      <div class="form-grid">
        <label class="field"><span>Time (UTC)</span>
          <div class="input-btn">
            <input class="input time mono" id="f-time" inputmode="numeric" maxlength="4" value="${esc(entry.time)}" placeholder="HHMM">
            <button type="button" class="mini" data-act="fill-now" data-target="#f-time">Now</button>
          </div>
        </label>
        <label class="field"><span>Hobbs</span>
          <div class="input-btn">
            <input class="input hobbs mono" id="f-hobbs" inputmode="decimal" value="${esc(entry.hobbs)}" placeholder="1234.5">
            <button type="button" class="mini" data-act="fill-last-hobbs" data-target="#f-hobbs">Last</button>
          </div>
        </label>
      </div>
      <div class="form-grid" style="margin-top:12px">
        ${sheetCoordField('Latitude N', 'f-lat', entry.lat, true)}
        ${sheetCoordField('Longitude W', 'f-lon', entry.lon, false)}
      </div>
      <div class="gps-row">
        <button type="button" class="mini gps-mini" data-act="gps-sheet">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/></svg>
          Use current position
        </button>
        <span class="gps-status" id="gps-sheet-status"></span>
      </div>
      <div class="form-grid" style="margin-top:12px">
        <label class="field span-2"><span>Event</span>
          <input class="input" id="f-event" list="event-options" value="${esc(entry.event)}" placeholder="Wheels Up, On Target, contact…">
        </label>
      </div>
      ${datalist}
      <label class="field" style="margin-top:12px"><span>Remarks</span>
        <textarea class="input" id="f-note" placeholder="Optional detail">${esc(entry.note)}</textarea>
      </label>
      <div class="sheet-note">Coordinate fields are prefilled from your last position; overwrite them when it changes.</div>
    `,
    footer: `${existing ? '<button type="button" class="btn danger left" data-act="delete-entry-sheet" data-id="' + esc(entry.id) + '">Delete</button>' : ''}
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn primary" data-act="save-entry" data-id="${esc(entry.id)}">Save</button>`,
    onClose: null
  });

  // Wire the sheet-local coordinate helpers (these fields are not live-bound).
  $$('#overlay [data-coord]').forEach(input => {
    const help = input.parentElement.querySelector('.coord-help');
    if (!help) return;
    const update = () => {
      const raw = input.value.trim();
      if (!raw) { help.textContent = ''; help.classList.remove('error'); return; }
      const parsed = input.dataset.coord === 'lat' ? parseLat(raw) : parseLon(raw);
      if (parsed == null) {
        help.textContent = 'Not a valid ' + (input.dataset.coord === 'lat' ? 'latitude' : 'longitude');
        help.classList.add('error');
      } else {
        help.textContent = fmtCoord(parsed, input.dataset.coord === 'lat', state.settings.coordFormat);
        help.classList.remove('error');
      }
    };
    input.addEventListener('input', update);
    update();
  });
}

function saveEntryFromSheet(entryId) {
  const log = activeLog();
  const time = normTime($('#f-time').value);
  const hobbs = $('#f-hobbs').value.trim();
  const lat = ($('#f-lat') ? $('#f-lat').value : '').trim();
  const lon = ($('#f-lon') ? $('#f-lon').value : '').trim();
  const event = $('#f-event').value.trim();
  const note = $('#f-note').value.trim();
  const kind = $('#f-kind').value;

  const timeInput = $('#f-time');
  if (!isValidTime(time)) {
    timeInput.classList.add('invalid');
    timeInput.focus();
    toast('Enter a valid UTC time (HHMM)');
    return;
  }
  timeInput.classList.remove('invalid');

  if (lat && parseLat(lat) == null) {
    toast('Latitude is not valid');
    return;
  }
  if (lon && parseLon(lon) == null) {
    toast('Longitude is not valid');
    return;
  }

  const data = { time, hobbs, lat, lon, event: event || 'Log entry', note, kind };

  if (entryId) {
    const entry = log.entries.find(e => e.id === entryId);
    if (entry) Object.assign(entry, data);
  } else {
    log.entries.push(Object.assign({ id: uid(), createdAt: Date.now() }, data));
  }

  const timeKey = KIND_TO_TIMEKEY[kind];
  if (timeKey) log.times[timeKey] = { time, hobbs };

  closeSheet();
  save();
  render();
  toast(entryId ? 'Entry updated' : 'Entry added');
}

function deleteEntry(entryId) {
  const log = activeLog();
  const index = log.entries.findIndex(e => e.id === entryId);
  if (index < 0) return;
  const beforeTimes = deepClone(log.times);
  const [removed] = log.entries.splice(index, 1);

  const timeKey = KIND_TO_TIMEKEY[removed.kind];
  if (timeKey && log.times[timeKey].time === removed.time) {
    log.times[timeKey] = { time: '', hobbs: '' };
  }

  closeSheet();
  save();
  render();
  toast('Entry deleted', 'Undo', () => {
    log.entries.splice(index, 0, removed);
    log.times = beforeTimes;
    save();
    render();
  });
}

/* ---------- menu, settings, help ---------- */

function menuSheet() {
  const log = activeLog();
  const logRows = state.logs.map(l => `<button type="button" class="log-row ${l.id === state.activeId ? 'active' : ''}" data-act="switch-log" data-id="${esc(l.id)}">
    <span class="log-name">${esc(l.mission || 'Untitled mission')}</span>
    <span class="log-meta">Sortie ${esc(l.sortie || '—')} · ${esc(l.aircraft || 'no tail')} · ${l.entries.length} entr${l.entries.length === 1 ? 'y' : 'ies'}</span>
  </button>`).join('');

  openSheet({
    title: 'Logs & data',
    body: `
      <div class="sheet-section">
        <h3>Mission logs</h3>
        <div class="log-list">${logRows}</div>
        <div class="btn-row">
          <button type="button" class="btn small" data-act="new-log">+ New log</button>
          <button type="button" class="btn small" data-act="dup-log">Duplicate</button>
          <button type="button" class="btn small danger" data-act="del-log">Delete</button>
        </div>
      </div>

      <div class="sheet-section">
        <h3>Output</h3>
        <div class="menu-list">
          <button type="button" class="menu-item" data-act="print">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
            <span>Print / Save PDF<span class="mi-sub">Two-page mission log, ready for signature</span></span>
          </button>
          <button type="button" class="menu-item" data-act="export-json">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
            <span>Export backup<span class="mi-sub">All logs as a .json file</span></span>
          </button>
          <button type="button" class="menu-item" data-act="import-json">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/></svg>
            <span>Import backup<span class="mi-sub">Merge a .json backup into this device</span></span>
          </button>
          <button type="button" class="menu-item" data-act="export-csv">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></svg>
            <span>Flight log CSV<span class="mi-sub">Time, Hobbs, position and remarks</span></span>
          </button>
        </div>
      </div>

      <div class="sheet-section">
        <div class="menu-list">
          <button type="button" class="menu-item" data-act="settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.63.66 1.1 1.3 1.1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"/></svg>
            <span>Settings<span class="mi-sub">Theme, coordinates, screen awake</span></span>
          </button>
          <button type="button" class="menu-item" data-act="help">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-.9.7-1.5 1.2-1.5 2.5"/><path d="M12 17h.01"/></svg>
            <span>Help &amp; install<span class="mi-sub">Add to home screen, offline use</span></span>
          </button>
        </div>
      </div>

      <div class="sheet-note">Observer Log v${APP_VERSION} · ${state.logs.reduce((n, l) => n + l.entries.length, 0)} entries across ${state.logs.length} log${state.logs.length === 1 ? '' : 's'}. Data never leaves this iPad unless you export it.</div>
    `,
    footer: `<button type="button" class="btn primary" data-close>Done</button>`,
    onClose: () => render()
  });
}

function settingsSheet() {
  const settings = state.settings;
  const wakeSupported = 'wakeLock' in navigator;
  const gpsSupported = ('geolocation' in navigator) && window.isSecureContext;

  openSheet({
    title: 'Settings',
    body: `
      <div class="setting-row">
        <div class="setting-label">Appearance<small>Auto follows the iPad</small></div>
        <div class="seg">
          <button type="button" data-act="set-theme" data-value="auto" class="${settings.theme === 'auto' ? 'active' : ''}">Auto</button>
          <button type="button" data-act="set-theme" data-value="light" class="${settings.theme === 'light' ? 'active' : ''}">Light</button>
          <button type="button" data-act="set-theme" data-value="dark" class="${settings.theme === 'dark' ? 'active' : ''}">Dark</button>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label">Coordinates<small>How positions print and display</small></div>
        <div class="seg">
          <button type="button" data-act="set-coord" data-value="dm" class="${settings.coordFormat === 'dm' ? 'active' : ''}">DD MM.mmm</button>
          <button type="button" data-act="set-coord" data-value="dd" class="${settings.coordFormat === 'dd' ? 'active' : ''}">Decimal</button>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label">OPS interval<small>Reminder rhythm on the log tab</small></div>
        <div class="input-btn" style="width:132px">
          <input class="input mono centered" id="ops-interval" data-bind="settings.opsInterval" inputmode="numeric" value="${esc(settings.opsInterval)}">
          <span class="muted small">min</span>
        </div>
      </div>

      <div class="setting-row">
        <div class="setting-label">Keep screen awake<small>${wakeSupported ? 'While the app is open' : 'Not supported in this browser'}</small></div>
        <button type="button" class="toggle ${settings.keepAwake ? 'on' : ''}" data-act="toggle-wake" ${wakeSupported ? '' : 'disabled'}>
          <span class="tick">✓</span> ${settings.keepAwake ? 'On' : 'Off'}
        </button>
      </div>

      <div class="setting-row">
        <div class="setting-label">Auto-capture GPS<small>${gpsSupported ? 'Adds a position to checkpoints and observations' : 'Needs the installed app or an https page'}</small></div>
        <button type="button" class="toggle ${settings.gpsAuto ? 'on' : ''}" data-act="toggle-gps-auto" ${gpsSupported ? '' : 'disabled'}>
          <span class="tick">✓</span> ${settings.gpsAuto ? 'On' : 'Off'}
        </button>
      </div>

      <div class="setting-row">
        <div class="setting-label">Finger drawing<small>Off means one finger scrolls the sketch</small></div>
        <button type="button" class="toggle ${settings.fingerDraw ? 'on' : ''}" data-act="toggle-finger">
          <span class="tick">✓</span> ${settings.fingerDraw ? 'On' : 'Off'}
        </button>
      </div>

      <div class="sheet-note" style="margin-top:16px">
        Stored on this iPad. Safari can clear website data after long periods of disuse — export a backup after each mission.
      </div>

      <button type="button" class="btn danger wide" data-act="reset-all" style="margin-top:8px">Erase all logs on this device</button>
    `,
    footer: `<button type="button" class="btn primary" data-close>Done</button>`,
    onClose: () => { render(); }
  });
}

function helpSheet() {
  openSheet({
    title: 'Help & install',
    body: `
      <div class="sheet-section">
        <h3>Put it on the home screen</h3>
        <p class="sheet-note" style="margin-top:0">
          Open this page in <strong>Safari</strong> on the iPad, tap the Share button, then
          <strong>Add to Home Screen</strong>. Launch it from that icon from then on. It opens full
          screen and keeps working with no signal.
        </p>
        <p class="sheet-note">
          The first load needs a connection so Safari can cache the app. After that, everything —
          including the sketch pad — runs offline.
        </p>
      </div>

      <div class="sheet-section">
        <h3>In the air</h3>
        <div class="menu-list">
          <div class="menu-item" style="cursor:default">
            <span><strong>Checkpoint buttons</strong><span class="mi-sub">Tap Engine Start, Wheels Up, In Area, etc. Time and Hobbs are filled in. Tap again to edit.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>OPS rhythm</strong><span class="mi-sub">Record a check every 30 minutes. Fuel and altimeter carry forward; the log tab warns you when one is due.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>Positions</strong><span class="mi-sub">Enter 35 12.345 or 35.2057. Set the display format in Settings. New entries start at your last position.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>GPS positions</strong><span class="mi-sub">Tap “Use GPS” in an entry, observation, or mission sheet. Turn on Auto-capture GPS in Settings to stamp every checkpoint. Allow location when Safari asks; a fix works without a network.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>Observation photos</strong><span class="mi-sub">Tap Photo on an observation to use the camera or photo library. Up to six per observation; photos appear in the PDF.</span></span>
          </div>
          <div class="menu-item" style="cursor:default">
            <span><strong>Apple Pencil</strong><span class="mi-sub">Choose <strong>Finger</strong> above the sketch pad to draw without a pencil. In Apple Pencil mode a finger scrolls the page instead of drawing.</span></span>
          </div>
        </div>
        <p class="sheet-note" style="margin-top:10px">
          GPS accuracy depends on the iPad model. Cellular iPads have a real GPS receiver; Wi-Fi-only
          models use Wi-Fi positioning and may be much less accurate away from coverage.
        </p>
      </div>

      <div class="sheet-section">
        <h3>After the sortie</h3>
        <p class="sheet-note" style="margin-top:0">
          Tap <strong>Print / Save PDF</strong>, then choose <strong>Save to Files</strong> or
          <strong>Print</strong> in the share sheet. On a computer, the browser print dialog opens.
          That gives you a PDF of the log with notes, sketches, observations and signature.
          <strong>Export backup</strong> writes a .json copy of everything.
        </p>
      </div>

      <div class="sheet-section">
        <h3>Privacy</h3>
        <p class="sheet-note" style="margin-top:0">
          There is no account and no server. Logs live in this browser's storage on this iPad. Nothing is
          uploaded. Deleting the app's website data, or “Erase all logs”, removes them permanently — keep
          backups.
        </p>
      </div>

      <div class="sheet-note" style="text-align:center;margin-top:20px">Observer Log v${APP_VERSION}</div>
    `,
    footer: `<button type="button" class="btn primary" data-close>Done</button>`,
    onClose: () => render()
  });
}

/* =========================================================================
   Actions
   ========================================================================= */

function quickLog(kind, label) {
  const log = activeLog();
  const existing = kind ? entryForKind(log, kind) : null;
  if (existing) {
    openEntrySheet(existing.id);
    return;
  }

  const beforeTimes = deepClone(log.times);
  const position = lastPosition(log);
  const entry = {
    id: uid(),
    kind,
    event: label,
    time: nowZ(),
    hobbs: lastHobbs(log),
    lat: position.lat,
    lon: position.lon,
    note: '',
    createdAt: Date.now()
  };
  log.entries.push(entry);

  const timeKey = KIND_TO_TIMEKEY[kind];
  if (timeKey) log.times[timeKey] = { time: entry.time, hobbs: entry.hobbs };

  save();
  render();
  if (state.settings.gpsAuto) autoGpsEntry(entry);
  toast(label + ' logged at ' + fmtZ(entry.time), 'Undo', () => {
    log.entries = log.entries.filter(e => e.id !== entry.id);
    log.times = beforeTimes;
    save();
    render();
  });
}

function addObservation() {
  const log = activeLog();
  const position = lastPosition(log);
  const obs = {
    id: uid(),
    time: nowZ(),
    hobbs: lastHobbs(log),
    lat: position.lat,
    lon: position.lon,
    text: ''
  };
  log.observations.push(obs);
  save();
  if (activeTab !== 'obs') {
    activeTab = 'obs';
  }
  render();
  if (state.settings.gpsAuto) autoGpsObservation(obs);
  requestAnimationFrame(() => {
    const cards = $$('.obs');
    const last = cards[cards.length - 1];
    if (last) {
      const area = last.querySelector('textarea');
      if (area) {
        area.focus({ preventScroll: true });
        last.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  });
}

function addOpsCheck() {
  const log = activeLog();
  const last = log.ops[log.ops.length - 1];
  const op = {
    id: uid(),
    time: nowZ(),
    hobbs: lastHobbs(log),
    fuel: last ? last.fuel : '',
    altimeter: last ? last.altimeter : '',
    normal: true
  };
  log.ops.push(op);
  save();
  render();
  toast('OPS check recorded at ' + fmtZ(op.time), 'Undo', () => {
    log.ops = log.ops.filter(o => o.id !== op.id);
    save();
    render();
  });
}

function switchLog(id) {
  if (!state.logs.some(l => l.id === id)) return;
  state.activeId = id;
  closeSheet();
  activeTab = 'log';
  save();
  render();
  window.scrollTo(0, 0);
}

function createLog() {
  const log = blankLog();
  state.logs.push(log);
  state.activeId = log.id;
  closeSheet();
  activeTab = 'log';
  save();
  render();
  toast('New log created');
}

function duplicateLog() {
  const source = activeLog();
  const copy = normalizeLog(deepClone(source));
  copy.id = uid();
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  copy.mission = (copy.mission ? copy.mission + ' copy' : 'Untitled copy');
  copy.entries.forEach(e => { e.id = uid(); });
  copy.ops.forEach(o => { o.id = uid(); });
  copy.observations.forEach(o => { o.id = uid(); });
  state.logs.push(copy);
  state.activeId = copy.id;
  closeSheet();
  activeTab = 'log';
  save();
  render();
  toast('Log duplicated');
}

function deleteLog() {
  if (!confirm('Delete “' + (activeLog().mission || 'Untitled mission') + '” and all of its entries? This cannot be undone.')) return;
  const index = state.logs.findIndex(l => l.id === state.activeId);
  state.logs.splice(index, 1);
  if (!state.logs.length) state.logs.push(blankLog());
  state.activeId = state.logs[0].id;
  closeSheet();
  activeTab = 'log';
  save();
  render();
  toast('Log deleted');
}

function slug(value) {
  return String(value || 'mission').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 42) || 'mission';
}

function exportName(extension) {
  const log = activeLog();
  const d = new Date();
  const date = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  return 'observer-log_' + slug(log.mission) + '_s' + slug(log.sortie) + '_' + date + '.' + extension;
}

async function shareFile(filename, blob) {
  try {
    if (navigator.canShare && typeof File === 'function') {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return true;
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return false;
    console.warn('share failed, falling back to download', err);
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  return true;
}

function exportJSON() {
  const payload = {
    app: 'Observer Log',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    logs: state.logs
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  shareFile(exportName('json'), blob);
  toast('Backup ready');
}

function csvCell(value) {
  const text = String(value == null ? '' : value);
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function exportCSV() {
  const log = activeLog();
  const header = ['Mission', 'Sortie', 'Aircraft', 'Callsign', 'Time (Z)', 'Hobbs', 'Latitude (DD)', 'Longitude (DD)', 'Event', 'Remarks', 'GPS accuracy (m)'];
  const rows = [header];
  log.entries.forEach(entry => {
    const lat = parseLat(entry.lat);
    const lon = parseLon(entry.lon);
    rows.push([
      log.mission, log.sortie, log.aircraft, log.callsign,
      entry.time ? entry.time + 'Z' : '',
      entry.hobbs,
      lat == null ? '' : lat.toFixed(6),
      lon == null ? '' : lon.toFixed(6),
      entry.event, entry.note,
      entry.gpsAccuracy == null ? '' : entry.gpsAccuracy
    ]);
  });
  const csv = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const blob = new Blob([csv], { type: 'text/csv' });
  shareFile(exportName('csv'), blob);
  toast('CSV ready');
}

function importJSON() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('cancel', () => input.remove());
  setTimeout(() => { if (input.isConnected) input.remove(); }, 300000);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      let incoming = null;

      if (data && Array.isArray(data.logs)) incoming = data.logs;
      else if (data && Array.isArray(data.entries)) incoming = [data];

      if (!incoming || !incoming.length) throw new Error('No logs found in that file');

      let added = 0;
      incoming.forEach(raw => {
        const log = normalizeLog(raw);
        const index = state.logs.findIndex(l => l.id === log.id);
        if (index >= 0) {
          state.logs[index] = log;
        } else {
          state.logs.push(log);
          added++;
        }
      });

      if (data.settings) state.settings = Object.assign(state.settings, data.settings);
      save();
      applyTheme();
      render();
      toast('Imported ' + incoming.length + ' log' + (incoming.length === 1 ? '' : 's') +
        (added ? ' (' + added + ' new)' : ''));
    } catch (err) {
      console.warn(err);
      toast('Could not import that file');
    }
  });
  input.click();
}

function printLog() {
  closeSheet();

  // iPadOS blocks window.print() inside a home-screen web app. On iOS (and
  // any standalone PWA) build the PDF directly and hand it to the share sheet.
  if (isIOSDevice() || isStandaloneApp()) {
    exportPdf();
    return;
  }

  buildPrint();
  window.print();
}

/* ---------- PDF export ---------- */

let pdfLogoData = null;

function isStandaloneApp() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true;
}

function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function pdfSafe(value) {
  return String(value == null ? '' : value)
    .replace(/[—–]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/′/g, "'")
    .replace(/″/g, '"')
    .replace(/→/g, '->')
    .replace(/…/g, '...')
    .replace(/·/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '');
}

function pdfCoordPair(latRaw, lonRaw, format) {
  const lat = parseLat(latRaw);
  const lon = parseLon(lonRaw);
  if (lat == null || lon == null) return '';
  return pdfSafe(fmtCoord(lat, true, format) + ' / ' + fmtCoord(lon, false, format));
}

function loadImageData(url) {
  return fetch(url)
    .then(response => {
      if (!response.ok) throw new Error('image request failed');
      return response.blob();
    })
    .then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    }));
}

function preloadPdfLogo() {
  loadImageData('icons/propeller-print.png')
    .then(data => { pdfLogoData = data; })
    .catch(() => { /* the PDF still works without the corner mark */ });
}

function pdfHeader(doc, title, subtitle, rightLines) {
  const W = doc.internal.pageSize.getWidth();
  const M = 36;
  const navy = [18, 63, 110];

  if (pdfLogoData) {
    try { doc.addImage(pdfLogoData, 'PNG', M, 28, 40, 40); } catch (_) { /* ignore */ }
  }

  const textX = pdfLogoData ? M + 50 : M;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text(pdfSafe(title), textX, 46);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(92, 106, 118);
  doc.text(pdfSafe(subtitle).toUpperCase(), textX, 59);

  doc.setFontSize(8);
  doc.setTextColor(30, 40, 50);
  rightLines.forEach((line, index) => {
    doc.text(pdfSafe(line), W - M, 38 + index * 11, { align: 'right' });
  });

  doc.setDrawColor(navy[0], navy[1], navy[2]);
  doc.setLineWidth(1.6);
  doc.line(M, 76, W - M, 76);
}

function buildPdfBlob() {
  const lib = window.jspdf;
  if (!lib || !lib.jsPDF) throw new Error('PDF library not loaded');

  const doc = new lib.jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  if (typeof doc.autoTable !== 'function') throw new Error('PDF table plugin not loaded');

  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 36;
  const CW = W - M * 2;
  const navy = [18, 63, 110];
  const grey = [92, 106, 118];
  const dark = [30, 40, 50];
  const log = activeLog();
  const fmt = state.settings.coordFormat;
  const totals = timeTotals(log);
  const printed = fmtDateZ(new Date());
  const mission = pdfSafe(log.mission || 'Untitled mission');
  const sortie = pdfSafe(log.sortie || '-');
  const aircraft = pdfSafe(log.aircraft || 'No tail');

  pdfHeader(doc, 'Observer Mission Log', 'Sortie record', [
    'Printed ' + printed,
    'Entries ' + log.entries.length
  ]);

  let y = 86;

  const coordText = (latRaw, lonRaw) => pdfCoordPair(latRaw, lonRaw, fmt) || '';

  const meta = [
    ['Mission', mission], ['Sortie', sortie], ['Aircraft N#', aircraft], ['Callsign', pdfSafe(log.callsign)],
    ['Base', pdfSafe(log.base)], ['CAP flight', pdfSafe(log.capFlight)], ['Sectional', pdfSafe(log.sectional)], ['Grid', pdfSafe(log.grid)],
    ['Altitude', pdfSafe(log.altitude)], ['Airspeed', pdfSafe(log.airspeed)], ['Entry point', coordText(log.entry.lat, log.entry.lon)], ['Exit point', coordText(log.exit.lat, log.exit.lon)],
    ['Pilot', pdfSafe(log.crew.pilot)], ['Observer', pdfSafe(log.crew.observer)], ['AP', pdfSafe(log.crew.ap)], ['Scanner', pdfSafe(log.crew.scanner)],
    ['Main radio', pdfSafe(log.radio.main)], ['Guard radio', pdfSafe(log.radio.guard)], ['ATIS / AWOS', pdfSafe(log.radio.atis)], ['CTAF', pdfSafe(log.radio.ctaf)]
  ];

  const cellW = CW / 4;
  const cellH = 31;
  meta.forEach((item, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    const x = M + col * cellW;
    const top = y + row * cellH;
    doc.setDrawColor(170, 185, 198);
    doc.setLineWidth(0.5);
    doc.rect(x, top, cellW, cellH);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.setTextColor(grey[0], grey[1], grey[2]);
    doc.text(item[0].toUpperCase(), x + 4, top + 8);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(item[1] && item[1].length > 24 ? 7.4 : 8.2);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    const lines = item[1] ? doc.splitTextToSize(item[1], cellW - 8).slice(0, 2) : [];
    if (lines.length) doc.text(lines, x + 4, top + 17);
  });
  y += cellH * 5 + 9;

  // Flight times and totals
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('FLIGHT TIMES', M, y + 7);
  doc.text('TOTALS', 350, y + 7);

  const leftW = 300;
  const rowH = 15;
  const tableTop = y + 13;

  doc.setFillColor(232, 238, 244);
  doc.rect(M, tableTop, leftW, rowH, 'F');
  doc.setDrawColor(150, 160, 170);
  doc.setLineWidth(0.5);
  doc.rect(M, tableTop, leftW, rowH);
  doc.line(M + 150, tableTop, M + 150, tableTop + rowH);
  doc.line(M + 215, tableTop, M + 215, tableTop + rowH);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6.2);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('EVENT', M + 4, tableTop + 10);
  doc.text('TIME (Z)', M + 156, tableTop + 10);
  doc.text('HOBBS', M + 221, tableTop + 10);

  TIME_DEFS.forEach((def, index) => {
    const value = log.times[def.key] || {};
    const top = tableTop + rowH * (index + 1);
    doc.setDrawColor(170, 185, 198);
    doc.rect(M, top, leftW, rowH);
    doc.line(M + 150, top, M + 150, top + rowH);
    doc.line(M + 215, top, M + 215, top + rowH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.4);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    doc.text(def.label, M + 4, top + 10);
    doc.setFont('helvetica', 'normal');
    doc.text(value.time ? value.time + 'Z' : '', M + 156, top + 10);
    doc.text(value.hobbs || '', M + 221, top + 10);
  });

  const totalsData = [
    ['Flight time', fmtDuration(totals.flight)],
    ['Engine run', fmtDuration(totals.engine)],
    ['Total tach', totals.tach == null ? '-' : fmtDecimal(totals.tach, 1)],
    ['Hobbs used', totals.hobbs == null ? '-' : fmtDecimal(totals.hobbs, 1)]
  ];
  const totalsX = 350;
  const totalsW = W - M - totalsX;
  const totalsCell = totalsW / 2;
  const totalsH = 30;

  totalsData.forEach((item, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = totalsX + col * totalsCell;
    const top = tableTop + row * totalsH;
    doc.setDrawColor(170, 185, 198);
    doc.rect(x, top, totalsCell, totalsH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(5.8);
    doc.setTextColor(grey[0], grey[1], grey[2]);
    doc.text(item[0].toUpperCase(), x + 4, top + 8);
    doc.setFontSize(12);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    doc.text(item[1], x + 4, top + 21);
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.8);
  doc.setTextColor(grey[0], grey[1], grey[2]);
  doc.text('Tach start ' + (log.times.tachStart || '________') + '  ·  Tach end ' + (log.times.tachEnd || '________'),
    totalsX, tableTop + totalsH * 2 + 10);

  y = Math.max(tableTop + rowH * 7, tableTop + totalsH * 2 + 16) + 10;

  // Flight log
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('FLIGHT LOG', M, y + 7);

  const logRows = log.entries.map(entry => [
    entry.time ? entry.time + 'Z' : '',
    entry.hobbs || '',
    pdfSafe(fmtCoord(parseLat(entry.lat), true, fmt) || ''),
    pdfSafe(fmtCoord(parseLon(entry.lon), false, fmt) || ''),
    pdfSafe(entry.event || ''),
    pdfSafe(entry.note || '')
  ]);
  const blankLogs = Math.max(0, 10 - logRows.length);
  for (let i = 0; i < blankLogs; i++) logRows.push(['', '', '', '', '', '']);

  doc.autoTable({
    startY: y + 12,
    margin: { left: M, right: M },
    tableWidth: CW,
    head: [['TIME', 'HOBBS', 'LATITUDE N', 'LONGITUDE W', 'EVENT', 'REMARKS']],
    body: logRows,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 7,
      cellPadding: 2.6,
      textColor: dark,
      lineColor: [150, 160, 170],
      lineWidth: 0.4,
      overflow: 'linebreak'
    },
    headStyles: {
      fillColor: [232, 238, 244],
      textColor: navy,
      fontSize: 6.2,
      fontStyle: 'bold'
    },
    columnStyles: {
      0: { cellWidth: 48, halign: 'center' },
      1: { cellWidth: 52, halign: 'center' },
      2: { cellWidth: 88 },
      3: { cellWidth: 92 },
      4: { cellWidth: 100 },
      5: { cellWidth: 160 }
    }
  });

  y = doc.lastAutoTable.finalY + 9;

  // OPS checks
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('OPS STATUS CHECKS', M, y + 7);

  const opsRows = log.ops.map((op, index) => [
    String(index + 1),
    op.time ? op.time + 'Z' : '',
    op.hobbs || '',
    pdfSafe(op.fuel || ''),
    pdfSafe(op.altimeter || ''),
    op.normal ? 'Normal' : 'Flagged'
  ]);
  const blankOps = Math.max(0, 3 - opsRows.length);
  for (let i = 0; i < blankOps; i++) opsRows.push(['', '', '', '', '', '']);

  doc.autoTable({
    startY: y + 12,
    margin: { left: M, right: M },
    tableWidth: CW,
    head: [['#', 'TIME', 'HOBBS', 'FUEL', 'ALTIMETER', 'STATUS']],
    body: opsRows,
    theme: 'grid',
    styles: {
      font: 'helvetica',
      fontSize: 7,
      cellPadding: 2.6,
      textColor: dark,
      lineColor: [150, 160, 170],
      lineWidth: 0.4
    },
    headStyles: {
      fillColor: [232, 238, 244],
      textColor: navy,
      fontSize: 6.2,
      fontStyle: 'bold'
    },
    columnStyles: {
      0: { cellWidth: 30, halign: 'center' },
      1: { cellWidth: 60, halign: 'center' },
      2: { cellWidth: 60, halign: 'center' },
      3: { cellWidth: 140 },
      4: { cellWidth: 80, halign: 'center' },
      5: { cellWidth: 170, halign: 'center' }
    }
  });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(100);
  doc.text('Observer Mission Log · ' + mission + ' · Sortie ' + sortie, M, H - 22);
  doc.text('Sortie record', W - M, H - 22, { align: 'right' });

  // Page 2 — notes, sketch, observations, certification
  doc.addPage();
  pdfHeader(doc, 'Notes & Observations', mission + ' · Sortie ' + sortie + ' · ' + aircraft, [
    'Printed ' + printed
  ]);

  let ny = 88;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('NOTES / SKETCHES', M, ny + 6);
  ny += 13;

  const noteText = pdfSafe(log.notes || '');
  const noteLines = noteText ? doc.splitTextToSize(noteText, CW - 10) : [];
  const noteH = Math.max(46, Math.min(160, noteLines.length * 9.6 + 12));
  doc.setDrawColor(170, 185, 198);
  doc.setLineWidth(0.5);
  doc.rect(M, ny, CW, noteH);
  if (noteLines.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.4);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    doc.text(noteLines.slice(0, Math.floor((noteH - 9) / 9.6)), M + 5, ny + 8);
  }
  ny += noteH + 8;

  const sketch = safeImage(log.sketch);
  if (sketch) {
    let sw = 190;
    let sh = 238;
    if (ny + sh > 460) { sw = 160; sh = 200; }
    if (ny + sh > H - 40) {
      doc.addPage();
      pdfHeader(doc, 'Notes & Observations (continued)', mission + ' · Sortie ' + sortie, ['Printed ' + printed]);
      ny = 88;
    }
    const sx = (W - sw) / 2;
    try {
      doc.addImage(sketch, 'JPEG', sx, ny, sw, sh);
      doc.setDrawColor(170, 185, 198);
      doc.rect(sx - 2, ny - 2, sw + 4, sh + 4);
    } catch (_) { /* skip a broken image */ }
    ny += sh + 10;
  }

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('OBSERVATIONS', M, ny + 6);
  ny += 13;

  const obsCount = Math.max(4, log.observations.length);
  for (let i = 0; i < obsCount; i++) {
    const obs = log.observations[i];
    const time = obs && obs.time ? obs.time + 'Z' : '______Z';
    const hobbs = obs && obs.hobbs ? obs.hobbs : '______';
    const coords = obs
      ? (pdfCoordPair(obs.lat, obs.lon, fmt) || '______ N  /  ______ W')
      : '______ N  /  ______ W';
    const head = 'Obs ' + (i + 1) + '    Time ' + time + '    Hobbs ' + hobbs + '    ' + coords;
    const body = obs ? pdfSafe(obs.text || '') : '';
    const bodyLines = body ? doc.splitTextToSize(body, CW - 10) : [];

    const photos = obs && Array.isArray(obs.photos)
      ? obs.photos
          .map(photo => ({ ...photo, src: safeImage(photo.data) }))
          .filter(photo => photo.src)
          .slice(0, 6)
      : [];
    const photoH = 52;
    const photoGap = 5;
    const photoRows = Math.ceil(photos.length / 3);
    const photoAreaH = photoRows ? photoRows * (photoH + photoGap) + 4 : 0;
    const boxH = Math.max(32, 17 + bodyLines.length * 9.2 + 4 + photoAreaH);

    if (ny + boxH > H - 40) {
      doc.addPage();
      pdfHeader(doc, 'Notes & Observations (continued)', mission + ' · Sortie ' + sortie, ['Printed ' + printed]);
      ny = 88;
    }

    doc.setFillColor(238, 243, 248);
    doc.rect(M, ny, CW, 15, 'F');
    doc.setDrawColor(170, 185, 198);
    doc.rect(M, ny, CW, boxH);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(navy[0], navy[1], navy[2]);
    doc.text(pdfSafe(head), M + 4, ny + 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.4);
    doc.setTextColor(dark[0], dark[1], dark[2]);
    if (bodyLines.length) doc.text(bodyLines, M + 5, ny + 22);

    if (photos.length) {
      let px = M + 5;
      let py = ny + 17 + bodyLines.length * 9.2 + 6;
      photos.forEach((photo, photoIndex) => {
        let pw = photo.w && photo.h ? photoH * (photo.w / photo.h) : photoH * 1.33;
        if (pw > 84) pw = 84;
        if (photoIndex > 0 && photoIndex % 3 === 0) {
          px = M + 5;
          py += photoH + photoGap;
        }
        try {
          const format = photo.src.startsWith('data:image/png') ? 'PNG' : 'JPEG';
          doc.addImage(photo.src, format, px, py, pw, photoH);
          doc.setDrawColor(170, 185, 198);
          doc.rect(px, py, pw, photoH);
        } catch (_) { /* skip a broken image */ }
        px += pw + photoGap;
      });
    }

    ny += boxH + 5;
  }

  if (ny + 82 > H - 30) {
    doc.addPage();
    pdfHeader(doc, 'Certification', mission + ' · Sortie ' + sortie, ['Printed ' + printed]);
    ny = 88;
  }

  ny += 2;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(navy[0], navy[1], navy[2]);
  doc.text('CERTIFICATION', M, ny + 6);
  ny += 14;

  const signature = safeImage(log.signoff.signature);
  if (signature) {
    try { doc.addImage(signature, 'JPEG', M, ny, 180, 43); } catch (_) { /* ignore */ }
  }

  doc.setDrawColor(60);
  doc.setLineWidth(0.7);
  doc.line(M, ny + 50, M + 200, ny + 50);
  doc.line(M + 220, ny + 50, M + 366, ny + 50);
  doc.line(M + 376, ny + 50, M + 446, ny + 50);
  doc.line(M + 456, ny + 50, W - M, ny + 50);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(dark[0], dark[1], dark[2]);
  if (log.signoff.name) doc.text(pdfSafe(log.signoff.name), M + 220, ny + 38);
  if (log.signoff.capid) doc.text(pdfSafe(log.signoff.capid), M + 376, ny + 38);
  doc.text(pdfSafe(log.signoff.dateTime || printed), M + 456, ny + 38);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(6);
  doc.setTextColor(grey[0], grey[1], grey[2]);
  doc.text('SIGNATURE', M, ny + 59);
  doc.text('PRINTED NAME', M + 220, ny + 59);
  doc.text('CAPID', M + 376, ny + 59);
  doc.text('DATE TIME (DDhhmmZ MMM YY)', M + 456, ny + 59);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(100);
  doc.text('Observer Mission Log · ' + mission + ' · Sortie ' + sortie, M, H - 22);
  doc.text('Notes & observations', W - M, H - 22, { align: 'right' });

  return doc.output('blob');
}

function exportPdf() {
  try {
    const blob = buildPdfBlob();
    shareFile(exportName('pdf'), blob).catch(err => {
      console.warn('PDF share failed', err);
      toast('PDF built, but sharing failed');
    });
    toast('PDF ready — choose Save to Files or Print');
  } catch (err) {
    console.warn('PDF build failed', err);
    toast('Could not build the PDF. Export a backup instead.');
  }
}

function resetAll() {
  if (!confirm('Erase every log stored on this iPad? Export a backup first if you need one.')) return;
  state = newState();
  applyTheme();
  closeSheet();
  activeTab = 'log';
  save();
  render();
  toast('All logs erased');
}

/* =========================================================================
   Print
   ========================================================================= */

function buildPrint() {
  const log = activeLog();
  const fmt = state.settings.coordFormat;
  const totals = timeTotals(log);

  const coordText = (latRaw, lonRaw) => {
    const lat = parseLat(latRaw);
    const lon = parseLon(lonRaw);
    if (lat == null || lon == null) return '—';
    return fmtCoord(lat, true, fmt) + ' / ' + fmtCoord(lon, false, fmt);
  };

  const cell = (label, value, extraClass) => `<div class="p-cell ${extraClass || ''}">
    <div class="pl">${esc(label)}</div>
    <div class="pv">${value ? esc(value) : '&nbsp;'}</div>
  </div>`;

  const crewRow = [
    ['Pilot', log.crew.pilot],
    ['Observer', log.crew.observer],
    ['AP', log.crew.ap],
    ['Scanner', log.crew.scanner]
  ].map(([label, value]) => cell(label, value)).join('');

  const headerCells = [
    cell('Mission', log.mission),
    cell('Sortie', log.sortie),
    cell('Aircraft N#', log.aircraft),
    cell('Callsign', log.callsign),
    cell('Base', log.base),
    cell('CAP flight', log.capFlight),
    cell('Sectional', log.sectional),
    cell('Grid', log.grid),
    cell('Altitude', log.altitude),
    cell('Airspeed', log.airspeed),
    cell('Entry point', coordText(log.entry.lat, log.entry.lon)),
    cell('Exit point', coordText(log.exit.lat, log.exit.lon)),
    cell('Main radio', log.radio.main),
    cell('Guard radio', log.radio.guard),
    cell('ATIS / AWOS', log.radio.atis),
    cell('CTAF', log.radio.ctaf)
  ].join('') + crewRow;

  const timesRows = TIME_DEFS.map(def => {
    const value = log.times[def.key] || {};
    return `<tr>
      <td class="lbl">${esc(def.label)}</td>
      <td class="t">${value.time ? esc(value.time + 'Z') : ''}</td>
      <td class="h">${value.hobbs ? esc(value.hobbs) : ''}</td>
    </tr>`;
  }).join('');

  const entries = log.entries.slice();
  const blankEntries = Math.max(0, 10 - entries.length);
  const entryRows = entries.map(entry => `<tr>
    <td class="c mono">${entry.time ? esc(entry.time + 'Z') : ''}</td>
    <td class="c mono">${esc(entry.hobbs || '')}</td>
    <td class="c mono">${esc(fmtCoord(parseLat(entry.lat), true, fmt) || '')}</td>
    <td class="c mono">${esc(fmtCoord(parseLon(entry.lon), false, fmt) || '')}</td>
    <td>${esc(entry.event || '')}</td>
    <td class="remark">${esc(entry.note || '')}</td>
  </tr>`).join('') +
    Array.from({ length: blankEntries }, () => '<tr><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('');

  const opsRows = log.ops.map((op, index) => `<tr>
    <td class="c">${index + 1}</td>
    <td class="c mono">${op.time ? esc(op.time + 'Z') : ''}</td>
    <td class="c mono">${esc(op.hobbs || '')}</td>
    <td>${esc(op.fuel || '')}</td>
    <td class="c mono">${esc(op.altimeter || '')}</td>
    <td class="c">${op.normal ? 'Normal' : 'Flagged'}</td>
  </tr>`).join('') +
    Array.from({ length: Math.max(0, 3 - log.ops.length) }, () => '<tr><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td></tr>').join('');

  const obsList = log.observations.slice();
  const obsBlocks = obsList.map((obs, index) => {
    const photos = (obs.photos || []).map(photo => safeImage(photo.data)).filter(Boolean);
    return `<div class="p-obs">
      <div class="p-obs-head">
        <b>Obs ${index + 1}</b>
        <span>Time ${obs.time ? esc(obs.time + 'Z') : '________'}</span>
        <span>Hobbs ${esc(obs.hobbs || '________')}</span>
        <span>${esc(coordPair(obs.lat, obs.lon, fmt) || '________ N  ________ W')}</span>
      </div>
      <div class="p-obs-body">${esc(obs.text || '')}</div>
      ${photos.length ? `<div class="p-obs-photos">${photos.map(src => `<img src="${src}" alt="">`).join('')}</div>` : ''}
    </div>`;
  }).join('') +
    Array.from({ length: Math.max(0, Math.min(4, 4 - obsList.length)) }, (_, i) => `<div class="p-obs">
      <div class="p-obs-head"><b>Obs ${obsList.length + i + 1}</b><span>Time ______Z</span><span>Hobbs ______</span><span>______ N  ______ W</span></div>
      <div class="p-obs-body">&nbsp;</div>
    </div>`).join('');

  const signatureSource = safeImage(log.signoff.signature);
  const signature = signatureSource
    ? `<img src="${signatureSource}" alt="Signature">`
    : '&nbsp;';
  const sketchSource = safeImage(log.sketch);

  const printDate = fmtDateZ(new Date());

  $('#print').innerHTML = `
    <section class="print-page">
      <div class="p-head">
        <div class="p-brand">
          <img class="p-emblem" src="icons/propeller.svg" alt="">
          <div>
            <div class="p-title">Observer Mission Log</div>
            <div class="p-sub">Civil Air Patrol · sortie record</div>
          </div>
        </div>
        <div class="p-head-right">
          <div><b>Printed</b> ${esc(printDate)}</div>
          <div><b>Entries</b> ${log.entries.length}</div>
        </div>
      </div>

      <div class="p-meta">${headerCells}</div>

      <div class="p-cols">
        <div class="p-section" style="margin-top:0">
          <div class="p-section-title">Flight times</div>
          <table class="p-table p-times">
            <thead><tr><th>Event</th><th class="c">Time (Z)</th><th class="c">Hobbs</th></tr></thead>
            <tbody>${timesRows}</tbody>
          </table>
        </div>
        <div class="p-section" style="margin-top:0">
          <div class="p-section-title">Totals</div>
          <div class="p-totals">
            <div class="p-total"><div class="tl">Flight time</div><div class="tv">${fmtDuration(totals.flight)}</div></div>
            <div class="p-total"><div class="tl">Engine run</div><div class="tv">${fmtDuration(totals.engine)}</div></div>
            <div class="p-total"><div class="tl">Total tach</div><div class="tv">${totals.tach == null ? '—' : fmtDecimal(totals.tach, 1)}</div></div>
            <div class="p-total"><div class="tl">Hobbs used</div><div class="tv">${totals.hobbs == null ? '—' : fmtDecimal(totals.hobbs, 1)}</div></div>
          </div>
          <div class="p-note">Tach start ${esc(log.times.tachStart || '________')} · Tach end ${esc(log.times.tachEnd || '________')}</div>
        </div>
      </div>

      <div class="p-section">
        <div class="p-section-title">Flight log</div>
        <table class="p-table">
          <thead><tr>
            <th style="width:9%">Time</th>
            <th style="width:10%">Hobbs</th>
            <th style="width:16%">Latitude N</th>
            <th style="width:17%">Longitude W</th>
            <th style="width:20%">Event</th>
            <th>Remarks</th>
          </tr></thead>
          <tbody>${entryRows}</tbody>
        </table>
      </div>

      <div class="p-section">
        <div class="p-section-title">OPS status checks</div>
        <table class="p-table">
          <thead><tr><th class="c" style="width:5%">#</th><th class="c" style="width:11%">Time</th><th class="c" style="width:11%">Hobbs</th><th style="width:18%">Fuel</th><th class="c" style="width:14%">Altimeter</th><th style="width:14%">Status</th></tr></thead>
          <tbody>${opsRows}</tbody>
        </table>
      </div>

      <div class="p-footer">
        <span>Observer Mission Log · ${esc(log.mission || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</span>
        <span>Sortie record</span>
      </div>
    </section>

    <section class="print-page">
      <div class="p-head">
        <div class="p-brand">
          <img class="p-emblem" src="icons/propeller.svg" alt="">
          <div>
            <div class="p-title">Notes &amp; Observations</div>
            <div class="p-sub">${esc(log.mission || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')} · ${esc(log.aircraft || 'No tail')}</div>
          </div>
        </div>
        <div class="p-head-right"><b>Printed</b> ${esc(printDate)}</div>
      </div>

      <div class="p-section" style="margin-top:0">
        <div class="p-section-title">Notes / sketches</div>
        <div class="p-notes-text">${esc(log.notes || '')}</div>
        ${sketchSource ? `<div class="p-sketch"><img src="${sketchSource}" alt="Sketch"></div>` : ''}
      </div>

      <div class="p-section">
        <div class="p-section-title">Observations</div>
        ${obsBlocks}
      </div>

      <div class="p-section">
        <div class="p-section-title">Certification</div>
        <div class="p-sign">
          <div class="sig-block">
            <div class="line">${signature}</div>
            <div class="cap">Signature</div>
          </div>
          <div class="sig-block">
            <div class="line">${log.signoff.name ? esc(log.signoff.name) : '&nbsp;'}</div>
            <div class="cap">Printed name</div>
          </div>
          <div class="sig-block">
            <div class="line">${log.signoff.capid ? esc(log.signoff.capid) : '&nbsp;'}</div>
            <div class="cap">CAPID</div>
          </div>
          <div class="sig-block">
            <div class="line">${log.signoff.dateTime ? esc(log.signoff.dateTime) : esc(fmtDateZ(new Date()))}</div>
            <div class="cap">Date time (DDhhmmZ MMM YY)</div>
          </div>
        </div>
      </div>

      <div class="p-footer">
        <span>Observer Mission Log · ${esc(log.mission || 'Untitled mission')} · Sortie ${esc(log.sortie || '—')}</span>
        <span>Notes &amp; observations</span>
      </div>
    </section>
  `;
}

/* =========================================================================
   Events
   ========================================================================= */

const actions = {
  'tab': el => {
    const tab = el.dataset.tab;
    if (tab) switchTab(tab);
  },
  'dismiss-intro': () => {
    state.settings.introDismissed = true;
    save();
    render();
  },
  'edit-mission': () => missionSheet(),
  'quick': el => {
    if (!el.dataset.kind) {
      openEntrySheet(null);
      return;
    }
    quickLog(el.dataset.kind, el.dataset.label || 'Log entry');
  },
  'add-entry': () => openEntrySheet(null),
  'edit-entry': el => openEntrySheet(el.dataset.id),
  'del-entry': el => {
    el.stopPropagation();
    deleteEntry(el.dataset.id);
  },
  'save-entry': el => saveEntryFromSheet(el.dataset.id || null),
  'delete-entry-sheet': el => deleteEntry(el.dataset.id),
  'fill-now': el => {
    const target = $(el.dataset.target);
    if (target) {
      target.value = nowZ();
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  },
  'fill-last-hobbs': el => {
    const target = $(el.dataset.target);
    if (target) {
      target.value = lastHobbs(activeLog());
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
  },
  'copy-entry': () => {
    const log = activeLog();
    const latInput = $('#overlay [data-bind="exit.lat"]');
    const lonInput = $('#overlay [data-bind="exit.lon"]');
    if (latInput) {
      latInput.value = log.entry.lat;
      latInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (lonInput) {
      lonInput.value = log.entry.lon;
      lonInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    toast('Exit point copied from entry');
  },
  'gps-sheet': async el => {
    const done = gpsBusy(el);
    try {
      const fix = await requestGps(true);
      fillCoordPair($('#f-lat'), $('#f-lon'), fix);
      const status = $('#gps-sheet-status');
      if (status) status.textContent = gpsStatusText(fix);
      toast('GPS position captured · ±' + Math.round(fix.accuracy) + ' m');
    } catch (err) {
      toast(gpsErrorText(err));
    } finally {
      done();
    }
  },
  'gps-obs': async el => {
    const log = activeLog();
    const obs = log.observations.find(o => o.id === el.dataset.id);
    if (!obs) return;
    const card = el.closest('.obs');
    const done = gpsBusy(el);
    try {
      const fix = await requestGps(true);
      applyGpsToObservation(obs, fix, card);
      save();
      toast('Observation position captured · ±' + Math.round(fix.accuracy) + ' m');
    } catch (err) {
      toast(gpsErrorText(err));
    } finally {
      done();
    }
  },
  'gps-mission': async el => {
    const target = el.dataset.target === 'exit' ? 'exit' : 'entry';
    const latInput = $('#overlay [data-bind="' + target + '.lat"]');
    const lonInput = $('#overlay [data-bind="' + target + '.lon"]');
    const status = $('#gps-mission-' + target + '-status');
    const done = gpsBusy(el);
    try {
      const fix = await requestGps(true);
      fillCoordPair(latInput, lonInput, fix);
      if (status) status.textContent = gpsStatusText(fix);
      toast((target === 'entry' ? 'Entry' : 'Exit') + ' point set from GPS · ±' + Math.round(fix.accuracy) + ' m');
    } catch (err) {
      toast(gpsErrorText(err));
    } finally {
      done();
    }
  },
  'mark-position': async el => {
    const done = gpsBusy(el);
    try {
      const fix = await requestGps(true);
      const log = activeLog();
      const entry = {
        id: uid(),
        kind: '',
        event: 'Position',
        time: nowZ(),
        hobbs: lastHobbs(log),
        lat: gpsCoordinateValue(fix.lat, true, state.settings.coordFormat),
        lon: gpsCoordinateValue(fix.lon, false, state.settings.coordFormat),
        note: '',
        createdAt: Date.now(),
        gpsAccuracy: Math.round(fix.accuracy),
        gpsTime: fmtZ(hhmmFromMs(fix.at))
      };
      log.entries.push(entry);
      save();
      render();
      toast('Position marked · ±' + Math.round(fix.accuracy) + ' m', 'Details', () => openEntrySheet(entry.id));
    } catch (err) {
      toast(gpsErrorText(err));
      openEntrySheet(null, { event: 'Position' });
    } finally {
      done();
    }
  },
  'toggle-gps-auto': async el => {
    if (state.settings.gpsAuto) {
      state.settings.gpsAuto = false;
      save();
      settingsSheet();
      return;
    }
    const done = gpsBusy(el);
    try {
      const fix = await requestGps(true);
      state.settings.gpsAuto = true;
      save();
      settingsSheet();
      toast('Auto GPS is on · ±' + Math.round(fix.accuracy) + ' m');
    } catch (err) {
      toast(gpsErrorText(err));
      done();
    }
  },
  'add-obs': () => addObservation(),
  'del-obs': el => {
    const log = activeLog();
    const index = log.observations.findIndex(o => o.id === el.dataset.id);
    if (index < 0) return;
    const [removed] = log.observations.splice(index, 1);
    save();
    render();
    toast('Observation deleted', 'Undo', () => {
      log.observations.splice(index, 0, removed);
      save();
      render();
    });
  },
  'add-photo': el => addObservationPhoto(el.dataset.obs),
  'view-photo': el => viewObservationPhoto(el.dataset.obs, Number(el.dataset.index)),
  'delete-photo': el => deleteObservationPhoto(el.dataset.obs, el.dataset.photo),
  'ops-add': () => addOpsCheck(),
  'del-ops': el => {
    const log = activeLog();
    const index = log.ops.findIndex(o => o.id === el.dataset.id);
    if (index < 0) return;
    const [removed] = log.ops.splice(index, 1);
    save();
    render();
    toast('OPS check deleted', 'Undo', () => {
      log.ops.splice(index, 0, removed);
      save();
      render();
    });
  },
  'toggle-ops': el => {
    const log = activeLog();
    const op = log.ops.find(o => o.id === el.dataset.id);
    if (!op) return;
    op.normal = !op.normal;
    save();
    render();
  },
  'add-navaid': () => {
    const log = activeLog();
    log.navAids.push({ ident: '', freq: '', radial: '' });
    save();
    render();
  },
  'del-navaid': el => {
    const log = activeLog();
    log.navAids.splice(Number(el.dataset.index), 1);
    save();
    render();
  },
  'switch-log': el => switchLog(el.dataset.id),
  'new-log': () => createLog(),
  'dup-log': () => duplicateLog(),
  'del-log': () => deleteLog(),
  'menu': () => menuSheet(),
  'settings': () => settingsSheet(),
  'help': () => helpSheet(),
  'print': () => printLog(),
  'export-json': () => { closeSheet(); exportJSON(); },
  'export-csv': () => { closeSheet(); exportCSV(); },
  'import-json': () => { closeSheet(); importJSON(); },
  'set-theme': el => {
    state.settings.theme = el.dataset.value;
    applyTheme();
    save();
    settingsSheet();
  },
  'set-coord': el => {
    state.settings.coordFormat = el.dataset.value;
    save();
    settingsSheet();
  },
  'toggle-wake': () => {
    state.settings.keepAwake = !state.settings.keepAwake;
    syncWakeLock();
    save();
    settingsSheet();
  },
  'toggle-finger': () => {
    state.settings.fingerDraw = !state.settings.fingerDraw;
    if (activeTab === 'notes') {
      if (sketchCtl) sketchCtl.flush();
      if (sigCtl) sigCtl.flush();
    }
    applyTheme();
    save();
    if ($('#overlay').classList.contains('show')) settingsSheet();
    else if (activeTab === 'notes') render();
  },
  'set-finger-mode': el => {
    const next = el.dataset.value === '1';
    if (state.settings.fingerDraw === next) return;
    state.settings.fingerDraw = next;
    if (sketchCtl) sketchCtl.flush();
    if (sigCtl) sigCtl.flush();
    applyTheme();
    save();
    render();
  },
  'reset-all': () => resetAll(),
  'sign-now': () => {
    const log = activeLog();
    log.signoff.dateTime = fmtDateZ(new Date());
    save();
    const input = $('[data-bind="signoff.dateTime"]');
    if (input) input.value = log.signoff.dateTime;
    toast('Date time stamped');
  },
  'clear-sign': () => {
    if (sigCtl) sigCtl.clear();
    toast('Signature cleared');
  },
  'pen': el => {
    if (sketchCtl) sketchCtl.setColor(el.dataset.color);
  },
  'eraser': () => {
    if (sketchCtl) sketchCtl.setEraser();
  },
  'undo-sketch': () => {
    if (sketchCtl) sketchCtl.undo();
  },
  'clear-sketch': () => {
    if (!confirm('Clear the sketch pad?')) return;
    if (sketchCtl) sketchCtl.clear();
  }
};

function switchTab(tab) {
  if (!['log', 'times', 'obs', 'notes'].includes(tab)) return;
  if (activeTab === 'notes') {
    if (sketchCtl) sketchCtl.flush();
    if (sigCtl) sigCtl.flush();
  }
  activeTab = tab;
  render();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

document.addEventListener('click', event => {
  const closeBtn = event.target.closest('[data-close]');
  if (closeBtn) {
    closeSheet();
    return;
  }

  const tabBtn = event.target.closest('#tabbar [data-tab]');
  if (tabBtn) {
    switchTab(tabBtn.dataset.tab);
    return;
  }

  const el = event.target.closest('[data-act]');
  if (!el) return;
  const name = el.dataset.act;
  if (!actions[name]) return;
  event.preventDefault();
  actions[name](el, event);
});

document.addEventListener('input', event => {
  const el = event.target;
  if (el.matches('textarea[data-autogrow]')) autoGrow(el);

  const bound = el.closest('[data-bind]');
  if (!bound) return;

  const path = bound.dataset.bind;
  if (path === 'sheet.lat' || path === 'sheet.lon') {
    // Sheet-local helper fields are read on save.
    return;
  }

  if (path.startsWith('settings.')) setPath(state, path, el.value);
  else setPath(activeLog(), path, el.value);

  if (el.matches('[data-coord]')) updateCoordHelp(el);
  if (/^(mission|sortie|aircraft|callsign|crew\.)/.test(path)) renderStrip();

  save();
});

document.addEventListener('change', event => {
  const el = event.target.closest('[data-bind]');
  if (!el) return;
  const path = el.dataset.bind;
  const kind = el.dataset.norm;

  if (kind === 'time') {
    const normalized = normTime(el.value);
    if (normalized && !isValidTime(normalized)) {
      el.classList.add('invalid');
      return;
    }
    el.classList.remove('invalid');
    el.value = normalized;
    const target = path.startsWith('settings.') ? state : activeLog();
    setPath(target, path, normalized);
    const match = path.match(/^times\.(\w+)\.time$/);
    if (match) syncLinkedTime(match[1], 'time', normalized);
    save();
    updateOutputs();
  } else if (kind === 'hobbs') {
    el.value = el.value.trim();
    const target = path.startsWith('settings.') ? state : activeLog();
    setPath(target, path, el.value);
    const match = path.match(/^times\.(\w+)\.hobbs$/);
    if (match) syncLinkedTime(match[1], 'hobbs', el.value);
    save();
    updateOutputs();
  } else if (kind === 'coord') {
    const isLat = el.dataset.coord === 'lat';
    const value = el.value.trim();
    if (value && (isLat ? parseLat(value) : parseLon(value)) == null) el.classList.add('invalid');
    else el.classList.remove('invalid');
    updateCoordHelp(el);
  } else if (path === 'settings.opsInterval') {
    let value = Math.round(num(el.value) || 30);
    value = Math.min(180, Math.max(5, value));
    el.value = value;
    state.settings.opsInterval = value;
    save();
    render();
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if ($('#overlay').classList.contains('show')) closeSheet();
    else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    const saveBtn = $('#overlay [data-act="save-entry"]');
    if (saveBtn) saveBtn.click();
  }
});

$('#overlay').addEventListener('click', event => {
  if (event.target.id === 'overlay') closeSheet();
});

/* =========================================================================
   Boot
   ========================================================================= */

async function boot() {
  let loaded = null;
  try {
    loaded = await readState();
  } catch (err) {
    console.warn('load failed', err);
  }

  state = loaded ? normalizeState(loaded) : newState();
  applyTheme();
  render();

  setSaveStatus('saved', loaded ? 'Saved ' + fmtClock(state.savedAt ? new Date(state.savedAt) : new Date()) : 'On this device');
  if (!loaded) save();

  // Re-check the theme when the system changes while set to Auto.
  if (window.matchMedia) {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (state.settings.theme === 'auto') applyTheme(); };
    if (query.addEventListener) query.addEventListener('change', onChange);
    else if (query.addListener) query.addListener(onChange);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) mirrorState();
    else if (state.settings.keepAwake && !wakeLock) syncWakeLock();
  });
  window.addEventListener('pagehide', mirrorState);

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  preloadPdfLogo();
  syncWakeLock();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const register = () => {
      navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW registration failed', err));
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }
}

boot();
