# 代码和数据怎么走

谱间由一个 React 页面和一个本机 Express 服务组成。已有谱面直接在浏览器解析；只有 PDF 和图片识谱需要独立安装的 Audiveris 进程。

```text
MusicXML / MXL ────────────────────┐
PDF / PNG / JPEG → 本机服务 → Audiveris → MusicXML
                                  ↓
                谱面显示、练习播放、校正、导出
                                  ↓
                             本机谱库
```

## 源码入口

| 路径 | 负责什么 |
| --- | --- |
| [App.tsx](<../src/App.tsx>) | 组合根。只保留跨模块的编排：当前打开的乐谱、切换乐谱和保存当前练习。 |
| [src/app/](<../src/app>) | 按职责拆开的 hooks：谱库与保存队列、播放器、练习设置、打开乐谱的几条流程、校对、配器、导出、扫描档案、移动端工具面板。不依赖 React 的纯函数也放在这里，并有单元测试。 |
| [src/components/](<../src/components>) | 页面区域：刊头、谱库侧栏、扫描档案、谱面区、播放条，以及练习、声音、校对和导出面板。 |
| [ScoreView.tsx](<../src/components/ScoreView.tsx>) | 用 OpenSheetMusicDisplay 把乐谱画成 SVG，并让游标跟随源谱位置。 |
| [api/scorecraft.ts](<../src/api/scorecraft.ts>) | 前端调用本机服务的唯一入口，带类型的健康检查、扫描任务和识谱接口。 |
| [music/index.ts](<../src/music/index.ts>) | 读取 MusicXML/MXL，解析音高、时值、节拍和谱表。普通反复展开为演奏顺序，不改变源谱。 |
| [practice/](<../src/practice>) | 练习会话的校验，以及谱库保存器和浏览器发件箱。服务端也用这里的会话校验。 |
| [src/styles/](<../src/styles>) | 样式分片，由 `index.css` 按顺序引入。后面的分片会覆盖前面的，顺序不能随意调整。 |
| [app.ts](<../server/app.ts>) | 组装本机服务：请求检查、各组接口、静态文件和错误处理。 |
| [request-guard.ts](<../server/request-guard.ts>) | 安全响应头，只接受本机 Host 和同源请求。 |
| [job-store.ts](<../server/job-store.ts>)、[recognition-queue.ts](<../server/recognition-queue.ts>) | 扫描任务的保存和恢复，识谱排队，重复上传和重试的去重。 |
| [routes/](<../server/routes>) | 上传识谱、跳过封面重试、任务查询和删除、健康检查与许可证。 |
| [library.ts](<../server/library.ts>) | 把校正版和练习设置写入本机谱库，以及处理并发保存冲突。 |
| [static-files.ts](<../server/static-files.ts>) | 提供构建好的前端，设置缓存和内容安全策略。 |
| [http-errors.ts](<../server/http-errors.ts>) | 带状态码的错误类型和统一的错误响应。 |

页面最外层有一个错误边界。渲染出错时显示说明和重新载入按钮，而不是空白页。

音频在浏览器通过 Web Audio 播放。录音乐器读取随项目提供的采样，不调用远程音色服务；合成器、电子鼓和节拍器由代码生成。WAV 导出使用离线 Web Audio 渲染。MIDI 导出的是音符和演奏指令，不包含录音。

## 本机数据

- `.data/library` 保存打开过的乐谱、校正和练习设置。文档编号来自导入的乐谱内容或扫描任务，不会随曲名改变。
- `.data/jobs` 保存扫描原稿、任务状态和识谱结果。原稿不随校正改动。程序启动时会清理超过 7 天的扫描，重启也不会自动重跑中断的任务。
- 设置 `SCORECRAFT_DATA_DIR` 可以把上面两个目录换到项目内的另一个位置。浏览器测试用它把数据放在 `.data/e2e`。
- `.tools` 放可选引擎和下载缓存。安装脚本会校验固定版本下载的 SHA-256。
- 浏览器只缓存有限的最近记录，并保留尚待写入谱库的更改。清空浏览器数据不能代替删除谱库，也不能当作备份。

服务只绑定回环地址，并检查请求的 Host 和 Origin。页面带内容安全策略，只允许同源脚本和请求。带内容哈希的构建文件长期缓存，页面本身每次重新验证，音色采样缓存一小时。上传检查文件大小、格式和保存路径；这些检查不是操作系统沙箱。该服务没有用户认证或多用户隔离，不适合作为公开上传端点。
