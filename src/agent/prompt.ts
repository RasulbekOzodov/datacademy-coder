import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_DISPLAY_NAME, PROJECT_INSTRUCTIONS_FILE } from '../constants.js';
import type { ToolDef } from '../llm/types.js';
import type { ResolvedShell } from '../tools/shell.js';

export interface SystemPromptInput {
  cwd: string;
  shell: ResolvedShell;
  tools: ToolDef[];
  /** 'native' = tools passed via API; 'text' = tools described in the prompt. */
  toolMode: 'native' | 'text';
  projectInstructions?: string;
}

const MAX_PROJECT_INSTRUCTIONS_CHARS = 6000;

export function loadProjectInstructions(cwd: string): string | undefined {
  for (const name of [PROJECT_INSTRUCTIONS_FILE, 'AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(cwd, name);
    try {
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
        if (!text) continue;
        return text.length > MAX_PROJECT_INSTRUCTIONS_CHARS ? `${text.slice(0, MAX_PROJECT_INSTRUCTIONS_CHARS)}\n[... truncated]` : text;
      }
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function osName(): string {
  if (process.platform === 'win32') return `Windows (${os.release()})`;
  if (process.platform === 'darwin') return `macOS (${os.release()})`;
  return `${process.platform} (${os.release()})`;
}

/**
 * The system prompt is deliberately byte-stable across turns (no dates, no git status) so local
 * servers can reuse their KV cache for the prefix.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const { cwd, shell, tools, toolMode, projectInstructions } = input;
  const shellHint =
    shell.kind === 'powershell' || shell.kind === 'pwsh'
      ? `${shell.displayName}. Chain commands with ";" (PowerShell 5.1 does not support "&&"). Use PowerShell syntax, not bash.`
      : shell.kind === 'cmd'
        ? `${shell.displayName}. Use cmd syntax (dir, type, copy, "&&" to chain), not bash or PowerShell cmdlets.`
        : shell.displayName;

  const parts: string[] = [];
  parts.push(
    `You are ${APP_DISPLAY_NAME}, an AI coding agent running in the user's terminal. You help with software engineering tasks by reading, writing and editing files and running commands inside the project directory.`,
  );
  parts.push(`# Environment
- Working directory: ${cwd}
- OS: ${osName()}
- Shell for the shell tool: ${shellHint}
- Use paths relative to the working directory.`);

  parts.push(`# How to work
- Understand before changing: use list_dir / glob / grep to find files and read_file to read them.
- ALWAYS read a file with read_file before editing it. Use edit_file for targeted changes (copy "old" exactly from the file) and write_file only for new files or full rewrites.
- Call a tool and wait for its result before deciding the next step. Independent actions (e.g. writing several new files) may be issued together in one message; anything that depends on a result (editing after reading, running after writing) must wait for that result. Never assume or invent a tool result.
- After running commands, check the exit code and output; fix errors you caused.
- In multi-file projects make the files work together: HTML must link its CSS (<link href="style.css">) and JS (<script src="script.js">), and selectors/ids used in CSS and JS must exist in the HTML.
- When the user reports a problem with something you made, read the relevant files with read_file, find the actual cause, and fix it with edit_file — do not repeat your previous answer.
- You are an agent, not a tutorial: when the user asks you to build, create, fix or change something, DO IT with tools in this same conversation. Never answer with a list of steps or with code blocks for the user to copy. To create a file, call write_file with the complete file contents in the "content" argument; to change a file, call edit_file; to run something, call shell.
- A typical flow for "build X": list_dir to see what exists -> write_file for each new file (one call per file) -> shell to run/verify -> short summary.
- Do not ask for permission in text — the tool system asks the user when needed. If a tool result says the user denied an action, briefly ask the user what to do instead; when the user then asks you to retry or continue, call the tool again.
- When the task is complete, reply with a short summary of what you did. Keep answers concise. Reply in the same language the user writes in.`);

  if (toolMode === 'text') {
    parts.push(`# Tools
You have access to the following tools. Their JSON schemas:
<tools>
${JSON.stringify(tools)}
</tools>

To call a tool, reply with EXACTLY this format and nothing after it:
<tool_call>
{"name": "tool_name", "arguments": {"param": "value"}}
</tool_call>

Rules:
- Exactly one <tool_call> per message. Stop immediately after </tool_call>.
- The result comes back in the next message as <tool_result name="tool_name">...</tool_result>. Never write a <tool_result> yourself.
- Arguments must be valid JSON matching the tool schema.
- When no more tools are needed, answer in plain text without any <tool_call>.

Example:
User: what files are here?
Assistant:
<tool_call>
{"name": "list_dir", "arguments": {"path": "."}}
</tool_call>
User: <tool_result name="list_dir">
./
src/
package.json  (1.2 KB)
</tool_result>
Assistant: There is a src folder and a package.json file.`);
  } else {
    parts.push(`# Tools
Use the provided tools (${tools.map((t) => t.name).join(', ')}). Call one tool per message and wait for the result.`);
  }

  if (projectInstructions) {
    parts.push(`# Project instructions (${PROJECT_INSTRUCTIONS_FILE})
${projectInstructions}`);
  }
  return parts.join('\n\n');
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 3000 });
    if (r.status !== 0) return undefined;
    return r.stdout.trim();
  } catch {
    return undefined;
  }
}

/** Volatile context appended to the first user message (kept out of the system prompt for cache stability). */
export function buildTurnContext(cwd: string): string {
  const lines: string[] = [`Date: ${new Date().toISOString().slice(0, 10)}`];
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch) {
    lines.push(`Git branch: ${branch}`);
    const status = git(cwd, ['status', '--short']);
    if (status) {
      const statusLines = status.split('\n');
      lines.push(statusLines.length > 30 ? `Git status: ${statusLines.length} changed files (run "git status" for details)` : `Git status:\n${status}`);
    } else if (status === '') lines.push('Git status: clean');
  }
  lines.push('Reminder: create and change files ONLY through write_file / edit_file tool calls (never print file contents as code blocks); do not start servers or open browsers.');
  return `[context]\n${lines.join('\n')}\n[/context]`;
}
