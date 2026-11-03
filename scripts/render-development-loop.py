#!/usr/bin/env python3
"""README 의 Mermaid 원본에서 손그림 SVG 를 다시 만든다.

의존성: @mermaid-js/mermaid-cli 12.2.0 (mmdc), 해당 CLI 가 지원하는 Chrome.
예: python3 scripts/render-development-loop.py --mmdc /path/to/mmdc
컨테이너의 브라우저 설정은 --puppeteer-config 로 별도 전달한다.
--preview /tmp/loop.png 는 시각 검토용 PNG 도 만든다. 원본은 README 한곳에만 둔다.
"""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mmdc', default='mmdc')
    parser.add_argument('--puppeteer-config', type=Path)
    parser.add_argument('--preview', type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source = re.search(r'^```mermaid\n(.*?)\n```', (root / 'README.md').read_text(), re.M | re.S)
    if source is None:
        parser.error('README 에 Mermaid 원본이 없다')
    output = root / 'docs/images/development-loop.svg'
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        diagram = Path(tmp) / 'development-loop.mmd'
        diagram.write_text(source[1] + '\n')
        common = [args.mmdc, '-i', str(diagram), '-c', str(root / 'docs/diagrams/development-loop.config.json'),
                  '-b', 'white', '--size', '1400']
        if args.puppeteer_config:
            common += ['-p', str(args.puppeteer_config.resolve())]
        subprocess.run(common + ['-o', str(output)], check=True, timeout=90)
        if args.preview:
            subprocess.run(common + ['-o', str(args.preview.resolve())], check=True, timeout=90)
    print(output.relative_to(root))


if __name__ == '__main__':
    main()
