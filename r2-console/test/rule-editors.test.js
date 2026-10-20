import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Independent serialization/validation coverage. These tests intentionally exercise
// JSON shapes that a preset-only editor often normalizes or silently discards.
await import('../public/rule-editors.js');
const { parseDocument, validatePolicy, validateLifecycle, clone } = globalThis.RuleEditors;
const baseStatement = () => ({
  Sid: 'ReadObjects', Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::123456789012:root' },
  Action: 's3:GetObject', Resource: 'arn:aws:s3:::photos/*'
});
const policy = statement => ({ Version: '2012-10-17', Statement: statement ?? [baseStatement()] });
const lifecycle = rule => ({ rules: rule ?? [{ id: 'expire-temp', status: 'Enabled', prefix: 'tmp/', expirationDays: 7 }] });

for (const statementShape of ['object', 'array']) {
  for (const fieldShape of ['scalar', 'array']) {
    test(`policy import preserves ${statementShape} Statement and ${fieldShape} values`, () => {
      const statement = baseStatement();
      if (fieldShape === 'array') {
        statement.Action = [statement.Action]; statement.Resource = [statement.Resource];
        statement.Principal.AWS = [statement.Principal.AWS];
      }
      const input = policy(statementShape === 'object' ? statement : [statement]);
      const parsed = parseDocument(JSON.stringify(input), 'policy');
      assert.deepEqual(parsed, input);
      assert.notEqual(parsed, input);
      assert.deepEqual(validatePolicy(parsed), []);
    });
  }
}

test('policy condition operators, typed values, extension fields and Unicode round trip without loss', () => {
  const statement = baseStatement();
  statement.Condition = {
    StringLike: { 's3:prefix': ['团队/*', 'literal & <tag> /'] },
    Bool: { 'aws:SecureTransport': false },
    NumericLessThanEquals: { 's3:max-keys': 10 },
    'ForAnyValue:StringEqualsIfExists': { 'aws:TagKeys': ['部门', 'env'] }
  };
  statement.Extension = { list: [null, false, 0, '', { nested: [true, 'x'] }] };
  const input = { ...policy([statement]), Id: '策略-一', VendorExtension: { enabled: false } };
  assert.deepEqual(parseDocument(JSON.stringify(input), 'policy'), input);
  assert.deepEqual(clone(input), input);
});

test('policy validators never normalize or mutate their input', () => {
  const input = policy(baseStatement());
  input.Statement.Condition = { Null: { 's3:prefix': 'false' } };
  const before = JSON.stringify(input);
  validatePolicy(input);
  assert.equal(JSON.stringify(input), before);
});

test('cloning preserves own special property names without prototype pollution', () => {
  const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"values":[null,false,0,""]}');
  const copy = clone(input);
  assert.deepEqual(copy, input);
  assert.equal(Object.hasOwn(copy, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  copy.values.push('independent');
  assert.equal(input.values.length, 4);
});

for (const malformed of ['', '{', 'null', '[]', 'true', '"policy"']) {
  test(`malformed policy document is rejected: ${JSON.stringify(malformed)}`, () => {
    assert.throws(() => parseDocument(malformed, 'policy'));
  });
}

for (const invalid of [
  { Version: 'bad', Statement: [baseStatement()] },
  { Version: '2012-10-17', Statement: [] },
  policy([{ ...baseStatement(), Effect: 'Maybe' }]),
  policy([{ ...baseStatement(), Action: [] }]),
  policy([{ ...baseStatement(), Resource: 42 }]),
  policy([{ ...baseStatement(), Principal: [] }])
]) {
  test(`invalid policy is flagged without mutation: ${JSON.stringify(invalid)}`, () => {
    const before = JSON.stringify(invalid);
    assert.ok(validatePolicy(invalid).length > 0);
    assert.equal(JSON.stringify(invalid), before);
  });
}

test('lifecycle days/date and disabled rules preserve exact supported values', () => {
  const input = lifecycle([
    { id: '按天', status: 'Enabled', prefix: ' temp /', expirationDays: 1 },
    { id: '按日期', status: 'Disabled', prefix: '', expirationDate: '2028-02-29' },
    { id: 'maximum', status: 'Enabled', prefix: 'archive/', expirationDays: 36500 }
  ]);
  assert.deepEqual(parseDocument(JSON.stringify(input), 'lifecycle'), input);
  assert.deepEqual(validateLifecycle(input), []);
  assert.deepEqual(validateLifecycle({ rules: [] }), []);
});

for (const changes of [
  { expirationDays: 0 }, { expirationDays: -1 }, { expirationDays: 1.5 },
  { expirationDays: 36501 }, { expirationDays: '7' },
  { expirationDate: '2027-02-29' }, { expirationDate: '2026-13-01' },
  { expirationDate: '2026-01-01T00:00:00Z' },
  { status: 'enabled' }, { id: '' }, { prefix: null }, { abortMultipartDays: 7 }
]) {
  test(`invalid lifecycle rule is flagged: ${JSON.stringify(changes)}`, () => {
    const rule = { id: 'example', status: 'Enabled', prefix: '', expirationDays: 7, ...changes };
    if (Object.hasOwn(changes, 'expirationDate')) delete rule.expirationDays;
    const input = lifecycle([rule]);
    const before = JSON.stringify(input);
    assert.ok(validateLifecycle(input).length > 0);
    assert.equal(JSON.stringify(input), before);
  });
}

test('lifecycle rejects both expiration modes, missing expiration, duplicate IDs and unknown fields', () => {
  assert.ok(validateLifecycle(lifecycle([{ id:'both', status:'Enabled', prefix:'', expirationDays:7, expirationDate:'2028-01-01' }])).length);
  assert.ok(validateLifecycle(lifecycle([{ id:'neither', status:'Enabled', prefix:'' }])).length);
  assert.ok(validateLifecycle(lifecycle([
    { id:'same', status:'Enabled', prefix:'a/', expirationDays:7 },
    { id:'same', status:'Disabled', prefix:'b/', expirationDays:14 }
  ])).length);
  assert.ok(validateLifecycle(lifecycle([{ id:'unknown', status:'Enabled', prefix:'', expirationDays:7, Transition:{Days:1} }])).length);
  assert.ok(validateLifecycle({ rules: [], unexpected: true }).length);
});

class Element {
  constructor(tag) { this.tagName=tag.toUpperCase();this.children=[];this.attrs={};this.listeners={};this._text='';this.value='';this.disabled=false;this.style={};this.dataset={}; }
  append(...items) { items.filter(x=>x!=null).forEach(x=>{this.children.push(x);if(typeof x==='object')x.parentElement=this;}); }
  replaceChildren(...items) { this.children=[];this._text='';this.append(...items); }
  set textContent(v) { this._text=String(v??'');this.children=[]; }
  get textContent() { return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join(''); }
  setAttribute(k,v) { this.attrs[k]=String(v);if(k==='id')this.id=String(v); }
  addEventListener(k,fn) { (this.listeners[k]??=[]).push(fn); }
  dispatch(type) { return this.listeners[type]?.at(-1)?.({target:this,preventDefault(){}}); }
  click() { if(!this.disabled)return this.dispatch('click'); }
  contains(other) { return this===other || this.children.some(c=>typeof c==='object' && c.contains(other)); }
}
const walk=(root,p)=>p(root)?root:root.children.map(c=>typeof c==='object'?walk(c,p):null).find(Boolean);
const findButton=(editor,text)=>walk(editor.element,e=>e.tagName==='BUTTON'&&e.textContent===text);
const findInput=(editor,label)=>walk(editor.element,e=>e.attrs['aria-label']===label);
function withDocument(run) {
  const previous=globalThis.document;
  globalThis.document={createElement:tag=>new Element(tag)};
  try { return run(); } finally { globalThis.document=previous; }
}
// Async handlers use document after await; keep the fixture installed for their lifetime.
async function withAsyncDocument(run) {
  const previous=globalThis.document;
  globalThis.document={createElement:tag=>new Element(tag)};
  try { return await run(); } finally { globalThis.document=previous; }
}

test('form render does not mutate singleton policy or typed condition values', () => withDocument(()=>{
  const input=policy({...baseStatement(),Condition:{Bool:{'aws:SecureTransport':false},NumericEquals:{'s3:max-keys':5}}});
  const editor=globalThis.RuleEditors.createPolicyEditor(input,{bucket:'photos'});
  assert.deepEqual(editor.getValue(),input);
  assert.equal(editor.isDirty(),false);
  const preview=findInput(editor,'自动生成的策略 JSON');
  assert.equal(Object.hasOwn(preview.attrs,'readonly'),true);
  assert.deepEqual(JSON.parse(preview.value),input);
}));

test('lifecycle form edits generate JSON without applying and adding rules defaults to disabled', () => withDocument(()=>{
  let applies=0;
  const editor=globalThis.RuleEditors.createLifecycleEditor(lifecycle(),{onApply:()=>applies++});
  const prefix=findInput(editor,'匹配对象前缀');prefix.value=' 临时 /';prefix.dispatch('input');
  const days=findInput(editor,'过期天数');days.value='30';days.dispatch('input');
  assert.equal(editor.getValue().rules[0].prefix,' 临时 /');
  assert.equal(editor.getValue().rules[0].expirationDays,30);
  assert.equal(editor.isDirty(),true);assert.equal(applies,0);
  findButton(editor,'＋ 添加过期规则').click();
  assert.equal(editor.getValue().rules[1].status,'Disabled');
  assert.equal(applies,0);
}));

test('lifecycle date mode replaces days only after explicit selection', () => withDocument(()=>{
  const editor=globalThis.RuleEditors.createLifecycleEditor(lifecycle());
  const mode=findInput(editor,'过期方式');mode.value='date';mode.dispatch('change');
  assert.equal(Object.hasOwn(editor.getValue().rules[0],'expirationDays'),false);
  assert.equal(editor.getValue().rules[0].expirationDate,'');
  const date=findInput(editor,'过期日期（UTC）');date.value='2028-02-29';date.dispatch('input');
  assert.deepEqual(editor.validate(),[]);
}));

test('invalid file import leaves current edited draft intact and never applies', async () => withAsyncDocument(async()=>{
  let applies=0;
  const editor=globalThis.RuleEditors.createLifecycleEditor(lifecycle(),{onApply:()=>applies++});
  const prefix=findInput(editor,'匹配对象前缀');prefix.value='keep-me/';prefix.dispatch('input');
  const before=editor.getValue();
  const input=findInput(editor,'导入 JSON 文件');input.files=[{size:4,text:async()=>'{bad'}];
  await input.dispatch('change');
  assert.deepEqual(editor.getValue(),before);
  assert.equal(editor.isDirty(),true);assert.equal(applies,0);
  assert.match(editor.element.textContent,/JSON 格式不正确/);
}));

test('valid import only updates draft, requires replace approval when dirty and preserves rejected draft', async () => withAsyncDocument(async()=>{
  let applies=0,confirmations=0;
  const editor=globalThis.RuleEditors.createLifecycleEditor(lifecycle(),{onApply:()=>applies++,confirmReplace:async()=>{confirmations++;return false;}});
  const prefix=findInput(editor,'匹配对象前缀');prefix.value='keep-me/';prefix.dispatch('input');
  const input=findInput(editor,'导入 JSON 文件');input.files=[{size:12,text:async()=>'{"rules":[]}'}];
  await input.dispatch('change');
  assert.equal(editor.getValue().rules[0].prefix,'keep-me/');
  assert.equal(confirmations,1);assert.equal(applies,0);
  const clean=globalThis.RuleEditors.createLifecycleEditor(lifecycle(),{onApply:()=>applies++});
  const cleanInput=findInput(clean,'导入 JSON 文件');cleanInput.files=input.files;
  await cleanInput.dispatch('change');
  assert.deepEqual(clean.getValue(),{rules:[]});assert.equal(clean.isDirty(),true);assert.equal(applies,0);
}));

test('unsupported lifecycle fields remain exportable but disable apply', async () => withAsyncDocument(async()=>{
  let applies=0;
  const input={rules:[{id:'unsupported',status:'Enabled',prefix:'',expirationDays:7,Transition:{Days:1}}],future:[false,null]};
  const editor=globalThis.RuleEditors.createLifecycleEditor(input,{onApply:()=>applies++});
  assert.deepEqual(editor.getValue(),input);
  assert.deepEqual(JSON.parse(findInput(editor,'自动生成的生命周期 JSON').value),input);
  const apply=findButton(editor,'检查并应用规则');assert.equal(apply.disabled,true);
  await apply.click();assert.equal(applies,0);
}));

test('overflow numeric JSON is rejected rather than silently becoming null', () => {
  const raw='{"Version":"2012-10-17","Statement":{"Effect":"Deny","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::photos/*","Condition":{"NumericEquals":{"key":1e400}}}}';
  assert.throws(()=>parseDocument(raw,'policy'));
});

test('NotPrincipal, NotAction and NotResource structures round trip and mutual conflicts are flagged', () => {
  const input=policy({ Sid:'Negative', Effect:'Deny', NotPrincipal:{AWS:['arn:aws:iam::123456789012:root']},
    NotAction:['s3:GetObject'], NotResource:'arn:aws:s3:::photos/public/*',
    Condition:{'ForAllValues:StringNotEquals':{'aws:TagKeys':['private']}} });
  assert.deepEqual(parseDocument(JSON.stringify(input),'policy'),input);
  assert.deepEqual(validatePolicy(input),[]);
  input.Statement.Action='s3:PutObject';
  assert.ok(validatePolicy(input).length>0);
});

function appFixture(respond) {
  const body=new Element('body');
  for(const id of ['modal-root','toast-root','view']){const e=new Element('div');e.id=id;body.append(e);}
  const calls=[];
  const document={body,createElement:tag=>new Element(tag),createTextNode:text=>{const e=new Element('text');e.textContent=text;return e;},getElementById:id=>walk(body,e=>e.id===id)};
  const context=vm.createContext({document,Node:Element,RuleEditors:globalThis.RuleEditors,Headers,Response,URL,URLSearchParams,
    setTimeout:()=>1,Intl,Date,TextEncoder,
    fetch:async(url,options={})=>{calls.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined});return new Response(JSON.stringify(await respond(url,options)),{status:200});}
  });
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\ninit\(\);\s*$/,'');
  vm.runInContext(source,context);
  vm.runInContext("state.csrf='test';state.bucket='photos';state.page='bucket';state.tab='settings';render=()=>{};typedPolicyConfirmation=async()=>true;confirmDialog=async()=>true;",context);
  return {calls,evaluate:code=>vm.runInContext(code,context)};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('policy save readback does not fetch or replace a different bucket after navigation', async()=>{
  const response=deferred();
  const f=appFixture((url,options)=>options.method==='PUT'?response.promise:{policy:null});
  const operation=f.evaluate(`savePolicyJson({value:${JSON.stringify(JSON.stringify(policy()))},isVisual:true})`);
  await Promise.resolve();await Promise.resolve();
  assert.equal(f.calls[0]?.method,'PUT');
  f.evaluate("state.bucket='other';state.policy={Version:'2012-10-17',Statement:[]};state.policyLoaded=true");
  response.resolve({ok:true});await operation;
  assert.equal(f.calls.some(c=>c.url.includes('/other/')),false);
  assert.equal(f.evaluate('state.policy === null'),false);
});

test('lifecycle removal completion does not clear another bucket after navigation', async()=>{
  const response=deferred();
  const f=appFixture(()=>response.promise);
  const operation=f.evaluate('removeLifecycle()');
  await Promise.resolve();await Promise.resolve();
  assert.equal(f.calls[0]?.method,'DELETE');
  f.evaluate("state.bucket='other';state.lifecycle={rules:[{id:'preserve'}]};state.lifecycleLoaded=true");
  response.resolve({rules:[]});await operation;
  assert.equal(f.evaluate('state.lifecycle.rules[0]?.id'),'preserve');
});

test('newer policy read wins over an older response for the same bucket', async()=>{
  const first=deferred(),second=deferred();let n=0;
  const f=appFixture(()=>++n===1?first.promise:second.promise);
  const older=f.evaluate('loadPolicy(true)');
  const newer=f.evaluate('loadPolicy(true)');
  second.resolve({policy:{Version:'2012-10-17',Id:'newer',Statement:[]}});await newer;
  first.resolve({policy:{Version:'2012-10-17',Id:'stale',Statement:[]}});await older;
  assert.equal(f.evaluate('state.policy.Id'),'newer');
});

test('newer lifecycle read wins over an older response for the same bucket', async()=>{
  const first=deferred(),second=deferred();let n=0;
  const f=appFixture(()=>++n===1?first.promise:second.promise);
  const older=f.evaluate('loadLifecycle()');
  const newer=f.evaluate('loadLifecycle()');
  second.resolve({rules:[{id:'newer'}]});await newer;
  first.resolve({rules:[{id:'stale'}]});await older;
  assert.equal(f.evaluate('state.lifecycle.rules[0].id'),'newer');
});

test('unsafe integer JSON is rejected rather than rounded during import',()=>{
  const raw='{"Version":"2012-10-17","Statement":{"Effect":"Deny","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::photos/*","Condition":{"NumericEquals":{"key":9007199254740993}}}}';
  assert.throws(()=>parseDocument(raw,'policy'));
});

test('while apply is pending, fieldset/import and external draft replacement are blocked',async()=>withAsyncDocument(async()=>{
  const done=deferred();
  const editor=globalThis.RuleEditors.createLifecycleEditor(lifecycle([{id:'a',status:'Disabled',prefix:'',expirationDays:7}]),{onApply:()=>done.promise});
  const operation=findButton(editor,'检查并应用规则').click();
  assert.equal(editor.isBusy(),true);
  assert.equal(walk(editor.element,e=>e.tagName==='FIELDSET').disabled,true);
  assert.equal(findButton(editor,'导入 JSON 到草稿').disabled,true);
  assert.equal(editor.setValue({rules:[]}),false);
  assert.equal(editor.getValue().rules.length,1);
  done.resolve();await operation;
  assert.equal(editor.isBusy(),false);
  assert.equal(walk(editor.element,e=>e.tagName==='FIELDSET').disabled,false);
}));

test('invalid number draft blocks export/apply, and correcting it restores valid numeric JSON',()=>withDocument(()=>{
  const input=policy({...baseStatement(),Condition:{NumericEquals:{'s3:max-keys':5}}});
  const editor=globalThis.RuleEditors.createPolicyEditor(input);
  const number=findInput(editor,'附加条件 / NumericEquals / s3:max-keys');
  number.value='1e400';number.dispatch('input');
  assert.equal(editor.getValue().Statement.Condition.NumericEquals['s3:max-keys'],5);
  assert.equal(findButton(editor,'导出 JSON（不应用）').disabled,true);
  assert.equal(findButton(editor,'检查并应用策略').disabled,true);
  number.value='7';number.dispatch('input');
  assert.equal(editor.getValue().Statement.Condition.NumericEquals['s3:max-keys'],7);
  assert.equal(findButton(editor,'导出 JSON（不应用）').disabled,false);
  assert.equal(findButton(editor,'检查并应用策略').disabled,false);
}));

test('policy apply blocks backend-unsupported exclusion modes but export retains them',()=>withDocument(()=>{
  const input=policy({Effect:'Deny',NotPrincipal:'*',NotAction:'s3:GetObject',NotResource:'arn:aws:s3:::photos/*'});
  assert.deepEqual(validatePolicy(input),[]);
  assert.ok(globalThis.RuleEditors.validatePolicyForApply(input).length);
  const editor=globalThis.RuleEditors.createPolicyEditor(input);
  assert.deepEqual(editor.getValue(),input);
  assert.equal(findButton(editor,'检查并应用策略').disabled,true);
  assert.equal(findButton(editor,'导出 JSON（不应用）').disabled,false);
}));

test('anonymous writes are rejected before apply while anonymous object read is allowed',()=>{
  assert.deepEqual(globalThis.RuleEditors.validatePolicyForApply(policy({...baseStatement(),Principal:'*'})),[]);
  for(const action of ['s3:PutObject','s3:DeleteObject','s3:ListBucket','s3:*']){
    assert.ok(globalThis.RuleEditors.validatePolicyForApply(policy({...baseStatement(),Principal:{AWS:['*']},Action:action})).length);
  }
});

test('single Statement object passes through app save without normalization to an array',async()=>{
  const input=policy({...baseStatement(),Condition:{StringEquals:{'s3:prefix':'images/'}}});
  const f=appFixture((url,options)=>options.method==='PUT'?{ok:true}:{policy:input});
  await f.evaluate(`savePolicyJson({value:${JSON.stringify(JSON.stringify(input))},isVisual:true})`);
  assert.equal(f.calls[0].method,'PUT');
  assert.deepEqual(f.calls[0].body,{policy:input,confirmBucket:'photos'});
  assert.equal(Array.isArray(f.calls[0].body.policy.Statement),false);
});

test('simple principal, operation and prefix controls produce policy without JSON input',()=>withDocument(()=>{
  const editor=globalThis.RuleEditors.createPolicyEditor(policy(),{bucket:'photos'});
  const who=findInput(editor,'谁可以访问');who.value='users';who.dispatch('change');
  const arn=findInput(editor,'用户 ARN 1');arn.value='arn:aws:iam::123456789012:user/demo';arn.dispatch('input');
  findButton(editor,'＋ 上传 / 覆盖').click();
  const prefix=findInput(editor,'资源对象前缀');prefix.value='客户/';prefix.dispatch('input');
  findButton(editor,'使用此前缀').click();
  const s=editor.getValue().Statement[0];
  assert.deepEqual(s.Principal,{AWS:['arn:aws:iam::123456789012:user/demo']});
  assert.deepEqual(s.Action,['s3:GetObject','s3:PutObject']);
  assert.deepEqual(s.Resource,['arn:aws:s3:::photos/客户/*']);
  assert.deepEqual(editor.validate(),[]);
}));

test('simple text changes are refreshed in advanced fields and advanced edits reflect after collapse',()=>withDocument(()=>{
  const editor=globalThis.RuleEditors.createPolicyEditor(policy(),{bucket:'photos'});
  const resource=findInput(editor,'资源 ARN 1');resource.value='arn:aws:s3:::photos/edited/*';resource.dispatch('input');
  const detail=walk(editor.element,e=>e.tagName==='DETAILS'&&e.children.some(c=>c.tagName==='SUMMARY'&&c.textContent.startsWith('高级权限字段')));
  detail.open=true;detail.dispatch('toggle');
  const raw=findInput(editor,'资源');assert.equal(raw.value,'arn:aws:s3:::photos/edited/*');
  raw.value='arn:aws:s3:::photos/advanced/*';raw.dispatch('input');
  detail.open=false;detail.dispatch('toggle');
  assert.equal(findInput(editor,'资源 ARN 1').value,'arn:aws:s3:::photos/advanced/*');
  assert.equal(editor.getValue().Statement[0].Resource,'arn:aws:s3:::photos/advanced/*');
}));

test('invalid number removed from structured field does not leave permanent export block',()=>withDocument(()=>{
  const editor=globalThis.RuleEditors.createPolicyEditor(policy({...baseStatement(),Condition:{NumericEquals:{'s3:max-keys':5}}}));
  const input=findInput(editor,'附加条件 / NumericEquals / s3:max-keys');input.value='';input.dispatch('input');
  assert.equal(findButton(editor,'导出 JSON（不应用）').disabled,true);
  findButton(editor,'移除全部条件').click();
  assert.equal(findButton(editor,'导出 JSON（不应用）').disabled,false);
}));
