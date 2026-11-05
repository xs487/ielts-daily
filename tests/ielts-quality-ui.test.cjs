const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=require('./ai-source.cjs');
const settle=()=>new Promise(resolve=>setImmediate(resolve));

function makePaper(){
  return {
    date:'2026-11-05',audioAvailable:true,
    listening:{parts:[0,1,2,3].map(index=>({
      title:`Part ${index+1}`,scenario:'An original practice conversation.',
      script:`PRIVATE_SCRIPT_${index+1}\nThe original speaker provides an answer.`,
      questions:[{number:index*10+1,format:'text',prompt:`Complete item ${index+1}.`,answer:index===0?'1.5':'research',acceptedAnswers:[],
        explanation:`PRIVATE_EXPLANATION_${index+1}`,evidence:`PRIVATE_EVIDENCE_${index+1}`,evidenceStatus:'supported',skill:'number',
        distractorNotes:[{option:'15',reason:'PRIVATE_DISTRACTOR_REASON'}]}]
    }))},
    reading:{passages:[{id:'P1',title:'Original source',text:'The researchers measured temperature.'}],questions:[{
      number:1,passageId:'P1',format:'tfng',prompt:'The researchers preferred summer.',
      options:['TRUE','FALSE','NOT GIVEN'],answer:'NOT GIVEN',explanation:'文中没有提供季节偏好的信息。',
      evidence:'The researchers measured temperature.',evidenceStatus:'not_given',skill:'information_absence'
    }]},
    writing:{
      task1:{prompt:'Summarise the table.',chart:{title:'Original survey',categories:['A','B','C','D'],series:[{name:'2020 (%)',values:[10,20,30,40]},{name:'2025 (%)',values:[20,30,20,30]}]}},
      task2:{prompt:'Discuss the role of public libraries.'}
    },
    speaking:{part1:[],part2:{cueCard:''},part3:[]},
    answers:{listen:{},read:{}},responses:{task1:Array(45).fill('research').join(' '),task2:Array(45).fill('library').join(' ')},results:{},grades:{}
  };
}

function harness(initial=makePaper()){
  let paper=initial;
  const listeners={},calls=[],main={innerHTML:''},location={hash:'#ai'};
  const window={addEventListener(){},IELTSApp:{getAIExam:()=>paper,setAIExam:value=>{paper=value;return true;},getTodayWords:()=>[{word:'research'}],today:()=>paper.date}};
  const sandbox={window,location,Map,Date,console,setTimeout,URL:{revokeObjectURL(){}},
    document:{querySelector:selector=>selector==='#main'?main:null,addEventListener:(event,handler)=>{listeners[event]=handler;}},
    fetch:async(url,options)=>{
      assert.equal(url,'/api/ielts');
      const body=JSON.parse(options.body);calls.push(body);
      if(body.action==='capabilities')return {ok:true,json:async()=>({providerName:'DeepSeek',audioAvailable:true,audioProviderName:'豆包语音'})};
      if(body.action==='grade-writing')return {ok:true,json:async()=>({feedback:{overallEstimate:6,taskResponse:6,coherenceCohesion:6,lexicalResource:6,grammarAccuracy:6,strengths:[],priorities:[],sentenceCorrections:[],feedback:'练习反馈'}})};
      throw new Error(`Unexpected request ${body.action}`);
    }};
  vm.runInNewContext(source,sandbox);
  const click=(action,extra={})=>listeners.click({target:{closest:()=>({dataset:{aiAction:action,...extra}})}});
  return {paper:()=>paper,calls,main,click,render:()=>{main.innerHTML=window.IELTSAIPractice.render();}};
}

test('numeric marking preserves decimal separators and accepts harmless final punctuation',async()=>{
  const paper=makePaper();
  paper.listening.parts[0].questions=[
    {number:1,format:'text',prompt:'Distance one?',answer:'1.5'},
    {number:2,format:'text',prompt:'Distance two?',answer:'1.5'},
    {number:3,format:'text',prompt:'Distance three?',answer:'15'}
  ];
  paper.answers.listen={1:'15',2:' １.５.  ',3:'1.5'};
  const h=harness(paper);h.render();await settle();h.click('submit-listen');
  assert.equal(h.paper().results.listen.correct,1);
  assert.match(h.main.innerHTML,/ai-question answer-wrong" id="listen-q1"/);
  assert.match(h.main.innerHTML,/ai-question answer-correct" id="listen-q2"/);
  assert.match(h.main.innerHTML,/ai-question answer-wrong" id="listen-q3"/);
});

async function checkAnswerCases(cases,format='text'){
  const paper=makePaper();
  paper.listening.parts.forEach(part=>{part.questions=[];});
  paper.listening.parts[0].questions=cases.map(([answer,value,expected,alternatives,prompt],index)=>({
    number:index+1,format,prompt:prompt||`Check answer ${index+1}.`,answer,acceptedAnswers:alternatives||[],
    ...(format==='choice'?{options:[answer,value,'another option']}:{}),explanation:'Original fixture.'
  }));
  paper.answers.listen=Object.fromEntries(cases.map(([,value],index)=>[index+1,value]));
  const h=harness(paper);h.render();await settle();h.click('submit-listen');
  assert.equal(h.paper().results.listen.correct,cases.filter(([, ,expected])=>expected).length);
  cases.forEach(([answer,value,expected],index)=>assert.ok(
    h.main.innerHTML.includes(`ai-question answer-${expected?'correct':'wrong'}" id="listen-q${index+1}"`),
    `${JSON.stringify(value)} should ${expected?'match':'not match'} ${JSON.stringify(answer)}`
  ));
}

test('text marking accepts explicitly listed British and American spelling equivalents',async()=>{
  await checkAnswerCases([
    ['neighbouring','neighboring',true],['neighboring','neighbouring',true],
    ['colour','color',true],['color','colour',true],['research centre','research center',true],
    ['theatres','theaters',true],['30 square metres','30 square meters',true],
    ['behavioural','behavioral',true],['travelling','traveling',true],
    ['organisation','organization',true],['analysed','analyzed',true],
    ['unlisted main answer','research center',true,['research centre']]
  ]);
});

test('text marking retains meaningful spelling, plurality, articles, hyphens and numeric separators',async()=>{
  await checkAnswerCases([
    ['colour','colr',false],['soul','sol',false],['course','corse',false],
    ['centre','centres',false],['gardens','garden',false],['colour','colors',false],
    ['a single crop','single crop',false],['the centre','center',false],
    ['student-led','student led',false],['1.5','15',false],['1,500','15',false],
    ['1/2','12',false],['room 1.5','room 15',false],['thirty','30',false]
  ]);
});

test('text marking accepts unambiguous full-month date order and ordinal variants',async()=>{
  await checkAnswerCases([
    ['28 November','28th November',true],['28 November','November 28th',true],
    ['November 28','28th of November',true],['twenty-eighth of November','28th November',true],
    ['twenty eighth November','November 28th',true],['1 January','January 1st',true],
    ['22 March','March 22nd',true],['23 April','April 23rd',true],['11 May','May 11th',true],
    ['28 November 2026','November 28th, 2026',true],['November 28, 2026','28th of November 2026',true],
    ['29 February 2024','February 29th, 2024',true],['29 February','February 29th',true]
  ]);
});

test('date matching preserves years and rejects ambiguous, invalid or expanded dates',async()=>{
  await checkAnswerCases([
    ['28 November 2026','November 28th 2027',false],['28 November 2026','November 28th',false],
    ['28 November','November 28th 2026',false],['28 November','29 November',false],
    ['28 November','28 December',false],['1 February','01/02',false],['2 January','01/02',false],
    ['01/02','02/01',false],['28 November','the 28th of November',false],
    ['28 November','by November 28th',false],['28 November','28st November',false],
    ['11 May','May 11st',false],['31 November','November 31st',false],
    ['29 February 2025','February 29th 2025',false],['1.5 November','15 November',false],
    ['28 November','date:11:28:',false]
  ]);
});

test('choice labels keep exact text matching without spelling or date equivalence',async()=>{
  await checkAnswerCases([
    ['colour','color',false],['28 November','November 28th',false],
    ['research centre',' RESEARCH CENTRE. ',true]
  ],'choice');
});

test('text marking enforces stated word and number limits before equivalent date matching',async()=>{
  await checkAnswerCases([
    ['28 November','November 28th',true,[], 'Write NO MORE THAN ONE WORD AND/OR A NUMBER.'],
    ['28 November','28th of November',false,[], 'Write NO MORE THAN ONE WORD AND/OR A NUMBER.'],
    ['28 November','twenty-eighth of November',false,[], 'Write NO MORE THAN TWO WORDS.'],
    ['28 November','28th of November',true,[], 'Write NO MORE THAN TWO WORDS AND/OR A NUMBER.'],
    ['28 November','twenty-eighth of November',true,[], 'Write NO MORE THAN THREE WORDS.'],
    ['28 November 2026','November 28th, 2026',false,[], 'Write NO MORE THAN THREE WORDS AND/OR A NUMBER.'],
    ['28 November 2026','28 November 2026',false,[], 'Write NO MORE THAN THREE WORDS AND A NUMBER.'],
    ['28 November 2026','November 28th, 2026',true,[], 'Write NO MORE THAN THREE WORDS.'],
    ['28 November 2026','November 28th, 2026',true,[], 'Give the date.'],
    ['student-led','student-led',true,[], 'Write ONE WORD ONLY.'],
    ['research centre','research center',true,[], 'Write 2 WORDS ONLY.'],
    ['research centre','research center',false,[], 'Write ONE WORD ONLY.'],
    ['a single crop','a single crop',false,[], 'Write TWO WORDS ONLY.'],
    ['28','28',true,[], 'Write ONE WORD OR A NUMBER.'],
    ['28 November','November 28th',false,[], 'Write ONE WORD OR A NUMBER.'],
    ['1.5 metres','1.5 meters',true,[], 'Write ONE WORD AND/OR A NUMBER.'],
    ['$28 per person','$28 per person',false,[], 'Write TWO WORDS AND/OR A NUMBER.'],
    ['28 dollars per person','28 dollars per person',false,[], 'Write TWO WORDS AND/OR A NUMBER.'],
    ['the research centre','the research center',true,[], 'Give the location.']
  ]);
});

test('grouped phone numbers count as one number only for explicit phone questions',async()=>{
  const instruction='Write NO MORE THAN THREE WORDS AND/OR A NUMBER.';
  await checkAnswerCases([
    ['01632 960422','01632 960422',true,[], `Phone number: ${instruction}`],
    ['+44 (1632) 960-422','+44 (1632) 960-422',true,[], `Telephone: ${instruction}`],
    ['07700 900 412','07700 900 412',true,[], `Mobile: ${instruction}`],
    ['123 4567','123 4567',true,[], `Contact number: ${instruction}`],
    ['12345 67890 12345','12345 67890 12345',true,[], `Phone number: ${instruction}`],
    ['01632 960422','01632 960422',true,[], 'Phone number: Write ONE WORD OR A NUMBER.'],
    ['01632 960422','01632 960422',true,[], 'Phone number: Write ONE WORD ONLY.'],
    ['123 456','123 456',false,[], `Phone number: ${instruction}`],
    ['12345 67890 123456','12345 67890 123456',false,[], `Phone number: ${instruction}`],
    ['01632 960422','01632 960422',false,[], `Room code: ${instruction}`],
    ['01632 960422','01632 960422',false,[], `Headphones model: ${instruction}`],
    ['room 24 25','room 24 25',false,[], `Room details: ${instruction}`],
    ['01 02','01 02',false,[], `Phone appointment date: ${instruction}`],
    ['01632 960422 ext 7','01632 960422 ext 7',false,[], `Phone number: ${instruction}`],
    ['01632 +960422','01632 +960422',false,[], `Phone number: ${instruction}`],
    ['01632 960422','01632960422',false,[], `Phone number: ${instruction}`],
    ['01632 960422','(01632) 960422',false,[], `Phone number: ${instruction}`],
    ['01632 960422','the main office number',false,['the main office number'], `Phone number: ${instruction}`],
    ['01632 960422','01632 960422 ext 7',false,['01632 960422 ext 7'], `Phone number: ${instruction}`]
  ]);
});

test('old papers with malformed accepted variants remain usable and blanks are never correct',async()=>{
  const paper=makePaper();
  paper.listening.parts[0].questions=[
    {number:1,format:'text',prompt:'One?',answer:'centre',acceptedAnswers:{alternate:'center'}},
    {number:2,format:'text',prompt:'Two?',answer:'centre',acceptedAnswers:['center',null,'']},
    {number:3,format:'text',prompt:'Three?',answer:'centre',acceptedAnswers:'center'}
  ];
  paper.answers.listen={1:'centre',2:'',3:'c'};
  const h=harness(paper);assert.doesNotThrow(()=>h.render());await settle();
  assert.doesNotThrow(()=>h.click('submit-listen'));
  assert.equal(h.paper().results.listen.correct,1);
  h.click('retry-listen');h.paper().answers.listen={2:'center'};h.click('submit-listen');
  assert.equal(h.paper().results.listen.correct,1);
});

test('evidence, explanations, distractor notes, skill review and scripts appear only after submission',async()=>{
  const h=harness();h.render();await settle();
  for(const hidden of ['PRIVATE_SCRIPT','PRIVATE_EXPLANATION','PRIVATE_EVIDENCE','PRIVATE_DISTRACTOR_REASON','本题考点','按考点复盘']){
    assert.ok(!h.main.innerHTML.includes(hidden),`${hidden} must stay hidden before submission`);
  }
  h.click('submit-listen');
  for(const visible of ['PRIVATE_SCRIPT_1','PRIVATE_EXPLANATION_1','PRIVATE_EVIDENCE_1','PRIVATE_DISTRACTOR_REASON','本题考点','按考点复盘']){
    assert.ok(h.main.innerHTML.includes(visible),`${visible} should be available after submission`);
  }
  assert.match(h.main.innerHTML,/<details class="answer-explanation"><summary>查看本部分听力原文<\/summary>/);
  assert.ok(!h.main.innerHTML.includes('PRIVATE_SCRIPT_2'));
  h.click('part',{index:'1'});assert.ok(h.main.innerHTML.includes('PRIVATE_SCRIPT_2'));
  h.click('retry-listen');assert.ok(!h.main.innerHTML.includes('PRIVATE_SCRIPT'));
  assert.ok(!h.main.innerHTML.includes('按考点复盘'));
});

test('skill review counts the entire listening paper rather than only the visible part',async()=>{
  const paper=makePaper();paper.answers.listen={1:'15',11:'research',21:'research',31:'research'};
  const h=harness(paper);h.render();await settle();h.click('submit-listen');
  assert.equal(h.paper().results.listen.correct,3);
  assert.match(h.main.innerHTML,/数字信息<\/strong>：答对 3 \/ 4；优先复习 1 题/);
  assert.ok(h.main.innerHTML.includes('复查数字、单位与更正后的最终数值。'));
  h.click('part',{index:'2'});
  assert.match(h.main.innerHTML,/数字信息<\/strong>：答对 3 \/ 4；优先复习 1 题/);
});

test('not-given evidence is labelled as related context rather than supporting proof',async()=>{
  const h=harness();h.render();await settle();h.click('skill',{skill:'read'});
  assert.ok(!h.main.innerHTML.includes('相关原文（未提供判断所需信息）'));
  h.click('submit-read');
  assert.ok(h.main.innerHTML.includes('相关原文（未提供判断所需信息）：The researchers measured temperature.'));
  assert.ok(h.main.innerHTML.includes('缺失信息判断'));
  assert.ok(!h.main.innerHTML.includes('原文依据：The researchers measured temperature.'));
});

test('legacy questions without quality metadata render normally and generated feedback is escaped',async()=>{
  const paper=makePaper();
  for(const part of paper.listening.parts)part.questions=[{number:part.questions[0].number,format:'text',prompt:'Original question?',answer:'research',explanation:'<script>bad</script>',distractorNotes:{option:'wrong'}}];
  paper.listening.parts[0].script='<img src=x onerror=alert(1)>';
  const h=harness(paper);h.render();await settle();h.click('submit-listen');
  assert.ok(!h.main.innerHTML.includes('按考点复盘'));
  assert.ok(h.main.innerHTML.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(h.main.innerHTML.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!h.main.innerHTML.includes('<img src=x'));
});

test('Task 1 assessment receives chart data and Task 2 does not',async()=>{
  const h=harness();h.render();await settle();h.click('skill',{skill:'write'});
  h.click('grade-writing',{task:'task1'});await settle();
  const task1=h.calls.find(call=>call.action==='grade-writing'&&call.task==='task1');
  assert.deepEqual(task1.chart,h.paper().writing.task1.chart);
  assert.equal(task1.chart.series[1].values[2],20);
  h.click('writing-task',{task:'task2'});h.click('grade-writing',{task:'task2'});await settle();
  const task2=h.calls.find(call=>call.action==='grade-writing'&&call.task==='task2');
  assert.equal(Object.hasOwn(task2,'chart'),false);
  assert.equal(task2.prompt,h.paper().writing.task2.prompt);
});
