from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import mimetypes


ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
PUBLIC_FILES = {
    "/": DIST / "index.html",
    "/index.html": DIST / "index.html",
    "/ROADMAP.md": ROOT / "ROADMAP.md",
    "/THIRD_PARTY_NOTICES.md": ROOT / "THIRD_PARTY_NOTICES.md",
}


class EditorHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.serve_file()

    def do_HEAD(self):
        self.serve_file(send_body=False)

    def serve_file(self, send_body=True):
        route = unquote(urlsplit(self.path).path)
        file_path = PUBLIC_FILES.get(route)
        if route == "/downloads/framewave-studio-windows-x64-setup.exe":
            candidate = (DIST / "downloads" / "framewave-studio-windows-x64-setup.exe").resolve()
            if candidate.parent == (DIST / "downloads").resolve() and candidate.is_file():
                file_path = candidate
        if file_path is None and route.startswith("/assets/"):
            relative = Path(route.removeprefix("/"))
            candidate = (DIST / relative).resolve()
            if (
                relative.parent == Path("assets") and
                candidate.parent == (DIST / "assets").resolve() and
                candidate.suffix in {".js", ".css", ".wasm"} and
                candidate.is_file()
            ):
                file_path = candidate
        if file_path is None:
            self.send_error(404, "File not found")
            return

        try:
            content = file_path.read_bytes()
        except OSError as error:
            self.send_error(500, f"Could not read requested file: {error}")
            return

        content_type, _ = mimetypes.guess_type(file_path.name)
        if file_path.suffix == ".wasm":
            content_type = "application/wasm"
        if file_path.suffix == ".md":
            content_type = "text/markdown"
        self.send_response(200)
        content_type = content_type or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type = f"{content_type}; charset=utf-8"
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if send_body:
            self.wfile.write(content)

    def log_message(self, format, *args):
        print(f"{self.client_address[0]} - {format % args}")


if __name__ == "__main__":
    address = ("0.0.0.0", 8765)
    server = ThreadingHTTPServer(address, EditorHandler)
    print(f"Framewave Studio is available on port {address[1]} (Ctrl+C to stop).")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Framewave Studio.")
    finally:
        server.server_close()
