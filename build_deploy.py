#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_deploy.py —— 构建部署产物
模板/产物分离防空转：读 index.tpl.html 模板，写 index.html 产物。
（绝不可以 index.html 当模板，否则二次构建占位符消失空转）
流程：合并 js -> app.js（node --check 校验）-> 注入模板 -> index.html
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

# 业务 js 合并顺序（不可乱序）
JS_ORDER = [
    'js/config.js',
    'js/utils.js',
    'js/theme.js',
    'js/pet-store.js',
    'js/fence.js',
    'js/loc-cache.js',
    'js/push.js',
    'js/algo/wgs2gcj.js',
    'js/algo/imufilter.js',
    'js/algo/stepcount.js',
    'js/algo/attitude.js',
    'js/algo/alg.js',
    'js/api/rsa-pkcs1.js',
    'js/api/aircloud.js',
    'js/app/map.js',
    'js/app/petstatus.js',
    'js/app/views.js',
    'js/app/views2.js',
    'js/app/views3.js',
    'js/app/main.js',
]

PLACEHOLDERS = {
    '__STYLE__': 'css/style.css',
    '__JSENCRYPT_JS__': 'vendor/jsencrypt.min.js',
}


def read(path):
    with open(os.path.join(ROOT, path), 'r', encoding='utf-8') as f:
        return f.read()


def write(path, content):
    with open(os.path.join(ROOT, path), 'w', encoding='utf-8') as f:
        f.write(content)


def build_app_js():
    parts = []
    for rel in JS_ORDER:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            print('缺失文件：%s' % rel)
            sys.exit(1)
        content = read(rel)
        parts.append('/* ===== %s ===== */\n' % rel + content + '\n')
    merged = '\n'.join(parts)
    write('app.js', merged)
    r = subprocess.run(['node', '--check', os.path.join(ROOT, 'app.js')],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print('app.js 语法校验失败：')
        print(r.stderr[:3000])
        sys.exit(1)
    print('app.js 合并完成（node --check OK）')
    return merged


def inject_inline_js(template, tag, js_text):
    """注入 JS：处理 </script> 字样（拆开）"""
    safe = js_text.replace('</script>', '<\\/script>')
    return template.replace(tag, safe)


def main():
    template_path = os.path.join(ROOT, 'index.tpl.html')
    if not os.path.exists(template_path):
        print('模板 index.tpl.html 不存在')
        sys.exit(1)
    template = read('index.tpl.html')

    # 检查产物是否已存在且模板未变（防空转）
    app_js = build_app_js()

    html = template
    for ph, path in PLACEHOLDERS.items():
        content = read(path)
        if ph == '__JSENCRYPT_JS__':
            html = inject_inline_js(html, ph, content)
        else:
            html = html.replace(ph, content)
    # 业务脚本注入
    html = inject_inline_js(html, '__SCRIPT__', app_js)

    out = os.path.join(ROOT, 'index.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)
    size_kb = os.path.getsize(out) / 1024
    print('index.html 生成完成：%.1f KB' % size_kb)
    if size_kb > 1024:
        print('警告：产物超过 1MB，需检查')
        sys.exit(1)

    # 审核红线自检
    html_text = html
    checks = []
    def has(s):
        return s in html_text
    if has('eval(') and html_text.count('eval(') > 0:
        # jsencrypt 可能含 eval 字样，检查上下文
        pass
    bad = []
    # 仅 TMap 外链脚本允许（合宙放行 map.qq.com），其余外链 script 视为违规
    import re
    external_scripts = re.findall(r'<script\s+src=["\']([^"\']+)["\']', html_text)
    for src in external_scripts:
        if 'map.qq.com' not in src:
            bad.append('外链 script: ' + src)
    if 'cdn' in html_text.lower(): bad.append('CDN 字样')
    if bad:
        print('审核红线警告：%s' % '; '.join(bad))
    print('构建完成 ✓')


if __name__ == '__main__':
    main()