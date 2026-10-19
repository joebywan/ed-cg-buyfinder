// The text "Copy N stations" puts on the clipboard, for pasting into Discord.
import { daysOld } from "./model.js";

const num = (n) => Number(n).toLocaleString("en-US");
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${(n / 1000).toFixed(1)}k`);

/**
 * lines: [{ station, system, ls, ly, parts: [{ commodity, tonnes }], cr_per_min, updated }] in screen order.
 * Lines from the same station merge: their commodities join and the best cr/min wins.
 * The header's age is the oldest market among them.
 */
export function copySummary({ dest, hold, lines, now = new Date() }) {
  const by = new Map();
  for (const l of lines) {
    const key = `${l.station}\0${l.system}`;
    const was = by.get(key);
    by.set(key, was ? { ...was, parts: [...was.parts, ...l.parts], cr_per_min: Math.max(was.cr_per_min, l.cr_per_min),
      updated: (daysOld(l.updated, now) ?? 0) > (daysOld(was.updated, now) ?? 0) ? l.updated : was.updated } : l);
  }
  const days = Math.max(0, ...[...by.values()].map((l) => daysOld(l.updated, now) ?? 0));
  return [`ED CG Buyfinder · ${dest} · ${num(hold)}t hold · data ${days < 1 ? "<1d" : `${days}d`} old`,
    ...[...by.values()].map((l) => [`${l.station} (${num(l.ls)} ls)`, `${l.system} (${l.ly} ly)`,
      l.parts.map((p) => `${p.commodity} ${num(p.tonnes)}t`).join(" + "), `${k(l.cr_per_min)} cr/min`].join(" · "))].join("\n");
}
