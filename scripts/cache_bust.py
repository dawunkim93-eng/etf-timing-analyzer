"""정적 파일 캐시 무효화.

`index.html` 이 `app.js?v=1` 처럼 고정 버전 문자열을 쓰면 브라우저가
영구 캐시한다. 그래서 app.js 를 고쳐도 사용자는 옛 버전을 계속 본다
(실제로 이 프로젝트에서 그랬다).

고정 문자열 대신 **내용 해시**를 넣는다. 파일이 바뀌면 쿼리가 바뀌고
브라우저가 새로 받는다. 파일이 안 바뀌면 URL 이 같아서 캐시를 쓴다.

用法:
    python scripts/cache_bust.py
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "index.html"
TARGETS = ["app.js", "styles.css"]


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:8]


def main() -> None:
    html = HTML.read_text(encoding="utf-8")
    original = html

    for name in TARGETS:
        path = ROOT / name
        if not path.exists():
            print(f"  ! {name} 없음 — 건너뜀")
            continue
        h = file_hash(path)
        # src="app.js?v=..." 또는 href="styles.css?v=..." 를 새 해시로
        pattern = re.compile(
            rf'((?:src|href)="{re.escape(name)})(?:\?v=[^"]*)?(")'
        )
        html, n = pattern.subn(rf"\1?v={h}\2", html)
        print(f"  {name} → v={h} ({n}곳)")

    if html != original:
        HTML.write_text(html, encoding="utf-8")
        print("  index.html 갱신")
    else:
        print("  변화 없음")


if __name__ == "__main__":
    main()
