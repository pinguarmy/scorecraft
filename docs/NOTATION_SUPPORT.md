# 记谱与播放支持

识别图片、显示 MusicXML 和播放音符是三件事。可以把音色换成吉他，但这不会让识谱引擎读懂六线谱图片。

| 手头的谱 | 可以做什么 |
| --- | --- |
| 标准印刷五线谱的 PDF、PNG 或 JPEG | 安装 Audiveris 后在本机识别。识别结果可能有错，先和原稿比对。 |
| 含音高和时值的 MusicXML/MXL | 不用识别，直接显示、播放和导出。适用于钢琴、吉他、贝斯、声乐等用五线谱记写的音乐。 |
| 含弦号、品位和音高的吉他或贝斯 MusicXML | 排版器可显示 TAB 记号，播放依据文件里明确写出的音高。只有弦号和品位时，谱间不会按调弦猜音高。纯 TAB 图片和 ASCII TAB 文本不能识别。 |
| 带鼓件映射的 MusicXML | 依据明确的 MIDI 鼓件编号播放。缺少映射的音符会提示并跳过，不根据谱面位置猜鼓件。鼓谱图片识别后，也要检查这些映射。 |
| 简谱、手写谱、歌词加和弦、录音 | 不提供相应的识别或自动伴奏。 |

普通反复会影响播放和导出顺序。复杂反复、滑音、推弦和部分表情或装饰记号可能可以显示，但不能保证按原意演奏。播放前遇到识谱或排版提示，建议先与原稿比对。

参考：[Audiveris 识谱限制](https://audiveris.github.io/audiveris/_pages/reference/limitations/)、[Audiveris TAB 处理](https://audiveris.github.io/audiveris/_pages/guides/specific/tablature/)、[MusicXML 鼓件映射](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/midi-unpitched/)。
