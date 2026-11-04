const {createHash,randomUUID} = require('node:crypto');

const practiceBase = `Create original IELTS Academic practice at approximately Band 7 level. Never claim it is an official IELTS paper or copy remembered test material. Use supplied vocabulary naturally where it fits. Return valid JSON only. Keep answers and explanations out of learner-facing prompts.`;

const listeningScriptPrompt = `${practiceBase} Create exactly one complete IELTS Listening script with this shape: {"title":"","scenario":"","script":""}. Write a natural dialogue or monologue of 750-950 words, at most 8000 characters, appropriate to the specified part. Develop the topic fully with concrete details, corrections, comparisons and plausible distractors for a separate set of ten questions. Do not include questions or answers in the output. Before returning, count the words and expand any draft shorter than 750 words.`;

const listeningQuestionsPrompt = `${practiceBase} Create exactly 10 IELTS Listening questions for the supplied script with this shape: {"questions":[{"number":1,"format":"text|choice","prompt":"","options":[],"answer":"","acceptedAnswers":[],"explanation":""}]}. Use the supplied sequential number range. Use form/note completion, multiple choice and short answer. Do not use TRUE/FALSE/NOT GIVEN or YES/NO/NOT GIVEN; these are Reading formats. For choice use 3 options and make answer exactly match the correct option. Every question needs an unambiguous answer and concise explanation. State a clear word limit for text-answer questions. Base answers on the script and order questions to follow it. Return questions only; do not repeat the script.`;

const readingPassagePrompt = `${practiceBase} Create one original IELTS Academic reading passage. Output exactly this shape: {"passage":{"id":"P1","title":"","text":""}}. Passage text must contain 650-900 words. Use the supplied passage ID. Develop a coherent academic argument or explanation with enough specific evidence for a separate reading question set. Return the passage only.`;

const readingQuestionsPrompt = `${practiceBase} Create IELTS Academic reading questions for the supplied passage. Output exactly this shape: {"questions":[{"number":1,"passageId":"P1","format":"text|choice|tfng","prompt":"","options":[],"answer":"","acceptedAnswers":[],"explanation":"","evidence":""}]}. Create exactly the requested question count and number range, all linked to the supplied passage ID. Use a mix of TRUE/FALSE/NOT GIVEN, multiple choice and short/sentence completion. For choice/tfng include 3 options and make answer exactly one option; provide acceptable variants for text answers. Every item must be answerable from the passage and include a short evidence quote. Do not repeat the passage in the output.`;

const writingSpeakingPrompt = `${practiceBase} Create original IELTS Academic Writing Task 1 and Task 2 prompts plus Speaking Parts 1-3. Output exactly this shape: {"writing":{"task1":{"prompt":"","chart":{"title":"","categories":["","","",""],"series":[{"name":"","values":[1,2,3,4]},{"name":"","values":[4,3,2,1]}]}},"task2":{"prompt":""}},"speaking":{"part1":[""],"part2":{"cueCard":""},"part3":[""]}}. Task 1 must describe a coherent visual with at least four categories and at least two numeric series, and its prompt must match the data. Task 2 must be an answerable discussion or argument prompt. Speaking Part 1 and Part 3 need 4-5 questions each; Part 2 needs a cue card with 3-4 bullets and a final explain question. Part 3 should extend the Part 2 topic into broader analysis.`;

const gradePrompt = `Evaluate the supplied IELTS Academic writing response as cautious practice feedback, not an official score. Return JSON only with this shape: {"taskResponse":number,"coherenceCohesion":number,"lexicalResource":number,"grammarAccuracy":number,"overallEstimate":number,"strengths":[string],"priorities":[string],"sentenceCorrections":[{"original":string,"revision":string,"reason":string}],"feedback":string}. Scores must be half bands from 0 to 9. Cite evidence from the response. For Task 1, assess task achievement; for Task 2, assess task response. State when the response is too short to assess reliably. Write strengths, priorities, correction reasons, and feedback in simplified Chinese; keep quoted original sentences, revised sentences, and the exam prompt in English.`;

// DeepSeek's current API alias deepseek-flash serves DeepSeek-V4.1-Flash-1017.
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

const generationReservationScript=`
local operation=ARGV[1]
local token=ARGV[2]
if operation=='reserve' then
  if redis.call('EXISTS',KEYS[2])==1 then return 0 end
  if redis.call('SET',KEYS[1],token,'NX','EX',ARGV[3]) then return 1 end
  return 0
end
if redis.call('GET',KEYS[1])~=token then return -1 end
if operation=='commit' then
  redis.call('SET',KEYS[2],'1','EX',ARGV[3])
  redis.call('DEL',KEYS[1])
  return 1
end
redis.call('DEL',KEYS[1])
return 1
`;

function generationQuotaKeys(req) {
  const forwarded=req.headers['x-forwarded-for'];
  const ip=typeof forwarded==='string'?forwarded.split(',')[0].trim():'unknown';
  const hash=createHash('sha256').update(ip).digest('hex').slice(0,24);
  const day=new Date().toISOString().slice(0,10);
  const base=`ielts:generate:v2:${hash}:${day}`;
  return {pending:`${base}:pending`,used:`${base}:used`};
}

async function generationReservation(req, operation, reservation) {
  const redisUrl=process.env.UPSTASH_REDIS_REST_URL;
  const redisToken=process.env.UPSTASH_REDIS_REST_TOKEN;
  if(!redisUrl||!redisToken)return null;
  const keys=operation==='reserve'?generationQuotaKeys(req):reservation?.keys;
  const reservationToken=operation==='reserve'?randomUUID():reservation?.token;
  if(!keys||!reservationToken)return null;
  const args=operation==='reserve'
    ?['reserve',reservationToken,'360']
    :operation==='commit'?['commit',reservationToken,'86400']
      :['release',reservationToken];
  const command=['EVAL',generationReservationScript,'2',keys.pending,keys.used,...args];
  try{
    const response=await fetch(`${redisUrl.replace(/\/$/,'')}/pipeline`,{
      method:'POST',redirect:'error',headers:{Authorization:`Bearer ${redisToken}`,'Content-Type':'application/json'},
      body:JSON.stringify([command]),signal:AbortSignal.timeout(5000)
    });
    if(!response.ok)return null;
    const result=await response.json();
    if(!Array.isArray(result)||result.length!==1||!result[0]||result[0].error)return null;
    const outcome=result[0].result;
    if(!Number.isSafeInteger(outcome))return null;
    if(operation==='reserve')return outcome===1?{token:reservationToken,keys}:outcome===0?false:null;
    return outcome===1;
  }catch{return null;}
}

function validWords(words) {
  return Array.isArray(words) && words.length >= 1 && words.length <= 100 && words.every(item =>
    item && typeof item.word === 'string' && item.word.trim().length > 0 && item.word.length <= 120 &&
    (item.meaning === undefined || typeof item.meaning === 'string')
  );
}

function validQuestionSet(questions, firstNumber, count) {
  return Array.isArray(questions) && questions.length === count && questions.every((question,index) =>
    question && question.number === firstNumber + index && typeof question.prompt === 'string' && question.prompt.trim() &&
    typeof question.answer === 'string' && question.answer.trim() && typeof question.explanation === 'string' &&
    ['text','choice','tfng'].includes(question.format) &&
    (question.format === 'text' || Array.isArray(question.options) && question.options.length >= 3 && question.options.includes(question.answer))
  );
}

function validQuestions(questions, firstNumber) { return validQuestionSet(questions,firstNumber,10); }

function wordCount(value) { return (String(value||'').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)||[]).length; }

function validReading(reading) {
  if(!Array.isArray(reading?.passages)||reading.passages.length!==3||!Array.isArray(reading.questions)||reading.questions.length!==40)return false;
  if(reading.passages.some(passage=>!passage||typeof passage.id!=='string'||typeof passage.title!=='string'||typeof passage.text!=='string'))return false;
  const passageIds=reading.passages.map(passage=>passage.id);
  const totalWords=reading.passages.reduce((sum,passage)=>sum+wordCount(passage.text),0);
  if(new Set(passageIds).size!==3||reading.passages.some(passage=>!passage.title||!passage.text)||totalWords<1900||totalWords>2800)return false;
  return reading.questions.every((question,index)=>question&&question.number===index+1&&typeof question.prompt==='string'&&question.prompt.trim()&&typeof question.answer==='string'&&question.answer.trim()&&typeof question.explanation==='string'&&question.explanation.trim()&&typeof question.evidence==='string'&&question.evidence.trim()&&
    ['text','choice','tfng'].includes(question.format)&&passageIds.includes(question.passageId)&&
    (question.format==='text'||Array.isArray(question.options)&&question.options.length>=3&&question.options.includes(question.answer)));
}

function moduleIssues(module, value) {
  if(module.kind==='listening-script'){
    const issues=[];
    if(typeof value?.title!=='string'||!value.title.trim()||typeof value?.scenario!=='string'||!value.scenario.trim()||typeof value?.script!=='string')issues.push('part_content');
    else {
      if(wordCount(value.script)<550)issues.push(`script_too_short:${wordCount(value.script)}_words;minimum_550_target_750_to_950`);
      if(value.script.length>8000)issues.push(`script_too_long:${value.script.length}_characters;maximum_8000`);
    }
    return issues;
  }
  if(module.kind==='listening-questions'){
    const issues=[];
    if(!validQuestions(value?.questions,module.firstNumber))issues.push(`question_count_or_format:${Array.isArray(value?.questions)?value.questions.length:0}`);
    else if(value.questions.some(question=>question.format==='tfng'))issues.push('listening_format_must_be_text_or_choice');
    return issues;
  }
  if(module.kind==='reading'){
    const passage=value?.passage;
    const issues=[];
    if(!passage||passage.id!==module.passageId||typeof passage.title!=='string'||!passage.title.trim()||typeof passage.text!=='string'||wordCount(passage.text)<650||wordCount(passage.text)>900)issues.push(`passage_content_or_length:${passage?wordCount(passage.text):0}`);
    return issues;
  }
  if(module.kind==='reading-questions'){
    const issues=[];
    if(!validQuestionSet(value?.questions,module.firstNumber,module.count))issues.push(`question_count_or_format:${Array.isArray(value?.questions)?value.questions.length:0}`);
    else if(value.questions.some(question=>question.passageId!==module.passageId||typeof question.evidence!=='string'||!question.evidence.trim()))issues.push('question_link_or_evidence');
    return issues;
  }
  const writing=value?.writing;
  const speaking=value?.speaking;
  const task1=writing?.task1;
  const chart=task1?.chart;
  const issues=[];
  if(typeof task1?.prompt!=='string'||!task1.prompt.trim()||typeof writing?.task2?.prompt!=='string'||!writing.task2.prompt.trim()||!Array.isArray(chart?.categories)||chart.categories.length<4||chart.categories.some(category=>typeof category!=='string'||!category.trim())||!Array.isArray(chart?.series)||chart.series.length<2||chart.series.some(series=>!series||typeof series.name!=='string'||!series.name.trim()||!Array.isArray(series.values)||series.values.length!==chart.categories.length||series.values.some(value=>typeof value!=='number'||!Number.isFinite(value))))issues.push('writing_tasks_or_chart');
  if(!Array.isArray(speaking?.part1)||speaking.part1.length<4||speaking.part1.length>5||speaking.part1.some(question=>typeof question!=='string'||!question.trim())||typeof speaking?.part2?.cueCard!=='string'||!speaking.part2.cueCard.trim()||!Array.isArray(speaking?.part3)||speaking.part3.length<4||speaking.part3.length>5||speaking.part3.some(question=>typeof question!=='string'||!question.trim()))issues.push('speaking_parts');
  return issues;
}

function paperStructureIssues(paper) {
  const issues=[];
  const parts=paper?.listening?.parts;
  if(!Array.isArray(parts)||parts.length!==4)issues.push(`listening_parts:${Array.isArray(parts)?parts.length:0}`);
  else parts.forEach((part,index)=>{
    if(!part?.title||!part?.script)issues.push(`listening_part_${index+1}_content`);
    if(!validQuestions(part?.questions,index*10+1))issues.push(`listening_part_${index+1}_questions:${Array.isArray(part?.questions)?part.questions.length:0}`);
  });
  const reading=paper?.reading;
  if(!Array.isArray(reading?.passages)||reading.passages.length!==3)issues.push(`reading_passages:${Array.isArray(reading?.passages)?reading.passages.length:0}`);
  if(!Array.isArray(reading?.questions)||reading.questions.length!==40)issues.push(`reading_questions:${Array.isArray(reading?.questions)?reading.questions.length:0}`);
  else if(!validReading(reading))issues.push('reading_content_or_question_validation');
  const task1=paper?.writing?.task1;
  const chart=task1?.chart;
  if(typeof task1?.prompt!=='string'||!task1.prompt.trim()||typeof paper?.writing?.task2?.prompt!=='string'||!paper.writing.task2.prompt.trim()||!Array.isArray(chart?.categories)||chart.categories.length<4||!Array.isArray(chart?.series)||chart.series.length<2||chart.series.some(series=>!series||!Array.isArray(series.values)||series.values.length!==chart.categories.length))issues.push('writing_tasks_or_chart');
  const speaking=paper?.speaking;
  if(!Array.isArray(speaking?.part1)||speaking.part1.length<4||speaking.part1.length>5||speaking.part1.some(question=>typeof question!=='string'||!question.trim())||typeof speaking?.part2?.cueCard!=='string'||!speaking.part2.cueCard.trim()||!Array.isArray(speaking?.part3)||speaking.part3.length<4||speaking.part3.length>5||speaking.part3.some(question=>typeof question!=='string'||!question.trim()))issues.push('speaking_parts');
  return issues;
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

async function openAI(req, res, body, config, deferErrors=false) {
  const fail=(status,payload)=>{
    if(deferErrors)return {handled:true,failure:{status,body:payload}};
    reply(res,status,payload);
    return {handled:true};
  };
  config=config||getAIConfig(res);
  if(!config)return {handled:true};
  const {provider,profile,apiKey,model}=config;
  const requestBody=profile.api==='responses'?{
    model,store:false,stream:false,instructions:body.system,input:body.user,
    max_output_tokens:body.maxOutputTokens||24000
  }:{
    model,messages:[{role:'system',content:body.system},{role:'user',content:body.user}],
    response_format:{type:'json_object'},max_tokens:body.maxTokens||body.maxOutputTokens||15000,temperature:body.temperature??0.55
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
    return fail(502,safe);
  }
  if(!response.ok){
    if(deferErrors){
      const temporary={setHeader(){},status(status){this.statusCode=status;return this;},json(body){this.body=body;return this;}};
      replyAIError(temporary,response.status,payload);
      return {handled:true,failure:{status:temporary.statusCode,body:temporary.body}};
    }
    replyAIError(res,response.status,payload);
    return {handled:true};
  }
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
    return fail(502,responseFailure(code));
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
    if(frame.data===undefined||frame.data===null||frame.data==='')return;
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
    const reservation=await generationReservation(req,'reserve');
    if(reservation===null)return reply(res,503,{error:'练习服务尚未配置安全的访问限额。'});
    if(reservation===false)return reply(res,429,{error:'此网络今天已生成过一套练习，或已有生成任务正在进行。'});
    const input = {
      date: typeof body.date === 'string' ? body.date.slice(0, 10) : '',
      targetBand: 7,
      vocabulary: body.words.map(item => ({word: item.word.trim(), meaning: String(item.meaning || '').slice(0, 240)}))
    };
    const modules=[];
    for(let index=0;index<4;index++){
      const part=index+1,firstNumber=index*10+1;
      const partInstruction=part===1?'Part 1 is a two-person everyday conversation with form or note completion.':part===2?'Part 2 is one speaker describing a social situation, often with a map or process.':part===3?'Part 3 is an academic discussion between students and/or a tutor.':'Part 4 is a single-speaker academic lecture with note completion.';
      modules.push({name:`listening_part_${part}`,kind:'listening-script',part,firstNumber,maxOutputTokens:4000,system:`${listeningScriptPrompt} ${partInstruction}`,user:JSON.stringify({module:{kind:'listening-script',part},...input})});
    }
    const readingCounts=[13,13,14];
    let firstReadingQuestion=1;
    for(let index=0;index<3;index++){
      const passageId=`P${index+1}`,count=readingCounts[index],firstNumber=firstReadingQuestion;
      firstReadingQuestion+=count;
      const passageInstruction=index===0?'Use a concrete science, environment, or design topic.':index===1?'Use a distinct topic in history, society, or education.':'Use a distinct topic in policy, technology, or research.';
      modules.push({name:`reading_${passageId}`,kind:'reading',passageId,maxOutputTokens:4000,system:`${readingPassagePrompt} ${passageInstruction}`,user:JSON.stringify({module:{kind:'reading',passageId},...input})});
    }
    modules.push({name:'writing_speaking',kind:'writing-speaking',maxOutputTokens:6500,system:writingSpeakingPrompt,user:JSON.stringify({module:{kind:'writing-speaking'},...input})});

    async function generateModule(module) {
      const run=async(issues,retry=false)=>openAI(req,res,{
        system:issues.length?`${module.system} A previous response for this module failed these checks: ${issues.join(', ')}. Regenerate this module and satisfy them exactly.`:module.system,
        user:module.user,
        maxOutputTokens:module.maxOutputTokens,
        timeoutMs:retry?45000:90000
      },config,true);
      try{
        let generated=await run([]);
        let retried=false;
        if(generated?.handled){
          const code=generated.failure?.body?.code;
          if(!['AI_INVALID_RESPONSE','AI_INCOMPLETE_RESPONSE'].includes(code))return {failure:generated.failure||{status:502,body:{error:'AI 服务暂未完成请求，请稍后重试。',code:'AI_UPSTREAM_ERROR'}}};
          generated=await run([`response_format:${code}`],true);
          retried=true;
          if(generated?.handled)return {failure:generated.failure||{status:502,body:{error:'AI 服务暂未完成请求，请稍后重试。',code:'AI_UPSTREAM_ERROR'}}};
        }
        let issues=moduleIssues(module,generated);
        if(issues.length&&!retried){
          console.warn('Generated IELTS module failed structure checks',JSON.stringify({module:module.name,issues}));
          generated=await run(issues,true);
          retried=true;
          if(generated?.handled)return {failure:generated.failure||{status:502,body:{error:'AI 服务暂未完成请求，请稍后重试。',code:'AI_UPSTREAM_ERROR'}}};
          issues=moduleIssues(module,generated);
        }
        return issues.length?{module:module.name,issues}:{value:generated};
      }catch{
        return {failure:{status:502,body:{error:'AI 练习模块生成失败，请稍后重试。',code:'AI_MODULE_GENERATION_FAILED'}}};
      }
    }

    async function finishFailedModules(generatedModules) {
      const failedModule=generatedModules.find(item=>item.failure);
      const invalidModule=generatedModules.find(item=>item.issues);
      if(!failedModule&&!invalidModule)return null;
      if(invalidModule)console.warn('IELTS module retry failed structure checks',JSON.stringify({module:invalidModule.module,issues:invalidModule.issues}));
      const released=await generationReservation(req,'release',reservation);
      if(released!==true)return {status:503,body:{error:'生成没有完成，暂时无法确认名额已释放；请稍后再试。',code:'GENERATION_QUOTA_RELEASE_FAILED'}};
      if(failedModule)return failedModule.failure;
      return {status:502,body:{error:'部分题目模块经过修复后仍不完整，今日名额已释放，可以稍后重试。',code:'AI_PAPER_STRUCTURE_INVALID'}};
    }
    const firstModules=await Promise.all(modules.map(generateModule));
    const firstFailure=await finishFailedModules(firstModules);
    if(firstFailure)return reply(res,firstFailure.status,firstFailure.body);
    const firstValues=firstModules.map(item=>item.value);
    const passages=firstValues.slice(4,7).map(item=>item.passage);
    const questionCounts=[13,13,14];
    let firstNumber=1;
    const questionModules=passages.map((passage,index)=>{
      const count=questionCounts[index];
      const module={name:`reading_questions_${passage.id}`,kind:'reading-questions',passageId:passage.id,firstNumber,count,maxOutputTokens:7000,system:readingQuestionsPrompt,user:JSON.stringify({module:{kind:'reading-questions',passageId:passage.id,firstNumber,count},passage,...input})};
      firstNumber+=count;
      return module;
    });
    const listeningQuestionModules=firstValues.slice(0,4).map((part,index)=>{
      const firstNumber=index*10+1;
      return {name:`listening_questions_${index+1}`,kind:'listening-questions',part:index+1,firstNumber,maxOutputTokens:6000,system:listeningQuestionsPrompt,user:JSON.stringify({module:{kind:'listening-questions',part:index+1,firstNumber,count:10},script:part.script,...input})};
    });
    const generatedQuestions=await Promise.all([...listeningQuestionModules,...questionModules].map(generateModule));
    const questionFailure=await finishFailedModules(generatedQuestions);
    if(questionFailure)return reply(res,questionFailure.status,questionFailure.body);
    const values=generatedQuestions.map(item=>item.value);
    // The UI renders a table, so derive its instruction from the validated data
    // instead of trusting a separate model-written count or chart description.
    const task1=firstValues[7].writing.task1;
    task1.prompt=`The table below compares ${task1.chart.series.map(series=>series.name).join(' and ')} across the categories shown.\n\nSummarise the information by selecting and reporting the main features, and make comparisons where relevant.\n\nYou should write at least 150 words.`;
    const result={
      listening:{parts:firstValues.slice(0,4).map((part,index)=>({...part,questions:values[index].questions}))},
      reading:{passages,questions:values.slice(4).flatMap(item=>item.questions)},
      ...firstValues[7]
    };
    const issues=paperStructureIssues(result);
    if(issues.length){
      console.warn('Combined IELTS modules failed final checks',JSON.stringify(issues));
      const released=await generationReservation(req,'release',reservation);
      if(released!==true)return reply(res,503,{error:'生成结果未通过最终检查，暂时无法确认名额已释放；请稍后再试。',code:'GENERATION_QUOTA_RELEASE_FAILED'});
      return reply(res,502,{error:'生成结果未通过最终完整性检查，今日名额已释放，可以稍后重试。',code:'AI_PAPER_STRUCTURE_INVALID'});
    }
    const committed=await generationReservation(req,'commit',reservation);
    if(committed!==true)return reply(res,503,{error:'试卷已生成，但暂时无法确认保存今日名额，请稍后刷新状态。',code:'GENERATION_QUOTA_COMMIT_FAILED'});
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
