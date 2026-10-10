// Makes the app's version follow ../version.py, which is the one place the
// number lives (the release workflow rewrites that line and nothing else).
//
//   node stamp-version.mjs          rewrite the files below to match
//   node stamp-version.mjs --check  exit 1 if any of them has drifted
//
// Three files carry the number and each wants its own spelling:
//   src/version.js            "1.9"    what EDDN records as softwareVersion
//   src-tauri/tauri.conf.json "1.9.0"  Tauri insists on three parts (semver)
//   src-tauri/Cargo.toml      "1.9.0"  same, and Cargo.lock must follow it or
//                                      `cargo ... --locked` refuses to build
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export function sourceVersion() {
  const m = readFileSync(here("../version.py"), "utf8").match(/^VERSION = "(\d+\.\d+(?:\.\d+)?)"/m);
  if (!m) throw new Error("could not find VERSION in ../version.py");
  return m[1];
}

/** [file, pattern whose first group is the old number, replacement number]. */
function targets(v) {
  const semver = v.split(".").length === 2 ? v + ".0" : v;
  return [
    ["src/version.js", /^(export const VERSION = ")[^"]*(")/m, v],
    ["src-tauri/tauri.conf.json", /^(  "version": ")[^"]*(")/m, semver],
    ["src-tauri/Cargo.toml", /^(version = ")[^"]*(")/m, semver],
    ["src-tauri/Cargo.lock", /(name = "cgbuy"\r?\nversion = ")[^"]*(")/, semver],
  ];
}

/** The files whose number differs from version.py, as "file: found, want". */
export function drift() {
  return targets(sourceVersion()).flatMap(([file, re, want]) => {
    const found = readFileSync(here(file), "utf8").match(re);
    const have = found && found[0].slice(found[1].length, found[0].length - found[2].length);
    return have === want ? [] : [`${file}: has ${have}, version.py says ${want}`];
  });
}

function stamp() {
  for (const [file, re, want] of targets(sourceVersion())) {
    const s = readFileSync(here(file), "utf8");
    if (!re.test(s)) throw new Error(`no version line found in ${file}`);
    writeFileSync(here(file), s.replace(re, `$1${want}$2`));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const bad = drift();
    bad.forEach((l) => console.error(l));
    process.exit(bad.length ? 1 : 0);
  }
  stamp();
}
