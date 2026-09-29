// Panasonic Comfort Cloud (inoffiziell): liest Klimaanlagen aus der
// Comfort-Cloud-App und steuert sie. Nachgebaut nach dem Ablauf der App bzw.
// der Community-Bibliothek python-panasonic-comfort-cloud (Auth0-Login mit
// PKCE, danach accsmart.panasonic.com mit signiertem API-Key-Header).
//
// ⚠️ Keine offizielle API - Panasonic hat den Ablauf schon mehrfach ohne
// Ankündigung geändert (App-Version, Login). Fehler werden deshalb nie
// verschluckt, sondern bis ins Dashboard durchgereicht.
//
// Zugangsdaten liegen NUR als Worker-Secrets (PANASONIC_USER / PANASONIC_PASS),
// Tokens in Workers KV (TADO_KV). Nach einem fehlgeschlagenen Login pausiert
// der Worker 30 Minuten, damit ein falsches Passwort den Panasonic-Account
// nicht durch den 5-Minuten-Cron sperrt.

const BASE_AUTH = 'https://authglb.digital.panasonic.com';
const BASE_ACC = 'https://accsmart.panasonic.com';
const APP_CLIENT_ID = 'Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx';
const AUTH0_CLIENT = 'eyJuYW1lIjoiQXV0aDAuQW5kcm9pZCIsImVudiI6eyJhbmRyb2lkIjoiMzAifSwidmVyc2lvbiI6IjIuOS4zIn0=';
const REDIRECT_URI = 'panasonic-iot-cfc://authglb.digital.panasonic.com/android/com.panasonic.ACCsmart/callback';
const API_KEY_SECRET = '521325fb2dd486bf4831b47644317fca';
const FALLBACK_APP_VERSION = '1.22.0';
const SCOPE = 'openid offline_access comfortcloud.control a2w.control';
const AUDIENCE = `https://digital.panasonic.com/${APP_CLIENT_ID}/api/v1/`;

const SESSION_KV_KEY = 'panasonic_session';
const BLOCK_KV_KEY = 'panasonic_login_block';
const LOGIN_BLOCK_MS = 30 * 60 * 1000;
// Wird in den Block-Fingerabdruck einbezogen: ein neuer Login-Ablauf im Code
// hebt eine alte Pause auf.
const LOGIN_FLOW_VERSION = 2;
const APP_VERSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Panasonic-Zahlencodes (siehe python-panasonic-comfort-cloud/constants.py)
const MODE_FROM_CODE = { 0: 'AUTO', 1: 'DRY', 2: 'COOL', 3: 'HEAT', 4: 'FAN' };
const MIN_TEMP = 16;
const MAX_TEMP = 30;

export const PANASONIC_HOME_ID = 'panasonic';

export function isPanasonicConfigured(env) {
  return Boolean(env.PANASONIC_USER && env.PANASONIC_PASS);
}

/* ---------- Hilfsfunktionen ---------- */

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// "YYYY-MM-DD HH:mm:ss" (UTC) und derselbe Zeitpunkt in ms - beide fließen
// in Header bzw. API-Key ein und müssen zusammenpassen.
function appTimestamp(date) {
  const str = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const ms = Math.floor(date.getTime() / 1000) * 1000;
  return { str, ms };
}

async function apiKey(tsMs, accessToken) {
  const hash = await sha256Hex(`Comfort Cloud${API_KEY_SECRET}${tsMs}Bearer ${accessToken}`);
  return hash.slice(0, 9) + 'cfc' + hash.slice(9);
}

async function apiHeaders(session, includeClientId = true) {
  const now = new Date();
  const ts = appTimestamp(now);
  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    'User-Agent': 'G-RAC',
    'x-app-name': 'Comfort Cloud',
    'x-app-timestamp': ts.str,
    'x-app-type': '1',
    'x-app-version': session.app_version,
    'x-cfc-api-key': await apiKey(ts.ms, session.access_token),
    'x-user-authorization-v2': `Bearer ${session.access_token}`,
  };
  if (includeClientId) headers['x-client-id'] = session.acc_client_id;
  return headers;
}

function decodeEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Liest alle <input type="hidden" name=".." value=".."> aus der Login-
// Antwort (wa / wresult / wctx für den Callback-Schritt).
function parseHiddenInputs(html) {
  const out = {};
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    if (!/type\s*=\s*["']hidden["']/i.test(tag)) continue;
    const name = /name\s*=\s*"([^"]*)"/i.exec(tag) || /name\s*=\s*'([^']*)'/i.exec(tag);
    const value = /value\s*=\s*"([^"]*)"/i.exec(tag) || /value\s*=\s*'([^']*)'/i.exec(tag);
    if (name) out[decodeEntities(name[1])] = value ? decodeEntities(value[1]) : '';
  }
  return out;
}

// Minimaler Cookie-Speicher für den Auth0-Login (Workers haben keinen).
function makeJar() {
  const cookies = {};
  return {
    get(name) { return cookies[name]; },
    header() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '); },
    add(res) {
      const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const line of lines) {
        const pair = line.split(';')[0];
        const i = pair.indexOf('=');
        if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
    },
  };
}

async function jarFetch(jar, url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { ...options, headers, redirect: 'manual' });
  jar.add(res);
  return res;
}

async function expectStatus(res, expected, step) {
  if (res.status === expected) return;
  const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  const err = new Error(`Panasonic ${step}: Status ${res.status} statt ${expected}${detail ? ' - ' + detail : ''}`);
  err.status = res.status;
  err.step = step;
  throw err;
}

function queryParam(location, name) {
  return new URL(location, BASE_AUTH).searchParams.get(name);
}

/* ---------- App-Version (Panasonic prüft sie serverseitig) ---------- */

async function detectAppVersion(env) {
  if (env.PANASONIC_APP_VERSION) return env.PANASONIC_APP_VERSION;
  try {
    const res = await fetch('https://play.google.com/store/apps/details?id=com.panasonic.ACCsmart');
    const text = await res.text();
    const match = /\["(\d+\.\d+\.\d+)"\]/.exec(text);
    if (match) return match[1];
  } catch (e) {
    // fällt auf den Standardwert zurück
  }
  return FALLBACK_APP_VERSION;
}

/* ---------- Login / Session ---------- */

async function login(env) {
  const jar = makeJar();
  const state = randomString(20);
  const codeVerifier = randomString(43);
  const codeChallenge = base64Url(new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  ));
  const appVersion = await detectAppVersion(env);

  // 1. authorize -> Redirect auf die Login-Seite
  const authorizeParams = new URLSearchParams({
    scope: SCOPE,
    audience: AUDIENCE,
    protocol: 'oauth2',
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    auth0Client: AUTH0_CLIENT,
    client_id: APP_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state,
  });
  let res = await jarFetch(jar, `${BASE_AUTH}/authorize?${authorizeParams}`, {
    headers: { 'User-Agent': 'okhttp/4.10.0' },
  });
  await expectStatus(res, 302, 'authorize');
  const loginState = queryParam(res.headers.get('Location'), 'state') || state;

  res = await jarFetch(jar, new URL(res.headers.get('Location'), BASE_AUTH + '/').toString());
  await expectStatus(res, 200, 'authorize_redirect');
  const csrf = jar.get('_csrf');
  if (!csrf) throw new Error('Panasonic authorize_redirect: kein _csrf-Cookie erhalten (Login-Ablauf geändert?)');

  // 2. Benutzername/Passwort
  res = await jarFetch(jar, `${BASE_AUTH}/usernamepassword/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Auth0-Client': AUTH0_CLIENT, 'User-Agent': 'okhttp/4.10.0' },
    body: JSON.stringify({
      client_id: APP_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      tenant: 'pdpauthglb-a1',
      response_type: 'code',
      scope: SCOPE,
      audience: AUDIENCE,
      _csrf: csrf,
      state: loginState,
      _intstate: 'deprecated',
      username: env.PANASONIC_USER,
      password: env.PANASONIC_PASS,
      lang: 'en',
      connection: 'PanasonicID-Authentication',
    }),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    // Auth0 liefert den Grund im Body (z. B. invalid_user_password). 400 kann
    // auch ein Ablauf-Problem sein und nicht zwingend falsche Zugangsdaten.
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    const err = new Error(`Panasonic-Login abgelehnt (Status ${res.status})${detail ? ' - ' + detail : ''}`);
    err.credentials = res.status !== 400;
    throw err;
  }
  await expectStatus(res, 200, 'login');
  const hidden = parseHiddenInputs(await res.text());
  if (!hidden.wresult) throw new Error('Panasonic login: Antwort enthielt kein wresult (Login-Ablauf geändert?)');

  // 3. Callback + Redirects bis zum Authorization-Code
  res = await jarFetch(jar, `${BASE_AUTH}/login/callback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36',
    },
    body: new URLSearchParams(hidden).toString(),
  });
  await expectStatus(res, 302, 'login_callback');
  res = await jarFetch(jar, new URL(res.headers.get('Location'), BASE_AUTH + '/').toString());
  await expectStatus(res, 302, 'login_redirect');
  const code = queryParam(res.headers.get('Location'), 'code');
  if (!code) throw new Error('Panasonic login_redirect: kein Authorization-Code erhalten');

  // 4. Code gegen Token tauschen
  res = await fetch(`${BASE_AUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Auth0-Client': AUTH0_CLIENT, 'User-Agent': 'okhttp/4.10.0' },
    body: JSON.stringify({
      scope: 'openid',
      client_id: APP_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
    redirect: 'manual',
  });
  await expectStatus(res, 200, 'get_token');
  const tokens = await res.json();

  // 5. Comfort-Cloud-Client-ID holen
  const session = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in - 60) * 1000,
    scope: tokens.scope,
    app_version: appVersion,
    acc_client_id: null,
  };
  res = await fetch(`${BASE_ACC}/auth/v2/login`, {
    method: 'POST',
    headers: await apiHeaders(session, false),
    body: JSON.stringify({ language: 0 }),
  });
  await expectStatus(res, 200, 'get_acc_client_id');
  session.acc_client_id = (await res.json()).clientId;
  if (!session.acc_client_id) throw new Error('Panasonic get_acc_client_id: keine clientId in der Antwort');
  return session;
}

async function refresh(session) {
  const res = await fetch(`${BASE_AUTH}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Auth0-Client': AUTH0_CLIENT, 'User-Agent': 'okhttp/4.10.0' },
    body: JSON.stringify({
      scope: session.scope,
      client_id: APP_CLIENT_ID,
      refresh_token: session.refresh_token,
      grant_type: 'refresh_token',
    }),
    redirect: 'manual',
  });
  if (!res.ok) return null;
  const tokens = await res.json();
  return {
    ...session,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || session.refresh_token,
    expires_at: Date.now() + (tokens.expires_in - 60) * 1000,
    scope: tokens.scope || session.scope,
  };
}

async function getSession(env, forceRelogin = false) {
  let session = null;
  if (!forceRelogin) {
    const raw = await env.TADO_KV.get(SESSION_KV_KEY);
    session = raw ? JSON.parse(raw) : null;
    if (session && Date.now() < session.expires_at) return session;
    if (session) {
      const refreshed = await refresh(session);
      if (refreshed) {
        await env.TADO_KV.put(SESSION_KV_KEY, JSON.stringify(refreshed));
        return refreshed;
      }
    }
  }

  // Die Pause gilt nur für dieselben Zugangsdaten und denselben Login-Code:
  // wer die Secrets korrigiert oder neu deployt, muss nicht warten.
  const fingerprint = await sha256Hex(`${LOGIN_FLOW_VERSION}|${env.PANASONIC_USER}|${env.PANASONIC_PASS}`);
  const blockRaw = await env.TADO_KV.get(BLOCK_KV_KEY);
  if (blockRaw) {
    const block = JSON.parse(blockRaw);
    if (block.fingerprint === fingerprint && Date.now() < block.until) {
      throw new Error(`Panasonic-Login pausiert (${block.reason}) - nächster Versuch gegen ${new Date(block.until).toISOString().slice(11, 16)} UTC.`);
    }
  }

  try {
    session = await login(env);
  } catch (err) {
    await env.TADO_KV.put(BLOCK_KV_KEY, JSON.stringify({
      until: Date.now() + LOGIN_BLOCK_MS,
      fingerprint,
      reason: err.message.slice(0, 300),
    }), { expirationTtl: 3600 });
    throw err;
  }
  await env.TADO_KV.delete(BLOCK_KV_KEY);
  await env.TADO_KV.put(SESSION_KV_KEY, JSON.stringify(session));
  return session;
}

/* ---------- API-Aufrufe ---------- */

async function accRequest(env, method, path, body) {
  let session = await getSession(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${BASE_ACC}${path}`, {
      method,
      headers: await apiHeaders(session),
      body: body ? JSON.stringify(body) : undefined,
    });
    // Token serverseitig ungültig geworden -> einmal komplett neu einloggen
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      session = await getSession(env, true);
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`Panasonic ${method} ${path.split('/').slice(0, 3).join('/')} -> ${res.status}${detail ? ' - ' + detail : ''}`);
    }
    return res.json();
  }
  throw new Error('Panasonic: Anfrage nach erneutem Login weiterhin abgelehnt.');
}

// Replik von Pythons quote_plus (+ der Eigenheit der Bibliothek, "%2f" -> "f").
function guidPath(guid) {
  return encodeURIComponent(guid)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%20/g, '+')
    .replace(/%2f/gi, 'f');
}

async function listDevices(env) {
  const groups = await accRequest(env, 'GET', '/device/group');
  const devices = [];
  for (const group of groups.groupList || []) {
    for (const device of group.deviceList || group.deviceIdList || []) {
      if (!device || !device.deviceGuid) continue;
      devices.push({
        id: device.deviceHashGuid || device.deviceGuid,
        guid: device.deviceGuid,
        name: device.deviceName || group.groupName || 'Klimaanlage',
      });
    }
  }
  return devices;
}

function validTemp(value) {
  return typeof value === 'number' && value > -50 && value < 100 ? value : null;
}

function mapDevice(device, status) {
  const p = (status && status.parameters) || {};
  const on = p.operate === 1;
  return {
    id: device.id,
    name: device.name,
    type: 'AC',
    power: on ? 'ON' : 'OFF',
    targetTemp: validTemp(p.temperatureSet),
    currentTemp: validTemp(p.insideTemperature),
    humidity: null,
    heatingPower: null,
    // Panasonic liefert keine Verdichter-Leistung - deshalb nur ON/OFF und
    // noPowerData, damit das Frontend keine erfundene Leistung/Laufzeit zeigt.
    acPower: on ? 'ON' : 'OFF',
    noPowerData: true,
    mode: MODE_FROM_CODE[p.operationMode] || null,
    fanLevel: null,
    openWindow: false,
    link: null,
    manualOverride: false,
    nextScheduleChange: null,
    batteryLow: false,
    deviceOffline: false,
    hasBatteryInfo: false,
    homeId: PANASONIC_HOME_ID,
    homeName: 'Panasonic',
    key: `${PANASONIC_HOME_ID}:${device.id}`,
  };
}

// Liefert { zones, error } - Fehler blockieren nie das restliche Dashboard.
export async function fetchPanasonicZones(env) {
  if (!isPanasonicConfigured(env)) return { zones: [], error: null };
  try {
    const devices = await listDevices(env);
    const zones = await Promise.all(devices.map(async (device) => {
      const status = await accRequest(env, 'GET', `/deviceStatus/${guidPath(device.guid)}`);
      return mapDevice(device, status);
    }));
    return { zones, error: null };
  } catch (err) {
    return { zones: [], error: err.message };
  }
}

// Schaltet ein Gerät ein/aus oder setzt die Zieltemperatur. Modus und
// Lüfterstufe bleiben unverändert (es werden nur die genannten Felder gesendet).
export async function setPanasonicDevice(env, deviceId, { power, temperature }) {
  if (!isPanasonicConfigured(env)) {
    throw new Error('Panasonic ist nicht konfiguriert (Secrets PANASONIC_USER / PANASONIC_PASS fehlen).');
  }
  const devices = await listDevices(env);
  const device = devices.find((d) => String(d.id) === String(deviceId));
  if (!device) throw new Error('Panasonic-Gerät nicht gefunden.');

  const parameters = {};
  if (power === 'OFF') {
    parameters.operate = 0;
  } else if (power === 'ON') {
    parameters.operate = 1;
  }
  if (temperature != null) {
    const t = Math.min(MAX_TEMP, Math.max(MIN_TEMP, Number(temperature)));
    if (Number.isNaN(t)) throw new Error('Ungültige Temperatur.');
    parameters.temperatureSet = t;
  }
  if (!Object.keys(parameters).length) throw new Error('Nichts zu setzen.');

  await accRequest(env, 'POST', '/deviceStatus/control', { deviceGuid: device.guid, parameters });
}
