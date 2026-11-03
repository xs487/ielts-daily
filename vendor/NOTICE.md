# 本地截图识别依赖

- Tesseract.js 6.0.1 — https://github.com/naptha/tesseract.js — Apache-2.0。许可证位于 tesseract/LICENSE.md。
- tesseract.js-core 6.1.2 — https://github.com/naptha/tesseract.js-core — Apache-2.0。许可证位于 tesseract-core/LICENSE。
- @tesseract.js-data/eng 1.0.0 — 英文 4.0.0_best_int 语言数据，npm 元数据标记 MIT；包元数据保存在 tessdata/package.json。
- Three.js 0.149.0 — https://github.com/mrdoob/three.js — MIT。使用本地 build/three.min.js；许可证位于 three/LICENSE。npm 包归档已按 registry 完整性值校验。

资源从 npm registry 的指定版本下载并校验包完整性。识别所需脚本、Worker、WebAssembly 和英文模型由当前本地网页提供；用户图片在浏览器内处理，不发送至外部识别服务。
