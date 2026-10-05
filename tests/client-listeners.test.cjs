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
test('desktop reconnect binds text paste once',async()=>{
 const s=openAndAttach();s.client.initTerminal();s.sockets[0].sent=[];
 await s.document.emit('paste',{preventDefault(){},clipboardData:{getData:()=> 'inert sample text',items:[]}});
 assert.equal(s.sockets[0].sent.filter(x=>x.type==='input').length,1);
});
test('desktop first connection binds text paste once',async()=>{
 const s=openAndAttach();s.sockets[0].sent=[];
 await s.document.emit('paste',{preventDefault(){},clipboardData:{getData:()=> 'inert sample text',items:[]}});
 assert.equal(s.sockets[0].sent.filter(x=>x.type==='input').length,1);
});
test('phone reconnect binds toolbar and text paste once',async()=>{
 const s=setup('phone');const toolbar=new Target();toolbar.dataset.key='x';s.document.querySelectorAll=()=>[toolbar];
 const sends=[];s.client.sendData=msg=>sends.push(msg);s.client.currentSession='sample-session';
 s.client.showTerminal();s.client.disconnect();s.client.showTerminal();sends.length=0;
 await toolbar.emit('click',{preventDefault(){}});
 assert.equal(sends.filter(x=>x.type==='input').length,1);
});
test('phone reconnect binds document text paste once',async()=>{
 const s=setup('phone');const sends=[];s.client.sendData=msg=>sends.push(msg);s.client.currentSession='sample-session';
 s.client.showTerminal();s.client.disconnect();s.client.showTerminal();sends.length=0;
 await s.document.emit('paste',{preventDefault(){},clipboardData:{getData:()=> 'inert sample text'}});
 assert.equal(sends.filter(x=>x.type==='input').length,1);
});

test('desktop right-click paste uses current terminal and fires once after four setups',async()=>{
 const s=openAndAttach();for(let i=0;i<3;i++)s.client.initTerminal();
 let count=0;s.client.pasteFromClipboard=async()=>count++;
 await s.elements.get('terminal').emit('contextmenu',{preventDefault(){}});
 assert.equal(count,1);
});
test('desktop image paste uploads once after repeated terminal initialization',async()=>{
 const s=openAndAttach();for(let i=0;i<3;i++)s.client.initTerminal();
 let count=0;const file={type:'image/png'};s.client.uploadFile=async f=>{assert.equal(f,file);count++;};
 await s.document.emit('paste',{preventDefault(){},clipboardData:{items:[{type:'image/png',getAsFile:()=>file}]}});
 assert.equal(count,1);
});
test('desktop paste outside terminal stays ignored after reconnect',async()=>{
 const s=openAndAttach();s.client.initTerminal();s.document.activeElement={closest:()=>false};s.sockets[0].sent=[];
 await s.document.emit('paste',{preventDefault(){throw Error('should not prevent');},clipboardData:{getData:()=> 'inert sample'}});
 assert.equal(s.sockets[0].sent.length,0);
});
test('desktop copy and focus handlers remain single and use replacement terminal',async()=>{
 const s=openAndAttach();s.client.initTerminal();let copied=0,focused=0;
 s.client.term.getSelection=()=> 'selected sample';s.client.term.focus=()=>focused++;
 await s.document.emit('copy',{preventDefault(){},clipboardData:{setData(type,text){assert.equal(type,'text/plain');assert.equal(text,'selected sample');copied++;}}});
 await s.elements.get('terminal').emit('click');
 assert.equal(copied,1);assert.equal(focused,1);
});
test('desktop new terminal input and keyboard handlers are still wired',()=>{
 const s=openAndAttach();s.client.initTerminal();s.sockets[0].sent=[];
 s.client.term.onInput('inert sample');
 assert.equal(s.sockets[0].sent.filter(x=>x.type==='input').length,1);
 let pasted=0;s.client.pasteFromClipboard=()=>pasted++;
 assert.equal(s.client.term.keyHandler({key:'v',ctrlKey:true,type:'keydown'}),false);
 assert.equal(pasted,1);
});
test('phone toolbar, paste, upload and resize stay single after four connections',async()=>{
 const s=setup('phone');const button=new Target();button.dataset.key='x';s.document.querySelectorAll=()=>[button];
 const sends=[];s.client.sendData=x=>sends.push(x);s.client.currentSession='sample-session';
 for(let i=0;i<4;i++){if(i)s.client.disconnect();s.client.showTerminal();}
 sends.length=0;await button.emit('click',{preventDefault(){}});
 assert.equal(sends.filter(x=>x.type==='input').length,1);
 let pasted=0;s.client.pasteFromClipboard=async()=>pasted++;
 await s.elements.get('paste-btn').emit('click',{preventDefault(){}});assert.equal(pasted,1);
 let uploads=0;const file={name:'inert.png'};s.client.uploadFile=async f=>{assert.equal(f,file);uploads++;};
 await s.elements.get('file-input').emit('change',{target:{files:[file],value:'sample'}});assert.equal(uploads,1);
 let resized=0;s.client.applyResize=()=>resized++;await s.window.emit('resize');assert.equal(resized,1);
});
test('phone new terminal input and keyboard handlers are still wired',()=>{
 const s=setup('phone');const sends=[];s.client.sendData=x=>sends.push(x);s.client.currentSession='sample-session';
 s.client.showTerminal();s.client.disconnect();s.client.showTerminal();sends.length=0;
 s.client.term.onInput('inert sample');assert.equal(sends.filter(x=>x.type==='input').length,1);
 let pasted=0;s.client.pasteFromClipboard=()=>pasted++;
 assert.equal(s.client.term.keyHandler({key:'v',ctrlKey:true,type:'keydown'}),false);assert.equal(pasted,1);
});
