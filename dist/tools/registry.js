import { editFileTool } from './edit-file.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { listDirTool } from './list-dir.js';
import { readFileTool } from './read-file.js';
import { makeShellTool, resolveShell } from './shell.js';
import { writeFileTool } from './write-file.js';
export class ToolRegistry {
    tools = new Map();
    register(tool) {
        this.tools.set(tool.name, tool);
        return this;
    }
    get(name) {
        if (this.tools.has(name))
            return this.tools.get(name);
        // Tolerate small-model naming slips: "readFile", "read-file", "ReadFile".
        const norm = name.replace(/[-\s]/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
        return this.tools.get(norm);
    }
    list() {
        return [...this.tools.values()];
    }
    names() {
        return [...this.tools.keys()];
    }
    defs() {
        return this.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    }
}
export function createDefaultTools(config) {
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
//# sourceMappingURL=registry.js.map