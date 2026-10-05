import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registry } from "@creative/node-registry";
import { getMessages } from "../../i18n/messages";
import { nodeTypes, nodeUi } from "./node-ui";

describe("node ui mapping", () => {
  const messages = getMessages("en");

  it("has a renderer and a config form for every registered node type", () => {
    expect(registry.list().length).toBeGreaterThan(0);
    for (const definition of registry.list()) {
      const ui = (nodeUi as Record<string, unknown>)[definition.type] as
        { Renderer: unknown; ConfigForm: unknown } | undefined;
      expect(ui, `nodeUi.${definition.type}`).toBeDefined();
      expect(typeof ui!.Renderer).toBe("function");
      expect(typeof ui!.ConfigForm).toBe("function");
      expect(nodeTypes[definition.type]).toBe(ui!.Renderer);
    }
  });

  it("has messages for every node title, port and config field", () => {
    for (const definition of registry.list()) {
      const base = `nodes.${definition.type}`;
      expect(messages[`${base}.title`], `${base}.title`).toBeTruthy();
      for (const port of [...definition.inputs, ...definition.outputs])
        expect(
          messages[`${base}.ports.${port.id}`],
          `${base} port ${port.id}`,
        ).toBeTruthy();
      const schema = z.toJSONSchema(definition.config, { io: "input" }) as {
        properties?: Record<string, unknown>;
      };
      for (const field of Object.keys(schema.properties ?? {}))
        expect(
          messages[`${base}.fields.${field}`],
          `${base} field ${field}`,
        ).toBeTruthy();
    }
  });
});
