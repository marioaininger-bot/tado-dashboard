// Wiener Netze Smart Meter (offizielle API "WN_SMART_METER_API" der Wiener
// Stadtwerke): liefert den echten Stromverbrauch des eigenen Zählpunkts als
// Viertelstunden-, Tages- oder Zählerstandswerte. Endpunkte und Ablauf nach der
// Community-Bibliothek wiener-netze-smart-meter-api (Python) und dem Swagger der API.
//
// Zugangsdaten liegen NUR als Worker-Secrets (siehe README):
//   WN_CLIENT_ID, WN_CLIENT_SECRET, WN_API_KEY, WN_ZAEHLPUNKT
// Die Secrets gibt es erst, wenn die Anwendung im Developer-Portal freigegeben
// und vom Smart-Meter-Support mit dem Portal-Zugang verbunden wurde. Bis dahin
// meldet /api/strom/status, was noch fehlt, und alle anderen Aufrufe liefern
// einen klaren Fehler statt eines Absturzes.
//
// Daten kommen vom Netzbetreiber erst am Folgetag. Antworten werden deshalb
// kurz in KV gecacht, um das API-Limit zu schonen.

// Token-Endpunkt laut Swagger der WN_SMART_METER_API (OAuth2 client_credentials,
// Scope "profile"). Per Variable WN_TOKEN_URL überschreibbar, falls die Wiener
// Netze den Endpunkt ändern.
const DEFAULT_TOKEN_URL = 'https://api.wstw.at/invoke/pub.apigateway.oauth2/getAccessToken';
const BASE_URL = 'https://api.wstw.at/gateway/WN_SMART_METER_API/1.0/';

const REQUIRED_SECRETS = ['WN_CLIENT_ID', 'WN_CLIENT_SECRET', 'WN_API_KEY', 'WN_ZAEHLPUNKT'];
const CACHE_PREFIX = 'strom_cache:';
const CACHE_TTL_SECONDS = 3600;
const DAY_MS = 24 * 3600 * 1000;

// Maximale Zeitspanne je Abfrage (Viertelstunden erzeugen sonst riesige Antworten).
const MAX_DAYS = { QUARTER_HOUR: 31, DAY: 366, METER_READ: 366 };
const WERTETYP = { 'quarter-hours': 'QUARTER_HOUR', daily: 'DAY', readings: 'METER_READ' };

// Token der laufenden Worker-Instanz (kurzlebig, ca. 5 Minuten gültig).
let tokenCache = { token: null, expiresAt: 0 };

export function missingSmartMeterSecrets(env) {
  return REQUIRED_SECRETS.filter((name) => !env[name]);
}

class SmartMeterError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function getBearerToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await fetch(env.WN_TOKEN_URL || DEFAULT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: env.WN_CLIENT_ID,
      client_secret: env.WN_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'profile',
    }),
  });
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (err) { /* kein JSON */ }
  if (!res.ok || !data.access_token) {
    throw new SmartMeterError(
      502,
      `Login bei Wiener Netze fehlgeschlagen (HTTP ${res.status}): ${data.error_description || data.error || raw.slice(0, 200) || 'keine Details'}`,
      'WN_AUTH_FAILED',
    );
  }
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + ((data.expires_in || 300) - 10) * 1000,
  };
  return tokenCache.token;
}

async function wnFetch(env, path, params) {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);

  // Bei 401 einmal mit frischem Token wiederholen.
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getBearerToken(env);
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'x-Gateway-APIKey': env.WN_API_KEY,
      },
    });
    if (res.status === 401 && attempt === 0) {
      tokenCache = { token: null, expiresAt: 0 };
      continue;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (err) { /* kein JSON */ }
    if (!res.ok) {
      throw new SmartMeterError(
        res.status === 429 ? 429 : 502,
        `Wiener Netze antwortet mit HTTP ${res.status}: ${(data && (data.message || data.error)) || text.slice(0, 200) || 'keine Details'}`,
        'WN_REQUEST_FAILED',
      );
    }
    return data;
  }
  throw new SmartMeterError(502, 'Wiener Netze lehnt den Zugriff ab (401).', 'WN_UNAUTHORIZED');
}

/* ---------- Datum & Normalisierung ---------- */

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

const fmtDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// Zeitraum prüfen: Standard sind die letzten 7 Tage. Gleiche Tage verlängert
// die API nicht von selbst (400), also hängen wir einen Tag an.
export function resolveRange(params, wertetyp, now = Date.now()) {
  const today = parseDate(fmtDate(now));
  let bis = params.get('bis') ? parseDate(params.get('bis')) : today;
  let von = params.get('von') ? parseDate(params.get('von')) : bis - 7 * DAY_MS;
  if (von === null || bis === null) {
    throw new SmartMeterError(400, 'Datum bitte als JJJJ-MM-TT angeben (von, bis).', 'BAD_DATE');
  }
  if (von > bis) throw new SmartMeterError(400, '"von" liegt nach "bis".', 'BAD_RANGE');
  if (von === bis) bis += DAY_MS;
  const days = Math.round((bis - von) / DAY_MS);
  if (days > MAX_DAYS[wertetyp]) {
    throw new SmartMeterError(
      400,
      `Zeitraum zu groß: höchstens ${MAX_DAYS[wertetyp]} Tage für diese Abfrage.`,
      'RANGE_TOO_LARGE',
    );
  }
  return { von: fmtDate(von), bis: fmtDate(bis) };
}

// Einheit des Werts in kWh umrechnen. Die genaue Einheit je Zählwerk steht in
// der Antwort; unbekannte Einheiten bleiben unverändert (kwh = null).
function toKwh(value, unit) {
  const u = String(unit || '').toUpperCase();
  if (typeof value !== 'number') return null;
  if (u === 'WH') return value / 1000;
  if (u === 'KWH') return value;
  return null;
}

// Antwortformat der API (verschachtelt) auf eine flache Liste je Zählwerk
// bringen: { obis, unit, values: [{ from, to, value, kwh, quality }] }.
export function normalizeMesswerte(raw) {
  const meters = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const series = [];
  for (const meter of meters) {
    for (const zw of meter.zaehlwerke || []) {
      const values = (zw.messwerte || []).map((m) => ({
        from: m.zeitVon,
        to: m.zeitBis,
        value: m.messwert ?? m.wert,
        kwh: toKwh(m.messwert ?? m.wert, m.einheit || zw.einheit),
        quality: m.qualitaet,
      }));
      series.push({
        obis: zw.obisCode,
        unit: (zw.messwerte && zw.messwerte[0] && zw.messwerte[0].einheit) || zw.einheit || null,
        values,
      });
    }
  }
  return series;
}

/* ---------- Abfragen mit Cache ---------- */

async function cached(env, key, loader) {
  const hit = await env.TADO_KV.get(CACHE_PREFIX + key);
  if (hit) return { ...JSON.parse(hit), cached: true };
  const fresh = await loader();
  await env.TADO_KV.put(CACHE_PREFIX + key, JSON.stringify(fresh), { expirationTtl: CACHE_TTL_SECONDS });
  return { ...fresh, cached: false };
}

export function fetchMesswerte(env, wertetyp, von, bis) {
  const zp = env.WN_ZAEHLPUNKT;
  return cached(env, `${wertetyp}:${von}:${bis}`, async () => {
    const raw = await wnFetch(env, `zaehlpunkte/${zp}/messwerte`, { wertetyp, datumVon: von, datumBis: bis });
    return { wertetyp, from: von, to: bis, series: normalizeMesswerte(raw) };
  });
}

export function fetchAnlagendaten(env) {
  return cached(env, 'anlage', async () => ({
    anlage: await wnFetch(env, `zaehlpunkte/${env.WN_ZAEHLPUNKT}`),
  }));
}

/* ---------- HTTP-Handler (vom Worker aufgerufen) ---------- */

export async function handleStrom(request, env, json) {
  const url = new URL(request.url);
  const route = url.pathname.replace('/api/strom/', '');
  const missing = missingSmartMeterSecrets(env);

  if (route === 'status') {
    return json(200, { configured: missing.length === 0, missing }, env);
  }
  if (missing.length) {
    return json(503, {
      error: `Smart Meter noch nicht eingerichtet: Secrets fehlen (${missing.join(', ')}).`,
      code: 'WN_NOT_CONFIGURED',
      missing,
    }, env);
  }

  try {
    if (route === 'anlage') {
      return json(200, await fetchAnlagendaten(env), env);
    }
    const wertetyp = WERTETYP[route];
    if (!wertetyp) return json(404, { error: 'Not found' }, env);
    const { von, bis } = resolveRange(url.searchParams, wertetyp);
    return json(200, await fetchMesswerte(env, wertetyp, von, bis), env);
  } catch (err) {
    if (err instanceof SmartMeterError) {
      return json(err.status, { error: err.message, code: err.code }, env);
    }
    throw err;
  }
}
