import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../constants.js';
/** Appends JSON lines describing every request/response so parser and prompt issues can be diagnosed. */
export class DebugLog {
    file;
    constructor(cwd, enabled, sessionId) {
        if (!enabled)
            return;
        const dir = path.join(cwd, CONFIG_DIR, 'logs');
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, `${sessionId}.jsonl`);
    }
    get enabled() {
        return !!this.file;
    }
    write(event) {
        if (!this.file)
            return;
        try {
            fs.appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8');
        }
        catch {
            /* never let logging break the agent */
        }
    }
}
//# sourceMappingURL=debug-log.js.map