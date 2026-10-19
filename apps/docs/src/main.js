import './style.css';
import { pages } from './content.js';

const owlUrl = `${import.meta.env.BASE_URL}owl.png`;
const demoUrl = import.meta.env.VITE_DEMO_URL || 'https://owl-pilot-demo.vercel.app';
const main = document.querySelector('#main');
const escape = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const linkDemo = () => document.querySelectorAll('[data-demo]').forEach((a) => { a.href = demoUrl; });
const nav = document.querySelector('#navigation');
let group;
let unmountApp;
let renderVersion = 0;
pages.forEach((page) => {
  if (group !== page.group) { group = page.group; nav.insertAdjacentHTML('beforeend', `<div class="nav-label">${group}</div>`); }
  nav.insertAdjacentHTML('beforeend', `<a href="#${page.id}" data-page="${page.id}"><span class="nav-marker">${page.id === 'overview' ? '◈' : '·'}</span>${page.title}<span class="nav-arrow">↗</span></a>`);
});

function render() {
  const version = ++renderVersion;
  unmountApp?.();
  unmountApp = undefined;
  const [pageId, sectionId] = location.hash.slice(1).split('/');
  const page = pages.find((p) => p.id === pageId) || pages[0];
  document.title = `${page.title} — Pilot docs`;
  document.querySelectorAll('[data-page]').forEach((a) => {
    const active = a.dataset.page === page.id;
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const index = pages.indexOf(page);
  main.innerHTML = `<div class="breadcrumb">Documentation <span>/</span> ${page.title}</div>
    <div class="page-heading"><div class="eyebrow"><span></span>${page.eyebrow}</div><h1>${page.id === 'overview' ? 'Meet your new<br />pilot<span class="green-dot">.</span>' : page.title}</h1><p class="lead">${page.description}</p></div>
    ${page.id === 'overview' ? `<div class="hero"><div class="hero-grid"></div><div class="hero-copy"><span class="tiny-label">OPTIMISTIC BY DESIGN</span><h2>Act now.<br /><span>Settle in the background.</span></h2><a href="#quickstart">Start building <span>→</span></a></div><div class="owl-stage"><span class="star star-one">✦</span><img src="${owlUrl}" alt="Pilot’s green pixel owl" /><span class="star star-two">+</span><span class="owl-caption"><i></i> READY FOR TAKEOFF</span></div><div class="hero-bottom"><span>01 / ACCEPT</span><span>02 / UPDATE</span><span>03 / SETTLE</span></div></div><div class="intro-meta"><span><i class="status-dot"></i> Built for CKB</span><span>TypeScript SDK</span><span>Open prototype</span></div>` : ''}
    ${page.app ? '<div id="ecosystem-app"></div>' : ''}
    ${page.sections.map((s) => `<section id="${s.id}"><h2><a href="#${page.id}/${s.id}">${s.title}<span class="heading-anchor">#</span></a></h2>
      ${s.flow ? `<div class="flow"><div><span>01</span><strong>Approve once</strong><p>Bound the session.</p></div><b>→</b><div><span>02</span><strong>Interact instantly</strong><p>Update local state.</p></div><b>→</b><div><span>03</span><strong>Settle on-chain</strong><p>Confirm in order.</p></div></div>` : ''}
      ${s.table ? `<div class="table-wrap"><table><tbody>${s.table.map(([name, desc]) => `<tr><th scope="row">${name}</th><td>${desc}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${s.html || ''}
      ${s.code ? `<div class="code-block"><div class="code-header"><span><i></i>${s.language}</span><button class="copy-button" aria-label="Copy code">Copy <span>▢</span></button></div><pre><code>${escape(s.code)}</code></pre></div>` : ''}
      ${s.demo ? '<a class="inline-demo" data-demo target="_blank" rel="noopener">Launch the testnet demo <span>↗</span></a>' : ''}</section>`).join('')}
    <div class="page-end"><span>Keep exploring</span><a href="#${pages[(index + 1) % pages.length].id}"><small>UP NEXT</small><strong>${pages[(index + 1) % pages.length].title} <span>→</span></strong></a></div><footer class="content-footer"><span>Pilot <b>•</b> An Owl project</span><span>Small permissions. Big possibilities.</span></footer>`;
  document.querySelector('#toc').innerHTML = page.sections.map((s) => `<a href="#${page.id}/${s.id}">${s.title}</a>`).join('');
  linkDemo();
  if (page.app) {
    import('./ecosystem.jsx').then(({ mountEcosystem }) => {
      if (version === renderVersion) unmountApp = mountEcosystem(document.querySelector('#ecosystem-app'), page.id);
    }).catch(() => {
      if (version === renderVersion) document.querySelector('#ecosystem-app').textContent = 'This page could not load. Reload to try again.';
    });
  }
  document.body.classList.remove('menu-open');
  document.querySelector('.menu-toggle').setAttribute('aria-expanded', 'false');
  main.querySelectorAll('.copy-button').forEach((button) => button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.closest('.code-block').querySelector('code').textContent);
      button.textContent = 'Copied ✓';
    } catch { button.textContent = 'Select code to copy'; }
    setTimeout(() => { if (button.isConnected) button.innerHTML = 'Copy <span>▢</span>'; }, 2000);
  }));
  if (sectionId && page.sections.some((s) => s.id === sectionId)) document.getElementById(sectionId).scrollIntoView();
  else window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);
document.querySelector('.menu-toggle').addEventListener('click', (e) => {
  const open = document.body.classList.toggle('menu-open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

const dialog = document.querySelector('#search-dialog');
const input = document.querySelector('#search-input');
function search() {
  const term = input.value.toLowerCase().trim();
  const matches = pages.filter((p) => `${p.title} ${p.description} ${p.sections.map((s) => `${s.title} ${s.html || ''} ${s.code || ''} ${JSON.stringify(s.table || [])}`).join(' ')}`.toLowerCase().includes(term));
  document.querySelector('#search-results').innerHTML = matches.length ? matches.map((p) => `<a href="#${p.id}"><strong>${p.title}<span>↗</span></strong><p>${p.description}</p></a>`).join('') : '<p class="no-results">No pages found. Try “session”, “budget”, or “store”.</p>';
  document.querySelectorAll('#search-results a').forEach((a) => a.addEventListener('click', () => dialog.close()));
}
function openSearch() { if (!dialog.open) dialog.showModal(); input.value = ''; search(); input.focus(); }
document.querySelector('.search-trigger').addEventListener('click', openSearch);
document.querySelector('#close-search').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
input.addEventListener('input', search);
window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); } });
render();
