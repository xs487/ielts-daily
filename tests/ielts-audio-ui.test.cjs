const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function harness({available=true,holdAudio=false}={}){
  let paper={date:'2026-11-04',providerName:'Original provider',audioAvailable:false,
    listening:{parts:[0,1,2,3].map(index=>({title:`Part ${index+1}`,scenario:'Practice',script:`English listening script for part ${index+1}.`,questions:[]}))},
    answers:{listen:{},read:{}},results:{}};
  const listeners={},calls=[],main={innerHTML:''},location={hash:'#ai'};
  const player={plays:0,pauses:0,play(){this.plays++;return Promise.resolve();},pause(){this.pauses++;}};
  let finishAudio;
  const audioGate=holdAudio?new Promise(resolve=>{finishAudio=resolve;}):Promise.resolve();
  let urlCount=0;
  const window={addEventListener(){},IELTSApp:{getAIExam:()=>paper,setAIExam:value=>{paper=value;return true;},getTodayWords:()=>[{word:'research'}],today:()=>paper.date}};
  const sandbox={window,location,URL:{createObjectURL:()=>`blob:audio-${++urlCount}`,revokeObjectURL(){}},Map,Date,console,setTimeout,
    document:{querySelector:selector=>selector==='#main'?main:selector==='#ai-listening-player'?player:null,addEventListener:(name,handler)=>{listeners[name]=handler;}},
    fetch:async(url,options)=>{
      assert.equal(url,'/api/ielts');
      const body=JSON.parse(options.body);calls.push(body);
      if(body.action==='capabilities')return {ok:true,json:async()=>({providerName:'DeepSeek',audioProviderName:available?'豆包语音':null,audioAvailable:available})};
      assert.equal(body.action,'audio');await audioGate;
      return {ok:true,blob:async()=>new Blob(['sample mp3 bytes'],{type:'audio/mpeg'})};
    }};
  vm.runInNewContext(require('./ai-source.cjs'),sandbox);
  const click=(action,extra={})=>listeners.click({target:{closest:()=>({dataset:{aiAction:action,...extra}})}});
  return {render:()=>{main.innerHTML=window.IELTSAIPractice.render();},paper:()=>paper,click,calls,main,location,player,finishAudio};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('configuring speech unlocks an existing paper without regenerating or losing its provenance',async()=>{
  const h=harness();h.render();await settle();
  assert.equal(h.paper().audioAvailable,true);
  assert.equal(h.paper().providerName,'Original provider');
  assert.equal(h.paper().audioProviderName,'豆包语音');
  assert.ok(h.main.innerHTML.includes('播放本部分音频'));
  assert.equal(h.calls.filter(call=>call.action==='generate').length,0);
});

test('replaying and revisiting listening parts reuses each part’s own audio',async()=>{
  const h=harness();h.render();await settle();
  h.click('play-audio');await settle();
  h.click('play-audio');await settle();
  h.click('part',{index:'1'});h.click('play-audio');await settle();
  h.click('part',{index:'0'});h.click('play-audio');await settle();
  const audioCalls=h.calls.filter(call=>call.action==='audio');
  assert.equal(audioCalls.length,2);
  assert.ok(audioCalls[0].script.includes('part 1'));
  assert.ok(audioCalls[1].script.includes('part 2'));
  assert.ok(h.main.innerHTML.includes('src="blob:audio-1"'));
  assert.equal(h.player.plays,4);
});

test('unconfigured speech never attempts audio generation, even for a stale available paper',async()=>{
  const h=harness({available:false});h.paper().audioAvailable=true;h.render();await settle();
  assert.equal(h.paper().audioAvailable,false);
  h.click('play-audio');await settle();
  assert.equal(h.calls.filter(call=>call.action==='audio').length,0);
  assert.ok(h.main.innerHTML.includes('disabled'));
});

test('an audio response arriving after leaving practice cannot replace the home page or start playback',async()=>{
  const h=harness({holdAudio:true});h.render();await settle();
  h.click('play-audio');await settle();
  h.click('home');h.main.innerHTML='Home page';
  h.finishAudio();await settle();
  assert.equal(h.location.hash,'home');
  assert.equal(h.main.innerHTML,'Home page');
  assert.equal(h.player.plays,0);
});
