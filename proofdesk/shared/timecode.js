// 时间码工具：秒数(浮点) <-> SMPTE 风格时间码 HH:MM:SS.mmm / HH:MM:SS,mmm
// 支持解析 HH:MM:SS、MM:SS、SS(.mmm) 以及 , 作毫秒分隔符的 SRT 形式

/**
 * 把秒数格式化为 HH:MM:SS.mmm
 * @param {number} seconds
 * @param {string} [msSep='.'] SRT 用 ','
 */
export function formatTC(seconds, msSep = '.') {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(ms, 3)}`;
}

/**
 * 把时间码解析为秒。返回 null 表示无法解析。
 * 接受："HH:MM:SS(.|,mmm)"、"MM:SS(.mmm)"、纯秒数 "12.5"
 * 两位数以上无法判歧义时按 [H:]M:S 处理；"90:00" => 90 分钟
 */
export function parseTC(text) {
  if (text == null) return null;
  let s = String(text).trim();
  if (s === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  s = s.replace(',', '.');
  const m = s.match(/^(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  // H:MM:SS 形式分钟必须 <60；M:SS 形式分钟允许溢出（如 90:00 = 5400 秒）
  if (sec >= 60 || (m[1] && min >= 60)) return null;
  const msPart = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  return h * 3600 + min * 60 + sec + msPart / 1000;
}

/** 紧凑展示：不到一小时显示 M:SS，否则 HH:MM:SS（校对台时间轴用） */
export function shortTC(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalSec = Math.floor(seconds);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * 等距分段：给定音频时长和段长，生成 [{start,end}]
 */
export function evenSegments(duration, segmentSec = 30) {
  const out = [];
  if (!Number.isFinite(duration) || duration <= 0) return out;
  const step = Math.max(5, segmentSec);
  let t = 0;
  while (t < duration - 0.05) {
    const end = Math.min(t + step, duration);
    out.push({ start: round3(t), end: round3(end) });
    t = end;
  }
  return out;
}

export const round3 = (n) => Math.round(n * 1000) / 1000;
