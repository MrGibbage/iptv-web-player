import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

// A real log file that survives independent of wherever the process's own
// stdout happens to be redirected — found via a real incident that it
// otherwise isn't: dev's stdout redirect had pointed at a scratchpad file
// that got deleted mid-session, silently losing everything logged since.
// console.log alone is not durable logging.
const LOG_DIR = process.env.LOG_DIR ?? "./data/logs";
const LOG_FILE = path.join(LOG_DIR, "app.log");
const ROTATED_FILE = path.join(LOG_DIR, "app.log.1");
// Full ffmpeg stderr gets appended on every unexpected exit (PLAN.md
// "Playback implementation" — that's the whole point), which can be
// several KB each; one rotation generation bounds growth without needing
// Laomedeia's fuller 4-generation scheme for what's currently a single log.
const MAX_BYTES = 2 * 1024 * 1024;
mkdirSync(LOG_DIR, { recursive: true });

function rotateIfNeeded(): void {
  try {
    if (statSync(LOG_FILE).size >= MAX_BYTES) {
      renameSync(LOG_FILE, ROTATED_FILE);
    }
  } catch {
    // no existing log file yet — nothing to rotate
  }
}

export function log(scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${scope}] ${message}`;
  rotateIfNeeded();
  appendFileSync(LOG_FILE, line + "\n");
  console.log(line);
}
