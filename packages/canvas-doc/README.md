# Canvas Doc

画布的 Yjs 文档层，浏览器与服务端共用（同构：只依赖 `yjs`、`zod`、`@creative/contracts`、`@creative/node-registry`，ESLint 限制导入和全局变量）。仓库里只有这个包导入 Yjs，Web 通过它的 API 使用文档。

## 文档结构（`SCHEMA_VERSION = 1`）

| 根键     | 内容                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------- |
| `meta`   | `schemaVersion`                                                                                       |
| `nodes`  | `Y.Map<id, Y.Map>`：`type`、`version`、`title`、`position`（整体替换）、`config`（`Y.Map<字段, 值>`） |
| `edges`  | `Y.Map<edgeId, {source, sourceHandle, target, targetHandle}>`；创建后不可变，改连线 = 删旧建新        |
| `groups` | 保留键名，暂未使用                                                                                    |

`edgeId = source:sourceHandle->target:targetHandle`，重复边落在同一个键上。执行状态、viewport、选中态不在文档里。

## API

- 操作：`addNode`、`moveNodes`（单事务）、`renameNode`、`updateConfig`、`removeNodes`（同事务删关联边）、`connect`、`removeEdges`。第二个参数是必传的 origin：`"user"`（可撤销）或 `"agent"`（不会被用户撤销）；缺失或其他值抛 `TypeError`。操作返回 `Result`（带错误码），不为业务错误抛异常。
- 连接校验：`validateConnection(graph, registry, connection)`，错误码 `unknown-node`、`unknown-port`、`port-type-mismatch`、`self-loop`、`duplicate-edge`、`cycle`；UI 的 `isValidConnection` 与 `connect` 用同一个函数。
- 快照：`readSnapshot(doc)`（按 id 排序，稳定）、`validateSnapshot(snapshot, registry)`（返回 `{code, path}[]`，不回显 config）、`inspectState(bytes, registry)`（对不可信的二进制状态给出结论，从不因坏输入抛异常；服务端保存前使用）。
- `repairDocument(doc)`：删除悬挂边、端口非法的边和成环的边（按 edgeId 字典序，后者删，各副本结果一致），origin 为 `repair`，不被撤销栈跟踪。`createHistory` 在每次撤销/重做后调用它；持久化在保存前调用它。代价：被修复删除的边，redo 不会恢复。
- 历史：`createHistory(doc, { captureTimeout })` 只跟踪 `user` origin；500 ms 内的连续编辑合并为一步。
- 编码：`createCanvasDoc`（服务端创建空画布）、`encodeState`（完整状态，不是增量）、`loadCanvasDoc`（更高的 `schemaVersion` 抛 `UnsupportedSchemaError`，坏数据抛 `InvalidStateError`，旧版本走 `MIGRATIONS`）、`toBase64`/`fromBase64`、`isPersistableOrigin`。
- `@creative/canvas-doc/fixtures`：`demoSnapshot`、`buildDemoDoc()`，只给测试和示例用，不进生产路径。

## 脚本

`pnpm --filter @creative/canvas-doc make-state [valid|large|dangling-edge|unknown-node|bad-config|future-schema]` 输出一份 base64 状态，供冒烟脚本和手工调用接口使用。
