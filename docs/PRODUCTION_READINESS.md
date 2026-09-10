# 生产运行与恢复

## 支持边界

- 正式支持：Apple Silicon macOS 上的单机、本地优先使用。
- 受控支持：可信局域网（`ORYNODE_ACCESS_MODE=trusted_lan`），必须使用配对会话。
- 不支持：公网暴露、多租户或不互信用户共享、Windows 完整运行、Intel Mac。
- `sources`、Wiki merge/split decisions 与 pending edges 当前属于实验性或内部接口，不代表已有完整用户界面。

## 上线前检查

1. 运行 `npm run doctor`、`npm test`、`npm run typecheck` 与 `npm run lint`。
2. 确认未设置 `ORYNODE_TRUSTED_LAN_UNSAFE=1`。
3. 确认 4318（Data Service）和 8080（模型运行时）仅绑定 `127.0.0.1`，不得通过反向代理或端口映射暴露。
4. Trusted-LAN 只在可信网络使用；撤销丢失或不再使用的配对会话。
5. 导入代表性 PDF、Office、中文和英文资料，完成一次“检索—回答—点击引用—打开原文”验收。

## 备份与恢复

升级、切换 embedding artifact 或修改数据迁移前先执行：

```bash
npm run knowledge:export
```

不要直接复制正在运行的 WAL 数据库作为备份。导出流程使用 SQLite 快照并校验清单哈希。

恢复前停止本地服务，再使用导入命令验证并切换导出包：

```bash
npm run knowledge:import -- /path/to/export --switch
```

恢复后运行 `npm run doctor`，并抽查资料数量、检索和引用落点。导入校验失败时不得强行切换。

## 升级与回滚

- Schema migration 只向前执行；应用升级前必须保留最近一次已验证导出。
- embedding 模型、维度或版本变化后必须重建向量索引，旧向量不能混用。
- 升级失败：停止服务，恢复上一版本代码及升级前导出，再运行迁移/备份测试。
- Wiki 源更新只会将已有综述标记为 stale；不会自动调用 Gemma 覆盖正文。由用户确认后重新生成。

## 故障处理

- 模型离线：设置页检查启动步骤；发送入口会保持禁用。
- 处理任务失败：处理中心选择“重新排队”；再次失败时保留原文件并查看错误。
- 语义搜索不可用：系统降级到 FTS5 关键词检索，不应伪装为语义命中。
- Wiki 编译失败：旧正文继续保留，失败运行记录可用于诊断，不发布半成品。
- 数据服务不可用：停止写操作并修复本地服务，不要绕过 4318 的回环边界。

## 安全假设

Data Service 信任同一台 Mac 上的本机进程；应用层 Scope 负责资料与会话附件的读取边界。该假设不适用于不可信本机代码、共享主机或多租户部署。检索到的文档内容始终按不可信数据处理，不能覆盖系统指令；没有模型明确引用的回答不会由应用启发式补写来源。
