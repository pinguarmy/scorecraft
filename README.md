# 谱间 · ScoreCraft

拿到一份乐谱，想先听一遍，或者只练其中几小节？谱间可以在浏览器里播放乐谱、单独听一个声部，也可以把选中的小节放慢、循环练。已有 MusicXML 或 MXL，直接导入就行；手头只有 PDF 或照片，可以装上 Audiveris，在本机把印刷五线谱转成可编辑的乐谱。

## 先跑起来

从 [GitHub Releases](https://github.com/pinguarmy/scorecraft/releases/latest) 下载 `scorecraft-source.zip` 并解压，也可以克隆仓库。需要 [Node.js](https://nodejs.org/) 22.13 以上的 22.x，或 24 及更新版本。在项目目录运行：

```sh
npm ci
npm run build
npm start
```

浏览器打开 <http://127.0.0.1:4381>。保持终端开着。第一次可以点“打开 First Light”，用内置的原创钢琴小曲《初光》试试播放和分声部练习。这一步不需要安装识谱引擎。

### 想导入 PDF 或照片？

Apple Silicon Mac 可以用安装脚本下载 Audiveris：

```sh
npm run setup:omr
npm run doctor
npm start
```

其他系统可从 [Audiveris](https://github.com/Audiveris/audiveris/releases) 自行安装，启动前把 `AUDIVERIS_BIN` 设为可执行文件的路径。各平台的安装方式不同；自动安装脚本只支持 Apple Silicon Mac。`npm run doctor` 可以检查环境。未安装引擎时，MusicXML/MXL 仍可正常使用。

## 怎么练

1. **导入乐谱。** 支持 MusicXML、MXL、PDF、PNG 和 JPEG。扫描完成后，先在“校对与原稿”对照原件，尤其是节奏、音高和拍号。
2. **选一段反复听。** 在“当前练习”选起止小节、调速度、开循环或预备拍。合奏谱可以只听自己的声部；双谱表钢琴谱可分开听左右手。
3. **下次接着练。** 从“我的乐谱”重开上次的谱，速度、选段和播放位置会一并恢复。关页前看一眼谱头，确认显示“已保存”。
4. **带到别的软件里。** 导出整份 MusicXML 继续编辑，或把整首、选中的小节导成 MIDI 或 WAV。MIDI 的最终音色由播放软件决定，WAV 则使用谱间当前选择的音色。

## 文件放在哪

谱间不需要账号、云存储或识谱 API 密钥。PDF 和照片只交给本机的 Audiveris，乐谱、练习设置和音色也不通过外部服务。首次安装 npm 依赖和 Audiveris 需要联网。

- 保存的乐谱和练习设置在 `.data/library`，不会因最近记录被清除而删除。重要乐谱建议导出 MusicXML，并备份该目录。
- 扫描原稿和识别结果在 `.data/jobs`。删除扫描不会删除已保存的校正版。程序启动时会清理超过 7 天的扫描任务。
- 浏览器缓存的最近记录不是备份。本机数据也没有加密，不要把运行目录放到共享位置。

服务默认只监听 `127.0.0.1`。它是单机练习工具，没有账号和多用户隔离，不要把它暴露到公网。

## 有哪些限制

PDF 和照片识谱主要面向清晰的印刷五线谱。手写谱、简谱、纯 TAB 图片和录音转谱不支持。能显示的记号不一定能按原意演奏，复杂反复、踏板和装饰音尤其如此。谱间适合练习和小范围校正，不是完整的打谱软件。具体见[记谱与播放支持](<docs/NOTATION_SUPPORT.md>)。

## 开发和测试

`npm run dev` 启动开发环境，浏览器打开 <http://127.0.0.1:4380>。[代码和数据怎么走](<docs/ARCHITECTURE.md>)解释了前端、音频和本机服务的分工。

```sh
npm run check
npm run build
```

`npm run check` 依次运行类型检查、ESLint、单元测试（`tests/music`、`tests/practice`、`tests/server`）和源码清单检查，不需要浏览器。`npm run format:check` 检查 Prettier 格式，不包含在 `check` 里。

渲染回归（`npm run test:render`）和浏览器测试（`npm run test:e2e`）需要 Google Chrome。用别的 Chromium 或 Chrome 时，把 `SCORECRAFT_BROWSER_PATH` 设为它的可执行文件路径。浏览器测试会自己启动 `npm start`，端口默认 4382，可用 `SCORECRAFT_E2E_PORT` 修改。运行前先 `npm run build`。这个测试服务把乐谱和扫描存到 `.data/e2e`，每次启动时清空，不会动日常使用的谱库。要测试自己启动的服务，设置 `SCORECRAFT_URL`，这时测试乐谱会写进那个服务的谱库。需要 UTF-8 语言环境（例如 `LANG=C.UTF-8`）。没装 Audiveris 时，真实 PDF 和图片识谱用例会跳过。详见[贡献指南](<CONTRIBUTING.md>)。

运行 `npm run package:source` 可生成 `.data/source.zip`。应用内的“下载本实例源码”会提供该文件。脚本只打包 [source-files.txt](<source-files.txt>) 里逐项列出的文件，不带用户乐谱、扫描原稿、日志、依赖或识谱引擎。新增或删除项目文件后，运行 `npm run check:manifest -- --write` 重新生成这份清单，`npm run check:manifest` 会在清单和 `git ls-files` 不一致时报错。

## 许可

应用代码采用 [AGPL-3.0-or-later](<LICENSE>)。《初光》和其他内置原创乐谱采用 CC0。录音采样使用单独的许可，见[第三方声明](<THIRD_PARTY_NOTICES.md>)。
