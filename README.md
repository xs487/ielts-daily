# IELTS DAILY

IELTS Academic 每日词汇练习网站：浏览器本地识别截图、核对训练词，按词汇生成听力、阅读、写作、口语题目，并提供练习反馈。题目为原创模拟材料，评分为练习估分。

公开构建不包含开发时提供的个人 PDF 词库。每位访客导入自己的词汇；词库、答案、作文、录音及反馈保存在该访客的浏览器。截图 OCR 在本地完成，出题时提交词汇，写作评分时提交题目、Task 1 图表和作文给管理员配置的 AI 服务商。

## 原创出题与复盘

命题规则版本：`2026-11-original-v4`。参考 IELTS 官方公开题型说明，采用原创材料与自建测试数据；不接入或抓取新东方题库，不把第三方原题、音频、范文或解析发送给模型。[来源和质量规则](QUESTION_QUALITY.md)记录实际查阅范围及限制。

听力独立题按有效引文位置排序并编号，阅读单选四项、听力单选三项，判断题区分事实支持、反证与未提供的信息。服务端校验连续引文确实来自对应原创材料、填空答案在引文中、选项不重复、题型符合本次蓝图及答案符合字数限制；主解析必填，附加干扰项理由按实际生成的合法条目显示，不编造遗漏理由。不合格模块最多重试一次，仍失败则释放本次名额。语义正确性和实际难度仍需审题，校验通过不代表官方认证。

交卷后显示中文解析、原文依据、干扰项理由、按考点统计的错题和复习建议；听力脚本也可展开。Task 1 评分会核对题目附带的表格，缺少表格时不得给出数据准确性结论或完整估分。旧的本地试卷仍可继续使用，新规则应用于之后生成的试卷。

在仓库根目录运行 `node --test tests/*.test.cjs` 可检查出题校验、评分、安全边界和前端复盘逻辑。测试采用自建材料与模拟接口，不需要密钥，也不会调用收费服务。

## 部署设置

将本目录作为 Vercel 项目根目录导入。所有环境变量只在 Vercel 服务端设置，Production 环境即可；修改后需要重新部署。密钥不要提交到仓库、前端代码、截图或聊天。

本项目当前采用 `AI_PROVIDER=deepseek` 和 `TTS_PROVIDER=doubao`。已有 Upstash 配置保持不变；只需在服务端新增对应两家的 `DEEPSEEK_API_KEY`、`DOUBAO_TTS_API_KEY`，以及上述两个服务商选择项。不要把原 WAWA ZZ 密钥当成 DeepSeek 或豆包密钥。

| 变量 | 内容 |
| --- | --- |
| `AI_PROVIDER` | `openai`（默认）、`wawazz` 或 `deepseek` |
| `OPENAI_API_KEY` | 仅用于 `openai` / `wawazz` 模式：填写所选服务商签发的密钥。此名称为兼容已有部署保留 |
| `OPENAI_MODEL` | 官方模式文本模型，可选，默认 `gpt-4o-mini` |
| `WAWAZZ_MODEL` | WAWA ZZ 模式文本模型，可选，默认 `gpt-5.6-terra` |
| `DEEPSEEK_API_KEY` | DeepSeek 模式必填的独立官方密钥，不会回退使用 `OPENAI_API_KEY` |
| `DEEPSEEK_MODEL` | DeepSeek 模式文本模型，可选，默认 `deepseek-flash`（官方当前映射到 DeepSeek-V4.1-Flash-1017），也支持 `deepseek-v4-pro` |
| `TTS_PROVIDER` | 独立语音服务：`doubao`、`openai` 或 `none`；未设时，仅文本服务为 OpenAI 时兼容旧版 OpenAI 语音配置，其他模式不启用语音 |
| `DOUBAO_TTS_API_KEY` | `doubao` 模式必填，在豆包语音新控制台创建的 API Key；不是火山方舟文本模型 Key |
| `DOUBAO_TTS_VOICE` | 可选，默认豆包 2.0 英式英语男声 `ICL_uranus_en_male_alastor_tob`，需在账号中开通该音色和资源 |
| `OPENAI_TTS_API_KEY` | 独立 OpenAI 语音密钥；文本服务不是 `openai` 时必须单独填写，不会复用 WAWA ZZ 或 DeepSeek 密钥 |
| `OPENAI_TTS_MODEL` | OpenAI 语音模型，可选，默认 `gpt-4o-mini-tts` |
| `UPSTASH_REDIS_REST_URL` | Upstash 数据库的 REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | 同一数据库有写入权限的 REST Token，不能使用只读 Token |

`AI_PROVIDER=deepseek` 时，文本请求只发往固定官方地址 `https://api.deepseek.com/chat/completions`，只使用独立的 `DEEPSEEK_API_KEY`，开启 JSON 输出并明确关闭思考模式。`AI_PROVIDER=wawazz` 时，文本请求只发往固定地址 `https://wawazz.xyz/v1/responses`，并设置 `store: false`。`AI_PROVIDER=openai` 时，文本请求只发往官方 `https://api.openai.com/v1/chat/completions`。前端不能指定服务商、请求地址、模型或密钥；AI 请求禁止自动重定向，上游错误只转换为固定提示。`store: false` 是请求参数，不代表第三方服务商对数据保留的独立承诺；使用其服务需了解其数据处理政策。

文本与语音可以分别设置，例如 `AI_PROVIDER=deepseek` 和 `TTS_PROVIDER=doubao`。豆包语音请求只发往固定官方地址 `https://openspeech.bytedance.com/api/v3/tts/unidirectional`，使用独立的 `DOUBAO_TTS_API_KEY` 和固定资源 `seed-tts-2.0`，输出 MP3（24 kHz）。服务端读取上游逐行 JSON 音频流，验证 Base64、正常完成标记及大小后才返回整段 MP3，不会把半截音频或上游错误原文发给浏览器。

未配置或格式无效的语音服务返回 `TTS_NOT_CONFIGURED`，不扣音频限额，也不发送外部请求。网页可通过无额度的 `capabilities` 动作同步公开服务名称和音频是否启用，避免旧练习记录一直停留在先前的语音状态；接口不返回密钥、服务地址或配置详情。口语题目可复制到外部评分流程，网页不会自行上传本地录音。

豆包 2.0 官方标准价为 3 元 / 万字符，英文也按字符而不是单词统计。官方试用说明为领取后 20,000 字符、有效期半年，是否可领取及实际权益以语音控制台领取页为准。配置语音密钥不会替账号开通资源或购买套餐。豆包接口和默认音色依据：[HTTP 流式语音合成](https://docs.volcengine.com/docs/doubao-voice/unidirectional-streaming-text-to-speech-http?lang=zh)。

## 请求与数据

Upstash 只保存哈希 IP、生成预留状态和请求计数，用于限制每个 IP 每天成功生成一套题、每天生成四次听力音频、每小时提交八次作文评分。整卷生成先原子预留名额，完整试卷通过校验后才提交；模型失败或结构不合格会释放预留。未完成的预留最多保留六分钟。限额配置缺失或不可用时，AI 接口拒绝请求。密钥格式及服务商配置会在限额计数前校验。

Vercel 函数最长运行 300 秒，整套出题分两阶段并行生成：先生成四段听力脚本、三篇阅读正文、写作和口语，再依据实际文本生成听读题组；每个模块至多自动重试一次，总等待上限约 270 秒。阅读三篇各 700–1000 词，目标各 780–850 词，生成题目前核验总长 2150–2750 词，共 40 题。听力各部分脚本目标 750–950 词，仅使用填空、简答及选择题，不使用阅读的 TRUE/FALSE/NOT GIVEN 题型；写作 Task 1 的表格说明由已校验的数据生成。作文评分最多等待 60 秒，豆包语音最多等待 180 秒，OpenAI 语音最多等待 120 秒。每段音频最多 3 MiB，以控制 Vercel 响应大小；听力文本最多 8,000 字符。DeepSeek / WAWA ZZ 每个生成模块最多输出 7,500 token、作文反馈最多输出 4,000 token；后端仅提取最终文字内容，忽略 reasoning，并拒绝不完整、失败或拒答结果。DeepSeek 的 `finish_reason` 必须为 `stop` 才会接受结果。作文解释和提升建议使用中文，英文原句及修改后的句子保持英语。

DeepSeek 参数依据：[首次调用](https://api-docs.deepseek.com/zh-cn/)、[模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)、[Chat Completions API](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)。

麦克风录音需要 HTTPS。第三方组件声明见 [vendor/NOTICE.md](vendor/NOTICE.md)。
