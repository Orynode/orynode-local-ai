# Orynode Local AI 故障排查

[简体中文](TROUBLESHOOTING_zh-CN.md) | [English](TROUBLESHOOTING.md)

遇到安装或启动问题时，先执行：

```bash
npm run doctor
```

诊断结果不会上传到任何服务器，也不会输出文档、提示词或其他私人数据。

## TurboFieldfare未安装

执行：

```bash
npm run turbo:install
```

或者直接执行完整安装：

```bash
npm run setup
```

安装脚本会检查Apple Silicon、macOS、Swift、Xcode和可用磁盘空间。

## 模型首次下载提示没有断点记录

更新到最新项目代码后重新执行：

```bash
npm run model:install
```

首次下载不会使用续传参数；只有检测到`.resume.json`断点文件时才会续传。

## 模型下载中断

再次执行相同命令：

```bash
npm run model:install
```

安装器会读取已有断点并继续下载，不需要删除已经下载的数据。

## 下载过程中没有看到进度

新版安装脚本会直接显示百分比、已下载容量、速度和预计剩余时间。如果下载由旧版脚本启动，可以在另一个终端执行：

```bash
npm run model:progress
```

该命令只读取本地断点记录，不会干扰正在进行的下载。

## 模型残留状态无法继续

只有在续传反复失败或安装器明确要求重置时，才执行：

```bash
npm run model:reset
npm run model:install
```

`model:reset`会删除未完成的模型下载。已经完整安装并通过校验的模型不会被该恢复流程自动删除。

## 模型已经安装

重复执行`npm run model:install`是安全的。安装器会先校验已有模型；校验通过后不会重新下载15GB数据。

## 磁盘空间不足

首次下载至少需要16GB可用空间。模型和下载状态位于：

```text
.orynode/models/
```

请释放空间后再次运行安装命令。不要在下载过程中手动移动`.partial`或`.resume.json`文件。

## 8080端口被其他程序占用

TurboFieldfare默认使用`127.0.0.1:8080`。`npm run local`会先检查该端口：

- 如果是TurboFieldfare，会复用已有服务；
- 如果是其他程序，会停止启动并明确报错；
- 不会把未知服务误认为本地模型。

## 3000端口被占用

停止之前运行的Orynode开发服务，再执行：

```bash
npm run local
```

通常可以在原终端按`Control+C`停止。

## npm提示Unknown env config "devdir"

这是用户电脑上的旧版npm配置警告，不是Orynode错误，也不会影响当前安装。可以选择执行：

```bash
npm config delete devdir
```

## 网络或Hugging Face错误

新版安装器遇到临时网络中断时会自动重试4次，每次都会从本地断点继续，不会重新下载已完成的数据。

如果错误中包含`NSURLErrorDomain Code=-1200`或`TLS`，通常是本机代理、VPN或网络临时中断导致的安全连接失败。可以：

1. 重启代理或VPN；
2. 在代理规则中让`huggingface.co`和`*.hf.co`直连；
3. 再次执行`npm run model:install`。

不要立即执行`model:reset`，因为现有断点通常仍然有效。可以先用`npm run model:progress`查看已保留的进度。

确认可以访问GitHub和Hugging Face。公开模型通常不需要登录；如果Hugging Face要求认证，可以在当前终端设置`HF_TOKEN`后重试。

不要把访问令牌写入README、问题截图或Git提交。

## 完整恢复顺序

```bash
npm run doctor
npm run turbo:install
npm run model:install
npm run local
```

不要首先删除整个`.orynode`目录，否则可能丢失已经下载的大模型数据。
