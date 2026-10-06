"""HTTP 层：标准库 ThreadingHTTPServer，提供 JSON API、音频 Range 流与静态前端。"""
from __future__ import annotations

import json
import os
import re
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import service
from .db import DATA_DIR, init_db
from .util import parse_multipart, parse_seed, to_srt, to_txt, wav_duration_seconds

UPLOAD_DIR = DATA_DIR / "uploads"
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_BODY = 300 * 1024 * 1024  # 上传上限 300MB

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "TranscriptDesk/1.0"
    protocol_version = "HTTP/1.1"

    # ---------- 基础收发 ----------

    def _send_json(self, obj, status: int = 200, extra_headers: dict | None = None) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path, download_name: str | None = None) -> None:
        ctype = MIME.get(path.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        if download_name:
            quoted = urllib.parse.quote(download_name)
            self.send_header("Content-Disposition",
                             f"attachment; filename*=UTF-8''{quoted}")
        self.send_header("Content-Length", str(path.stat().st_size))
        self.end_headers()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > 10 * 1024 * 1024:
            raise service.bad("请求体过大")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise service.bad("请求不是合法 JSON")
        if not isinstance(data, dict):
            raise service.bad("请求体必须是 JSON 对象")
        return data

    def _auth(self) -> dict:
        h = self.headers.get("Authorization", "")
        token = h[7:].strip() if h.startswith("Bearer ") else ""
        if not token:
            token = self.headers.get("X-Auth-Token", "").strip()
        user = service.user_by_token(token)
        if not user:
            raise service.HttpError(401, "unauthorized", "请先选择校对员身份")
        return user

    def _auth_opt(self) -> dict | None:
        h = self.headers.get("Authorization", "")
        token = h[7:].strip() if h.startswith("Bearer ") else self.headers.get("X-Auth-Token", "")
        return service.user_by_token(token.strip())

    def log_message(self, fmt, *args) -> None:  # 静默默认日志
        pass

    # ---------- 路由 ----------

    def do_GET(self) -> None:
        self._dispatch("GET")

    def do_POST(self) -> None:
        self._dispatch("POST")

    def do_PATCH(self) -> None:
        self._dispatch("PATCH")

    def do_DELETE(self) -> None:
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        try:
            self._route(method, path, qs)
        except service.HttpError as e:
            self._send_json({"error": e.code, "message": e.message}, e.status)
        except Exception as e:  # noqa: BLE001 - 兜底，避免断连
            self._send_json({"error": "internal", "message": f"服务器错误：{e}"}, 500)

    def _route(self, method: str, path: str, qs: dict) -> None:
        # 静态前端
        if method == "GET" and (path == "/" or path == "/index.html"):
            return self._send_file(WEB_DIR / "index.html")
        m = re.fullmatch(r"/static/(.+)", path)
        if method == "GET" and m:
            target = (WEB_DIR / urllib.parse.unquote(m.group(1))).resolve()
            if WEB_DIR.resolve() not in target.parents or not target.is_file():
                raise service.notfound()
            return self._send_file(target)

        # API
        m = re.fullmatch(r"/api/projects/([^/]+)/audio/([^/]+)", path)
        if method == "GET" and m:
            return self._serve_audio(m.group(1), m.group(2))

        routes = [
            ("POST", r"^/api/users$", self._users_register),
            ("GET", r"^/api/users$", self._users_list),
            ("POST", r"^/api/users/login$", self._users_login),
            ("GET", r"^/api/projects$", self._projects_list),
            ("POST", r"^/api/projects$", self._projects_create),
            ("POST", r"^/api/projects/demo$", self._projects_demo),
        ]
        for rm, pat, fn in routes:
            if method == rm and re.fullmatch(pat, path):
                return fn(qs)

        m = re.fullmatch(r"/api/projects/([^/]+)", path)
        if method == "GET" and m:
            return self._send_json(service.get_project(m.group(1)))
        m = re.fullmatch(r"/api/projects/([^/]+)/(.+)", path)
        if m:
            pid, action = m.group(1), m.group(2)
            return self._project_route(method, pid, action, qs)
        raise service.notfound()

    # ---------- 用户 ----------

    def _users_register(self, qs) -> None:
        data = self._read_json()
        self._send_json(service.create_user(data.get("name", "")), 201)

    def _users_login(self, qs) -> None:
        data = self._read_json()
        self._send_json(service.login_user(data.get("name", "")))

    def _users_list(self, qs) -> None:
        self._send_json({"users": service.list_users()})

    # ---------- 项目 ----------

    def _projects_list(self, qs) -> None:
        self._send_json({"projects": service.list_projects()})

    def _projects_create(self, qs) -> None:
        user = self._auth()
        data = self._read_json()
        self._send_json(service.create_project(data.get("name", ""), data.get("description", ""), user), 201)

    def _projects_demo(self, qs) -> None:
        """一键生成带音频、草稿和两位校对员部分稿的演示项目。"""
        from . import seed
        self._send_json(seed.create_demo(), 201)

    def _project_route(self, method: str, pid: str, action: str, qs: dict) -> None:
        # 公开：项目详情/分段/合并视图/导出/审计（本地协作台，读不设限）
        if method == "GET":
            if action == "segments":
                return self._send_json({"segments": service.get_segments(pid)})
            if action == "merge":
                return self._send_json(service.merge_overview(pid))
            if action == "final":
                return self._send_json({"segments": service.final_transcript(pid)})
            if action == "audit":
                return self._send_json({"logs": service.audit_logs(pid)})
            if action == "export":
                return self._export(pid, qs.get("format", "srt"))
            raise service.notfound()

        user = self._auth()

        if method == "POST" and action == "audio":
            return self._upload_audio(pid, user)
        if method == "POST" and action == "audio-meta":
            data = self._read_json()
            service.set_audio_meta(pid, data.get("duration"), user)
            return self._send_json({"ok": True})
        if method == "POST" and action == "segments/import":
            data = self._read_json()
            try:
                segs = parse_seed(data.get("text", ""))
            except ValueError as e:
                raise service.bad(f"草稿解析失败：{e}")
            return self._send_json({"segments": service.replace_segments(pid, segs, "草稿", user)})
        if method == "POST" and action == "reopen":
            return self._send_json(service.reopen_project(pid, user))
        if method == "POST" and action == "finalize":
            return self._send_json(service.finalize(pid, user))
        if method == "POST" and action == "heartbeat":
            data = self._read_json()
            return self._send_json({"presence": service.heartbeat(pid, data.get("segment_id"), user)})

        m = re.fullmatch(r"segments/([^/]+)/proofs", action)
        if method == "POST" and m:
            data = self._read_json()
            res = service.submit_version(pid, m.group(1), data.get("text", ""), data.get("note", ""), user)
            return self._send_json(res, 201)

        m = re.fullmatch(r"segments/([^/]+)/split", action)
        if method == "POST" and m:
            data = self._read_json()
            at = data.get("at_ms")
            if at is None:
                raise service.bad("缺少 at_ms")
            return self._send_json({"segments": service.split_segment(pid, m.group(1), int(at), user)})

        m = re.fullmatch(r"segments/([^/]+)/timecodes", action)
        if method == "POST" and m:
            data = self._read_json()
            res = service.adjust_segment(pid, m.group(1),
                                         int(data["start_ms"]), int(data["end_ms"]), user)
            return self._send_json(res)

        m = re.fullmatch(r"segments/([^/]+)/resolve", action)
        if method == "POST" and m:
            data = self._read_json()
            res = service.resolve_conflict(pid, m.group(1), data.get("chosen", ""),
                                           data.get("text", ""), data.get("chosen_user"), user)
            return self._send_json(res)

        raise service.notfound()

    # ---------- 音频上传 ----------

    def _upload_audio(self, pid: str, user: dict) -> None:
        ctype = self.headers.get("Content-Type", "")
        if not ctype.startswith("multipart/form-data"):
            raise service.bad("音频上传必须使用 multipart/form-data")
        service.get_project(pid)  # 404 检查
        length = int(self.headers.get("Content-Length") or 0)
        try:
            form = parse_multipart(self.rfile, ctype, str(UPLOAD_DIR), MAX_BODY, length)
        except ValueError as e:
            raise service.bad(str(e))
        fi = form.get("file")
        if not fi:
            raise service.bad("缺少音频文件字段 file")
        import sqlite3
        from .db import get_conn
        dur = wav_duration_seconds(fi["path"])
        conn = get_conn()
        try:
            conn.execute(
                "UPDATE projects SET audio_file=?, audio_name=?, audio_mime=?, audio_size=?,"
                "audio_dur=COALESCE(audio_dur,?) WHERE id=?",
                (os.path.basename(fi["path"]), fi["filename"], fi["content_type"], fi["size"], dur, pid))
            conn.execute(
                "INSERT INTO audit_logs(project_id,user_id,action,detail,created_at) VALUES(?,?,?,?,?)",
                (pid, user["id"], "project.audio_upload",
                 f"上传音频 {fi['filename']} ({fi['size']} 字节)", service.now_ms()))
            conn.commit()
        finally:
            conn.close()
        self._send_json({"ok": True, "audio_name": fi["filename"],
                         "size": fi["size"], "duration": dur}, 201)

    # ---------- 音频 Range 流 ----------

    def _serve_audio(self, pid: str, name: str) -> None:
        p = service.get_project(pid)
        if not p.get("audio_file") or urllib.parse.unquote(name) != p["audio_file"]:
            raise service.notfound("音频不存在")
        path = UPLOAD_DIR / p["audio_file"]
        if not path.is_file():
            raise service.notfound("音频文件丢失")
        size = path.stat().st_size
        ctype = MIME.get(path.suffix.lower(), p.get("audio_mime") or "audio/mpeg")
        range_hdr = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if range_hdr:
            mm = re.fullmatch(r"bytes=(\d*)-(\d*)", range_hdr.strip())
            if mm:
                a, b = mm.groups()
                if a:
                    start = int(a)
                if b:
                    end = min(int(b), size - 1)
                status = 206
        if start >= size or end < start:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    # ---------- 导出 ----------

    def _export(self, pid: str, fmt: str) -> None:
        p = service.get_project(pid)
        if p["status"] != "finalized":
            raise service.bad("只有定稿后的项目才能导出终稿")
        segs = service.final_transcript(pid)
        safe = re.sub(r"[^\w一-鿿-]+", "_", p["name"]).strip("_") or "transcript"
        if fmt == "txt":
            body = to_txt(segs).encode("utf-8")
            fname = f"{safe}.txt"
            ctype = "text/plain; charset=utf-8"
        else:
            body = to_srt(segs).encode("utf-8")
            fname = f"{safe}.srt"
            ctype = "application/x-subrip; charset=utf-8"
        quoted = urllib.parse.quote(fname)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quoted}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(host: str = "127.0.0.1", port: int = 4100) -> None:
    init_db()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"口述听写稿校对台已启动: http://{host}:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    import sys
    h = sys.argv[1] if len(sys.argv) > 1 else "127.0.0.1"
    p = int(sys.argv[2]) if len(sys.argv) > 2 else 4100
    serve(h, p)
