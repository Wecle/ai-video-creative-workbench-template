// Prints a canvas document state as base64, for smoke tests and manual API calls.
//   tsx scripts/make-state.ts [valid|large|dangling-edge|unknown-node|bad-config|future-schema]
import {
  ORIGIN,
  addNode,
  edgesOf,
  encodeState,
  metaOf,
  nodesOf,
  toBase64,
  transact,
} from "../src";
import { buildDemoDoc } from "../src/fixtures";
import * as Y from "yjs";

const kind = process.argv[2] ?? "valid";
const doc = buildDemoDoc();

switch (kind) {
  case "valid":
    break;
  case "large": {
    // About 600 KB of raw state: stays below the 1 MB request limit once base64-encoded.
    for (let i = 0; i < 30; i++)
      addNode(doc, "agent", {
        id: `big-${i}`,
        type: "text",
        position: { x: i * 20, y: 400 },
        config: { text: "x".repeat(20000) },
      });
    break;
  }
  case "dangling-edge":
    transact(doc, ORIGIN.load, () =>
      edgesOf(doc).set("text-1:text->ghost:prompt", {
        source: "text-1",
        sourceHandle: "text",
        target: "ghost",
        targetHandle: "prompt",
      }),
    );
    break;
  case "unknown-node":
    transact(doc, ORIGIN.load, () => {
      const node = new Y.Map<unknown>();
      node.set("type", "video.generate");
      node.set("version", 1);
      node.set("title", "Video");
      node.set("position", { x: 0, y: 0 });
      node.set("config", new Y.Map());
      nodesOf(doc).set("video-1", node);
    });
    break;
  case "bad-config":
    transact(doc, ORIGIN.load, () =>
      (nodesOf(doc).get("image-1")!.get("config") as Y.Map<unknown>).set(
        "aspectRatio",
        "4:3",
      ),
    );
    break;
  case "future-schema":
    transact(doc, ORIGIN.load, () => metaOf(doc).set("schemaVersion", 2));
    break;
  default:
    console.error(`unknown kind: ${kind}`);
    process.exit(2);
}
process.stdout.write(toBase64(encodeState(doc)));
