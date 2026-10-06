/* 口述听写稿校对台 —— 零依赖单文件前端 */
"use strict";

// ---------- 状态 ----------
const state = {
  user: JSON.parse(localStorage.getItem("td_user") || "null"),
  route: location.hash || "#/",
  project: null,
  segments: [],
  users: [],
  tab: "proof",
  drafts: {},           // 我未提交的校对文本 segId -> text
  dirty: new Set(),
  mergeDrafts: {},      // 冲突页人工裁定文本
  mergeChoice: {},      // segId -> 'user:<uid>' | 'manual'
  audioReady: false,
  lastSegFetch: 0,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
};

// ---------- API ----------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.user) headers["Authorization"] = "Bearer " + state.user.token;
  if (opts.body && !(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...opts, headers });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `请求失败 (${res.status})`);
  return data;
}

function toast(msg, kind = "") {
  const t = h("div", { class: "toast " + kind }, msg);
  $("#toast-host").append(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; }, 2800);
  setTimeout(() => t.remove(), 3200);
}

// ---------- 时间码 ----------
function parseTC(s) {
  let m = /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$/.exec(s);
  if (m) { const x = m[4].padEnd(3, "0"); return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +x; }
  m = /^\s*(\d{1,2}):(\d{2})[,.](\d{1,3})\s*$/.exec(s);
  if (m) { const x = m[3].padEnd(3, "0"); return (+m[1] * 60 + +m[2]) * 1000 + +x; }
  throw new Error("时间码格式应为 HH:MM:SS,mmm");
}
const fmtTC = ms => {
  if (ms == null || ms < 0) ms = 0;
  ms = Math.round(ms);
  const s = Math.floor(ms / 1000), x = ms % 1000;
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")},${String(x).padStart(3, "0")}`;
};
const fmtClock = ms => {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  return hh ? `${hh}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
            : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// ---------- 字符级 diff ----------
function diffOps(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  const push = (op, ch) => { const l = ops[ops.length - 1]; if (l && l.op === op) l.t += ch; else ops.push({ op, t: ch }); };
  while (i < n && j < m) {
    if (a[i] === b[j]) { push("eq", a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", a[i]); i++; }
    else { push("ins", b[j]); j++; }
  }
  if (i < n) push("del", a.slice(i));
  if (j < m) push("ins", b.slice(j));
  return ops;
}
function diffHTML(a, b) {
  const frag = document.createDocumentFragment();
  for (const op of diffOps(a || "", b || "")) {
    if (op.op === "eq") frag.append(op.t);
    else {
      const s = h(op.op === "del" ? "del" : "ins", {}, op.t);
      if (op.op === "del") { s.style.color = "var(--red)"; s.style.background = "var(--red-dim)"; }
      frag.append(s);
    }
  }
  return frag;
}

const avatarColor = name => {
  const palette = ["#4f9cff", "#34b27a", "#d9a441", "#e0604d", "#9a7eff", "#3fb8c4", "#d46aa8"];
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
};
const avatar = (name, live = false, title = "") =>
  h("span", { class: "avatar" + (live ? " live" : ""), style: `background:${avatarColor(name)}`, title: title || name },
    name.slice(0, 1));

// ---------- 身份 ----------
async function openIdentity() {
  const modal = $("#identity-modal");
  modal.classList.remove("hidden");
  const wrap = $("#existing-users");
  wrap.innerHTML = "";
  let selected = null;
  try { state.users = (await api("/api/users")).users; } catch { state.users = []; }
  if (!state.users.length) {
    $("#identity-title").textContent = "登记校对员身份";
    $("#login-existing-btn").style.display = "none";
  } else {
    $("#identity-title").textContent = "选择校对员身份";
    $("#login-existing-btn").style.display = "";
  }
  for (const u of state.users) {
    const chip = h("div", { class: "user-chip" }, u.name);
    chip.onclick = () => {
      selected = u;
      $$(".user-chip", wrap).forEach(c => c.classList.remove("sel"));
      chip.classList.add("sel");
      $("#login-existing-btn").disabled = false;
    };
    wrap.append(chip);
  }
  const nameInput = $("#new-name");
  nameInput.value = "";
  $("#register-btn").onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) return toast("请输入姓名", "err");
    try {
      const u = await api("/api/users", { method: "POST", body: JSON.stringify({ name }) });
      state.user = { id: u.id, name: u.name, token: u.token };
      localStorage.setItem("td_user", JSON.stringify(state.user));
      modal.classList.add("hidden");
      renderIdentityChip();
      toast("已登记，欢迎 " + name, "ok");
      route();
    } catch (e) { toast(e.message, "err"); }
  };
  $("#login-existing-btn").onclick = () => {
    if (!selected) return;
    api("/api/users/login", { method: "POST", body: JSON.stringify({ name: selected.name }) })
      .then(u => {
        state.user = { id: u.id, name: u.name, token: u.token };
        localStorage.setItem("td_user", JSON.stringify(state.user));
        modal.classList.add("hidden");
        renderIdentityChip();
        route();
      }).catch(e => toast(e.message, "err"));
  };
  nameInput.onkeydown = e => { if (e.key === "Enter") $("#register-btn").click(); };
  setTimeout(() => nameInput.focus(), 50);
}

function renderIdentityChip() {
  const box = $("#identity");
  box.innerHTML = "";
  if (!state.user) {
    box.append(h("button", { class: "btn sm", onclick: openIdentity }, "登录身份"));
    return;
  }
  box.append(
    avatar(state.user.name),
    h("span", {}, state.user.name),
    h("button", {
      class: "btn sm", title: "切换校对员",
      onclick: () => { state.user = null; localStorage.removeItem("td_user"); renderIdentityChip(); openIdentity(); }
    }, "切换"),
  );
}

// ---------- 路由 ----------
function route() {
  state.route = location.hash || "#/";
  const m = /^#\/project\/([^?]+)/.exec(state.route);
  if (m) {
    const tab = new URLSearchParams(state.route.split("?")[1] || "").get("tab") || "proof";
    state.tab = tab;
    openProject(m.group(1));
  } else {
    renderHome();
  }
}
window.addEventListener("hashchange", route);

// ---------- 首页 ----------
async function renderHome() {
  $("#presence-bar").innerHTML = "";
  const app = $("#app");
  app.innerHTML = "";
  const page = h("div", { class: "page" }, h("div", { class: "wrap" }));
  const wrap = $(".wrap", page);
  wrap.append(
    h("div", { class: "page-head" },
      h("div", {},
        h("h1", {}, "口述听写稿校对台"),
        h("p", {}, "音频分段 · 时间码对齐 · 多人独立校对 · 版本三方合并 · 冲突人工确认后定稿落库")),
      h("div", { style: "display:flex;gap:10px" },
        h("button", { class: "btn", onclick: makeDemo }, "生成演示项目"),
      )),
    h("div", { id: "cards", class: "card-grid" }),
  );
  app.append(page);

  const newCard = h("div", {
    class: "card new-card",
    onclick: createProjectDialog,
  }, h("div", {}, h("div", { style: "font-size:26px;margin-bottom:6px" }, "＋"), "新建校对项目"));

  try {
    const { projects } = await api("/api/projects");
    const grid = $("#cards");
    grid.append(newCard);
    for (const p of projects) grid.append(projectCard(p));
  } catch (e) {
    $("#cards").append(newCard);
  }
}

function projectCard(p) {
  const status = p.status === "finalized"
    ? h("span", { class: "badge finalized" }, "已定稿")
    : h("span", { class: "badge open" }, "校对中");
  return h("div", { class: "card", onclick: () => { location.hash = `#/project/${p.id}?tab=proof`; } },
    h("h3", {}, p.name),
    h("div", { class: "desc" }, p.description || "（无描述）"),
    h("div", { class: "stats" },
      status,
      h("span", {}, "分段 ", h("b", {}, String(p.segment_count))),
      h("span", {}, "已校对 ", h("b", {}, String(p.proofed_count))),
      h("span", {}, "校对员 ", h("b", {}, String(p.proofreader_count))),
    ));
}

function createProjectDialog() {
  if (!state.user) return openIdentity();
  const mask = h("div", { class: "modal-mask" });
  const modal = h("div", { class: "modal" },
    h("h2", {}, "新建校对项目"),
    h("label", { class: "field" }, "项目名称",
      h("input", { class: "input", id: "p-name", maxlength: "80", placeholder: "如：外公口述·闯关东" })),
    h("label", { class: "field" }, "说明（可选）",
      h("textarea", { class: "input", id: "p-desc", rows: "3" })),
    h("div", { class: "modal-actions" },
      h("button", { class: "btn", onclick: () => mask.remove() }, "取消"),
      h("button", {
        class: "btn primary", onclick: async () => {
          const name = $("#p-name", mask).value.trim();
          if (!name) return toast("请填写项目名称", "err");
          try {
            const p = await api("/api/projects", {
              method: "POST",
              body: JSON.stringify({ name, description: $("#p-desc", mask).value }),
            });
            mask.remove();
            location.hash = `#/project/${p.id}?tab=import`;
          } catch (e) { toast(e.message, "err"); }
        }
      }, "创建并导入素材")),
  );
  mask.append(modal);
  document.body.append(mask);
  setTimeout(() => $("#p-name", mask).focus(), 50);
}

async function makeDemo() {
  try {
    const p = await api("/api/projects/demo", { method: "POST" });
    toast("演示项目已生成（含两位校对员与一处冲突）", "ok");
    location.hash = `#/project/${p.id}?tab=proof`;
  } catch (e) { toast(e.message, "err"); }
}

// ---------- 项目外壳 ----------
async function openProject(pid) {
  try {
    state.project = await api(`/api/projects/${pid}`);
  } catch (e) {
    location.hash = "#/";
    return toast(e.message, "err");
  }
  state.pid = pid;
  state.drafts = {};
  state.dirty = new Set();
  state.mergeDrafts = {};
  state.mergeChoice = {};
  renderShell();
  await refreshSegments();
  renderTab();
  schedulePoll();
}

function renderShell() {
  const p = state.project;
  $("#app").innerHTML = "";
  const ws = h("div", { class: "workspace" },
    h("div", { class: "proj-head" },
      h("span", { class: "back", onclick: () => { location.hash = "#/"; } }, "← 项目列表"),
      h("div", {},
        h("h2", {}, p.name, " ",
          p.status === "finalized" ? h("span", { class: "badge finalized" }, "已定稿")
                                   : h("span", { class: "badge open" }, "校对中")),
        h("div", { class: "sub" },
          p.audio_name ? `音频：${p.audio_name}` + (p.audio_dur ? ` · ${fmtClock(p.audio_dur * 1000)}` : "")
                       : "尚未上传音频")),
      h("div", { class: "spacer" }),
      p.status === "finalized"
        ? h("button", { class: "btn sm", onclick: () => reopenProject() }, "重新打开（回到校对）")
        : h("button", {
            class: "btn sm primary", onclick: () => location.hash = `#/project/${p.id}?tab=merge`
          }, "进入合并 / 定稿")),
    h("div", { class: "tabs" },
      ...[["proof", "音频校对"], ["merge", "合并定稿"], ["import", "素材与分段"], ["audit", "审计日志"]]
        .map(([key, label]) => h("div", {
          class: "tab" + (state.tab === key ? " active" : ""),
          onclick: () => { location.hash = `#/project/${p.id}?tab=${key}`; },
        }, label, h("span", { class: "dot", id: `tab-dot-${key}` })))),
    h("div", { class: "tab-pane", id: "tab-pane" }),
  );
  $("#app").append(ws);
}

async function reopenProject() {
  try {
    state.project = await api(`/api/projects/${state.pid}/reopen`, { method: "POST" });
    renderShell();
    await refreshSegments();
    renderTab();
    toast("项目已重新打开", "ok");
  } catch (e) { toast(e.message, "err"); }
}

async function refreshSegments() {
  const data = await api(`/api/projects/${state.pid}/segments`);
  state.segments = data.segments;
  state.lastSegFetch = Date.now();
}

function renderTab() {
  const pane = $("#tab-pane");
  pane.innerHTML = "";
  const tabs = { proof: renderProofTab, merge: renderMergeTab, import: renderImportTab, audit: renderAuditTab };
  (tabs[state.tab] || renderProofTab)(pane);
}

// ---------- 轮询协同 ----------
let pollTimer = null;
let beatTimer = null;
function schedulePoll() {
  clearInterval(pollTimer);
  clearInterval(beatTimer);
  pollTimer = setInterval(async () => {
    if (!state.pid || !/^#\/project\//.test(location.hash)) return;
    try {
      const focusInList = $("#tab-pane")?.contains(document.activeElement) && state.tab === "proof";
      state.project = await api(`/api/projects/${state.pid}`);
      await refreshSegments();
      if (!focusInList) renderTab();
      updatePresenceBar();
      updateAudioTrack();
    } catch { /* 忽略瞬时失败 */ }
  }, 4000);
  beatTimer = setInterval(() => {
    if (state.pid && state.user && /^#\/project\//.test(location.hash)) {
      api(`/api/projects/${state.pid}/heartbeat`, {
        method: "POST",
        body: JSON.stringify({ segment_id: state.currentSegId || null }),
      }).then(r => { state.presence = r.presence; updatePresenceBar(); }).catch(() => {});
    }
  }, 5000);
}

function updatePresenceBar() {
  const bar = $("#presence-bar");
  if (!bar || state.tab === undefined) return;
  bar.innerHTML = "";
  const list = (state.presence || []).filter(p => state.user && p.user_id !== state.user.id);
  if (!list.length) return;
  const seen = new Map();
  for (const p of list) seen.set(p.user_id, p);
  for (const p of seen.values())
    bar.append(avatar(p.user_name, true, `${p.user_name} 在线`));
}

// ---------- 音频播放器 ----------
let audioEl = null;
function ensureAudio() {
  if (audioEl) return audioEl;
  audioEl = h("audio", { class: "native", preload: "metadata" });
  document.body.append(audioEl);
  audioEl.addEventListener("loadedmetadata", () => {
    state.audioReady = true;
    if (state.project && state.project.audio_dur == null) {
      api(`/api/projects/${state.pid}/audio-meta`, {
        method: "POST", body: JSON.stringify({ duration: audioEl.duration }),
      }).catch(() => {});
    }
    updateAudioTrack();
  });
  audioEl.addEventListener("timeupdate", onTimeUpdate);
  audioEl.addEventListener("ended", () => {
    $(".play-btn") && ($(".play-btn").textContent = "▶");
  });
  return audioEl;
}

function audioSrc() {
  const p = state.project;
  return p.audio_file ? `/api/projects/${p.id}/audio/${encodeURIComponent(p.audio_file)}` : null;
}

function buildPlayer() {
  const src = audioSrc();
  const player = h("div", { class: "player" },
    h("button", { class: "play-btn" }, "▶"),
    h("div", { class: "time-readout" }, "00:00 / 00:00"),
    h("div", { class: "seek-track" },
      h("div", { class: "seek-fill", style: "width:0%" }),
      h("div", { class: "seek-knob", style: "left:0%" }),
      h("div", { id: "seg-ticks" })),
    h("select", { class: "input rate-select" },
      [["1", "1.0×"], ["0.8", "0.8×"], ["0.6", "0.6×"], ["1.25", "1.25×"], ["1.5", "1.5×"]]
        .map(([v, l]) => h("option", { value: v, selected: v === "1" ? true : false }, l))),
  );
  if (!src) {
    player.replaceChildren(h("span", { class: "hint" }, "尚未上传音频：可在「素材与分段」页上传。时间码点击仍可编辑。"));
    return player;
  }
  const a = ensureAudio();
  if (a.dataset.src !== src) { a.src = src; a.dataset.src = src; }
  const btn = $(".play-btn", player);
  btn.onclick = () => {
    if (a.paused) { a.play(); btn.textContent = "❚❚"; }
    else { a.pause(); btn.textContent = "▶"; }
  };
  const track = $(".seek-track", player);
  track.onclick = ev => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    if (a.duration) { a.currentTime = ratio * a.duration; }
  };
  $(".rate-select", player).onchange = e => { a.playbackRate = parseFloat(e.target.value); };
  return player;
}

function updateAudioTrack() {
  if (!audioEl || !state.segments.length) return;
  const ticks = $("#seg-ticks");
  const ro = $(".time-readout");
  if (!ticks) return;
  const dur = audioEl.duration || state.project?.audio_dur || 0;
  ticks.innerHTML = "";
  if (dur > 0) {
    for (const s of state.segments) {
      ticks.append(h("div", { class: "seek-seg", style: `left:${(s.start_ms / 1000 / dur) * 100}%` }));
    }
  }
  const fill = $(".seek-fill"), knob = $(".seek-knob");
  if (fill && dur) {
    const pct = (audioEl.currentTime / dur) * 100;
    fill.style.width = pct + "%";
    knob.style.left = pct + "%";
  }
  if (ro) ro.textContent = `${fmtClock((audioEl.currentTime || 0) * 1000)} / ${fmtClock((dur || 0) * 1000)}`;
}

function onTimeUpdate() {
  updateAudioTrack();
  const t = audioEl.currentTime * 1000;
  const cur = state.segments.find(s => t >= s.start_ms && t < s.end_ms);
  const id = cur ? cur.id : null;
  if (id !== state.currentSegId) {
    state.currentSegId = id;
    $$(".seg").forEach(el => el.classList.toggle("playing", el.dataset.id === id));
    const el = id && $(`.seg[data-id="${id}"]`);
    if (el && state.follow !== false) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function playSegment(seg) {
  const src = audioSrc();
  if (!src) return toast("项目还没有音频，请先在「素材与分段」上传", "err");
  const a = ensureAudio();
  const jump = () => {
    a.currentTime = seg.start_ms / 1000;
    a.play().catch(() => {});
    const btn = $(".play-btn");
    if (btn) btn.textContent = "❚❚";
    state.follow = true;
  };
  if (state.audioReady) jump();
  else a.addEventListener("loadedmetadata", jump, { once: true });
}

// ---------- 校对页 ----------
function renderProofTab(pane) {
  const locked = state.project.status === "finalized";
  pane.append(buildPlayer());
  const list = h("div", { class: "seg-list" });
  if (!state.segments.length) {
    list.append(h("div", { class: "empty" },
      "还没有分段。请先到「素材与分段」上传音频并导入 SRT / 时间码草稿。"));
  }
  for (const seg of state.segments) list.append(renderSeg(seg, locked));
  pane.append(list);
  updateAudioTrack();
}

function renderSeg(seg, locked) {
  const mine = seg.versions.find(v => v.user_id === state.user?.id);
  const others = seg.versions.filter(v => v.user_id !== state.user?.id);
  const uniqueTexts = new Set(seg.versions.map(v => v.text));
  const stateBadge = !seg.versions.length ? h("span", { class: "badge missing" }, "待校对")
    : uniqueTexts.size === 1 ? h("span", { class: "badge agreed" }, "已一致")
    : h("span", { class: "badge conflict" }, `${uniqueTexts.size} 个版本冲突`);

  const who = h("div", { class: "who" }, ...seg.versions.map(v =>
    avatar(v.user_name, false, `${v.user_name} 已校对`)));

  const head = h("div", { class: "seg-head" },
    h("span", { class: "idx" }, `#${seg.idx + 1}`),
    h("span", {
      class: "tc", title: "点击播放此段",
      onclick: () => playSegment(seg),
    }, `${fmtTC(seg.start_ms)} → ${fmtTC(seg.end_ms)}  ▶`),
    stateBadge,
    h("span", { class: "spacer" }),
    who,
    !locked && h("button", {
      class: "btn sm", title: "调整时间码 / 拆分",
      onclick: () => { const row = $(`.tc-edit[data-id="${seg.id}"]`); row.classList.toggle("hidden"); }
    }, "⏱ 时间码"),
  );

  const body = h("div", { class: "seg-body" },
    h("div", { class: "original" }, "听写原稿：", seg.original),
  );

  const grid = h("div", { class: "seg-grid" + (others.length ? "" : " single") });

  // 我的校对框
  if (state.user && !locked) {
    const draftInit = state.drafts[seg.id] ?? (mine ? mine.text : seg.original);
    const ta = h("textarea", { class: "input", rows: "4" }, draftInit);
    const noteIn = h("input", { class: "input", style: "margin-top:8px", placeholder: "备注（选填，如：此处听不清）" });
    if (mine) noteIn.value = mine.note || "";
    ta.addEventListener("input", () => { state.dirty.add(seg.id); state.drafts[seg.id] = ta.value; });
    const savedHint = h("span", { class: "saved-hint" }, mine ? `已于 ${new Date(mine.updated_at).toLocaleTimeString()} 提交` : "");
    const submit = async () => {
      if (!ta.value.trim()) return toast("校对文本不能为空", "err");
      try {
        await api(`/api/projects/${state.pid}/segments/${seg.id}/proofs`, {
          method: "POST", body: JSON.stringify({ text: ta.value, note: noteIn.value }),
        });
        state.dirty.delete(seg.id);
        delete state.drafts[seg.id];
        toast(`第 ${seg.idx + 1} 段已提交`, "ok");
        await refreshSegments();
        renderTab();
      } catch (e) { toast(e.message, "err"); }
    };
    ta.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); submit(); }
    });
    const myBox = h("div", { class: "version-box" },
      h("div", { class: "vh" },
        avatar(state.user.name),
        h("span", { class: "name" }, "我的校对稿"),
        h("span", { class: "hint" }, "Ctrl+Enter 提交")),
      ta, noteIn,
      h("div", { class: "seg-foot" },
        h("button", { class: "btn sm primary", onclick: submit }, "提交我的版本"),
        h("span", { class: "spacer" }),
        savedHint),
    );
    grid.append(myBox);
  } else if (locked) {
    const t = seg.merge?.chosen === "manual" ? seg.merge.text : (uniqueTexts.size === 1 && seg.versions[0] ? seg.versions[0].text : "");
    grid.append(h("div", { class: "version-box" },
      h("div", { class: "vh" }, h("span", { class: "name" }, "定稿文本")),
      h("div", { class: "vtext" }, t || "（未定）")));
  }

  // 他人版本（与原稿 diff）
  for (const v of others) {
    grid.append(h("div", { class: "version-box" },
      h("div", { class: "vh" }, avatar(v.user_name), h("span", { class: "name" }, v.user_name + " 的校对稿"),
        h("button", {
          class: "btn sm", onclick: ev => {
            const dv = $(".dv", ev.target.closest(".version-box"));
            dv.classList.toggle("hidden");
            ev.target.textContent = dv.classList.contains("hidden") ? "对比原稿" : "收起对比";
          }
        }, "对比原稿")),
      h("div", { class: "vtext" }, v.text),
      v.note ? h("div", { class: "vnote" }, "备注：" + v.note) : null,
      h("div", { class: "dv hidden", style: "margin-top:8px;line-height:1.9;font-size:13.5px" },
        diffHTML(seg.original, v.text)),
    ));
  }

  // 我已有版本时，若处于锁定外，也展示我的版本 diff 入口（上面编辑框即可）
  body.append(grid);

  // 时间码调整行
  const tcRow = h("div", { class: "tc-edit hidden", style: "margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
    h("span", { class: "hint" }, "起"),
    h("input", { class: "input", style: "width:150px", value: fmtTC(seg.start_ms), "data-tc": "start" }),
    h("span", { class: "hint" }, "止"),
    h("input", { class: "input", style: "width:150px", value: fmtTC(seg.end_ms), "data-tc": "end" }),
    h("button", {
      class: "btn sm", onclick: async ev => {
        const row = ev.target.closest(".tc-edit");
        try {
          const s = parseTC($('[data-tc="start"]', row).value);
          const e = parseTC($('[data-tc="end"]', row).value);
          await api(`/api/projects/${state.pid}/segments/${seg.id}/timecodes`, {
            method: "POST", body: JSON.stringify({ start_ms: s, end_ms: e }),
          });
          toast("时间码已更新", "ok");
          await refreshSegments(); renderTab();
        } catch (err) { toast(err.message, "err"); }
      }
    }, "保存时间码"),
    h("span", { class: "hint" }, "或在播放位置"),
    h("button", {
      class: "btn sm", onclick: async () => {
        if (!audioEl || !state.audioReady) return toast("音频尚未就绪", "err");
        try {
          await api(`/api/projects/${state.pid}/segments/${seg.id}/split`, {
            method: "POST", body: JSON.stringify({ at_ms: Math.round(audioEl.currentTime * 1000) }),
          });
          toast("已在当前播放位置拆分", "ok");
          await refreshSegments(); renderTab();
        } catch (e) { toast(e.message, "err"); }
      }
    }, "✂ 拆分此段"),
  );
  tcRow.dataset.id = seg.id;
  body.append(tcRow);

  return h("div", { class: "seg", "data-id": seg.id }, head, body);
}

// ---------- 合并 / 定稿页 ----------
async function renderMergeTab(pane) {
  const ov = await api(`/api/projects/${state.pid}/merge`).catch(() => null);
  if (!ov) return;
  state.mergeOV = ov;
  const { stats } = ov;
  const locked = state.project.status === "finalized";

  pane.append(h("div", { class: "merge-summary" },
    statTile(stats.total, "总分段"),
    statTile(stats.agreed, "全员一致 · 自动合并", "var(--green)"),
    statTile(stats.conflict, "存在分歧", "var(--red)"),
    statTile(stats.conflict_pending, "待人工确认", "var(--amber)"),
    statTile(stats.needs_review || 0, "已确认 · 待复核", "var(--violet)"),
    statTile(stats.missing, "无人校对", "var(--muted)"),
  ));

  const inner = h("div", { style: "padding-bottom:60px" });
  for (const it of ov.items) inner.append(renderMergeItem(it, locked));
  pane.append(inner);

  const canFinalize = stats.missing === 0 && stats.conflict_pending === 0;
  const actions = h("div", { class: "merge-actions" });
  if (locked) {
    actions.append(
      h("span", { class: "gate-msg ok" }, "✓ 全稿已定稿落库"),
      h("span", { class: "spacer" }),
      h("a", { class: "btn", href: `/api/projects/${state.pid}/export?format=srt`, download: "" }, "导出 SRT 字幕"),
      h("a", { class: "btn", href: `/api/projects/${state.pid}/export?format=txt`, download: "" }, "导出时间码文本"),
    );
  } else if (canFinalize) {
    actions.append(
      h("span", { class: "gate-msg ok" }, "✓ 无未校对段、无待确认冲突，可以定稿"),
      h("span", { class: "spacer" }),
      h("button", { class: "btn green", onclick: finalize }, "全部确认无误 · 定稿落库"));
  } else {
    actions.append(h("span", { class: "gate-msg" },
      `定稿闸门未通过：${stats.missing ? stats.missing + " 段无人校对；" : ""}` +
      `${stats.conflict_pending ? stats.conflict_pending + " 个冲突待人工确认；" : ""}` +
      "（冲突段必须逐条人工确认后才会写入终稿）"));
  }
  pane.append(actions);

  if (locked) renderFinalTranscript(pane);
}

function statTile(n, label, color) {
  return h("div", { class: "stat-tile" },
    h("div", { class: "n", style: color ? `color:${color}` : "" }, String(n)),
    h("div", { class: "l" }, label));
}

function renderMergeItem(it, locked) {
  const badge = {
    missing: h("span", { class: "badge missing" }, "无人校对"),
    agreed: h("span", { class: "badge agreed" }, "一致 · 自动"),
    conflict: h("span", { class: "badge conflict" }, "冲突待确认"),
    resolved: h("span", { class: "badge resolved" }, "已人工确认"),
    review: h("span", { class: "badge", style: "background:var(--amber-dim);color:var(--amber)" }, "已确认 · 版本有变待复核"),
  }[it.state];

  const head = h("div", { class: "mi-head" },
    h("b", {}, `#${it.idx + 1}`),
    h("span", { class: "tc", style: "cursor:pointer;font-variant-numeric:tabular-nums",
      onclick: () => playSegment(it) }, `${fmtTC(it.start_ms)} → ${fmtTC(it.end_ms)} ▶`),
    badge, h("span", { class: "spacer" }),
    h("span", { class: "hint" }, `${it.versions.length} 份校对`));

  const box = h("div", { class: "merge-item" }, head,
    h("div", { class: "original" }, "听写原稿：" + it.original));

  if (it.state === "missing") return box;

  if (it.state === "agreed") {
    box.append(h("div", { class: "version-box" },
      h("div", { class: "vh" }, h("span", { class: "name" }, "自动合入文本")),
      h("div", { class: "vtext" }, it.versions[0].text)));
    return box;
  }

  // 冲突：每个版本是一个可选项 + 人工编辑
  const choices = h("div", { class: "choices" });
  const currentChoice = state.mergeChoice[it.id]
    || (it.merge?.chosen === "manual" && it.merge.chosen_user ? `user:${it.merge.chosen_user}` : null)
    || (it.merge?.chosen === "manual" ? "manual" : null);
  const choiceEls = {};
  for (const v of it.versions) {
    const key = "user:" + v.user_id;
    const el = h("div", { class: "choice" + (currentChoice === key ? " picked" : "") },
      h("div", { class: "ch-head" }, avatar(v.user_name), h("b", {}, v.user_name + " 版"),
        v.note ? h("span", { class: "vnote" }, "· " + v.note) : null),
      h("div", { class: "ch-text" }, v.text));
    el.onclick = () => {
      if (locked) return;
      state.mergeChoice[it.id] = key;
      Object.values(choiceEls).forEach(c => c.classList.remove("picked"));
      el.classList.add("picked");
      manualTa.value = v.text;
    };
    choiceEls[key] = el;
    choices.append(el);
  }
  const manualKey = "manual";
  const manualTa = h("textarea", { class: "input", rows: "4",
    placeholder: "也可以综合各版本，直接人工裁定最终文本" });
  manualTa.value = state.mergeDrafts[it.id]
    ?? (it.merge?.chosen === "manual" ? it.merge.text : "");
  manualTa.addEventListener("input", () => {
    state.mergeDrafts[it.id] = manualTa.value;
    state.mergeChoice[it.id] = "manual";
    Object.values(choiceEls).forEach(c => c.classList.remove("picked"));
    manualWrap.classList.add("picked");
  });
  const manualWrap = h("div", { class: "choice manual-box" + (currentChoice === "manual" ? " picked" : "") },
    h("div", { class: "ch-head" }, h("b", {}, "人工裁定文本")), manualTa);
  manualWrap.onclick = ev => { if (ev.target !== manualTa && !locked) manualTa.focus(); };
  choiceEls[manualKey] = manualWrap;
  box.append(choices, manualWrap);

  if (it.state === "resolved" && it.merge) {
    box.append(h("div", { class: "hint", style: "margin-top:6px;color:var(--accent)" },
      "当前定稿：" + (it.merge.text || "").slice(0, 80) + ((it.merge.text || "").length > 80 ? "…" : "")));
  }

  if (!locked) {
    box.append(h("div", { class: "seg-foot", style: "margin-top:12px" },
      h("span", { class: "spacer" }),
      h("button", {
        class: "btn primary", onclick: async () => {
          const choice = state.mergeChoice[it.id];
          if (!choice) return toast("请先选择一个版本，或在人工裁定框中写定文本", "err");
          try {
            if (choice === "manual") {
              if (!manualTa.value.trim()) return toast("人工裁定文本不能为空", "err");
              await api(`/api/projects/${state.pid}/segments/${it.id}/resolve`, {
                method: "POST",
                body: JSON.stringify({ chosen: "manual", text: manualTa.value }),
              });
            } else {
              const uid2 = choice.slice(5);
              const v = it.versions.find(x => x.user_id === uid2);
              state.mergeDrafts[it.id] = v.text;
              await api(`/api/projects/${state.pid}/segments/${it.id}/resolve`, {
                method: "POST",
                body: JSON.stringify({ chosen: "user_a", chosen_user: uid2, text: v.text }),
              });
            }
            toast(`第 ${it.idx + 1} 段冲突已人工确认`, "ok");
            delete state.dirty;
            renderTab();
          } catch (e) { toast(e.message, "err"); }
        }
      }, "确认此段定稿")));
  }
  return box;
}

async function finalize() {
  if (!confirm("确认定稿？系统将校验：每段均有校对稿、所有冲突均已人工确认。定稿后校对将被锁定（可由成员重新打开）。"))
    return;
  try {
    state.project = await api(`/api/projects/${state.pid}/finalize`, { method: "POST" });
    toast("全稿已定稿落库", "ok");
    renderShell();
    await refreshSegments();
    renderTab();
  } catch (e) { toast(e.message, "err"); }
}

async function renderFinalTranscript(pane) {
  const { segments } = await api(`/api/projects/${state.pid}/final`);
  const box = h("div", { class: "pane-inner final-view" },
    h("h3", { style: "margin:6px 0 12px" }, "终稿全文"));
  for (const s of segments) {
    box.append(h("div", { class: "fv-seg" },
      h("div", { class: "fv-tc" }, `${fmtTC(s.start_ms)} → ${fmtTC(s.end_ms)}`),
      h("div", { class: "fv-text" }, s.text)));
  }
  pane.append(box);
}

// ---------- 素材 / 分段导入页 ----------
function renderImportTab(pane) {
  const p = state.project;
  const locked = p.status === "finalized";
  const inner = h("div", { class: "pane-inner" });

  // 音频上传
  const audioPanel = h("div", { class: "panel-box" },
    h("h3", {}, "① 上传音频"),
    p.audio_name
      ? h("p", { class: "hint" }, `当前音频：${p.audio_name}` +
          (p.audio_dur ? `，时长 ${fmtClock(p.audio_dur * 1000)}` : "（读取时长中…）") +
          (p.audio_size ? `，${(p.audio_size / 1048576).toFixed(1)} MB` : ""))
      : h("p", { class: "hint" }, "支持 wav / mp3 / m4a / ogg / flac，上限 300MB，支持拖动播放（Range 请求）。"),
  );
  if (!locked) {
    const fileIn = h("input", { type: "file", accept: "audio/*,.wav,.mp3,.m4a,.ogg,.flac" });
    const upBtn = h("button", { class: "btn primary" }, "上传并替换音频");
    upBtn.onclick = async () => {
      const f = fileIn.files[0];
      if (!f) return toast("请先选择音频文件", "err");
      const fd = new FormData();
      fd.append("file", f);
      upBtn.disabled = true; upBtn.textContent = "上传中…";
      try {
        await api(`/api/projects/${state.pid}/audio`, { method: "POST", body: fd });
        state.project = await api(`/api/projects/${state.pid}`);
        toast("音频已上传", "ok");
        renderShell(); renderTab();
      } catch (e) { toast(e.message, "err"); upBtn.disabled = false; upBtn.textContent = "上传并替换音频"; }
    };
    audioPanel.append(h("div", { class: "upload-row" }, fileIn, upBtn));
  }
  inner.append(audioPanel);

  // 草稿导入
  const seedPanel = h("div", { class: "panel-box" },
    h("h3", {}, "② 导入听写草稿（自动分段与时间码对齐）"),
    h("p", { class: "hint" },
      "支持三种格式，自动识别：", h("br"),
      "• SRT：序号 + ", h("code", {}, "00:00:01,000 --> 00:00:05,000"), " + 正文", h("br"),
      "• 时间码行：", h("code", {}, "[00:00:01,000] 正文内容"), h("br"),
      "• 纯文本：每行一段，按 12 秒等长预切，之后在校对页用「⏱ 时间码」精修或在播放处拆分。",
      h("br"), "注意：一旦已有校对提交，分段结构将锁定，不能整体替换。"));
  const ta = h("textarea", { class: "input", rows: "10", placeholder: "把 SRT 或时间码文本粘贴到这里…" });
  const hasProofs = state.segments.some(s => s.versions.length);
  seedPanel.append(ta);
  if (locked) {
    seedPanel.append(h("p", { class: "hint", style: "margin-top:8px;color:var(--amber)" }, "项目已定稿，导入已关闭。"));
  } else if (hasProofs) {
    seedPanel.append(h("p", { class: "hint", style: "margin-top:8px;color:var(--amber)" },
      "已有校对提交，禁止整体替换；请在校对页逐条调整时间码或拆分。"));
  } else {
    seedPanel.append(h("div", { class: "seg-foot", style: "margin-top:10px" },
      h("span", { class: "spacer" }),
      h("button", {
        class: "btn primary", onclick: async () => {
          if (!ta.value.trim()) return toast("请粘贴草稿文本", "err");
          try {
            const r = await api(`/api/projects/${state.pid}/segments/import`, {
              method: "POST", body: JSON.stringify({ text: ta.value }),
            });
            toast(`已导入 ${r.segments.length} 个分段`, "ok");
            await refreshSegments();
            location.hash = `#/project/${state.pid}?tab=proof`;
          } catch (e) { toast(e.message, "err"); }
        }
      }, "解析并生成分段")));
  }
  inner.append(seedPanel);

  // 当前分段清单
  const listPanel = h("div", { class: "panel-box" },
    h("h3", {}, `③ 当前分段（${state.segments.length}）`));
  const rows = state.segments.map(s => h("div", {
    class: "log-row", style: "cursor:pointer",
    onclick: () => { location.hash = `#/project/${state.pid}?tab=proof`; setTimeout(() => {
      const el = $(`.seg[data-id="${s.id}"]`); el?.scrollIntoView({ behavior: "smooth" }); playSegment(s);
    }, 300); }
  }, h("span", { class: "t" }, fmtTC(s.start_ms)), h("span", {}, s.original)));
  listPanel.append(h("div", {}, ...rows));
  inner.append(listPanel);

  pane.append(inner);
}

// ---------- 审计页 ----------
async function renderAuditTab(pane) {
  const { logs } = await api(`/api/projects/${state.pid}/audit`);
  const inner = h("div", { class: "pane-inner" },
    h("h3", { style: "margin:4px 0 14px" }, "审计日志（所有校对、冲突确认、定稿动作均不可篡改地留痕）"));
  if (!logs.length) inner.append(h("div", { class: "empty" }, "暂无日志"));
  for (const l of logs) {
    inner.append(h("div", { class: "log-row" },
      h("span", { class: "t" }, new Date(l.created_at).toLocaleString()),
      h("span", { class: "u" }, l.user_name || "系统"),
      h("span", { class: "a" }, l.action),
      h("span", {}, l.detail)));
  }
  pane.append(inner);
}

// ---------- 启动 ----------
$("#brand").onclick = () => { location.hash = "#/"; };
init();

async function init() {
  if (state.user) {
    const u = await api("/api/users").catch(() => null);
    if (u && !u.users.some(x => x.id === state.user.id)) {
      state.user = null;
      localStorage.removeItem("td_user");
    }
  }
  renderIdentityChip();
  if (!state.user) openIdentity();
  route();
}
