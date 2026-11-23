import { readdirSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join, basename } from 'path';

const STATE_DIR = join(
  homedir(),
  'Library/Application Support/Ulanzi/UlanziDeck/claude-state'
);

const WORKING_STALE_MS = 15 * 60 * 1000; // working with no events this long = dead session
const DEAD_MS = 12 * 60 * 60 * 1000;     // any file this old is ignored entirely

const PRIORITY = { asking: 4, attention: 3, compacting: 2, working: 1, waiting: 0 };

// TTYs ('/dev/ttysNNN') with a live claude TUI on them, or null if ps failed.
// readStates() runs every second per key, so the ps result is cached briefly.
const LIVE_TTY_TTL_MS = 2000;
let liveTtyCache = { at: 0, ttys: null };

function liveClaudeTtys() {
  const now = Date.now();
  if (now - liveTtyCache.at < LIVE_TTY_TTL_MS) return liveTtyCache.ttys;
  let ttys = null;
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'tty=,command='], { encoding: 'utf8', timeout: 3000 });
    ttys = new Set();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\S+)\s+(.*)$/);
      if (m && m[1] !== '??' && /claude/.test(m[2])) ttys.add('/dev/' + m[1]);
    }
  } catch { /* ps unavailable — don't filter */ }
  liveTtyCache = { at: now, ttys };
  return ttys;
}

export function readStates() {
  let files;
  try {
    // skip dotfiles: the dir also holds helper files like .bigkey-widget.json
    files = readdirSync(STATE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return [];
  }
  const now = Date.now();
  const live = liveClaudeTtys();
  const states = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'));
      if (!(s.state in PRIORITY) || typeof s.ts !== 'number') continue; // not a session state file
      s.sid = f.slice(0, -5);
      const age = now - s.ts * 1000;
      if (age > DEAD_MS) continue;
      // Only sessions with a live claude on a terminal can receive keystrokes.
      // Drops tty-less sessions (Claude Desktop, headless) and sessions whose
      // terminal died without a SessionEnd — they used to win the target pick
      // and swallow every /model, /effort, /clear and /compact press.
      if (live && !(s.tty && live.has(s.tty))) continue;
      if ((s.state === 'working' || s.state === 'compacting' || s.state === 'asking') && age > WORKING_STALE_MS) {
        s.state = 'waiting';
      }
      states.push(s);
    } catch { /* partial write or bad file — skip */ }
  }
  return states;
}

// Overall pet state. Optional dir filter narrows to sessions in that project.
export function aggregateState(states, dir) {
  let list = states;
  if (dir) list = states.filter(s => s.cwd === dir || s.cwd.startsWith(dir + '/'));
  if (!list.length) return { state: 'none', count: 0 };
  let best = list[0];
  // highest priority wins; ties go to the most recently active session
  // (was: first file in directory order, i.e. alphabetical by session id)
  for (const s of list) {
    const dp = PRIORITY[s.state] - PRIORITY[best.state];
    if (dp > 0 || (dp === 0 && s.ts > best.ts)) best = s;
  }
  return { ...best, count: list.length };
}

// The session currently asking a question with a captured option list.
// A pinned session's question wins when several ask at once (so the switch
// key chooses which one to answer first); otherwise the newest ask shows.
export function askingSession(states, preferSid) {
  const asking = states.filter(s => s.state === 'asking' && s.ask && s.ask.options?.length);
  if (!asking.length) return null;
  if (preferSid) {
    const pinned = asking.find(s => s.sid === preferSid);
    if (pinned) return pinned;
  }
  return asking.reduce((a, b) => (b.ts > a.ts ? b : a));
}

// Best-effort match of an iTerm session (by its title) to a Claude session:
// Claude Code titles usually contain the project directory name.
export function stateForSessionName(states, name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  const matches = states.filter(s => {
    const base = basename(s.cwd || '').toLowerCase();
    return base && lower.includes(base);
  });
  if (matches.length) {
    let best = matches[0];
    for (const s of matches) {
      if (PRIORITY[s.state] > PRIORITY[best.state]) best = s;
    }
    return best;
  }
  if (states.length === 1) return states[0]; // only one live claude — assume it's this one
  return null;
}
