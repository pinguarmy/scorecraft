# 贡献指南

## 准备环境

需要 Node.js 22.13 以上的 22.x，或 24 及更新版本。`.nvmrc` 和 CI 使用 Node.js 22 的最新补丁。

```sh
npm ci
npm run dev
```

`npm run dev` 启动开发环境，浏览器打开 <http://127.0.0.1:4380>。代码结构见 [docs/ARCHITECTURE.md](<docs/ARCHITECTURE.md>)。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint。有警告属于已知问题，错误必须修掉 |
| `npm run format` / `npm run format:check` | 用 Prettier 格式化 / 只检查格式 |
| `npm test` | 单元测试：`test:music`、`test:server`、`test:practice` |
| `npm run check:manifest` | 检查 `source-files.txt` 和 `git ls-files` 是否一致 |
| `npm run check` | 依次运行 typecheck、lint、`npm test`、check:manifest |
| `npm run build` | 类型检查后构建前端到 `dist/` |
| `npm run test:render` | 渲染回归，需要浏览器 |
| `npm run test:e2e` | Playwright 浏览器测试，需要浏览器和 `dist/` |

提交前至少运行 `npm run check`。CI 还会运行格式检查、构建、渲染回归和浏览器测试。

## 测试分层

- `tests/music`、`tests/practice`：纯逻辑测试，不需要浏览器和服务。
- `tests/server`：针对本机服务的测试，用临时目录存数据，不碰日常谱库。
- `tests/render`：在无界面的 Chrome 里加载 OSMD，检查渲染兼容和光标。不启动服务。说明见 [tests/render/README.md](<tests/render/README.md>)。
- `tests/e2e`：Playwright 测试整个应用。需要先 `npm run build`。没有设置 `SCORECRAFT_URL` 时，Playwright 自己启动 `npm start`，端口默认 4382（`SCORECRAFT_E2E_PORT`），数据存到每次清空的 `.data/e2e`（`SCORECRAFT_DATA_DIR`），不碰日常谱库。需要 UTF-8 语言环境，例如 `LANG=C.UTF-8`。没装 Audiveris 时，两个真实识谱用例会跳过，这是正常的。

渲染回归和浏览器测试默认使用已安装的 Google Chrome。要用别的 Chromium 或 Chrome，设置 `SCORECRAFT_BROWSER_PATH` 为可执行文件路径：

```sh
SCORECRAFT_BROWSER_PATH=/path/to/chrome npm run test:render
```

## 源码清单

AGPL 源码 ZIP 只打包 `source-files.txt` 里列出的文件。新增、删除或重命名文件后，先 `git add`，再运行：

```sh
npm run check:manifest -- --write
```

把更新后的清单一起提交。不在 git 仓库里（比如从源码 ZIP 解压出来）时，`npm run check:manifest` 会跳过检查。

## 一次改动应该包括

- 行为变化对应的测试。修 bug 时先写出能复现它的测试。
- 通过 `npm run check`；改了界面或服务接口时，也要跑相关的 e2e 用例。
- 新增或删除了文件时，更新后的 `source-files.txt`。
- 用户能看到的变化，同步修改 README 或 `docs/` 里的说明。
- 新增的依赖、乐谱或音频采样，在 [THIRD_PARTY_NOTICES.md](<THIRD_PARTY_NOTICES.md>) 里写明来源和许可。

## 格式

`.editorconfig` 和 `.prettierrc` 定义了缩进、引号和行宽。不要为了格式化单独改动无关的代码，避免和别人的改动冲突。
