// Copies just the web app into src-tauri/dist (frontendDist); keeps .git, test/, node_modules out.
import { cpSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const out = fileURLToPath(new URL("./dist", import.meta.url));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["index.html", "app.js", "style.css", "icon.png", "src"]) {
  cpSync(root + f, out + "/" + f, { recursive: true });
}
