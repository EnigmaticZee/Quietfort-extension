#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
#
# Builds site/privacy.html from docs/PRIVACY.md (so the two never differ).
# Run from the repository root: python3 scripts/build-site.py
import html, re, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
md = (root / 'docs' / 'PRIVACY.md').read_text()

def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r'`([^`]+)`', r'<code>\1</code>', t)
    t = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', t)
    t = re.sub(r'(https://[^\s<),]+[^\s<).,])', r'<a href="\1">\1</a>', t)
    return t

out, lines, i = [], md.splitlines(), 0
while i < len(lines):
    l = lines[i]
    if not l.strip(): i += 1; continue
    if l.startswith('# '): out.append(f'<h1>{inline(l[2:])}</h1>')
    elif l.startswith('## '): out.append(f'<h2>{inline(l[3:])}</h2>')
    elif l.startswith('- '):
        items = []
        while i < len(lines) and lines[i].startswith('- '): items.append(f'<li>{inline(lines[i][2:])}</li>'); i += 1
        out.append('<ul>' + ''.join(items) + '</ul>'); continue
    elif l.startswith('|'):
        rows = []
        while i < len(lines) and lines[i].startswith('|'): rows.append(lines[i]); i += 1
        cells = lambda r: [c.strip() for c in r.strip().strip('|').split('|')]
        head = ''.join(f'<th>{inline(c)}</th>' for c in cells(rows[0]))
        body = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in cells(r)) + '</tr>' for r in rows[2:])
        out.append(f'<div class="table"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'); continue
    else:
        para = []
        while i < len(lines) and lines[i].strip() and not lines[i].startswith(('#', '- ', '|')): para.append(lines[i]); i += 1
        out.append(f'<p>{inline(" ".join(para))}</p>'); continue
    i += 1

page = f'''<!doctype html>
<!-- Generated from docs/PRIVACY.md by scripts/build-site.py. Do not edit. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Privacy policy · Quietfort</title><meta name="color-scheme" content="light dark"><link rel="icon" type="image/png" href="assets/icon-32.png">
<style>
:root {{ --bg:#f5f6f4; --card:#fff; --fg:#12201f; --muted:#5b6866; --line:#dfe4e1; --accent:#0d6c60; --code:#ecefec; color-scheme: light; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#0b1d20; --card:#12292d; --fg:#e8f1ef; --muted:#9db1ad; --line:#22403f; --accent:#6fdcca; --code:#0f262a; color-scheme: dark; }} }}
* {{ box-sizing: border-box; }}
body {{ margin:0; background:var(--bg); color:var(--fg); font:17px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,sans-serif; -webkit-font-smoothing:antialiased; }}
main {{ max-width: 780px; margin: 0 auto; padding: 32px max(20px, env(safe-area-inset-right)) 80px max(20px, env(safe-area-inset-left)); }}
.back {{ display:inline-flex; align-items:center; gap:10px; color:var(--fg); text-decoration:none; font-weight:700; margin-bottom:32px; }}
.mark {{ width:30px; height:30px; border-radius:9px; display:grid; place-items:center; background:linear-gradient(160deg,#169383,#0b3c45); }}
.mark svg {{ width:15px; height:18px; }}
h1 {{ font-size: clamp(34px,5vw,48px); letter-spacing:-.02em; line-height:1.1; margin:0 0 8px; }}
h2 {{ font-size: 24px; letter-spacing:-.01em; margin: 40px 0 10px; }}
p, li {{ color: var(--fg); }} p {{ margin: 0 0 14px; }} ul {{ padding-left: 22px; margin: 0 0 14px; }} li + li {{ margin-top: 6px; }}
a {{ color: var(--accent); overflow-wrap: anywhere; }}
code {{ font: .88em ui-monospace,SFMono-Regular,Menlo,monospace; background: var(--code); padding: 1px 6px; border-radius: 6px; }}
.table {{ overflow-x: auto; margin: 8px 0 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); }}
table {{ border-collapse: collapse; width: 100%; font-size: 15px; min-width: 560px; }}
th, td {{ text-align: left; vertical-align: top; padding: 12px 14px; border-bottom: 1px solid var(--line); }}
th {{ font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }}
tr:last-child td {{ border-bottom: 0; }}
</style></head><body><main>
<a class="back" href="./"><span class="mark" aria-hidden="true"><svg viewBox="26 24 48 56"><path d="M28 26h8v5h6v-5h16v5h6v-5h8v23c0 15-9.5 24.5-22 29.5C37.5 73.5 28 64 28 49z" fill="#fff"/><rect x="38" y="47" width="24" height="7" rx="3.5" fill="#0B3C45"/></svg></span>Quietfort</a>
{chr(10).join(out)}
</main></body></html>
'''
(root / 'site' / 'privacy.html').write_text(page)
print('wrote site/privacy.html')
