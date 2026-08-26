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

/** Single source of truth for slash commands: /help, the "/" palette and Tab completion all use it. */
export const COMMANDS: Array<{ name: string; args?: string; desc: string }> = [
  { name: 'help', desc: "barcha buyruqlar (shu ro'yxat)" },
  { name: 'model', args: '[nom]', desc: 'joriy model haqida / modelni almashtirish' },
  { name: 'models', desc: 'providerdagi modellar' },
  { name: 'provider', args: '[nom]', desc: "provider ko'rish / almashtirish (config'dan)" },
  { name: 'status', desc: 'cwd, model, tool rejimi, context, git' },
  { name: 'usage', desc: 'DataCademy hisobi: balans, kunlik limit, sarf' },
  { name: 'compact', desc: "suhbatni qisqartirish (context bo'shatish)" },
  { name: 'clear', desc: 'yangi suhbat' },
  { name: 'undo', desc: "agentning oxirgi fayl o'zgarishini qaytarish" },
  { name: 'yolo', desc: 'yozish/shell uchun avtomatik ruxsat (yoq/o\'chir)' },
  { name: 'resume', args: '[id]', desc: 'oldingi suhbatni tanlab davom ettirish' },
  { name: 'sessions', desc: "saqlangan suhbatlar ro'yxati" },
  { name: 'save', args: '[nom]', desc: 'suhbatni nom bilan saqlash (avto-saqlash ham bor)' },
  { name: 'load', args: '<id>', desc: 'suhbatni id bilan yuklash' },
  { name: 'exit', desc: 'chiqish (Ctrl+C ikki marta ham)' },
];

/** Names accepted by Tab completion (aliases included). */
export const COMMAND_NAMES = [...COMMANDS.map((c) => c.name), 'quit', 'balance', 'continue'];

export function commandPalette(filter = ''): string {
  const f = filter.replace(/^\//, '').toLowerCase();
  const rows = COMMANDS.filter((c) => c.name.startsWith(f));
  if (!rows.length) return pc.dim(`  /${f}… — bunday buyruq yo'q (/help)`);
  const width = Math.max(...rows.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0))) + 2;
  return rows.map((c) => `  ${pc.cyan('/' + c.name)}${c.args ? ' ' + pc.dim(c.args) : ''}${' '.repeat(Math.max(1, width - c.name.length - (c.args ? c.args.length + 1 : 0)))}${pc.dim(c.desc)}`).join('\n');
}

const HELP = `
${pc.bold('Buyruqlar')}  ${pc.dim('(/ yozing — ro\'yxat chiqadi, Tab — to\'ldirish)')}
${commandPalette()}

${pc.bold('CLI')}
  ${APP_NAME} login             DataCademy hisobiga ulanish
  ${APP_NAME} --setup           sozlash ustasi (hisob / lokal / API)
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

    case 'usage':
    case 'balance': {
      if (!agent.provider.usage) {
        print(pc.dim('bu provider balans ma\'lumotini bermaydi (faqat DataCademy hisobi uchun)'));
        return 'handled';
      }
      try {
        const u = (await agent.provider.usage()) as Record<string, unknown>;
        const n = (v: unknown) => Number(v ?? 0).toLocaleString('ru-RU');
        const lines = [
          `hisob: ${String(u.email ?? '')}${u.plan_label ? ` · tarif: ${String(u.plan_label)}` : ' · tarif yo\'q'}`,
          `balans: ${n(u.total_remaining)} kredit (obuna ${n(u.subscription_remaining)} + top-up ${n(u.topup_remaining)})`,
          u.daily_cap ? `bugun: ${n(u.daily_used)} / ${n(u.daily_cap)} (kunlik limit)` : `bugun: ${n(u.daily_used)}`,
          u.period_end ? `obuna muddati: ${new Date(Number(u.period_end)).toLocaleDateString('ru-RU')}` : '',
          u.last_30_days ? `30 kun: ${n((u.last_30_days as Record<string, unknown>).requests)} so'rov · ${n((u.last_30_days as Record<string, unknown>).credits)} kredit` : '',
          u.ok === false && u.reason ? pc.yellow(String(u.reason)) : '',
        ].filter(Boolean);
        print(pc.dim(lines.join('\n')));
      } catch (err) {
        print(pc.red(`balansni olib bo'lmadi: ${(err as Error).message.split('\n')[0]}`));
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
