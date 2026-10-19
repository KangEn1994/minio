'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  authenticated: false, accessKey: '', csrf: '', buckets: [],
  page: 'overview', bucket: '', tab: 'objects', prefix: '', filter: '',
  objects: [], prefixes: [], nextToken: null, listVersion: 0, loading: false,
  lifecycleLoaded: false, lifecycle: null, lifecycleError: '',
  uploadBusy: false, selected: new Set()
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
      showApp(); await loadBuckets();
    } else showLogin();
  } catch (e) { showLogin(); $('login-error').textContent='无法连接服务器，请稍后重试。'; $('login-error').hidden=false; }
}
function bindStaticEvents() {
  $('login-form').addEventListener('submit', async (event)=>{
    event.preventDefault();
    const key=$('access-key').value.trim(), secret=$('secret-key').value;
    if (!key||!secret) return;
    $('login-error').hidden=true; $('login-button').disabled=true; $('login-button').textContent='登录中…';
    try {
      const data=await jsonRequest('/api/login',{method:'POST',json:{accessKey:key,secretKey:secret},noCsrf:true});
      state.authenticated=true; state.accessKey=data?.accessKey || key; state.csrf='';
      $('secret-key').value=''; showApp(); await loadBuckets();
    } catch(e) { $('login-error').textContent=e.message; $('login-error').hidden=false; }
    finally { $('login-button').disabled=false; $('login-button').textContent='登录'; }
  });
  $('logout-button').addEventListener('click',async()=>{
    try { await jsonRequest('/api/logout',{method:'POST'}); } catch(e) { apiError(e); return; }
    state.authenticated=false; state.csrf=''; state.buckets=[]; state.bucket=''; showLogin();
  });
  $('nav-overview').addEventListener('click',()=>openOverview());
  $('sidebar-create').addEventListener('click',()=>openCreateBucket());
  $('menu-toggle').addEventListener('click',()=>{ const s=$('sidebar'); const open=s.classList.toggle('open'); $('menu-toggle').setAttribute('aria-expanded',String(open)); });
  document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') { if($('modal-root').firstChild) clear($('modal-root')); else closeSidebar(); } });
}
function showApp() { $('login-screen').hidden=true; $('app').hidden=false; $('account-label').textContent=state.accessKey; }
function showLogin() { state.authenticated=false; $('login-screen').hidden=false; $('app').hidden=true; }
function closeSidebar(){ $('sidebar').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded','false'); }
async function loadBuckets(){
  try { const data=await jsonRequest('/api/buckets'); state.buckets=Array.isArray(data?.buckets)?data.buckets:[]; renderNav(); if(state.bucket && !state.buckets.some(b=>b.name===state.bucket)) {state.bucket='';state.page='overview';} render(); }
  catch(e){apiError(e); render();}
}
function renderNav(){
  $('nav-overview').classList.toggle('active',state.page==='overview');
  const nav=clear($('bucket-nav'));
  if(!state.buckets.length) nav.append(node('div',{class:'bucket-nav-empty',text:'暂无存储桶'}));
  for(const bucket of state.buckets){
    const item=node('button',{class:`bucket-nav-item ${state.page==='bucket'&&state.bucket===bucket.name?'active':''}`,type:'button',title:bucket.name,on:{click:()=>openBucket(bucket.name)}},node('span',{class:'nav-icon',text:'▤','aria-hidden':'true'}),node('span',{text:bucket.name}));
    nav.append(item);
  }
}
function openOverview(){ state.page='overview'; state.bucket=''; closeSidebar(); renderNav(); render(); }
function openBucket(name){state.page='bucket';state.bucket=name;state.tab='objects';state.prefix='';state.filter='';state.selected.clear();state.lifecycleLoaded=false;state.lifecycleError='';closeSidebar();renderNav();render();loadObjects();}
function render(){
  const view=clear($('view')); $('topbar-path').textContent=state.page==='overview'?'概览':state.bucket;
  if(state.page==='overview') renderOverview(view);
  else if(state.bucket) renderBucket(view);
}
function pageHead(eyebrow,title,description,actions=[]){
  return node('div',{class:'page-head'},node('div',{},node('div',{class:'eyebrow',text:eyebrow}),node('h1',{text:title}),node('p',{text:description})),node('div',{class:'head-actions'},actions));
}
function emptyState(icon,title,description,action){return node('div',{class:'empty-state'},node('div',{class:'empty-icon',text:icon,'aria-hidden':'true'}),node('h3',{text:title}),node('p',{text:description}),action||null);}
function renderOverview(view){
  view.append(pageHead('STORAGE / OVERVIEW','存储概览','集中查看并管理您的 MinIO 存储桶。',[button('＋ 创建存储桶','primary',openCreateBucket)]));
  const stats=node('div',{class:'stats-grid'});
  stats.append(statCard('存储桶',String(state.buckets.length),'当前账户可访问','▤'));
  view.append(stats);
  const panel=node('section',{class:'panel'}); panel.append(node('div',{class:'panel-heading'},node('h2',{text:'所有存储桶'}),node('span',{class:'hint',text:`共 ${state.buckets.length} 个`})));
  if(!state.buckets.length) panel.append(emptyState('▤','还没有存储桶','创建一个存储桶，开始存放文件。',button('创建存储桶','primary',openCreateBucket)));
  else {
    const table=node('table',{class:'data-table'}),thead=node('thead'),tr=node('tr');
    for(const label of ['名称','创建时间','']) tr.append(node('th',{text:label})); thead.append(tr); table.append(thead);
    const tbody=node('tbody'); for(const bucket of state.buckets){
      const row=node('tr');
      row.append(node('td',{},node('button',{class:'item-name',type:'button',on:{click:()=>openBucket(bucket.name)}},node('span',{class:'bucket-glyph',text:'▤','aria-hidden':'true'}),node('span',{text:bucket.name}))));
      row.append(node('td',{text:formatDate(bucket.creationDate)}));
      row.append(node('td',{class:'row-actions'},iconButton('查看 →',()=>openBucket(bucket.name)))); tbody.append(row);
    }
    table.append(tbody); panel.append(node('div',{class:'table-wrap'},table));
  }
  view.append(panel);
}
function statCard(label,value,note,icon){return node('div',{class:'stat-card'},node('div',{class:'stat-icon',text:icon,'aria-hidden':'true'}),node('div',{class:'stat-label',text:label}),node('div',{class:'stat-value',text:value}),node('div',{class:'stat-note',text:note}));}
function renderBucket(view){
  view.append(pageHead('STORAGE / BUCKET',state.bucket,'管理此存储桶中的文件和配置。',state.tab==='objects'?[button('＋ 新建文件夹','',openCreateFolder),button('↑ 上传文件','primary',pickFiles)]:[]));
  view.append(node('div',{class:'tabs'},node('button',{class:`tab ${state.tab==='objects'?'active':''}`,type:'button',on:{click:()=>{state.tab='objects';render();}}},'对象'),node('button',{class:`tab ${state.tab==='settings'?'active':''}`,type:'button',on:{click:()=>{state.tab='settings';render();loadLifecycle();}}},'设置')));
  if(state.tab==='objects') renderObjects(view); else renderSettings(view);
}
function renderObjects(view){
  const breadcrumb=node('nav',{class:'breadcrumb','aria-label':'文件夹路径'});
  breadcrumb.append(node('button',{type:'button',on:{click:()=>navigatePrefix('')}},state.bucket));
  const parts=state.prefix.split('/').filter(Boolean); let cumulative='';
  for(const part of parts){ cumulative+=part+'/'; const target=cumulative; breadcrumb.append(node('span',{class:'breadcrumb-sep',text:'/','aria-hidden':'true'}),node('button',{class:target===state.prefix?'current':'',type:'button',on:{click:()=>navigatePrefix(target)}},part)); }
  view.append(breadcrumb);
  const search=node('input',{type:'search',placeholder:'按当前路径下的前缀筛选','aria-label':'按当前路径下的前缀筛选',value:state.filter});
  const searchForm=node('form',{class:'search-field',on:{submit:(e)=>{e.preventDefault();state.filter=search.value;loadObjects();}}},node('span',{text:'⌕','aria-hidden':'true'}),search);
  const toolbar=node('div',{class:'toolbar'},searchForm,button('筛选','',()=>{state.filter=search.value;loadObjects();}),state.filter?button('清除筛选','ghost',()=>{state.filter='';loadObjects();}):null,node('div',{class:'toolbar-spacer'}),state.selected.size?button(`删除选中 (${state.selected.size})`,'danger',deleteSelectedObjects):null,button('↻ 刷新','',()=>loadObjects()));
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
      row.append(node('td',{text:'—'}),node('td',{text:'—'}),node('td',{class:'row-actions'},iconButton('打开 →',()=>navigatePrefix(prefix)))); tbody.append(row);
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
function navigatePrefix(prefix){state.prefix=prefix;state.filter='';state.selected.clear();render();loadObjects();}
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
  const lifecycle=node('section',{class:'settings-card'});
  lifecycle.append(node('h2',{text:'生命周期规则'}),node('p',{text:'以 JSON 管理对象过期规则。每条规则包含 id、status、prefix 和 expirationDays。'}));
  const status=node('div',{class:'settings-status',text:state.lifecycleError || (state.lifecycleLoaded?'已读取当前配置':'正在读取配置…')});
  const editor=node('textarea',{class:'code-input','aria-label':'生命周期 JSON',spellcheck:'false',value:state.lifecycleLoaded?JSON.stringify(state.lifecycle||{rules:[]},null,2):'',disabled:!state.lifecycleLoaded});
  lifecycle.append(editor,status,node('div',{class:'button-row'},button('移除规则','danger',()=>removeLifecycle(),{disabled:!state.lifecycleLoaded}),button('保存规则','primary',()=>saveLifecycle(editor),{disabled:!state.lifecycleLoaded})));
  grid.append(lifecycle);
  grid.append(node('section',{class:'settings-card'},node('h2',{text:'CORS 配置'}),node('p',{text:'当前 MinIO 服务器不支持通过 S3 API 管理存储桶 CORS。'}),node('div',{class:'notice warn',text:'CORS 配置在此不可用。请在支持该功能的服务端或反向代理中配置跨域请求。'})));
  grid.append(node('section',{class:'settings-card danger-zone'},node('h2',{text:'危险操作'}),node('p',{text:'仅空存储桶可以删除。删除后需要重新创建才能使用同名存储桶。'}),button('删除存储桶','danger',()=>deleteBucket(state.bucket))));
  view.append(grid);
}
async function loadLifecycle(){
  if(state.lifecycleLoaded || state.tab!=='settings') return;
  const bucket=state.bucket; state.lifecycleError='';
  try { const data=await jsonRequest(storageUrl(bucket,'/lifecycle')); if(bucket!==state.bucket) return; state.lifecycle=data || {rules:[]}; state.lifecycleLoaded=true; }
  catch(e){if(bucket!==state.bucket)return; if(e.status===404){state.lifecycle={rules:[]};state.lifecycleLoaded=true;}else{state.lifecycleError=e.message;apiError(e);}}
  render();
}
async function saveLifecycle(editor){
  let config; try{config=JSON.parse(editor.value);}catch(e){showToast('JSON 格式不正确，请检查语法。','error');return;}
  if(!config || typeof config!=='object' || Array.isArray(config) || !Array.isArray(config.rules)){showToast('配置需要包含 rules 数组。','error');return;}
  if(config.rules.some(rule=>rule?.status==='Enabled')){
    if(!await confirmDialog('确认自动删除规则','启用后，MinIO 将自动删除匹配前缀且超过指定天数的对象。请确认规则范围与天数。','确认保存',true))return;
  }
  try {await jsonRequest(storageUrl(state.bucket,'/lifecycle'),{method:'PUT',json:config});state.lifecycle=config;showToast('生命周期规则已保存。','success');}
  catch(e){apiError(e);}
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
  backdrop.addEventListener('click',(e)=>{if(e.target===backdrop)clear($('modal-root'));});
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
function openCreateBucket(){
  const modal=modalBase('创建存储桶','存储桶名称需在 3–63 个字符之间，使用小写字母、数字或连字符；不能包含连续连字符。');
  const input=node('input',{type:'text',placeholder:'例如 project-assets',autocomplete:'off',required:'',maxlength:'63',spellcheck:'false'});
  const error=node('p',{class:'form-error',hidden:true,role:'alert'});
  const submit=button('创建存储桶','primary',async()=>{
    const name=input.value.trim();
    if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name) || name.includes('--')){error.textContent='请输入有效的存储桶名称。';error.hidden=false;return;}
    submit.disabled=true;
    try{await jsonRequest('/api/buckets',{method:'POST',json:{name}});clear($('modal-root'));await loadBuckets();openBucket(name);showToast('存储桶已创建。','success');}
    catch(e){error.textContent=e.message;error.hidden=false;submit.disabled=false;}
  });
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit.click();}});
  modal.append(node('label',{for:'new-bucket-name',text:'存储桶名称'}));input.id='new-bucket-name';modal.append(input,error,node('div',{class:'modal-actions'},button('取消','',()=>clear($('modal-root'))),submit));input.focus();
}
async function deleteBucket(name){
  if(!await confirmDialog('删除存储桶',`确定删除“${name}”吗？存储桶必须为空。`,'删除存储桶',true))return;
  try{await jsonRequest(`${storageUrl(name)}?deleteBucket=1`,{method:'DELETE'});showToast('存储桶已删除。','success');state.page='overview';state.bucket='';await loadBuckets();}
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
    try{await jsonRequest(storageUrl(state.bucket,'/folders'),{method:'POST',json:{prefix:state.prefix+name+'/'}});clear($('modal-root'));showToast('文件夹已创建。','success');await loadObjects();}
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
    clear($('modal-root'));showToast(`已上传 ${files.length} 个文件。`,'success');await loadObjects();
  }catch(e){label.textContent=`上传中断：${e.message}`;apiError(e);modal.append(node('div',{class:'modal-actions'},button('关闭','',()=>clear($('modal-root')))));if(done)await loadObjects();}
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
    for(const [label,value] of [['对象键',data?.key||key],['大小',formatBytes(data?.size)],['内容类型',data?.contentType||'—'],['ETag',data?.etag||'—'],['上次修改',formatDate(data?.lastModified)]]) details.append(node('div',{},node('dt',{text:label}),node('dd',{text:value})));
    if(data?.metadata && Object.keys(data.metadata).length){
      for(const [name,value] of Object.entries(data.metadata)) details.append(node('div',{},node('dt',{text:`元数据 · ${name}`}),node('dd',{text:value})));
    }
    content.replaceWith(details);
    modal.append(node('div',{class:'modal-actions'},button('关闭','',()=>clear($('modal-root'))),button('下载','primary',()=>downloadObject(key))));
  }catch(e){content.textContent=e.message;content.className='form-error';}
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
  await loadObjects();
  if(failed.length){
    const modal=modalBase('部分对象删除失败',`已删除 ${keys.length-failed.length}/${keys.length} 个对象。以下 ${failed.length} 个对象未删除：`);
    const list=node('ul',{class:'failure-list'});
    for(const item of failed)list.append(node('li',{},node('strong',{text:item.key}),node('span',{text:item.message})));
    modal.append(list,node('div',{class:'modal-actions'},button('关闭','',()=>clear($('modal-root')))));
  } else showToast(`已删除 ${keys.length} 个对象。`,'success');
}
async function deleteObject(key){
  if(!await confirmDialog('删除对象',`确定删除“${key}”吗？此操作无法在控制台中撤销。`,'删除对象',true))return;
  try{await jsonRequest(objectUrl(state.bucket,key),{method:'DELETE'});showToast('对象已删除。','success');await loadObjects();}catch(e){apiError(e);}
}
init();
