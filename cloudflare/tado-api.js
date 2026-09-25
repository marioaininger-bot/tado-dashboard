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
// Kostenlose, key-lose Wetter-API für Zusatzdaten (Luftfeuchte, Wind,
// Stunden-Vorhersage), die Tado selbst nicht liefert.
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const TOKEN_KV_KEY = 'tokens';
// Verlauf (Temperatur/Luftfeuchte je Zone), geschrieben vom Cron-Trigger
// alle 15 Minuten, unabhängig davon ob das Dashboard offen ist. 96 Punkte =
// 24h. Die Kachel zeigt nur die letzten 3, der Tages-Chart die ganze Liste.
const HISTORY_KV_KEY = 'zone_history';
const HISTORY_MAX_POINTS = 96;

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

async function fetchExtraWeather(lat, lon) {
  // forecast_days=2, damit auch spätabends noch genug Stunden für die
  // Vorhersage übrig sind (nicht nur bis Mitternacht des aktuellen Tages).
  const url = `${OPEN_METEO_BASE}?latitude=${lat}&longitude=${lon}&current=relative_humidity_2m,wind_speed_10m&hourly=temperature_2m,precipitation_probability&forecast_days=2&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo -> ${res.status}`);
  }
  const data = await res.json();

  const times = (data.hourly && data.hourly.time) || [];
  const temps = (data.hourly && data.hourly.temperature_2m) || [];
  const rain = (data.hourly && data.hourly.precipitation_probability) || [];
  // "current.time" kommt (wie "hourly.time") in der lokalen Zeitzone des
  // Hauses (timezone=auto) - im Gegensatz zur UTC-Uhr des Workers, die
  // hier vorher fälschlich zum Vergleich benutzt wurde und je nach
  // Sommer-/Winterzeit zu falschen Startpunkten führte.
  const nowRef = (data.current && data.current.time) || new Date().toISOString();
  const nowHour = nowRef.slice(0, 13);
  // Strikt ">": die aktuelle, schon angebrochene Stunde wird übersprungen -
  // die Vorschau startet erst mit der nächsten vollen Stunde.
  let startIdx = times.findIndex((t) => t.slice(0, 13) > nowHour);
  if (startIdx < 0) startIdx = 0;

  // 24h rollend (nicht nur bis Mitternacht) - auf breiten Bildschirmen
  // sonst zu wenig Inhalt für die verfügbare Breite. newDay markiert den
  // Übergang auf den Folgetag fürs Frontend (kleine Trennung/Label).
  let lastDate = null;
  const hourly = times.slice(startIdx, startIdx + 24).map((t, i) => {
    const datePart = t.slice(0, 10);
    const newDay = lastDate !== null && datePart !== lastDate;
    lastDate = datePart;
    return {
      time: t.slice(11, 16),
      temp: temps[startIdx + i] != null ? temps[startIdx + i] : null,
      rainChance: rain[startIdx + i] != null ? rain[startIdx + i] : null,
      newDay,
    };
  });

  return {
    humidity: data.current ? data.current.relative_humidity_2m : null,
    windSpeed: data.current ? data.current.wind_speed_10m : null,
    hourly,
  };
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

// Batterie-/Verbindungsstatus aus der "devices"-Liste einer Zone (kommt bei
// der klassischen API direkt im Zonen-Objekt mit, kein Extra-Request nötig).
function deviceStatus(devices) {
  if (!Array.isArray(devices) || !devices.length) {
    return { batteryLow: false, deviceOffline: false };
  }
  return {
    batteryLow: devices.some((d) => d.batteryState === 'LOW'),
    deviceOffline: devices.some((d) => d.connectionState && d.connectionState.value === false),
  };
}

// Nächste geplante Zeitplan-Änderung (nur relevant, wenn gerade keine
// manuelle Übersteuerung aktiv ist). Kommt sowohl im klassischen zoneState
// als auch im tado-X-Room-Objekt direkt mit - nur der Temperatur-Schlüssel
// unterscheidet sich (celsius vs. value).
function extractScheduleChange(change, tempKey) {
  if (!change) return null;
  const setting = change.setting || {};
  return {
    start: change.start,
    power: setting.power || null,
    temperature: setting.temperature ? setting.temperature[tempKey] : null,
  };
}

function mapClassicZone(zone, classicStates) {
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
    manualOverride: Boolean(state.overlay),
    nextScheduleChange: extractScheduleChange(state.nextScheduleChange, 'celsius'),
    ...deviceStatus(zone.devices),
  };
}

// Lädt Home + alle Zonen (klassisch + tado X). Wird sowohl vom
// Dashboard-Endpunkt als auch vom Cron-Trigger (Verlaufs-Aufzeichnung)
// genutzt.
async function fetchHomeAndZones(env, accessToken) {
  const me = await tadoFetch(env, accessToken, '/me');
  const home = (me.homes || [])[0];
  if (!home) {
    throw new Error('Kein Tado-Zuhause gefunden.');
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
        manualOverride: Boolean(room.manualControlTermination),
        nextScheduleChange: extractScheduleChange(room.nextScheduleChange, 'value'),
        // Die rooms-API liefert (Stand jetzt, per /api/debug/rooms geprüft)
        // kein "devices"-Feld - Batteriestatus kommt bei tado X offenbar
        // über einen anderen Endpunkt (wird noch untersucht).
        batteryLow: false,
        deviceOffline: false,
      };
    });
    // Zubehör wie Klimaanlage/Warmwasser läuft weiterhin klassisch dazunehmen.
    const extras = classicZones
      .filter((zone) => zone.type !== 'HEATING')
      .map((zone) => mapClassicZone(zone, classicStates));
    zoneList = zoneList.concat(extras);
  } else {
    zoneList = classicZones.map((zone) => mapClassicZone(zone, classicStates));
  }

  return { home, homeDetails, isTadoX, zoneList };
}

// Heiz-/Kühlleistung als einheitlicher Prozentwert (0-100), unabhängig vom
// Zonentyp - Basis für die Betriebsstunden-Schätzung im Frontend.
function powerPercent(zone) {
  if (zone.type === 'AC') {
    return typeof zone.acPower === 'number' ? zone.acPower : (zone.acPower === 'ON' ? 100 : 0);
  }
  return zone.heatingPower || 0;
}

// Hängt an jede Zone ihre letzten Messpunkte (Temperatur/Luftfeuchte/
// Leistung) an, die der Cron-Trigger alle 15 Minuten aufgezeichnet hat.
async function attachHistory(env, zoneList) {
  const raw = await env.TADO_KV.get(HISTORY_KV_KEY);
  const history = raw ? JSON.parse(raw) : {};
  return zoneList.map((zone) => ({
    ...zone,
    history: history[String(zone.id)] || [],
  }));
}

// Schreibt für jede Zone mit gültiger Temperatur einen neuen Messpunkt in
// den Verlauf und behält nur die letzten HISTORY_MAX_POINTS Einträge.
async function recordHistory(env, zoneList) {
  const raw = await env.TADO_KV.get(HISTORY_KV_KEY);
  const history = raw ? JSON.parse(raw) : {};
  const t = new Date().toISOString();

  for (const zone of zoneList) {
    if (zone.currentTemp == null) continue;
    const key = String(zone.id);
    const points = history[key] || [];
    points.push({ t, temp: zone.currentTemp, humidity: zone.humidity, power: powerPercent(zone) });
    history[key] = points.slice(-HISTORY_MAX_POINTS);
  }

  await env.TADO_KV.put(HISTORY_KV_KEY, JSON.stringify(history));
}

async function handleDashboard(env) {
  const accessToken = await getValidAccessToken(env);
  if (!accessToken) {
    return json(401, { error: 'Nicht eingeloggt.' }, env);
  }

  try {
    const { home, homeDetails, zoneList } = await fetchHomeAndZones(env, accessToken);
    const zonesWithHistory = await attachHistory(env, zoneList);

    const weather = await tadoFetch(env, accessToken, `/homes/${home.id}/weather`).catch(() => null);
    const geo = homeDetails && homeDetails.geolocation;
    const extraWeather = geo
      ? await fetchExtraWeather(geo.latitude, geo.longitude).catch(() => null)
      : null;

    return json(200, {
      homeName: home.name,
      zones: zonesWithHistory,
      weather: (weather || extraWeather) ? {
        outsideTemp: weather && weather.outsideTemperature ? weather.outsideTemperature.celsius : null,
        solarIntensity: weather && weather.solarIntensity ? weather.solarIntensity.percentage : null,
        state: weather && weather.weatherState ? weather.weatherState.value : null,
        humidity: extraWeather ? extraWeather.humidity : null,
        windSpeed: extraWeather ? extraWeather.windSpeed : null,
        hourly: extraWeather ? extraWeather.hourly : [],
      } : null,
    }, env);
  } catch (err) {
    return json(502, { error: err.message }, env);
  }
}

// Setzt eine Zone manuell auf eine Zieltemperatur (oder AUS). Nur für
// HEATING-Zonen unterstützt (Klimaanlage/Warmwasser bräuchten eine andere
// Setting-Struktur - bewusst nicht implementiert, um dort nichts Falsches
// zu senden). Klassische Zonen laufen über den offiziell dokumentierten
// Overlay-Endpunkt; tado X (rooms-API) ist von Tado nicht dokumentiert und
// hier nach bestem Wissen (Community-Quellen) umgesetzt - unbedingt nach
// dem Deploy gegen echte Hardware verifizieren.
async function handleSetZone(request, env) {
  const accessToken = await getValidAccessToken(env);
  if (!accessToken) {
    return json(401, { error: 'Nicht eingeloggt.' }, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: 'Ungültiger Request-Body.' }, env);
  }
  const { zoneId, temperature, power } = body;
  if (zoneId == null) {
    return json(400, { error: 'zoneId fehlt.' }, env);
  }

  try {
    const { home, isTadoX, zoneList } = await fetchHomeAndZones(env, accessToken);
    const zone = zoneList.find((z) => String(z.id) === String(zoneId));
    if (!zone) {
      return json(404, { error: 'Zone nicht gefunden.' }, env);
    }
    if (zone.type !== 'HEATING') {
      return json(400, { error: 'Direktes Setzen wird aktuell nur für Heizkörper-Zonen unterstützt.' }, env);
    }

    if (isTadoX) {
      const res = await fetch(`${HOPS_API_BASE}/homes/${home.id}/rooms/${zoneId}/manualControl`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(
          power === 'OFF'
            ? { setting: { type: 'HEATING', power: 'OFF' } }
            : { setting: { type: 'HEATING', power: 'ON', temperature: { value: temperature } }, termination: { type: 'MANUAL' } }
        ),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`tado X Zone konnte nicht gesetzt werden (Status ${res.status})${detail ? ' - ' + detail : ''}`);
      }
    } else {
      const res = await fetch(`${API_BASE}/homes/${home.id}/zones/${zoneId}/overlay`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          setting: power === 'OFF'
            ? { type: 'HEATING', power: 'OFF' }
            : { type: 'HEATING', power: 'ON', temperature: { celsius: temperature } },
          termination: { type: 'MANUAL' },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Zone konnte nicht gesetzt werden (Status ${res.status})${detail ? ' - ' + detail : ''}`);
      }
    }

    return json(200, { status: 'ok' }, env);
  } catch (err) {
    return json(502, { error: err.message }, env);
  }
}

// Hebt eine manuelle Übersteuerung wieder auf, Zone folgt danach wieder
// ihrem hinterlegten Zeitplan.
async function handleResumeSchedule(request, env) {
  const accessToken = await getValidAccessToken(env);
  if (!accessToken) {
    return json(401, { error: 'Nicht eingeloggt.' }, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: 'Ungültiger Request-Body.' }, env);
  }
  const { zoneId } = body;
  if (zoneId == null) {
    return json(400, { error: 'zoneId fehlt.' }, env);
  }

  try {
    const { home, isTadoX, zoneList } = await fetchHomeAndZones(env, accessToken);
    const zone = zoneList.find((z) => String(z.id) === String(zoneId));
    if (!zone) {
      return json(404, { error: 'Zone nicht gefunden.' }, env);
    }

    if (isTadoX && zone.type === 'HEATING') {
      const res = await fetch(`${HOPS_API_BASE}/homes/${home.id}/rooms/${zoneId}/resumeSchedule`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Zeitplan konnte nicht fortgesetzt werden (Status ${res.status})${detail ? ' - ' + detail : ''}`);
      }
    } else {
      const res = await fetch(`${API_BASE}/homes/${home.id}/zones/${zoneId}/overlay`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Zeitplan konnte nicht fortgesetzt werden (Status ${res.status})${detail ? ' - ' + detail : ''}`);
      }
    }

    return json(200, { status: 'ok' }, env);
  } catch (err) {
    return json(502, { error: err.message }, env);
  }
}

// Siehe Kommentar bei der Route: nur zum Debuggen der undokumentierten
// tado-X-Datenstruktur, danach wieder entfernbar.
async function handleDebugRooms(env) {
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
    // Drei Kandidaten parallel abfragen, um herauszufinden, wo bei tado X
    // der Batterie-/Verbindungsstatus der Geräte tatsächlich steckt.
    const [rooms, devicesClassic, roomsAndDevices] = await Promise.all([
      hopsFetch(env, accessToken, `/homes/${home.id}/rooms`).catch((e) => ({ error: e.message })),
      tadoFetch(env, accessToken, `/homes/${home.id}/devices`).catch((e) => ({ error: e.message })),
      hopsFetch(env, accessToken, `/homes/${home.id}/roomsAndDevices`).catch((e) => ({ error: e.message })),
    ]);
    return json(200, { rooms, devicesClassic, roomsAndDevices }, env);
  } catch (err) {
    return json(502, { error: err.message }, env);
  }
}

// Vom Cron-Trigger (siehe wrangler.toml, alle 15 Minuten) aufgerufen -
// zeichnet den Verlauf unabhängig davon auf, ob gerade jemand das
// Dashboard geöffnet hat. Fehler werden bewusst verschluckt: der nächste
// Lauf in 15 Minuten versucht es einfach erneut.
async function handleScheduled(env) {
  const accessToken = await getValidAccessToken(env);
  if (!accessToken) return;

  try {
    const { zoneList } = await fetchHomeAndZones(env, accessToken);
    await recordHistory(env, zoneList);
  } catch (err) {
    // best effort
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
    if (url.pathname === '/api/zones/set' && request.method === 'POST') {
      return handleSetZone(request, env);
    }
    if (url.pathname === '/api/zones/resume' && request.method === 'POST') {
      return handleResumeSchedule(request, env);
    }
    // Temporärer Debug-Endpunkt: zeigt die rohen tado-X "rooms"-Daten, um
    // undokumentierte Feldnamen (z.B. für Batterie-/Verbindungsstatus)
    // herauszufinden. Kann nach dem Fix wieder entfernt werden.
    if (url.pathname === '/api/debug/rooms' && request.method === 'GET') {
      return handleDebugRooms(env);
    }

    return json(404, { error: 'Not found' }, env);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
