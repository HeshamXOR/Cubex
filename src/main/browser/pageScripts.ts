/**
 * Code run inside a page, in a world of its own. The page's scripts cannot see the list of refs or replace the functions used
 * here, though they still own the DOM these read, which is why what comes back is treated as untrusted text.
 *
 * Events sent from here reach the page's own listeners. A value set from here also bypasses the setter a framework such as React
 * installs in the page's world, so the framework sees the following input event as a real change.
 */

export interface PageSnapshot {
  url: string
  title: string
  text: string
  truncated: boolean
  refs: number
}

export type ActionOutcome = { ok: true } | { ok: false; reason: string }

export function snapshotScript(maxChars: number): string {
  return `(() => {
  const MAX = ${Math.max(200, Math.floor(maxChars))};
  const refs = [];
  window.__cubexRefs = refs;
  const lines = [];
  let line = '';
  let size = 0;
  let full = false;
  const flush = () => {
    const text = line.replace(/\\s+/g, ' ').trim();
    line = '';
    if (!text || full) return;
    if (size + text.length > MAX) { full = true; return; }
    lines.push(text);
    size += text.length + 1;
  };
  const clip = (text, limit) => { const t = String(text || '').replace(/\\s+/g, ' ').trim(); return t.length > limit ? t.slice(0, limit) + '...' : t; };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']);
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'THEAD', 'TR', 'UL']);
  const ROLES = /^(?:button|link|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|combobox|textbox|searchbox|slider|spinbutton)$/;
  const hidden = (el) => {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const style = getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  };
  const interactive = (el) => {
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href');
    if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
    if (tag === 'INPUT') return el.type !== 'hidden';
    const role = el.getAttribute('role');
    if (role && ROLES.test(role)) return true;
    return el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable) || el.hasAttribute('onclick');
  };
  const nameOf = (el) => {
    const labelled = el.getAttribute('aria-labelledby');
    const byId = labelled ? labelled.split(/\\s+/).map((id) => { const found = document.getElementById(id); return found ? found.textContent : ''; }).join(' ') : '';
    const label = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    const image = el.querySelector ? el.querySelector('img[alt]') : null;
    return clip(el.getAttribute('aria-label') || byId || label || (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' ? '' : el.innerText) || (image && image.getAttribute('alt')) || el.title, 100);
  };
  const describe = (el, n) => {
    const tag = el.tagName;
    const role = el.getAttribute('role');
    const name = nameOf(el);
    const said = name ? ' "' + name + '"' : '';
    const flags = [el.disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled' : '', el.required ? 'required' : ''].filter(Boolean);
    let text;
    if (tag === 'A') {
      text = 'link' + said + ' -> ' + clip(el.getAttribute('href'), 120);
    } else if (tag === 'INPUT') {
      const type = el.type || 'text';
      if (type === 'checkbox' || type === 'radio') {
        text = type + said + (el.checked ? ' checked' : ' not checked');
      } else if (type === 'submit' || type === 'button' || type === 'reset') {
        text = 'button "' + clip(el.value || name, 100) + '"';
      } else {
        const value = type === 'password' ? (el.value ? '(hidden)' : '') : clip(el.value, 200);
        text = 'input ' + type + said + (value ? ' value="' + value + '"' : '') + (el.placeholder ? ' placeholder="' + clip(el.placeholder, 80) + '"' : '');
      }
    } else if (tag === 'TEXTAREA') {
      text = 'textarea' + said + (el.value ? ' value="' + clip(el.value, 200) + '"' : '') + (el.placeholder ? ' placeholder="' + clip(el.placeholder, 80) + '"' : '');
    } else if (tag === 'SELECT') {
      const options = [...el.options].slice(0, 12).map((option) => clip(option.label || option.value, 40) + (option.selected ? ' (selected)' : ''));
      text = 'select' + said + ' options: ' + options.join(', ') + (el.options.length > 12 ? ', and ' + (el.options.length - 12) + ' more' : '');
    } else if (el.isContentEditable) {
      text = 'editable text' + said;
    } else {
      text = (role || (tag === 'SUMMARY' ? 'summary' : 'button')) + said;
      const checked = el.getAttribute('aria-checked') || el.getAttribute('aria-selected');
      if (checked) text += ' ' + (checked === 'true' ? 'on' : 'off');
    }
    return '[' + n + '] ' + text + (flags.length ? ' (' + flags.join(', ') + ')' : '');
  };
  const walk = (node) => {
    if (full) return;
    if (node.nodeType === 3) { line += node.nodeValue; return; }
    if (node.nodeType === 11) { for (const child of node.childNodes) walk(child); return; }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || hidden(el)) return;
    if (tag === 'IFRAME') { flush(); line = '[frame: ' + clip(el.getAttribute('src') || 'embedded', 120) + ']'; flush(); return; }
    if (tag === 'IMG') { const alt = el.getAttribute('alt'); if (alt) line += ' [image: ' + clip(alt, 100) + '] '; return; }
    if (interactive(el)) {
      flush();
      const n = refs.length;
      refs.push(el);
      line = describe(el, n);
      flush();
      return;
    }
    const block = BLOCK.has(tag);
    if (block) flush();
    if (/^H[1-6]$/.test(tag)) line = '#'.repeat(Number(tag[1])) + ' ';
    if (tag === 'LI') line = '- ';
    if (el.shadowRoot) walk(el.shadowRoot);
    for (const child of el.childNodes) walk(child);
    if (tag === 'TD' || tag === 'TH') line += ' | ';
    if (block) flush();
  };
  if (document.body) walk(document.body);
  flush();
  return { url: location.href, title: document.title, text: lines.join('\\n'), truncated: full, refs: refs.length };
})()`
}

const FIND = (ref: number): string => `const el = (window.__cubexRefs || [])[${ref}];
  if (!el || !el.isConnected) return { ok: false, reason: 'Ref ${ref} is not on the page any more. Read the page again and use a new ref.' };`

export function clickScript(ref: number): string {
  return `(() => {
  ${FIND(ref)}
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'That control is disabled.' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const box = el.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const top = document.elementFromPoint(x, y);
  if (top && !el.contains(top) && !top.contains(el) && !(top.closest && top.closest('label') && el.labels && [...el.labels].includes(top.closest('label')))) {
    return { ok: false, reason: 'Something else is on top of that control: ' + top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + '. A person could not click it either.' };
  }
  const options = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', options));
  el.dispatchEvent(new MouseEvent('mousedown', options));
  if (el.focus) el.focus();
  el.dispatchEvent(new PointerEvent('pointerup', options));
  el.dispatchEvent(new MouseEvent('mouseup', options));
  el.click();
  return { ok: true };
})()`
}

export function typeScript(ref: number, text: string, submit: boolean): string {
  return `(() => {
  ${FIND(ref)}
  const text = ${JSON.stringify(text)};
  if (el.disabled || el.readOnly) return { ok: false, reason: 'That field cannot be changed.' };
  if (el.focus) el.focus();
  const tag = el.tagName;
  if (tag === 'SELECT') {
    const option = [...el.options].find((o) => o.label === text || o.value === text);
    if (!option) return { ok: false, reason: 'That list has no option called ' + JSON.stringify(text.slice(0, 80)) + '.' };
    el.value = option.value;
  } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
  } else {
    return { ok: false, reason: 'That control does not take text. Click it instead.' };
  }
  if (!el.isContentEditable) el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  if (${submit ? 'true' : 'false'}) {
    const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const proceed = el.dispatchEvent(new KeyboardEvent('keydown', key));
    el.dispatchEvent(new KeyboardEvent('keyup', key));
    if (proceed && el.form) {
      if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
    }
  }
  return { ok: true };
})()`
}

/** Whether this text is on the page yet: for pages that fill themselves in after they load. */
export function hasTextScript(text: string): string {
  return `(() => !!document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(text.toLowerCase())}))()`
}
