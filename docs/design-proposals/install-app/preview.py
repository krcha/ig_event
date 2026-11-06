"""Serve only the local review artifact; never serve repository or planning files."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
FILES = {"index.html", "install.html", "styles.css", "demo.js"}


class PreviewHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_head(self):
        relative = unquote(urlsplit(self.path).path).lstrip("/") or "index.html"
        target = (ROOT / relative).resolve()
        allowed = relative in FILES or relative.startswith(("assets/", "screenshots/"))
        if not allowed or not target.is_relative_to(ROOT) or not target.is_file():
            self.send_error(404)
            return None
        return super().send_head()


if __name__ == "__main__":
    print("Local design preview: http://127.0.0.1:4178/index.html", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 4178), PreviewHandler).serve_forever()
