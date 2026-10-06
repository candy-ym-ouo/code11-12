"""纯标准库工具：时间码、SRT、字符级 diff、WAV 探测、分片 multipart 解析。"""
from __future__ import annotations

import os
import re
import secrets
import uuid
from html import escape
from typing import Iterable

# ---------- id / token ----------

def uid() -> str:
    return uuid.uuid4().hex


def new_token() -> str:
    return secrets.token_hex(24)


# ---------- 时间码 ----------

_TC = re.compile(r"^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*$")
_TC_SHORT = re.compile(r"^\s*(\d{1,2}):(\d{2})[,.](\d{1,3})\s*$")


def parse_timecode(s: str) -> int:
    """'00:01:02,500' / '01:02.5' -> 毫秒。非法输入抛 ValueError。"""
    m = _TC.match(s)
    if m:
        h, mi, sec, ms = m.groups()
        ms = int(ms.ljust(3, "0"))
        return (int(h) * 3600 + int(mi) * 60 + int(sec)) * 1000 + ms
    m = _TC_SHORT.match(s)
    if m:
        mi, sec, ms = m.groups()
        ms = int(ms.ljust(3, "0"))
        return (int(mi) * 60 + int(sec)) * 1000 + ms
    raise ValueError(f"无法识别的时间码：{s!r}（应为 HH:MM:SS,mmm）")


def fmt_tc(ms: int) -> str:
    if ms is None:
        return "--:--:--,---"
    if ms < 0:
        ms = 0
    h, rem = divmod(int(ms), 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, x = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{x:03d}"


def fmt_clock(ms: int) -> str:
    """播放器时钟 MM:SS（无小时）或 H:MM:SS。"""
    s = int(ms / 1000)
    h, rem = divmod(s, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


# ---------- 草稿导入：SRT / 带时间码文本 / 纯文本 ----------

_SRT_INDEX = re.compile(r"^\d+$")


def parse_seed(text: str, default_chunk_ms: int = 12000) -> list[dict]:
    """返回 [{start_ms, end_ms, original}]。

    1) 含 '-->' 的 SRT 块
    2) 每行 '[00:00:01,000] 正文' 或 '00:00:01,000 正文'
    3) 其余 → 纯文本，按行均分默认时长
    """
    text = text.replace("﻿", "")
    if "-->" in text:
        segs = _parse_srt(text)
        if segs:
            return segs
    segs = _parse_timecoded_lines(text)
    if segs:
        return segs
    return _parse_plain(text, default_chunk_ms)


def _parse_srt(text: str) -> list[dict]:
    blocks = re.split(r"\n\s*\n", text.strip())
    out: list[dict] = []
    for block in blocks:
        lines = [l.strip() for l in block.splitlines() if l.strip()]
        if not lines:
            continue
        if _SRT_INDEX.match(lines[0]) and len(lines) >= 2 and "-->" in lines[1]:
            lines = lines[1:]
        if "-->" not in lines[0]:
            raise ValueError(f"SRT 块缺少时间码行：{block[:40]!r}")
        if len(lines) < 2 or not lines[1].strip():
            raise ValueError(f"SRT 块缺少正文：{lines[0]}")
        a, b = lines[0].split("-->", 1)
        start, end = parse_timecode(a.strip()), parse_timecode(b.strip())
        if end <= start:
            raise ValueError(f"SRT 时间码结束早于开始：{a.strip()} --> {b.strip()}")
        body = "\n".join(lines[1:]).strip()
        out.append({"start_ms": start, "end_ms": end, "original": body})
    return out


_INLINE_TC = re.compile(
    r"^\s*\[?\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*\]?\s*[:：]?\s*(.+)$"
)


def _parse_timecoded_lines(text: str) -> list[dict]:
    hits: list[tuple[int, str]] = []
    for line in text.splitlines():
        m = _INLINE_TC.match(line)
        if m:
            try:
                hits.append((parse_timecode(m.group(1)), m.group(2).strip()))
            except ValueError:
                pass
    if not hits:
        return []
    out = []
    for i, (start, body) in enumerate(hits):
        end = hits[i + 1][0] if i + 1 < len(hits) else start + 12000
        if body and end > start:
            out.append({"start_ms": start, "end_ms": end, "original": body})
    return out


def _parse_plain(text: str, chunk_ms: int) -> list[dict]:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return [
        {"start_ms": i * chunk_ms, "end_ms": (i + 1) * chunk_ms, "original": body}
        for i, body in enumerate(lines)
    ]


# ---------- SRT / TXT 导出 ----------

def to_srt(segments: Iterable[dict]) -> str:
    parts = []
    for i, seg in enumerate(segments, 1):
        parts.append(f"{i}\n{fmt_tc(seg['start_ms'])} --> {fmt_tc(seg['end_ms'])}\n{seg['text']}")
    return "\n\n".join(parts) + "\n"


def to_txt(segments: Iterable[dict]) -> str:
    return "\n".join(f"[{fmt_tc(s['start_ms'])}] {s['text']}" for s in segments) + "\n"


# ---------- 字符级 diff（LCS 回溯，中文按字） ----------

def char_diff(a: str, b: str) -> list[dict]:
    """返回 [{op: eq|del|ins, text}]。"""
    n, m = len(a), len(b)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if a[i] == b[j] else max(dp[i + 1][j], dp[i][j + 1])
    ops: list[dict] = []
    i = j = 0

    def push(op: str, ch: str) -> None:
        if ops and ops[-1]["op"] == op:
            ops[-1]["text"] += ch
        else:
            ops.append({"op": op, "text": ch})

    while i < n and j < m:
        if a[i] == b[j]:
            push("eq", a[i]); i += 1; j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            push("del", a[i]); i += 1
        else:
            push("ins", b[j]); j += 1
    if i < n:
        push("del", a[i:])
    if j < m:
        push("ins", b[j:])
    return ops


def diff_html(a: str, b: str) -> str:
    out = []
    for op in char_diff(a, b):
        t = escape(op["text"])
        if op["op"] == "del":
            out.append(f'<del style="color:#c0392b">{t}</del>')
        elif op["op"] == "ins":
            out.append(f'<ins style="color:#1e8449">{t}</ins>')
        else:
            out.append(t)
    return "".join(out)


# ---------- WAV 时长探测 ----------

def wav_duration_seconds(path: str) -> float | None:
    try:
        with open(path, "rb") as f:
            if f.read(12)[:4] != b"RIFF":
                return None
            data_size = 0
            byte_rate = channels = 0
            while True:
                hdr = f.read(8)
                if len(hdr) < 8:
                    return None
                cid, size = hdr[:4], int.from_bytes(hdr[4:8], "little")
                if cid == b"fmt ":
                    fmt = f.read(min(size, 16))
                    channels = int.from_bytes(fmt[2:4], "little")
                    byte_rate = int.from_bytes(fmt[8:12], "little")
                    f.seek(max(0, size - 16) + (size & 1 if size > 16 else 0), 1)
                elif cid == b"data":
                    data_size = size
                    break
                else:
                    f.seek(size + (size & 1), 1)
            if channels > 0 and byte_rate > 0 and data_size > 0:
                return round(data_size / byte_rate, 3)
    except OSError:
        return None
    return None


# ---------- multipart/form-data 单遍流式解析 ----------

class _LimitedReader:
    """按 Content-Length 限量读取：keep-alive 连接上 body 之后还有下个请求，
    绝不能直接读到 EOF，否则会永久阻塞。"""

    def __init__(self, rfile, remaining: int):
        self.rfile = rfile
        self.remaining = remaining

    def read(self, size: int = -1) -> bytes:
        if self.remaining <= 0:
            return b""
        if size is None or size < 0:
            size = self.remaining
        chunk = self.rfile.read(min(size, self.remaining))
        self.remaining -= len(chunk)
        return chunk


def parse_multipart(rfile, content_type: str, dest_dir: str, max_bytes: int,
                    length: int | None = None) -> dict:
    """解析 multipart 表单。文件流式落盘 dest_dir，普通字段读入内存。

    返回 {fields: {name: str}, file: dict|None}。length 为请求体 Content-Length。
    """
    if length is not None and length > max_bytes:
        raise ValueError(f"上传体超过上限 {max_bytes} 字节")
    rfile = _LimitedReader(rfile, length if length is not None else max_bytes)
    m = re.search(r"boundary=(?:\"([^\"]+)\"|([^;]+))", content_type)
    if not m:
        raise ValueError("缺少 multipart boundary")
    boundary = (m.group(1) or m.group(2)).strip().encode()
    marker = b"--" + boundary
    sep = b"\r\n" + marker           # part 之间
    tail_window = len(sep) + 2       # 足够容纳可能跨块的分隔符 + --/CRLF

    fields: dict[str, str] = {}
    file_info = None
    buf = b""
    total = 0
    phase = "preamble"
    part = {}

    def close_part():
        nonlocal file_info
        if not part:
            return
        if part.get("fp"):
            part["fp"].close()
            file_info = {
                "field": part["name"],
                "filename": part["filename"],
                "path": part["path"],
                "size": part["size"],
                "content_type": part["ctype"],
            }
        else:
            data = part["bytes"]
            if data.endswith(b"\r\n"):
                data = data[:-2]
            fields[part["name"]] = data.decode("utf-8", errors="replace")

    def start_part(headers_raw: bytes):
        nonlocal part
        part = {"name": "", "filename": None, "ctype": "application/octet-stream",
                "fp": None, "bytes": b"", "path": None, "size": 0}
        for line in headers_raw.decode("latin1").split("\r\n"):
            low = line.lower()
            if low.startswith("content-disposition"):
                mm = re.search(r'name="([^"]*)"', low)
                if mm:
                    part["name"] = mm.group(1)
                fm = re.search(r'filename="([^"]*)"', low)
                if fm:
                    part["filename"] = fm.group(1)
            elif low.startswith("content-type"):
                part["ctype"] = line.split(":", 1)[1].strip()
        if part["filename"] is not None:
            safe = f"{uid()}_{os.path.basename(part['filename']).replace(chr(0), '')}"
            os.makedirs(dest_dir, exist_ok=True)
            part["path"] = os.path.join(dest_dir, safe)
            part["fp"] = open(part["path"], "wb")

    def write_body(chunk: bytes):
        if part.get("fp"):
            part["fp"].write(chunk)
            part["size"] += len(chunk)
        else:
            part["bytes"] += chunk

    while True:
        chunk = rfile.read(1 << 20)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise ValueError(f"上传体超过上限 {max_bytes} 字节")
        buf += chunk

        if phase == "preamble":
            idx = buf.find(marker)
            if idx < 0:
                buf = buf[-(len(marker)):]
                continue
            buf = buf[idx + len(marker):]
            if buf.startswith(b"--"):
                return {"fields": fields, "file": None}
            if buf.startswith(b"\r\n"):
                buf = buf[2:]
            phase = "headers"

        while True:
            if phase == "headers":
                idx = buf.find(b"\r\n\r\n")
                if idx < 0:
                    break
                start_part(buf[:idx])
                buf = buf[idx + 4:]
                phase = "body"
            if phase == "body":
                pos = buf.find(sep)
                if pos < 0:
                    write_body(buf[:-tail_window] if len(buf) > tail_window else b"")
                    buf = buf[-tail_window:] if len(buf) > tail_window else buf
                    break
                write_body(buf[:pos])
                close_part()
                buf = buf[pos + len(sep):]
                if buf.startswith(b"--"):
                    return {"fields": fields, "file": file_info}
                # boundary 行尾 CRLF 之后才是下一个 part 的头
                if buf.startswith(b"\r\n"):
                    buf = buf[2:]
                phase = "headers"
                if not buf:
                    break

    raise ValueError("multipart 数据不完整（连接提前结束）")
