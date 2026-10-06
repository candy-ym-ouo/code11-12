import { api } from './api.js';
import { h } from './dom.js';

/** 新建项目表单（创建后跳转设置页上传音频/原稿） */
export async function renderNewProject(root, me, onCreated) {
  const nameInput = h('input', { class: 'input', placeholder: '如：祖母口述·一九六〇年南下', maxlength: '80' });
  const descInput = h('textarea', {
    class: 'input', rows: 3,
    placeholder: '录音背景、口述人、采集时间等备注（可选）',
  });
  const membersInput = h('input', {
    class: 'input',
    placeholder: '用逗号分隔，如：林校对，赵校对（可稍后在设置页添加）',
  });
  const requireAll = h('input', { type: 'checkbox', checked: true });

  const submitBtn = h('button', { class: 'btn primary' }, '创建项目');
  const form = h('div', { class: 'page', style: 'max-width:680px' }, [
    h('div', { class: 'page-head' }, [
      h('h2', {}, '新建校对项目'),
    ]),
    h('div', { class: 'panel' }, [
      h('label', { class: 'field' }, [h('span', {}, '项目名称 *'), nameInput]),
      h('label', { class: 'field' }, [h('span', {}, '项目说明'), descInput]),
      h('label', { class: 'field' }, [
        h('span', {}, '其他校对人（按姓名加入；不存在则自动建档）'),
        membersInput,
      ]),
      h('label', {
        class: 'field',
        style: 'display:flex;gap:8px;align-items:flex-start;cursor:pointer',
      }, [
        requireAll,
        h('span', { style: 'margin:0' }, [
          h('b', {}, '全员校对齐方可定稿'),
          h('div', { class: 'muted', style: 'font-weight:normal;margin-top:2px' },
            '开启后，任何段落只要有成员尚未提交修订，即视为未齐，定稿被拦截。可随时在设置页调整。'),
        ]),
      ]),
      h('div', { style: 'display:flex;gap:10px;margin-top:18px' }, [
        h('button', { class: 'btn', onClick: () => (location.hash = '#/') }, '取消'),
        h('span', { class: 'spacer' }),
        submitBtn,
      ]),
    ]),
    h('p', { class: 'hint-line' },
      '创建后进入设置页：上传音频、导入听写原稿（SRT / 带时间码文本 / 自然段），并完成等距分段。'),
  ]);
  root.append(form);

  submitBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    submitBtn.disabled = true;
    try {
      const memberNames = membersInput.value
        .split(/[,，、\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const p = await api('POST', '/api/projects', {
        name,
        description: descInput.value,
        memberNames,
        requireAllMembers: requireAll.checked,
      });
      await onCreated(p.id);
    } catch (e) {
      submitBtn.disabled = false;
      alert(e.message);
    }
  });
  nameInput.focus();
}
