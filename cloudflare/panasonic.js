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
// Tokens in Workers KV (TADO_KV). Panasonic verlangt beim Login einen
// Bestätigungscode (MFA): der Login läuft deshalb NIE automatisch, sondern
// nur auf Knopfdruck im Dashboard (/api/panasonic/login/start und
// /verify). Danach hält der Refresh-Token die Verbindung.

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
// Zwischenstand eines Logins, der auf den Bestätigungscode wartet.
const PENDING_KV_KEY = 'panasonic_login_pending';
const PENDING_TTL_SECONDS = 600;

// Panasonic-Zahlencodes (siehe python-panasonic-comfort-cloud/constants.py)
const MODE_CODES = { AUTO: 0, DRY: 1, COOL: 2, HEAT: 3, FAN: 4 };
const FAN_CODES = { AUTO: 0, LOW: 1, LOWMID: 2, MID: 3, HIGHMID: 4, HIGH: 5 };
const ECO_CODES = { AUTO: 0, POWERFUL: 1, QUIET: 2 };
// Luftrichtung: senkrecht (UD) / waagrecht (LR). "Auto" steckt bei Panasonic
// nicht im Positionswert, sondern in fanAutoMode (0 = beide Auto, 2 = nur
// UD Auto, 3 = nur LR Auto, 1 = keine). LR-Wert 6 heißt "nicht vorhanden".
const SWING_UD_CODES = { UP: 0, DOWN: 1, MID: 2, UPMID: 3, DOWNMID: 4, SWING: 5 };
const SWING_LR_CODES = { RIGHT: 0, LEFT: 1, MID: 2, RIGHTMID: 4, LEFTMID: 5 };
const LR_UNAVAILABLE = 6;
const DEFAULT_ON_TEMP = 20;
const invert = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k]));
const MODE_FROM_CODE = invert(MODE_CODES);
const FAN_FROM_CODE = invert(FAN_CODES);
const ECO_FROM_CODE = invert(ECO_CODES);
const SWING_UD_FROM_CODE = invert(SWING_UD_CODES);
const SWING_LR_FROM_CODE = invert(SWING_LR_CODES);
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
    Accept: 'application/json; charset=utf-8',
    'Content-Type': 'application/json',
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
// Lässt sich in KV ablegen, damit der Login nach dem Bestätigungscode auf
// derselben Auth0-Sitzung weiterläuft.
function makeJar(initial = {}) {
  const cookies = { ...initial };
  return {
    get(name) { return cookies[name]; },
    dump() { return { ...cookies }; },
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

// Für Fehlermeldungen: Ziel ohne Parameterwerte (Codes/States bleiben
// geheim), nur error/error_description im Klartext.
function describeUrl(url) {
  const names = Array.from(url.searchParams.keys()).join(',');
  const err = ['error', 'error_description']
    .filter((k) => url.searchParams.get(k))
    .map((k) => `${k}=${url.searchParams.get(k)}`)
    .join('; ');
  return `${url.protocol}//${url.host}${url.pathname} [Parameter: ${names || '-'}]${err ? ' ' + err : ''}`;
}

function queryParam(location, name) {
  return new URL(location, BASE_AUTH).searchParams.get(name);
}

/* ---------- App-Version (Panasonic prüft sie serverseitig) ---------- */

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MIN_PLAUSIBLE_VERSION = [1, 21, 0];

function plausibleVersion(v) {
  if (!VERSION_RE.test(v)) return false;
  const parts = v.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (parts[i] > MIN_PLAUSIBLE_VERSION[i]) return true;
    if (parts[i] < MIN_PLAUSIBLE_VERSION[i]) return false;
  }
  return true;
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(4000) });
  return res.text();
}

// Liefert die App-Versionen, die für den Header probiert werden (in dieser
// Reihenfolge). Panasonic weist unbekannte/zu alte Versionen ab; die
// Erkennung über die Store-Seiten kann aus dem Worker heraus scheitern oder
// Unsinn liefern, deshalb gibt es mehrere Quellen und feste Rückfallwerte.
async function detectAppVersions(env) {
  const found = [];
  if (env.PANASONIC_APP_VERSION) found.push(String(env.PANASONIC_APP_VERSION).trim());

  const sources = await Promise.allSettled([
    fetchText('https://play.google.com/store/apps/details?id=com.panasonic.ACCsmart&hl=en')
      .then((t) => (/\["(\d+\.\d+\.\d+)"\]/.exec(t) || [])[1]),
    fetchText('https://www.appbrain.com/app/panasonic-comfort-cloud/com.panasonic.ACCsmart')
      .then((t) => (/itemprop="softwareVersion"[^>]*content="([^"]+)"|content="([^"]+)"[^>]*itemprop="softwareVersion"/i.exec(t) || []).slice(1).find(Boolean)),
  ]);
  for (const r of sources) {
    if (r.status === 'fulfilled' && r.value) found.push(String(r.value).trim());
  }
  found.push(FALLBACK_APP_VERSION, '1.21.0');

  const seen = new Set();
  return found.filter((v) => {
    if (seen.has(v) || !VERSION_RE.test(v)) return false;
    // Nur automatisch erkannte Werte auf Plausibilität prüfen; ein
    // ausdrücklich gesetzter Wert (PANASONIC_APP_VERSION) gilt immer.
    if (v !== env.PANASONIC_APP_VERSION && !plausibleVersion(v)) return false;
    seen.add(v);
    return true;
  });
}

/* ---------- Login / Session ---------- */

function loginRequiredError(message) {
  const err = new Error(message || 'Panasonic ist nicht angemeldet.');
  err.loginRequired = true;
  return err;
}

// Auth0-Guardian-Widget ("MFA Standard"): Konfiguration steckt als JS-Objekt
// (window.__g_config) im HTML und ist kein gültiges JSON.
function extractGuardianConfig(html) {
  if (!html.includes('__g_config')) return null;
  const config = {};
  for (const key of ['postActionURL', 'serviceUrl', 'requestToken', 'stateCheckingMechanism']) {
    const match = new RegExp(`${key}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(html);
    if (match) config[key] = match[1];
  }
  if (!config.requestToken || !config.serviceUrl || !config.postActionURL) return null;
  return config;
}

const guardianHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

// Wie das Guardian-Widget beim Öffnen der Seite: start-flow. Das stößt bei
// Panasonic den Versand von Code bzw. Push-Freigabe an. Liefert
// { transactionToken, info } - info sind die (ungefährlichen) Felder der
// Antwort für den Hinweistext.
async function guardianStartFlow(g) {
  const res = await fetch(`${g.serviceUrl}/api/start-flow`, {
    method: 'POST',
    headers: guardianHeaders(g.requestToken),
    body: JSON.stringify({ state_transport: 'polling' }),
  });
  if (![200, 201, 204].includes(res.status)) {
    throw new Error(`Panasonic guardian_start_flow: Status ${res.status}`);
  }
  const body = await res.json().catch(() => ({}));
  const transactionToken = body.transactionToken || body.transaction_token;
  if (!transactionToken) throw new Error('Panasonic guardian_start_flow: kein transactionToken erhalten');
  const safe = {};
  for (const [k, v] of Object.entries(body)) {
    if (/token|signature/i.test(k)) continue;
    safe[k] = v;
  }
  return { transactionToken, info: JSON.stringify(safe).slice(0, 200) };
}

// Erkennt, ob eine Seite ein MFA-Challenge ist, und liefert dafür den
// Zwischenstand (oder null).
function detectChallenge(html) {
  const hidden = parseHiddenInputs(html);
  if (hidden.mfa_token) return { kind: 'otp', mfaToken: hidden.mfa_token };
  const guardian = extractGuardianConfig(html);
  if (guardian) return { kind: 'guardian', guardian };
  return null;
}

// Sichtbarer Text einer Seite (für den Hinweis neben dem Code-Feld).
function pageText(html, max = 300) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Für Fehlermeldungen bei unbekannten Seiten: Titel, Feldnamen, Textanfang.
function describePage(html, url) {
  const title = (/<title[^>]*>([^<]*)/i.exec(html) || [])[1];
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  const names = Object.keys(parseHiddenInputs(html)).join(',');
  return `${describeUrl(url)} | Titel: ${title ? title.trim() : '-'} | Felder: ${names || '-'} | Text: ${text || '-'}`;
}

// Comfort-Cloud-Client-ID holen. Probiert die App-Versionen der Reihe nach,
// solange Panasonic den Header ablehnt (400 "bad header" bzw. 401 4106 =
// neue App-Version veröffentlicht); die funktionierende Version wird in der
// Sitzung gespeichert.
async function fetchAccClientId(session, appVersions) {
  const tried = [];
  let lastDetail = '';
  for (const version of appVersions) {
    session.app_version = version;
    const res = await fetch(`${BASE_ACC}/auth/v2/login`, {
      method: 'POST',
      headers: await apiHeaders(session, false),
      body: JSON.stringify({ language: 0 }),
    });
    if (res.status === 200) {
      const clientId = (await res.json()).clientId;
      if (!clientId) throw new Error('Panasonic get_acc_client_id: keine clientId in der Antwort');
      return clientId;
    }
    lastDetail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    tried.push(`${version}→${res.status}`);
    if (res.status !== 400 && res.status !== 401) break;
  }
  throw new Error(`Panasonic get_acc_client_id fehlgeschlagen (App-Versionen: ${tried.join(', ')}) - ${lastDetail}`
    + ' - ggf. PANASONIC_APP_VERSION als Variable setzen.');
}

// Token-Antwort -> gespeicherte Sitzung (inkl. Comfort-Cloud-Client-ID).
async function buildSession(env, tokens, appVersions) {
  const session = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in - 60) * 1000,
    scope: tokens.scope || SCOPE,
    app_version: appVersions[0],
    acc_client_id: null,
  };
  session.acc_client_id = await fetchAccClientId(session, appVersions);
  await env.TADO_KV.put(SESSION_KV_KEY, JSON.stringify(session));
  await env.TADO_KV.delete(PENDING_KV_KEY);
  return session;
}

async function exchangeCode(code, codeVerifier) {
  const res = await fetch(`${BASE_AUTH}/oauth/token`, {
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
  return res.json();
}

// Folgt Weiterleitungen, bis "code"/"error" in der Ziel-URL steht oder eine
// Seite (Status 200, z. B. die MFA-Abfrage) ausgeliefert wird.
async function followToCode(jar, startUrl) {
  let target = startUrl;
  for (let hop = 0; hop < 8; hop++) {
    if (target.searchParams.get('code') || target.searchParams.get('error')) {
      return { code: target.searchParams.get('code'), url: target };
    }
    const res = await jarFetch(jar, target.toString());
    const next = res.headers.get('Location');
    if (res.status >= 300 && res.status < 400 && next) {
      target = new URL(next, BASE_AUTH + '/');
      continue;
    }
    if (res.status === 200) return { page: await res.text(), url: target };
    throw new Error(`Panasonic login_redirect: Status ${res.status} bei ${describeUrl(target)}`);
  }
  throw new Error('Panasonic login_redirect: zu viele Weiterleitungen');
}

// Schritt 1 (Knopf "Anmelden"): Login mit den Secrets. Liefert entweder eine
// fertige Sitzung oder den Hinweis, dass ein Bestätigungscode nötig ist.
export async function startPanasonicLogin(env) {
  if (!isPanasonicConfigured(env)) {
    throw new Error('Panasonic ist nicht konfiguriert (Secrets PANASONIC_USER / PANASONIC_PASS fehlen).');
  }
  const jar = makeJar();
  const state = randomString(20);
  const codeVerifier = randomString(43);
  const codeChallenge = base64Url(new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  ));
  const appVersions = await detectAppVersions(env);

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
    // Auth0 liefert den Grund im Body (z. B. invalid_user_password).
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Panasonic-Login abgelehnt (Status ${res.status})${detail ? ' - ' + detail : ''}`);
  }
  await expectStatus(res, 200, 'login');
  const loginHtml = await res.text();

  const pendingBase = { cookies: jar.dump(), codeVerifier, appVersions };
  let challenge = detectChallenge(loginHtml);
  let challengeHtml = challenge ? loginHtml : null;

  if (!challenge) {
    const hidden = parseHiddenInputs(loginHtml);
    if (!hidden.wresult) throw new Error('Panasonic login: Antwort enthielt weder wresult noch eine MFA-Abfrage (Login-Ablauf geändert?)');

    // 3. Callback + Redirects bis zum Authorization-Code (oder zur MFA-Seite)
    res = await jarFetch(jar, `${BASE_AUTH}/login/callback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36',
      },
      body: new URLSearchParams(hidden).toString(),
    });
    await expectStatus(res, 302, 'login_callback');
    const result = await followToCode(jar, new URL(res.headers.get('Location'), BASE_AUTH + '/'));

    if (result.code) {
      const tokens = await exchangeCode(result.code, codeVerifier);
      await buildSession(env, tokens, appVersions);
      return { status: 'ok' };
    }
    if (!result.page) {
      throw new Error(`Panasonic login_redirect: kein Authorization-Code erhalten (${describeUrl(result.url)})`);
    }
    challenge = detectChallenge(result.page);
    challengeHtml = result.page;
    if (!challenge) {
      throw new Error(`Panasonic: unbekannte Seite nach dem Login - ${describePage(result.page, result.url)}`);
    }
  }

  let hint = pageText(challengeHtml);
  if (challenge.kind === 'guardian') {
    // Wie die echte Seite: Flow starten, damit Panasonic Code/Freigabe sendet.
    try {
      const flow = await guardianStartFlow(challenge.guardian);
      challenge.transactionToken = flow.transactionToken;
      hint = `${hint ? hint + ' | ' : ''}Panasonic-Antwort: ${flow.info}`;
    } catch (err) {
      hint = `${hint ? hint + ' | ' : ''}${err.message}`;
    }
  }

  await env.TADO_KV.put(PENDING_KV_KEY, JSON.stringify({
    ...pendingBase,
    cookies: jar.dump(),
    challenge,
    hint,
    createdAt: Date.now(),
  }), { expirationTtl: PENDING_TTL_SECONDS });
  return { status: 'mfa', kind: challenge.kind, hint };
}

// Schritt 2: Bestätigungscode einlösen und Sitzung speichern.
export async function verifyPanasonicMfa(env, rawCode) {
  const otp = String(rawCode || '').replace(/\s+/g, '');
  const raw = await env.TADO_KV.get(PENDING_KV_KEY);
  if (!raw) throw new Error('Keine offene Panasonic-Anmeldung (abgelaufen?) - bitte erneut auf "Anmelden" klicken.');
  const pending = JSON.parse(raw);
  const { challenge } = pending;
  // Ohne Code geht nur die Push-Freigabe (Guardian): dort wird auf die
  // Bestätigung in der Panasonic-App gewartet.
  if (!otp && challenge.kind !== 'guardian') throw new Error('Bitte den Bestätigungscode eingeben.');

  if (challenge.kind === 'otp') {
    // Best effort, Fehler hier sind nicht fatal (Authenticator-Apps brauchen es meist nicht).
    await fetch(`${BASE_AUTH}/mfa/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Auth0-Client': AUTH0_CLIENT, 'User-Agent': 'okhttp/4.10.0' },
      body: JSON.stringify({ mfa_token: challenge.mfaToken, client_id: APP_CLIENT_ID, challenge_type: 'otp' }),
    }).catch(() => null);

    const res = await fetch(`${BASE_AUTH}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Auth0-Client': AUTH0_CLIENT, 'User-Agent': 'okhttp/4.10.0' },
      body: JSON.stringify({
        grant_type: 'http://auth0.com/oauth/grant-type/mfa-otp',
        client_id: APP_CLIENT_ID,
        mfa_token: challenge.mfaToken,
        otp,
      }),
      redirect: 'manual',
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(`Bestätigungscode abgelehnt (Status ${res.status})${detail ? ' - ' + detail : ''}`);
    }
    await expectStatus(res, 200, 'verify_mfa');
    await buildSession(env, await res.json(), pending.appVersions || [pending.appVersion]);
    return { status: 'ok' };
  }

  // Guardian-Widget
  const g = challenge.guardian;
  let transactionToken = challenge.transactionToken;
  if (!transactionToken) transactionToken = (await guardianStartFlow(g)).transactionToken;

  let res;
  if (otp) {
    const submit = () => fetch(`${g.serviceUrl}/api/verify-otp`, {
      method: 'POST',
      headers: guardianHeaders(transactionToken),
      body: JSON.stringify({ type: 'manual_input', code: otp }),
    });
    res = await submit();
    if (res.status === 401 || res.status === 404) {
      // gespeicherter Vorgang abgelaufen -> neu starten und noch einmal versuchen
      transactionToken = (await guardianStartFlow(g)).transactionToken;
      res = await submit();
    }
    if (res.status === 403) throw new Error('Bestätigungscode abgelehnt (falscher oder abgelaufener Code).');
    if (![200, 201, 204].includes(res.status)) await expectStatus(res, 200, 'guardian_verify_otp');
  }

  // Ohne Code (Push-Freigabe in der App) länger warten als nach einem Code.
  let signature = null;
  const polls = otp ? 10 : 25;
  for (let i = 0; i < polls && !signature; i++) {
    res = await fetch(`${g.serviceUrl}/api/transaction-state`, { method: 'POST', headers: guardianHeaders(transactionToken) });
    if (![200, 201, 204].includes(res.status)) await expectStatus(res, 200, 'guardian_transaction_state');
    const body = await res.json().catch(() => ({}));
    if (body.state === 'accepted') signature = body.token;
    else if (body.state === 'rejected') throw new Error('Panasonic: Bestätigung wurde abgelehnt.');
    else await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!signature) {
    throw new Error(otp
      ? 'Panasonic: Zeitüberschreitung bei der Bestätigung.'
      : 'Panasonic: keine Freigabe erhalten - in der Comfort-Cloud-App bestätigen oder einen Code eingeben.');
  }

  const jar = makeJar(pending.cookies);
  res = await jarFetch(jar, g.postActionURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Mobile Safari/537.36',
    },
    body: new URLSearchParams({ accepted: 'true', signature }).toString(),
  });
  await expectStatus(res, 302, 'guardian_post_action');
  const result = await followToCode(jar, new URL(res.headers.get('Location'), BASE_AUTH + '/'));
  if (!result.code) {
    throw new Error(`Panasonic guardian: kein Authorization-Code erhalten (${describeUrl(result.url)})`);
  }
  const tokens = await exchangeCode(result.code, pending.codeVerifier);
  await buildSession(env, tokens, pending.appVersions || [pending.appVersion]);
  return { status: 'ok' };
}

// Liefert null oder { kind, hint } für den offenen Bestätigungscode-Schritt.
export async function panasonicMfaPending(env) {
  const raw = await env.TADO_KV.get(PENDING_KV_KEY);
  if (!raw) return null;
  const pending = JSON.parse(raw);
  return { kind: pending.challenge.kind, hint: pending.hint || '' };
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

// Liefert eine gültige Sitzung aus KV (bei Bedarf per Refresh-Token
// erneuert). Startet NIE einen Login - dafür braucht es den Bestätigungscode.
async function getSession(env, forceRefresh = false) {
  const raw = await env.TADO_KV.get(SESSION_KV_KEY);
  const session = raw ? JSON.parse(raw) : null;
  if (!session) throw loginRequiredError();
  if (!forceRefresh && Date.now() < session.expires_at) return session;

  const refreshed = await refresh(session);
  if (!refreshed) {
    await env.TADO_KV.delete(SESSION_KV_KEY);
    throw loginRequiredError('Panasonic-Sitzung abgelaufen - bitte neu anmelden.');
  }
  await env.TADO_KV.put(SESSION_KV_KEY, JSON.stringify(refreshed));
  return refreshed;
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
    // Token serverseitig ungültig geworden -> einmal per Refresh-Token erneuern
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      session = await getSession(env, true);
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      if (res.status === 401 && detail.includes('4106')) {
        throw new Error(`Panasonic verlangt eine neuere App-Version (aktuell ${session.app_version}) - PANASONIC_APP_VERSION als Variable setzen.`);
      }
      throw new Error(`Panasonic ${method} ${path.split('/').slice(0, 3).join('/')} -> ${res.status}${detail ? ' - ' + detail : ''}`);
    }
    return res.json();
  }
  throw new Error('Panasonic: Anfrage nach erneuter Token-Erneuerung weiterhin abgelehnt.');
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

// Anzeigename: immer "Klima <Raum>" - ein vorhandenes "Klima"/"Klimaanlage"/
// "AC" am Anfang des in der Comfort-Cloud-App vergebenen Namens wird dabei
// nicht doppelt gesetzt.
export function displayName(rawName) {
  const room = String(rawName || '').trim().replace(/^(klimaanlage|klima|ac)\b[\s:_-]*/i, '').trim();
  return room ? `Klima ${room}` : 'Klima';
}

// Liest die Luftrichtungen aus den Status-Parametern (null = nicht vorhanden).
function readSwing(p) {
  const fan = p.fanAutoMode;
  const udAuto = fan === 0 || fan === 2;
  const lrAuto = fan === 0 || fan === 3;
  const ud = p.airSwingUD === undefined ? null : (udAuto ? 'AUTO' : (SWING_UD_FROM_CODE[p.airSwingUD] || null));
  const lrSupported = p.airSwingLR !== undefined && p.airSwingLR !== LR_UNAVAILABLE;
  const lr = lrSupported ? (lrAuto ? 'AUTO' : (SWING_LR_FROM_CODE[p.airSwingLR] || null)) : null;
  return { ud, lr };
}

function mapDevice(device, status) {
  const p = (status && status.parameters) || {};
  const on = p.operate === 1;
  const swing = readSwing(p);
  return {
    id: device.id,
    name: displayName(device.name),
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
    fanLevel: FAN_FROM_CODE[p.fanSpeed] || null,
    ecoMode: ECO_FROM_CODE[p.ecoMode] || null,
    swingUD: swing.ud,
    swingLR: swing.lr,
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

// Liefert { zones, error, loginRequired, mfaPending } - Fehler blockieren nie
// das restliche Dashboard.
export async function fetchPanasonicZones(env) {
  if (!isPanasonicConfigured(env)) return { zones: [], error: null, loginRequired: false, mfaPending: null };
  try {
    const devices = await listDevices(env);
    const zones = await Promise.all(devices.map(async (device) => {
      const status = await accRequest(env, 'GET', `/deviceStatus/${guidPath(device.guid)}`);
      return mapDevice(device, status);
    }));
    return { zones, error: null, loginRequired: false, mfaPending: null };
  } catch (err) {
    const loginRequired = Boolean(err.loginRequired);
    return {
      zones: [],
      error: err.message,
      loginRequired,
      mfaPending: loginRequired ? await panasonicMfaPending(env) : null,
    };
  }
}

// Steuert ein Gerät. Gesendet werden nur die genannten Felder (Ein/Aus,
// Zieltemperatur, Modus, Lüfterstufe, Eco-Modus) - alles andere bleibt
// unverändert. Das Gerät wird dabei nie von selbst eingeschaltet.
export async function setPanasonicDevice(env, deviceId, { power, temperature, mode, fanSpeed, eco, swingUD, swingLR }) {
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
    // Beim Einschalten immer Kühlen (nicht der zuletzt benutzte Modus,
    // z. B. Entfeuchten) - außer es wird ausdrücklich ein Modus mitgegeben.
    if (mode == null) parameters.operationMode = MODE_CODES.COOL;
    // ... und mit Standard-Zieltemperatur (PANASONIC_DEFAULT_TEMP, sonst 20),
    // außer eine Temperatur wird mitgegeben oder der Modus hat keine.
    const targetMode = mode == null ? 'COOL' : String(mode).toUpperCase();
    if (temperature == null && targetMode !== 'DRY' && targetMode !== 'FAN') {
      const configured = Number(env.PANASONIC_DEFAULT_TEMP);
      const base = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ON_TEMP;
      parameters.temperatureSet = Math.min(MAX_TEMP, Math.max(MIN_TEMP, base));
    }
  }
  if (temperature != null) {
    const t = Math.min(MAX_TEMP, Math.max(MIN_TEMP, Number(temperature)));
    if (Number.isNaN(t)) throw new Error('Ungültige Temperatur.');
    parameters.temperatureSet = t;
  }
  const pick = (value, codes, label) => {
    const code = codes[String(value).toUpperCase()];
    if (code === undefined) throw new Error(`Ungültiger Wert für ${label}: ${value}`);
    return code;
  };
  if (mode != null) parameters.operationMode = pick(mode, MODE_CODES, 'Modus');
  if (fanSpeed != null) parameters.fanSpeed = pick(fanSpeed, FAN_CODES, 'Lüfterstufe');
  if (eco != null) parameters.ecoMode = pick(eco, ECO_CODES, 'Eco-Modus');
  if (swingUD != null || swingLR != null) {
    // "Auto" hängt an fanAutoMode und betrifft beide Achsen gemeinsam - deshalb
    // erst den aktuellen Zustand der anderen Achse lesen.
    const current = await accRequest(env, 'GET', `/deviceStatus/${guidPath(device.guid)}`);
    const fan = (current.parameters || {}).fanAutoMode;
    let udAuto = fan === 0 || fan === 2;
    let lrAuto = fan === 0 || fan === 3;
    if (swingUD != null) {
      const v = String(swingUD).toUpperCase();
      udAuto = v === 'AUTO';
      if (!udAuto) parameters.airSwingUD = pick(v, SWING_UD_CODES, 'Luftrichtung senkrecht');
    }
    if (swingLR != null) {
      const v = String(swingLR).toUpperCase();
      lrAuto = v === 'AUTO';
      if (!lrAuto) parameters.airSwingLR = pick(v, SWING_LR_CODES, 'Luftrichtung waagrecht');
    }
    parameters.fanAutoMode = udAuto && lrAuto ? 0 : udAuto ? 2 : lrAuto ? 3 : 1;
  }
  if (!Object.keys(parameters).length) throw new Error('Nichts zu setzen.');

  await accRequest(env, 'POST', '/deviceStatus/control', { deviceGuid: device.guid, parameters });
}
