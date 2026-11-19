# 本地多乐器采样与署名

本目录选取 Nicholaus P. Brosowsky 的 tonejs-instruments 多根音样本。上游明确区分代码 MIT 与 **样本 CC BY 3.0**；不能因为代码采用 MIT 就把录音称为 MIT。[11]

来源固定为 commit `622c2f1c32c8cfce4158ddc3eb26e518ddef37e5`。本地 46 个 MP3 均逐字节复制，没有转码、裁切或归一化。总计 9,477,234 字节。每个文件的根音、原始来源、SHA-256、Git blob SHA 与大小见 [source-manifest.json](source-manifest.json)。

| ID | 显示名 | 根音 | 个数 | 大小 |
| --- | --- | --- | --- | --- |
| guitar-acoustic | 原声吉他 | D2 F2 Gs2 B2 D3 F3 Gs3 B3 D4 F4 Gs4 B4 D5 | 13 | 2,481,254 字节 |
| guitar-electric | 电吉他 | E2 Fs2 A2 C3 Ds3 Fs3 A3 C4 Ds4 Fs4 A4 C5 Ds5 Fs5 A5 C6 | 16 | 1,643,136 字节 |
| bass-electric | 电贝斯 | E1 G1 As1 E2 As2 E3 As3 E4 G4 | 9 | 2,777,224 字节 |
| strings | 弦乐·小提琴 | G3 C4 G4 C5 G5 C6 G6 C7 | 8 | 2,575,620 字节 |

`Cs`、`Ds`、`Fs`、`Gs`、`As` 中的 `s` 表示升号，C4 对应 MIDI 60。`strings` 是小提琴录音，不是合奏弦乐。每套有多个原始根音，不是把一小段声音变调覆盖全部乐器；根音以外采用最近音变调时应如实说明。这不是逐键、多力度、多奏法的完整音源。上游没有给这些 MP3 提供 loop 点，不应擅称自然无限延音。

## 原始来源与署名

上游来源清单记录了以下原始贡献者或项目，拼写原样保留：[12]

- 原声吉他为 `Iowa`：爱荷华大学 [Musical Instrument Samples](https://theremin.music.uiowa.edu/MIS.html) 项目声明录音可不受限制地用于项目。上游没有给出具体录音编号，也没有将原录音标为 CC0。
- 电吉他和电贝斯为 `Karoryfer`：[官方目录](https://shop.karoryfer.com/pages/free-samples)说明其免费采样包除 Marie Ork 外现为 CC0。电贝斯与 [Pastabass](https://shop.karoryfer.com/pages/free-pastabass) 的部分原录音吻合；电吉他的具体采样包未确认。
- 小提琴为 `VSO2`：八个根音与 Versilian Studios [VSCO 2 Community Edition 独奏小提琴](https://github.com/sgossner/VSCO-2-CE/tree/440300901dfe9275fd84e0b7763af1f8443ae62e/Strings/Solo%20Violin/Arco%20Vib) 原录音吻合，原录音采用 [CC0](https://raw.githubusercontent.com/sgossner/VSCO-2-CE/440300901dfe9275fd84e0b7763af1f8443ae62e/LICENSE)。

CC BY 3.0 是 tonejs-instruments 对其编辑版样本的许可标注，不是对上述原录音的重新授权。

可使用以下署名，并在对外分享采样混音时保留作者与许可信息：

> Instrument samples selected from tonejs-instruments by Nicholaus P. Brosowsky, CC BY 3.0. Original source credits: Iowa, Karoryfer, VSO2, as documented upstream. Source: https://github.com/nbrosowsky/tonejs-instruments/tree/622c2f1c32c8cfce4158ddc3eb26e518ddef37e5 . License: https://creativecommons.org/licenses/by/3.0/ . Selected MP3 recordings redistributed unchanged; playback may transpose, envelope and mix them. The strings preset uses violin recordings, not a string ensemble.

[UPSTREAM-README.md](UPSTREAM-README.md)、[UPSTREAM-LICENSE.md](UPSTREAM-LICENSE.md) 与 [UPSTREAM-sample-source-info.txt](UPSTREAM-sample-source-info.txt) 均为固定版本的原样副本。上游自行做过裁静音、响度匹配、降噪与部分音高校正，本项目没有再次修改 MP3。[1] CC BY 3.0 法律全文可从同一应用的 [钢琴素材许可](../piano/LICENSE.txt) 查看，在线原文为 https://creativecommons.org/licenses/by/3.0/legalcode.txt 。

采样与应用 AGPL 代码分开授权，不暗示这些作者为 ScoreCraft 背书。没有下载 Tonejs 的许可不明确鼓素材，没有借用 FluidR3 的根 MIT 许可证覆盖实际 SoundFont 录音权利。明亮钢琴若复用 Salamander 加 EQ，不是新的录音；合成器与电子鼓若由应用生成，应标为合成，不混称真实采样。

## Sources

[1] https://github.com/nbrosowsky/tonejs-instruments
[11] https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/622c2f1c32c8cfce4158ddc3eb26e518ddef37e5/LICENSE.md
[12] https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/622c2f1c32c8cfce4158ddc3eb26e518ddef37e5/sample-source-info.txt
