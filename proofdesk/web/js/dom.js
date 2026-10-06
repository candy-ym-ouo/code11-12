// 微型 DOM 辅助（无框架）
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v);
    } else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...nodes) {
  clear(el);
  el.append(...nodes.flat().filter(Boolean));
}

const COLORS = ['#8a5a2b', '#2f5d8a', '#3e7a4f', '#8a4b7a', '#b07a2e', '#4a6b8a', '#7a3e3e', '#5a6b3e'];
export function colorFor(id) {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum = (sum * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[sum % COLORS.length];
}

export function avatar(name, id, size = '') {
  const ch = (name || '?').trim()[0] || '?';
  return h('span', { class: `avatar ${size}`, style: `background:${colorFor(id || name)}` }, ch);
}

export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtClock(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer = null;
export function toast(msg, isErr = false) {
  const box = document.getElementById('toast');
  box.textContent = msg;
  box.className = 'toast' + (isErr ? ' err' : '');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.hidden = true), 2600);
}

export function confirmAsync(message) {
  return new Promise((resolve) => {
    const ok = window.confirm(message);
    resolve(ok);
  });
}

/** 自定义模态框 */
export function modal({ title, body, footer, wide = false }) {
  const root = document.getElementById('modal-root');
  const mask = h('div', { class: 'modal-mask' });
  const close = () => root.removeChild(mask);
  const footNodes = footer ? footer(close) : [h('button', { class: 'btn', onClick: close }, '关闭')];
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') }, [
    h('div', { class: 'modal-head' }, [
      h('h3', {}, title),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onClick: close }, '✕'),
    ]),
    h('div', { class: 'modal-body' }, body),
    h('div', { class: 'modal-foot' }, footNodes),
  ]);
  mask.append(box);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  root.append(mask);
  return { close, root: box, body };
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

export function statusBadge(status) {
  const map = {
    agreed: ['一致', 'agreed'],
    conflict: ['冲突', 'conflict'],
    incomplete: ['未齐', 'incomplete'],
    unreviewed: ['待校', 'unreviewed'],
    draft: ['校对中', 'draft'],
    confirmed: ['已定稿', 'confirmed'],
  };
  const [text, cls] = map[status] || [status, 'draft'];
  return h('span', { class: `badge ${cls}` }, text);
}

export const debounce = (fn, ms = 500) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};
