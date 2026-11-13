// Push-Nachrichten aufs Handy über ntfy (https://ntfy.sh).
//
// Der Cron-Trigger (alle 5 Minuten) meldet hier die aktuell zutreffenden
// "Zustände" (Fenster offen, Batterie schwach, ...). Das Modul merkt sich in
// KV (Schlüssel notify_state), seit wann ein Zustand gilt und ob dafür schon
// eine Nachricht rausging, damit nicht alle 5 Minuten dieselbe Meldung kommt.
// Fällt der Zustand weg, kommt (falls vorher gemeldet) eine Entwarnung.
//
// Geschrieben wird nur bei einer Änderung des Zustands (KV-Limit im Free-Plan:
// 1000 Schreibzugriffe pro Tag).
//
// Secret NTFY_TOPIC (langer, zufälliger Name - er ist das "Passwort" des
// Topics). Ohne dieses Secret passiert nichts. Optional: Variable NTFY_URL
// für einen eigenen ntfy-Server (Standard https://ntfy.sh).

const STATE_KV_KEY = 'notify_state';
const DEFAULT_NTFY_URL = 'https://ntfy.sh';

// Wie lange ein Zustand mindestens bestehen muss, bevor eine Nachricht rausgeht.
export const MIN_AGE = {
  panasonicLogin: 0,
  window: 10 * 60 * 1000,
  battery: 0,
  offline: 15 * 60 * 1000,
  tadoData: 30 * 60 * 1000,
};

export function isNotifyConfigured(env) {
  return Boolean(env.NTFY_TOPIC);
}

// Schickt eine Nachricht. Gibt true zurück, wenn ntfy sie angenommen hat.
// JSON-Variante, damit Umlaute und Emojis in Titel/Text keine Header-Probleme machen.
export async function sendPush(env, msg) {
  return (await sendPushDetailed(env, msg)).ok;
}

// Wie sendPush, liefert aber { ok, status, detail } für die Diagnose
// (Testroute). Der Topic-Name wird aus dem Text entfernt, damit er nie in einer
// Antwort oder einem Log auftaucht.
export async function sendPushDetailed(env, { title, message, priority = 3, tags = [] }) {
  if (!isNotifyConfigured(env)) return { ok: false, status: null, detail: 'NTFY_TOPIC ist nicht gesetzt.' };
  const scrub = (text) => String(text).split(env.NTFY_TOPIC).join('***').slice(0, 300);
  try {
    const res = await fetch(env.NTFY_URL || DEFAULT_NTFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, priority, tags }),
    });
    const detail = res.ok ? '' : scrub(await res.text().catch(() => ''));
    return { ok: res.ok, status: res.status, detail };
  } catch (err) {
    return { ok: false, status: null, detail: scrub(err && err.message ? err.message : err) };
  }
}

async function loadState(env) {
  const raw = await env.TADO_KV.get(STATE_KV_KEY);
  try {
    const state = raw ? JSON.parse(raw) : {};
    return state && typeof state === 'object' ? state : {};
  } catch (err) {
    return {};
  }
}

// conditions: Liste zutreffender Zustände
//   { key, minAge, title, message, priority?, tags?, recovered? }
// checked: Schlüssel-Präfixe, die in diesem Lauf sicher geprüft wurden. Nur
//   dafür gilt "nicht in conditions" als "wieder in Ordnung". Was nicht geprüft
//   werden konnte (z. B. Tado-Abruf fehlgeschlagen), bleibt unverändert.
export async function evaluateNotifications(env, conditions, checked) {
  if (!isNotifyConfigured(env)) return;

  const state = await loadState(env);
  const now = Date.now();
  let changed = false;
  const present = new Set();

  for (const cond of conditions) {
    present.add(cond.key);
    let entry = state[cond.key];
    if (!entry) {
      entry = { since: now, notified: false };
      state[cond.key] = entry;
      changed = true;
    }
    if (!entry.notified && now - entry.since >= cond.minAge) {
      const ok = await sendPush(env, cond);
      // Bei Fehler nicht als gemeldet markieren: nächster Lauf versucht es erneut.
      if (ok) {
        entry.notified = true;
        entry.recovered = cond.recovered || null;
        changed = true;
      }
    }
  }

  for (const key of Object.keys(state)) {
    if (present.has(key)) continue;
    if (!checked.some((prefix) => key.startsWith(prefix))) continue;
    const entry = state[key];
    if (entry.notified && entry.recovered) {
      await sendPush(env, { title: entry.recovered.title, message: entry.recovered.message, priority: 2, tags: ['white_check_mark'] });
    }
    delete state[key];
    changed = true;
  }

  if (changed) await env.TADO_KV.put(STATE_KV_KEY, JSON.stringify(state));
}

// Baut aus den Zonen (Tado + Panasonic) die Zustände für Fenster, Batterie, Offline.
export function conditionsFromZones(zones) {
  const out = [];
  for (const zone of zones) {
    if (zone.type === 'AC' || zone.noPowerData) continue; // Panasonic-Zonen haben keine Tado-Geräte
    const k = zone.key;
    const name = zone.name;
    if (zone.openWindow) {
      out.push({
        key: `window:${k}`, minAge: MIN_AGE.window,
        title: `Fenster offen: ${name}`,
        message: `Im Raum ${name} ist seit über 10 Minuten ein Fenster offen.`,
        priority: 3, tags: ['window'],
        recovered: { title: `Fenster zu: ${name}`, message: `Im Raum ${name} ist das Fenster wieder zu.` },
      });
    }
    if (zone.batteryLow) {
      out.push({
        key: `battery:${k}`, minAge: MIN_AGE.battery,
        title: `Batterie schwach: ${name}`,
        message: `Das Tado-Thermostat im Raum ${name} meldet eine schwache Batterie.`,
        priority: 3, tags: ['battery'],
      });
    }
    if (zone.deviceOffline) {
      out.push({
        key: `offline:${k}`, minAge: MIN_AGE.offline,
        title: `Tado-Gerät offline: ${name}`,
        message: `Ein Gerät im Raum ${name} ist seit über 15 Minuten nicht erreichbar.`,
        priority: 4, tags: ['warning'],
        recovered: { title: `Wieder online: ${name}`, message: `Das Gerät im Raum ${name} ist wieder erreichbar.` },
      });
    }
  }
  return out;
}
