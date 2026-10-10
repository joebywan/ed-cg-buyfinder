// Naming the browser for the journal button's tooltip. Only used where the
// browser can't keep a folder open, so Chrome and Edge never need a name.

/** "Brave", "Firefox", "Safari", or null. Brave sends Chrome's user agent
 *  unchanged, so it is recognised by the navigator.brave object instead. */
export function browserName({ userAgent = "", brave = null } = {}) {
  if (brave) return "Brave";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Safari\//.test(userAgent) && !/(Chrome|Chromium|Edg)\//.test(userAgent)) return "Safari";
  return null;
}

export function folderTooltip(nav) {
  return `${browserName(nav) || "This browser"} restricts monitoring folders, you need to do this every time you want to load the logs. Chrome/Edge you don't need to.`;
}
