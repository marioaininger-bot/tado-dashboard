// Cloudflare Worker: Proxy zwischen dem Dashboard (Browser) und der
// (inoffiziellen, aber seit Jahren stabilen) Tado-API. Übernimmt den
// OAuth2 Device-Code-Login und cached/erneuert die Tokens in Workers KV,
// damit der Browser nie ein Tado-Passwort oder Access-Token zu sehen
// bekommt.
//
// Tado-Tokens liegen NUR in der KV-Namespace (Binding: TADO_KV).
//
// Setze ALLOWED_ORIGIN in wrangler.toml auf deine GitHub-Pages-URL,
// damit nur dein Dashboard die Endpunkte aufrufen darf.

const TADO_CLIENT_ID = '1bb50063-6b0c-4d11-bd99-387f4a91cc46'; // öffentliche Tado-Client-ID (Device-Flow, kein Secret nötig)
const AUTH_BASE = 'https://login.tado.com/oauth2';
const API_BASE = 'https://my.tado.com/api/v2';
// Neuere "tado X" Geräte (weiße, runde Thermostate) laufen über eine
// komplett andere API ("rooms" statt "zones"), aber mit demselben
// OAuth-Access-Token wie die klassische API.
const HOPS_API_BASE = 'https://hops.tado.com';
const TOKEN_KV_KEY = 'tokens';

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(status, body, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

async function tokenRequest(env, params) {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: TADO_CLIENT_ID, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function storeTokens(env, data) {
  const record = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // kleiner Sicherheitsabstand, damit wir nie mit einem gerade
    // abgelaufenen Token loslaufen
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  await env.TADO_KV.put(TOKEN_KV_KEY, JSON.stringify(record));
  return record;
}

async function getValidAccessToken(env) {
  const raw = await env.TADO_KV.get(TOKEN_KV_KEY);
  if (!raw) return null;
  const tokens = JSON.parse(raw);
  if (Date.now() < tokens.expires_at) return tokens.access_token;

  const { ok, data } = await tokenRequest(env, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  if (!ok || !data.access_token) {
    await env.TADO_KV.delete(TOKEN_KV_KEY);
    return null;
  }
  const stored = await storeTokens(env, data);
  return stored.access_token;
}

async function tadoFetch(env, accessToken, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Tado API ${path} -> ${res.status}`);
  }
  return res.json();
}

async function hopsFetch(env, accessToken, path) {
  const res = await fetch(`${HOPS_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Tado X API ${path} -> ${res.status}`);
  }
  return res.json();
}

async function handleAuthStart(env) {
  const res = await fetch(`${AUTH_BASE}/device_authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: TADO_CLIENT_ID, scope: 'offline_access' }),
  });
  if (!res.ok) {
    return json(502, { error: 'Konnte Login bei Tado nicht starten.' }, env);
  }
  const data = await res.json();
  return json(200, {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: data.verification_uri,
    verification_uri_complete: data.verification_uri_complete,
    interval: data.interval || 5,
    expires_in: data.expires_in,
  }, env);
}

async function handleAuthPoll(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: 'Ungültiger Request-Body.' }, env);
  }
  if (!body.device_code) {
    return json(400, { error: 'device_code fehlt.' }, env);
  }

  const { ok, data } = await tokenRequest(env, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: body.device_code,
  });

  if (ok && data.access_token) {
    await storeTokens(env, data);
    return json(200, { status: 'success' }, env);
  }

  const error = data.error || 'unknown_error';
  if (error === 'authorization_pending' || error === 'slow_down') {
    return json(200, { status: 'pending' }, env);
  }
  return json(200, { status: 'error', error }, env);
}

async function handleAuthStatus(env) {
  const token = await getValidAccessToken(env);
  return json(200, { loggedIn: Boolean(token) }, env);
}

async function handleAuthLogout(env) {
  await env.TADO_KV.delete(TOKEN_KV_KEY);
  return json(200, { status: 'ok' }, env);
}

async function handleDashboard(env) {
  const accessToken = await getValidAccessToken(env);
  if (!accessToken) {
    return json(401, { error: 'Nicht eingeloggt.' }, env);
  }

  try {
    const me = await tadoFetch(env, accessToken, '/me');
    const home = (me.homes || [])[0];
    if (!home) {
      return json(404, { error: 'Kein Tado-Zuhause gefunden.' }, env);
    }

    const homeDetails = await tadoFetch(env, accessToken, `/homes/${home.id}`).catch(() => null);
    const isTadoX = homeDetails && homeDetails.generation === 'LINE_X';

    // Klassische zones/zoneStates-API abfragen. Bei tado X (LINE_X) laufen
    // die Heizkörper zwar über die neue rooms-API, aber Zubehör wie eine
    // per "Smart AC Control" angebundene Klimaanlage bleibt eine klassische
    // Zone - deshalb hier immer mitziehen (best effort, falls leer/Fehler).
    const [classicZones, classicZoneStates] = await Promise.all([
      tadoFetch(env, accessToken, `/homes/${home.id}/zones`).catch(() => []),
      tadoFetch(env, accessToken, `/homes/${home.id}/zoneStates`).catch(() => ({})),
    ]);
    const classicStates = classicZoneStates.zoneStates || classicZoneStates;

    function mapClassicZone(zone) {
      const state = classicStates[String(zone.id)] || {};
      const setting = state.setting || {};
      const sensor = state.sensorDataPoints || {};
      const activity = state.activityDataPoints || {};
      return {
        id: zone.id,
        name: zone.name,
        type: zone.type, // HEATING | AC | HOT_WATER
        power: setting.power || null,
        targetTemp: setting.temperature ? setting.temperature.celsius : null,
        currentTemp: sensor.insideTemperature ? sensor.insideTemperature.celsius : null,
        humidity: sensor.humidity ? sensor.humidity.percentage : null,
        heatingPower: activity.heatingPower ? activity.heatingPower.percentage : null,
        acPower: activity.acPower ? activity.acPower.value : null,
        openWindow: Boolean(state.openWindow || state.openWindowDetected),
        link: state.link ? state.link.state : null,
      };
    }

    let zoneList;
    if (isTadoX) {
      // "tado X" Heizkörper: eigene API (hops.tado.com) mit "rooms" statt "zones".
      const rooms = await hopsFetch(env, accessToken, `/homes/${home.id}/rooms`);
      zoneList = rooms.map((room) => {
        const setting = room.setting || {};
        const sensor = room.sensorDataPoints || {};
        return {
          id: room.id,
          name: room.name,
          type: 'HEATING',
          power: setting.power || null,
          targetTemp: setting.temperature ? setting.temperature.value : null,
          currentTemp: sensor.insideTemperature ? sensor.insideTemperature.value : null,
          humidity: sensor.humidity ? sensor.humidity.percentage : null,
          heatingPower: room.heatingPower ? room.heatingPower.percentage : null,
          acPower: null,
          openWindow: Boolean(room.openWindow),
          link: room.connection ? room.connection.state : null,
        };
      });
      // Zubehör wie Klimaanlage/Warmwasser läuft weiterhin klassisch dazunehmen.
      const extras = classicZones.filter((zone) => zone.type !== 'HEATING').map(mapClassicZone);
      zoneList = zoneList.concat(extras);
    } else {
      zoneList = classicZones.map(mapClassicZone);
    }

    const weather = await tadoFetch(env, accessToken, `/homes/${home.id}/weather`).catch(() => null);

    return json(200, {
      homeName: home.name,
      zones: zoneList,
      weather: weather ? {
        outsideTemp: weather.outsideTemperature ? weather.outsideTemperature.celsius : null,
        solarIntensity: weather.solarIntensity ? weather.solarIntensity.percentage : null,
        state: weather.weatherState ? weather.weatherState.value : null,
      } : null,
    }, env);
  } catch (err) {
    return json(502, { error: err.message }, env);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env) });
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/auth/start' && request.method === 'POST') {
      return handleAuthStart(env);
    }
    if (url.pathname === '/api/auth/poll' && request.method === 'POST') {
      return handleAuthPoll(request, env);
    }
    if (url.pathname === '/api/auth/status' && request.method === 'GET') {
      return handleAuthStatus(env);
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      return handleAuthLogout(env);
    }
    if (url.pathname === '/api/dashboard' && request.method === 'GET') {
      return handleDashboard(env);
    }

    return json(404, { error: 'Not found' }, env);
  },
};
