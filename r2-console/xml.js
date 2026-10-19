// Small, dependency-free parser for the limited S3 XML response surface.
// DTD and external entities are never accepted.
export function xmlDecode(s = '') {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    switch (entity) {
      case 'amp': return '&'; case 'lt': return '<'; case 'gt': return '>';
      case 'quot': return '"'; case 'apos': return "'";
      default: {
        const n = entity[1].toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
          ? String.fromCodePoint(n) : '\ufffd';
      }
    }
  });
}

export function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function parseXml(source) {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)) throw new Error('Unsafe XML response');
  const document = { name: '#document', children: [], text: '' };
  const stack = [document];
  const tokens = source.match(/<[^>]*>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--')) continue;
    if (token.startsWith('</')) {
      const name = token.slice(2, -1).trim();
      if (stack.length < 2 || stack.at(-1).name !== name) throw new Error('Malformed XML response');
      stack.pop();
    } else if (token.startsWith('<')) {
      const selfClosing = token.endsWith('/>');
      const name = token.slice(1, selfClosing ? -2 : -1).trim().split(/\s+/)[0];
      if (!/^[A-Za-z_][\w:.-]*$/.test(name)) throw new Error('Malformed XML response');
      const item = { name, children: [], text: '' };
      stack.at(-1).children.push(item);
      if (!selfClosing) stack.push(item);
    } else {
      stack.at(-1).text += xmlDecode(token);
    }
  }
  if (stack.length !== 1) throw new Error('Malformed XML response');
  return document.children[0] || document;
}

export const children = (node, name) => (node?.children || []).filter(child => child.name === name);
export const child = (node, name) => children(node, name)[0];
// S3 keys and prefixes are byte-sensitive: leading/trailing spaces are valid.
export const value = (node, name) => child(node, name)?.text || '';
