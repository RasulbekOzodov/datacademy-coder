#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import { DebugLog } from './agent/debug-log.js';
import { Agent } from './agent/loop.js';
import { latestSessionId, newSessionId } from './agent/session.js';
import { exampleConfig, loadConfig, projectConfigDir } from './config/load.js';
import { APP_DISPLAY_NAME, APP_NAME, VERSION } from './constants.js';
import { createProviderFromConfig } from './llm/registry.js';
import { PermissionManager } from './permissions/manager.js';
import { createDefaultTools } from './tools/registry.js';
import { shellFallbackNote } from './tools/shell.js';
import { LineReader, TerminalUI, makePrompter, startRepl } from './ui/repl.js';
import { out } from './ui/render.js';
const program = new Command();
program
    .name(APP_NAME)
    .description(`${APP_DISPLAY_NAME} — a terminal coding agent powered by locally running LLMs (Ollama, LM Studio, llama.cpp, vLLM).`)
    .version(VERSION)
    .option('-p, --prompt <text>', 'run a single request and exit (non-interactive)')
    .option('--provider <name>', 'provider name from config (default: config.defaultProvider)')
    .option('-m, --model <name>', 'model name to use with the provider')
    .option('--yolo', 'auto-approve file writes and shell commands')
    .option('--cwd <dir>', 'working directory (default: current directory)')
    .option('--tool-mode <mode>', 'native | text | auto (default: config or auto)')
    .option('--debug', 'write raw requests/responses to .datacademy_coder/logs/')
    .option('--init', 'write an example config to ./.datacademy_coder/config.json and exit')
    .option('-c, --continue', 'continue the most recent conversation in this folder')
    .option('-r, --resume [id]', 'resume a previous conversation (pick from a list, or give its id)')
    .parse(process.argv);
const opts = program.opts();
async function main() {
    const cwd = path.resolve(opts.cwd ?? process.cwd());
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`Directory not found: ${cwd}`);
    }
    if (opts.init) {
        const dir = projectConfigDir(cwd);
        const file = path.join(dir, 'config.json');
        if (fs.existsSync(file)) {
            out(`${pc.yellow(`config already exists: ${file}`)}\n`);
            return;
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, `${exampleConfig()}\n`, 'utf8');
        out(`${pc.green(`wrote ${file}`)}\n${pc.dim('edit the model / baseUrl, then run the agent again')}\n`);
        return;
    }
    const { config, sources } = loadConfig(cwd, {
        provider: opts.provider,
        model: opts.model,
        yolo: opts.yolo,
        debug: opts.debug,
        toolMode: opts.toolMode,
    });
    const provider = createProviderFromConfig(config);
    await provider.healthCheck();
    // Surface "model not found" early with a pull hint.
    await provider.capabilities();
    const { registry, shell } = createDefaultTools(config);
    if (shellFallbackNote)
        out(`${pc.yellow(`⚠ ${shellFallbackNote}`)}\n`);
    const sessionId = newSessionId();
    const debug = new DebugLog(cwd, config.debug, sessionId);
    const oneShot = typeof opts.prompt === 'string';
    const reader = new LineReader();
    const permissions = new PermissionManager({ mode: config.permissions.mode, allow: config.permissions.allow }, makePrompter(reader));
    const ui = new TerminalUI();
    const agent = new Agent({ provider, tools: registry, shell, permissions, config, ui, cwd, debug });
    if (debug.enabled)
        out(`${pc.dim(`debug log: ${debug.file}`)}\n`);
    if (oneShot) {
        const controller = new AbortController();
        reader.onSigint(() => {
            controller.abort();
            out(`\n${pc.yellow('⚠ interrupted')}\n`);
        });
        try {
            await agent.run(opts.prompt, controller.signal);
        }
        finally {
            reader.close();
        }
        return;
    }
    let resume;
    if (opts.continue) {
        resume = latestSessionId(cwd);
        if (!resume)
            out(`${pc.dim('no previous conversation in this folder — starting a new one')}\n`);
    }
    else if (opts.resume !== undefined) {
        resume = typeof opts.resume === 'string' ? opts.resume : 'pick';
    }
    await startRepl({ agent, config, permissions, cwd, sessionId, configSources: sources, resume }, reader);
}
main().catch((err) => {
    out(`${pc.red(`✗ ${err.message}`)}\n`);
    if (opts.debug && err.stack)
        out(`${pc.dim(err.stack)}\n`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map