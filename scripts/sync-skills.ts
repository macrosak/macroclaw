import { resolve, dirname, join } from "path";
import { cpSync, readdirSync, mkdirSync } from "fs";

const repoRoot = resolve(dirname(import.meta.dir));
const defaultWorkspace = resolve(process.env.HOME || "~", ".macroclaw-workspace");
const workspace = process.env.WORKSPACE
  ? resolve(process.env.WORKSPACE)
  : defaultWorkspace;

const skillsSource = join(repoRoot, "skills");
const skillsTarget = join(workspace, ".claude", "skills");

mkdirSync(skillsTarget, { recursive: true });

const entries = readdirSync(skillsSource, { withFileTypes: true }).filter(
  (e) => e.isDirectory(),
);

if (entries.length === 0) {
  console.log("[sync-skills] No skills found in skills/");
  process.exit(0);
}

for (const entry of entries) {
  const src = join(skillsSource, entry.name);
  const dst = join(skillsTarget, entry.name);
  cpSync(src, dst, { recursive: true });
  console.log(`[sync-skills] ${entry.name} -> ${dst}`);
}

console.log(`[sync-skills] Synced ${entries.length} skill(s) to ${workspace}`);
