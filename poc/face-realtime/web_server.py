"""6단계: 브라우저 화면 + 내 PC의 Python 분석 서버 (localhost)

분석은 전부 이 Python 프로그램이 한다. 브라우저는 결과를 보여주고 버튼 입력만 보낸다.
서버는 127.0.0.1에만 열려 같은 PC의 브라우저만 접속할 수 있다. 추가 패키지는 필요 없다(표준 라이브러리).

실행 예)
  python web_server.py              # http://127.0.0.1:8000 이 자동으로 열림
  python web_server.py --no-mic     # 마이크 없이
  python web_server.py --port 8080 --camera 1 --no-browser

주소
  GET  /                화면 (web/index.html)
  GET  /video.mjpg      웹캠 영상 (MJPEG)
  GET  /events          상태 스트림 (Server-Sent Events, 초당 10회)
  GET  /api/questions   연습 질문 목록
  POST /api/command     {"action": "start" | "stop" | "redo_setup" | "skip_position" | "report", "question": "..."}
  GET  /eval.html       평가용 지시 화면 (8단계): 지시를 따라 하는 동안 recordings/ 에 영상·음성·정답을 저장
                        {"action": "eval_start", "task": "gaze" | "rate" | "filler"}, "eval_mark", "eval_stop"
"""
import argparse
import json
import mimetypes
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from coach_engine import CoachEngine

WEB_DIR = Path(__file__).parent / "web"
STATE_INTERVAL = 0.1
BOUNDARY = "frame"
QUESTIONS = [
    "간단하게 자기소개를 해 주세요.",
    "우리 회사에 지원한 이유는 무엇인가요?",
    "가장 기억에 남는 프로젝트와 본인의 역할을 말해 주세요.",
    "팀에서 갈등이 있었을 때 어떻게 해결했나요?",
    "본인의 단점과 이를 보완하기 위한 노력을 말해 주세요.",
    "입사 후 5년 뒤의 모습을 말해 주세요.",
]


def make_handler(engine):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # 요청마다 찍히는 로그는 끔
            pass

        def _send(self, code, body, ctype):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/video.mjpg":
                return self._video()
            if path == "/events":
                return self._events()
            if path == "/api/questions":
                return self._json({"questions": QUESTIONS})
            if path == "/api/state":
                return self._json(engine.state())
            return self._static(path)

        def do_POST(self):
            if self.path != "/api/command":
                return self._json({"ok": False, "error": "없는 주소"}, 404)
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                action = body.pop("action")
            except (ValueError, KeyError):
                return self._json({"ok": False, "error": "잘못된 요청"}, 400)
            self._json(engine.command(action, **body))

        def _static(self, path):
            name = "index.html" if path in ("", "/") else path.lstrip("/")
            file = (WEB_DIR / name).resolve()
            if WEB_DIR.resolve() not in file.parents or not file.is_file():
                return self._json({"ok": False, "error": "없는 파일"}, 404)
            ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype == "application/javascript":
                ctype += "; charset=utf-8"
            self._send(200, file.read_bytes(), ctype)

        def _video(self):
            self.send_response(200)
            self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY}")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            last = 0
            try:
                while True:
                    last, jpeg = engine.wait_frame(last)
                    if jpeg is None:
                        time.sleep(0.2)
                        continue
                    self.wfile.write(f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\n"
                                     f"Content-Length: {len(jpeg)}\r\n\r\n".encode())
                    self.wfile.write(jpeg)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

        def _events(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                while True:
                    data = json.dumps(engine.state(), ensure_ascii=False)
                    self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    time.sleep(STATE_INTERVAL)
            except (BrokenPipeError, ConnectionResetError):
                pass
            self.close_connection = True

    return Handler


def main():
    parser = argparse.ArgumentParser(description="브라우저 화면 + 로컬 Python 분석 서버")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--camera", default="0", help="웹캠 번호, 또는 시험용 영상 파일 경로")
    parser.add_argument("--no-mic", action="store_true", help="마이크를 쓰지 않음")
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    args = parser.parse_args()

    camera = int(args.camera) if args.camera.isdigit() else args.camera
    engine = CoachEngine(camera=camera, use_mic=not args.no_mic)
    engine.start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(engine))
    server.daemon_threads = True
    url = f"http://127.0.0.1:{args.port}"
    print(f"{url} 에서 열렸습니다. 끝내려면 Ctrl+C")
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        engine.close()


if __name__ == "__main__":
    main()
