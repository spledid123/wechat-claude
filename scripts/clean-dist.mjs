// Wipe the tsc output so stale modules (e.g. removed features) never leak
// into fresh builds or the portable staging copy.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
fs.rmSync(dist, { recursive: true, force: true });
