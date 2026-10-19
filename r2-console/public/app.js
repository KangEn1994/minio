'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  authenticated: false, accessKey: '', csrf: '', buckets: [],
  page: 'overview', bucket: '', tab: 'objects', prefix: '', filter: '', bucketFilter: '',
  objects: [], prefixes: [], nextToken: null, listVersion: 0, loading: false,
  lifecycleLoaded: false, lifecycle: null, lifecycleError: '',
  policyLoaded: false, policy: null, policyError: '',
  stats: null, statsError: '', statsLoading: false, statsVersion: 0,
  adminCapabilities: null, adminError: '', accessKeys: [], accessKeysLoaded: false, accessKeysLoading: false,
  multipartUploads: [], multipartLoaded: false, multipartLoading: false, multipartError: '', multipartHasMore: false, multipartKeyMarker: '', multipartUploadIdMarker: '', multipartVersion: 0,
  uploadBusy: false, deleteBusy: false, selected: new Set()
};

function node(tag, options = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value == null ? '' : String(value);
    else if (key === 'on') for (const [event, handler] of Object.entries(value)) el.addEventListener(event, handler);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'value') el.value = value;
    else if (key === 'disabled') el.disabled = !!value;
    else if (key === 'hidden') el.hidden = !!value;
    else if (key === 'title') el.title = value;
    else if (value !== null && value !== undefined) el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
function button(label, cls, click, extra = {}) { return node('button', {class: `button ${cls || ''}`, type:'button', on:{click}, ...extra}, label); }
function iconButton(label, click, extra = {}) { return node('button', {class:'button small', type:'button', on:{click}, ...extra}, label); }
function clear(el) { el.replaceChildren(); return el; }
function formatDate(v) { if (!v) return '—'; const d = new Date(v); return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(d); }
function formatExactTime(v) { const d=new Date(v); return Number.isNaN(d.getTime())?'未知':new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(d); }
function formatBytes(n) { const x = Number(n); if (!Number.isFinite(x) || x < 0) return '—'; if (x < 1024) return `${x} B`; const units=['KB','MB','GB','TB']; let v=x/1024,i=0; while(v>=1024&&i<units.length-1){v/=1024;i++} return `${v.toFixed(v<10?1:0)} ${units[i]}`; }
function showToast(message, type='') { const root=$('toast-root'); const toast=node('div',{class:`toast ${type}`,role:'status',text:message}); root.append(toast); setTimeout(()=>toast.remove(),4500); }
function apiError(error) { showToast(error && error.message ? error.message : '操作失败，请重试。','error'); }
function storageUrl(bucket, suffix='') { return `/api/buckets/${encodeURIComponent(bucket)}${suffix}`; }
function safeKeyPath(key) {
  if (key === '.' || key === '..') throw new Error('不支持名称为点或双点的对象。');
  return encodeURIComponent(key);
}
function objectUrl(bucket,key) { return storageUrl(bucket, `/objects/${safeKeyPath(key)}`); }
function multipartUrl(bucket,key) { return storageUrl(bucket, `/multipart/${safeKeyPath(key)}`); }

async function request(url, options={}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!['GET','HEAD','OPTIONS'].includes(method) && !options.noCsrf) {
    if (!state.csrf) {
      const res = await fetch('/api/csrf', {credentials:'same-origin'});
      if (!res.ok) throw new Error('无法获取安全令牌，请刷新页面重试。');
      const payload = await res.json(); state.csrf = payload.token;
    }
    headers.set('X-CSRF-Token', state.csrf);
  }
  const res = await fetch(url, {...options, headers, credentials:'same-origin'});
  if (!res.ok) {
    let payload;
    try { payload = await res.json(); } catch (_) { payload = null; }
    if (res.status === 401 && url !== '/api/login') showLogin();
    const error = new Error(payload?.message || payload?.error || `请求失败 (${res.status})`);
    error.status=res.status; throw error;
  }
  return res;
}
async function jsonRequest(url, options={}) {
  const headers = new Headers(options.headers || {});
  if (options.json !== undefined) { headers.set('Content-Type','application/json'); options = {...options, body:JSON.stringify(options.json)}; delete options.json; }
  const res=await request(url,{...options,headers});
  if (res.status===204) return null;
  const raw=await res.text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { throw new Error('服务器返回了无法解析的数据。'); }
}
async function init() {
  bindStaticEvents();
  try {
    const data=await jsonRequest('/api/session');
    if (data?.authenticated) {
      state.authenticated=true; state.accessKey=data.accessKey || '';
      showApp(); await loadBuckets(); applyRoute();
    } else showLogin();
  } catch (e) { showLogin(); $('login-error').textContent='无法连接服务器，请稍后重试。'; $('login-error').hidden=false; }
}
function bindStaticEvents() {
  const accessNav=node('button',{id:'nav-access-keys',class:'nav-item',type:'button',on:{click:openAccessKeys}},node('span',{class:'nav-icon',text:'◇','aria-hidden':'true'}),node('span',{text:'访问密钥'}));
  $('nav-overview').parentElement.append(accessNav);
  $('login-form').addEventListener('submit', async (event)=>{
    event.preventDefault();
    const key=$('access-key').value.trim(), secret=$('secret-key').value;
    if (!key||!secret) return;
    $('login-error').hidden=true; $('login-button').disabled=true; $('login-button').textContent='登录中…';
    try {
      const data=await jsonRequest('/api/login',{method:'POST',json:{accessKey:key,secretKey:secret},noCsrf:true});
      state.authenticated=true; state.accessKey=data?.accessKey || key; state.csrf='';
      $('secret-key').value=''; showApp(); await loadBuckets(); applyRoute();
    } catch(e) { $('login-error').textContent=e.message; $('login-error').hidden=false; }
    finally { $('login-button').disabled=false; $('login-button').textContent='登录'; }
  });
  $('logout-button').addEventListener('click',async()=>{
    try { await jsonRequest('/api/logout',{method:'POST'}); } catch(e) { apiError(e); return; }
    state.authenticated=false; state.csrf=''; state.buckets=[]; state.bucket='';
    history.replaceState(null,'',location.pathname+location.search); showLogin();
  });
  $('nav-overview').addEventListener('click',()=>openOverview());
  $('sidebar-create').addEventListener('click',()=>openCreateBucket());
  $('menu-toggle').addEventListener('click',()=>{ const s=$('sidebar'); const open=s.classList.toggle('open'); $('menu-toggle').setAttribute('aria-expanded',String(open)); });
  window.addEventListener('popstate',()=>{if(state.authenticated)applyRoute();});
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') { if($('modal-root').firstChild) {if($('modal-root').firstChild.dataset.blockClose!=='true')clear($('modal-root'));} else closeSidebar(); } });
}
function showApp() { $('login-screen').hidden=true; $('app').hidden=false; $('account-label').textContent=state.accessKey; }
function showLogin() { state.authenticated=false; $('login-screen').hidden=false; $('app').hidden=true; }
function closeSidebar(){ $('sidebar').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded','false'); }
async function loadBuckets(){
  try { const data=await jsonRequest('/api/buckets'); state.buckets=Array.isArray(data?.buckets)?data.buckets:[]; renderNav(); if(state.bucket && !state.buckets.some(b=>b.name===state.bucket)) {state.bucket='';state.page='overview';syncRoute(true);} render(); }
  catch(e){apiError(e); render();}
}
function renderNav(){
  $('nav-overview').classList.toggle('active',state.page==='overview');
  $('nav-access-keys').classList.toggle('active',state.page==='access-keys');
  const nav=clear($('bucket-nav'));
  if(!state.buckets.length) nav.append(node('div',{class:'bucket-nav-empty',text:'暂无存储桶'}));
  for(const bucket of state.buckets){
    const item=node('button',{class:`bucket-nav-item ${state.page==='bucket'&&state.bucket===bucket.name?'active':''}`,type:'button',title:bucket.name,on:{click:()=>openBucket(bucket.name)}},node('span',{class:'nav-icon',text:'▤','aria-hidden':'true'}),node('span',{text:bucket.name}));
    nav.append(item);
  }
}
function syncRoute(replace=false){
  const params=new URLSearchParams();
  if(state.page==='access-keys')params.set('view','access-keys');
  if(state.page==='bucket'&&state.bucket){
    params.set('bucket',state.bucket);
    if(state.tab==='settings')params.set('tab','settings');
    if(state.prefix)params.set('prefix',state.prefix);
    if(state.filter)params.set('filter',state.filter);
  }
  const next=location.pathname+location.search+(params.size?'#'+params.toString():'');
  if(next!==location.pathname+location.search+location.hash)history[replace?'replaceState':'pushState'](null,'',next);
}
function applyRoute(){
  const params=new URLSearchParams(location.hash.slice(1));
  const bucket=params.get('bucket');
  if(params.get('view')==='access-keys'){state.page='access-keys';state.bucket='';closeSidebar();renderNav();render();loadAccessKeyCapabilities();return;}
  state.selected.clear();state.lifecycleLoaded=false;state.lifecycleError='';state.policyLoaded=false;state.policyError='';state.stats=null;state.statsError='';state.statsVersion++;resetMultipartState();state.listVersion++;
  if(!bucket||!state.buckets.some(item=>item.name===bucket)){
    state.page='overview';state.bucket='';state.prefix='';state.filter='';
    if(bucket)syncRoute(true);
    renderNav();render();return;
  }
  state.page='bucket';state.bucket=bucket;state.tab=params.get('tab')==='settings'?'settings':'objects';
  state.prefix=params.get('prefix')||'';state.filter=params.get('filter')||'';
  closeSidebar();renderNav();render();
  if(state.tab==='settings')loadSettings();else {loadObjects();loadBucketStats();}
}
function openOverview(){ state.page='overview'; state.bucket=''; closeSidebar();syncRoute();renderNav();render(); }
function openAccessKeys(){state.page='access-keys';state.bucket='';closeSidebar();syncRoute();renderNav();render();loadAccessKeyCapabilities();}
function openBucket(name){state.page='bucket';state.bucket=name;state.tab='objects';state.prefix='';state.filter='';state.selected.clear();state.lifecycleLoaded=false;state.lifecycleError='';state.policyLoaded=false;state.policyError='';state.stats=null;state.statsError='';state.statsVersion++;resetMultipartState();closeSidebar();syncRoute();renderNav();render();loadObjects();loadBucketStats();}
function render(){
  const view=clear($('view')); $('topbar-path').textContent=state.page==='overview'?'概览':state.page==='access-keys'?'访问密钥':state.bucket;
  if(state.page==='overview') renderOverview(view);
  else if(state.page==='access-keys')renderAccessKeys(view);
  else if(state.bucket) renderBucket(view);
}
function pageHead(eyebrow,title,description,actions=[]){
  return node('div',{class:'page-head'},node('div',{},node('div',{class:'eyebrow',text:eyebrow}),node('h1',{text:title}),node('p',{text:description})),node('div',{class:'head-actions'},actions));
}
function emptyState(icon,title,description,action){return node('div',{class:'empty-state'},node('div',{class:'empty-icon',text:icon,'aria-hidden':'true'}),node('h3',{text:title}),node('p',{text:description}),action||null);}
function renderAccessKeys(view){
  view.append(pageHead('MINIO / SERVICE ACCOUNTS','访问密钥','管理 MinIO 服务账户密钥，并按存储桶限制权限。',[button('↻ 刷新','',loadAccessKeyCapabilities),button('＋ 创建访问密钥','primary',openCreateAccessKey,{disabled:state.adminCapabilities?.available!==true||!state.buckets.length})]));
  if(state.adminError){view.append(node('div',{class:'notice warn',text:`${state.adminCapabilities?.available?'无法读取服务账户列表':'无法检查访问密钥功能'}：${state.adminError}`}));return;}
  if(!state.adminCapabilities){view.append(node('div',{class:'stats-placeholder',text:'正在检查 MinIO 管理功能…'}));return;}
  if(state.adminCapabilities.available!==true){view.append(node('div',{class:'notice warn',text:`此部署未启用 MinIO 服务账户管理。${state.adminCapabilities.reason||''}`}));return;}
  view.append(node('div',{class:'notice',text:'这些是 MinIO 服务账户密钥，不是 Cloudflare R2 令牌。新密钥的 Secret Key 只显示一次；请妥善保存。'}));
  if(!state.buckets.length)view.append(node('div',{class:'notice warn',text:'当前账户没有可访问的存储桶，因此暂不能创建受限访问密钥。'}));
  const panel=node('section',{class:'panel access-keys-panel'});
  panel.append(node('div',{class:'panel-heading'},node('h2',{text:'服务账户'}),node('span',{class:'hint',text:state.accessKeysLoading?'加载中…':state.accessKeysLoaded?`共 ${state.accessKeys.length} 个`:'尚未读取'})));
  if(state.accessKeysLoading&&!state.accessKeysLoaded)panel.append(emptyState('⋯','正在读取','正在获取 MinIO 服务账户。'));
  else if(!state.accessKeysLoaded)panel.append(emptyState('◇','无法读取服务账户','请刷新重试。'));
  else if(!state.accessKeys.length)panel.append(emptyState('◇','暂无服务账户','创建受限密钥供应用访问指定存储桶。',state.buckets.length?button('创建访问密钥','primary',openCreateAccessKey):null));
  else{
    const table=node('table',{class:'data-table'}),head=node('tr');
    for(const label of ['Access Key','名称 / 描述','所属用户','状态','到期时间',''])head.append(node('th',{text:label}));
    table.append(node('thead',{},head));
    const body=node('tbody');
    for(const account of state.accessKeys){
      const row=node('tr'),key=String(account.accessKey||'');
      row.append(node('td',{class:'mono-cell',text:key}));
      row.append(node('td',{},node('div',{text:account.name||'—'}),account.description?node('div',{class:'table-subtext',text:account.description}):null));
      row.append(node('td',{text:account.parentUser||'—'}));
      row.append(node('td',{text:account.status||'—'}));
      row.append(node('td',{text:account.expiresAt?formatExactTime(account.expiresAt):'—'}));
      row.append(node('td',{class:'row-actions'},button('撤销','danger small',()=>revokeAccessKey(key),{disabled:!key})));
      body.append(row);
    }
    table.append(body);panel.append(node('div',{class:'table-wrap'},table));
  }
  view.append(panel);
}
async function loadAccessKeyCapabilities(){
  state.adminCapabilities=null;state.adminError='';state.accessKeysLoaded=false;state.accessKeys=[];
  if(state.page==='access-keys')render();
  try{
    const data=await jsonRequest('/api/admin/access-keys/capabilities');
    if(state.page!=='access-keys')return;
    if(!data||typeof data.available!=='boolean')throw new Error('服务器返回了无效的功能状态。');
    state.adminCapabilities=data;render();
    if(data.available)await loadAccessKeys();
  }catch(e){if(state.page==='access-keys'){state.adminError=e.message;render();}}
}
async function loadAccessKeys(){
  if(state.adminCapabilities?.available!==true)return;
  state.accessKeysLoading=true;if(state.page==='access-keys')render();
  try{
    const data=await jsonRequest('/api/admin/access-keys');
    if(!Array.isArray(data?.accounts))throw new Error('服务器返回了无效的服务账户列表。');
    state.accessKeys=data.accounts;state.accessKeysLoaded=true;state.adminError='';
  }catch(e){state.accessKeysLoaded=false;state.adminError=e.message;}
  finally{state.accessKeysLoading=false;if(state.page==='access-keys')render();}
}
function dateTimeInputValue(date){return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function openCreateAccessKey(){
  if(state.adminCapabilities?.available!==true||!state.buckets.length)return;
  const modal=modalBase('创建 MinIO 访问密钥','为一个可访问的存储桶创建有期限的服务账户。默认仅授予列出和读取权限。');
  const bucket=node('select',{id:'key-bucket','aria-label':'存储桶'},state.buckets.map(item=>node('option',{value:item.name,text:item.name})));
  const prefix=node('input',{id:'key-prefix',type:'text',placeholder:'可留空；例如 team/photos/',spellcheck:'false'});
  const name=node('input',{id:'key-name',type:'text',placeholder:'可选',maxlength:'128'});
  const description=node('textarea',{id:'key-description',class:'key-description',placeholder:'用途说明（可选）',maxlength:'512'});
  const now=new Date(),defaultExpiry=new Date(now.getTime()+30*86400000),maxExpiry=new Date(now.getTime()+365*86400000);
  const expiry=node('input',{id:'key-expiry',type:'datetime-local',min:dateTimeInputValue(new Date(now.getTime()+60000)),max:dateTimeInputValue(maxExpiry),value:dateTimeInputValue(defaultExpiry)});
  const permissions={};
  const permissionRow=node('div',{class:'permission-grid'});
  for(const [code,label,checked] of [['list','列出对象',true],['read','读取对象',true],['write','上传或覆盖对象',false],['delete','删除对象',false]]){
    const input=node('input',{type:'checkbox','aria-label':label});input.checked=checked;permissions[code]=input;
    permissionRow.append(node('label',{class:'permission-choice'},input,node('span',{text:label})));
  }
  const confirm=node('input',{id:'key-confirm-bucket',type:'text',autocomplete:'off',spellcheck:'false',placeholder:'输入选中的存储桶名称'});
  bucket.addEventListener('change',()=>{confirm.value='';});
  const error=node('div',{class:'form-error',role:'alert',hidden:true});
  const submit=button('创建密钥','primary',async()=>{
    const bucketName=bucket.value,chosen=Object.entries(permissions).filter(([,input])=>input.checked).map(([code])=>code);
    const prefixValue=prefix.value,expiration=new Date(expiry.value),current=Date.now();
    let message='';
    if(!state.buckets.some(item=>item.name===bucketName))message='请选择可访问的存储桶。';
    else if(prefixValue&&(!prefixValue.endsWith('/')||prefixValue.startsWith('/')||/[\u0000-\u001f\u007f]/.test(prefixValue)||prefixValue.split('/').some(part=>part==='.'||part==='..')||new TextEncoder().encode(prefixValue).length>1024))message='前缀须为以 / 结尾的相对路径，且不含 . 或 .. 路径段。';
    else if(!chosen.length)message='请至少选择一种权限。';
    else if(!Number.isFinite(expiration.getTime())||expiration.getTime()<=current+30000||expiration.getTime()>current+365*86400000)message='到期时间必须晚于现在，且不超过一年。';
    else if(confirm.value!==bucketName)message='请准确输入选中的存储桶名称以确认。';
    if(message){error.textContent=message;error.hidden=false;return;}
    submit.disabled=true;error.hidden=true;
    const body={bucket:bucketName,prefix:prefixValue,permissions:chosen,expiresAt:expiration.toISOString(),confirmBucket:bucketName};
    if(name.value.trim())body.name=name.value.trim();
    if(description.value.trim())body.description=description.value.trim();
    try{
      const data=await jsonRequest('/api/admin/access-keys',{method:'POST',json:body});
      clear($('modal-root'));showNewAccessSecret(data);loadAccessKeys();
    }catch(e){error.textContent=e.message;error.hidden=false;submit.disabled=false;}
  });
  modal.append(node('label',{for:'key-bucket',text:'存储桶'}),bucket,node('label',{for:'key-prefix',text:'限定前缀（可选）'}),prefix,
    node('label',{text:'权限'}),permissionRow,node('div',{class:'notice warn',text:'写入权限允许上传或覆盖对象；删除权限允许删除对象。仅选择应用确实需要的权限。'}),
    node('label',{for:'key-expiry',text:'到期时间（本地时间，最多一年）'}),expiry,node('label',{for:'key-name',text:'名称'}),name,
    node('label',{for:'key-description',text:'描述'}),description,node('label',{for:'key-confirm-bucket',text:'输入存储桶名称以确认创建'}),confirm,error,
    node('div',{class:'modal-actions'},button('取消','',()=>clear($('modal-root'))),submit));
  bucket.focus();
}
function showNewAccessSecret(data){
  if(!data||typeof data.secretKey!=='string'||!data.secretKey){
    const modal=modalBase('密钥已创建，但无法显示 Secret Key','服务器没有返回 Secret Key。该密钥可能已创建，请检查列表并撤销后重建。');
    modal.append(node('div',{class:'modal-actions'},button('关闭','',()=>clear($('modal-root')))));return;
  }
  let secret=data.secretKey;
  const accessKey=String(data.account?.accessKey||'');
  const modal=modalBase('保存新的访问密钥','Secret Key 只显示这一次。关闭此窗口后无法再次查看；请现在复制到安全位置。');
  modal.parentElement.dataset.blockClose='true';
  const secretInput=node('textarea',{class:'secret-once',readonly:'',spellcheck:'false','aria-label':'一次性 Secret Key',value:secret});
  const close=()=>{secret='';secretInput.value='';clear($('modal-root'));};
  modal.append(node('div',{class:'notice warn',text:'这组密钥可按选定权限访问存储桶。不要发送到公开聊天、代码仓库或网页。'}),
    node('label',{text:'Access Key'}),node('div',{class:'mono-cell',text:accessKey}),node('label',{text:'Secret Key'}),secretInput,
    node('div',{class:'modal-actions'},button('复制 Secret Key','',async()=>{
      try{if(!navigator.clipboard)throw new Error();await navigator.clipboard.writeText(secret);showToast('Secret Key 已复制。','success');}
      catch(_){secretInput.focus();secretInput.select();showToast('已选中 Secret Key，请手动复制。');}
    }),button('我已保存，关闭','primary',close)));
}
async function revokeAccessKey(accessKey){
  if(!accessKey||accessKey==='.'||accessKey==='..')return;
  const confirmed=await new Promise(resolve=>{
    const modal=modalBase('撤销访问密钥',`撤销 ${accessKey} 后，使用它的应用将无法继续访问 MinIO。`);
    const input=node('input',{type:'text',autocomplete:'off',spellcheck:'false','aria-label':'输入 Access Key 以确认',placeholder:accessKey});
    const action=button('撤销密钥','danger',()=>{if(input.value===accessKey){clear($('modal-root'));resolve(true);}},{disabled:true});
    input.addEventListener('input',()=>{action.disabled=input.value!==accessKey;});
    modal.append(node('label',{for:'confirm-revoke-key',text:`请输入 ${accessKey} 以确认`}),input,node('div',{class:'modal-actions'},button('取消','',()=>{clear($('modal-root'));resolve(false);}),action));
    input.id='confirm-revoke-key';input.focus();
    const observer=new MutationObserver(()=>{if(!$('modal-root').contains(modal)){observer.disconnect();resolve(false);}});observer.observe($('modal-root'),{childList:true});
  });
  if(!confirmed)return;
  try{await jsonRequest(`/api/admin/access-keys/${encodeURIComponent(accessKey)}`,{method:'DELETE',json:{confirmAccessKey:accessKey}});showToast('访问密钥已撤销。','success');await loadAccessKeys();}
  catch(e){apiError(e);}
}
function renderOverview(view){
  view.append(pageHead('STORAGE / OVERVIEW','存储概览','集中查看并管理您的 MinIO 存储桶。',[button('＋ 创建存储桶','primary',openCreateBucket)]));
  const stats=node('div',{class:'stats-grid'});
  stats.append(statCard('存储桶',String(state.buckets.length),'当前账户可访问','▤'));
  view.append(stats);
  const panel=node('section',{class:'panel'}),count=node('span',{class:'hint'});
  panel.append(node('div',{class:'panel-heading'},node('h2',{text:'所有存储桶'}),count));
  if(!state.buckets.length){
    count.textContent='共 0 个';
    panel.append(emptyState('▤','还没有存储桶','创建一个存储桶，开始存放文件。',button('创建存储桶','primary',openCreateBucket)));
  } else {
    const filterInput=node('input',{type:'search',value:state.bucketFilter,placeholder:'按名称查找存储桶','aria-label':'按名称查找存储桶'});
    panel.append(node('div',{class:'bucket-filter'},node('div',{class:'search-field'},node('span',{text:'⌕','aria-hidden':'true'}),filterInput),node('span',{class:'bucket-filter-note',text:'在当前账户的完整存储桶列表中筛选'})));
    const table=node('table',{class:'data-table'}),thead=node('thead'),tr=node('tr');
    for(const label of ['名称','创建时间',''])tr.append(node('th',{text:label}));thead.append(tr);table.append(thead);
    const tbody=node('tbody'),rows=[];
    for(const bucket of state.buckets){
      const row=node('tr');
      row.append(node('td',{},node('button',{class:'item-name',type:'button',on:{click:()=>openBucket(bucket.name)}},node('span',{class:'bucket-glyph',text:'▤','aria-hidden':'true'}),node('span',{text:bucket.name}))));
      row.append(node('td',{text:formatDate(bucket.creationDate)}));
      row.append(node('td',{class:'row-actions'},iconButton('查看 →',()=>openBucket(bucket.name))));
      tbody.append(row);rows.push({name:bucket.name,row});
    }
    table.append(tbody);
    const wrapper=node('div',{class:'table-wrap'},table);
    const noMatches=emptyState('⌕','没有匹配的存储桶','请尝试其他名称。');
    panel.append(wrapper,noMatches);
    const applyFilter=()=>{
      state.bucketFilter=filterInput.value;
      const query=state.bucketFilter.trim().toLocaleLowerCase();
      let shown=0;
      for(const item of rows){const match=item.name.toLocaleLowerCase().includes(query);item.row.hidden=!match;if(match)shown++;}
      wrapper.hidden=shown===0;noMatches.hidden=shown!==0;
      count.textContent=query?`显示 ${shown} / ${rows.length} 个`:`共 ${rows.length} 个`;
    };
    filterInput.addEventListener('input',applyFilter);applyFilter();
  }
  view.append(panel);
}
function statCard(label,value,note,icon){return node('div',{class:'stat-card'},node('div',{class:'stat-icon',text:icon,'aria-hidden':'true'}),node('div',{class:'stat-label',text:label}),node('div',{class:'stat-value',text:value}),node('div',{class:'stat-note',text:note}));}
function renderBucket(view){
  view.append(pageHead('STORAGE / BUCKET',state.bucket,'管理此存储桶中的文件和配置。',state.tab==='objects'?[button('＋ 新建文件夹','',openCreateFolder),button('↑ 上传文件','primary',pickFiles)]:[]));
  view.append(node('div',{class:'tabs'},node('button',{class:`tab ${state.tab==='objects'?'active':''}`,type:'button',on:{click:()=>{state.tab='objects';syncRoute();render();loadObjects();if(!state.stats)loadBucketStats();}}},'对象'),node('button',{class:`tab ${state.tab==='settings'?'active':''}`,type:'button',on:{click:()=>{state.tab='settings';syncRoute();render();loadSettings();}}},'设置')));
  if(state.tab==='objects'){renderBucketStats(view);renderObjects(view);} else renderSettings(view);
}
function renderBucketStats(view){
  const wrap=node('section',{class:'bucket-stats',id:'bucket-stats','aria-label':'存储桶统计'});
  if(state.statsError){
    wrap.append(node('div',{class:'notice warn',text:`无法读取存储桶统计：${state.statsError}`}),button('重试统计','',()=>loadBucketStats()));
  }else if(!state.stats){
    wrap.append(node('div',{class:'stats-placeholder',text:state.statsLoading?'正在统计当前对象…':'统计数据尚未读取。'}));
  }else{
    if(state.statsLoading)wrap.append(node('div',{class:'stats-disclaimer',text:'正在更新统计…'}));
    const exact=state.stats.exact===true;
    const count=Number(state.stats.objects),bytes=Number(state.stats.bytes);
    if(!Number.isFinite(count)||!Number.isFinite(bytes)){
      wrap.append(node('div',{class:'notice warn',text:'服务器返回了无效的统计数据。'}));
    }else{
      const grid=node('div',{class:'stats-grid'});
      grid.append(statCard('当前对象数量',`${exact?'':'≥ '}${count.toLocaleString('zh-CN')}`,exact?'全桶精确计数':'扫描达到 10,000 个对象上限，此为下限','▧'));
      grid.append(statCard('当前对象大小',`${exact?'':'≥ '}${formatBytes(bytes)}`,exact?'全桶精确统计':'扫描达到 10,000 个对象上限，此为下限','◫'));
      wrap.append(grid,node('p',{class:'stats-disclaimer',text:`${state.stats.includesVersions?'包含':'不含'}历史版本；统计整个存储桶的当前对象，与当前文件夹或前缀筛选无关。`}));
    }
  }
  view.append(wrap);
}
function updateBucketStats(){
  const current=$('bucket-stats');
  if(!current||state.page!=='bucket'||state.tab!=='objects')return;
  const holder=node('div');renderBucketStats(holder);current.replaceWith(holder.firstChild);
}
async function loadBucketStats(){
  if(!state.bucket)return false;
  const bucket=state.bucket,version=++state.statsVersion;
  state.statsLoading=true;state.statsError='';updateBucketStats();
  try{
    const data=await jsonRequest(storageUrl(bucket,'/stats'));
    if(version!==state.statsVersion||bucket!==state.bucket)return false;
    if(!data||!Number.isSafeInteger(data.objects)||data.objects<0||!Number.isSafeInteger(data.bytes)||data.bytes<0||typeof data.exact!=='boolean')throw new Error('服务器返回了无效的统计数据。');
    state.stats=data;return true;
  }catch(e){if(version===state.statsVersion&&bucket===state.bucket){state.stats=null;state.statsError=e.message;}return false;}
  finally{if(version===state.statsVersion&&bucket===state.bucket){state.statsLoading=false;updateBucketStats();}}
}
function renderObjects(view){
  const breadcrumb=node('nav',{class:'breadcrumb','aria-label':'文件夹路径'});
  breadcrumb.append(node('button',{type:'button',on:{click:()=>navigatePrefix('')}},state.bucket));
  const parts=state.prefix.split('/').filter(Boolean); let cumulative='';
  for(const part of parts){ cumulative+=part+'/'; const target=cumulative; breadcrumb.append(node('span',{class:'breadcrumb-sep',text:'/','aria-hidden':'true'}),node('button',{class:target===state.prefix?'current':'',type:'button',on:{click:()=>navigatePrefix(target)}},part)); }
  view.append(breadcrumb);
  const search=node('input',{type:'search',placeholder:'按当前路径下的前缀筛选','aria-label':'按当前路径下的前缀筛选',value:state.filter});
  const searchForm=node('form',{class:'search-field',on:{submit:(e)=>{e.preventDefault();state.filter=search.value;syncRoute();loadObjects();}}},node('span',{text:'⌕','aria-hidden':'true'}),search);
  const toolbar=node('div',{class:'toolbar'},searchForm,button('筛选','',()=>{state.filter=search.value;syncRoute();loadObjects();}),state.filter?button('清除筛选','ghost',()=>{state.filter='';syncRoute();loadObjects();}):null,node('div',{class:'toolbar-spacer'}),state.selected.size?button(`删除选中 (${state.selected.size})`,'danger',deleteSelectedObjects):null,button('↻ 刷新','',()=>{loadObjects();loadBucketStats();}));
  view.append(toolbar);
  if(state.filter) view.append(node('div',{class:'prefix-note',text:`前缀筛选：${state.prefix}${state.filter}。结果可能包含更深层的对象。`}));
  const panel=node('section',{class:'panel'}); panel.append(node('div',{class:'panel-heading'},node('h2',{text:'对象'}),node('span',{class:'hint',text:state.loading?'加载中…':`${state.prefixes.length} 个文件夹 · ${state.objects.length} 个对象${state.nextToken?'（可继续加载）':''}`})));
  if(state.loading && !state.objects.length && !state.prefixes.length) panel.append(emptyState('⋯','正在加载','正在读取此路径下的对象。'));
  else if(!state.objects.length&&!state.prefixes.length) panel.append(emptyState('▧',state.filter?'没有匹配的对象':'此处还没有文件',state.filter?'请尝试其他前缀。':'上传文件或创建文件夹开始使用。',!state.filter?button('上传文件','primary',pickFiles):null));
  else { const table=node('table',{class:'data-table'}),thead=node('thead'),headRow=node('tr');
    const selectHeader=node('th'); const selectable=state.objects.filter(o=>!(o.key.endsWith('/')&&o.size===0&&state.prefixes.includes(o.key))); if(selectable.length){const selectAll=node('input',{type:'checkbox','aria-label':'选择当前加载的全部对象'});selectAll.checked=selectable.every(o=>state.selected.has(o.key));selectAll.addEventListener('change',()=>{for(const o of selectable){if(selectAll.checked)state.selected.add(o.key);else state.selected.delete(o.key);}render();});selectHeader.append(selectAll);}headRow.append(selectHeader);for(const label of ['名称','大小','上次修改','操作']) headRow.append(node('th',{text:label})); thead.append(headRow);table.append(thead);
    const tbody=node('tbody');
    for(const prefix of state.prefixes){
      const name=relativeName(prefix,state.prefix).replace(/\/$/,'') || prefix;
      const row=node('tr'); row.append(node('td')); row.append(node('td',{},node('button',{class:'item-name',type:'button',title:prefix,on:{click:()=>navigatePrefix(prefix)}},node('span',{class:'folder-glyph',text:'▰','aria-hidden':'true'}),node('span',{text:name}))));
      row.append(node('td',{text:'—'}),node('td',{text:'—'}),node('td',{class:'row-actions'},node('div',{class:'head-actions'},iconButton('打开 →',()=>navigatePrefix(prefix)),iconButton('删除文件夹及其内容',()=>deleteFolderPrefix(prefix),{class:'button small danger'})))); tbody.append(row);
    }
    for(const object of state.objects){
      if(object.key.endsWith('/') && object.size===0 && state.prefixes.includes(object.key)) continue;
      const name=relativeName(object.key,state.prefix) || object.key;
      const row=node('tr');const select=node('input',{type:'checkbox','aria-label':`选择 ${object.key}`});select.checked=state.selected.has(object.key);select.addEventListener('change',()=>{if(select.checked)state.selected.add(object.key);else state.selected.delete(object.key);render();});row.append(node('td',{},select)); row.append(node('td',{},node('span',{class:'item-name',title:object.key},node('span',{class:'file-glyph',text:'▧','aria-hidden':'true'}),node('span',{text:name}))));
      row.append(node('td',{text:formatBytes(object.size)}),node('td',{text:formatDate(object.lastModified)}));
      row.append(node('td',{class:'row-actions'},node('div',{class:'head-actions'},iconButton('详情',()=>showObjectMetadata(object.key)),iconButton('下载',()=>downloadObject(object.key)),iconButton('删除',()=>deleteObject(object.key),{class:'button small danger'})))); tbody.append(row);
    }
    table.append(tbody);panel.append(node('div',{class:'table-wrap'},table));
    if(state.nextToken) panel.append(node('div',{class:'load-more'},button(state.loading?'加载中…':'加载更多','',()=>loadObjects(true),{disabled:state.loading})));
  }
  view.append(panel);
}
function relativeName(value,prefix){return value.startsWith(prefix)?value.slice(prefix.length):value;}
function navigatePrefix(prefix){state.prefix=prefix;state.filter='';state.selected.clear();syncRoute();render();loadObjects();}
async function loadObjects(more=false){
  if(!state.bucket || state.tab!=='objects') return;
  const version=++state.listVersion, bucket=state.bucket, prefix=state.prefix+state.filter;
  if(!more){state.objects=[];state.prefixes=[];state.nextToken=null;state.selected.clear();} else if(!state.nextToken) return;
  const token=more?state.nextToken:null; state.loading=true;render();
  const params=new URLSearchParams({prefix}); if(token) params.set('continuation',token);
  try {
    const data=await jsonRequest(`${storageUrl(bucket,'/objects')}?${params}`);
    if(version!==state.listVersion || bucket!==state.bucket) return;
    state.objects=more?state.objects.concat(data?.objects||[]):(data?.objects||[]);
    const prefixes=more?state.prefixes.concat(data?.prefixes||[]):(data?.prefixes||[]);
    state.prefixes=[...new Set(prefixes)]; state.nextToken=data?.nextContinuationToken||null;
  } catch(e){if(version===state.listVersion) apiError(e);}
  finally{if(version===state.listVersion){state.loading=false;render();}}
}
function renderSettings(view){
  const grid=node('div',{class:'settings-grid'});
  grid.append(renderPolicySettings());
  const lifecycle=node('section',{class:'settings-card'});
  lifecycle.append(node('h2',{text:'生命周期规则'}),node('p',{text:'以 JSON 管理对象过期规则。每条规则包含 id、status、prefix，并设置 expirationDays（对象过期天数）或 expirationDate（过期日期），两者不能同时使用。当前 MinIO 服务端不支持 abortMultipartDays（清理未完成分片上传）。'}));
  const status=node('div',{class:'settings-status',text:state.lifecycleError || (state.lifecycleLoaded?'已读取当前配置':'正在读取配置…')});
  const editor=node('textarea',{class:'code-input','aria-label':'生命周期 JSON',spellcheck:'false',value:state.lifecycleLoaded?JSON.stringify(state.lifecycle||{rules:[]},null,2):'',disabled:!state.lifecycleLoaded});
  lifecycle.append(editor,status,node('div',{class:'button-row'},button('移除规则','danger',()=>removeLifecycle(),{disabled:!state.lifecycleLoaded}),button('保存规则','primary',()=>saveLifecycle(editor),{disabled:!state.lifecycleLoaded})));
  grid.append(lifecycle);
  grid.append(renderMultipartPanel());
  grid.append(node('section',{class:'settings-card'},node('h2',{text:'CORS 配置'}),node('p',{text:'当前 MinIO 服务器不支持通过 S3 API 管理存储桶 CORS。'}),node('div',{class:'notice warn',text:'CORS 配置在此不可用。请在支持该功能的服务端或反向代理中配置跨域请求。'})));
  grid.append(node('section',{class:'settings-card danger-zone'},node('h2',{text:'危险操作'}),node('p',{text:'清空存储桶会递归删除全部对象，保留存储桶。删除存储桶仅适用于空存储桶。版本化存储桶不支持此处的批量清空。'}),node('div',{class:'policy-actions'},button('清空存储桶','danger',emptyBucketContents),button('删除存储桶','danger',()=>deleteBucket(state.bucket)))));
  view.append(grid);
}
function resetMultipartState(){
  state.multipartVersion++;state.multipartUploads=[];state.multipartLoaded=false;state.multipartLoading=false;
  state.multipartError='';state.multipartHasMore=false;state.multipartKeyMarker='';state.multipartUploadIdMarker='';
}
function renderMultipartPanel(){
  const panel=node('section',{class:'settings-card',id:'multipart-panel'});
  panel.append(node('h2',{text:'未完成的分片上传'}),node('p',{text:'查看并手动中止未完成的分片上传。中止会永久丢弃已上传的分片，不会设置自动过期或清理规则。'}));
  panel.append(button('↻ 刷新列表','',()=>loadMultipartUploads(false),{disabled:state.multipartLoading}));
  if(state.multipartError)panel.append(node('div',{class:'notice warn multipart-notice',text:`读取或中止失败：${state.multipartError}`}));
  if(state.multipartLoading&&!state.multipartLoaded)panel.append(node('div',{class:'metadata-loading multipart-loading',text:'正在读取未完成的上传…'}));
  else if(state.multipartLoaded&&!state.multipartUploads.length)panel.append(node('div',{class:'notice multipart-notice',text:'当前没有未完成的分片上传。'}));
  else if(state.multipartUploads.length){
    const table=node('table',{class:'data-table'}),head=node('tr');
    for(const label of ['对象键','Upload ID','发起时间',''])head.append(node('th',{text:label}));
    table.append(node('thead',{},head));
    const body=node('tbody');
    for(const item of state.multipartUploads){
      const row=node('tr');
      row.append(node('td',{class:'mono-cell',text:item.key}),node('td',{class:'mono-cell',text:item.uploadId}),node('td',{text:formatDate(item.initiated)}),node('td',{class:'row-actions'},button('中止上传','danger small',()=>abortIncompleteUpload(item),{disabled:state.multipartLoading})));
      body.append(row);
    }
    table.append(body);panel.append(node('div',{class:'table-wrap multipart-table'},table));
    if(state.multipartHasMore)panel.append(node('div',{class:'load-more'},button(state.multipartLoading?'加载中…':'加载更多','',()=>loadMultipartUploads(true),{disabled:state.multipartLoading})));
  }
  return panel;
}
function updateMultipartPanel(){
  const current=$('multipart-panel');if(!current||state.page!=='bucket'||state.tab!=='settings')return;
  current.replaceWith(renderMultipartPanel());
}
async function loadMultipartUploads(more=false){
  if(state.page!=='bucket'||state.tab!=='settings'||!state.bucket||state.multipartLoading)return;
  if(more&&!state.multipartHasMore)return;
  const bucket=state.bucket,version=++state.multipartVersion;
  if(!more){state.multipartUploads=[];state.multipartLoaded=false;state.multipartHasMore=false;state.multipartKeyMarker='';state.multipartUploadIdMarker='';}
  const params=new URLSearchParams();
  if(more){params.set('keyMarker',state.multipartKeyMarker);params.set('uploadIdMarker',state.multipartUploadIdMarker);}
  state.multipartLoading=true;state.multipartError='';updateMultipartPanel();
  try{
    const data=await jsonRequest(`${storageUrl(bucket,'/multipart-uploads')}${params.size?'?'+params:''}`);
    if(version!==state.multipartVersion||bucket!==state.bucket)return;
    if(!Array.isArray(data?.uploads)||typeof data.hasMore!=='boolean')throw new Error('服务器返回了无效的分片上传列表。');
    if(data.uploads.some(item=>typeof item?.key!=='string'||typeof item?.uploadId!=='string'))throw new Error('服务器返回了无效的分片上传记录。');
    const entries=data.uploads;
    const existing=more?state.multipartUploads:[],seen=new Set(existing.map(item=>item.key+'\0'+item.uploadId));
    for(const item of entries){const identity=item.key+'\0'+item.uploadId;if(!seen.has(identity)){existing.push(item);seen.add(identity);}}
    state.multipartUploads=existing;state.multipartLoaded=true;
    const nextKeyMarker=data.nextKeyMarker||'',nextUploadIdMarker=data.nextUploadIdMarker||'';
    const repeated=more&&nextKeyMarker===state.multipartKeyMarker&&nextUploadIdMarker===state.multipartUploadIdMarker;
    state.multipartKeyMarker=nextKeyMarker;state.multipartUploadIdMarker=nextUploadIdMarker;
    state.multipartHasMore=data.hasMore;
    if(data.hasMore&&repeated){state.multipartHasMore=false;throw new Error('服务器重复返回同一页位置，已停止加载。');}
    if(data.hasMore&&!state.multipartKeyMarker){state.multipartHasMore=false;throw new Error('服务器未返回下一页位置，已停止加载。');}
  }catch(e){if(version===state.multipartVersion&&bucket===state.bucket)state.multipartError=e.message;}
  finally{if(version===state.multipartVersion&&bucket===state.bucket){state.multipartLoading=false;updateMultipartPanel();}}
}
async function abortIncompleteUpload(item){
  const bucket=state.bucket,uploadId=item.uploadId;
  const confirmed=await new Promise(resolve=>{
    const modal=modalBase('中止未完成的分片上传',`对象 ${item.key} 的已上传分片将被永久丢弃。这只是手动清理，不会启用自动过期。`);
    const input=node('input',{type:'text',autocomplete:'off',spellcheck:'false','aria-label':'输入 Upload ID 以确认',placeholder:uploadId});
    const action=button('中止上传','danger',()=>{if(input.value===uploadId){clear($('modal-root'));resolve(true);}},{disabled:true});
    input.addEventListener('input',()=>{action.disabled=input.value!==uploadId;});
    modal.append(node('label',{for:'confirm-upload-id',text:`请输入 ${uploadId} 以确认`}),input,node('div',{class:'modal-actions'},button('取消','',()=>{clear($('modal-root'));resolve(false);}),action));
    input.id='confirm-upload-id';input.focus();
    const observer=new MutationObserver(()=>{if(!$('modal-root').contains(modal)){observer.disconnect();resolve(false);}});observer.observe($('modal-root'),{childList:true});
  });
  if(!confirmed||bucket!==state.bucket)return;
  const params=new URLSearchParams({key:item.key,uploadId});
  try{await jsonRequest(`${storageUrl(bucket,'/multipart-uploads')}?${params}`,{method:'DELETE',json:{confirmUploadId:uploadId}});showToast('未完成的分片上传已中止。','success');await loadMultipartUploads(false);}
  catch(e){state.multipartError=e.message;updateMultipartPanel();apiError(e);}
}
function policyUrl(bucket){ return storageUrl(bucket,'/policy'); }
function publicReadPolicy(bucket){
  return {Version:'2012-10-17',Statement:[{Sid:'PublicRead',Effect:'Allow',Principal:'*',Action:['s3:GetObject'],Resource:[`arn:aws:s3:::${bucket}/*`]}]};
}
function policyLabel(policy,bucket){
  if(!policy)return '未配置存储桶策略';
  const list=policy.Statement;
  if(Array.isArray(list)&&list.length===1){
    const s=list[0], principals=s?.Principal;
    const publicPrincipal=principals==='*'||principals?.AWS==='*'||(Array.isArray(principals?.AWS)&&principals.AWS.length===1&&principals.AWS[0]==='*');
    const actions=Array.isArray(s?.Action)?s.Action:[s?.Action];
    const resources=Array.isArray(s?.Resource)?s.Resource:[s?.Resource];
    if(s?.Effect==='Allow'&&publicPrincipal&&actions.length===1&&actions[0]==='s3:GetObject'&&resources.length===1&&resources[0]===`arn:aws:s3:::${bucket}/*`&&!s.Condition&&!s.NotAction&&!s.NotResource)return '公开读取（已识别）';
  }
  return '已配置自定义策略，请审阅下方 JSON';
}
function renderPolicySettings(){
  const card=node('section',{class:'settings-card'});
  card.append(node('h2',{text:'存储桶权限'}),node('p',{text:'管理此存储桶的 MinIO S3 存储桶策略。更改策略可能影响对象的可访问性。'}));
  const status=state.policyError?`读取失败：${state.policyError}`:!state.policyLoaded?'正在读取当前策略…':policyLabel(state.policy,state.bucket);
  card.append(node('div',{class:'policy-status',text:status}),node('div',{class:'notice warn',text:'公开读取会让任何知道对象地址的人无需登录即可读取对象。私有预设会移除存储桶策略，但其他 IAM 权限仍可能允许访问。'}));
  const editor=node('textarea',{class:'code-input policy-editor','aria-label':'当前存储桶策略 JSON',spellcheck:'false',placeholder:'在此粘贴存储桶策略 JSON',value:state.policyLoaded&&state.policy?JSON.stringify(state.policy,null,2):'',disabled:!state.policyLoaded});
  card.append(node('label',{class:'policy-editor-label',text:'当前策略 JSON'}),editor);
  card.append(node('div',{class:'policy-actions'},
    button('刷新策略','',()=>loadPolicy(true)),
    button('私有预设','',applyPrivatePolicy,{disabled:!state.policyLoaded||!state.policy}),
    button('公开读取预设','danger',applyPublicReadPolicy,{disabled:!state.policyLoaded}),
    button('保存 JSON 策略','primary',()=>savePolicyJson(editor),{disabled:!state.policyLoaded})));
  return card;
}
async function loadSettings(){await loadLifecycle();await loadPolicy();await loadMultipartUploads();}
async function loadPolicy(force=false){
  if(state.policyLoaded&&!force)return true;
  if(state.tab!=='settings'||!state.bucket)return false;
  const bucket=state.bucket;state.policyError='';if(force)state.policyLoaded=false;render();
  try{
    const data=await jsonRequest(policyUrl(bucket));
    if(bucket!==state.bucket||state.tab!=='settings')return false;
    state.policy=data?.policy||null;state.policyLoaded=true;
  }catch(e){
    if(bucket!==state.bucket||state.tab!=='settings')return false;
    if(e.status===404){state.policy=null;state.policyLoaded=true;}
    else{state.policyError=e.message;apiError(e);}
  }
  render();return state.policyLoaded;
}
async function typedPolicyConfirmation(bucket,title,description,actionLabel){
  return new Promise(resolve=>{
    const modal=modalBase(title,description);
    const input=node('input',{type:'text',autocomplete:'off',spellcheck:'false','aria-label':'输入存储桶名称以确认',placeholder:bucket});
    const warning=node('div',{class:'notice warn',text:'此更改可能公开存储桶中的对象，或覆盖现有访问权限。请核对策略内容。'});
    const confirm=button(actionLabel,'danger',()=>{if(input.value===bucket){clear($('modal-root'));resolve(true);}}, {disabled:true});
    input.addEventListener('input',()=>{confirm.disabled=input.value!==bucket;});
    modal.append(warning,node('label',{for:'confirm-policy-bucket',text:`请输入 ${bucket} 以确认`}),input,node('div',{class:'modal-actions'},button('取消','',()=>{clear($('modal-root'));resolve(false);}),confirm));
    input.id='confirm-policy-bucket';input.focus();
    const observer=new MutationObserver(()=>{if(!$('modal-root').contains(modal)){observer.disconnect();resolve(false);}});
    observer.observe($('modal-root'),{childList:true});
  });
}
async function applyPublicReadPolicy(){
  const bucket=state.bucket;
  const ok=await typedPolicyConfirmation(bucket,'启用公开读取',`将替换 ${bucket} 当前的存储桶策略。任何人都可能无需登录读取该存储桶中的对象。`,'启用公开读取');
  if(!ok||bucket!==state.bucket)return;
  try{await jsonRequest(policyUrl(bucket),{method:'PUT',json:{policy:publicReadPolicy(bucket),confirmBucket:bucket}});const verified=await loadPolicy(true);showToast(verified?'公开读取策略已保存并重新读取。':'公开读取策略已提交，但无法读取最新配置。',verified?'success':'error');}
  catch(e){apiError(e);}
}
async function applyPrivatePolicy(){
  const bucket=state.bucket;
  if(!await confirmDialog('移除存储桶策略',`确定移除 ${bucket} 当前的存储桶策略吗？这会撤销通过该策略授予的权限；其他 IAM 授权可能仍然有效。`,'移除策略',true))return;
  if(bucket!==state.bucket)return;
  try{await jsonRequest(policyUrl(bucket),{method:'DELETE'});const verified=await loadPolicy(true);showToast(verified?'存储桶策略已移除并重新读取。':'存储桶策略已移除，但无法读取最新配置。',verified?'success':'error');}
  catch(e){apiError(e);}
}
async function savePolicyJson(editor){
  const bucket=state.bucket;let policy;
  try{policy=JSON.parse(editor.value);}catch(e){showToast('策略 JSON 格式不正确。','error');return;}
  if(!policy||typeof policy!=='object'||Array.isArray(policy)||!Array.isArray(policy.Statement)){showToast('策略需要包含 Statement 数组。','error');return;}
  if(!await typedPolicyConfirmation(bucket,'保存存储桶策略',`将使用编辑框中的 JSON 替换 ${bucket} 当前的策略。错误或过宽的权限可能公开对象。`,'保存策略'))return;
  if(bucket!==state.bucket)return;
  try{await jsonRequest(policyUrl(bucket),{method:'PUT',json:{policy,confirmBucket:bucket}});const verified=await loadPolicy(true);showToast(verified?'存储桶策略已保存并重新读取。':'存储桶策略已提交，但无法读取最新配置。',verified?'success':'error');}
  catch(e){apiError(e);}
}
async function loadLifecycle(){
  if(state.lifecycleLoaded || state.tab!=='settings') return;
  const bucket=state.bucket; state.lifecycleError='';
  try { const data=await jsonRequest(storageUrl(bucket,'/lifecycle')); if(bucket!==state.bucket) return; state.lifecycle=data || {rules:[]}; state.lifecycleLoaded=true; }
  catch(e){if(bucket!==state.bucket)return; if(e.status===404){state.lifecycle={rules:[]};state.lifecycleLoaded=true;}else{state.lifecycleError=e.message;apiError(e);}}
  render();
}
async function saveLifecycle(editor){
  const bucket=state.bucket;
  let config; try{config=JSON.parse(editor.value);}catch(e){showToast('JSON 格式不正确，请检查语法。','error');return;}
  if(!config || typeof config!=='object' || Array.isArray(config) || !Array.isArray(config.rules)){showToast('配置需要包含 rules 数组。','error');return;}
  if(config.rules.some(rule=>rule&&Object.prototype.hasOwnProperty.call(rule,'abortMultipartDays'))){showToast('当前 MinIO 服务端不支持 abortMultipartDays，请移除后再保存。','error');return;}
  if(config.rules.some(rule=>rule?.status==='Enabled')){
    if(!await confirmDialog('确认自动删除规则','启用后，MinIO 将自动删除匹配前缀且超过指定天数的对象。请确认规则范围与天数。','确认保存',true))return;
  }
  if(bucket!==state.bucket)return;
  try {
    const saved=await jsonRequest(storageUrl(bucket,'/lifecycle'),{method:'PUT',json:config});
    if(!Array.isArray(saved?.rules))throw new Error('服务器未返回已保存规则，请刷新确认。');
    if(bucket===state.bucket){state.lifecycle=saved;state.lifecycleLoaded=true;editor.value=JSON.stringify(saved,null,2);}
    showToast('生命周期规则已保存并读取服务器配置。','success');
  }catch(e){apiError(e);}
}
async function removeLifecycle(){
  const bucket=state.bucket;
  if(!await confirmDialog('移除生命周期规则',`确定移除 ${bucket} 的所有生命周期规则吗？`,'移除规则',true))return;
  try{await jsonRequest(storageUrl(bucket,'/lifecycle'),{method:'DELETE'});state.lifecycle={rules:[]};state.lifecycleLoaded=true;render();showToast('生命周期规则已移除。','success');}catch(e){apiError(e);}
}
function modalBase(title,description){
  clear($('modal-root'));
  const backdrop=node('div',{class:'modal-backdrop'}),modal=node('div',{class:'modal',role:'dialog','aria-modal':'true','aria-label':title});
  modal.append(node('h2',{text:title}),node('p',{text:description})); backdrop.append(modal); $('modal-root').append(backdrop);
  backdrop.addEventListener('click',(e)=>{if(e.target===backdrop&&backdrop.dataset.blockClose!=='true')clear($('modal-root'));});
  return modal;
}
function confirmDialog(title,description,confirmLabel='确认',danger=false){
  return new Promise((resolve)=>{
    const modal=modalBase(title,description);
    const end=(answer)=>{clear($('modal-root'));resolve(answer);};
    modal.append(node('div',{class:'modal-actions'},button('取消','',()=>end(false)),button(confirmLabel,danger?'danger':'primary',()=>end(true))));
    const observer=new MutationObserver(()=>{if(!$('modal-root').contains(modal)){observer.disconnect();resolve(false);}}); observer.observe($('modal-root'),{childList:true});
  });
}
function typedDeletionConfirmation(title,description,target,actionLabel){
  return new Promise(resolve=>{
    const modal=modalBase(title,description);
    const input=node('input',{type:'text',autocomplete:'off',spellcheck:'false','aria-label':`输入 ${target} 以确认`,placeholder:target});
    const action=button(actionLabel,'danger',()=>{if(input.value===target){clear($('modal-root'));resolve(true);}},{disabled:true});
    input.addEventListener('input',()=>{action.disabled=input.value!==target;});
    modal.append(node('div',{class:'notice warn',text:'此操作会永久删除匹配的对象，无法在控制台中撤销。'}),node('label',{for:'confirm-deletion-target',text:`请输入 ${target} 以确认`}),input,node('div',{class:'modal-actions'},button('取消','',()=>{clear($('modal-root'));resolve(false);}),action));
    input.id='confirm-deletion-target';input.focus();
    const observer=new MutationObserver(()=>{if(!$('modal-root').contains(modal)){observer.disconnect();resolve(false);}});
    observer.observe($('modal-root'),{childList:true});
  });
}
async function deleteFolderPrefix(prefix){
  const bucket=state.bucket;
  if(state.deleteBusy||!prefix||!prefix.endsWith('/'))return;
  const confirmed=await typedDeletionConfirmation('删除文件夹及其内容',`将删除 ${bucket}/${prefix} 下所有对象及子文件夹。只匹配此完整前缀，不会删除名称相似的相邻文件夹。`,prefix,'删除文件夹及其内容');
  if(!confirmed||bucket!==state.bucket)return;
  await runPagedDeletion(`${storageUrl(bucket,'/prefix')}?${new URLSearchParams({prefix})}`,'正在删除文件夹',()=>{if(bucket===state.bucket){loadBucketStats();if(state.tab==='objects')loadObjects();}});
}
async function emptyBucketContents(){
  const bucket=state.bucket;
  if(state.deleteBusy||!bucket)return;
  const confirmed=await typedDeletionConfirmation('清空存储桶',`将删除 ${bucket} 中的全部对象和文件夹，包括所有子路径。存储桶本身会保留。版本化存储桶不能通过此操作清空。`,bucket,'清空存储桶');
  if(!confirmed||bucket!==state.bucket)return;
  await runPagedDeletion(storageUrl(bucket,'/empty'),'正在清空存储桶',()=>{state.objects=[];state.prefixes=[];state.selected.clear();if(bucket===state.bucket)loadBucketStats();});
}
async function runPagedDeletion(url,title,onFinish){
  if(state.deleteBusy)return;
  state.deleteBusy=true;
  const modal=modalBase(title,'服务器正在分批删除对象。请保持页面打开，直到操作结束。');
  modal.parentElement.dataset.blockClose='true';
  const status=node('div',{class:'deletion-progress-text',text:'已删除 0 个对象，正在处理…'});
  const progress=node('progress',{class:'upload-progress','aria-label':'删除进行中'});
  modal.append(status,progress);
  let deleted=0, failed=[],problem='';
  try{
    while(true){
      const result=await jsonRequest(url,{method:'DELETE'});
      if(!result||!Number.isInteger(result.deleted)||result.deleted<0||!Array.isArray(result.failed)||typeof result.hasMore!=='boolean')throw new Error('服务器返回了无效的删除结果。');
      deleted+=result.deleted;failed=failed.concat(result.failed);
      status.textContent=`已删除 ${deleted} 个对象，正在处理…`;
      if(failed.length||!result.hasMore)break;
      if(result.deleted===0)throw new Error('服务器未删除任何对象，已停止以避免重复请求。');
    }
  }catch(e){problem=e.message||'删除请求失败';}
  finally{state.deleteBusy=false;try{onFinish();}catch(_){}}
  if(!failed.length&&!problem){clear($('modal-root'));showToast(`删除完成，共删除 ${deleted} 个对象。`,'success');return;}
  clear(modal);modal.parentElement.dataset.blockClose='false';
  modal.append(node('h2',{text:'删除未完成'}),node('p',{text:`已删除 ${deleted} 个对象。剩余对象未全部删除，请检查失败原因后重试。`}));
  if(problem)modal.append(node('div',{class:'notice warn',text:problem}));
  if(failed.length){
    const list=node('ul',{class:'failure-list'});
    for(const item of failed)list.append(node('li',{},node('strong',{text:typeof item==='string'?item:String(item?.key||'未知对象')}),node('span',{text:typeof item==='string'?'删除失败':String(item?.message||'删除失败')})));
    modal.append(list);
  }
  modal.append(node('div',{class:'modal-actions'},button('关闭','',()=>clear($('modal-root')))));
}
function openCreateBucket(){
  const modal=modalBase('创建存储桶','存储桶名称需在 3–63 个字符之间，使用小写字母、数字或连字符，且以字母或数字开头和结尾。');
  const input=node('input',{type:'text',placeholder:'例如 project-assets',autocomplete:'off',required:'',maxlength:'63',spellcheck:'false'});
  const error=node('p',{class:'form-error',hidden:true,role:'alert'});
  const submit=button('创建存储桶','primary',async()=>{
    const name=input.value.trim();
    if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)){error.textContent='请输入有效的存储桶名称。';error.hidden=false;return;}
    submit.disabled=true;
    try{await jsonRequest('/api/buckets',{method:'POST',json:{name}});clear($('modal-root'));await loadBuckets();openBucket(name);showToast('存储桶已创建。','success');}
    catch(e){error.textContent=e.message;error.hidden=false;submit.disabled=false;}
  });
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit.click();}});
  modal.append(node('label',{for:'new-bucket-name',text:'存储桶名称'}));input.id='new-bucket-name';modal.append(input,error,node('div',{class:'modal-actions'},button('取消','',()=>clear($('modal-root'))),submit));input.focus();
}
async function deleteBucket(name){
  if(!await confirmDialog('删除存储桶',`确定删除“${name}”吗？存储桶必须为空。`,'删除存储桶',true))return;
  try{await jsonRequest(`${storageUrl(name)}?deleteBucket=1`,{method:'DELETE'});showToast('存储桶已删除。','success');state.page='overview';state.bucket='';state.prefix='';state.filter='';syncRoute(true);await loadBuckets();}
  catch(e){apiError(e);}
}
function openCreateFolder(){
  if(!state.bucket)return;
  const modal=modalBase('新建文件夹',`将在 ${state.bucket}/${state.prefix} 下创建文件夹。`);
  const input=node('input',{type:'text',placeholder:'文件夹名称',required:'',maxlength:'255'}),error=node('p',{class:'form-error',role:'alert',hidden:true});
  const submit=button('创建文件夹','primary',async()=>{
    const name=input.value.trim();
    if(!name||name==='.'||name==='..'||name.includes('/')){error.textContent='请输入不含斜杠的文件夹名称。';error.hidden=false;return;}
    submit.disabled=true;
    try{await jsonRequest(storageUrl(state.bucket,'/folders'),{method:'POST',json:{prefix:state.prefix+name+'/'}});clear($('modal-root'));showToast('文件夹已创建。','success');await loadObjects();loadBucketStats();}
    catch(e){error.textContent=e.message;error.hidden=false;submit.disabled=false;}
  });
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit.click();}});
  modal.append(node('label',{for:'new-folder-name',text:'文件夹名称'}));input.id='new-folder-name';modal.append(input,error,node('div',{class:'modal-actions'},button('取消','',()=>clear($('modal-root'))),submit));input.focus();
}
function pickFiles(){
  if(state.uploadBusy)return;
  const input=node('input',{type:'file',multiple:'',hidden:true}); document.body.append(input);
  input.addEventListener('change',async()=>{const files=[...input.files];input.remove();if(files.length)await uploadFiles(files);},{once:true});input.click();
}
async function uploadFiles(files){
  if(state.uploadBusy)return; state.uploadBusy=true;
  const bucket=state.bucket,prefix=state.prefix;
  const modal=modalBase('上传文件',`正在上传 ${files.length} 个文件至 ${bucket}/${prefix}。`);
  const label=node('div',{class:'upload-status',text:'准备上传…'}),fill=node('progress',{class:'upload-progress',max:'100',value:'0','aria-label':'上传进度'});
  modal.append(label,fill);
  let done=0;
  try{
    for(const file of files){
      const key=prefix+file.name;
      label.textContent=`${done+1}/${files.length} · ${file.name}`;
      if(file.size<=16*1024*1024){await request(objectUrl(bucket,key),{method:'PUT',headers:{'Content-Type':file.type||'application/octet-stream'},body:file});}
      else await uploadMultipart(bucket,key,file,(part,total)=>{fill.value=Math.round(((done+part/total)/files.length)*100);label.textContent=`${done+1}/${files.length} · ${file.name} · 分片 ${part}/${total}`;});
      done++;fill.value=Math.round(done/files.length*100);
    }
    clear($('modal-root'));showToast(`已上传 ${files.length} 个文件。`,'success');await loadObjects();loadBucketStats();
  }catch(e){label.textContent=`上传中断：${e.message}`;apiError(e);modal.append(node('div',{class:'modal-actions'},button('关闭','',()=>clear($('modal-root')))));if(done){await loadObjects();loadBucketStats();}}
  finally{state.uploadBusy=false;}
}
async function uploadMultipart(bucket,key,file,onPart){
  const base=multipartUrl(bucket,key);
  const start=await jsonRequest(base,{method:'POST'});
  const uploadId=start?.uploadId; if(!uploadId)throw new Error('服务器未返回分片上传 ID。');
  const partSize=8*1024*1024,total=Math.ceil(file.size/partSize),parts=[];
  try{
    for(let i=0;i<total;i++){
      const part=file.slice(i*partSize,Math.min(file.size,(i+1)*partSize));
      const data=await jsonRequest(`${base}/parts/${i+1}?uploadId=${encodeURIComponent(uploadId)}`,{method:'PUT',body:part,headers:{'Content-Type':'application/octet-stream',...(i===total-1?{'X-Last-Part':'true'}:{})}});
      if(!data?.etag)throw new Error(`分片 ${i+1} 未返回 ETag。`);
      parts.push({partNumber:i+1,etag:data.etag});onPart(i+1,total);
    }
    await jsonRequest(`${base}/complete?uploadId=${encodeURIComponent(uploadId)}`,{method:'POST',json:{parts}});
  }catch(e){try{await jsonRequest(`${base}?uploadId=${encodeURIComponent(uploadId)}`,{method:'DELETE'});}catch(_){}throw e;}
}
async function showObjectMetadata(key){
  const bucket=state.bucket;
  const modal=modalBase('对象详情',key);
  const content=node('div',{class:'metadata-loading',text:'正在读取对象信息…'});modal.append(content);
  try{
    const data=await jsonRequest(`${objectUrl(bucket,key)}?metadata=1`);
    if(!$('modal-root').contains(modal))return;
    const details=node('dl',{class:'metadata-list'});
    for(const [label,value] of [['对象键',data?.key||key],['大小',formatBytes(data?.size)],['内容类型',data?.contentType||'—'],['Cache-Control',data?.cacheControl||'—'],['ETag',data?.etag||'—'],['上次修改',formatDate(data?.lastModified)]]) details.append(node('div',{},node('dt',{text:label}),node('dd',{text:value})));
    if(data?.metadata && Object.keys(data.metadata).length){
      for(const [name,value] of Object.entries(data.metadata)) details.append(node('div',{},node('dt',{text:`元数据 · ${name}`}),node('dd',{text:value})));
    }
    content.replaceWith(details);
    const share=node('section',{class:'share-section'});
    share.append(node('h3',{text:'临时访问链接'}),node('p',{text:'链接是临时访问凭据。持有链接的人在到期前可下载或覆盖这个对象；请谨慎分享。'}));
    const expiry=node('input',{type:'number',min:'60',max:'3600',step:'1',value:'900','aria-label':'链接有效期（秒）'});
    const output=node('div',{class:'share-output'});
    const getLink=button('临时下载链接','',()=>makeShareLink(bucket,key,'GET',expiry,output,modal,[getLink,putLink]));
    const putLink=button('临时上传链接','danger',()=>makeShareLink(bucket,key,'PUT',expiry,output,modal,[getLink,putLink]));
    share.append(node('div',{class:'share-controls'},node('label',{},'有效期（秒）',expiry),getLink,putLink),output);
    modal.append(share,node('div',{class:'modal-actions object-detail-actions'},button('关闭','',()=>clear($('modal-root'))),button('复制对象','',()=>openCopyObject(bucket,key)),button('编辑元数据','',()=>openEditMetadata(bucket,key,data)),button('下载','primary',()=>downloadObject(key))));
  }catch(e){content.textContent=e.message;content.className='form-error';}
}
function safeCopyKey(key){
  return typeof key==='string'&&key.length>0&&new TextEncoder().encode(key).length<=1024&&
    !/[\u0000-\u001f\u007f]/.test(key)&&!key.split('/').some(part=>part==='.'||part==='..');
}
function openCopyObject(bucket,key){
  const modal=modalBase('复制对象',`从 ${bucket}/${key} 复制到同一存储桶中的新对象键。源对象不会删除。`);
  modal.append(node('div',{class:'notice warn',text:'目标对象若已存在，可能被覆盖。此操作采用 MinIO 单次复制，仅支持不超过 5 GiB 的对象。'}));
  const destination=node('input',{id:'copy-destination',type:'text',spellcheck:'false',placeholder:'例如 archive/copy.jpg'});
  const error=node('div',{class:'form-error',role:'alert',hidden:true});
  const submit=button('复制对象','primary',async()=>{
    const destinationKey=destination.value;
    if(!safeCopyKey(destinationKey)||destinationKey===key){error.textContent='请输入有效且不同于源对象的目标键。';error.hidden=false;return;}
    if(!await confirmDialog('确认复制对象',`将 ${key} 复制到 ${destinationKey}。若目标已存在，内容可能被覆盖。`,'确认复制',true))return;
    const work=modalBase('正在复制对象',`正在复制到 ${destinationKey}，请稍候。`);work.parentElement.dataset.blockClose='true';
    try{
      await jsonRequest(`${objectUrl(bucket,key)}/copy`,{method:'POST',json:{destinationKey}});
      clear($('modal-root'));showToast('对象已复制，源对象保持不变。','success');
      if(bucket===state.bucket){if(state.tab==='objects')loadObjects();loadBucketStats();}
    }catch(e){work.parentElement.dataset.blockClose='false';work.append(node('div',{class:'notice warn',text:e.message}),node('div',{class:'modal-actions'},button('关闭','',()=>clear($('modal-root')))));}
  });
  modal.append(node('label',{for:'copy-destination',text:'目标对象键'}),destination,error,node('div',{class:'modal-actions'},button('取消','',()=>clear($('modal-root'))),submit));destination.focus();
}
function openEditMetadata(bucket,key,current){
  const modal=modalBase('编辑对象元数据',`仅修改 ${bucket}/${key} 指定的字段；留空表示保持原值，不会删除现有元数据。`);
  modal.append(node('div',{class:'notice warn',text:'保存会对对象执行安全自复制，仅支持不超过 5 GiB 的对象。加密、对象锁或不受支持的标签等状态会被拒绝，不能保证所有对象都可编辑。'}));
  const contentType=node('input',{id:'edit-content-type',type:'text',placeholder:current?.contentType||'例如 image/jpeg'});
  const cacheControl=node('input',{id:'edit-cache-control',type:'text',placeholder:current?.cacheControl||'例如 max-age=3600'});
  const custom=node('textarea',{id:'edit-custom-metadata',class:'key-description metadata-json',spellcheck:'false',value:'{}','aria-label':'要添加或替换的自定义元数据 JSON'});
  const error=node('div',{class:'form-error',role:'alert',hidden:true});
  const submit=button('保存元数据','primary',async()=>{
    let additions;
    try{additions=JSON.parse(custom.value||'{}');}catch(_){error.textContent='自定义元数据 JSON 格式不正确。';error.hidden=false;return;}
    if(!additions||typeof additions!=='object'||Array.isArray(additions)||Object.entries(additions).some(([name,value])=>!/^[a-z0-9-]+$/i.test(name)||typeof value!=='string'||!value)){
      error.textContent='自定义元数据须为名称和值均有效的 JSON 对象。';error.hidden=false;return;
    }
    const patch={};if(contentType.value.trim())patch.contentType=contentType.value.trim();
    if(cacheControl.value.trim())patch.cacheControl=cacheControl.value.trim();
    if(Object.keys(additions).length)patch.customMetadata=additions;
    if(!Object.keys(patch).length){error.textContent='请填写至少一项要添加或替换的元数据。';error.hidden=false;return;}
    if(!await confirmDialog('确认编辑元数据','这会对当前对象执行自复制。受保护或超过 5 GiB 的对象将被拒绝，原对象保持不变。','确认保存',true))return;
    const work=modalBase('正在保存元数据','MinIO 正在安全复制对象，请稍候。');work.parentElement.dataset.blockClose='true';
    try{
      await jsonRequest(`${objectUrl(bucket,key)}/metadata`,{method:'PATCH',json:{patch}});
      clear($('modal-root'));showToast('对象元数据已保存。','success');
      if(bucket===state.bucket){if(state.tab==='objects')loadObjects();showObjectMetadata(key);}
    }catch(e){work.parentElement.dataset.blockClose='false';work.append(node('div',{class:'notice warn',text:e.message}),node('div',{class:'modal-actions'},button('关闭','',()=>clear($('modal-root')))));}
  });
  modal.append(node('label',{for:'edit-content-type',text:'Content-Type（留空则不修改）'}),contentType,
    node('label',{for:'edit-cache-control',text:'Cache-Control（留空则不修改）'}),cacheControl,
    node('label',{for:'edit-custom-metadata',text:'要添加或替换的自定义元数据（JSON 对象）'}),custom,error,
    node('div',{class:'modal-actions'},button('取消','',()=>clear($('modal-root'))),submit));
  contentType.focus();
}
async function makeShareLink(bucket,key,method,expiryInput,output,modal,buttons){
  const expiresSeconds=Number(expiryInput.value);
  if(!Number.isInteger(expiresSeconds)||expiresSeconds<60||expiresSeconds>3600){
    output.replaceChildren(node('div',{class:'form-error',text:'有效期必须是 60–3600 秒之间的整数。'}));return;
  }
  for(const b of buttons)b.disabled=true;
  output.replaceChildren(node('div',{class:'metadata-loading',text:'正在生成链接…'}));
  try{
    const data=await jsonRequest(`${objectUrl(bucket,key)}/share`,{method:'POST',json:{method,expiresSeconds}});
    if(!$('modal-root').contains(modal))return;
    if(typeof data?.url!=='string'||!data.url)throw new Error('服务器未返回链接。');
    const parsed=new URL(data.url);
    if(!['http:','https:'].includes(parsed.protocol))throw new Error('服务器返回了无效的链接。');
    const local=['localhost','127.0.0.1','[::1]','::1'].includes(parsed.hostname);
    const urlBox=node('textarea',{class:'share-link',readonly:'',spellcheck:'false','aria-label':'临时访问链接',value:data.url});
    const copy=button('复制链接','',async()=>{
      try{if(!navigator.clipboard)throw new Error();await navigator.clipboard.writeText(data.url);showToast('链接已复制。','success');}
      catch(_){urlBox.focus();urlBox.select();showToast('已选中链接，请手动复制。');}
    });
    output.replaceChildren(node('div',{class:'share-result-head',text:`${method==='GET'?'下载':'上传/覆盖'}链接 · ${formatExactTime(data.expiresAt)} 到期`}),urlBox,node('div',{class:'share-result-actions'},copy),node('div',{class:'notice warn',text:local?'此链接指向 MinIO 所在机器的回环地址，仅在该机器上可用。':'链接仅在接收方可以访问此 MinIO 端点的网络中可用。'}));
  }catch(e){if($('modal-root').contains(modal))output.replaceChildren(node('div',{class:'form-error',text:e.message||'生成链接失败。'}));}
  finally{for(const b of buttons)b.disabled=false;}
}
async function downloadObject(key){
  try{
    const res=await request(objectUrl(state.bucket,key));
    const blob=await res.blob(),url=URL.createObjectURL(blob);
    const a=node('a',{href:url,download:key.split('/').pop()||'download'});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(e){apiError(e);}
}
async function deleteSelectedObjects(){
  const keys=[...state.selected]; if(!keys.length)return;
  if(!await confirmDialog('删除选中对象',`确定删除选中的 ${keys.length} 个对象吗？只会删除当前选中的对象。`,'删除选中对象',true))return;
  const bucket=state.bucket, failed=[];
  for(const key of keys){
    try{await jsonRequest(objectUrl(bucket,key),{method:'DELETE'});state.selected.delete(key);}
    catch(e){failed.push({key,message:e.message});}
  }
  await loadObjects();loadBucketStats();
  if(failed.length){
    const modal=modalBase('部分对象删除失败',`已删除 ${keys.length-failed.length}/${keys.length} 个对象。以下 ${failed.length} 个对象未删除：`);
    const list=node('ul',{class:'failure-list'});
    for(const item of failed)list.append(node('li',{},node('strong',{text:item.key}),node('span',{text:item.message})));
    modal.append(list,node('div',{class:'modal-actions'},button('关闭','',()=>clear($('modal-root')))));
  } else showToast(`已删除 ${keys.length} 个对象。`,'success');
}
async function deleteObject(key){
  if(!await confirmDialog('删除对象',`确定删除“${key}”吗？此操作无法在控制台中撤销。`,'删除对象',true))return;
  try{await jsonRequest(objectUrl(state.bucket,key),{method:'DELETE'});showToast('对象已删除。','success');await loadObjects();loadBucketStats();}catch(e){apiError(e);}
}
init();
