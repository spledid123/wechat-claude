import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

copyDir(
  path.join(root, "src", "features", "01-claude-dialogue", "db", "migrations"),
  path.join(root, "dist", "src", "features", "01-claude-dialogue", "db", "migrations"),
);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}
