const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const root = process.env.REVIEW_ROOT || path.resolve(__dirname, '..');
class Target {
  constructor() { this.listeners = new Map(); this.classList = {add(){}, remove(){},toggle(){}}; this.style={}; this.dataset={}; this.value=''; this.textContent=''; }
  addEventListener(type, fn) { const list=this.listeners.get(type)||[]; list.push(fn); this.listeners.set(type,list); }
  removeEventListener(type,fn) { this.listeners.set(type,(this.listeners.get(type)||[]).filter(x=>x!==fn)); }
  async emit(type, event={}) { for (const fn of [...(this.listeners.get(type)||[])]) await fn(event); }
  appendChild() {} querySelector() { return new Target(); }
}
function setup(kind='desktop') {
  const elements=new Map();
  const document=new Target();
  document.getElementById=id=> { if(!elements.has(id)) elements.set(id,new Target()); return elements.get(id); };
  document.querySelectorAll=()=>[];
  document.createElement=()=>new Target();
  document.activeElement={closest:()=>true};
  const window=new Target();
  Object.assign(window,{location:{search:'',protocol:'https:',host:'example.invalid',origin:'https://example.invalid'},matchMedia:()=>({matches:false}),innerWidth:1200,history:{replaceState(){}}});
  const timers=[];
  const sockets=[];
  class MockSocket {
    static OPEN=1;
    constructor(){this.readyState=1;this.sent=[];sockets.push(this);}
    send(raw){this.sent.push(JSON.parse(raw));}
  }
  class MockTerminal {
    constructor(options){this.options=options;this.cols=120;this.rows=30;this.writes=[];}
    dispose(){this.disposed=true;}
    loadAddon(addon){addon.term=this;}
    open(){} focus(){} clear(){this.writes=[];}
    write(v){this.writes.push(v);} writeln(v){this.writes.push(v+'\n');}
    onData(fn){this.onInput=fn;} onResize(){} getSelection(){return '';}
    attachCustomKeyEventHandler(fn){this.keyHandler=fn;}
    resize(cols,rows){this.cols=cols;this.rows=rows;}
  }
  class MockFit {fit(){} proposeDimensions(){return {rows:30,cols:120};}}
  const context=vm.createContext({window,document,navigator:{userAgent:'offline-test'},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},URLSearchParams,console,WebSocket:MockSocket,Terminal:MockTerminal,FitAddon:{FitAddon:MockFit},WebLinksAddon:{WebLinksAddon:class{}},setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearTimeout(){},setInterval:()=>1,clearInterval(){}});
  let source=fs.readFileSync(path.join(root,kind==='desktop'?'docs/app.js':'docs/remote.html'),'utf8');
  if(kind==='phone') source=source.match(/<script>\s*(class PhoneClient[\s\S]*?)<\/script>/)[1];
  vm.runInContext(source+'\n;globalThis.Client = '+(kind==='desktop'?'TerminalHub':'PhoneClient')+';',context);
  const client=new context.Client();
  return {client,document,window,elements,sockets,timers};
}
function openAndAttach() {
 const s=setup();s.client.connect();s.sockets[0].onopen();s.client.sessions=[{id:'sample-session',type:'native',shell:'sample'}];
 s.client.attachSession('sample-session');
 s.client.handleMessage({type:'buffer',sessionId:'sample-session',data:'saved display\n'});
 s.client.handleMessage({type:'info',sessionId:'sample-session',sessionType:'native',hasPty:true});
 return s;
}
test('initial desktop attach sends one attach and repeated selection is a no-op',()=>{
 const s=openAndAttach();const sock=s.sockets[0];assert.equal(sock.sent.filter(x=>x.type==='attach').length,1);
 s.client.attachSession('sample-session');assert.equal(sock.sent.filter(x=>x.type==='attach').length,1);
});
test('desktop reconnect restores selected attachment after a network interruption',()=>{
 const s=openAndAttach(); s.sockets[0].onclose({code:1006,reason:'offline test'});
 s.timers.find(x=>x.delay===1000).fn();s.sockets[1].onopen();
 assert.equal(s.sockets[1].sent.filter(x=>x.type==='attach'&&x.sessionId==='sample-session').length,1);
});
test('desktop deliberately detached sessions stay detached after reconnect',()=>{
 const s=openAndAttach();s.client.detachSession();s.sockets[0].onclose({code:1006,reason:'offline test'});
 s.timers.find(x=>x.delay===1000).fn();s.sockets[1].onopen();
 assert.equal(s.sockets[1].sent.filter(x=>x.type==='attach').length,0);
});
test('server session list does not hide a missing reconnect attachment',()=>{
 const s=openAndAttach();s.sockets[0].onclose({code:1006,reason:''});
 s.timers.find(x=>x.delay===1000).fn();s.sockets[1].onopen();
 s.client.handleMessage({type:'sessions',sessions:[{id:'sample-session',type:'native',shell:'sample'}]});
 assert.equal(s.sockets[1].sent.filter(x=>x.type==='attach').length,1);
});
test('each replacement socket reattaches exactly once through three reconnects',()=>{
 const s=openAndAttach();
 for(let n=0;n<3;n++){
   s.sockets[n].onclose({code:1006,reason:''});
   s.timers.filter(x=>x.delay===1000).at(-1).fn();s.sockets[n+1].onopen();
   assert.equal(s.sockets[n+1].sent.filter(x=>x.type==='attach').length,1);
   s.client.handleMessage({type:'buffer',sessionId:'sample-session',data:'restored '+n});
   s.client.handleMessage({type:'info',sessionId:'sample-session',sessionType:'native',hasPty:true});
   assert.equal(s.client.terminalBuffer,'restored '+n);
   s.client.attachSession('sample-session');
   assert.equal(s.sockets[n+1].sent.filter(x=>x.type==='attach').length,1);
 }
});
test('reconnect before attachment confirmation still requests selected session once',()=>{
 const s=openAndAttach();s.client.pendingAttachSessionId='sample-session';
 s.sockets[0].onclose({code:1006,reason:''});
 s.timers.find(x=>x.delay===1000).fn();s.sockets[1].onopen();
 assert.equal(s.sockets[1].sent.filter(x=>x.type==='attach').length,1);
});
test('a new connection without a selection sends no attach',()=>{
 const s=setup();s.client.connect();s.sockets[0].onopen();
 assert.equal(s.sockets[0].sent.filter(x=>x.type==='attach').length,0);
});
test('an auth rejection never schedules another connection',()=>{
 const s=openAndAttach();const before=s.timers.length;
 s.sockets[0].onclose({code:4001,reason:'Invalid token'});
 assert.equal(s.timers.length,before);
 assert.equal(s.client.authError.textContent,'Invalid token');
});
