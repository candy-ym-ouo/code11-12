// 全局音频播放器：单例 <audio>，负责播放/暂停、倍速、区间循环、时间轴
import { mediaUrl } from './api.js';
import { h } from './dom.js';
import { shortTC } from '/shared/timecode.js';

class Player {
  constructor() {
    this.audio = document.getElementById('global-audio');
    this.project = null;
    this.loopRange = null; // {start,end}
    this.onTime = null;
    this.barEl = null;
    this.fillEl = null;
    this.knobEl = null;
    this.timeEl = null;
    this.playBtn = null;
    this.loopChip = null;
    this.segments = [];

    this.audio.addEventListener('timeupdate', () => this._tick());
    this.audio.addEventListener('play', () => this._renderPlay());
    this.audio.addEventListener('pause', () => this._renderPlay());
    this.audio.addEventListener('ended', () => this._renderPlay());
    this.audio.addEventListener('loadedmetadata', () => this._drawMarks());
  }

  load(project, segments) {
    this.project = project;
    this.segments = segments || [];
    this.loopRange = null;
    this.audio.src = project.audio ? mediaUrl(project.id) : '';
    this.audio.load();
    if (this.barEl) this._drawMarks();
  }

  bar() {
    this.playBtn = h('button', {
      class: 'play',
      title: '播放/暂停 (空格)',
      onClick: () => this.toggle(),
    }, '▶');
    this.timeEl = h('span', { class: 'times' }, '0:00 / 0:00');
    this.fillEl = h('div', { class: 'fill' });
    this.knobEl = h('div', { class: 'knob', style: 'left:0%' });
    const scrub = h('div', { class: 'scrub' }, [this.fillEl, this.knobEl]);
    scrub.addEventListener('click', (e) => {
      const r = scrub.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      this.seekRatio(ratio);
    });

    this.loopChip = h('button', {
      class: 'loop-chip',
      title: '当前段落循环播放，再点取消',
      onClick: () => {
        this.loopRange = null;
        this.loopChip.classList.remove('on');
        this.loopChip.textContent = '区间循环：关';
      },
    }, '区间循环：关');

    const rate = h(
      'select',
      { class: 'rate-select', onChange: (e) => (this.audio.playbackRate = Number(e.target.value)) },
      [0.7, 0.85, 1, 1.25, 1.5, 2].map((r) =>
        h('option', { value: r, selected: r === 1 }, r === 1 ? '1.0×' : `${r}×`),
      ),
    );

    this.barEl = h('div', { class: 'audio-bar' }, [
      this.playBtn,
      this.timeEl,
      scrub,
      this.loopChip,
      rate,
    ]);
    this._drawMarks();
    return this.barEl;
  }

  _drawMarks() {
    if (!this.barEl) return;
    this.barEl.querySelectorAll('.segmark').forEach((n) => n.remove());
    const scrub = this.barEl.querySelector('.scrub');
    const dur = this.audio.duration || this.project?.audio?.duration || 0;
    if (!dur) return;
    for (const s of this.segments) {
      if (s.start > 0) {
        scrub.append(h('div', { class: 'segmark', style: `left:${(s.start / dur) * 100}%` }));
      }
    }
  }

  setSegments(segments) {
    this.segments = segments || [];
    this._drawMarks();
  }

  async play() {
    if (!this.project?.audio) return;
    try {
      await this.audio.play();
    } catch (e) { /* 浏览器自动播放限制，等用户交互 */ }
  }
  pause() {
    this.audio.pause();
  }
  toggle() {
    if (this.audio.paused) this.play();
    else this.pause();
  }
  seekTo(t) {
    if (Number.isFinite(t)) this.audio.currentTime = Math.max(0, t);
  }
  seekRatio(r) {
    const dur = this.audio.duration || this.project?.audio?.duration;
    if (dur) this.seekTo(r * dur);
  }
  playRange(start, end, { loop = true } = {}) {
    this.loopRange = loop ? { start, end } : null;
    this._updateLoopChip(start, end, loop);
    this.seekTo(start);
    this.play();
  }
  clearLoop() {
    this.loopRange = null;
    if (this.loopChip) {
      this.loopChip.classList.remove('on');
      this.loopChip.textContent = '区间循环：关';
    }
  }
  _updateLoopChip(start, end, on) {
    if (!this.loopChip) return;
    if (on) {
      this.loopChip.classList.add('on');
      this.loopChip.textContent = `循环 ${shortTC(start)}–${shortTC(end)} ✕`;
    }
  }

  currentSegment() {
    const t = this.audio.currentTime;
    return this.segments.find((s) => t >= s.start && (s.end == null || t < s.end)) || null;
  }

  _tick() {
    const t = this.audio.currentTime;
    if (this.loopRange && t >= this.loopRange.end) {
      this.seekTo(this.loopRange.start);
      this.play();
    }
    const dur = this.audio.duration || this.project?.audio?.duration || 0;
    if (this.fillEl) this.fillEl.style.width = `${dur ? (t / dur) * 100 : 0}%`;
    if (this.knobEl) this.knobEl.style.left = `${dur ? (t / dur) * 100 : 0}%`;
    if (this.timeEl) this.timeEl.textContent = `${shortTC(t)} / ${shortTC(dur)}`;
    if (this.onTime) this.onTime(t);
  }
  _renderPlay() {
    if (this.playBtn) this.playBtn.textContent = this.audio.paused ? '▶' : '⏸';
  }
}

export const player = new Player();
