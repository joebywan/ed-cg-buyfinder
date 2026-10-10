// Running inside the Tauri desktop app (withGlobalTauri): the app supplies the
// journal folder and the settings file, so neither browser API is needed.

export const DESKTOP = typeof window !== "undefined" && !!window.__TAURI__;

const tauriInvoke = (name, args) => window.__TAURI__.core.invoke(name, args);

/** The old Python app's cgbuy.json as this page's store keys. Only what maps
 *  cleanly: search boxes, odyssey, the hand-set destination, EDDN on/off. */
export function mapLegacy(legacy) {
  const out = {};
  if (!legacy || typeof legacy !== "object") return out;
  const settings = {};
  const p = legacy.params || {};
  for (const k of ["hold", "range", "jump_empty", "jump_laden", "min_supply", "max_age_days"]) {
    const n = Number(p[k]);
    if (p[k] !== "" && p[k] != null && Number.isFinite(n) && n >= 0) settings[k] = n;
  }
  if (["L", "M", "S"].includes(legacy.pad_override)) settings.pad = legacy.pad_override;
  if (typeof legacy.odyssey === "boolean") settings.odyssey = legacy.odyssey;
  if (Object.keys(settings).length) out["cgbuy.settings"] = settings;
  if (typeof legacy.eddn_enabled === "boolean") out["cgbuy.eddn"] = legacy.eddn_enabled;
  const d = legacy.dest;
  if (legacy.dest_manual && d?.system && d.station && d.commodities?.length) {
    out["cgbuy.dest"] = { system: d.system, station: d.station, commodities: d.commodities,
                          title: d.title || "", expiry: d.expiry || null };
  }
  return out;
}

/** Same get/set shape as the localStorage store, but synchronous over an
 *  in-memory object that is saved behind it. */
export async function loadStore(invoke = tauriInvoke, delay = 300) {
  let data = {};
  try {
    const { store, legacy } = await invoke("config_load");
    data = store ?? mapLegacy(legacy);
  } catch { /* start empty */ }
  let timer;
  return {
    get: (key, fallback) => (key in data ? data[key] : fallback),
    set(key, value) {
      data[key] = value;
      clearTimeout(timer);
      timer = setTimeout(() => invoke("config_save", { store: data }).catch(() => {}), delay);
    },
  };
}

/** The slice of FileSystemDirectoryHandle that JournalTail uses, over the
 *  journal_list / journal_read commands. */
export class DesktopDir {
  constructor(invoke = tauriInvoke) { this.invoke = invoke; }

  #file({ name, size, mtime_ms }) {
    const read = (offset) => this.invoke("journal_read", { name, offset });
    return {
      kind: "file", name,
      getFile: async () => ({
        size, lastModified: mtime_ms, name,
        slice: (from) => ({ arrayBuffer: () => read(from) }),
        arrayBuffer: () => read(0),
        text: async () => new TextDecoder().decode(await read(0)),
      }),
    };
  }

  async *entries() {
    for (const f of await this.invoke("journal_list")) yield [f.name, this.#file(f)];
  }

  async getFileHandle(name) {
    const f = (await this.invoke("journal_list")).find((x) => x.name === name);
    if (!f) throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
    return this.#file(f);
  }
}

export const desktopStore = DESKTOP ? await loadStore() : null;
export const journalDir = DESKTOP ? await tauriInvoke("journal_dir").catch(() => null) : null;
