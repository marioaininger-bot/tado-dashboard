// Stromverbrauch der Klimaanlagen laut Panasonic Comfort Cloud: je Gerät, Tag und Stunde in kWh.
//
// Die Comfort-Cloud liefert bei Geräten mit Energiemessung (powerConsumptionFlg) Stundenwerte je Tag
// (deviceHistoryData). Der Cron-Trigger (alle 5 Minuten) holt sie in kleinen Portionen und legt sie dauerhaft in
// KV ab (Schlüssel ac_energy). Das Dashboard liest nur aus KV und fragt Panasonic nie selbst ab.
//
// Je Lauf höchstens MAX_DAYS_PER_RUN Tage (je Gerät eine Anfrage), damit der Cron im Free-Plan unter dem Limit
// von 50 Subrequests bleibt. Reihenfolge: heute (höchstens alle 30 Minuten neu), gestern (bis nach 3 Uhr heute
// noch einmal, damit die letzte Stunde vollständig ist), dann rückwärts bis BACKFILL_DAYS, was noch fehlt.
// Geschrieben wird nur, wenn etwas geholt wurde (KV: 1000 Schreibzugriffe pro Tag im Free-Plan).

import { isPanasonicConfigured, listPanasonicDevices, fetchPanasonicDayEnergy, displayName, PANASONIC_HOME_ID } from './panasonic.js';
import { viennaDayHour } from './runtime-log.js';

const KV_KEY = 'ac_energy';
const BACKFILL_DAYS = 60;
const RETENTION_DAYS = 400;
const MAX_DAYS_PER_RUN = 3;
const TODAY_REFRESH_MS = 30 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(dateIso, n) {
  return new Date(Date.parse(`${dateIso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// Ein Tag gilt als endgültig, wenn er nach 3 Uhr des Folgetags (Wiener Zeit) geholt wurde.
function isFinal(dateIso, fetchedAt) {
  const f = viennaDayHour(new Date(fetchedAt));
  const next = addDays(dateIso, 1);
  return f.day > next || (f.day === next && f.hour >= 3);
}

// Welche Tage sind in diesem Lauf an der Reihe (Reihenfolge siehe Kopf der Datei).
export function daysToFetch(fetched, now) {
  const today = viennaDayHour(now).day;
  const todo = [];
  for (let i = 0; i <= BACKFILL_DAYS && todo.length < MAX_DAYS_PER_RUN; i++) {
    const date = addDays(today, -i);
    const t = fetched[date];
    const due = !t
      || (date === today ? now.getTime() - Date.parse(t) >= TODAY_REFRESH_MS : !isFinal(date, t));
    if (due) todo.push(date);
  }
  return todo;
}

export async function syncAcEnergy(env, now = new Date()) {
  if (!isPanasonicConfigured(env)) return { written: false };
  const raw = await env.TADO_KV.get(KV_KEY);
  const log = raw ? JSON.parse(raw) : { v: 1, zones: {}, fetched: {} };
  const todo = daysToFetch(log.fetched, now);
  if (!todo.length) return { written: false };

  const devices = await listPanasonicDevices(env);
  for (const date of todo) {
    const results = await Promise.all(devices.map(async (device) => {
      try {
        return { device, hours: await fetchPanasonicDayEnergy(env, device, date) };
      } catch (err) {
        if (err.loginRequired) throw err;
        return { device, hours: null };               // einzelnes Gerät antwortet nicht: Tag bleibt für dieses Gerät leer
      }
    }));
    for (const { device, hours } of results) {
      const key = `${PANASONIC_HOME_ID}:${device.id}`;
      const zone = log.zones[key] || { name: displayName(device.name), days: {} };
      zone.name = displayName(device.name);
      if (hours) zone.days[date] = hours;
      log.zones[key] = zone;
    }
    log.fetched[date] = now.toISOString();
  }

  const cutoff = addDays(viennaDayHour(now).day, -RETENTION_DAYS);
  for (const zone of Object.values(log.zones)) for (const d of Object.keys(zone.days)) if (d < cutoff) delete zone.days[d];
  for (const d of Object.keys(log.fetched)) if (d < cutoff) delete log.fetched[d];

  await env.TADO_KV.put(KV_KEY, JSON.stringify(log));
  return { written: true, days: todo };
}

// Auswertung für die API: je Anlage und Tag die Summe in kWh (nur Stunden mit Wert) und die 24 Stundenwerte.
export function summariseEnergy(log, von, bis) {
  const zones = Object.entries(log.zones).map(([key, zone]) => ({
    key,
    name: zone.name,
    days: Object.keys(zone.days).sort()
      .filter((d) => (!von || d >= von) && (!bis || d <= bis))
      .map((date) => {
        const byHour = zone.days[date];
        const known = byHour.filter((v) => v !== null);
        return {
          date,
          kwh: Math.round(known.reduce((a, b) => a + b, 0) * 1000) / 1000,
          hoursKnown: known.length,
          byHour,
          fetchedAt: log.fetched[date] || null,
        };
      }),
  }));
  return { zones };
}

export async function handleEnergy(request, env, json) {
  const url = new URL(request.url);
  const von = url.searchParams.get('von');
  const bis = url.searchParams.get('bis');
  if ((von && !DATE_RE.test(von)) || (bis && !DATE_RE.test(bis))) {
    return json(400, { error: 'Datum bitte als JJJJ-MM-TT angeben (von, bis).', code: 'BAD_DATE' }, env);
  }
  const raw = await env.TADO_KV.get(KV_KEY);
  if (!raw) return json(200, { zones: [] }, env);
  return json(200, summariseEnergy(JSON.parse(raw), von, bis), env);
}
