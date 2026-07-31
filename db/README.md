# 说明

本目录**不存放**业务 Schema。

本地对话与知识库数据由 `scripts/local-data-service.mjs` 管理，库文件在：

```text
.orynode/data/orynode.db
```

请勿再引入未接线的 Drizzle/D1 封装，以免与本地优先架构冲突。
