import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A small deterministic DOM fixture keeps these interaction tests dependency-free.
// It checks the client handlers and mocked API traffic, not browser layout.
class Element {
  constructor(tag = 'text') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this._text = '';
    this._value = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
  }
  append(...items) {
    for (const item of items) {
      if (item == null) continue;
      const child = item instanceof Element ? item : new Element('text');
      if (!(item instanceof Element)) child.textContent = String(item);
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...items) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this._text = '';
    this.append(...items);
  }
  replaceWith(other) {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    parent.children[index] = other;
    other.parentElement = parent;
    this.parentElement = null;
  }
  remove() {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(other) {
    return this === other || this.children.some(child => child.contains(other));
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get value() {
    if (this._value) return this._value;
    if (this.tagName === 'SELECT') return this.children.find(child => child.tagName === 'OPTION')?.value || '';
    return this._value;
  }
  set value(value) { this._value = String(value); }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === 'id') this.id = String(value); }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  dispatch(type) {
    const event = { type, target: this, preventDefault() {} };
    return this.listeners[type]?.at(-1)?.(event);
  }
  click() { return this.dispatch('click'); }
  focus() {}
  select() {}
}

function walk(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children) {
    const found = walk(child, predicate);
    if (found) return found;
  }
  return null;
}
function byText(root, tag, text) {
  return walk(root, item => item.tagName === tag.toUpperCase() && item.textContent === text);
}

function fixture(respond = () => ({ ok: true })) {
  const body = new Element('body');
  const document = {
    body,
    createElement: tag => new Element(tag),
    createTextNode: text => { const element = new Element('text'); element.textContent = text; return element; },
    getElementById: id => walk(body, item => item.id === id)
  };
  for (const id of ['modal-root', 'toast-root', 'view']) {
    const root = new Element('div'); root.id = id; body.append(root);
  }
  const calls = [];
  const fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), method, body });
    const result = await respond(String(url), method, body);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const clipboardWrites = [];
  const context = vm.createContext({
    document, Node: Element, fetch, Headers, Response, URL, URLSearchParams,
    TextEncoder, Intl, Date, Number, String, Object, Array, Set, Map, Math,
    navigator: { clipboard: { writeText: async value => { clipboardWrites.push(value); } } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1
  });
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /\ninit\(\);\s*$/);
  vm.runInContext(source.replace(/\ninit\(\);\s*$/, ''), context, { filename: 'public/app.js' });
  vm.runInContext("state.csrf='test-csrf'", context);
  return { body, document, calls, clipboardWrites, evaluate: code => vm.runInContext(code, context) };
}

test('overview bucket filter changes visible rows without an API request', () => {
  const f = fixture();
  f.evaluate("state.buckets=[{name:'photos'},{name:'reports'}];renderOverview(document.getElementById('view'))");
  const search = walk(f.body, item => item.attrs['aria-label'] === '按名称查找存储桶');
  assert.ok(search);
  search.value = 'photo'; search.dispatch('input');
  const rows = [];
  const visit = item => { if (item.tagName === 'TR' && /photos|reports/.test(item.textContent)) rows.push(item); item.children.forEach(visit); };
  visit(f.body);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.textContent.includes('photos')).hidden, false);
  assert.equal(rows.find(row => row.textContent.includes('reports')).hidden, true);
  assert.equal(f.calls.length, 0);
});

test('lifecycle save uses server readback, including normalized rules', async () => {
  const serverConfig = { rules: [{ id: 'canonical', status: 'Disabled', prefix: '', expirationDays: 7 }] };
  const f = fixture(() => serverConfig);
  f.evaluate("state.bucket='photos'");
  const editor = f.document.createElement('textarea');
  editor.value = JSON.stringify({ rules: [{ id: 'submitted', status: 'Disabled', prefix: '', expirationDays: 7 }] });
  f.body.append(editor);
  f.evaluate('globalThis.editorUnderTest=document.body.children.at(-1)');
  await f.evaluate('saveLifecycle(editorUnderTest)');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/buckets/photos/lifecycle');
  assert.equal(f.calls[0].method, 'PUT');
  assert.equal(JSON.parse(editor.value).rules[0].id, 'canonical');
  assert.equal(f.evaluate('state.lifecycle.rules[0].id'), 'canonical');
});

test('access key creation requires typed bucket and exposes secret only in one-time modal', async () => {
  const f = fixture((url, method) => {
    if (url === '/api/admin/access-keys' && method === 'POST') return { account: { accessKey: 'AKTEST' }, secretKey: 'example-secret' };
    if (url === '/api/admin/access-keys' && method === 'GET') return { accounts: [] };
    throw new Error(`Unexpected ${method} ${url}`);
  });
  f.evaluate("state.buckets=[{name:'photos'}];state.adminCapabilities={available:true};openCreateAccessKey()");
  let create = byText(f.body, 'button', '创建密钥');
  assert.ok(create);
  await create.click();
  assert.equal(f.calls.length, 0);
  assert.match(f.body.textContent, /请准确输入/);
  f.document.getElementById('key-prefix').value = ' team /';
  f.document.getElementById('key-confirm-bucket').value = 'photos';
  await create.click();
  const post = f.calls.find(call => call.method === 'POST');
  assert.ok(post);
  assert.equal(post.body.confirmBucket, 'photos');
  assert.equal(post.body.prefix, ' team /');
  assert.deepEqual(post.body.permissions, ['list', 'read']);
  assert.ok(walk(f.body, item => item.tagName === 'TEXTAREA' && item.value === 'example-secret'));
  assert.equal(f.clipboardWrites.length, 0);
  byText(f.body, 'button', '我已保存，关闭').click();
  assert.equal(f.body.textContent.includes('example-secret'), false);
  assert.equal(walk(f.body, item => item.value === 'example-secret'), null);
});

test('multipart list loads subsequent page using returned markers', async () => {
  const f = fixture(url => url.includes('keyMarker=')
    ? { uploads: [{ key: 'b', uploadId: 'u2' }], hasMore: false }
    : { uploads: [{ key: 'a', uploadId: 'u1' }], hasMore: true, nextKeyMarker: 'a', nextUploadIdMarker: 'u1' });
  f.evaluate("state.page='bucket';state.tab='settings';state.bucket='photos'");
  await f.evaluate('loadMultipartUploads(false)');
  assert.equal(f.evaluate('state.multipartUploads.length'), 1);
  assert.equal(f.evaluate('state.multipartHasMore'), true);
  await f.evaluate('loadMultipartUploads(true)');
  assert.equal(f.evaluate('state.multipartUploads.length'), 2);
  assert.equal(f.evaluate('state.multipartHasMore'), false);
  assert.match(f.calls[1].url, /keyMarker=a/);
  assert.match(f.calls[1].url, /uploadIdMarker=u1/);
});

test('copy action validates destination and POSTs only after confirmation', async () => {
  const f = fixture(() => ({ key: 'archive/copy.txt' }));
  f.evaluate("openCopyObject('photos','source.txt')");
  const destination = f.document.getElementById('copy-destination');
  destination.value = 'source.txt';
  const submit = byText(f.body, 'button', '复制对象');
  await submit.click();
  assert.equal(f.calls.length, 0);
  destination.value = 'archive/copy.txt';
  const pending = submit.click();
  assert.equal(f.calls.length, 0);
  byText(f.body, 'button', '确认复制').click();
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/buckets/photos/objects/source.txt/copy');
  assert.deepEqual(f.calls[0].body, { destinationKey: 'archive/copy.txt' });
});

test('metadata edit requires a change and confirmation before PATCH', async () => {
  const f = fixture(() => ({ key: 'source.txt', contentType: 'text/plain' }));
  f.evaluate("openEditMetadata('photos','source.txt',{contentType:'text/plain'})");
  const submit = byText(f.body, 'button', '保存元数据');
  await submit.click();
  assert.equal(f.calls.length, 0);
  assert.match(f.body.textContent, /至少一项/);
  f.document.getElementById('edit-content-type').value = 'text/markdown';
  f.document.getElementById('edit-custom-metadata').value = '{"label":"draft"}';
  const pending = submit.click();
  assert.equal(f.calls.length, 0);
  byText(f.body, 'button', '确认保存').click();
  await pending;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'PATCH');
  assert.equal(f.calls[0].url, '/api/buckets/photos/objects/source.txt/metadata');
  assert.deepEqual(f.calls[0].body, { patch: { contentType: 'text/markdown', customMetadata: { label: 'draft' } } });
});

test('bucket stats show a lower bound when the API scan is capped', async () => {
  const f = fixture(() => ({ objects: 10000, bytes: 1048576, exact: false, includesVersions: false }));
  f.evaluate("state.page='bucket';state.tab='objects';state.bucket='photos';renderBucketStats(document.getElementById('view'))");
  await f.evaluate('loadBucketStats()');
  assert.equal(f.calls[0].url, '/api/buckets/photos/stats');
  assert.match(f.body.textContent, /≥ 10,000/);
  assert.match(f.body.textContent, /不含历史版本/);
});

test('presigned URL button requests bounded expiry and does not copy automatically', async () => {
  const f = fixture(() => ({ url: 'http://127.0.0.1:9000/photos/source.txt?X-Amz-Signature=example', expiresAt: '2026-10-19T17:00:00Z' }));
  const modal = f.document.createElement('div');
  f.document.getElementById('modal-root').append(modal);
  const output = f.document.createElement('div'); modal.append(output);
  const expiry = f.document.createElement('input'); expiry.id = 'test-expiry'; expiry.value = '30'; modal.append(expiry);
  const button = f.document.createElement('button'); button.id = 'test-share-button'; modal.append(button);
  await f.evaluate("makeShareLink('photos','source.txt','GET',document.getElementById('test-expiry'),document.getElementById('modal-root').firstChild.firstChild,document.getElementById('modal-root').firstChild,[document.getElementById('test-share-button')])");
  assert.equal(f.calls.length, 0);
  assert.match(output.textContent, /60–3600/);
  expiry.value = '120';
  await f.evaluate("makeShareLink('photos','source.txt','GET',document.getElementById('test-expiry'),document.getElementById('modal-root').firstChild.firstChild,document.getElementById('modal-root').firstChild,[document.getElementById('test-share-button')])");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, '/api/buckets/photos/objects/source.txt/share');
  assert.deepEqual(f.calls[0].body, { method: 'GET', expiresSeconds: 120 });
  assert.equal(f.clipboardWrites.length, 0);
  assert.match(output.textContent, /回环地址/);
  assert.ok(walk(output, item => item.tagName === 'TEXTAREA' && item.value.includes('X-Amz-Signature')));
});
