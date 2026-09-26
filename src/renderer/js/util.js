// Small DOM and formatting helpers shared by every module.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function iconBtn(name, title, onClick, extraClass = '') {
  const b = h('button', { class: 'icon-btn ' + extraClass, title, html: icon(name) });
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function textBtn(label, onClick, { iconName, primary, title } = {}) {
  const b = h('button', { class: 'btn' + (primary ? ' primary' : ''), title });
  b.innerHTML = (iconName ? icon(iconName, 18) : '') + `<span>${escapeHtml(label)}</span>`;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const hrs = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return hrs ? `${hrs}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function fmtTotal(sec) {
  sec = Math.round(sec || 0);
  const hrs = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return hrs ? `${hrs} h ${m} min` : `${m} min`;
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function shuffleArray(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const cmp = (a, b) => collator.compare(a ?? '', b ?? '');

function basename(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

function toast(msg, ms = 2600) {
  const el = h('div', { class: 'toast', text: msg });
  $('#toast-root').append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function isTyping(e) {
  const t = e.target;
  if (!t) return false;
  if (t.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'color'].includes(t.type);
  return t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
}
