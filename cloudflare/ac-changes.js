// Änderungs-Protokoll der Klimaanlagen: hält fest, wann sich Ein/Aus, Modus,
// Solltemperatur, Lüfterstufe oder Eco-Modus einer Anlage geändert haben, und
// ob die Änderung vom Dashboard kam oder von außen (Panasonic-App, Timer,
// Fernbedienung, Smart-Home-Routine).
//
// Der Cron-Trigger (alle 5 Minuten) vergleicht den aktuellen Zustand mit dem
// zuletzt gespeicherten und schreibt nur bei einer Änderung nach KV. Die
// Uhrzeit eines Eintrags (`t`) ist der Moment der Erkennung; die Änderung
// geschah irgendwann in den davor liegenden `tickMinutes` Minuten.
//
// Die Herkunft ist eine Näherung: Befehle über /api/zones/set merkt sich der
// Worker (markDashboardCommand). Eine Änderung kurz danach gilt als "dashboard",
// alles andere als "extern". Panasonic liefert selbst keine Angabe dazu.

const CHANGES_KV_KEY = 'ac_changes';
const CMD_KV_KEY = 'ac_dashboard_cmd';
export const TICK_MINUTES = 5;               // Takt des Cron-Triggers (wrangler.toml)
const MAX_EVENTS = 500;
const CMD_WINDOW_MS = 10 * 60 * 1000;        // Befehl gilt so lange als Ursache einer Änderung
const FIELDS = ['power', 'mode', 'targetTemp', 'fanLevel', 'ecoMode'];

// Vom Befehls-Endpunkt aufgerufen, nachdem ein Panasonic-Befehl durchging.
export async function markDashboardCommand(env, zoneKey, now = new Date()) {
  const raw = await env.TADO_KV.get(CMD_KV_KEY);
  const cmds = raw ? JSON.parse(raw) : {};
  const cutoff = now.getTime() - 60 * 60 * 1000;
  for (const [k, t] of Object.entries(cmds)) if (Date.parse(t) < cutoff) delete cmds[k];
  cmds[zoneKey] = now.toISOString();
  await env.TADO_KV.put(CMD_KV_KEY, JSON.stringify(cmds));
}

function snapshot(zone) {
  const s = {};
  for (const f of FIELDS) s[f] = zone[f] ?? null;
  return s;
}

// Zonen, die gerade nicht antworten, liefern lauter null - das ist keine
// echte Änderung und würde das Protokoll mit Fehlalarmen füllen.
function isReadable(zone) {
  return zone.type === 'AC' && !zone.deviceOffline && zone.power != null;
}

// Wird bei jedem Cron-Lauf aufgerufen. Schreibt nur bei Änderung (oder
// einmalig, wenn eine Anlage zum ersten Mal gesehen wird).
export async function recordAcChanges(env, zones, now = new Date()) {
  const raw = await env.TADO_KV.get(CHANGES_KV_KEY);
  const log = raw ? JSON.parse(raw) : { v: 1, tickMinutes: TICK_MINUTES, since: now.toISOString(), last: {}, events: [] };
  const cmdRaw = await env.TADO_KV.get(CMD_KV_KEY);
  const cmds = cmdRaw ? JSON.parse(cmdRaw) : {};

  let dirty = !raw;
  for (const zone of zones.filter(isReadable)) {
    const cur = snapshot(zone);
    const prev = log.last[zone.key];
    if (!prev) {
      log.last[zone.key] = cur;
      dirty = true;
      continue;
    }
    const changes = {};
    for (const f of FIELDS) if (prev[f] !== cur[f]) changes[f] = [prev[f], cur[f]];
    if (!Object.keys(changes).length) continue;

    const cmdAt = cmds[zone.key] ? Date.parse(cmds[zone.key]) : 0;
    const viaDashboard = cmdAt && now.getTime() - cmdAt <= CMD_WINDOW_MS;
    log.events.push({
      t: now.toISOString(),
      zone: zone.key,
      name: zone.name,
      source: viaDashboard ? 'dashboard' : 'extern',
      changes,
    });
    log.last[zone.key] = cur;
    dirty = true;
  }

  if (!dirty) return { written: false };
  log.events = log.events.slice(-MAX_EVENTS);
  await env.TADO_KV.put(CHANGES_KV_KEY, JSON.stringify(log));
  return { written: true };
}

// GET /api/klima/aenderungen?zone=<Teil des Namens>&limit=<n>
// Neueste Änderungen zuerst.
export async function handleAcChanges(request, env, json) {
  const url = new URL(request.url);
  const zone = (url.searchParams.get('zone') || '').toLowerCase();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 50, 1), MAX_EVENTS);
  const raw = await env.TADO_KV.get(CHANGES_KV_KEY);
  if (!raw) return json(200, { since: null, tickMinutes: TICK_MINUTES, events: [] }, env);
  const log = JSON.parse(raw);
  const events = log.events
    .filter((e) => !zone || (e.name || '').toLowerCase().includes(zone))
    .slice(-limit)
    .reverse();
  return json(200, { since: log.since, tickMinutes: log.tickMinutes, events }, env);
}
