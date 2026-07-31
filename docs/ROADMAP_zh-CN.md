# Orynode Local AI 路线图

[简体中文](ROADMAP_zh-CN.md) | [English](ROADMAP.md)

## 产品原则

浏览器界面是产品的主要操作界面，TurboFieldfare 是可替换的本地推理后端。从 V1 发展到 V2 的过程中，安装和运行细节应该逐步从用户视野中消失。

## V1——源码安装版

适用用户：

- 开发者
- 开源项目早期用户
- 能够使用终端的用户

使用流程：

1. 克隆项目仓库；
2. 执行 `npm install`；
3. 执行 `npm run turbo:install`；
4. 执行 `npm run model:install`；
5. 执行 `npm run local`；
6. 在 `http://localhost:3000` 使用助手。

V1 功能范围：

- 可复现的 TurboFieldfare 安装；
- 支持断点续传的模型安装；
- 本地 Web 对话；
- 使用SQLite保存、恢复和删除本地对话；
- 连接状态和运行引导；
- 本地文件导入和基于原文的回答；
- 清晰的隐私及第三方项目声明。

V1 不会宣传为普通用户无需技术知识即可安装的消费级软件。

## V2——原生macOS应用

适用用户：

- 普通 Mac 用户
- 希望使用本地助手，但不想安装开发工具链的团队

使用流程：

1. 下载 DMG；
2. 将 Orynode Local AI 拖入“应用程序”；
3. 打开应用；
4. 在浏览器引导页面下载模型；
5. 无需 npm、Node.js、Xcode 或终端即可使用。

V2 应用需要负责：

- 启动和停止本地管理服务；
- 打开默认浏览器；
- 下载、断点续传、校验、更新和删除模型；
- 启动和停止内置的 TurboFieldfare 服务；
- 通过本地接口向Web页面显示安装和运行进度；
- 所有服务只监听 `127.0.0.1`；
- 将所有可执行组件放入经过签名的应用包；
- 安装后只下载模型数据，不下载新的可执行程序。

## 兼容约定

V1 必须保持下面的边界，避免 V2 需要重新开发：

```text
浏览器界面
  -> Orynode管理及对话API
  -> TurboFieldfare OpenAI兼容本地API
  -> 本地模型目录
```

V1 固定约定：

- TurboFieldfare API 默认为 `http://127.0.0.1:8080/v1`；
- 开发阶段运行文件存储在 `.orynode/`；
- V1对话数据库固定为 `.orynode/data/orynode.db`；
- 模型使用 TurboFieldfare 生成的 `.gturbo` 目录；
- 浏览器不能直接执行系统命令；
- 安装逻辑必须与对话、文档处理逻辑分离。

V2 可以将运行数据迁移到标准的 macOS Application Support
目录，但必须能够检测或迁移用户已有的 V1 模型，避免重复下载。

## V2再处理的发布工作

- Swift 启动器；
- 应用图标和Bundle信息；
- Developer ID签名；
- Hardened Runtime配置；
- 应用内可执行程序签名；
- Apple公证；
- 附加公证票据的DMG；
- 自动更新。

这些工作不应阻碍V1验证本地AI助手的实际使用价值。
