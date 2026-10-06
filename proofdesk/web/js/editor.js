import { api } from './api.js';
import { avatar, h, mount, toast } from './dom.js';
import { player } from './player.js';
import { renderProof } from './proof.js';
import { renderReview } from './review.js';
import { renderHistory } from './history.js';
import { renderSettings } from './settings.js';

const TABS = [
  ['proof', '逐段校对'],
  ['review', '合并评审'],
  ['history', '版本与历史'],
  ['settings', '项目设置'],
];

export async function renderEditor(root, { me, detail, tab }) {
  const ctx = {
    me,
    project: detail,
    tab: TABS.some(([k]) => k === tab) ? tab : 'proof',
  };

  if (!TABS.some(([k]) => k === ctx.tab)) ctx.tab = 'proof';

  async function refresh(switchTab) {
    if (switchTab) ctx.tab = switchTab;
    const fresh = await api('GET', `/api/projects/${ctx.project.id}`);
    ctx.project = fresh;
    draw();
  }
  ctx.refresh = refresh;

  function go(t) {
    location.hash = `#/p/${ctx.project.id}/${t}`;
    ctx.tab = t;
    draw();
  }
  ctx.go = go;

  function draw() {
    const p = ctx.project;
    const conflictCount = p.review.counts.conflict;
    const tabsEl = h('div', { class: 'tabs' },
      TABS.map(([key, label]) =>
        h('button', {
          class: 'tab' + (ctx.tab === key ? ' active' : ''),
          onClick: () => go(key),
        }, [
          label,
          key === 'review' && conflictCount > 0
            ? h('span', { class: 'n' }, conflictCount)
            : null,
        ]),
      ),
    );

    const workEl = h('div', { class: 'work' + (ctx.tab === 'proof' ? '' : ' pad') });
    const shell = h('div', { class: 'editor' });

    // 顶栏（精简）
    const isCreator = p.createdBy === me.id;
    const top = h('div', { class: 'topbar' }, [
      h('span', { class: 'title', onClick: () => (location.hash = '#/') }, '📜'),
      h('span', { style: 'font-weight:600' }, p.name),
      h('span', { class: `badge ${p.status}` }, p.status === 'confirmed' ? '已定稿' : '校对中'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'me' }, [
        h('span', { class: 'muted', style: 'font-size:12.5px' }, '成员：'),
        ...p.members.map((m) => avatar(m.name, m.userId, 'sm')),
      ]),
      h('button', { class: 'btn ghost sm', onClick: () => (location.hash = '#/') }, '列表'),
    ]);

    shell.append(top);

    if (p.audio) shell.append(player.bar());
    player.load(p, p.segments);

    shell.append(tabsEl, workEl);
    mount(root, shell);

    const sub = {
      me,
      project: p,
      isCreator,
      refresh,
      workEl,
      go,
    };
    if (ctx.tab === 'proof') renderProof(sub);
    if (ctx.tab === 'review') renderReview(sub);
    if (ctx.tab === 'history') renderHistory(sub);
    if (ctx.tab === 'settings') renderSettings(sub);
  }

  draw();

  // 键盘快捷键（仅在校对页，且焦点不在输入控件）
  const editing = () => {
    const t = document.activeElement;
    return t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT');
  };
  document.onkeydown = (e) => {
    if (editing()) return;
    if (e.code === 'Space') {
      e.preventDefault();
      player.toggle();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const order = TABS.map(([k]) => k);
      const i = order.indexOf(ctx.tab);
      go(order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length]);
    }
  };
}
