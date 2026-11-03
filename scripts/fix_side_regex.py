from pathlib import Path

p = Path("app/api/telegram/route.ts")
s = p.read_text()

old = '''  const pair = (a: string, b: string) =>\n    new RegExp(`(?:${a})\\\\w*[^а-яёa-z0-9]{0,8}(?:${b})\\\\w*|(?:${b})\\\\w*[^а-яёa-z0-9]{0,8}(?:${a})\\\\w*`, "i").test(text);\n'''
new = '''  const pair = (a: string, b: string) =>\n    new RegExp(`(?:${a})[а-яё]*[^а-яёa-z0-9]{0,8}(?:${b})[а-яё]*|(?:${b})[а-яё]*[^а-яёa-z0-9]{0,8}(?:${a})[а-яё]*`, "i").test(text);\n'''

if s.count(old) != 1:
    raise SystemExit(f"side regex anchor count: {s.count(old)}")

s = s.replace(old, new, 1)
p.write_text(s)
print("OK: Russian side parsing fixed")
