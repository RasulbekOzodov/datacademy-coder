import type { Config } from '../config/schema.js';
import type { JsonSchema } from '../llm/types.js';

export type Permission = 'read' | 'write' | 'exec';

export interface UndoEntry {
  path: string;
  /** null = file did not exist before */
  previous: string | null;
}

export interface ToolContext {
  cwd: string;
  config: Config;
  /** Absolute paths read via read_file in this session (read-before-edit guard). */
  readFiles: Set<string>;
  undoStack: UndoEntry[];
  signal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** One-line summary for the terminal (e.g. "120 lines"). */
  summary?: string;
}

export type ToolArgs = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  permission: Permission;
  /** Short human-readable description of a call, e.g. `read_file src/a.ts`. */
  describeCall(args: ToolArgs): string;
  /** Optional preview shown in the permission prompt (diff, file head, command). */
  preview?(args: ToolArgs, ctx: ToolContext): Promise<string | undefined>;
  execute(args: ToolArgs, ctx: ToolContext): Promise<ToolResult>;
}
