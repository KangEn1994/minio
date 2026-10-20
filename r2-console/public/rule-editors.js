/* Form-first editors. The JSON document is the model: no normalization or lossy projection. */
(function (root) {
  'use strict';
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = value => { checkDepth(value); return JSON.parse(JSON.stringify(value)); };
  const put = (o, k, v) => Object.defineProperty(o, k, {value:v, enumerable:true, writable:true, configurable:true});
  function checkDepth(v, depth=0) {
    if (depth > 30) throw new Error('配置嵌套超过 30 层，无法安全编辑。');
    if (typeof v==='number' && (!Number.isFinite(v) || Number.isInteger(v)&&!Number.isSafeInteger(v))) throw new Error('数字超出安全范围。请使用有限数字；大整数请在服务端允许时使用文本形式。');
    if (v && typeof v === 'object') Object.values(v).forEach(x => checkDepth(x, depth+1));
  }
  function parseDocument(text, kind) {
    if (typeof text !== 'string' || text.length > 1024*1024) throw new Error('JSON 文件不得超过 1 MiB。');
    let value; try { value=JSON.parse(text); } catch { throw new Error('JSON 格式不正确，原草稿未被修改。'); }
    if (!object(value)) throw new Error('配置必须是 JSON 对象。');
    if (kind === 'policy' && !(Array.isArray(value.Statement) || object(value.Statement))) throw new Error('策略需要 Statement 规则数组或单条规则对象。');
    if (kind === 'lifecycle' && !Array.isArray(value.rules)) throw new Error('生命周期配置需要 rules 数组。');
    if (!['policy','lifecycle'].includes(kind)) throw new Error('未知配置类型。');
    checkDepth(value); return clone(value);
  }
  const strings = v => typeof v === 'string' && v.length > 0 || Array.isArray(v) && v.length>0 && v.every(x=>typeof x==='string'&&x.length>0);
  function validatePolicy(value) {
    const errors=[];
    if (!object(value)) return ['策略必须是对象。'];
    if (!['2012-10-17','2008-10-17'].includes(value.Version)) errors.push('策略版本必须为 2012-10-17 或 2008-10-17。');
    const statements=Array.isArray(value.Statement)?value.Statement:object(value.Statement)?[value.Statement]:[];
    if (!statements.length || statements.length>100) errors.push('策略需要 1–100 条规则；移除全部策略请使用“移除策略”。');
    statements.forEach((s,i)=>{
      const p=`规则 ${i+1}：`;
      if(!object(s)){errors.push(p+'必须是对象。');return;}
      if(!['Allow','Deny'].includes(s.Effect))errors.push(p+'请选择允许或拒绝。');
      for(const [yes,no,label] of [['Action','NotAction','操作'],['Resource','NotResource','资源'],['Principal','NotPrincipal','访问主体']]) {
        if(own(s,yes)===own(s,no))errors.push(p+label+'需要正向或排除字段之一，不能同时存在。');
        else {
          const v=own(s,yes)?s[yes]:s[no];
          if(yes==='Principal') {
            if(!(typeof v==='string'&&v.length || object(v)&&Object.keys(v).length&&Object.values(v).every(strings)))errors.push(p+'访问主体需要非空名称或主体类型与名称列表。');
          } else if(!strings(v))errors.push(p+label+'至少需要一个非空值。');
        }
      }
      if(own(s,'Sid')&&typeof s.Sid!=='string')errors.push(p+'规则标识必须是文本。');
      if(own(s,'Condition')&&(!object(s.Condition)||Object.values(s.Condition).some(v=>!object(v))))errors.push(p+'条件必须按运算符 → 条件键 → 值组织。');
    });
    return errors;
  }
  function validatePolicyForApply(value) {
    const errors=validatePolicy(value);
    if(!object(value))return errors;
    const statements=Array.isArray(value.Statement)?value.Statement:object(value.Statement)?[value.Statement]:[];
    const wildcard=v=>typeof v==='string'?v.includes('*'):Array.isArray(v)?v.some(wildcard):object(v)?Object.values(v).some(wildcard):false;
    statements.forEach((s,i)=>{
      if(!object(s))return;
      if(['NotPrincipal','NotAction','NotResource'].some(k=>own(s,k)))errors.push(`规则 ${i+1}：当前服务端不支持排除模式策略的应用，可编辑并导出 JSON。`);
      if(s.Effect==='Allow'&&wildcard(s.Principal)) {
        const actions=Array.isArray(s.Action)?s.Action:[s.Action];
        if(actions.some(a=>a!=='s3:GetObject'))errors.push(`规则 ${i+1}：此控制台只允许匿名读取对象，禁止匿名写入或列出对象。`);
      }
    });return errors;
  }
  function validateLifecycle(value) {
    if(!object(value)||!Array.isArray(value.rules))return ['生命周期配置需要 rules 数组。'];
    const errors=[];const ids=new Set();
    const unknown=Object.keys(value).filter(k=>k!=='rules');
    if(unknown.length)errors.push(`无法安全应用未知顶层字段：${unknown.join('、')}。字段会保留在导出的 JSON 中。`);
    if(value.rules.length>1000)errors.push('最多支持 1000 条生命周期规则。');
    value.rules.forEach((r,i)=>{
      const p=`规则 ${i+1}：`;
      if(!object(r)){errors.push(p+'必须是对象。');return;}
      const extra=Object.keys(r).filter(k=>!['id','status','prefix','expirationDays','expirationDate'].includes(k));
      if(extra.length)errors.push(p+`服务端不支持字段 ${extra.join('、')}；保留导出，但不能应用，以免丢失配置。`);
      if(typeof r.id!=='string'||!r.id||r.id.length>255||ids.has(r.id))errors.push(p+'规则名称须为 1–255 字符且不重复。');
      ids.add(r.id);
      if(!['Enabled','Disabled'].includes(r.status))errors.push(p+'请选择启用或停用。');
      if(typeof r.prefix!=='string')errors.push(p+'匹配前缀必须是文本。');
      const days=own(r,'expirationDays'),date=own(r,'expirationDate');
      if(days===date)errors.push(p+'请选择按天数或按日期过期，二者只能选一个。');
      if(days&&(!Number.isInteger(r.expirationDays)||r.expirationDays<1||r.expirationDays>36500))errors.push(p+'过期天数须为 1–36500 的整数。');
      if(date) {
        const d=r.expirationDate;
        if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d+'T00:00:00.000Z'))||new Date(d+'T00:00:00.000Z').toISOString().slice(0,10)!==d)errors.push(p+'请选择有效过期日期。');
      }
    });
    return errors;
  }
  const labels={Version:'策略版本',Id:'策略标识（可选）',Sid:'规则名称（可选）',Effect:'权限效果',Principal:'访问主体',NotPrincipal:'排除这些主体',Action:'允许匹配的操作',NotAction:'除这些操作以外',Resource:'匹配资源',NotResource:'排除这些资源',Condition:'附加条件',AWS:'AWS / MinIO 用户',Service:'服务主体',CanonicalUser:'规范用户 ID',Federated:'联合身份主体'};
  function el(tag, attrs={}, ...children) {
    const n=document.createElement(tag);
    for(const [k,v]of Object.entries(attrs)){
      if(k==='text')n.textContent=v;
      else if(k==='class')n.className=v;
      else if(k==='value')n.value=v;
      else if(k==='on')for(const [name,fn]of Object.entries(v))n.addEventListener(name,fn);
      else if(k==='disabled')n.disabled=!!v;
      else if(v!==undefined)n.setAttribute(k,v);
    }
    children.flat(Infinity).filter(x=>x!==null&&x!==undefined).forEach(x=>n.append(x));return n;
  }
  const btn=(text,fn,cls='')=>el('button',{type:'button',class:'button '+cls,text,on:{click:fn}});
  function select(options,value,change,label) {
    const n=el('select',{'aria-label':label,on:{change:()=>change(n.value)}});
    options.forEach(([v,text])=>n.append(el('option',{value:v,text})));n.value=value;return n;
  }
  function field(label,input,hint='') {return el('label',{class:'rule-field'},el('span',{class:'rule-label',text:label}),input,hint?el('span',{class:'hint',text:hint}):null);}
  const kindOf=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
  const defaultValue=t=>({string:'',number:0,boolean:false,object:{},array:[],null:null})[t];
  const typeNames={string:'文本',number:'数字',boolean:'是 / 否',object:'字段组',array:'多值列表',null:'空值'};
  // Every JSON value is represented by typed controls, including extension fields.
  function valueControl(value,set,changed,label='值',depth=0) {
    const box=el('div',{class:'structured-value'});let current=value;
    const redraw=()=>{box.replaceChildren();render();changed.refresh?.();};
    const update=v=>{current=v;set(v);changed();};
    function render(){
      const type=kindOf(current);
      const picker=select(Object.entries(typeNames),type,t=>{if(t!==type){update(defaultValue(t));redraw();}},label+'类型');
      picker.className='type-select';box.append(picker);
      if(type==='string'||type==='number') {
        const input=el('input',{type:type==='number'?'number':'text',value:String(current),'aria-label':label,on:{input:()=>{if(type==='number'){const n=Number(input.value);const invalid=input.value===''||!Number.isFinite(n)||Number.isInteger(n)&&!Number.isSafeInteger(n);changed.numericError?.(input,invalid);if(invalid)return;update(n);}else update(input.value);}}});
        if(type==='number')input.setAttribute('step','any');box.append(input);
      } else if(type==='boolean')box.append(select([['true','是（true）'],['false','否（false）']],String(current),v=>update(v==='true'),label));
      else if(type==='null')box.append(el('span',{class:'hint',text:'JSON 空值 null'}));
      else {
        const rows=el('div',{class:'structured-rows'});box.append(rows);
        for(const key of Object.keys(current)) {
          const row=el('div',{class:'structured-row'});
          row.append(el('span',{class:'structured-key',text:type==='array'?`值 ${Number(key)+1}`:(labels[key]||key),title:key}));
          row.append(valueControl(current[key],v=>put(current,key,v),changed,label+' / '+key,depth+1));
          row.append(btn('移除',()=>{if(type==='array')current.splice(Number(key),1);else delete current[key];changed();redraw();},'small danger'));
          rows.append(row);
        }
        const add=el('div',{class:'structured-add'});
        if(type==='object') {
          const key=el('input',{type:'text',placeholder:'字段名称，例如 StringEquals、s3:prefix','aria-label':label+'新字段名称'});
          const error=el('span',{class:'form-error',role:'alert'});
          add.append(key,btn('添加字段',()=>{if(!key.value||own(current,key.value)){error.textContent='名称不能为空或与已有字段重复。';return;}put(current,key.value,'');changed();redraw();},'small'),error);
        } else add.append(btn('＋ 添加值',()=>{current.push('');changed();redraw();},'small'));
        box.append(add);
      }
    }
    render();return box;
  }
  function createEditor(kind,initial,options={}) {
    let value=clone(initial),dirty=false,busy=false;const invalidNumbers=new Set();
    const rootEl=el('div',{class:'visual-rule-editor','data-editor':kind});
    const form=el('fieldset',{class:'rule-form'}),status=el('div',{class:'rule-validation',role:'status'});
    const preview=el('textarea',{class:'code-input generated-json',readonly:'',spellcheck:'false','aria-label':kind==='policy'?'自动生成的策略 JSON':'自动生成的生命周期 JSON'});
    const previewBox=el('details',{class:'json-preview'},el('summary',{text:'查看自动生成的 JSON'}),preview);
    const validate=kind==='policy'?validatePolicyForApply:validateLifecycle;
    const changed=()=>{dirty=true;refresh();options.onChange?.(clone(value));};
    changed.numericError=(input,invalid)=>{if(invalid)invalidNumbers.add(input);else invalidNumbers.delete(input);dirty=true;refresh();};
    const refresh=()=>{
      for(const input of invalidNumbers)if(!rootEl.contains(input))invalidNumbers.delete(input);
      preview.value=JSON.stringify(value,null,2);const errors=validate(value);
      status.replaceChildren();status.append(el('div',{text:dirty?'有未应用的草稿更改':'当前配置已载入'}));
      if(invalidNumbers.size)errors.push('请修正无效或超出安全范围的数字。预览保留最后有效值；修正前不能导出或应用。');
      errors.forEach(message=>status.append(el('div',{class:'form-error',text:message})));
      apply.disabled=busy||errors.length>0;exportButton.disabled=invalidNumbers.size>0;copy.disabled=invalidNumbers.size>0;form.disabled=busy;importButton.disabled=busy;
    };
    changed.refresh=refresh;
    const exportButton=btn('导出 JSON（不应用）',()=>{
      const blob=new Blob([JSON.stringify(value,null,2)+'\n'],{type:'application/json'});
      const url=URL.createObjectURL(blob);const a=el('a',{href:url,download:`${options.bucket||'bucket'}-${kind}.json`});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    const copy=btn('复制 JSON',async()=>{try{await navigator.clipboard.writeText(JSON.stringify(value,null,2));status.textContent='JSON 已复制，尚未应用到存储桶。';}catch{status.textContent='无法访问剪贴板，请展开 JSON 预览后复制。';}});
    const importInput=el('input',{type:'file',accept:'.json,application/json','aria-label':'导入 JSON 文件'});importInput.hidden=true;
    const importButton=btn('导入 JSON 到草稿',()=>importInput.click());
    let importVersion=0;
    importInput.addEventListener('change',async()=>{
      const file=importInput.files?.[0];if(!file||busy)return;const version=++importVersion;
      try{
        if(file.size>1024*1024)throw new Error('JSON 文件不得超过 1 MiB。');
        const next=parseDocument(await file.text(),kind);if(version!==importVersion)return;
        if(dirty&&options.confirmReplace&&!await options.confirmReplace())return;
        if(version!==importVersion)return;value=next;draw();changed();
      }catch(e){status.textContent=e.message;status.className='rule-validation form-error';}
      finally{importInput.value='';}
    });
    const apply=btn(kind==='policy'?'检查并应用策略':'检查并应用规则',async()=>{
      if(busy||validate(value).length||invalidNumbers.size)return;busy=true;++importVersion;refresh();
      try{await options.onApply?.(clone(value));}finally{busy=false;refresh();}
    },'primary');
    rootEl.append(el('div',{class:'notice',text:'填写表单即可生成 JSON。导入、编辑和导出仅修改草稿；点击“检查并应用”并确认后才会更新存储桶。'}),form,status,
      el('div',{class:'rule-toolbar'},importButton,exportButton,copy,apply,importInput),previewBox);
    function textField(label,v,update,hint='',type='text') {
      const input=el('input',{type,value:v??'','aria-label':label,on:{input:()=>{if(type==='number'){const n=Number(input.value);const invalid=input.value===''||!Number.isFinite(n)||Number.isInteger(n)&&!Number.isSafeInteger(n);changed.numericError(input,invalid);if(invalid)return;}update(input.value);changed();}}});return field(label,input,hint);
    }
    function genericExtra(container,target,known,label) {
      const extras=Object.keys(target).filter(k=>!known.includes(k));
      if(!extras.length)return;
      const details=el('details',{class:'rule-advanced',open:''},el('summary',{text:label}));
      extras.forEach(key=>details.append(field(key,valueControl(target[key],v=>put(target,key,v),changed,key)),btn('移除 '+key,()=>{delete target[key];draw();changed();},'small danger')));
      container.append(details);
    }
    function pair(container,s,a,b,label,defaults){
      const key=own(s,a)?a:own(s,b)?b:a;
      const toggle=select([[a,label],[b,'排除模式：'+label]],key,newKey=>{const v=s[key]??defaults;delete s[a];delete s[b];put(s,newKey,v);draw();changed();},label+'匹配模式');
      container.append(field(label+'匹配模式',toggle),field(labels[key]||key,valueControl(s[key]??'',v=>put(s,key,v),changed,label)));
      if(own(s,a)&&own(s,b))container.append(field('冲突字段 '+b,valueControl(s[b],v=>put(s,b,v),changed,b)),btn('移除冲突字段 '+b,()=>{delete s[b];draw();changed();},'danger small'));
    }
    function drawPolicy(){
      form.append(el('div',{class:'rule-grid'},field('策略版本',select([['2012-10-17','2012-10-17（推荐）'],['2008-10-17','2008-10-17']],value.Version,v=>{value.Version=v;changed();},'策略版本')),textField('策略标识（可选）',value.Id,v=>{if(v)put(value,'Id',v);else delete value.Id;})));
      const items=Array.isArray(value.Statement)?value.Statement:[value.Statement];
      if(!Array.isArray(value.Statement))form.append(el('p',{class:'hint',text:'已保留原配置的单条 Statement 对象格式。添加第二条规则时才转换为数组。'}));
      items.forEach((s,index)=>{
        const card=el('section',{class:'rule-card'});
        const title=el('div',{class:'rule-card-head'},el('h3',{text:`权限规则 ${index+1}`}),btn('删除这条规则',()=>{items.splice(index,1);value.Statement=items;draw();changed();},'small danger'));card.append(title);
        if(!object(s)){card.append(valueControl(s,v=>{if(Array.isArray(value.Statement))value.Statement[index]=v;else value.Statement=v;},changed,'规则'));form.append(card);return;}
        card.append(el('div',{class:'rule-grid'},textField('规则名称（Sid，可选）',s.Sid,v=>{if(v)put(s,'Sid',v);else delete s.Sid;}),field('允许或拒绝',select([['Allow','允许（Allow）'],['Deny','拒绝（Deny）']],s.Effect,v=>{s.Effect=v;changed();},'允许或拒绝'))));
        const principal=s.Principal;
        const aws=object(principal)?principal.AWS:undefined;
        const isPublic=principal==='*'||aws==='*'||Array.isArray(aws)&&aws.length===1&&aws[0]==='*';
        const isUsers=object(principal)&&Object.keys(principal).length===1&&own(principal,'AWS')&&!isPublic;
        const principalMode=own(s,'NotPrincipal')?'advanced':isPublic?'public':isUsers?'users':'advanced';
        card.append(field('谁可以访问',select([['public','所有人（无需登录）'],['users','指定用户'],['advanced','其他主体 / 高级配置']],principalMode,m=>{
          if(m==='advanced'){raw.open=true;return;}
          delete s.NotPrincipal;s.Principal=m==='public'?'*':{AWS:['']};draw();changed();
        },'谁可以访问')));
        if(principalMode==='users') {
          const values=Array.isArray(aws)?aws:[aws];
          const list=el('div',{class:'simple-value-list'});
          values.forEach((arn,i)=>list.append(el('div',{class:'simple-value-row'},textField('用户 ARN '+(i+1),arn,v=>{const next=[...values];next[i]=v;s.Principal.AWS=Array.isArray(aws)?next:next[0];values[i]=v;},'填写 MinIO 用户 ARN，不需要输入 JSON。'),btn('移除用户',()=>{values.splice(i,1);s.Principal.AWS=values;draw();changed();},'small danger'))));
          list.append(btn('＋ 添加用户',()=>{s.Principal.AWS=[...values,''];draw();changed();},'small'));card.append(list);
        } else if(principalMode==='public')card.append(el('div',{class:'notice warn',text:'任何人都可能读取对象。此控制台禁止匿名上传、删除或列出对象。'}));
        else card.append(el('p',{class:'hint',text:'已保留导入的高级主体配置，可展开下方“高级权限字段”修改。选择其他访问范围会明确替换主体配置。'}));
        const actionValues=Array.isArray(s.Action)?s.Action:typeof s.Action==='string'?[s.Action]:[];
        const actionList=el('div',{class:'permission-options'});
        card.append(el('div',{class:'rule-label',text:s.Effect==='Deny'?'拒绝哪些操作':'可以执行哪些操作'}));
        for(const [action,label] of [['s3:GetObject','读取 / 下载'],['s3:PutObject','上传 / 覆盖'],['s3:ListBucket','列出对象'],['s3:DeleteObject','删除对象']]) {
          const enabled=actionValues.includes(action);
          const b=btn((enabled?'✓ ':'＋ ')+label,()=>{const next=enabled?actionValues.filter(x=>x!==action):[...actionValues,action];delete s.NotAction;s.Action=typeof s.Action==='string'&&next.length===1?next[0]:next;draw();changed();},enabled?'selected':'');
          b.setAttribute('aria-pressed',String(enabled));actionList.append(b);
        }
        card.append(actionList);
        const customActions=el('details',{class:'rule-advanced'},el('summary',{text:'自定义 S3 操作 / 查看全部操作'}));
        actionValues.forEach((action,i)=>customActions.append(el('div',{class:'simple-value-row'},textField('S3 操作 '+(i+1),action,v=>{actionValues[i]=v;s.Action=typeof s.Action==='string'?v:[...actionValues];}),btn('移除操作',()=>{actionValues.splice(i,1);s.Action=actionValues;draw();changed();},'small danger'))));
        customActions.append(btn('＋ 添加自定义操作',()=>{delete s.NotAction;s.Action=[...actionValues,''];draw();changed();},'small'));card.append(customActions);
        const resources=Array.isArray(s.Resource)?s.Resource:typeof s.Resource==='string'?[s.Resource]:[];
        const bucketArn=`arn:aws:s3:::${options.bucket||'bucket'}`;
        card.append(el('div',{class:'rule-label',text:'规则匹配哪些资源'}));
        const shortcuts=el('div',{class:'rule-shortcuts'});
        shortcuts.append(btn('填入整个桶和全部对象',()=>{delete s.NotResource;s.Resource=[bucketArn,bucketArn+'/*'];draw();changed();},'small'));
        const prefixInput=el('input',{type:'text',placeholder:'例如 images/','aria-label':'资源对象前缀'});
        shortcuts.append(field('只匹配对象前缀',prefixInput),btn('使用此前缀',()=>{delete s.NotResource;s.Resource=[bucketArn+'/'+prefixInput.value+'*'];draw();changed();},'small'));card.append(shortcuts);
        card.append(el('p',{class:'hint',text:'快捷范围会替换资源列表。列出对象作用于桶资源；读取、上传、删除作用于对象资源。限制列出范围还需要 s3:prefix 条件。'}));
        resources.forEach((resource,i)=>card.append(el('div',{class:'simple-value-row'},textField('资源 ARN '+(i+1),resource,v=>{resources[i]=v;s.Resource=typeof s.Resource==='string'?v:[...resources];}),btn('移除资源',()=>{resources.splice(i,1);s.Resource=resources;draw();changed();},'small danger'))));
        card.append(btn('＋ 添加资源',()=>{delete s.NotResource;s.Resource=[...resources,''];draw();changed();},'small'));
        const raw=el('details',{class:'rule-advanced'},el('summary',{text:'高级权限字段：主体类型、排除匹配和原始数据类型'}));
        const rawFields=el('div');
        const refreshRaw=()=>{rawFields.replaceChildren();pair(rawFields,s,'Principal','NotPrincipal','访问主体','*');pair(rawFields,s,'Action','NotAction','操作',['s3:GetObject']);pair(rawFields,s,'Resource','NotResource','资源',[bucketArn+'/*']);};
        raw.append(rawFields);refreshRaw();
        raw.addEventListener('toggle',()=>{if(raw.open){refreshRaw();refresh();}else if(rawFields.children.length){draw();refresh();}});
        card.append(raw);
        const advanced=el('details',{class:'rule-advanced'},el('summary',{text:'附加条件（IP、前缀、时间等）'}));
        if(own(s,'Condition'))advanced.append(field('条件运算符 → 条件键 → 值',valueControl(s.Condition,v=>put(s,'Condition',v),changed,'附加条件')),btn('移除全部条件',()=>{delete s.Condition;draw();changed();},'small danger'));
        else advanced.append(btn('＋ 添加条件',()=>{s.Condition={StringEquals:{'s3:prefix':['']}};draw();changed();},'small'));
        card.append(advanced);genericExtra(card,s,['Sid','Effect','Principal','NotPrincipal','Action','NotAction','Resource','NotResource','Condition'],'其他原始字段（完整保留）');form.append(card);
      });
      form.append(btn('＋ 添加权限规则',()=>{items.push({Sid:'',Effect:'Allow',Principal:{AWS:['']},Action:['s3:GetObject'],Resource:[`arn:aws:s3:::${options.bucket||'bucket'}/*`]});value.Statement=items;draw();changed();}));
      genericExtra(form,value,['Version','Id','Statement'],'其他策略字段（完整保留）');
    }
    function drawLifecycle(){
      value.rules.forEach((r,index)=>{
        const card=el('section',{class:'rule-card'});card.append(el('div',{class:'rule-card-head'},el('h3',{text:`过期规则 ${index+1}`}),btn('删除这条规则',()=>{value.rules.splice(index,1);draw();changed();},'small danger')));
        if(!object(r)){card.append(valueControl(r,v=>value.rules[index]=v,changed,'规则'));form.append(card);return;}
        card.append(el('div',{class:'rule-grid'},textField('规则名称',r.id,v=>r.id=v),field('规则状态',select([['Disabled','停用'],['Enabled','启用：会自动删除匹配对象']],r.status,v=>{r.status=v;changed();},'规则状态'))));
        card.append(textField('匹配对象前缀',r.prefix,v=>r.prefix=v,'留空匹配整个桶；例如 logs/ 仅匹配此前缀。空格是对象名称的一部分，不会自动删除。'));
        const mode=own(r,'expirationDate')?'date':'days';
        card.append(field('过期方式',select([['days','创建后经过指定天数'],['date','在指定日期过期（UTC）']],mode,m=>{delete r.expirationDays;delete r.expirationDate;if(m==='days')r.expirationDays=30;else r.expirationDate='';draw();changed();},'过期方式')));
        if(mode==='days')card.append(textField('过期天数',r.expirationDays,v=>r.expirationDays=v===''?'':Number(v),'1–36500 天。','number'));
        else card.append(textField('过期日期（UTC）',r.expirationDate,v=>r.expirationDate=v,'按 UTC 零点处理，可能立即影响已符合条件的对象。','date'));
        if(own(r,'expirationDays')&&own(r,'expirationDate'))card.append(el('p',{class:'form-error',text:'导入规则同时包含天数和日期。请重新选择过期方式以明确保留哪一个。'}));
        genericExtra(card,r,['id','status','prefix','expirationDays','expirationDate'],'服务端不支持的原始字段（保留导出，阻止应用）');form.append(card);
      });
      if(!value.rules.length)form.append(el('p',{class:'rule-empty',text:'暂无过期规则。添加规则后可以逐条设置范围、启用状态和过期时间。'}));
      form.append(btn('＋ 添加过期规则',()=>{let n=value.rules.length+1;while(value.rules.some(r=>r?.id==='rule-'+n))n++;value.rules.push({id:'rule-'+n,status:'Disabled',prefix:'',expirationDays:30});draw();changed();}));
      genericExtra(form,value,['rules'],'其他导入字段（保留导出，阻止应用）');
    }
    function draw(){invalidNumbers.clear();form.replaceChildren();if(kind==='policy')drawPolicy();else drawLifecycle();}
    draw();refresh();
    return {element:rootEl,getValue:()=>clone(value),isDirty:()=>dirty,isBusy:()=>busy,setValue(next){if(busy)return false;value=clone(next);dirty=true;draw();refresh();return true;},validate:()=>validate(value)};
  }
  root.RuleEditors={clone,parseDocument,validatePolicy,validatePolicyForApply,validateLifecycle,
    createPolicyEditor:(value,options)=>createEditor('policy',value,options),
    createLifecycleEditor:(value,options)=>createEditor('lifecycle',value,options)};
})(globalThis);
