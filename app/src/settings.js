// The SETTINGS tab: preferences that apply the moment they change. Search
// parameters (max age, EDDN) live elsewhere on the page; those inputs here are
// views of the same controls, so there is only ever one copy of the state.
import { DESKTOP } from "./desktop.js";
import { FONT_DEFAULT, clampFont, loadPrefs } from "./prefs.js";

const $ = (id) => document.getElementById(id);
const tauri = () => window.__TAURI__;

/** ctx: { store, journal() -> JournalState|null, reconnectJournal() } */
export function initSettings(ctx) {
  const { store } = ctx;
  const prefs = loadPrefs(store.get("cgbuy.prefs", null));
  const save = () => store.set("cgbuy.prefs", prefs);

  // Scales the whole page: fonts, rows, widths.
  const applyFont = () => {
    document.documentElement.style.zoom = String(prefs.font_size / FONT_DEFAULT);
    $("s-font").textContent = String(prefs.font_size);
  };
  const bumpFont = (d) => { prefs.font_size = d ? clampFont(prefs.font_size + d) : FONT_DEFAULT; applyFont(); save(); };
  $("s-font-minus").onclick = () => bumpFont(-1);
  $("s-font-plus").onclick = () => bumpFont(1);
  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey) return;
    const d = e.key === "+" || e.key === "=" ? 1 : e.key === "-" ? -1 : e.key === "0" ? 0 : null;
    if (d == null) return;
    e.preventDefault();
    bumpFont(d);
  });
  applyFont();

  // Mirrors of controls that live above the tabs: write through, read back on show.
  const fire = (el) => el.dispatchEvent(new Event("change", { bubbles: true }));
  $("s-max_age").onchange = () => { $("f-max_age_days").value = $("s-max_age").value; fire($("f-max_age_days")); };
  $("s-eddn").onchange = () => { $("f-eddn").checked = $("s-eddn").checked; fire($("f-eddn")); };

  const num = (id, key) => {
    const el = $(id);
    el.onchange = () => {
      const n = Math.round(Number(el.value));
      if (el.value !== "" && Number.isFinite(n) && n >= 0) prefs[key] = n;
      el.value = prefs[key];
      save();
    };
  };
  num("s-fresh", "cache_fresh_minutes");
  num("s-vtop", "verify_top");
  $("s-verify").onchange = () => { prefs.verify_edsm = $("s-verify").checked; save(); };
  $("s-update").onchange = () => { prefs.update_check = $("s-update").checked; save(); };
  $("s-sound").onchange = () => { prefs.alert_sound = $("s-sound").checked; save(); };

  $("s-reset").onclick = () => {
    const j = ctx.journal();
    if (!j) return;
    // The journal files still hold the old runs; remember when to stop learning from them.
    prefs.calAfter = Math.floor(Date.now() / 1000);
    j.calAfter = prefs.calAfter;
    j.cal.jump_secs.length = j.cal.dock_secs.length = j.cal.depart_secs.length = j.cal.approach_samples.length = 0;
    save();
    refresh();
  };

  async function pushNotify(on) {
    prefs.notifications = on;
    const n = tauri()?.notification;
    if (on && n && !(await n.isPermissionGranted())) prefs.notifications = (await n.requestPermission()) === "granted";
    $("s-notify").checked = prefs.notifications;
    save();
  }
  $("s-notify").onchange = () => pushNotify($("s-notify").checked);

  async function setDir(path) {
    try {
      const dir = await tauri().core.invoke("set_journal_dir", { path });
      store.set("cgbuy.journalDir", path || "");
      $("s-dir-msg").textContent = dir ? "" : "no journal folder found there";
      await ctx.reconnectJournal();
    } catch (err) {
      $("s-dir-msg").textContent = String(err);
    }
    refresh();
  }
  $("s-dir-set").onclick = () => setDir($("s-dir").value.trim() || null);
  $("s-dir-auto").onclick = () => { $("s-dir").value = ""; setDir(null); };
  $("s-dir-browse").hidden = !tauri()?.dialog;
  $("s-dir-browse").onclick = async () => {
    const p = await tauri().dialog.open({ directory: true, defaultPath: $("s-dir").value || undefined });
    if (typeof p === "string") { $("s-dir").value = p; setDir(p); }
  };
  for (const el of document.querySelectorAll(".desktop-only")) el.hidden = !DESKTOP;

  /** Re-read everything shown from the live state; called when the tab opens or the page re-renders. */
  async function refresh() {
    $("s-max_age").value = $("f-max_age_days").value;
    $("s-eddn").checked = $("f-eddn").checked;
    $("s-eddn").disabled = $("eddn-label").hidden;
    $("s-eddn-note").textContent = $("eddn-label").title
      || "Needs a journal folder: it uploads as the commander the journal names.";
    $("s-fresh").value = prefs.cache_fresh_minutes;
    $("s-vtop").value = prefs.verify_top;
    $("s-verify").checked = prefs.verify_edsm;
    $("s-sound").checked = prefs.alert_sound;
    $("s-update").checked = prefs.update_check;
    $("s-notify").checked = prefs.notifications;
    const j = ctx.journal();
    $("s-cal").textContent = j ? j.cal.summary() : "no journal data";
    $("s-reset").disabled = !j;
    if (DESKTOP) {
      const dir = await tauri().core.invoke("journal_dir").catch(() => null);
      $("s-dir-now").textContent = dir ? `in use: ${dir}` : "no journal folder found";
      $("s-dir").value = store.get("cgbuy.journalDir", "");
    }
  }

  return {
    prefs, refresh, save,
    /** Desktop notification, if switched on. */
    notify(title, body) {
      if (!DESKTOP || !prefs.notifications) return;
      tauri().notification?.sendNotification({ title, body });
    },
  };
}
