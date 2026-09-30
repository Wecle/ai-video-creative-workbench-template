# Backend

产品业务后端。Gateway 负责公网入口、限流和转发；Backend 只负责业务 API、领域逻辑和数据访问。

- src：Fastify 业务 API 和后端路由
- modules/control-plane：项目、工作区和任务控制（预留）
- modules/realtime：实时事件推送（预留）
- modules/webhooks：外部回调接收（预留）
- test：后端测试

默认监听 127.0.0.1:4001，生产部署不直接暴露公网。
