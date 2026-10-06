import { api, getToken, setToken } from './api.js';
import { avatar, fmtTime, h, mount, toast } from './dom.js';
import { renderEditor } from './editor.js';
import { renderNewProject } from './new-project.js';

const app = document.getElementById('app');
let me = null;

async function bootstrap() {
  if (getToken()) {
    try {
      me = await api('GET', '/api/me');
    } catch {
      setToken('');
    }
  }
  route();
}

function route() {
  const hash = location.hash || '#/';
  if (!me) return renderLogin();
  const m = hash.match(/^#\/p\/([^/]+)(?:\/(review|history|settings))?/);
  if (m) return renderProject(m[1], m[2] || 'proof');
  if (hash === '#/new') return renderNewProjectPage();
  renderHome();
}

window.addEventListener('hashchange', route);

// ---------------- 登录 ----------------
function renderLogin() {
  const nameInput = h('input', { class: 'input', placeholder: '如：王编辑', maxlength: '40', autofocus: true });
  const tokenInput = h('input', {
    class: 'input',
    placeholder: '（可选）粘贴上次使用的登录令牌',
    type: 'password',
  });
  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) return toast('请输入姓名', true);
    if (tokenInput.value.trim()) setToken(tokenInput.value.trim());
    try {
      const r = await api('POST', '/api/login', { name });
      setToken(r.token);
      me = { id: r.id, name: r.name };
      toast(`欢迎，${r.name}`);
      route();
    } catch (e) {
      setToken('');
      toast(e.message, true);
    }
  };
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  tokenInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());

  mount(
    app,
    h('div', { class: 'login-wrap' }, [
      h('div', { class: 'login-card' }, [
        h('div', { class: 'brand' }, [
          h('div', { class: 'mark' }, '听 · 校 · 存'),
          h('h1', {}, '口述听写稿校对台'),
          h('p', {}, '音频分段 · 时间码对齐 · 多人校对 · 版本合并 · 冲突人工确认'),
        ]),
        h('label', { class: 'field' }, [h('span', {}, '校对人姓名'), nameInput]),
        h('label', { class: 'field' }, [h('span', {}, '登录令牌（首次使用留空，系统自动签发）'), tokenInput]),
        h(
          'button',
          { class: 'btn primary', style: 'width:100%;margin-top:6px;padding:10px', onClick: submit },
          '进入校对台',
        ),
        h('p', { class: 'hint-line', style: 'text-align:center' },
          '姓名仅用于署名；令牌是你在本机的登录凭证，请妥善保管。'),
      ]),
    ]),
  );
  nameInput.focus();
}

// ---------------- 首页：项目列表 ----------------
async function renderHome() {
  let projects = [];
  try {
    projects = await api('GET', '/api/projects');
  } catch (e) {
    toast(e.message, true);
  }

  const cards = projects.map((p) => {
    const pct = p.segmentCount ? Math.round((p.touchedCount / p.segmentCount) * 100) : 0;
    return h('button', {
      class: 'proj-card',
      onClick: () => (location.hash = `#/p/${p.id}`),
    }, [
      h('div', { class: 'row1' }, [
        h('span', { class: 'name' }, p.name),
        h('span', { class: `badge ${p.status}` }, p.status === 'confirmed' ? '已定稿' : '校对中'),
      ]),
      p.description ? h('div', { class: 'desc' }, p.description) : null,
      h('div', { class: 'meta' }, [
        h('span', {}, `${p.segmentCount} 段`),
        h('span', { style: 'display:flex;align-items:center;gap:6px' }, [
          ...p.members.slice(0, 5).map((m) => avatar(m.name || '?', m.userId, 'sm')),
          h('span', {}, `${p.membersCount} 人`),
        ]),
        h('span', { class: 'prog' + (p.status === 'confirmed' ? ' done' : '') }, [
          h('i', { style: `width:${pct}%` }),
        ]),
        h('span', {}, `${p.touchedCount}/${p.segmentCount} 已校`),
        h('span', { class: 'spacer' }),
        h('span', {}, '更新于 ' + fmtTime(p.updatedAt)),
      ]),
    ]);
  });

  mount(
    app,
    topbar(),
    h('div', { class: 'page' }, [
      h('div', { class: 'page-head' }, [
        h('h2', {}, '我的校对项目'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', onClick: () => (location.hash = '#/new') }, '＋ 新建项目'),
      ]),
      cards.length
        ? h('div', {}, cards)
        : h('div', { class: 'empty' }, [
            h('div', { class: 'big' }, '📭'),
            h('div', {}, '还没有项目。点击「新建项目」上传音频与口述原稿，开始多人校对。'),
            h('div', { style: 'height:14px' }),
            h('button', { class: 'btn primary', onClick: () => (location.hash = '#/new') }, '＋ 新建第一个项目'),
          ]),
    ]),
  );
}

// ---------------- 新建项目 ----------------
async function renderNewProjectPage() {
  try {
    mount(app, topbar());
    await renderNewProject(app, me, async (id) => {
      toast('项目已创建');
      location.hash = `#/p/${id}/settings`;
    });
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------- 项目工作台 ----------------
async function renderProject(id, tab) {
  try {
    mount(app, h('div', { class: 'boot' }, '载入项目…'));
    const detail = await api('GET', `/api/projects/${id}`);
    await renderEditor(app, { me, detail, tab });
  } catch (e) {
    mount(app, topbar(), h('div', { class: 'empty' }, [
      h('div', { class: 'big' }, '⚠️'),
      h('div', {}, e.message),
      h('div', { style: 'height:12px' }),
      h('button', { class: 'btn', onClick: () => (location.hash = '#/') }, '返回列表'),
    ]));
  }
}

// ---------------- 顶栏 ----------------
function topbar() {
  return h('div', { class: 'topbar' }, [
    h('span', {
      class: 'title',
      onClick: () => (location.hash = '#/'),
      title: '返回项目列表',
    }, '📜 口述听写稿校对台'),
    h('span', { class: 'spacer' }),
    me
      ? h('span', { class: 'me' }, [
          avatar(me.name, me.id, 'sm'),
          h('span', {}, me.name),
          h('button', {
            class: 'btn ghost sm',
            onClick: async () => {
              try { await api('POST', '/api/logout'); } catch {}
              setToken('');
              me = null;
              route();
            },
          }, '退出'),
        ])
      : null,
  ]);
}

bootstrap();
