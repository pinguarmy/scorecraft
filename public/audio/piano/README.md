# Salamander Grand Piano 钢琴采样

Salamander Grand Piano by **Alexander Holm**, licensed under [Creative Commons Attribution 3.0 Unported](https://creativecommons.org/licenses/by/3.0/). Source recordings are a Yamaha C5 grand piano recorded with two AKG c414 microphones.[6][2]

本目录的 30 个 MP3 来自 [Tonejs/audio](https://github.com/Tonejs/audio/tree/efd8296360f9526e379bfbe5c1698ff54d6a1d34/salamander)，固定 commit 为 `efd8296360f9526e379bfbe5c1698ff54d6a1d34`。它们覆盖 A0 到 C8，按小三度取根音，原文件名中的 `Ds` 表示 D♯，`Fs` 表示 F♯。[7]

## 署名与许可

可使用以下署名：

> Piano samples: Salamander Grand Piano by Alexander Holm, CC BY 3.0. Web MP3 subset from Tonejs/audio, commit efd8296360f9526e379bfbe5c1698ff54d6a1d34. Source: https://sfzinstruments.github.io/pianos/salamander/ . License: https://creativecommons.org/licenses/by/3.0/ . Samples redistributed unchanged; playback may transpose, mix and envelope the recordings.

采样资源按 CC BY 3.0 单独授权，不因与 ScoreCraft 一起分发就变为 AGPL，也不转移用户原谱的权利。分发素材或使用其制作的改编录音时，应保留合理署名、来源与许可链接，并说明所作修改。CC BY 3.0 允许复制、改编、分发和公开表演，但不代表作者或 Yamaha/AKG 为本软件背书。[5]

- [README](README) 是固定 commit 下上游说明的逐字节副本，保留了作者、录音信息与 `CC-by` 许可声明。[6]
- [LICENSE.txt](LICENSE.txt) 是 Creative Commons 官方的完整英文法律文本，未作改写。[5]
- [source-manifest.json](source-manifest.json) 记录每个文件的 MIDI 根音、同源路径、字节数、SHA-256、上游 Git blob SHA 与固定来源 URL。

## 这个轻量版本不包含什么

上游完整库描述了 48 kHz/24-bit 录音、16 个力度层、琴槌与共振释放采样。[6][2]这里仅分发该 Tonejs/audio 目录的全部 30 个 MP3，每个根音一个文件；没有 16 层力度切换，也没有完整 SFZ、踏板或共振素材。[7]ScoreCraft 未重新转码、裁切或归一化这些 MP3，总大小为 2,012,677 字节。播放引擎可以变速移调与施加包络，但不能将此称为完整 Salamander 16 层钢琴。

采样加载应使用同源 `/audio/piano/` 路径，不需要在运行时访问 GitHub 或 CDN。来源 URL 仅用于许可证与追溯。本目录的下载与哈希核验不等于已验证浏览器解码、播放质量或离线 WAV 输出，这些由应用集成验收负责。

## Sources

[2] https://sfzinstruments.github.io/pianos/salamander
[5] https://creativecommons.org/licenses/by/3.0/legalcode.txt
[6] https://raw.githubusercontent.com/Tonejs/audio/efd8296360f9526e379bfbe5c1698ff54d6a1d34/salamander/README
[7] https://api.github.com/repos/Tonejs/audio/contents/salamander?ref=efd8296360f9526e379bfbe5c1698ff54d6a1d34
