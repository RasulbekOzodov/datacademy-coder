import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../constants.js';
import type { Message } from '../llm/types.js';

export interface SessionFile {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  provider: string;
  model: string;
  toolMode?: 'native' | 'text';
  messages: Message[];
}

export function sessionsDir(cwd: string): string {
  return path.join(cwd, CONFIG_DIR, 'sessions');
}

export function newSessionId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function saveSession(cwd: string, session: SessionFile): string {
  const dir = sessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${session.id}.json`);
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(session, null, 2), 'utf8');
  return file;
}

export function loadSession(cwd: string, id: string): SessionFile {
  const file = path.join(sessionsDir(cwd), id.endsWith('.json') ? id : `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`Session not found: ${id}`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionFile;
  if (!Array.isArray(data.messages)) throw new Error(`Invalid session file: ${file}`);
  return data;
}

export function latestSessionId(cwd: string): string | undefined {
  return listSessions(cwd).find((s) => s.messages > 0)?.id;
}

/** Short preview of a session for pickers: the first user message. */
export function sessionPreview(cwd: string, id: string): string {
  try {
    const s = loadSession(cwd, id);
    const first = s.messages.find((m) => m.role === 'user' && m.meta?.kind !== 'tool_result');
    return (first?.content ?? '').split('\n')[0].slice(0, 70);
  } catch {
    return '';
  }
}

export function listSessions(cwd: string): Array<{ id: string; updatedAt: string; messages: number; model: string }> {
  const dir = sessionsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SessionFile;
        return { id: f.replace(/\.json$/, ''), updatedAt: s.updatedAt ?? '', messages: s.messages?.length ?? 0, model: s.model ?? '' };
      } catch {
        return { id: f.replace(/\.json$/, ''), updatedAt: '', messages: 0, model: '?' };
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
