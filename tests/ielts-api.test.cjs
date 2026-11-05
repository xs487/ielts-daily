const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'ielts.js'), 'utf8');
const fakeOpenAIKey = 'sk-test-never-a-real-secret';
const fakeDeepSeekKey = 'sk-deepseek-test-never-a-real-secret';
const fakeDoubaoKey = 'doubao-test-never-a-real-secret';
const fakeRedisToken = 'upstash-test-never-a-real-secret';
const doubaoEndpoint = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const mockMp3 = Buffer.from('ID3mock-british-english-audio');

function response(status, body, contentType = 'application/json', chunkSize = 8192) {
  const streamBytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: name => name.toLowerCase() === 'content-type' ? contentType : null},
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    arrayBuffer: async () => Buffer.from('mock-audio'),
    body: {getReader() {
      let offset = 0;
      return {
        async read() {
          if (offset >= streamBytes.length) return {done: true};
          const value = streamBytes.subarray(offset, offset + chunkSize);
          offset += value.length;
          return {done: false, value};
        },
        async cancel() { offset = streamBytes.length; },
        releaseLock() {}
      };
    }}
  };
}

// Original synthetic fixtures: each answer is grounded in a distinct, ordered
// sentence. These are test data, not external exam passages or questions.
const fixtureFacts = [
  ['car park', 'At the first stop, visitors should use the car park beside the entrance.'],
  ['city library', 'At the second stop, the city library hosts the event in meeting room 24.'],
  ['student-led', 'At the third stop, the student-led workshop takes place in meeting room 24.'],
  ['24', 'At the fourth stop, meeting room 24 is reserved for the briefing.'],
  ['research centre', 'At the fifth stop, the university research centre uses meeting room 24 for interviews.'],
  ['city library', 'At the sixth stop, the central city library provides documents for visitors.'],
  ['meeting room', 'At the seventh stop, participants gather in meeting room 24 after lunch.'],
  ['bicycles', 'At the eighth stop, bicycles can be hired from the reception desk.'],
  ['gardens', 'At the ninth stop, the gardens are open until sunset.'],
  ['tickets', 'At the tenth stop, tickets for the student-led tour identify the car park, the central city library, meeting room 24 and the university research centre.'],
  ['volunteers', 'At the eleventh stop, volunteers explain how the equipment works.'],
  ['records', 'At the twelfth stop, records are stored in a secure cabinet.'],
  ['feedback', 'At the thirteenth stop, feedback about the student-led tour covers the car park, the central city library, meeting room 24 and the university research centre.'],
  ['maps', 'At the fourteenth stop, maps are available beside the exit.']
];

function fixtureText(count, prefix) {
  const facts = fixtureFacts.slice(0, count).map(([, sentence]) => sentence).join(' ');
  const context = `${prefix} This original research exercise describes a community learning route. Its organisers compare the observations carefully before drawing conclusions. `;
  const words = `${context}${facts}`.split(/\s+/);
  const filler = 'Researchers document the route so that other teams can evaluate the same procedures independently'.split(' ');
  while (words.length < 750) words.push(filler[(words.length - 1) % filler.length]);
  return words.join(' ');
}

function fixtureQuestion(number, index, passageId) {
  const [answer, evidence] = fixtureFacts[index];
  return {
    number,
    ...(passageId ? {passageId} : {}),
    format: 'text',
    prompt: `Write NO MORE THAN THREE WORDS. Complete the detail for stop ${index + 1} in ${passageId || 'the tour'}.`,
    answer,
    acceptedAnswers: [],
    explanation: '定位该站点的描述，答案直接出现在引文中；复习时应核对名词词形。',
    evidence,
    evidenceStatus: 'supported',
    skill: 'detail',
    distractorNotes: []
  };
}

function makePaper() {
  const listening = {parts: Array.from({length: 4}, (_, partIndex) => ({
    title: `Part ${partIndex + 1}`,
    scenario: 'A practice scenario',
    script: fixtureText(10, `Listening part ${partIndex + 1}.`),
    questions: Array.from({length: 10}, (_, index) => fixtureQuestion(partIndex * 10 + index + 1, index))
  }))};
  const reading = {
    passages: ['P1', 'P2', 'P3'].map(id => ({
      id,
      title: `Passage ${id}`,
      text: fixtureText(id === 'P3' ? 14 : 13, `Passage ${id}.`)
    })),
    questions: Array.from({length: 40}, (_, index) => {
      const passage = index < 13 ? 1 : index < 26 ? 2 : 3;
      return fixtureQuestion(index + 1, index - [0, 0, 13, 26][passage], `P${passage}`);
    })
  };
  return {
    listening,
    reading,
    writing: {
      task1: {
        prompt: 'Summarise the information.',
        chart: {title: 'Survey', categories: ['A', 'B', 'C', 'D'], series: [
          {name: 'Group A', values: [1, 2, 3, 4]},
          {name: 'Group B', values: [4, 3, 2, 1]}
        ]}
      },
      task2: {prompt: 'Discuss both views and give your opinion.'}
    },
    speaking: {
      part1: ['Question 1', 'Question 2', 'Question 3', 'Question 4'],
      part2: {cueCard: 'Describe a useful skill.\n- What it is\n- How you learned it\n- Why it matters\nExplain how it changed you.'},
      part3: ['Question 1', 'Question 2', 'Question 3', 'Question 4']
    }
  };
}

function makeAiGate() {
  let markStarted;
  let unblock;
  const started = new Promise(resolve => { markStarted = resolve; });
  const blocked = new Promise(resolve => { unblock = resolve; });
  return {
    started,
    release: unblock,
    async enter() {
      markStarted();
      await blocked;
    }
  };
}

function makeDeepSeekModule(module, payload = {}) {
  const paper = makePaper();
  if (module?.kind === 'listening-script') {
    const part = paper.listening.parts[Number(module.part) - 1];
    return {title: part.title, scenario: part.scenario, script: part.script};
  }
  if (module?.kind === 'listening-questions') {
    const questions = paper.listening.parts[Number(module.part) - 1].questions;
    const choices = module.part === 2 ? 4 : module.part === 3 ? 6 : 0;
    questions.slice(0, choices).forEach(question => makeChoice(question, false));
    return {questions};
  }
  if (module?.kind === 'reading') {
    const passage = paper.reading.passages.find(item => item.id === module.passageId);
    return {passage};
  }
  if (module?.kind === 'reading-questions') {
    const firstNumber = Number(module.firstNumber);
    const count = Number(module.count);
    const questions = Array.from({length: count}, (_, index) => ({
        ...paper.reading.questions[firstNumber - 1 + index],
        number: firstNumber + index,
        passageId: module.passageId
      }));
    questions.slice(0, 5).forEach((question, index) => makeJudgment(question, ['TRUE', 'FALSE', 'NOT GIVEN'][index % 3]));
    questions.slice(5, 9).forEach(question => makeChoice(question, true));
    return {questions};
  }
  if (module?.kind === 'writing-speaking') return {writing: paper.writing, speaking: paper.speaking};
  return paper;
}

function makeGradeFixture(overrides = {}) {
  return {
    taskResponse: 7, coherenceCohesion: 7, lexicalResource: 7, grammarAccuracy: 7,
    overallEstimate: 7, strengths: ['表达清晰。'], priorities: ['补充具体论据。'],
    sentenceCorrections: [], feedback: '这是练习反馈；请结合任务要求补充论证。',
    ...overrides
  };
}

function createHarness({redisMode = 'ok', aiStatus = 200, aiStatusSequence = [], paperSequence = [], gradeFeedback = makeGradeFixture(), aiGate, reservationModes = {}, deepseekModuleOverrides = {}, openAIKey = fakeOpenAIKey, provider, envOverrides = {}, wawaMode = 'completed', deepseekMode = 'stop', doubaoMode = 'completed', ttsStatus = 200, random} = {}) {
  const calls = [];
  const reservationCalls = [];
  const reservationState = new Map();
  const moduleCalls = [];
  const moduleAttempts = new Map();
  let aiRequestCount = 0;
  function moduleContext(userContent) {
    let payload;
    try { payload = JSON.parse(userContent); } catch {}
    const module = payload?.module || null;
    const key = module?.kind === 'listening-script' ? `listening-script-${module.part}`
      : module?.kind === 'listening-questions' ? `listening-questions-${module.part}`
      : module?.kind === 'reading' ? `reading-${module.passageId}`
        : module?.kind === 'reading-questions' ? `reading-questions-${module.passageId}`
        : module?.kind === 'writing-speaking' ? 'writing-speaking' : null;
    if (!key) return {module, key: null, attempt: 0};
    const attempt = (moduleAttempts.get(key) || 0) + 1;
    moduleAttempts.set(key, attempt);
    moduleCalls.push({key, module, attempt,
      passage: payload?.passage ? {id: payload.passage.id, words: String(payload.passage.text || '').trim().split(/\s+/).length} : null,
      script: typeof payload?.script === 'string' ? {
        words: payload.script.trim().split(/\s+/).length,
        hash: createHash('sha256').update(payload.script).digest('hex')
      } : null
    });
    return {module, payload, key, attempt, override: deepseekModuleOverrides[key]?.[attempt - 1]};
  }
  const env = {
    OPENAI_API_KEY: openAIKey,
    UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
    UPSTASH_REDIS_REST_TOKEN: fakeRedisToken
  };
  if (provider !== undefined) env.AI_PROVIDER = provider;
  Object.assign(env, envOverrides);
  const sandbox = {
    ...(random ? {Math: Object.assign(Object.create(Math), {random})} : {}),
    Buffer,
    TextDecoder,
    AbortSignal,
    Date,
    URL,
    process: {env},
    require: name => {
      assert.equal(name, 'node:crypto');
      return {createHash, randomUUID};
    },
    module: {exports: {}},
    fetch: async (url, options = {}) => {
      calls.push({url, options});
      if (url.startsWith('https://redis.example.test/')) {
        const commands = JSON.parse(options.body);
        if (commands?.length === 1 && commands[0]?.[0] === 'EVAL') {
          const [name, , keyCount, pendingKey, usedKey, operation, token] = commands[0];
          assert.equal(name, 'EVAL');
          assert.equal(keyCount, '2');
          reservationCalls.push({operation, pendingKey, usedKey, token, ttl: commands[0][7]});
          const mode = reservationModes[operation];
          const evalResult = value => response(200, [{result: value}]);
          if (redisMode === 'http-error') return response(503, {});
          if (redisMode === 'throw') throw new Error('mock Redis unavailable');
          if (redisMode === 'bad-shape') return response(200, {result: 1});
          if (redisMode === 'command-error') return response(200, [{error: 'ERR EVAL failed'}]);
          if (redisMode === 'bad-count') return evalResult('not-a-counter');
          if (redisMode === 'null-count') return evalResult(null);
          if (redisMode === 'string-count') return evalResult('1');
          if (redisMode === 'zero-count' || redisMode === 'over-limit') return evalResult(0);
          if (redisMode === 'expiry-not-set') return evalResult(-2);
          if (mode === 'http-error') return response(503, {});
          if (mode === 'throw' || mode === 'throw-before') throw new Error('mock reservation request outcome unknown');
          if (mode === 'bad-shape') return response(200, {result: 1});
          if (mode === 'bad-result') return response(200, [{result: '1'}]);
          const pending = reservationState.get(pendingKey);
          const used = reservationState.get(usedKey);
          const initialPending = pending;
          const initialUsed = used;
          let outcome;
          if (operation === 'reserve') {
            if (used || pending) outcome = 0;
            else {
              reservationState.set(pendingKey, token);
              outcome = 1;
            }
          } else if (pending !== token) outcome = -1;
          else if (operation === 'commit') {
            reservationState.delete(pendingKey);
            reservationState.set(usedKey, '1');
            outcome = 1;
          } else {
            reservationState.delete(pendingKey);
            outcome = 1;
          }
          if (mode === 'throw-after' || mode === 'throw-after-apply') throw new Error('mock reservation result lost after applying script');
          if (mode === 'throw-before-apply') {
            if (initialPending === undefined) reservationState.delete(pendingKey);
            else reservationState.set(pendingKey, initialPending);
            if (initialUsed === undefined) reservationState.delete(usedKey);
            else reservationState.set(usedKey, initialUsed);
            throw new Error('mock reservation result lost before applying script');
          }
          if (mode === 'return-zero') return evalResult(0);
          if (mode === 'return-negative') return evalResult(-1);
          if (mode === 'invalid-shape') return response(200, [{error: 'script failed'}]);
          return evalResult(outcome);
        }
        if (redisMode === 'http-error') return response(503, {});
        if (redisMode === 'throw') throw new Error('mock Redis unavailable');
        if (redisMode === 'bad-shape') return response(200, {result: 1});
        if (redisMode === 'command-error') return response(200, [
          {result: 1}, {error: 'ERR cannot set expiry'}
        ]);
        if (redisMode === 'over-limit') return response(200, [{result: 99}, {result: 1}]);
        if (redisMode === 'bad-count') return response(200, [{result: 'not-a-counter'}, {result: 1}]);
        if (redisMode === 'null-count') return response(200, [{result: null}, {result: 1}]);
        if (redisMode === 'string-count') return response(200, [{result: '1'}, {result: 1}]);
        if (redisMode === 'zero-count') return response(200, [{result: 0}, {result: 1}]);
        if (redisMode === 'expiry-not-set') return response(200, [{result: 1}, {result: 0}]);
        assert.ok(Array.isArray(commands) && commands.length === 2);
        assert.ok(commands.every(Array.isArray));
        assert.equal(commands[0][0], 'INCR');
        assert.equal(commands[1][0], 'EXPIRE');
        assert.equal(typeof commands[0][1], 'string');
        assert.equal(typeof commands[1][2], 'number');
        assert.equal(commands[0][1], commands[1][1]);
        return response(200, [{result: 1}, {result: 1}]);
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        if (aiGate) await aiGate.enter();
        const request = JSON.parse(options.body);
        const userContent = request.messages.find(message => message.role === 'user')?.content || '';
        const isGrading = request.messages[0].content.includes('Evaluate the supplied IELTS');
        const {module, payload, key, override} = moduleContext(userContent);
        const currentStatus = override?.status ?? aiStatusSequence[aiRequestCount] ?? aiStatus;
        const currentPaper = paperSequence[aiRequestCount];
        aiRequestCount++;
        if (currentStatus !== 200) return response(currentStatus, {error: {message: `failure includes ${fakeOpenAIKey}`}});
        const content = isGrading ? gradeFeedback
          : override && Object.prototype.hasOwnProperty.call(override, 'content') ? override.content
            : override && Object.prototype.hasOwnProperty.call(override, 'value') ? JSON.stringify(override.value)
              : key ? JSON.stringify(makeDeepSeekModule(module, payload)) : currentPaper ?? paper;
        return response(200, {choices: [{message: {content: typeof content === 'string' ? content : JSON.stringify(content)}}]});
      }
      if (url === 'https://api.openai.com/v1/audio/speech') return response(200, {});
      if (url === doubaoEndpoint) {
        if (doubaoMode === 'network-error') throw new Error(`speech transport failure includes ${fakeDoubaoKey}`);
        if (ttsStatus !== 200) return response(ttsStatus, {code: 45000000, message: `speech error includes ${fakeDoubaoKey} and ${fakeDeepSeekKey}`});
        const event = value => `${JSON.stringify(value)}\n`;
        const chunk1 = {code: 0, data: mockMp3.subarray(0, 8).toString('base64')};
        const chunk2 = {code: 0, data: mockMp3.subarray(8).toString('base64')};
        const complete = {code: 20000000, message: 'OK'};
        if (doubaoMode === 'missing-terminal') return response(200, event(chunk1) + event(chunk2), 'application/x-ndjson');
        if (doubaoMode === 'error-terminal') return response(200, event(chunk1) + event({code: 45000000, message: `speech error includes ${fakeDoubaoKey}`}), 'application/x-ndjson');
        if (doubaoMode === 'empty') return response(200, event(complete), 'application/x-ndjson');
        if (doubaoMode === 'invalid-base64') return response(200, event({code: 0, data: '%%%invalid-base64%%% '}) + event(complete), 'application/x-ndjson');
        if (doubaoMode === 'noncanonical-base64') return response(200, event({code: 0, data: 'YR=='}) + event(complete), 'application/x-ndjson');
        if (doubaoMode === 'invalid-json') return response(200, '{broken-ndjson\n', 'application/x-ndjson');
        if (doubaoMode === 'unpadded-base64') {
          const unpadded1 = {...chunk1, data: chunk1.data.replace(/=+$/, '')};
          const unpadded2 = {...chunk2, data: chunk2.data.replace(/=+$/, '')};
          return response(200, event(unpadded1) + event(unpadded2) + event(complete), 'text/plain');
        }
        if (doubaoMode === 'null-audio-frame') return response(200, event({code: 0, data: null}) + event(chunk1) + event(chunk2) + event(complete), 'text/plain');
        if (doubaoMode === 'oversized') return response(200, event({code: 0, data: Buffer.alloc(4 * 1024 * 1024 + 1, 65).toString('base64')}) + event(complete), 'application/x-ndjson');
        if (doubaoMode === 'aggregate-oversized') {
          const largeChunk = event({code: 0, data: Buffer.alloc(2 * 1024 * 1024, 65).toString('base64')});
          return response(200, largeChunk + largeChunk + event(complete), 'application/x-ndjson');
        }
        if (doubaoMode === 'body-error') {
          const mockResponse = response(200, '', 'application/x-ndjson');
          mockResponse.body.getReader = () => ({
            async read() { throw new Error(`body failure includes ${fakeDoubaoKey}`); },
            async cancel() {}, releaseLock() {}
          });
          return mockResponse;
        }
        return response(200, event(chunk1) + '\n' + event(chunk2) + event(complete), 'application/x-ndjson', doubaoMode === 'chunked' ? 7 : 8192);
      }
      if (url === 'https://api.deepseek.com/chat/completions') {
        if (aiGate) await aiGate.enter();
        const currentStatus = aiStatusSequence[aiRequestCount] ?? aiStatus;
        const currentPaper = paperSequence[aiRequestCount];
        aiRequestCount++;
        const request = JSON.parse(options.body);
        const isGrading = request.messages[0].content.includes('Evaluate the supplied IELTS');
        const userContent = request.messages.find(message => message.role === 'user')?.content || '';
        const {module, payload: modulePayload, key: moduleKey, override} = moduleContext(userContent);
        if (deepseekMode === 'network-error' || override?.networkError) throw new Error(`transport failure includes ${fakeDeepSeekKey}`);
        const status = override?.status ?? currentStatus;
        if (status !== 200) return response(status, {error: {
          message: `failure includes ${fakeDeepSeekKey} and ${fakeOpenAIKey}`,
          ...(override?.errorCode ? {code: override.errorCode} : {})
        }});
        const content = deepseekMode === 'reasoning-only' ? '' : deepseekMode === 'invalid-json' ? '{broken-json'
          : isGrading ? JSON.stringify(gradeFeedback)
            : override && Object.prototype.hasOwnProperty.call(override, 'content') ? override.content
              : override && Object.prototype.hasOwnProperty.call(override, 'value') ? JSON.stringify(override.value)
                : moduleKey ? JSON.stringify(makeDeepSeekModule(module, modulePayload))
                  : JSON.stringify(currentPaper ?? paper);
        const choice = {
          message: {content, reasoning_content: JSON.stringify({overallEstimate: 1, secret: fakeDeepSeekKey})},
          finish_reason: override?.finishReason ?? (deepseekMode === 'missing-finish' ? undefined : ['length', 'content_filter', 'tool_calls', 'error', 'aborted', 'insufficient_system_resource'].includes(deepseekMode) ? deepseekMode : 'stop')
        };
        return response(200, {choices: [choice]});
      }
      if (url === 'https://wawazz.xyz/v1/responses') {
        if (aiGate) await aiGate.enter();
        const request = JSON.parse(options.body);
        const isGrading = JSON.stringify([request.input, request.instructions]).includes('Evaluate the supplied IELTS');
        const userContent = typeof request.input === 'string' ? request.input : JSON.stringify(request.input);
        const {module, payload, key, override} = moduleContext(userContent);
        const currentStatus = override?.status ?? aiStatusSequence[aiRequestCount] ?? aiStatus;
        const currentPaper = paperSequence[aiRequestCount];
        aiRequestCount++;
        if (currentStatus !== 200) return response(currentStatus, {error: {message: `failure includes ${fakeOpenAIKey}`}});
        const content = isGrading ? JSON.stringify(gradeFeedback)
          : override && Object.prototype.hasOwnProperty.call(override, 'content') ? override.content
            : JSON.stringify(override && Object.prototype.hasOwnProperty.call(override, 'value') ? override.value : key ? makeDeepSeekModule(module, payload) : currentPaper ?? paper);
        const output = [
          {type: 'reasoning', id: 'rs_mock', summary: []},
          {type: 'message', role: 'assistant', content: [{type: 'output_text', text: content}]}
        ];
        if (wawaMode === 'refusal') output[1].content = [{type: 'refusal', refusal: `Cannot answer ${fakeOpenAIKey}`}];
        if (wawaMode === 'failed') return response(200, {status: 'failed', error: {message: `failure includes ${fakeOpenAIKey}`}, output});
        if (wawaMode.startsWith('sse-')) {
          const sseEvent = value => `data: ${JSON.stringify(value)}\n\n`;
          const eventType = wawaMode === 'sse-incomplete' ? 'response.incomplete'
            : wawaMode === 'sse-failed' ? 'response.failed' : 'response.completed';
          return response(200,
            sseEvent({type: 'response.reasoning_text.delta', delta: `ignored reasoning ${fakeOpenAIKey}`}) +
            sseEvent({type: 'response.output_text.delta', delta: content}) +
            sseEvent({type: eventType, response: {status: eventType.slice('response.'.length)}}) +
            'data: [DONE]\n\n',
            'text/event-stream');
        }
        return response(200, {status: wawaMode === 'incomplete' ? 'incomplete' : 'completed', output});
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  };
  const paper = makePaper();
  vm.runInNewContext(source, sandbox, {filename: 'api/ielts.js'});
  const handler = sandbox.module.exports;
  const req = body => ({method: 'POST', headers: {'x-forwarded-for': '192.0.2.10'}, body});
  const res = () => ({
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; }
  });
  async function invoke(body) {
    const result = res();
    await handler(req(body), result);
    return result;
  }
  return {calls, env, handler, invoke, req, res, reservationCalls, reservationState, deepseekModuleCalls: moduleCalls};
}

const vocab = [{word: 'resilient', meaning: 'able to recover'}];

function phraseMatcher() {
  const sandbox = {module: {exports: {}}, require};
  vm.runInNewContext(source, sandbox, {filename: 'api/ielts.js'});
  return sandbox.containsPhrase;
}

test('evidence matching rejects numeric fragments of decimals, thousands, times, fractions and ranges', () => {
  const containsPhrase = phraseMatcher();
  for (const [material, fragment] of [
    ['The measurement is 1.5 metres.', '1'],
    ['The measurement is 1.5 metres.', '5'],
    ['The budget is 15,000 pounds.', '15'],
    ['The budget is 15,000 pounds.', '000'],
    ['The event starts at 09:30.', '09'],
    ['The event starts at 09:30.', '30'],
    ['The fraction is 3/4.', '3'],
    ['The fraction is 3/4.', '4'],
    ['The period is 2019-2024.', '2019'],
    ['The period is 2019-2024.', '2024'],
    ['Use room 1.5 for the meeting.', 'room 1'],
    ['The temperature is -1 degrees.', '1'],
    ['The change is +1 metre.', '1']
  ]) assert.equal(containsPhrase(material, fragment), false, `${fragment} is only part of ${material}`);
});

test('evidence matching accepts complete numbers and ordinary sentence punctuation', () => {
  const containsPhrase = phraseMatcher();
  for (const value of ['1.5', '15,000', '09:30', '3/4', '2019-2024', '1', '5', '-1', '+1']) {
    assert.equal(containsPhrase(`The recorded value is ${value}.`, value), true, value);
  }
  assert.equal(containsPhrase('Use room 1. Then leave by the stairs.', 'room 1'), true);
  assert.equal(containsPhrase('The recorded value is １．５ metres.', '1.5'), true);
});

test('evidence matching continues past numeric fragments to a later complete occurrence', () => {
  const containsPhrase = phraseMatcher();
  assert.equal(containsPhrase('The draft was 1.5 metres; the final figure is 1 metre.', '1'), true);
  assert.equal(containsPhrase('Originally 15,000 pounds, the fee is now 15 pounds.', '15'), true);
});

function qualityModule(kind = 'reading-questions', part = 1) {
  return kind === 'reading-questions'
    ? makeDeepSeekModule({kind, passageId: 'P1', firstNumber: 1, count: 13})
    : makeDeepSeekModule({kind, part, firstNumber: (part - 1) * 10 + 1, count: 10});
}

function makeChoice(question, reading = true) {
  const correctAnswer = question.answer;
  const options = [correctAnswer, 'unavailable alternative', 'rejected alternative', ...(reading ? ['unmentioned alternative'] : [])];
  Object.assign(question, {
    format: 'choice', prompt: `Which detail is stated for checkpoint question ${question.number}?`,
    answer: options[0], acceptedAnswers: [], options,
    distractorNotes: options.slice(1).map(option => ({option, reason: '该地点未被指定为停车地点；题目要求定位第一站的明确指示。'}))
  });
}

function makeJudgment(question, answer = 'TRUE') {
  Object.assign(question, {
    format: 'tfng',
    prompt: answer === 'TRUE' ? `The supplied description for checkpoint question ${question.number} is accurate.`
      : answer === 'FALSE' ? `The event at checkpoint question ${question.number} takes place at a railway station.`
        : `The location in checkpoint question ${question.number} has two hundred parking spaces.`,
    options: ['TRUE', 'FALSE', 'NOT GIVEN'], answer, acceptedAnswers: [], distractorNotes: [],
    evidenceStatus: {TRUE: 'supported', FALSE: 'contradicted', 'NOT GIVEN': 'not_given'}[answer],
    skill: answer === 'NOT GIVEN' ? 'information_absence' : 'fact_check',
    explanation: answer === 'NOT GIVEN' ? '原文给出了停车位置，但没有给出车位数量，因此无法确认也无法否认两百个车位。' : '把题干的停车地点与原文第一站的指示对照判断。'
  });
}

for (const [kind, reading] of [['reading-questions', true], ['listening-questions', false]]) {
  const key = reading ? 'reading-questions-P1' : 'listening-questions-1';
  test(`${kind} accepts grounded questions with the correct multiple-choice option count`, async () => {
    const value = qualityModule(kind, 2);
    makeChoice(value.questions[reading ? 5 : 0], reading);
    const h = deepseekHarness({deepseekModuleOverrides: {[reading ? key : 'listening-questions-2']: [{value}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 15);
  });

  for (const [name, mutate] of [
    ['invented evidence', value => { value.questions[0].evidence = 'The guide tells everyone to visit the castle on Mars.'; }],
    ['answer not in quoted evidence', value => { value.questions[0].answer = 'castle'; }],
    ['duplicate question prompts', value => { value.questions[1].prompt = value.questions[0].prompt; }],
    ['empty explanation', value => { value.questions[0].explanation = ' '; }],
    ['unknown skill', value => { value.questions[0].skill = 'invented_skill'; }],
    ['non-array answer alternatives', value => { value.questions[0].acceptedAnswers = {answer: 'car park'}; }],
    ['non-string answer alternative', value => { value.questions[0].acceptedAnswers = [24]; }],
    ['empty answer alternative', value => { value.questions[0].acceptedAnswers = ['']; }],
    ['duplicate choice options', value => { makeChoice(value.questions[0], reading); value.questions[0].options[1] = value.questions[0].options[0]; }],
    ['wrong choice option count', value => { makeChoice(value.questions[0], reading); value.questions[0].options.pop(); }],
    ['choice accepting a wrong alternative', value => { makeChoice(value.questions[0], reading); value.questions[0].acceptedAnswers = ['railway station']; }],
    ['unsupported evidence status', value => { value.questions[0].evidenceStatus = 'contradicted'; }]
  ]) {
    test(`${kind} rejects ${name}, repairs only that module, and commits the replacement`, async () => {
      const choiceCase = /choice|distractor/.test(name);
      const value = qualityModule(kind, choiceCase ? 2 : 1);
      const target = choiceCase ? value.questions[reading ? 5 : 0] : value.questions.at(-1);
      mutate({questions: [target, value.questions[reading ? 1 : 2]]});
      const targetKey = !reading && choiceCase ? 'listening-questions-2' : key;
      const h = deepseekHarness({deepseekModuleOverrides: {[targetKey]: [{value}]}});
      const result = await h.invoke({action: 'generate', words: vocab});
      assert.equal(result.statusCode, 200);
      assert.equal(h.deepseekModuleCalls.length, 16);
      assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === targetKey).map(call => call.attempt), [1, 2]);
      assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit']);
    });
  }

  for (const [name, notes, expected] of [
    ['omitted', undefined, []],
    ['non-array', {option: 'unavailable alternative', reason: 'Not the stated location.'}, []],
    ['partially missing', [{option: 'unavailable alternative', reason: 'Not the stated location.'}], [{option: 'unavailable alternative', reason: 'Not the stated location.'}]],
    ['malformed and duplicate', [null, 'invalid', {}, {option: 'car park', reason: 'This is the correct answer.'}, {option: 'invented option', reason: 'Unknown option.'}, {option: 'rejected alternative', reason: ' '}, {option: 'unavailable alternative', reason: 'Not the stated location.'}, {option: 'unavailable alternative', reason: 'Duplicate reason.'}], [{option: 'unavailable alternative', reason: 'Not the stated location.'}]]
  ]) {
    test(`${kind} accepts ${name} distractor reasons and retains only valid unique notes`, async () => {
      const value = qualityModule(kind, 2);
      const target = value.questions[reading ? 5 : 0];
      makeChoice(target, reading);
      target.distractorNotes = notes;
      const targetKey = reading ? key : 'listening-questions-2';
      const h = deepseekHarness({deepseekModuleOverrides: {[targetKey]: [{value}]}});
      const result = await h.invoke({action: 'generate', words: vocab});
      assert.equal(result.statusCode, 200);
      assert.equal(h.deepseekModuleCalls.length, 15);
      assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === targetKey).map(call => call.attempt), [1]);
      const returned = reading ? result.body.paper.reading.questions[5] : result.body.paper.listening.parts[1].questions[0];
      assert.deepEqual(JSON.parse(JSON.stringify(returned.distractorNotes)), expected);
      assert.equal(returned.explanation, target.explanation);
    });
  }

  test(`${kind} repeated fabricated evidence rejects the paper and releases the quota`, async () => {
    const value = qualityModule(kind);
    value.questions[0].evidence = 'The guide tells everyone to visit the castle on Mars.';
    const h = deepseekHarness({deepseekModuleOverrides: {[key]: [{value}, {value}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.code, 'AI_PAPER_STRUCTURE_INVALID');
    assert.equal(result.body.paper, undefined);
    assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);
    assert.equal(h.reservationState.has(h.reservationCalls[0].usedKey), false);
  });
}

for (const answer of ['TRUE', 'FALSE', 'NOT GIVEN']) {
  test(`reading accepts ${answer} with matching evidence semantics metadata`, async () => {
    const value = qualityModule();
    makeJudgment(value.questions[0], answer);
    const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P1': [{value}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 15);
  });
}

for (const [name, mutate] of [
  ['nonstandard judgment options', q => { q.options = ['TRUE', 'FALSE', 'UNKNOWN']; }],
  ['FALSE without contradiction metadata', q => { q.answer = 'FALSE'; q.evidenceStatus = 'not_given'; }],
  ['NOT GIVEN pretending the quote proves the statement', q => { q.answer = 'NOT GIVEN'; q.evidenceStatus = 'supported'; }]
]) {
  test(`reading repairs ${name}`, async () => {
    const value = qualityModule();
    makeJudgment(value.questions[0]);
    mutate(value.questions[0]);
    const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P1': [{value}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 16);
  });
}

test('listening sorts grounded questions by evidence and renumbers without regenerating', async () => {
  const value = qualityModule('listening-questions');
  value.questions.reverse();
  value.questions.forEach((question, index) => { question.number = index + 1; });
  const h = deepseekHarness({deepseekModuleOverrides: {'listening-questions-1': [{value}]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(h.deepseekModuleCalls.length, 15);
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'listening-questions-1').map(call => call.attempt), [1]);
  const questions = result.body.paper.listening.parts[0].questions;
  assert.deepEqual(Array.from(questions, question => question.number), Array.from({length: 10}, (_, index) => index + 1));
  assert.deepEqual(Array.from(questions, question => question.answer), fixtureFacts.slice(0, 10).map(([answer]) => answer));
  assert.match(questions[0].prompt, /stop 1/);
  assert.match(questions[9].prompt, /stop 10/);
});

test('listening allows mixed question formats in script order and keeps equal evidence stable', async () => {
  const value = qualityModule('listening-questions', 2);
  value.questions[0] = fixtureQuestion(11, 0);
  value.questions[4].evidence = value.questions[3].evidence;
  value.questions[4].answer = value.questions[3].answer;
  makeChoice(value.questions[4], false);
  const originals = value.questions.map(question => ({prompt: question.prompt, answer: question.answer, format: question.format}));
  value.questions = [value.questions[9], ...value.questions.slice(0, 9)];
  value.questions.forEach((question, index) => { question.number = 11 + index; });
  const h = deepseekHarness({deepseekModuleOverrides: {'listening-questions-2': [{value}]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(h.deepseekModuleCalls.length, 15);
  const returned = result.body.paper.listening.parts[1].questions;
  assert.deepEqual(Array.from(returned, question => question.number), Array.from({length: 10}, (_, index) => 11 + index));
  assert.deepEqual(Array.from(returned, question => question.format), originals.map(question => question.format));
  assert.deepEqual(Array.from(returned, question => question.answer), originals.map(question => question.answer));
  assert.equal(returned[3].prompt, originals[3].prompt);
  assert.equal(returned[4].prompt, originals[4].prompt);
});

function questionContent(question) {
  const {number, options, ...content} = question;
  return JSON.parse(JSON.stringify({...content, ...(options ? {options: [...options].sort()} : {})}));
}

test('reading sorts reversed choice and completion groups without moving passages or regenerating', async () => {
  const value = makeDeepSeekModule({kind: 'reading-questions', passageId: 'P2', firstNumber: 14, count: 13});
  const originals = value.questions.map(questionContent);
  value.questions = [...value.questions.slice(0, 5), ...value.questions.slice(5, 9).reverse(), ...value.questions.slice(9).reverse()];
  value.questions.forEach((question, index) => { question.number = 14 + index; });
  const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P2': [{value}]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(h.deepseekModuleCalls.length, 15);
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'reading-questions-P2').map(call => call.attempt), [1]);
  const reading = result.body.paper.reading;
  assert.deepEqual(Array.from(reading.questions, question => question.number), Array.from({length: 40}, (_, index) => index + 1));
  assert.deepEqual(Array.from(reading.questions, question => question.passageId), [...Array(13).fill('P1'), ...Array(13).fill('P2'), ...Array(14).fill('P3')]);
  assert.deepEqual(Array.from(reading.questions.slice(13, 26), questionContent), originals);
  assert.deepEqual(JSON.parse(JSON.stringify(reading.passages)), makePaper().reading.passages);
});

test('reading preserves equal-evidence order and never sorts a completion into another format group', async () => {
  const value = qualityModule();
  const questions = value.questions;
  questions[7].evidence = questions[6].evidence;
  questions[7].answer = questions[6].answer;
  makeChoice(questions[7]);
  questions[11].evidence = questions[10].evidence;
  questions[11].answer = questions[10].answer;
  questions[9] = fixtureQuestion(10, 0, 'P1');
  const expected = [...questions.slice(0, 5), questions[5], questions[7], questions[6], questions[8], questions[9], questions[11], questions[10], questions[12]].map(questionContent);
  value.questions = [...questions.slice(0, 5), ...questions.slice(5, 9).reverse(), ...questions.slice(9).reverse()];
  value.questions.forEach((question, index) => { question.number = index + 1; });
  const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P1': [{value}]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(h.deepseekModuleCalls.length, 15);
  const returned = result.body.paper.reading.questions.slice(0, 13);
  assert.deepEqual(Array.from(returned, questionContent), expected);
  assert.deepEqual(Array.from(returned, question => question.number), Array.from({length: 13}, (_, index) => index + 1));
  assert.deepEqual(Array.from(returned, question => question.format), [...Array(5).fill('tfng'), ...Array(4).fill('choice'), ...Array(4).fill('text')]);
});

test('reading keeps judgment questions and their standard options in input order despite reversed evidence', async () => {
  const value = qualityModule();
  value.questions = [...value.questions.slice(0, 5).reverse(), ...value.questions.slice(5)];
  value.questions.forEach((question, index) => { question.number = index + 1; });
  const expected = value.questions.slice(0, 5).map(questionContent);
  const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P1': [{value}]}, random: () => 0});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(h.deepseekModuleCalls.length, 15);
  const returned = result.body.paper.reading.questions.slice(0, 5);
  assert.deepEqual(Array.from(returned, questionContent), expected);
  for (const question of returned) assert.deepEqual(Array.from(question.options), ['TRUE', 'FALSE', 'NOT GIVEN']);
});

for (const [kind, reading] of [['reading-questions', true], ['listening-questions', false]]) {
  test(`${kind} shuffles choices while preserving the option set, answer and distractor explanations`, async () => {
    const value = qualityModule(kind, 2);
    const originals = value.questions.filter(question => question.format === 'choice').map(question => {
      question.distractorNotes.forEach((note, index) => { note.reason = `This alternative is excluded by source detail ${index + 1}.`; });
      return questionContent(question);
    });
    const h = deepseekHarness({
      deepseekModuleOverrides: {[reading ? 'reading-questions-P1' : 'listening-questions-2']: [{value}]},
      random: () => 0
    });
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 15);
    const questions = reading ? result.body.paper.reading.questions.slice(0, 13) : result.body.paper.listening.parts[1].questions;
    const returned = Array.from(questions).filter(question => question.format === 'choice');
    assert.deepEqual(returned.map(questionContent), originals);
    for (const question of returned) {
      assert.notEqual(question.options[0], question.answer);
      assert.equal(question.options.filter(option => option === question.answer).length, 1);
    }
  });
}

test('reading repairs a passage below 700 words before writing its questions', async () => {
  const value = makeDeepSeekModule({kind: 'reading', passageId: 'P1'});
  value.passage.text = value.passage.text.split(/\s+/).slice(0, 699).join(' ');
  const h = deepseekHarness({deepseekModuleOverrides: {'reading-P1': [{value}]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(h.deepseekModuleCalls.length, 16);
  assert.equal(h.deepseekModuleCalls.find(call => call.key === 'reading-questions-P1').passage.words, 750);
});

function resizedReadingPassage(id, words) {
  const passage = makeDeepSeekModule({kind: 'reading', passageId: id}).passage;
  const tokens = passage.text.split(/\s+/);
  const filler = 'Independent observers recorded additional measurements across the route'.split(' ');
  while (tokens.length < words) tokens.push(filler[tokens.length % filler.length]);
  passage.text = tokens.slice(0, words).join(' ');
  return passage;
}

for (const words of [700, 924, 1000]) {
  test(`reading accepts an original ${words}-word passage when the total remains in range`, async () => {
    const passage = resizedReadingPassage('P1', words);
    const h = deepseekHarness({deepseekModuleOverrides: {'reading-P1': [{value: {passage}}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 15);
    assert.equal(result.body.paper.reading.passages[0].text.trim().split(/\s+/).length, words);
    assert.equal(result.body.paper.reading.passages.reduce((sum, item) => sum + item.text.trim().split(/\s+/).length, 0), words + 1500);
  });
}

for (const words of [700, 1000]) {
  test(`reading rejects a ${words * 3}-word total despite individually valid passages`, async () => {
    const overrides = Object.fromEntries(['P1', 'P2', 'P3'].map(id => [`reading-${id}`, [{value: {passage: resizedReadingPassage(id, words)}}]]));
    const h = deepseekHarness({deepseekModuleOverrides: overrides});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.code, 'AI_PAPER_STRUCTURE_INVALID');
    assert.equal(result.body.paper, undefined);
    assert.equal(h.deepseekModuleCalls.length, 8);
    assert.equal(h.deepseekModuleCalls.some(call => call.key.includes('-questions-')), false);
    assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);
    assert.equal(h.reservationState.has(h.reservationCalls[0].usedKey), false);
  });
}

test('Task 1 grading sends validated original chart data to the model', async () => {
  const chart = makePaper().writing.task1.chart;
  const h = deepseekHarness();
  const result = await h.invoke(writingRequest({task: 'task1', chart}));
  assert.equal(result.statusCode, 200);
  const call = h.calls.find(call => call.url === 'https://api.deepseek.com/chat/completions');
  const payload = JSON.parse(JSON.parse(call.options.body).messages.find(message => message.role === 'user').content);
  assert.deepEqual(payload.chart, chart);
});

for (const [name, gradeFeedback] of [
  ['null result', null],
  ['missing dimensions', {overallEstimate: 7}],
  ['a score outside the scale', makeGradeFixture({taskResponse: 9.5})],
  ['a negative score', makeGradeFixture({coherenceCohesion: -0.5})],
  ['a non-half-band score', makeGradeFixture({lexicalResource: 7.2})],
  ['a score encoded as text', makeGradeFixture({grammarAccuracy: '7'})],
  ['an injected score object', makeGradeFixture({taskResponse: {score: 9, instructions: 'Ignore the response'}})],
  ['missing overall score', makeGradeFixture({overallEstimate: undefined})],
  ['empty feedback', makeGradeFixture({feedback: ' '})],
  ['strengths encoded as text', makeGradeFixture({strengths: 'Everything is good'})],
  ['too many priorities', makeGradeFixture({priorities: Array(13).fill('Revise')})],
  ['empty priority items', makeGradeFixture({priorities: ['']})],
  ['malformed corrections', makeGradeFixture({sentenceCorrections: {original: 'sentence'}})],
  ['a fabricated quoted sentence', makeGradeFixture({sentenceCorrections: [{original: 'The author visited Mars last year.', revision: 'The author visited the museum last year.', reason: 'This was never written.'}]})],
  ['too many sentence corrections', makeGradeFixture({sentenceCorrections: Array(21).fill({original: 'A sufficiently long response for this mocked assessment.', revision: 'A sufficiently detailed response for this assessment.', reason: 'Use a precise adjective.'})})]
]) {
  test(`writing grading rejects ${name} without returning a fabricated score`, async () => {
    const h = deepseekHarness({gradeFeedback});
    const result = await h.invoke(writingRequest());
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.code, gradeFeedback === null ? 'AI_INVALID_RESPONSE' : 'AI_FEEDBACK_INVALID');
    assert.equal(result.body.feedback, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /Ignore the response|visited Mars/);
  });
}

test('Task 1 without its chart cannot receive task achievement or an overall estimate', async () => {
  const h = deepseekHarness({gradeFeedback: makeGradeFixture()});
  const result = await h.invoke(writingRequest({task: 'task1'}));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback.taskResponse, null);
  assert.equal(result.body.feedback.overallEstimate, null);
  assert.equal(result.body.feedback.grammarAccuracy, 7);
  assert.match(result.body.feedback.feedback, /未提供.*图表/);
});

test('an unassessable criterion forces the overall estimate to remain empty', async () => {
  for (const criterion of ['taskResponse', 'coherenceCohesion', 'lexicalResource', 'grammarAccuracy']) {
    const h = deepseekHarness({gradeFeedback: makeGradeFixture({[criterion]: null, overallEstimate: 9})});
    const result = await h.invoke(writingRequest());
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.feedback[criterion], null);
    assert.equal(result.body.feedback.overallEstimate, null);
  }
});

test('writing grading preserves verified sentence corrections and strips extra provider properties', async () => {
  const original = 'A sufficiently long response for this mocked assessment.';
  const correction = {original, revision: 'A sufficiently detailed response for this assessment.', reason: '选择更准确的形容词。'};
  const h = deepseekHarness({gradeFeedback: makeGradeFixture({
    sentenceCorrections: [{...correction, injected: 'must not be returned'}],
    unexpected: 'must not be returned'
  })});
  const result = await h.invoke(writingRequest({response: original}));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(result.body.feedback.sentenceCorrections)), [correction]);
  assert.equal(result.body.feedback.unexpected, undefined);
  assert.doesNotMatch(JSON.stringify(result.body), /must not be returned/);
});

test('client-supplied grades cannot override validated model feedback', async () => {
  const h = deepseekHarness({gradeFeedback: makeGradeFixture()});
  const result = await h.invoke(writingRequest({taskResponse: 9, overallEstimate: 9, feedback: {overallEstimate: 9}}));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback.taskResponse, 7);
  assert.equal(result.body.feedback.overallEstimate, 7);
});

for (const [name, mutate] of [
  ['missing numeric data', chart => { chart.series[0].values = ['one', 2, 3, 4]; }],
  ['mismatched category count', chart => { chart.series[0].values = [1]; }],
  ['invalid category type', chart => { chart.categories[0] = {}; }],
  ['excessive chart size', chart => { chart.categories = Array(1000).fill('large'); chart.series.forEach(series => { series.values = Array(1000).fill(1); }); }]
]) {
  test(`Task 1 rejects ${name} before spending quota or calling the model`, async () => {
    const chart = makePaper().writing.task1.chart;
    mutate(chart);
    const h = deepseekHarness();
    const result = await h.invoke(writingRequest({task: 'task1', chart}));
    assert.equal(result.statusCode, 400);
    assert.equal(h.calls.length, 0);
  });
}

test('generation reserves and commits an atomic Upstash Lua slot before returning a complete paper', async () => {
  const h = createHarness();
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit']);
  const [reserve, commit] = h.reservationCalls;
  assert.match(reserve.pendingKey, /^ielts:generate:v2:[a-f0-9]{24}:\d{4}-\d{2}-\d{2}:pending$/);
  assert.equal(reserve.usedKey, reserve.pendingKey.replace(/:pending$/, ':used'));
  assert.equal(reserve.ttl, '360');
  assert.equal(commit.pendingKey, reserve.pendingKey);
  assert.equal(commit.usedKey, reserve.usedKey);
  assert.equal(commit.token, reserve.token);
  assert.equal(commit.ttl, '86400');
  const evalCalls = h.calls.filter(call => call.url.includes('redis.example.test'));
  assert.equal(evalCalls.length, 2);
  for (const call of evalCalls) {
    const commands = JSON.parse(call.options.body);
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], 'EVAL');
    assert.equal(commands[0][2], '2');
    assert.match(commands[0][3], /^ielts:generate:v2:/);
    assert.match(commands[0][4], /:used$/);
  }
  assert.equal(h.reservationState.get(reserve.usedKey), '1');
  assert.equal(h.reservationState.has(reserve.pendingKey), false);
  assert.equal(h.calls.filter(call => call.url === 'https://api.openai.com/v1/chat/completions').length, 15);
});

for (const mode of ['http-error', 'throw', 'bad-shape', 'command-error', 'bad-count', 'null-count', 'string-count', 'expiry-not-set']) {
  test(`Redis ${mode} fails closed without calling OpenAI`, async () => {
    const h = createHarness({redisMode: mode});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 503);
    assert.equal(h.calls.filter(call => /api\.(?:openai|deepseek)\.com\/chat\/completions/.test(call.url)).length, 0);
  });
}

test('an occupied reservation is rejected without calling OpenAI', async () => {
  const h = createHarness({redisMode: 'over-limit'});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 429);
  assert.equal(h.calls.filter(call => /api\.(?:openai|deepseek)\.com\/chat\/completions/.test(call.url)).length, 0);
  assert.equal(h.reservationCalls.length, 1);
});

test('missing Redis configuration fails closed without any outgoing request', async () => {
  const h = createHarness();
  delete h.env.UPSTASH_REDIS_REST_TOKEN;
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 503);
  assert.equal(h.calls.length, 0);
});

test('generation validates and returns a complete 40-question listening and reading paper', async () => {
  const h = createHarness();
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.paper.listening.parts.reduce((n, part) => n + part.questions.length, 0), 40);
  assert.equal(result.body.paper.reading.questions.length, 40);
});

test('a committed successful generation blocks another same-day request before calling AI', async () => {
  const h = createHarness();
  const first = await h.invoke({action: 'generate', words: vocab});
  assert.equal(first.statusCode, 200);
  const second = await h.invoke({action: 'generate', words: vocab});
  assert.equal(second.statusCode, 429);
  assert.equal(h.calls.filter(call => call.url === 'https://api.openai.com/v1/chat/completions').length, 15);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit', 'reserve']);
});

test('one invalid listening question module retries only itself and commits after both phases validate', async () => {
  const invalidPart = makeDeepSeekModule({kind: 'listening-questions', part: 2, firstNumber: 11, count: 10});
  invalidPart.questions.pop();
  const h = deepseekHarness({deepseekModuleOverrides: {'listening-questions-2': [{value: invalidPart}]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(h.deepseekModuleCalls.length, 16);
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'listening-questions-2').map(call => call.attempt), [1, 2]);
  assert.equal(h.deepseekModuleCalls.filter(call => call.key !== 'listening-questions-2').length, 14);
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key.startsWith('reading-questions-')).map(call => call.key).sort(), ['reading-questions-P1', 'reading-questions-P2', 'reading-questions-P3'].sort());
  const calls = h.calls.filter(call => call.url === 'https://api.deepseek.com/chat/completions');
  assert.equal(calls.length, 16);
  const tokens = calls.map(call => JSON.parse(call.options.body).max_tokens).sort((a, b) => a - b);
  assert.deepEqual(tokens, [...Array(7).fill(4000), ...Array(5).fill(6500), 6500, ...Array(3).fill(7500)].sort((a, b) => a - b));
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit']);
  assert.equal(h.reservationState.get(h.reservationCalls[0].usedKey), '1');
});

for (const moduleCase of [
  {kind: 'listening-questions', key: 'listening-questions-1', part: 1, firstNumber: 1, count: 10},
  {kind: 'reading-questions', key: 'reading-questions-P2', passageId: 'P2', firstNumber: 14, count: 13}
]) {
  function questionModule() {
    return makeDeepSeekModule(moduleCase, moduleCase.passageId ? {passage: makeDeepSeekModule({kind: 'reading', passageId: moduleCase.passageId}).passage} : {});
  }
  test(`${moduleCase.kind} aligns word limits to answers and accepted variants without regenerating questions`, async () => {
    const value = questionModule();
    const alignedQuestions = [
      {prompt: 'ONE WORD ONLY. Where can visitors leave their cars?', answer: 'car park', acceptedAnswers: [], expected: 'Write NO MORE THAN TWO WORDS. Where can visitors leave their cars?'},
      {prompt: 'Write NO MORE THAN TWO WORDS. Name the venue.', answer: 'city library', acceptedAnswers: ['central city library'], expected: 'Write NO MORE THAN THREE WORDS. Name the venue.'},
      ...['AND A NUMBER', 'AND/OR A NUMBER', 'OR A NUMBER'].map((numberClause, index) => ({
        prompt: `Write ONE WORD ${numberClause}. Where is event ${index + 1}?`, answer: 'meeting room 24', acceptedAnswers: ['training room 7'],
        expected: `Write NO MORE THAN TWO WORDS AND A NUMBER. Where is event ${index + 1}?`
      }))
    ];
    for (const {expected, ...question} of alignedQuestions) {
    Object.assign(value.questions.at(-1), question);
    const h = deepseekHarness({deepseekModuleOverrides: {[moduleCase.key]: [{value}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 15);
    assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === moduleCase.key).map(call => call.attempt), [1]);
    const returned = moduleCase.part ? result.body.paper.listening.parts[moduleCase.part - 1].questions
      : result.body.paper.reading.questions.filter(question => question.passageId === moduleCase.passageId);
      assert.equal(returned.at(-1).prompt, moduleCase.part
        ? expected.replace(/Write NO MORE THAN (?:TWO|THREE) WORDS(?: AND A NUMBER)?/, 'Write NO MORE THAN THREE WORDS AND/OR A NUMBER')
        : expected);
      assert.equal(returned.at(-1).answer, question.answer);
      assert.deepEqual(Array.from(returned.at(-1).acceptedAnswers), question.acceptedAnswers);
    }
  });

  test(`${moduleCase.kind} filters only over-limit optional variants without regenerating or changing the answer`, async () => {
    const value = questionModule();
    Object.assign(value.questions.at(-1), {
      prompt: 'Write NO MORE THAN THREE WORDS AND A NUMBER. Name the venue.',
      answer: 'city library',
      acceptedAnswers: ['central city library', 'the main city library', 'library 24 25', 'city library']
    });
    const h = deepseekHarness({deepseekModuleOverrides: {[moduleCase.key]: [{value}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 15);
    assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === moduleCase.key).map(call => call.attempt), [1]);
    const returned = moduleCase.part ? result.body.paper.listening.parts[moduleCase.part - 1].questions
      : result.body.paper.reading.questions.filter(question => question.passageId === moduleCase.passageId);
    assert.equal(returned.at(-1).answer, 'city library');
    assert.deepEqual(Array.from(returned.at(-1).acceptedAnswers), ['central city library', 'city library']);
    assert.equal(returned.at(-1).evidence, value.questions.at(-1).evidence);
  });

  for (const invalidVariant of ['answer', 'multiple-numbers']) {
    function invalidQuestions() {
      const value = questionModule();
      const invalid = invalidVariant === 'answer'
        ? {prompt: 'ONE WORD ONLY. Where can visitors leave their cars?', answer: 'the main car park', acceptedAnswers: []}
        : {prompt: 'Write NO MORE THAN TWO WORDS AND A NUMBER. Where is the event?', answer: 'room 24 25', acceptedAnswers: []};
      Object.assign(value.questions.at(-1), invalid);
      return value;
    }

    test(`${moduleCase.kind} unrepairable ${invalidVariant} retries only that module and aligns its replacement`, async () => {
      const replacement = questionModule();
      Object.assign(replacement.questions.at(-1), {prompt: 'ONE WORD ONLY. Where can visitors leave their cars?', answer: 'car park', acceptedAnswers: []});
      const h = deepseekHarness({deepseekModuleOverrides: {[moduleCase.key]: [{value: invalidQuestions()}, {value: replacement}]}});
      const result = await h.invoke({action: 'generate', words: vocab});
      assert.equal(result.statusCode, 200);
      assert.equal(h.deepseekModuleCalls.length, 16);
      assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === moduleCase.key).map(call => call.attempt), [1, 2]);
      assert.equal(h.deepseekModuleCalls.filter(call => call.key !== moduleCase.key).length, 14);
      const requests = h.calls.filter(call => call.url === 'https://api.deepseek.com/chat/completions')
        .map(call => JSON.parse(call.options.body))
        .filter(body => {
          const module = JSON.parse(body.messages.find(message => message.role === 'user').content).module;
          return module.kind === moduleCase.kind && (moduleCase.part ? module.part === moduleCase.part : module.passageId === moduleCase.passageId);
        });
      assert.equal(requests.length, 2);
      const expectedIssue = invalidVariant === 'multiple-numbers'
        ? `answer_exceeds_number_limit:q${moduleCase.firstNumber+moduleCase.count-1}:2_numbers;maximum_1`
        : `answer_exceeds_word_limit:q${moduleCase.firstNumber+moduleCase.count-1}:4_words;maximum_${moduleCase.part ? 3 : 1}`;
      assert.ok(requests[1].messages[0].content.includes(expectedIssue));
      const firstPayload = JSON.parse(requests[0].messages.find(message => message.role === 'user').content);
      const retryPayload = JSON.parse(requests[1].messages.find(message => message.role === 'user').content);
      const {previousDraft, validationIssues, ...originalFields} = retryPayload;
      assert.deepEqual(originalFields, firstPayload);
      assert.ok(validationIssues.includes(expectedIssue));
      if (invalidVariant === 'multiple-numbers') assert.equal(validationIssues.some(issue => issue.startsWith('answer_exceeds_word_limit:')), false);
      assert.equal(previousDraft.questions.length, moduleCase.count);
      assert.equal(previousDraft.questions.at(-1).answer, invalidQuestions().questions.at(-1).answer);
      assert.equal(previousDraft.questions.at(-1).evidence, invalidQuestions().questions.at(-1).evidence);
      assert.equal(firstPayload.previousDraft, undefined);
      const returned = moduleCase.part ? result.body.paper.listening.parts[moduleCase.part - 1].questions
        : result.body.paper.reading.questions.filter(question => question.passageId === moduleCase.passageId);
      assert.equal(returned.at(-1).prompt, moduleCase.part
        ? 'Write NO MORE THAN THREE WORDS AND/OR A NUMBER. Where can visitors leave their cars?'
        : 'Write NO MORE THAN TWO WORDS. Where can visitors leave their cars?');
      assert.equal(returned.at(-1).answer, 'car park');
      assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit']);
    });

    test(`${moduleCase.kind} repeated unrepairable ${invalidVariant} rejects the paper and releases quota`, async () => {
      const h = deepseekHarness({deepseekModuleOverrides: {[moduleCase.key]: [
        {value: invalidQuestions()}, {value: invalidQuestions()}
      ]}});
      const failed = await h.invoke({action: 'generate', words: vocab});
      assert.equal(failed.statusCode, 502);
      assert.equal(failed.body.code, 'AI_PAPER_STRUCTURE_INVALID');
      assert.equal(failed.body.paper, undefined);
      assert.equal(h.deepseekModuleCalls.length, 16);
      assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === moduleCase.key).map(call => call.attempt), [1, 2]);
      assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);
      assert.equal(h.reservationState.has(h.reservationCalls[0].pendingKey), false);
      assert.equal(h.reservationState.has(h.reservationCalls[0].usedKey), false);
      const retried = await h.invoke({action: 'generate', words: vocab});
      assert.equal(retried.statusCode, 200);
      assert.equal(h.deepseekModuleCalls.length, 31);
      assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release', 'reserve', 'commit']);
    });
  }

  test(`${moduleCase.kind} accepts legal two-word, number and hyphenated answers without a retry`, async () => {
    const value = questionModule();
    const validAnswers = [
      {prompt: 'Write TWO WORDS ONLY. Where should participants meet?', answer: 'car park', acceptedAnswers: ['railway station']},
      {prompt: 'Write NO MORE THAN TWO WORDS AND/OR A NUMBER. Where is the event?', answer: 'meeting room 24', acceptedAnswers: ['training room 7']},
      {prompt: 'Write ONE WORD ONLY. Describe the programme.', answer: 'student-led', acceptedAnswers: ['long-term']},
      {prompt: 'Write ONE WORD OR A NUMBER. Which room is used?', answer: '24', acceptedAnswers: ['7.5']},
      {prompt: 'Write THREE WORDS ONLY. Name the venue.', answer: 'university research centre', acceptedAnswers: ['regional training centre']},
      {prompt: 'Name the second venue.', answer: 'central city library', acceptedAnswers: ['town training centre']},
      {prompt: 'NO MORE THAN TWO WORDS AND A NUMBER. Where is the event?', answer: 'meeting room 24', acceptedAnswers: ['training room 7']}
    ];
    for (const [index, question] of validAnswers.entries()) {
    Object.assign(value.questions.at(-1), question);
    const h = deepseekHarness({deepseekModuleOverrides: {[moduleCase.key]: [{value}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 15);
    assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === moduleCase.key).map(call => call.attempt), [1]);
    const returned = moduleCase.part ? result.body.paper.listening.parts[moduleCase.part - 1].questions
      : result.body.paper.reading.questions.filter(question => question.passageId === moduleCase.passageId);
      const expectedPrompt = index === 5 ? 'Name the second venue. (Write NO MORE THAN THREE WORDS).' : question.prompt;
      assert.equal(returned.at(-1).prompt, moduleCase.part
        ? expectedPrompt.replace(/(?:Write )?(?:NO MORE THAN )?(?:ONE|TWO|THREE) WORDS?(?: ONLY)?(?: AND\/OR A NUMBER| AND A NUMBER| OR A NUMBER)?/i, 'Write NO MORE THAN THREE WORDS AND/OR A NUMBER')
        : expectedPrompt);
      assert.equal(returned.at(-1).answer, question.answer);
      assert.deepEqual(Array.from(returned.at(-1).acceptedAnswers), question.acceptedAnswers);
    }
  });

  function numberQuestionOverrides(label, answer) {
    const value = questionModule();
    const evidence = `The final contact detail is ${answer}.`;
    Object.assign(value.questions.at(-1), {
      prompt: `Write ONE WORD AND A NUMBER. Record the ${label}: ____.`,
      answer, acceptedAnswers: [], evidence, skill: 'number'
    });
    if (moduleCase.part) {
      const source = makeDeepSeekModule({kind: 'listening-script', part: moduleCase.part});
      source.script += ` ${evidence}`;
      return {value, source, overrides: {
        [`listening-script-${moduleCase.part}`]: [{value: source}],
        [moduleCase.key]: [{value}]
      }};
    }
    const source = makeDeepSeekModule({kind: 'reading', passageId: moduleCase.passageId});
    source.passage.text += ` ${evidence}`;
    return {value, source, overrides: {
      [`reading-${moduleCase.passageId}`]: [{value: source}],
      [moduleCase.key]: [{value}]
    }};
  }

  test(`${moduleCase.kind} accepts one contextual telephone number without rewriting its source or answer`, async () => {
    for (const [label, answer] of [
      ['phone number', '01632 960422'],
      ['telephone number', '(01632) 960422'],
      ['mobile number', '07700 900123'],
      ['contact number', '01632-960422']
    ]) {
      const {value, source, overrides} = numberQuestionOverrides(label, answer);
      const h = deepseekHarness({deepseekModuleOverrides: overrides});
      const result = await h.invoke({action: 'generate', words: vocab});
      assert.equal(result.statusCode, 200, `${label}: ${answer}`);
      assert.equal(h.deepseekModuleCalls.length, 15);
      const returned = moduleCase.part ? result.body.paper.listening.parts[moduleCase.part - 1].questions
        : result.body.paper.reading.questions.filter(question => question.passageId === moduleCase.passageId);
      assert.equal(returned.at(-1).answer, answer);
      assert.equal(returned.at(-1).evidence, value.questions.at(-1).evidence);
      if (moduleCase.part) assert.equal(result.body.paper.listening.parts[moduleCase.part - 1].script, source.script);
      else assert.equal(result.body.paper.reading.passages.find(passage => passage.id === moduleCase.passageId).text, source.passage.text);
    }
  });

  test(`${moduleCase.kind} does not let telephone formatting bypass answer grounding`, async () => {
    const {value, overrides} = numberQuestionOverrides('phone number', '01632 960422');
    value.questions.at(-1).answer = '01632 960423';
    const h = deepseekHarness({deepseekModuleOverrides: overrides});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 16);
    assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === moduleCase.key).map(call => call.attempt), [1, 2]);
    const returned = moduleCase.part ? result.body.paper.listening.parts[moduleCase.part - 1].questions
      : result.body.paper.reading.questions.filter(question => question.passageId === moduleCase.passageId);
    assert.equal(returned.some(question => question.answer === '01632 960423'), false);
  });

  test(`${moduleCase.kind} diagnoses two numbers accurately when the telephone exception does not apply`, async () => {
    for (const [label, answer] of [
      ['reference number', '01632 960422'],
      ['contact number', '24 25'],
      ['phone number', '12345678 12345678']
    ]) {
      const {value, overrides} = numberQuestionOverrides(label, answer);
      const h = deepseekHarness({deepseekModuleOverrides: overrides});
      const result = await h.invoke({action: 'generate', words: vocab});
      assert.equal(result.statusCode, 200, `${label}: ${answer}`);
      assert.equal(h.deepseekModuleCalls.length, 16);
      const requests = h.calls.filter(call => call.url === 'https://api.deepseek.com/chat/completions')
        .map(call => JSON.parse(JSON.parse(call.options.body).messages.find(message => message.role === 'user').content))
        .filter(payload => payload.module.kind === moduleCase.kind && (moduleCase.part ? payload.module.part === moduleCase.part : payload.module.passageId === moduleCase.passageId));
      assert.equal(requests.length, 2);
      const expectedIssue = `answer_exceeds_number_limit:q${moduleCase.firstNumber+moduleCase.count-1}:2_numbers;maximum_1`;
      assert.ok(requests[1].validationIssues.includes(expectedIssue));
      assert.equal(requests[1].validationIssues.some(issue => issue.startsWith('answer_exceeds_word_limit:')), false);
      assert.equal(requests[1].previousDraft.questions.at(-1).answer, answer);
      assert.equal(requests[1].previousDraft.questions.at(-1).evidence, value.questions.at(-1).evidence);
    }
  });
}

for (const invalidKind of ['tfng', 'short-script']) {
  function invalidListeningPart() {
    const part = makeDeepSeekModule({kind: invalidKind === 'tfng' ? 'listening-questions' : 'listening-script', part: 3, firstNumber: 21, count: 10});
    if (invalidKind === 'tfng') part.questions[0] = {
      ...part.questions[0], format: 'tfng', options: ['TRUE', 'FALSE', 'NOT GIVEN'], answer: 'TRUE'
    };
    else part.script = Array(20).fill('A short listening script with some supporting details.').join(' ');
    return part;
  }
  const key = invalidKind === 'tfng' ? 'listening-questions-3' : 'listening-script-3';
  const issue = invalidKind === 'tfng' ? 'listening_format_must_be_text_or_choice' : 'script_too_short:';

  test(`Listening ${invalidKind} is repaired by retrying only that part once`, async () => {
    const h = deepseekHarness({deepseekModuleOverrides: {[key]: [{value: invalidListeningPart()}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.equal(h.deepseekModuleCalls.length, 16);
    assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === key).map(call => call.attempt), [1, 2]);
    const partCalls = h.calls.filter(call => call.url === 'https://api.deepseek.com/chat/completions')
      .map(call => JSON.parse(call.options.body))
      .filter(body => {
        const module = JSON.parse(body.messages.find(message => message.role === 'user').content).module;
        return module?.part === 3 && module.kind === (invalidKind === 'tfng' ? 'listening-questions' : 'listening-script');
      });
    assert.equal(partCalls.length, 2);
    assert.ok(partCalls[1].messages[0].content.includes(issue));
    for (const part of result.body.paper.listening.parts) {
      assert.ok(part.script.trim().split(/\s+/).length >= 650);
      assert.ok(part.script.length <= 8000);
      assert.ok(part.questions.every(question => ['text', 'choice'].includes(question.format)));
    }
    assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit']);
  });

  test(`Listening ${invalidKind} still invalid after retry is rejected and releases quota`, async () => {
    const h = deepseekHarness({deepseekModuleOverrides: {[key]: [
      {value: invalidListeningPart()}, {value: invalidListeningPart()}
    ]}});
    const failed = await h.invoke({action: 'generate', words: vocab});
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.body.code, 'AI_PAPER_STRUCTURE_INVALID');
    assert.equal(failed.body.paper, undefined);
    assert.equal(h.deepseekModuleCalls.length, invalidKind === 'tfng' ? 16 : 9);
    assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === key).map(call => call.attempt), [1, 2]);
    assert.equal(h.deepseekModuleCalls.some(call => call.key.startsWith('reading-questions-')), invalidKind === 'tfng');
    assert.equal(h.deepseekModuleCalls.some(call => call.key.startsWith('listening-questions-')), invalidKind === 'tfng');
    assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);
    assert.equal(h.reservationState.has(h.reservationCalls[0].pendingKey), false);
    assert.equal(h.reservationState.has(h.reservationCalls[0].usedKey), false);

    const retried = await h.invoke({action: 'generate', words: vocab});
    assert.equal(retried.statusCode, 200);
    assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release', 'reserve', 'commit']);
    assert.equal(h.deepseekModuleCalls.length, invalidKind === 'tfng' ? 31 : 24);
  });
}

test('Task 1 instruction describes the validated table series and discards a conflicting model prompt', async () => {
  const writingSpeaking = makeDeepSeekModule({kind: 'writing-speaking'});
  const modelPrompt = 'The bar chart below compares three activities: hiking, swimming and volunteering.';
  writingSpeaking.writing.task1.prompt = modelPrompt;
  writingSpeaking.writing.task1.chart.series[0].name = 'Library visits';
  writingSpeaking.writing.task1.chart.series[1].name = 'Sport participation';
  const h = deepseekHarness({deepseekModuleOverrides: {'writing-speaking': [{value: writingSpeaking}]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  const task1 = result.body.paper.writing.task1;
  assert.match(task1.prompt, /^The table below compares Library visits and Sport participation across the categories shown\./);
  assert.match(task1.prompt, /at least 150 words/);
  assert.doesNotMatch(task1.prompt, /three activities|bar chart|hiking|swimming|volunteering/);
  assert.notEqual(task1.prompt, modelPrompt);
  assert.equal(task1.chart.series.length, 2);
  assert.equal(h.deepseekModuleCalls.length, 15);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit']);
});

test('a module still invalid after its one retry releases quota, then a later request succeeds', async () => {
  const passage = makeDeepSeekModule({kind: 'reading', passageId: 'P2'}).passage;
  const invalidModule = makeDeepSeekModule({kind: 'reading-questions', passageId: 'P2', firstNumber: 14, count: 13}, {passage});
  invalidModule.questions.pop();
  const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P2': [{value: invalidModule}, {value: invalidModule}]}});
  const failed = await h.invoke({action: 'generate', words: vocab});
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.code, 'AI_PAPER_STRUCTURE_INVALID');
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'reading-questions-P2').map(call => call.attempt), [1, 2]);
  assert.equal(h.deepseekModuleCalls.length, 16);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);
  assert.equal(h.reservationState.has(h.reservationCalls[0].pendingKey), false);
  const retried = await h.invoke({action: 'generate', words: vocab});
  assert.equal(retried.statusCode, 200);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release', 'reserve', 'commit']);
  assert.equal(h.deepseekModuleCalls.length, 31);
});

test('an upstream HTTP failure releases its reservation before returning and allows a later retry', async () => {
  const h = createHarness({aiStatusSequence: [500]});
  const failed = await h.invoke({action: 'generate', words: vocab});
  assert.equal(failed.statusCode, 502);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);
  assert.equal(h.deepseekModuleCalls.length, 8);
  assert.equal(h.deepseekModuleCalls.some(call => call.key.startsWith('reading-questions-')), false);
  assert.equal(h.reservationState.has(h.reservationCalls[0].pendingKey), false);
  const retried = await h.invoke({action: 'generate', words: vocab});
  assert.equal(retried.statusCode, 200);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release', 'reserve', 'commit']);
  assert.equal(h.deepseekModuleCalls.length, 23);
});

test('one module HTTP failure releases quota, and a later request retries all modules successfully', async () => {
  const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P3': [{status: 500}]}});
  const failed = await h.invoke({action: 'generate', words: vocab});
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.code, 'AI_UPSTREAM_ERROR');
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'reading-questions-P3').map(call => call.attempt), [1]);
  assert.equal(h.deepseekModuleCalls.length, 15);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);

  const retried = await h.invoke({action: 'generate', words: vocab});
  assert.equal(retried.statusCode, 200);
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'reading-questions-P3').map(call => call.attempt), [1, 2]);
  assert.equal(h.deepseekModuleCalls.length, 30);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release', 'reserve', 'commit']);
});

for (const key of ['listening-script-2', 'reading-questions-P3']) {
  test(`${key} retries one connection failure without regenerating other modules`, async () => {
    const h = deepseekHarness({deepseekModuleOverrides: {[key]: [{networkError: true}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 200);
    assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === key).map(call => call.attempt), [1, 2]);
    assert.equal(h.deepseekModuleCalls.length, 16);
    assert.equal(h.deepseekModuleCalls.filter(call => call.key !== key).length, 14);
    assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit']);
    const attempts = h.calls.filter(call => call.url === 'https://api.deepseek.com/chat/completions')
      .map(call => JSON.parse(call.options.body))
      .filter(body => {
        const module = JSON.parse(body.messages.find(message => message.role === 'user').content).module;
        return key === 'listening-script-2' ? module.kind === 'listening-script' && module.part === 2
          : module.kind === 'reading-questions' && module.passageId === 'P3';
      });
    assert.equal(attempts.length, 2);
    assert.match(attempts[1].messages[0].content, /connection:AI_CONNECTION_FAILED/);
    const firstPayload = JSON.parse(attempts[0].messages.find(message => message.role === 'user').content);
    const retryPayload = JSON.parse(attempts[1].messages.find(message => message.role === 'user').content);
    assert.deepEqual(retryPayload, firstPayload);
    assert.doesNotMatch(JSON.stringify(result.body), /transport failure|sk-deepseek-test-never-a-real-secret/);
  });

  test(`${key} releases quota after two connection failures`, async () => {
    const h = deepseekHarness({deepseekModuleOverrides: {[key]: [{networkError: true}, {networkError: true}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.code, 'AI_CONNECTION_FAILED');
    assert.equal(result.body.paper, undefined);
    assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === key).map(call => call.attempt), [1, 2]);
    assert.equal(h.deepseekModuleCalls.length, key === 'listening-script-2' ? 9 : 16);
    assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);
    assert.equal(h.reservationState.has(h.reservationCalls[0].pendingKey), false);
    assert.equal(h.reservationState.has(h.reservationCalls[0].usedKey), false);
    assert.doesNotMatch(JSON.stringify(result.body), /transport failure|sk-deepseek-test-never-a-real-secret/);
  });
}

for (const [status, errorCode, resultCode, resultStatus] of [
  [401, undefined, 'AI_AUTH_FAILED', 502],
  [429, 'insufficient_quota', 'AI_QUOTA_UNAVAILABLE', 429]
]) {
  test(`a module ${resultCode} does not retry and releases quota`, async () => {
    const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P3': [{status, errorCode}]}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, resultStatus);
    assert.equal(result.body.code, resultCode);
    assert.equal(result.body.paper, undefined);
    assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'reading-questions-P3').map(call => call.attempt), [1]);
    assert.equal(h.deepseekModuleCalls.length, 15);
    assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);
  });
}

test('AI_INVALID_RESPONSE for one module is retried once and the complete exam can commit', async () => {
  const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P1': [{content: 'not a paper'}]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'reading-questions-P1').map(call => call.attempt), [1, 2]);
  assert.equal(h.deepseekModuleCalls.length, 16);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit']);
});

test('AI_INCOMPLETE_RESPONSE for one module is retried once before it is accepted', async () => {
  const h = deepseekHarness({deepseekModuleOverrides: {'listening-script-4': [{finishReason: 'length'}]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'listening-script-4').map(call => call.attempt), [1, 2]);
  assert.equal(h.deepseekModuleCalls.length, 16);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'commit']);
});

test('a response-format retry that remains structurally invalid does not trigger a third attempt', async () => {
  const passage = makeDeepSeekModule({kind: 'reading', passageId: 'P1'}).passage;
  const invalidQuestions = makeDeepSeekModule({kind: 'reading-questions', passageId: 'P1', firstNumber: 1, count: 13}, {passage});
  invalidQuestions.questions.pop();
  const h = deepseekHarness({deepseekModuleOverrides: {'reading-questions-P1': [
    {finishReason: 'length'},
    {value: invalidQuestions}
  ]}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 502);
  assert.equal(result.body.code, 'AI_PAPER_STRUCTURE_INVALID');
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key === 'reading-questions-P1').map(call => call.attempt), [1, 2]);
  assert.equal(h.deepseekModuleCalls.length, 16);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'release']);
});

test('two simultaneous same-IP requests reserve only once while the first model request is pending', async () => {
  const gate = makeAiGate();
  const h = createHarness({aiGate: gate});
  const firstPromise = h.invoke({action: 'generate', words: vocab});
  await gate.started;
  const second = await h.invoke({action: 'generate', words: vocab});
  assert.equal(second.statusCode, 429);
  assert.equal(h.calls.filter(call => call.url === 'https://api.openai.com/v1/chat/completions').length, 8);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'reserve']);
  gate.release();
  const first = await firstPromise;
  assert.equal(first.statusCode, 200);
  assert.equal(h.calls.filter(call => call.url === 'https://api.openai.com/v1/chat/completions').length, 15);
  assert.deepEqual(h.reservationCalls.map(call => call.operation), ['reserve', 'reserve', 'commit']);
});

test('a concurrent denied reservation does not take the pending slot from the first request', async () => {
  const gate = makeAiGate();
  const h = createHarness({aiGate: gate});
  const firstPromise = h.invoke({action: 'generate', words: vocab});
  await gate.started;
  const second = await h.invoke({action: 'generate', words: vocab});
  assert.equal(second.statusCode, 429);
  gate.release();
  const first = await firstPromise;
  assert.equal(first.statusCode, 200);
  assert.equal(h.reservationState.get(h.reservationCalls[0].usedKey), '1');
  assert.equal(h.reservationState.has(h.reservationCalls[0].pendingKey), false);
});

test('unknown commit outcome never returns a successful paper or immediately reopens quota', async () => {
  for (const mode of ['throw-after', 'throw-before-apply']) {
    const h = createHarness({reservationModes: {commit: mode}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, 'GENERATION_QUOTA_COMMIT_FAILED');
    assert.equal(h.reservationCalls.at(-1).operation, 'commit');
    const second = await h.invoke({action: 'generate', words: vocab});
    assert.equal(second.statusCode, 429);
    assert.equal(h.calls.filter(call => call.url === 'https://api.openai.com/v1/chat/completions').length, 15);
  }
});

test('unknown release result leaves the reservation occupied instead of allowing an unsafe immediate retry', async () => {
  const h = createHarness({aiStatus: 500, reservationModes: {release: 'throw-before-apply'}});
  const failed = await h.invoke({action: 'generate', words: vocab});
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.code, 'GENERATION_QUOTA_RELEASE_FAILED');
  assert.equal(h.reservationState.has(h.reservationCalls[0].pendingKey), true);
  assert.doesNotMatch(failed.body.error, /名额已释放，可以稍后重试/);
  const second = await h.invoke({action: 'generate', words: vocab});
  assert.equal(second.statusCode, 429);
  assert.equal(h.calls.filter(call => call.url === 'https://api.openai.com/v1/chat/completions').length, 8);
});

test('Redis reservation or commit failure fails closed without reporting a successful generation', async () => {
  for (const mode of ['http-error', 'throw', 'bad-shape', 'bad-result']) {
    const h = createHarness({reservationModes: {reserve: mode}});
    const result = await h.invoke({action: 'generate', words: vocab});
    assert.equal(result.statusCode, 503);
    assert.equal(h.calls.filter(call => call.url === 'https://api.openai.com/v1/chat/completions').length, 0);
  }
  const h = createHarness({reservationModes: {commit: 'throw-before-apply'}});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'GENERATION_QUOTA_COMMIT_FAILED');
  assert.equal(result.body.paper, undefined);
});

test('writing assessment proceeds after quota is recorded', async () => {
  const h = createHarness();
  const result = await h.invoke({
    action: 'grade-writing', task: 'task2', prompt: 'Discuss the issue.',
    response: 'A sufficiently long response for this mocked assessment.'
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback.overallEstimate, 7);
  const redis = h.calls.find(call => call.url.includes('redis.example.test'));
  assert.deepEqual(JSON.parse(redis.options.body).map(command => command[0]), ['INCR', 'EXPIRE']);
});

test('audio generation proceeds after quota is recorded', async () => {
  const h = createHarness();
  const result = await h.invoke({action: 'audio', script: 'This is a sufficiently long practice listening script.'});
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Content-Type'], 'audio/mpeg');
  const redis = h.calls.find(call => call.url.includes('redis.example.test'));
  assert.equal(JSON.parse(redis.options.body)[1][2], 86400);
});

for (const inputKey of [
  `  ${fakeOpenAIKey}  `,
  `\r\n ${fakeOpenAIKey} \t`,
  `"${fakeOpenAIKey}"`,
  `'${fakeOpenAIKey}'`,
  `  " ${fakeOpenAIKey} "  `
]) {
  test('chat and audio requests use a trimmed key without matching outer quotes', async () => {
    const h = createHarness({openAIKey: inputKey});
    const writing = await h.invoke({
      action: 'grade-writing', task: 'task2', prompt: 'Discuss the issue.',
      response: 'A sufficiently long response for this mocked assessment.'
    });
    assert.equal(writing.statusCode, 200);
    const chatCall = h.calls.find(call => call.url === 'https://api.openai.com/v1/chat/completions');
    assert.equal(chatCall.options.headers.Authorization, `Bearer ${fakeOpenAIKey}`);

    const audio = await h.invoke({action: 'audio', script: 'This is a sufficiently long practice listening script.'});
    assert.equal(audio.statusCode, 200);
    const audioCall = h.calls.find(call => call.url === 'https://api.openai.com/v1/audio/speech');
    assert.equal(audioCall.options.headers.Authorization, `Bearer ${fakeOpenAIKey}`);
  });
}

for (const invalidKey of [
  `${fakeOpenAIKey.slice(0, 8)}\n${fakeOpenAIKey.slice(8)}`,
  `${fakeOpenAIKey.slice(0, 8)} ${fakeOpenAIKey.slice(8)}`,
  `"${fakeOpenAIKey}'`,
  `'${fakeOpenAIKey}"`,
  '"   "'
]) {
  test('invalid OpenAI key formatting is rejected safely for chat and audio', async () => {
    const h = createHarness({openAIKey: invalidKey});
    const writing = await h.invoke({
      action: 'grade-writing', task: 'task2', prompt: 'Discuss the issue.',
      response: 'A sufficiently long response for this mocked assessment.'
    });
    const audio = await h.invoke({action: 'audio', script: 'This is a sufficiently long practice listening script.'});
    for (const [result, expectedCode] of [[writing, 'AI_KEY_FORMAT_INVALID'], [audio, 'TTS_NOT_CONFIGURED']]) {
      assert.equal(result.statusCode, 503);
      assert.equal(result.body.code, expectedCode);
      assert.doesNotMatch(JSON.stringify(result.body), /sk-test-never-a-real-secret/);
      assert.doesNotMatch(JSON.stringify(result.body), /upstash-test-never-a-real-secret/);
    }
    assert.equal(h.calls.some(call => call.url.includes('api.openai.com')), false);
  });
}

test('empty OpenAI configuration rejects chat and audio before quota or requests', async () => {
  for (const openAIKey of ['', '  \r\n\t  ']) {
    const h = createHarness({openAIKey});
    const writing = await h.invoke(writingRequest());
    assert.equal(writing.statusCode, 503);
    assert.equal(writing.body.code, 'AI_KEY_MISSING');
    assert.match(writing.body.error, /还没有配置/);
    const audio = await h.invoke({action: 'audio', script: 'This is a sufficiently long practice listening script.'});
    assert.equal(audio.statusCode, 503);
    assert.equal(audio.body.code, 'TTS_NOT_CONFIGURED');
    assert.equal(h.calls.length, 0);
  }
});

for (const aiStatus of [401, 403, 429, 500]) {
  test(`OpenAI ${aiStatus} response never returns upstream message or fake key`, async () => {
    const h = createHarness({aiStatus});
    const result = await h.invoke({action: 'grade-writing', task: 'task2', prompt: 'Discuss.', response: 'A sufficiently long response for this mocked assessment.'});
    assert.equal(result.statusCode, aiStatus === 429 ? 429 : 502);
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(fakeOpenAIKey));
    assert.doesNotMatch(JSON.stringify(result.body), /failure includes/);
  });
}

function writingRequest(overrides = {}) {
  return {
    action: 'grade-writing', task: 'task2', prompt: 'Discuss the issue.',
    response: 'A sufficiently long response for this mocked assessment.',
    ...overrides
  };
}

test('WAWA uses the fixed Responses endpoint and server default with storage disabled', async () => {
  const h = createHarness({provider: 'wawazz'});
  const result = await h.invoke(writingRequest());
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback.overallEstimate, 7);
  const call = h.calls.find(item => item.url === 'https://wawazz.xyz/v1/responses');
  assert.ok(call);
  const body = JSON.parse(call.options.body);
  assert.equal(body.model, 'gpt-5.6-terra');
  assert.equal(body.store, false);
  assert.equal(body.stream, false);
  assert.equal(body.max_output_tokens, 4000);
  assert.equal(body.temperature, undefined);
  assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers.Authorization, `Bearer ${fakeOpenAIKey}`);
  assert.equal(h.calls.some(item => item.url.includes('api.openai.com')), false);
});

test('WAWA ignores front-end provider, host, model and key overrides', async () => {
  const h = createHarness({provider: 'wawazz'});
  const clientKey = 'client-controlled-credential';
  const result = await h.invoke(writingRequest({
    provider: 'openai', baseURL: 'https://attacker.invalid', host: 'https://attacker.invalid',
    endpoint: 'https://attacker.invalid', model: 'client-model', apiKey: clientKey,
    openai_api_key: clientKey, OPENAI_API_KEY: clientKey
  }));
  assert.equal(result.statusCode, 200);
  const aiCalls = h.calls.filter(item => !item.url.startsWith('https://redis.example.test/'));
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].url, 'https://wawazz.xyz/v1/responses');
  assert.equal(JSON.parse(aiCalls[0].options.body).model, 'gpt-5.6-terra');
  assert.equal(aiCalls[0].options.headers.Authorization, `Bearer ${fakeOpenAIKey}`);
  assert.doesNotMatch(JSON.stringify(aiCalls[0].options), /attacker\.invalid|client-controlled-credential|client-model/);
});

test('WAWAZZ_MODEL is a server-side override and OPENAI_MODEL cannot override its default', async () => {
  const officialModel = createHarness({provider: 'wawazz', envOverrides: {OPENAI_MODEL: 'official-only-model'}});
  assert.equal((await officialModel.invoke(writingRequest())).statusCode, 200);
  const defaultCall = officialModel.calls.find(item => item.url === 'https://wawazz.xyz/v1/responses');
  assert.equal(JSON.parse(defaultCall.options.body).model, 'gpt-5.6-terra');

  const configured = createHarness({provider: 'wawazz', envOverrides: {WAWAZZ_MODEL: 'server-selected-model', OPENAI_MODEL: 'official-only-model'}});
  assert.equal((await configured.invoke(writingRequest())).statusCode, 200);
  const configuredCall = configured.calls.find(item => item.url === 'https://wawazz.xyz/v1/responses');
  assert.equal(JSON.parse(configuredCall.options.body).model, 'server-selected-model');
});

test('WAWA outputs from both generation phases are read from output_text after reasoning items', async () => {
  const h = createHarness({provider: 'wawazz'});
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.paper.listening.parts.flatMap(part => part.questions).length, 40);
  assert.equal(result.body.paper.reading.questions.length, 40);
  assert.equal(result.body.paper.speaking.part1.length, 4);
  const calls = h.calls.filter(item => item.url === 'https://wawazz.xyz/v1/responses');
  assert.equal(calls.length, 15);
  assert.ok(calls.every(call => [4000, 6500, 7500].includes(JSON.parse(call.options.body).max_output_tokens)));
});

for (const wawaMode of ['incomplete', 'failed', 'refusal']) {
  test(`WAWA ${wawaMode} response is refused even when output contains JSON`, async () => {
    const h = createHarness({provider: 'wawazz', wawaMode});
    const result = await h.invoke(writingRequest());
    assert.ok(result.statusCode >= 400 && result.statusCode < 600);
    assert.equal(result.body.feedback, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /sk-test-never-a-real-secret|failure includes|Cannot answer/);
  });
}

for (const aiStatus of [401, 403, 429, 500]) {
  test(`WAWA ${aiStatus} never returns an upstream error or fake credential`, async () => {
    const h = createHarness({provider: 'wawazz', aiStatus});
    const result = await h.invoke(writingRequest());
    assert.equal(result.statusCode, aiStatus === 429 ? 429 : 502);
    assert.doesNotMatch(JSON.stringify(result.body), /sk-test-never-a-real-secret|failure includes/);
  });
}

test('WAWA audio has an explicit unconfigured response without quota or official API calls', async () => {
  const h = createHarness({provider: 'wawazz'});
  const result = await h.invoke({action: 'audio', script: 'This is a sufficiently long practice listening script.'});
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'TTS_NOT_CONFIGURED');
  assert.equal(h.calls.length, 0);
});

test('an unknown server provider is rejected before quota and external requests', async () => {
  const h = createHarness({provider: 'unknown-service'});
  const result = await h.invoke(writingRequest());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'AI_PROVIDER_INVALID');
  assert.equal(h.calls.length, 0);
});

test('WAWA SSE completion accepts output text deltas and ignores reasoning deltas', async () => {
  const h = createHarness({provider: 'wawazz', wawaMode: 'sse-completed'});
  const result = await h.invoke(writingRequest());
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback.overallEstimate, 7);
  assert.doesNotMatch(JSON.stringify(result.body), /ignored reasoning|sk-test-never-a-real-secret/);
});

for (const wawaMode of ['sse-incomplete', 'sse-failed']) {
  test(`WAWA ${wawaMode} rejects accumulated JSON without terminal completion`, async () => {
    const h = createHarness({provider: 'wawazz', wawaMode});
    const result = await h.invoke(writingRequest());
    assert.ok(result.statusCode >= 400 && result.statusCode < 600);
    assert.equal(result.body.feedback, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /ignored reasoning|sk-test-never-a-real-secret/);
  });
}

function deepseekHarness(overrides = {}) {
  return createHarness({
    provider: 'deepseek',
    ...overrides,
    envOverrides: {DEEPSEEK_API_KEY: fakeDeepSeekKey, ...overrides.envOverrides}
  });
}

test('DeepSeek uses its fixed official endpoint and independent key with JSON mode and thinking disabled', async () => {
  const h = deepseekHarness();
  const result = await h.invoke(writingRequest());
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback.overallEstimate, 7);
  const aiCalls = h.calls.filter(call => !call.url.startsWith('https://redis.example.test/'));
  assert.equal(aiCalls.length, 1);
  const call = aiCalls[0];
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.options.headers.Authorization, `Bearer ${fakeDeepSeekKey}`);
  assert.equal(call.options.redirect, 'error');
  const body = JSON.parse(call.options.body);
  assert.equal(body.model, 'deepseek-flash');
  assert.deepEqual(body.response_format, {type: 'json_object'});
  assert.deepEqual(body.thinking, {type: 'disabled'});
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, 4000);
  assert.doesNotMatch(JSON.stringify(call.options), new RegExp(fakeOpenAIKey));
});

test('DeepSeek does not require an OpenAI key and ignores reasoning_content', async () => {
  const h = deepseekHarness({envOverrides: {OPENAI_API_KEY: ''}});
  const result = await h.invoke(writingRequest());
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.feedback.overallEstimate, 7);
  assert.doesNotMatch(JSON.stringify(result.body), /reasoning_content|sk-deepseek-test-never-a-real-secret/);
});

test('DeepSeek cannot reuse an OpenAI or client-supplied key when its server credential is missing', async () => {
  const h = createHarness({provider: 'deepseek'});
  const result = await h.invoke(writingRequest({
    DEEPSEEK_API_KEY: fakeDeepSeekKey, apiKey: fakeDeepSeekKey, provider: 'openai'
  }));
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'AI_KEY_MISSING');
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /sk-test-never-a-real-secret|sk-deepseek-test-never-a-real-secret/);
});

test('DeepSeek ignores client-controlled endpoint, model, provider and credentials', async () => {
  const h = deepseekHarness();
  const clientKey = 'client-controlled-deepseek-credential';
  const result = await h.invoke(writingRequest({
    provider: 'wawazz', baseURL: 'https://attacker.invalid', host: 'https://attacker.invalid',
    endpoint: 'https://attacker.invalid', model: 'client-model', apiKey: clientKey,
    DEEPSEEK_API_KEY: clientKey, OPENAI_API_KEY: clientKey
  }));
  assert.equal(result.statusCode, 200);
  const aiCalls = h.calls.filter(item => !item.url.startsWith('https://redis.example.test/'));
  assert.equal(aiCalls.length, 1);
  assert.equal(aiCalls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(JSON.parse(aiCalls[0].options.body).model, 'deepseek-flash');
  assert.equal(aiCalls[0].options.headers.Authorization, `Bearer ${fakeDeepSeekKey}`);
  assert.doesNotMatch(JSON.stringify(aiCalls[0].options), /attacker\.invalid|client-controlled-deepseek-credential|client-model|sk-test-never-a-real-secret/);
});

test('DEEPSEEK_MODEL controls only DeepSeek while other provider model settings cannot override it', async () => {
  const defaults = deepseekHarness({envOverrides: {OPENAI_MODEL: 'official-only-model', WAWAZZ_MODEL: 'wawa-only-model'}});
  assert.equal((await defaults.invoke(writingRequest())).statusCode, 200);
  const defaultCall = defaults.calls.find(call => call.url === 'https://api.deepseek.com/chat/completions');
  assert.equal(JSON.parse(defaultCall.options.body).model, 'deepseek-flash');

  const configured = deepseekHarness({envOverrides: {DEEPSEEK_MODEL: 'deepseek-v4-pro', OPENAI_MODEL: 'official-only-model'}});
  assert.equal((await configured.invoke(writingRequest())).statusCode, 200);
  const configuredCall = configured.calls.find(call => call.url === 'https://api.deepseek.com/chat/completions');
  assert.equal(JSON.parse(configuredCall.options.body).model, 'deepseek-v4-pro');
});

test('DeepSeek runs eight first-stage modules then seven script- and passage-conditioned question modules', async () => {
  const h = deepseekHarness();
  const result = await h.invoke({action: 'generate', words: vocab});
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.paper.listening.parts.flatMap(part => part.questions).length, 40);
  assert.equal(result.body.paper.reading.questions.length, 40);
  assert.deepEqual(Array.from(result.body.paper.reading.passages, passage => result.body.paper.reading.questions.filter(question => question.passageId === passage.id).length), [13, 13, 14]);
  assert.equal(result.body.providerName, 'DeepSeek');
  assert.equal(result.body.audioAvailable, false);
  const calls = h.calls.filter(item => item.url === 'https://api.deepseek.com/chat/completions');
  assert.equal(calls.length, 15);
  assert.equal(h.deepseekModuleCalls.length, 15);
  assert.deepEqual(h.deepseekModuleCalls.slice(0, 8).map(call => call.key), [
    'listening-script-1', 'listening-script-2', 'listening-script-3', 'listening-script-4',
    'reading-P1', 'reading-P2', 'reading-P3', 'writing-speaking',
  ]);
  assert.deepEqual(h.deepseekModuleCalls.slice(8).map(call => call.key), [
    'listening-questions-1', 'listening-questions-2', 'listening-questions-3', 'listening-questions-4',
    'reading-questions-P1', 'reading-questions-P2', 'reading-questions-P3'
  ]);
  const expectedScripts = Array.from({length: 4}, (_, index) => {
    const script = makeDeepSeekModule({kind: 'listening-script', part: index + 1}).script;
    assert.equal(result.body.paper.listening.parts[index].script, script);
    assert.deepEqual(Array.from(result.body.paper.listening.parts[index].questions, question => question.number), Array.from({length: 10}, (_, questionIndex) => index * 10 + questionIndex + 1));
    return {words: script.trim().split(/\s+/).length, hash: createHash('sha256').update(script).digest('hex')};
  });
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key.startsWith('listening-questions-')).map(call => call.script), expectedScripts);
  assert.deepEqual(h.deepseekModuleCalls.filter(call => call.key.startsWith('reading-questions-')).map(call => call.passage), [
    {id: 'P1', words: 750}, {id: 'P2', words: 750}, {id: 'P3', words: 750}
  ]);
  const tokens = calls.map(call => JSON.parse(call.options.body).max_tokens).sort((a, b) => a - b);
  assert.deepEqual(tokens, [...Array(7).fill(4000), ...Array(4).fill(6500), 6500, ...Array(3).fill(7500)].sort((a, b) => a - b));
  assert.doesNotMatch(JSON.stringify(result.body), /reasoning_content|sk-deepseek-test-never-a-real-secret/);
});

for (const deepseekMode of ['length', 'content_filter', 'tool_calls', 'error', 'missing-finish', 'aborted', 'insufficient_system_resource']) {
  test(`DeepSeek finish_reason ${deepseekMode} rejects otherwise valid JSON`, async () => {
    const h = deepseekHarness({deepseekMode});
    const result = await h.invoke(writingRequest());
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.code, deepseekMode === 'content_filter' ? 'AI_REFUSAL' : 'AI_INCOMPLETE_RESPONSE');
    assert.equal(result.body.feedback, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /sk-deepseek-test-never-a-real-secret|sk-test-never-a-real-secret|reasoning_content/);
  });
}

test('DeepSeek rejects unsupported server model configuration before spending quota or calling any provider', async () => {
  const h = deepseekHarness({envOverrides: {DEEPSEEK_MODEL: 'wrong-provider-model'}});
  const result = await h.invoke(writingRequest());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'AI_MODEL_INVALID');
  assert.equal(h.calls.length, 0);
});

for (const deepseekMode of ['reasoning-only', 'invalid-json']) {
  test(`DeepSeek ${deepseekMode} never grades from reasoning or malformed content`, async () => {
    const h = deepseekHarness({deepseekMode});
    const result = await h.invoke(writingRequest());
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.feedback, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /sk-deepseek-test-never-a-real-secret|reasoning_content|broken-json/);
  });
}

for (const aiStatus of [401, 403, 429, 500]) {
  test(`DeepSeek ${aiStatus} never exposes upstream errors or either provider credential`, async () => {
    const h = deepseekHarness({aiStatus});
    const result = await h.invoke(writingRequest());
    assert.equal(result.statusCode, aiStatus === 429 ? 429 : 502);
    assert.doesNotMatch(JSON.stringify(result.body), /failure includes|sk-deepseek-test-never-a-real-secret|sk-test-never-a-real-secret/);
  });
}

test('DeepSeek network failures redact credential-bearing exception messages', async () => {
  const h = deepseekHarness({deepseekMode: 'network-error'});
  const result = await h.invoke(writingRequest());
  assert.equal(result.statusCode, 502);
  assert.doesNotMatch(JSON.stringify(result.body), /transport failure|sk-deepseek-test-never-a-real-secret|sk-test-never-a-real-secret/);
});

test('DeepSeek trims its own server key without substituting the OpenAI credential', async () => {
  const h = deepseekHarness({envOverrides: {DEEPSEEK_API_KEY: `  " ${fakeDeepSeekKey} "  `}});
  const result = await h.invoke(writingRequest());
  assert.equal(result.statusCode, 200);
  const call = h.calls.find(item => item.url === 'https://api.deepseek.com/chat/completions');
  assert.equal(call.options.headers.Authorization, `Bearer ${fakeDeepSeekKey}`);
});

test('DeepSeek malformed key fails before quota and is not replaced by a valid OpenAI key', async () => {
  const h = deepseekHarness({envOverrides: {DEEPSEEK_API_KEY: `${fakeDeepSeekKey}\nextra`}});
  const result = await h.invoke(writingRequest());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.code, 'AI_KEY_FORMAT_INVALID');
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /sk-deepseek-test-never-a-real-secret|sk-test-never-a-real-secret/);
});

test('DeepSeek audio remains unconfigured even with both provider keys and makes no quota or network request', async () => {
  for (const DEEPSEEK_API_KEY of [fakeDeepSeekKey, '', 'invalid key']) {
    const h = deepseekHarness({envOverrides: {DEEPSEEK_API_KEY}});
    const result = await h.invoke({action: 'audio', script: 'This is a sufficiently long practice listening script.'});
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, 'TTS_NOT_CONFIGURED');
    assert.equal(h.calls.length, 0);
  }
});

function doubaoHarness(overrides = {}) {
  return deepseekHarness({
    ...overrides,
    envOverrides: {
      TTS_PROVIDER: 'doubao', DOUBAO_TTS_API_KEY: fakeDoubaoKey,
      ...overrides.envOverrides
    }
  });
}

function requestHeader(call, name) {
  const entry = Object.entries(call.options.headers).find(([header]) => header.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

const audioRequest = {action: 'audio', script: 'This is a sufficiently long practice listening script.'};
const secretPattern = /sk-test-never-a-real-secret|sk-deepseek-test-never-a-real-secret|doubao-test-never-a-real-secret|upstash-test-never-a-real-secret/;

test('capabilities reports only public metadata without consuming quota or making outgoing requests', async () => {
  for (const [provider, providerName, audioAvailable, audioProviderName] of [
    ['openai', 'OpenAI', true, 'OpenAI'],
    ['deepseek', 'DeepSeek', false, null],
    ['wawazz', 'WAWA ZZ', false, null]
  ]) {
    const h = createHarness({provider});
    const result = await h.invoke({action: 'capabilities'});
    assert.equal(result.statusCode, 200);
    assert.deepEqual(Object.keys(result.body).sort(), ['audioAvailable', 'audioProviderName', 'providerName']);
    assert.equal(result.body.providerName, providerName);
    assert.equal(result.body.audioAvailable, audioAvailable);
    assert.equal(result.body.audioProviderName, audioProviderName);
    assert.equal(h.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result.body), secretPattern);
  }
});

test('DeepSeek generation and capabilities agree on configured Doubao audio availability', async () => {
  const h = doubaoHarness();
  const capabilities = await h.invoke({action: 'capabilities'});
  assert.equal(capabilities.statusCode, 200);
  assert.equal(capabilities.body.providerName, 'DeepSeek');
  assert.equal(capabilities.body.audioAvailable, true);
  assert.ok(typeof capabilities.body.audioProviderName === 'string' && capabilities.body.audioProviderName);
  assert.equal(h.calls.length, 0);
  const generated = await h.invoke({action: 'generate', words: vocab});
  assert.equal(generated.statusCode, 200);
  assert.equal(generated.body.audioAvailable, true);
  assert.equal(generated.body.audioProviderName, capabilities.body.audioProviderName);
  assert.equal(h.calls.filter(call => call.url === doubaoEndpoint).length, 0);
});

test('Doubao synthesis uses a fixed v3 endpoint and only its independent API key', async () => {
  const h = doubaoHarness();
  const result = await h.invoke(audioRequest);
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Content-Type'], 'audio/mpeg');
  assert.ok(Buffer.isBuffer(result.body));
  assert.deepEqual(result.body, mockMp3);
  const speech = h.calls.find(call => call.url === doubaoEndpoint);
  assert.ok(speech);
  assert.equal(speech.options.redirect, 'error');
  assert.equal(requestHeader(speech, 'X-Api-Key'), fakeDoubaoKey);
  assert.equal(requestHeader(speech, 'X-Api-Resource-Id'), 'seed-tts-2.0');
  assert.match(requestHeader(speech, 'X-Api-Request-Id'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(requestHeader(speech, 'Authorization'), undefined);
  const body = JSON.parse(speech.options.body);
  assert.equal(body.req_params.text, audioRequest.script);
  assert.equal(body.req_params.speaker, 'ICL_uranus_en_male_alastor_tob');
  assert.deepEqual(body.req_params.audio_params, {format: 'mp3', sample_rate: 24000});
  assert.deepEqual(JSON.parse(body.req_params.additions), {explicit_language: 'en'});
  assert.doesNotMatch(JSON.stringify(speech.options), /sk-test-never-a-real-secret|sk-deepseek-test-never-a-real-secret|upstash-test-never-a-real-secret/);
  assert.equal(h.calls.filter(call => !call.url.startsWith('https://redis.example.test/')).length, 1);
  const quota = h.calls.find(call => call.url.startsWith('https://redis.example.test/'));
  assert.ok(quota);
  assert.deepEqual(JSON.parse(quota.options.body).map(command => command[0]), ['INCR', 'EXPIRE']);
});

test('Doubao audio does not require an OpenAI or DeepSeek key and never reuses text credentials', async () => {
  const h = doubaoHarness({envOverrides: {OPENAI_API_KEY: '', DEEPSEEK_API_KEY: ''}});
  const result = await h.invoke(audioRequest);
  assert.equal(result.statusCode, 200);
  const speech = h.calls.find(call => call.url === doubaoEndpoint);
  assert.equal(requestHeader(speech, 'X-Api-Key'), fakeDoubaoKey);
  assert.equal(h.calls.some(call => call.url.includes('api.openai.com') || call.url.includes('api.deepseek.com')), false);
});

test('Doubao ignores client-controlled provider, host, key, voice, format and resource overrides', async () => {
  const h = doubaoHarness();
  const result = await h.invoke({
    ...audioRequest,
    TTS_PROVIDER: 'openai', ttsProvider: 'openai', provider: 'openai',
    endpoint: 'https://attacker.invalid', host: 'https://attacker.invalid', baseURL: 'https://attacker.invalid',
    apiKey: 'client-controlled-speech-secret', DOUBAO_TTS_API_KEY: 'client-controlled-speech-secret',
    voice: 'client-voice', speaker: 'client-voice', resourceId: 'client-resource',
    format: 'wav', sample_rate: 8000
  });
  assert.equal(result.statusCode, 200);
  const speech = h.calls.find(call => call.url === doubaoEndpoint);
  assert.ok(speech);
  assert.equal(requestHeader(speech, 'X-Api-Key'), fakeDoubaoKey);
  assert.doesNotMatch(JSON.stringify(speech.options), /attacker\.invalid|client-controlled-speech-secret|client-voice|client-resource/);
  assert.equal(JSON.parse(speech.options.body).req_params.audio_params.format, 'mp3');
  assert.equal(JSON.parse(speech.options.body).req_params.audio_params.sample_rate, 24000);
});

test('Doubao voice is configured only by the server environment', async () => {
  const h = doubaoHarness({envOverrides: {DOUBAO_TTS_VOICE: 'server-selected-voice'}});
  const result = await h.invoke({...audioRequest, voice: 'client-voice'});
  assert.equal(result.statusCode, 200);
  const speech = h.calls.find(call => call.url === doubaoEndpoint);
  assert.equal(JSON.parse(speech.options.body).req_params.speaker, 'server-selected-voice');
});

test('Doubao removes pasted outer whitespace and matching quotes from only its own credential', async () => {
  const h = doubaoHarness({envOverrides: {DOUBAO_TTS_API_KEY: `  " ${fakeDoubaoKey} "  `}});
  const result = await h.invoke(audioRequest);
  assert.equal(result.statusCode, 200);
  const speech = h.calls.find(call => call.url === doubaoEndpoint);
  assert.equal(requestHeader(speech, 'X-Api-Key'), fakeDoubaoKey);
});

for (const DOUBAO_TTS_API_KEY of ['', '   ', 'invalid key']) {
  test('missing or malformed Doubao credentials cannot fall back to configured text keys or client secrets', async () => {
    const h = doubaoHarness({envOverrides: {DOUBAO_TTS_API_KEY}});
    const result = await h.invoke({...audioRequest, DOUBAO_TTS_API_KEY: fakeDoubaoKey, apiKey: fakeDoubaoKey});
    assert.equal(result.statusCode, 503);
    assert.equal(h.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result.body), secretPattern);
    const capabilities = await h.invoke({action: 'capabilities'});
    assert.equal(capabilities.statusCode, 200);
    assert.equal(capabilities.body.audioAvailable, false);
    assert.equal(capabilities.body.audioProviderName, null);
    assert.equal(h.calls.length, 0);
  });
}

test('old Doubao app/access-token variables cannot silently substitute for a missing v3 API key', async () => {
  const h = doubaoHarness({envOverrides: {
    DOUBAO_TTS_API_KEY: '', DOUBAO_APP_ID: 'legacy-app-id', DOUBAO_ACCESS_TOKEN: 'legacy-secret-token',
    DOUBAO_TTS_APP_ID: 'legacy-app-id', DOUBAO_TTS_ACCESS_TOKEN: 'legacy-secret-token'
  }});
  const result = await h.invoke(audioRequest);
  assert.equal(result.statusCode, 503);
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result.body), /legacy-app-id|legacy-secret-token/);
});

for (const script of [undefined, '', 'too short', 123, ' '.repeat(40), 'x'.repeat(8001)]) {
  test('invalid listening script is rejected before quota or Doubao requests', async () => {
    const h = doubaoHarness();
    const result = await h.invoke({action: 'audio', script});
    assert.equal(result.statusCode, 400);
    assert.equal(h.calls.length, 0);
  });
}

test('an 8000-character listening script is accepted by the Doubao branch', async () => {
  const h = doubaoHarness();
  const script = 'a'.repeat(8000);
  const result = await h.invoke({action: 'audio', script});
  assert.equal(result.statusCode, 200);
  const speech = h.calls.find(call => call.url === doubaoEndpoint);
  assert.equal(JSON.parse(speech.options.body).req_params.text, script);
});

for (const redisMode of ['http-error', 'over-limit']) {
  test(`Doubao respects Redis ${redisMode} without sending the speech key or script upstream`, async () => {
    const h = doubaoHarness({redisMode});
    const result = await h.invoke(audioRequest);
    assert.equal(result.statusCode, redisMode === 'over-limit' ? 429 : 503);
    assert.equal(h.calls.some(call => call.url === doubaoEndpoint), false);
    assert.doesNotMatch(JSON.stringify(h.calls), /doubao-test-never-a-real-secret/);
  });
}

for (const doubaoMode of ['error-terminal', 'empty', 'invalid-base64', 'noncanonical-base64', 'invalid-json', 'oversized', 'aggregate-oversized', 'network-error', 'body-error']) {
  test(`Doubao ${doubaoMode} never returns partial or invalid audio or exposes upstream diagnostics`, async () => {
    const h = doubaoHarness({doubaoMode});
    const result = await h.invoke(audioRequest);
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.code, {
      'error-terminal': 'TTS_UPSTREAM_ERROR',
      empty: 'TTS_EMPTY_RESPONSE',
      'invalid-base64': 'TTS_INVALID_RESPONSE',
      'noncanonical-base64': 'TTS_INVALID_RESPONSE',
      'invalid-json': 'TTS_INVALID_RESPONSE',
      oversized: 'TTS_AUDIO_TOO_LARGE',
      'aggregate-oversized': 'TTS_AUDIO_TOO_LARGE',
      'network-error': 'TTS_CONNECTION_FAILED',
      'body-error': 'TTS_CONNECTION_FAILED'
    }[doubaoMode]);
    assert.equal(Buffer.isBuffer(result.body), false);
    assert.equal(result.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.doesNotMatch(JSON.stringify(result.body), secretPattern);
    assert.doesNotMatch(JSON.stringify(result.body), /speech error includes|speech transport failure|body failure includes|broken-ndjson|invalid-base64/);
  });
}

test('Doubao accepts EOF after valid audio chunks without a terminal frame', async () => {
  const h = doubaoHarness({doubaoMode: 'missing-terminal'});
  const result = await h.invoke(audioRequest);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, mockMp3);
});

test('Doubao decodes unpadded Base64 chunks from text/plain streams', async () => {
  const h = doubaoHarness({doubaoMode: 'unpadded-base64'});
  const result = await h.invoke(audioRequest);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, mockMp3);
});

test('Doubao skips successful metadata frames with null audio data', async () => {
  const h = doubaoHarness({doubaoMode: 'null-audio-frame'});
  const result = await h.invoke(audioRequest);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, mockMp3);
});

test('Doubao NDJSON frames are decoded correctly when network chunks split every seven bytes', async () => {
  const h = doubaoHarness({doubaoMode: 'chunked'});
  const result = await h.invoke(audioRequest);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, mockMp3);
});

test('an unknown TTS provider or invalid voice disables audio before any quota or network access', async () => {
  for (const envOverrides of [
    {TTS_PROVIDER: 'untrusted-service'},
    {DOUBAO_TTS_VOICE: 'not a valid voice'},
    {DOUBAO_TTS_VOICE: 'https://attacker.invalid/voice'}
  ]) {
    const h = doubaoHarness({envOverrides});
    const result = await h.invoke(audioRequest);
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, 'TTS_NOT_CONFIGURED');
    assert.equal(h.calls.length, 0);
    const capabilities = await h.invoke({action: 'capabilities'});
    assert.equal(capabilities.body.audioAvailable, false);
    assert.equal(capabilities.body.audioProviderName, null);
    assert.doesNotMatch(JSON.stringify(capabilities.body), /attacker|untrusted-service|voice/);
  }
});

test('explicit official OpenAI TTS in WAWA or DeepSeek mode requires its own official speech key', async () => {
  for (const provider of ['wawazz', 'deepseek']) {
    const h = createHarness({provider, envOverrides: {TTS_PROVIDER: 'openai', DEEPSEEK_API_KEY: fakeDeepSeekKey}});
    const result = await h.invoke(audioRequest);
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.code, 'TTS_NOT_CONFIGURED');
    assert.equal(h.calls.length, 0);

    const isolatedSpeechKey = 'official-speech-only-test-secret';
    const configured = createHarness({provider, envOverrides: {TTS_PROVIDER: 'openai', OPENAI_TTS_API_KEY: isolatedSpeechKey, DEEPSEEK_API_KEY: fakeDeepSeekKey}});
    const success = await configured.invoke(audioRequest);
    assert.equal(success.statusCode, 200);
    const call = configured.calls.find(item => item.url === 'https://api.openai.com/v1/audio/speech');
    assert.equal(requestHeader(call, 'Authorization'), `Bearer ${isolatedSpeechKey}`);
    assert.doesNotMatch(JSON.stringify(call.options), /sk-test-never-a-real-secret|sk-deepseek-test-never-a-real-secret/);
  }
});

for (const ttsStatus of [401, 403, 429, 500]) {
  test(`Doubao HTTP ${ttsStatus} never returns either provider key or upstream error details`, async () => {
    const h = doubaoHarness({ttsStatus});
    const result = await h.invoke(audioRequest);
    assert.equal(result.statusCode, 502);
    assert.equal(result.body.code, 'TTS_UPSTREAM_ERROR');
    assert.equal(Buffer.isBuffer(result.body), false);
    assert.doesNotMatch(JSON.stringify(result.body), secretPattern);
    assert.doesNotMatch(JSON.stringify(result.body), /speech error includes/);
  });
}
