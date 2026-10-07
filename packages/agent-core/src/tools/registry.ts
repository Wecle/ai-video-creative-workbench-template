import type { ToolDescriptor, ToolProvider } from "./types";
import { toModelToolName } from "./names";

export interface ToolRegistry {
  get(name: string): ToolDescriptor | undefined;
  list(): readonly ToolDescriptor[];
  resolve(allowedTools: readonly string[]): ToolDescriptor[];
  getProvider(name: string): ToolProvider | undefined;
  getCanonicalName(modelName: string): string | undefined;
}

export function createToolRegistry(
  providers: readonly ToolProvider[],
): ToolRegistry {
  const toolsByName = new Map<string, ToolDescriptor>();
  const toolsByModelName = new Map<string, string>();
  const providerByToolName = new Map<string, ToolProvider>();

  for (const provider of providers) {
    for (const tool of provider.list()) {
      if (toolsByName.has(tool.name)) {
        throw new Error(`Duplicate tool registration: '${tool.name}'`);
      }
      const modelName = toModelToolName(tool.name);
      if (toolsByModelName.has(modelName)) {
        throw new Error(
          `Model tool name collision: '${modelName}' for tools '${toolsByModelName.get(modelName)}' and '${tool.name}'`,
        );
      }
      toolsByName.set(tool.name, tool);
      toolsByModelName.set(modelName, tool.name);
      providerByToolName.set(tool.name, provider);
    }
  }

  return {
    get(name: string): ToolDescriptor | undefined {
      return toolsByName.get(name);
    },
    list(): readonly ToolDescriptor[] {
      return Array.from(toolsByName.values());
    },
    resolve(allowedTools: readonly string[]): ToolDescriptor[] {
      const result: ToolDescriptor[] = [];
      for (const name of allowedTools) {
        const tool = toolsByName.get(name);
        if (tool) {
          result.push(tool);
        }
      }
      return result;
    },
    getProvider(name: string): ToolProvider | undefined {
      return providerByToolName.get(name);
    },
    getCanonicalName(modelName: string): string | undefined {
      return toolsByModelName.get(modelName);
    },
  };
}
