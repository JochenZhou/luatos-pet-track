from pathlib import Path

root = Path(__file__).parent
java = (root / "android/app/src/main/java/com/jochen/luatos_pet_track/MainActivity.java").read_text()
layout = (root / "android/app/src/main/res/layout/activity_main.xml").read_text()

checks = {
    "原生悬浮按钮已移除": 'btn_menu' not in layout and 'findViewById(R.id.btn_menu)' not in java,
    "顶栏注入菜单按钮": "android-app-menu" in java and "querySelector('.topbar')" in java,
    "菜单按钮调用原生抽屉": "public void openDrawer()" in java and "drawer.openDrawer(Gravity.START)" in java,
    "不再给标题增加旧左边距": "paddingLeft='62'" not in java,
    "菜单按钮可访问": "aria-label" in java and "打开菜单" in java,
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + " - " + name)
if failed:
    raise SystemExit("\n未满足: " + "、".join(failed))
print(f"\n全部通过: {len(checks)}/{len(checks)}")
