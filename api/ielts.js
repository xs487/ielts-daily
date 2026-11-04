const {createHash,randomUUID} = require('node:crypto');

const systemPrompt = `You are an IELTS Academic practice-material author. Create original practice, never claim it is an official IELTS paper, and never copy remembered test material. Use the supplied vocabulary naturally across the paper; do not force every word into every passage. Keep language and task structures faithful to IELTS Academic.

For action=generate, return one JSON object with exactly this shape:
{"listening":{"parts":[{"title":"","scenario":"","script":"","questions":[{"number":1,"format":"text|choice|tfng","prompt":"","options":[],"answer":"","acceptedAnswers":[],"explanation":""}]}]},"reading":{"passages":[{"id":"P1","title":"","text":""}],"questions":[{"number":1,"passageId":"P1","format":"text|choice|tfng","prompt":"","options":[],"answer":"","acceptedAnswers":[],"explanation":"","evidence":""}]},"writing":{"task1":{"prompt":"","chart":{"title":"","categories":[],"series":[{"name":"","values":[]}] }},"task2":{"prompt":""}},"speaking":{"part1":[],"part2":{"cueCard":""},"part3":[]}}.

Listening must have 4 parts and exactly 10 numbered questions per part (1-40). Write a complete natural dialogue/monologue script for each part. Mix note/form completion, multiple choice, short answer, and map/plan directions expressed clearly in question prompts. Use format=text for short answers, choice for options, tfng only when appropriate. For choice/tfng, options must be an array of strings. For choice answers, copy the exact correct option text into answer, not a letter. Answers and concise explanations must be unambiguous.

Reading must have 3 original passages totalling about 2,150-2,500 words and exactly 40 numbered questions (1-40) linked to a passage. Vary IELTS Academic formats: TRUE/FALSE/NOT GIVEN, multiple choice, short answer, and sentence completion. Use format=tfng with options ["TRUE","FALSE","NOT GIVEN"], format=choice with 3-4 options, and format=text for short answers. Put acceptable short-answer variants in acceptedAnswers. Add a brief evidence quote for every question.

Writing must contain an Academic Task 1 visual-data prompt with coherent categories and numeric series, plus a Task 2 discussion/argument prompt. Both must be original and answerable.

Speaking must include 4-5 Part 1 interview questions, one IELTS-style Part 2 cue card with 3-4 bullets and a final explain question, and 4-5 increasingly analytical Part 3 questions related to Part 2.

Return valid JSON only. Do not put answers or listening scripts in learner-facing prompts; scripts and answers belong only in their specified fields. Do not fabricate official band conversions.`;

const gradePrompt = `Evaluate the supplied IELTS Academic writing response as cautious practice feedback, not an official score. Return JSON only with this shape: {"taskResponse":number,"coherenceCohesion":number,"lexicalResource":number,"grammarAccuracy":number,"overallEstimate":number,"strengths":[string],"priorities":[string],"sentenceCorrections":[{"original":string,"revision":string,"reason":string}],"feedback":string}. Scores must be half bands from 0 to 9. Cite evidence from the response. For Task 1, assess task achievement; for Task 2, assess task response. State when the response is too short to assess reliably. Write strengths, priorities, correction reasons, and feedback in simplified Chinese; keep quoted original sentences, revised sentences, and the exam prompt in English.`;

const providerProfiles = Object.freeze({
  openai: Object.freeze({endpoint:'https://api.openai.com/v1/chat/completions',api:'chat',defaultModel:'gpt-4o-mini',modelEnv:'OPENAI_MODEL'}),
  wawazz: Object.freeze({endpoint:'https://wawazz.xyz/v1/responses',api:'responses',defaultModel:'gpt-5.6-terra',modelEnv:'WAWAZZ_MODEL'}),
  deepseek: Object.freeze({endpoint:'https://api.deepseek.com/chat/completions',api:'chat',defaultModel:'deepseek-flash',modelEnv:'DEEPSEEK_MODEL',keyEnv:'DEEPSEEK_API_KEY',models:Object.freeze(['deepseek-flash','deepseek-v4-pro'])})
});

function reply(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

function normalizeSecret(value) {
  let key=String(value||'').trim();
  if((key.startsWith('"')&&key.endsWith('"'))||(key.startsWith("'")&&key.endsWith("'")))key=key.slice(1,-1).trim();
  return key&&!/[\s"']/.test(key)?key:null;
}

function getOpenAIKey(res, keyEnv='OPENAI_API_KEY') {
  const raw=String(process.env[keyEnv]||'').trim();
  if(!raw){
    reply(res,503,{error:'服务端还没有配置 AI API 密钥。',code:'AI_KEY_MISSING'});
    return null;
  }
  const key=normalizeSecret(raw);
  if(!key){
    reply(res,503,{error:'服务端密钥格式无效，请管理员重新填写完整密钥。',code:'AI_KEY_FORMAT_INVALID'});
    return null;
  }
  return key;
}

function getAIConfig(res) {
  const provider=String(process.env.AI_PROVIDER||'openai').trim().toLowerCase();
  if(!Object.prototype.hasOwnProperty.call(providerProfiles,provider)){
    reply(res,503,{error:'AI 服务商配置无效，请网站管理员核对。',code:'AI_PROVIDER_INVALID'});
    return null;
  }
  const profile=providerProfiles[provider];
  const apiKey=getOpenAIKey(res,profile.keyEnv);
  if(!apiKey)return null;
  const model=String(process.env[profile.modelEnv]||profile.defaultModel).trim();
  if(profile.models&&!profile.models.includes(model)){
    reply(res,503,{error:'AI 模型配置无效，请网站管理员选择该服务商支持的模型。',code:'AI_MODEL_INVALID'});
    return null;
  }
  return {provider,profile,apiKey,model};
}

function getTTSConfig() {
  const aiProvider=String(process.env.AI_PROVIDER||'openai').trim().toLowerCase();
  const provider=String(process.env.TTS_PROVIDER||(aiProvider==='openai'?'openai':'none')).trim().toLowerCase();
  if(provider==='doubao'){
    const apiKey=normalizeSecret(process.env.DOUBAO_TTS_API_KEY);
    const voice=String(process.env.DOUBAO_TTS_VOICE||'ICL_uranus_en_male_alastor_tob').trim();
    if(!apiKey||!/^[A-Za-z0-9_-]{1,150}$/.test(voice))return null;
    return {provider,providerName:'豆包语音',apiKey,voice};
  }
  if(provider==='openai'){
    // A WAWA text key must never be reused for the official OpenAI speech service.
    const apiKey=normalizeSecret(process.env.OPENAI_TTS_API_KEY||(aiProvider==='openai'?process.env.OPENAI_API_KEY:''));
    if(!apiKey)return null;
    return {provider,providerName:'OpenAI',apiKey,model:process.env.OPENAI_TTS_MODEL||'gpt-4o-mini-tts'};
  }
  return null;
}

function publicCapabilities() {
  const provider=String(process.env.AI_PROVIDER||'openai').trim().toLowerCase();
  const providerName={wawazz:'WAWA ZZ',deepseek:'DeepSeek',openai:'OpenAI'}[provider]||'AI';
  const tts=getTTSConfig();
  return {providerName,audioAvailable:Boolean(tts),audioProviderName:tts?.providerName||null};
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
      method:'POST',redirect:'error',headers:{Authorization:`Bearer ${redisToken}`,'Content-Type':'application/json'},
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

function responseFailure(code) {
  const messages={
    AI_INCOMPLETE_RESPONSE:'AI 没有完成整份内容，请稍后重试。',
    AI_REFUSAL:'AI 暂未提供这份练习内容，请调整训练词后重试。',
    AI_EMPTY_RESPONSE:'AI 没有返回可用内容，请稍后重试。',
    AI_INVALID_RESPONSE:'AI 返回格式暂时无法读取，请重试。',
    AI_UPSTREAM_ERROR:'AI 服务暂未完成请求，请稍后重试。'
  };
  return {code,error:messages[code]||messages.AI_UPSTREAM_ERROR};
}

function parseResponsesStream(text) {
  let completed;
  let deltas='';
  let refusal=false;
  let terminalStatus;
  for(const line of text.split(/\r?\n/)){
    if(!line.startsWith('data:'))continue;
    const data=line.slice(5).trim();
    if(!data||data==='[DONE]')continue;
    let event;
    try{event=JSON.parse(data);}catch{throw responseFailure('AI_INVALID_RESPONSE');}
    if(event.type==='response.output_text.delta'&&typeof event.delta==='string')deltas+=event.delta;
    if(event.type==='response.refusal.delta'||event.type==='response.refusal.done')refusal=true;
    if(event.type==='response.completed')completed=event.response;
    if(event.type==='response.incomplete')terminalStatus='incomplete';
    if(event.type==='response.failed'||event.type==='error')terminalStatus='failed';
  }
  if(refusal)throw responseFailure('AI_REFUSAL');
  if(terminalStatus)throw responseFailure(terminalStatus==='incomplete'?'AI_INCOMPLETE_RESPONSE':'AI_UPSTREAM_ERROR');
  if(!completed)throw responseFailure('AI_INCOMPLETE_RESPONSE');
  if((!Array.isArray(completed.output)||completed.output.length===0)&&deltas){
    completed={...completed,output:[{type:'message',content:[{type:'output_text',text:deltas}]}]};
  }
  return completed;
}

function extractResponsesText(payload) {
  if(payload?.status==='incomplete')throw responseFailure('AI_INCOMPLETE_RESPONSE');
  if(payload?.status&&payload.status!=='completed')throw responseFailure('AI_UPSTREAM_ERROR');
  if(payload?.error)throw responseFailure('AI_UPSTREAM_ERROR');
  if(!Array.isArray(payload?.output))throw responseFailure('AI_EMPTY_RESPONSE');
  const texts=[];
  for(const item of payload.output){
    if(item?.type==='refusal')throw responseFailure('AI_REFUSAL');
    if(item?.type!=='message')continue;
    if(item.status==='incomplete')throw responseFailure('AI_INCOMPLETE_RESPONSE');
    if(item.status&&item.status!=='completed')throw responseFailure('AI_UPSTREAM_ERROR');
    if(item.refusal)throw responseFailure('AI_REFUSAL');
    for(const content of Array.isArray(item.content)?item.content:[]){
      if(content?.type==='refusal'||content?.refusal)throw responseFailure('AI_REFUSAL');
      if(content?.type==='output_text'&&typeof content.text==='string')texts.push(content.text);
    }
  }
  const text=texts.join('');
  if(!text.trim())throw responseFailure('AI_EMPTY_RESPONSE');
  return text;
}

async function openAI(req, res, body, config) {
  config=config||getAIConfig(res);
  if(!config)return {handled:true};
  const {provider,profile,apiKey,model}=config;
  const requestBody=profile.api==='responses'?{
    model,store:false,stream:false,instructions:body.system,input:body.user,
    max_output_tokens:body.maxOutputTokens||24000
  }:{
    model,messages:[{role:'system',content:body.system},{role:'user',content:body.user}],
    response_format:{type:'json_object'},max_tokens:body.maxTokens||15000,temperature:body.temperature??0.55
  };
  if(provider==='deepseek'){
    requestBody.max_tokens=body.maxOutputTokens||24000;
    requestBody.thinking={type:'disabled'};
    requestBody.stream=false;
  }
  let response,payload;
  try{
    response=await fetch(profile.endpoint,{
      method:'POST',redirect:'error',
      headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
      body:JSON.stringify(requestBody),signal:AbortSignal.timeout(body.timeoutMs||270000)
    });
    // Keep body consumption in the same timeout/error boundary as the request.
    const raw=await response.text();
    const eventStream=response.headers?.get?.('content-type')?.includes('text/event-stream');
    if(profile.api==='responses'&&response.ok&&(eventStream||/^\s*(?:event:|data:)/.test(raw)))payload=parseResponsesStream(raw);
    else{
      try{payload=JSON.parse(raw);}catch{
        if(response.ok)throw responseFailure('AI_INVALID_RESPONSE');
        payload={};
      }
    }
  }catch(error){
    const safe=['AI_INCOMPLETE_RESPONSE','AI_REFUSAL','AI_EMPTY_RESPONSE','AI_INVALID_RESPONSE','AI_UPSTREAM_ERROR'].includes(error?.code)?responseFailure(error.code):
      {error:'暂时无法连接 AI 服务，请稍后重试。',code:'AI_CONNECTION_FAILED'};
    reply(res,502,safe);
    return {handled:true};
  }
  if(!response.ok){replyAIError(res,response.status,payload);return {handled:true};}
  try{
    let content;
    if(profile.api==='responses')content=extractResponsesText(payload);
    else{
      const choice=payload.choices?.[0];
      if(choice?.finish_reason==='length')throw responseFailure('AI_INCOMPLETE_RESPONSE');
      if(choice?.message?.refusal||choice?.finish_reason==='content_filter')throw responseFailure('AI_REFUSAL');
      if(provider==='deepseek'&&choice?.finish_reason!=='stop')throw responseFailure('AI_INCOMPLETE_RESPONSE');
      content=choice?.message?.content;
      if(typeof content!=='string'||!content.trim())throw responseFailure('AI_EMPTY_RESPONSE');
    }
    const fenced=content.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
    const result=JSON.parse(fenced?fenced[1]:content);
    if(!result||typeof result!=='object'||Array.isArray(result))throw responseFailure('AI_INVALID_RESPONSE');
    return result;
  }catch(error){
    const code=['AI_INCOMPLETE_RESPONSE','AI_REFUSAL','AI_EMPTY_RESPONSE','AI_UPSTREAM_ERROR'].includes(error?.code)?error.code:'AI_INVALID_RESPONSE';
    reply(res,502,responseFailure(code));
    return {handled:true};
  }
}

const MAX_TTS_AUDIO_BYTES=3*1024*1024;

function ttsFailure(code, diagnostic) {
  const messages={
    TTS_NOT_CONFIGURED:'独立语音服务尚未配置完成，暂时不能生成音频。',
    TTS_UPSTREAM_ERROR:'语音服务暂未完成请求，请稍后重试。',
    TTS_INVALID_RESPONSE:'语音服务返回格式暂时无法读取，请稍后重试。',
    TTS_INCOMPLETE_RESPONSE:'语音服务未完整返回音频，请稍后重试。',
    TTS_EMPTY_RESPONSE:'语音服务没有返回可播放音频，请稍后重试。',
    TTS_AUDIO_TOO_LARGE:'本部分音频超过可传输大小，请网站管理员调整听力文本。',
    TTS_CONNECTION_FAILED:'暂时无法连接语音服务，请稍后重试。'
  };
  const failure={code,error:messages[code]||messages.TTS_UPSTREAM_ERROR};
  if(diagnostic)failure.diagnostic=diagnostic;
  return failure;
}

async function collectDoubaoAudio(response) {
  const reader=response.body?.getReader?.();
  if(!reader)throw ttsFailure('TTS_INVALID_RESPONSE','stream_missing');
  const decoder=new TextDecoder();
  const chunks=[];
  let pending='',audioBytes=0,wireBytes=0,finished=false;
  const maxLineChars=4*Math.ceil(MAX_TTS_AUDIO_BYTES/3)+65536;
  function consumeLine(line) {
    line=line.trim();
    if(!line)return;
    if(line.length>maxLineChars)throw ttsFailure('TTS_AUDIO_TOO_LARGE');
    let frame;
    try{frame=JSON.parse(line);}catch{throw ttsFailure('TTS_INVALID_RESPONSE','invalid_json');}
    if(!frame||typeof frame!=='object'||Array.isArray(frame))throw ttsFailure('TTS_INVALID_RESPONSE','invalid_frame');
    if(frame.code===20000000){finished=true;return;}
    if(frame.code!==0)throw ttsFailure('TTS_UPSTREAM_ERROR','upstream_error_frame');
    if(frame.data===undefined||frame.data==='')return;
    if(typeof frame.data!=='string'){
      const shape=Array.isArray(frame.data)?`array_${frame.data.length}`:frame.data===null?'null':typeof frame.data==='object'?`object_${Object.keys(frame.data).length}`:typeof frame.data;
      throw ttsFailure('TTS_INVALID_RESPONSE',`invalid_audio_data_type_${shape}`);
    }
    if(frame.data.length%4===1||!/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data))throw ttsFailure('TTS_INVALID_RESPONSE','invalid_audio_data_alphabet');
    if(frame.data.length>4*Math.ceil(MAX_TTS_AUDIO_BYTES/3))throw ttsFailure('TTS_AUDIO_TOO_LARGE');
    const encoded=frame.data.padEnd(Math.ceil(frame.data.length/4)*4,'=');
    const chunk=Buffer.from(encoded,'base64');
    if(!chunk.length||chunk.toString('base64')!==encoded)throw ttsFailure('TTS_INVALID_RESPONSE','invalid_audio_data_encoding');
    audioBytes+=chunk.length;
    if(audioBytes>MAX_TTS_AUDIO_BYTES)throw ttsFailure('TTS_AUDIO_TOO_LARGE');
    chunks.push(chunk);
  }
  try{
    while(!finished){
      const {value,done}=await reader.read();
      if(done){
        pending+=decoder.decode();
        if(pending)consumeLine(pending);
        break;
      }
      wireBytes+=value.byteLength;
      if(wireBytes>MAX_TTS_AUDIO_BYTES*2)throw ttsFailure('TTS_AUDIO_TOO_LARGE');
      pending+=decoder.decode(value,{stream:true});
      let newline;
      while(!finished&&(newline=pending.indexOf('\n'))!==-1){
        const line=pending.slice(0,newline);
        pending=pending.slice(newline+1);
        consumeLine(line);
      }
      if(!finished&&pending.length>maxLineChars)throw ttsFailure('TTS_AUDIO_TOO_LARGE');
    }
    if(audioBytes===0)throw ttsFailure('TTS_EMPTY_RESPONSE');
    return Buffer.concat(chunks,audioBytes);
  }finally{
    await reader.cancel().catch(()=>{});
  }
}

async function speechAudio(res, script, config) {
  let response,buffer;
  try{
    if(config.provider==='doubao'){
      response=await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional',{
        method:'POST',redirect:'error',
        headers:{'X-Api-Key':config.apiKey,'X-Api-Resource-Id':'seed-tts-2.0','X-Api-Request-Id':randomUUID(),'Content-Type':'application/json'},
        body:JSON.stringify({req_params:{text:script,speaker:config.voice,audio_params:{format:'mp3',sample_rate:24000},additions:JSON.stringify({explicit_language:'en'})}}),
        signal:AbortSignal.timeout(180000)
      });
      if(!response.ok)throw ttsFailure('TTS_UPSTREAM_ERROR','upstream_http_error');
      buffer=await collectDoubaoAudio(response);
    }else{
      response=await fetch('https://api.openai.com/v1/audio/speech',{
        method:'POST',redirect:'error',headers:{Authorization:`Bearer ${config.apiKey}`,'Content-Type':'application/json'},
        body:JSON.stringify({model:config.model,voice:'alloy',input:script,instructions:'Read clearly in a natural British English accent at a measured exam pace.',response_format:'mp3'}),
        signal:AbortSignal.timeout(120000)
      });
      if(!response.ok)throw ttsFailure('TTS_UPSTREAM_ERROR');
      buffer=Buffer.from(await response.arrayBuffer());
      if(!buffer.length)throw ttsFailure('TTS_EMPTY_RESPONSE');
      if(buffer.length>MAX_TTS_AUDIO_BYTES)throw ttsFailure('TTS_AUDIO_TOO_LARGE');
    }
    res.setHeader('Content-Type','audio/mpeg');
    res.setHeader('Cache-Control','no-store');
    return res.status(200).send(buffer);
  }catch(error){
    const codes=['TTS_UPSTREAM_ERROR','TTS_INVALID_RESPONSE','TTS_INCOMPLETE_RESPONSE','TTS_EMPTY_RESPONSE','TTS_AUDIO_TOO_LARGE'];
    const code=codes.includes(error?.code)?error.code:'TTS_CONNECTION_FAILED';
    if(config.provider==='doubao'){
      const contentType=response?.headers?.get?.('content-type')||null;
      console.warn('Doubao TTS request failed',JSON.stringify({code,diagnostic:error?.diagnostic||code,status:response?.status||null,contentType}));
    }
    return reply(res,502,ttsFailure(code));
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, {error: '仅支持 POST 请求。'});
  const body = req.body || {};
  if(body.action==='capabilities')return reply(res,200,publicCapabilities());
  if (body.action === 'generate') {
    if (!validWords(body.words)) return reply(res, 400, {error: '请先导入 1 到 100 个有效训练词。'});
    const config=getAIConfig(res);
    if(!config)return;
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
    },config);
    if (result?.handled) return;
    const chart=result.writing?.task1?.chart;
    if (!result.listening?.parts || result.listening.parts.length !== 4 || result.listening.parts.some((part,index) => !part.title || !part.script || !validQuestions(part.questions,index*10+1)) ||
        !validReading(result.reading) ||
        !result.writing?.task1?.prompt || !result.writing?.task2?.prompt || !Array.isArray(chart?.categories)||chart.categories.length<4||!Array.isArray(chart?.series)||chart.series.length<2||chart.series.some(series=>!Array.isArray(series.values)||series.values.length!==chart.categories.length) ||
        !Array.isArray(result.speaking?.part1) || result.speaking.part1.length<4 || result.speaking.part1.length>5 || !result.speaking?.part2?.cueCard || !Array.isArray(result.speaking?.part3) || result.speaking.part3.length<4 || result.speaking.part3.length>5) {
      return reply(res, 502, {error: '生成结果没有达到完整试卷结构，请重试。'});
    }
    return reply(res, 200, {date: input.date, generatedAt: new Date().toISOString(),...publicCapabilities(),paper: result});
  }
  if (body.action === 'grade-writing') {
    if (!['task1', 'task2'].includes(body.task) || typeof body.response !== 'string' || body.response.trim().length < 40 || body.response.length > 25000 || typeof body.prompt !== 'string' || body.prompt.length > 3000) {
      return reply(res, 400, {error: '请提交至少 40 个字符、且不超过 25,000 个字符的作文。'});
    }
    const config=getAIConfig(res);
    if(!config)return;
    const allowed=await rateLimit(req,'grade');
    if(allowed===null)return reply(res,503,{error:'练习服务尚未配置安全的访问限额。'});
    if(!allowed)return reply(res,429,{error:'评分请求较多，请一小时后再试。'});
    const result = await openAI(req, res, {
      system: gradePrompt,
      user: JSON.stringify({task: body.task, prompt: body.prompt, response: body.response}),
      maxTokens: 2500,
      maxOutputTokens: 4000,
      timeoutMs: 60000,
      temperature: 0.2
    },config);
    if (result?.handled) return;
    return reply(res, 200, {feedback: result});
  }
  if (body.action === 'audio') {
    if (typeof body.script !== 'string' || body.script.trim().length < 20 || body.script.length > 8000) return reply(res, 400, {error: '听力文本长度无效。'});
    const config=getTTSConfig();
    if(!config)return reply(res,503,ttsFailure('TTS_NOT_CONFIGURED'));
    const allowed=await rateLimit(req,'audio');
    if(allowed===null)return reply(res,503,{error:'练习服务尚未配置安全的访问限额。'});
    if(!allowed)return reply(res,429,{error:'音频生成请求过多，请明天再试。'});
    return speechAudio(res,body.script,config);
  }
  return reply(res, 400, {error: '不支持的操作。'});
};
