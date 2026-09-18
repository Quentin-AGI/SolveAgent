import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const dist = resolve(root, "dist");
const files = ["index.html", "styles.css", "script.js", "favicon.svg"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
for (const file of files) cpSync(resolve(root, file), resolve(dist, file));
console.log(`Built ${files.length} files into ${dist}`);
