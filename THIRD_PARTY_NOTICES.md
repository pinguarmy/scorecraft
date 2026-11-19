# 第三方声明 / Third-party notices

ScoreCraft 的应用代码采用 [AGPL-3.0-or-later](<LICENSE>)。[示例乐谱和衍生谱页](<public/samples/README.md>)采用 CC0。用户导入的乐谱保留其原有权利。

## 录音 / Recordings

这些素材与应用代码分开授权。随项目分发或分享使用这些采样的混音时，请保留相应署名和许可链接。应用在播放和生成 WAV 时可能变调、调整音量包络或混音，不会修改仓库中的录音文件。

- **钢琴。** Alexander Holm 的 Salamander Grand Piano，CC BY 3.0。30 个 MP3 来自固定版本的 Tonejs/audio。[署名和来源](<public/audio/piano/README.md>) · [许可全文](<public/audio/piano/LICENSE.txt>) · [文件校验清单](<public/audio/piano/source-manifest.json>)。明亮钢琴是同一套录音加均衡，不是另一套录音。
- **原声吉他、电吉他、电贝斯和小提琴。** 来自 Nicholaus P. Brosowsky 的 tonejs-instruments；上游对录音标为 CC BY 3.0，代码另为 MIT。[原始贡献者、署名和来源](<public/audio/instruments/README.md>) · [上游许可](<public/audio/instruments/UPSTREAM-LICENSE.md>) · [文件校验清单](<public/audio/instruments/source-manifest.json>)。
- 合成铺底、电子鼓和节拍器由 ScoreCraft 生成，不使用外部录音。

## 软件 / Software

Audiveris 是单独安装的识谱程序，不随源码包分发。npm 依赖的固定版本见 [package-lock.json](<package-lock.json>)；各依赖及其传递依赖的许可见安装后附带的许可文件。

| 用途 | 组件及上游许可 |
| --- | --- |
| 本机识谱 | [Audiveris](https://github.com/Audiveris/audiveris)（AGPL-3.0）；引擎本身附带的 JVM、库和模型遵循上游许可。 |
| 谱面、界面 | [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay)（BSD-3-Clause）、[React](https://github.com/facebook/react)（MIT） |
| 本机服务与上传 | [Express](https://github.com/expressjs/express)、[Multer](https://github.com/expressjs/multer)（均为 MIT） |
| XML 和 ZIP | [@xmldom/xmldom](https://github.com/xmldom/xmldom)、[fflate](https://github.com/101arrowz/fflate)（均为 MIT） |
| 开发与测试 | [Vite](https://vite.dev/) 和 [tsx](https://tsx.is/)（MIT）；[TypeScript](https://www.typescriptlang.org/) 和 [Playwright](https://github.com/microsoft/playwright)（Apache-2.0） |
