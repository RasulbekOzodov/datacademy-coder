import { spawnSync } from 'node:child_process';
import pc from 'picocolors';
import type { Agent } from '../agent/loop.js';
import { listSessions, loadSession, newSessionId, saveSession, sessionPreview } from '../agent/session.js';
import type { Config } from '../config/schema.js';
import { APP_NAME } from '../constants.js';
import { createProviderFromConfig } from '../llm/registry.js';
import type { PermissionManager } from '../permissions/manager.js';

export interface CommandContext {
  agent: Agent;
  config: Config;
  permissions: PermissionManager;
  cwd: string;
  sessionId: string;
  print: (s: string) => void;
  /** Ask the user a line of input (REPL only). */
  ask?: (prompt: string) => Promise<string | null>;
  /** Called when a session was loaded so the REPL can continue saving under that id. */
  onSessionLoaded?: (id: string) => void;
}

/** Interactive picker: list sessions and let the user choose one by number or id. Returns the chosen id. */
export async function pickSession(cwd: string, ask: (prompt: string) => Promise<string | null>, print: (s: string) => void): Promise<string | undefined> {
  const list = listSessions(cwd).filter((s) => s.messages > 0);
  if (!list.length) {
    print(pc.dim('no saved sessions in this folder'));
    return undefined;
  }
  const shown = list.slice(0, 15);
  print(pc.bold('Saved sessions:'));
  shown.forEach((s, i) => {
    const when = s.updatedAt.slice(0, 16).replace('T', ' ');
    print(`  ${pc.cyan(String(i + 1).padStart(2))}. ${s.id}  ${pc.dim(`${when} · ${s.messages} msgs · ${s.model}`)}\n      ${pc.dim(sessionPreview(cwd, s.id) || '(empty)')}`);
  });
  const answer = (await ask(pc.yellow('Resume which? [number / id / Enter to cancel]: ')))?.trim();
  if (!answer) return undefined;
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1].id;
  return list.some((s) => s.id === answer) ? answer : undefined;
}

export function applySession(ctx: CommandContext, id: string): string {
  const s = loadSession(ctx.cwd, id);
  ctx.agent.clear();
  ctx.agent.messages = s.messages;
  ctx.onSessionLoaded?.(s.id);
  return `resumed session ${s.id} (${s.messages.length} messages, ${s.provider}/${s.model})`;
}

export type CommandOutcome = 'handled' | 'exit' | 'not-a-command';

const HELP = `
${pc.bold('Commands')}
  /help                 show this help
  /model [name]         show current model info, or switch model (same provider)
  /models               list models available on the provider
  /provider [name]      show or switch provider (from config)
  /status               cwd, model, tool mode, context usage, git changes
  /compact              shrink the conversation to free context
  /clear                start a fresh conversation
  /undo                 revert the last file change made by the agent
  /yolo                 toggle auto-approve for write/shell actions
  /resume [id]          pick a previous conversation in this folder and continue it
  /sessions             list saved conversations
  /save [name]          save under a custom name (conversations auto-save after every answer)
  /load <id>            load a saved conversation by id
  /exit                 quit (Ctrl+C twice also works)

${pc.bold('CLI')}
  ${APP_NAME} --continue        continue the most recent conversation in this folder
  ${APP_NAME} --resume [id]     pick (or open) a previous conversation

${pc.bold('Tips')}
  Ctrl+C once interrupts the current answer; twice exits.
  Put project rules in AGENT.md — they are added to the system prompt.
  Run "${APP_NAME} --init" to write an example config file.
`.trim();

export async function handleCommand(line: string, ctx: CommandContext): Promise<CommandOutcome> {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return 'not-a-command';
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  const { agent, print } = ctx;

  switch (cmd.toLowerCase()) {
    case 'help':
    case '?':
      print(HELP);
      return 'handled';

    case 'exit':
    case 'quit':
    case 'q':
      return 'exit';

    case 'clear':
      agent.clear();
      print(pc.dim('conversation cleared'));
      return 'handled';

    case 'compact':
      print(pc.dim(agent.compact()));
      return 'handled';

    case 'undo': {
      const r = await agent.undo();
      print(r ? pc.dim(r) : pc.dim('nothing to undo'));
      return 'handled';
    }

    case 'yolo':
      ctx.permissions.yolo = !ctx.permissions.yolo;
      print(ctx.permissions.yolo ? pc.yellow('yolo mode ON — write/shell actions run without asking') : pc.dim('yolo mode OFF — actions will be confirmed'));
      return 'handled';

    case 'model': {
      if (arg) {
        agent.setModel(arg);
        try {
          print(pc.dim(await agent.provider.describe()));
        } catch (err) {
          print(pc.red((err as Error).message));
        }
        return 'handled';
      }
      try {
        print(pc.dim(await agent.provider.describe()));
      } catch (err) {
        print(pc.red((err as Error).message));
      }
      return 'handled';
    }

    case 'models': {
      try {
        const models = await agent.provider.listModels();
        if (!models.length) print(pc.dim('no models found on the server'));
        else print(models.map((m) => (m === agent.provider.model ? `${pc.green('*')} ${m}` : `  ${m}`)).join('\n'));
      } catch (err) {
        print(pc.red((err as Error).message));
      }
      return 'handled';
    }

    case 'provider': {
      if (!arg) {
        const names = Object.keys(ctx.config.providers).map((n) => (n === agent.provider.name ? `${pc.green('*')} ${n} (${ctx.config.providers[n].type})` : `  ${n} (${ctx.config.providers[n].type})`));
        print(names.join('\n'));
        return 'handled';
      }
      try {
        const provider = createProviderFromConfig(ctx.config, arg);
        await provider.healthCheck();
        agent.setProvider(provider);
        print(pc.dim(await provider.describe()));
      } catch (err) {
        print(pc.red((err as Error).message));
      }
      return 'handled';
    }

    case 'status': {
      const est = agent.estimatedTokens();
      const win = agent.provider.contextWindow;
      const lines = [
        `cwd: ${ctx.cwd}`,
        `provider: ${agent.provider.name} · model: ${agent.provider.model}`,
        `tool mode: ${agent.toolMode ?? `(${ctx.config.toolMode}, resolved on first request)`}`,
        `permissions: ${ctx.permissions.yolo ? 'yolo' : 'ask'}`,
        `messages: ${agent.messages.length} · context: ~${est}/${win} tokens (${Math.round((est / win) * 100)}%)${agent.lastPromptTokens ? ` · last prompt: ${agent.lastPromptTokens}` : ''}`,
      ];
      const git = spawnSync('git', ['diff', '--stat'], { cwd: ctx.cwd, encoding: 'utf8', windowsHide: true });
      if (git.status === 0 && git.stdout.trim()) lines.push(`git diff --stat:\n${git.stdout.trim()}`);
      print(pc.dim(lines.join('\n')));
      return 'handled';
    }

    case 'save': {
      const id = arg || ctx.sessionId;
      const file = saveSession(ctx.cwd, {
        id,
        createdAt: new Date().toISOString(),
        updatedAt: '',
        cwd: ctx.cwd,
        provider: agent.provider.name,
        model: agent.provider.model,
        toolMode: agent.toolMode,
        messages: agent.messages,
      });
      print(pc.dim(`saved ${agent.messages.length} messages to ${file}`));
      return 'handled';
    }

    case 'load': {
      if (!arg) {
        print(pc.red('usage: /load <session-id>   (see /sessions, or use /resume)'));
        return 'handled';
      }
      try {
        print(pc.dim(applySession(ctx, arg)));
      } catch (err) {
        print(pc.red((err as Error).message));
      }
      return 'handled';
    }

    case 'resume':
    case 'continue': {
      try {
        let id = arg || undefined;
        if (!id) {
          if (!ctx.ask) {
            print(pc.red('usage: /resume <session-id>'));
            return 'handled';
          }
          id = await pickSession(ctx.cwd, ctx.ask, print);
          if (!id) {
            print(pc.dim('cancelled'));
            return 'handled';
          }
        }
        print(pc.dim(applySession(ctx, id)));
      } catch (err) {
        print(pc.red((err as Error).message));
      }
      return 'handled';
    }

    case 'sessions': {
      const list = listSessions(ctx.cwd);
      if (!list.length) print(pc.dim('no saved sessions'));
      else print(list.map((s) => `  ${s.id}  ${pc.dim(`${s.messages} msgs · ${s.model} · ${s.updatedAt.slice(0, 16).replace('T', ' ')}`)}`).join('\n'));
      return 'handled';
    }

    default:
      print(pc.red(`unknown command /${cmd} — type /help`));
      return 'handled';
  }
}

export { newSessionId };
