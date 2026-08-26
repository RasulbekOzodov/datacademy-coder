import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../constants.js';
export function sessionsDir(cwd) {
    return path.join(cwd, CONFIG_DIR, 'sessions');
}
export function newSessionId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
export function saveSession(cwd, session) {
    const dir = sessionsDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${session.id}.json`);
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(session, null, 2), 'utf8');
    return file;
}
export function loadSession(cwd, id) {
    const file = path.join(sessionsDir(cwd), id.endsWith('.json') ? id : `${id}.json`);
    if (!fs.existsSync(file))
        throw new Error(`Session not found: ${id}`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.messages))
        throw new Error(`Invalid session file: ${file}`);
    return data;
}
export function latestSessionId(cwd) {
    return listSessions(cwd).find((s) => s.messages > 0)?.id;
}
/** Short preview of a session for pickers: the first user message. */
export function sessionPreview(cwd, id) {
    try {
        const s = loadSession(cwd, id);
        const first = s.messages.find((m) => m.role === 'user' && m.meta?.kind !== 'tool_result');
        return (first?.content ?? '').split('\n')[0].slice(0, 70);
    }
    catch {
        return '';
    }
}
export function listSessions(cwd) {
    const dir = sessionsDir(cwd);
    if (!fs.existsSync(dir))
        return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
        try {
            const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            return { id: f.replace(/\.json$/, ''), updatedAt: s.updatedAt ?? '', messages: s.messages?.length ?? 0, model: s.model ?? '' };
        }
        catch {
            return { id: f.replace(/\.json$/, ''), updatedAt: '', messages: 0, model: '?' };
        }
    })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
//# sourceMappingURL=session.js.map