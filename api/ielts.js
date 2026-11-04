const {createHash} = require('node:crypto');

const systemPrompt = `You are an IELTS Academic practice-material author. Create original practice, never claim it is an official IELTS paper, and never copy remembered test material. Use the supplied vocabulary naturally across the paper; do not force every word into every passage. Keep language and task structures faithful to IELTS Academic.

For action=generate, return one JSON object with exactly this shape:
{"listening":{"parts":[{"title":"","scenario":"","script":"","questions":[{"number":1,"format":"text|choice|tfng","prompt":"","options":[],"answer":"","acceptedAnswers":[],"explanation":""}]}]},"reading":{"passages":[{"id":"P1","title":"","text":""}],"questions":[{"number":1,"passageId":"P1","format":"text|choice|tfng","prompt":"","options":[],"answer":"","acceptedAnswers":[],"explanation":"","evidence":""}]},"writing":{"task1":{"prompt":"","chart":{"title":"","categories":[],"series":[{"name":"","values":[]}] }},"task2":{"prompt":""}},"speaking":{"part1":[],"part2":{"cueCard":""},"part3":[]}}.

Listening must have 4 parts and exactly 10 numbered questions per part (1-40). Write a complete natural dialogue/monologue script for each part. Mix note/form completion, multiple choice, short answer, and map/plan directions expressed clearly in question prompts. Use format=text for short answers, choice for options, tfng only when appropriate. For choice/tfng, options must be an array of strings. For choice answers, copy the exact correct option text into answer, not a letter. Answers and concise explanations must be unambiguous.

Reading must have 3 original passages totalling about 2,150-2,500 words and exactly 40 numbered questions (1-40) linked to a passage. Vary IELTS Academic formats: TRUE/FALSE/NOT GIVEN, multiple choice, short answer, and sentence completion. Use format=tfng with options ["TRUE","FALSE","NOT GIVEN"], format=choice with 3-4 options, and format=text for short answers. Put acceptable short-answer variants in acceptedAnswers. Add a brief evidence quote for every question.

Writing must contain an Academic Task 1 visual-data prompt with coherent categories and numeric series, plus a Task 2 discussion/argument prompt. Both must be original and answerable.

Speaking must include 4-5 Part 1 interview questions, one IELTS-style Part 2 cue card with 3-4 bullets and a final explain question, and 4-5 increasingly analytical Part 3 questions related to Part 2.

Return valid JSON only. Do not put answers or listening scripts in learner-facing prompts; scripts and answers belong only in their specified fields. Do not fabricate official band conversions.`;

const gradePrompt = `Evaluate the supplied IELTS Academic writing response as cautious practice feedback, not an official score. Return JSON only with this shape: {"taskResponse":number,"coherenceCohesion":number,"lexicalResource":number,"grammarAccuracy":number,"overallEstimate":number,"strengths":[string],"priorities":[string],"sentenceCorrections":[{"original":string,"revision":string,"reason":string}],"feedback":string}. Scores must be half bands from 0 to 9. Cite evidence from the response. For Task 1, assess task achievement; for Task 2, assess task response. State when the response is too short to assess reliably.`;

function reply(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

function getOpenAIKey(res) {
  let key=String(process.env.OPENAI_API_KEY||'').trim();
  if(!key){
    reply(res,503,{error:'服务端还没有配置 OpenAI API 密钥。'});
    return null;
  }
  if((key.startsWith('"')&&key.endsWith('"'))||(key.startsWith("'")&&key.endsWith("'")))key=key.slice(1,-1).trim();
  if(!key||/[\s"']/.test(key)){
    reply(res,503,{error:'服务端密钥格式无效，请管理员重新填写完整密钥。',code:'AI_KEY_FORMAT_INVALID'});
    return null;
  }
  return key;
}

async function rateLimit(req, action) {
  const redisUrl=process.env.UPSTASH_REDIS_REST_URL;
  const redisToken=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!redisUrl||!redisToken)return null;
  const forwarded = req.headers['x-forwarded-for'];
  const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : 'unknown';
  const daily=action==='generate'||action==='audio';
  const day=new Date().toISOString().slice(0,10);
  const window=daily?day:new Date().toISOString().slice(0,13);
  const limit=action==='generate'?1:action==='audio'?4:8;
  const hash=createHash('sha256').update(ip).digest('hex').slice(0,24);
  const key=`ielts:${action}:${hash}:${window}`;
  try{
    const response=await fetch(`${redisUrl.replace(/\/$/,'')}/pipeline`,{
      method:'POST',headers:{Authorization:`Bearer ${redisToken}`,'Content-Type':'application/json'},
      body:JSON.stringify([['INCR',key],['EXPIRE',key,daily?86400:3600]]),signal:AbortSignal.timeout(5000)
    });
    if(!response.ok)return null;
    const result=await response.json();
    if(!Array.isArray(result)||result.length!==2||result.some(item=>!item||item.error))return null;
    const count=result[0].result;
    if(!Number.isSafeInteger(count)||count<1||result[1].result!==1)return null;
    return count<=limit;
  }catch{return null;}
}

function validWords(words) {
  return Array.isArray(words) && words.length >= 1 && words.length <= 100 && words.every(item =>
    item && typeof item.word === 'string' && item.word.trim().length > 0 && item.word.length <= 120 &&
    (item.meaning === undefined || typeof item.meaning === 'string')
  );
}

function validQuestions(questions, firstNumber) {
  return Array.isArray(questions) && questions.length === 10 && questions.every((question,index) =>
    question && question.number === firstNumber + index && typeof question.prompt === 'string' && question.prompt.trim() &&
    typeof question.answer === 'string' && question.answer.trim() && typeof question.explanation === 'string' &&
    ['text','choice','tfng'].includes(question.format) &&
    (question.format === 'text' || Array.isArray(question.options) && question.options.length >= 3 && question.options.includes(question.answer))
  );
}

function wordCount(value) { return (String(value||'').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)||[]).length; }

function validReading(reading) {
  if(!Array.isArray(reading?.passages)||reading.passages.length!==3||!Array.isArray(reading.questions)||reading.questions.length!==40)return false;
  const passageIds=reading.passages.map(passage=>passage.id);
  const totalWords=reading.passages.reduce((sum,passage)=>sum+wordCount(passage.text),0);
  if(new Set(passageIds).size!==3||reading.passages.some(passage=>!passage.title||!passage.text)||totalWords<1900||totalWords>2800)return false;
  return reading.questions.every((question,index)=>question&&question.number===index+1&&question.prompt&&question.answer&&question.explanation&&
    ['text','choice','tfng'].includes(question.format)&&passageIds.includes(question.passageId)&&
    (question.format==='text'||Array.isArray(question.options)&&question.options.length>=3&&question.options.includes(question.answer)));
}

function replyAIError(res, status, payload) {
  if(status===401)return reply(res,502,{error:'AI 服务认证失败，请网站管理员核对服务端密钥及其所属服务商。',code:'AI_AUTH_FAILED'});
  if(status===403)return reply(res,502,{error:'AI 服务拒绝访问，请网站管理员核对项目权限。',code:'AI_ACCESS_DENIED'});
  if(status===429){
    const quotaCodes=['insufficient_quota','credit_balance_exhausted','organization_spend_limit_exceeded','project_spend_limit_exceeded','organization_usage_limit_exceeded'];
    const quota=quotaCodes.includes(payload?.error?.code)||payload?.error?.type==='insufficient_quota';
    return reply(res,429,{error:quota?'AI 服务额度暂不可用，请网站管理员检查账户配置。':'AI 服务请求繁忙，请稍后重试。',code:quota?'AI_QUOTA_UNAVAILABLE':'AI_RATE_LIMITED'});
  }
  return reply(res,502,{error:'AI 服务暂未完成请求，请稍后重试；如持续失败，请网站管理员核对模型配置。',code:'AI_UPSTREAM_ERROR'});
}

async function openAI(req, res, body) {
  const apiKey=getOpenAIKey(res);
  if(!apiKey)return {handled:true};
  let response;
  try { response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{role: 'system', content: body.system}, {role: 'user', content: body.user}],
      response_format: {type: 'json_object'},
      max_tokens: body.maxTokens || 15000,
      temperature: body.temperature ?? 0.55
    }),
    signal: AbortSignal.timeout(body.timeoutMs || 270000)
  }); } catch {
    reply(res, 502, {error: '暂时无法连接 AI 服务，请稍后重试。'});
    return {handled: true};
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    replyAIError(res,response.status,payload);
    return {handled: true};
  }
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    reply(res, 502, {error: 'AI 没有返回可用内容，请稍后重试。'});
    return {handled: true};
  }
  try { return JSON.parse(content); }
  catch {
    reply(res, 502, {error: 'AI 返回格式暂时无法读取，请重试。'});
    return {handled: true};
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, {error: '仅支持 POST 请求。'});
  const body = req.body || {};
  if (body.action === 'generate') {
    if (!validWords(body.words)) return reply(res, 400, {error: '请先导入 1 到 100 个有效训练词。'});
    const allowed=await rateLimit(req,'generate');
    if(allowed===null)return reply(res,503,{error:'练习服务尚未配置安全的访问限额。'});
    if(!allowed)return reply(res,429,{error:'此网络今天已生成过一套练习，请明天再试。'});
    const input = {
      date: typeof body.date === 'string' ? body.date.slice(0, 10) : '',
      targetBand: 7,
      vocabulary: body.words.map(item => ({word: item.word.trim(), meaning: String(item.meaning || '').slice(0, 240)}))
    };
    const result = await openAI(req, res, {
      system: systemPrompt,
      user: `Create one complete IELTS Academic daily practice set for this date using this vocabulary data.\n${JSON.stringify(input)}`
    });
    if (result?.handled) return;
    const chart=result.writing?.task1?.chart;
    if (!result.listening?.parts || result.listening.parts.length !== 4 || result.listening.parts.some((part,index) => !part.title || !part.script || !validQuestions(part.questions,index*10+1)) ||
        !validReading(result.reading) ||
        !result.writing?.task1?.prompt || !result.writing?.task2?.prompt || !Array.isArray(chart?.categories)||chart.categories.length<4||!Array.isArray(chart?.series)||chart.series.length<2||chart.series.some(series=>!Array.isArray(series.values)||series.values.length!==chart.categories.length) ||
        !Array.isArray(result.speaking?.part1) || result.speaking.part1.length<4 || result.speaking.part1.length>5 || !result.speaking?.part2?.cueCard || !Array.isArray(result.speaking?.part3) || result.speaking.part3.length<4 || result.speaking.part3.length>5) {
      return reply(res, 502, {error: '生成结果没有达到完整试卷结构，请重试。'});
    }
    return reply(res, 200, {date: input.date, generatedAt: new Date().toISOString(), paper: result});
  }
  if (body.action === 'grade-writing') {
    if (!['task1', 'task2'].includes(body.task) || typeof body.response !== 'string' || body.response.trim().length < 40 || body.response.length > 25000 || typeof body.prompt !== 'string' || body.prompt.length > 3000) {
      return reply(res, 400, {error: '请提交至少 40 个字符、且不超过 25,000 个字符的作文。'});
    }
    const allowed=await rateLimit(req,'grade');
    if(allowed===null)return reply(res,503,{error:'练习服务尚未配置安全的访问限额。'});
    if(!allowed)return reply(res,429,{error:'评分请求较多，请一小时后再试。'});
    const result = await openAI(req, res, {
      system: gradePrompt,
      user: JSON.stringify({task: body.task, prompt: body.prompt, response: body.response}),
      maxTokens: 2500,
      timeoutMs: 60000,
      temperature: 0.2
    });
    if (result?.handled) return;
    return reply(res, 200, {feedback: result});
  }
  if (body.action === 'audio') {
    if (typeof body.script !== 'string' || body.script.trim().length < 20 || body.script.length > 8000) return reply(res, 400, {error: '听力文本长度无效。'});
    const apiKey=getOpenAIKey(res);
    if(!apiKey)return;
    const allowed=await rateLimit(req,'audio');
    if(allowed===null)return reply(res,503,{error:'练习服务尚未配置安全的访问限额。'});
    if(!allowed)return reply(res,429,{error:'音频生成请求过多，请明天再试。'});
    let audio;
    try{audio = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts', voice: 'alloy', input: body.script, instructions: 'Read clearly in a natural British English accent at a measured exam pace.', response_format: 'mp3'}),
      signal: AbortSignal.timeout(120000)
    });}catch{return reply(res,502,{error:'暂时无法连接语音服务，请稍后重试。'});}
    if (!audio.ok) return reply(res, 502, {error: '听力音频生成失败，请稍后重试。'});
    const buffer = Buffer.from(await audio.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buffer);
  }
  return reply(res, 400, {error: '不支持的操作。'});
};
