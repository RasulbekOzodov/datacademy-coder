import path from 'node:path';
import { isDangerousCommand } from '../tools/shell.js';
import type { Tool, ToolArgs, ToolContext } from '../tools/types.js';
import { isInside, resolvePath } from '../tools/util.js';

export type PermissionAnswer = 'once' | 'always' | 'deny';

export interface PermissionRequest {
  tool: Tool;
  args: ToolArgs;
  description: string;
  preview?: string;
  dangerous: boolean;
}

export type PermissionPrompter = (req: PermissionRequest) => Promise<PermissionAnswer>;

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
}

const PATH_KEYS = ['path', 'file', 'filename', 'file_path'];

export class PermissionManager {
  yolo: boolean;
  private sessionAllow = new Set<string>();
  private configAllow: string[];

  constructor(
    opts: { mode: 'ask' | 'yolo'; allow: string[] },
    private prompter: PermissionPrompter,
  ) {
    this.yolo = opts.mode === 'yolo';
    this.configAllow = opts.allow;
  }

  allowForSession(tool: Tool): void {
    this.sessionAllow.add(tool.name);
  }

  private isAllowlisted(tool: Tool, args: ToolArgs): boolean {
    if (this.sessionAllow.has(tool.name)) return true;
    for (const entry of this.configAllow) {
      if (entry === tool.name) return true;
      if (tool.name === 'shell' && entry.startsWith('shell:')) {
        const prefix = entry.slice(6).trim();
        const cmd = String(args.command ?? args.cmd ?? '').trim();
        if (prefix && cmd.startsWith(prefix)) return true;
      }
    }
    return false;
  }

  async check(tool: Tool, args: ToolArgs, ctx: ToolContext): Promise<PermissionDecision> {
    if (tool.permission === 'read') return { allowed: true };

    // Hard guards for writes: stay inside the working directory, never touch .git internals.
    if (tool.permission === 'write') {
      const raw = PATH_KEYS.map((k) => args[k]).find((v) => typeof v === 'string') as string | undefined;
      if (raw) {
        const abs = resolvePath(ctx.cwd, raw);
        if (!isInside(ctx.cwd, abs)) {
          return { allowed: false, reason: `Refused: ${raw} is outside the working directory ${ctx.cwd}.` };
        }
        const rel = path.relative(ctx.cwd, abs).split(path.sep);
        if (rel[0] === '.git') return { allowed: false, reason: 'Refused: writing inside .git/ is not allowed.' };
      }
    }

    const dangerous = tool.name === 'shell' && isDangerousCommand(String(args.command ?? args.cmd ?? ''));
    if (!dangerous && (this.yolo || this.isAllowlisted(tool, args))) return { allowed: true };

    const description = tool.describeCall(args);
    let preview: string | undefined;
    try {
      preview = await tool.preview?.(args, ctx);
    } catch {
      /* preview is best-effort */
    }
    const answer = await this.prompter({ tool, args, description, preview, dangerous });
    if (answer === 'always') {
      if (!dangerous) this.allowForSession(tool);
      return { allowed: true };
    }
    if (answer === 'once') return { allowed: true };
    return { allowed: false, reason: 'User denied this action. Ask the user how to proceed or try a different approach.' };
  }
}
