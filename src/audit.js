import fs from 'node:fs';
import path from 'node:path';

const MAX_FIELD = 300;

function clean(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return undefined;
  return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD)}...` : text;
}

export function createAudit(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  try {
    const stat = fs.statSync(file);
    if (stat.size > 5 * 1024 * 1024) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // No existing log, nothing to rotate.
  }

  return function audit(record) {
    const safe = {};
    for (const [key, value] of Object.entries(record)) {
      const cleaned = clean(value);
      if (cleaned !== undefined) safe[key] = cleaned;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...safe });
    try {
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch {
      // Auditing must never take the bridge down.
    }
  };
}
