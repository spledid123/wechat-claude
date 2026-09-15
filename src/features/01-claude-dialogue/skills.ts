/**
 * User-extensible reference skills (skills/).
 *
 * Skills are plain folders — no SDK skill tooling. Each subfolder with a
 * SKILL.md is one skill: the file's frontmatter `description:` is surfaced
 * to the AI in the system prompt, and the whole folder is copied into each
 * session workspace so the agent can Read/Bash it. Users can drop new
 * folders next to the exe (portable layout) or into the repo skills/ dir;
 * `syncSkills` propagates them into existing workspaces folder-by-folder,
 * so additions take effect on the next message without a restart.
 */

import fs from "node:fs";
import path from "node:path";

export interface SkillSummary {
  /** Folder name — also the path the AI reads (skills/<name>/SKILL.md). */
  name: string;
  /** One-line description from SKILL.md frontmatter (may be empty). */
  description: string;
}

const SKILL_FILE = "SKILL.md";
const DESC_SCAN_LIMIT = 8192;

/** List the skills under a root dir (missing dir → empty list). */
export function listSkills(skillsRoot: string): SkillSummary[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillFile = path.join(skillsRoot, entry.name, SKILL_FILE);
    if (!fs.existsSync(skillFile)) continue;
    skills.push({
      name: entry.name,
      description: readSkillDescription(skillFile),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Copy any source skill folder missing from the workspace (per-folder, so
 * user additions propagate to already-created sessions; updates to existing
 * copies are deliberately not pushed — delete the session to refresh).
 */
export function syncSkills(
  sourceSkillsRoot: string | undefined,
  workspaceDir: string,
): void {
  if (!sourceSkillsRoot) return;
  let sources: fs.Dirent[];
  try {
    sources = fs.readdirSync(sourceSkillsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of sources) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const src = path.join(sourceSkillsRoot, entry.name);
    if (!fs.existsSync(path.join(src, SKILL_FILE))) continue;
    const dest = path.join(workspaceDir, "skills", entry.name);
    if (fs.existsSync(dest)) continue;
    try {
      fs.mkdirSync(path.join(workspaceDir, "skills"), { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    } catch {
      /* a broken/locked skill folder must not break the message flow */
    }
  }
}

/** Pull `description:` from SKILL.md frontmatter, else the first heading. */
function readSkillDescription(skillFile: string): string {
  let head: string;
  try {
    const fd = fs.openSync(skillFile, "r");
    try {
      const buf = Buffer.alloc(DESC_SCAN_LIMIT);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString("utf-8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  const desc = head.match(/^description:\s*(.+)\s*$/m);
  if (desc) {
    let value = desc[1].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  const heading = head.match(/^#\s+(.+)\s*$/m);
  return heading ? heading[1].trim() : "";
}
