// Laufzeit-Protokoll der Klimaanlagen: zählt je Tag und Stunde, wie viele
// 5-Minuten-Messungen (Cron-Trigger) eine Anlage eingeschaltet war, getrennt
// nach Modus (Kühlen, Heizen, ...). Basis für den späteren Abgleich mit dem
// echten Stromverbrauch aus dem Smart Meter.
//
// Der normale Verlauf (zone_history) reicht dafür nicht: er hält nur 24 Stunden
// und kennt bei Panasonic keine Leistung. Dieses Protokoll wächst dagegen mit
// (400 Tage), bleibt klein und schreibt nur, wenn eine Anlage läuft. Stunden
// ohne Eintrag heißen deshalb "aus", gelten aber erst ab `since` (dem Tag, an
// dem das Protokoll angelegt wurde).
//
// Fehlt eine Cron-Messung (Worker-Ausfall), wird diese Zeit als "aus" gezählt.
// Die Werte sind daher eine Untergrenze.

const RUNTIME_KV_KEY = 'runtime_log';
export const TICK_MINUTES = 5;               // Takt des Cron-Triggers (wrangler.toml)
const RETENTION_DAYS = 400;
const TZ = 'Europe/Vienna';
const MODES = ['COOL', 'HEAT', 'DRY', 'FAN', 'AUTO'];

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

// Datum (JJJJ-MM-TT) und Stunde (0-23) in Wiener Ortszeit.
export function viennaDayHour(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function emptyLog(now) {
  return { v: 1, since: viennaDayHour(now).day, tickMinutes: TICK_MINUTES, zones: {} };
}

async function loadLog(env, now) {
  const raw = await env.TADO_KV.get(RUNTIME_KV_KEY);
  return raw ? JSON.parse(raw) : { ...emptyLog(now), fresh: true };
}

function isRunningAc(zone) {
  return zone.type === 'AC' && zone.power === 'ON' && !zone.deviceOffline;
}

// Wird bei jedem Cron-Lauf aufgerufen. Schreibt nur, wenn eine Anlage läuft
// (oder einmalig beim Anlegen), um das KV-Schreiblimit zu schonen.
export async function recordRuntime(env, zones, now = new Date()) {
  const log = await loadLog(env, now);
  const running = zones.filter(isRunningAc);
  if (!running.length && !log.fresh) return { written: false };
  delete log.fresh;

  const { day, hour } = viennaDayHour(now);
  const hh = String(hour).padStart(2, '0');
  for (const zone of running) {
    const entry = log.zones[zone.key] || { name: zone.name, days: {} };
    entry.name = zone.name;
    const dayData = entry.days[day] || {};
    const slot = dayData[hh] || { on: 0 };
    slot.on += 1;
    const mode = MODES.includes(zone.mode) ? zone.mode : 'AUTO';
    slot[mode] = (slot[mode] || 0) + 1;
    dayData[hh] = slot;
    entry.days[day] = dayData;
    log.zones[zone.key] = entry;
  }

  // Alte Tage entfernen (ISO-Datum sortiert alphabetisch wie chronologisch).
  const cutoff = viennaDayHour(new Date(now.getTime() - RETENTION_DAYS * 86400000)).day;
  for (const entry of Object.values(log.zones)) {
    for (const d of Object.keys(entry.days)) if (d < cutoff) delete entry.days[d];
  }

  await env.TADO_KV.put(RUNTIME_KV_KEY, JSON.stringify(log));
  return { written: true };
}

// Auswertung für die API: je Anlage und Tag die Minuten insgesamt, je Stunde
// und je Modus. Tage ohne Eintrag fehlen (= Anlage war aus, sofern >= since).
export function summarise(log, von, bis) {
  const zones = Object.entries(log.zones).map(([key, entry]) => {
    const days = Object.keys(entry.days).sort()
      .filter((d) => (!von || d >= von) && (!bis || d <= bis))
      .map((date) => {
        const byHour = Array(24).fill(0);
        const modes = {};
        for (const [hh, slot] of Object.entries(entry.days[date])) {
          byHour[Number(hh)] = slot.on * log.tickMinutes;
          for (const m of MODES) if (slot[m]) modes[m] = (modes[m] || 0) + slot[m] * log.tickMinutes;
        }
        return { date, minutes: byHour.reduce((a, b) => a + b, 0), byHour, modes };
      });
    return { key, name: entry.name, days };
  });
  return { since: log.since, tickMinutes: log.tickMinutes, zones };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleRuntime(request, env, json) {
  const url = new URL(request.url);
  const von = url.searchParams.get('von');
  const bis = url.searchParams.get('bis');
  if ((von && !DATE_RE.test(von)) || (bis && !DATE_RE.test(bis))) {
    return json(400, { error: 'Datum bitte als JJJJ-MM-TT angeben (von, bis).', code: 'BAD_DATE' }, env);
  }
  const raw = await env.TADO_KV.get(RUNTIME_KV_KEY);
  if (!raw) {
    return json(200, { since: null, tickMinutes: TICK_MINUTES, zones: [] }, env);
  }
  return json(200, summarise(JSON.parse(raw), von, bis), env);
}
