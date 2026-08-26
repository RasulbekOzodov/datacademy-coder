import type { Config } from '../config/schema.js';
import type { ToolDef } from '../llm/types.js';
import { editFileTool } from './edit-file.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { makeShellTool, resolveShell, type ResolvedShell } from './shell.js';
import type { Tool } from './types.js';
import { writeFileTool } from './write-file.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    if (this.tools.has(name)) return this.tools.get(name);
    // Tolerate small-model naming slips: "readFile", "read-file", "ReadFile".
    const norm = name.replace(/[-\s]/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    return this.tools.get(norm);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  defs(): ToolDef[] {
    return this.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }
}

export function createDefaultTools(config: Config): { registry: ToolRegistry; shell: ResolvedShell } {
  const shell = resolveShell(config);
  const registry = new ToolRegistry()
    .register(readFileTool)
    .register(listDirTool)
    .register(globTool)
    .register(grepTool)
    .register(writeFileTool)
    .register(editFileTool)
    .register(makeShellTool(shell));
  return { registry, shell };
}
