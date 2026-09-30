#!/usr/bin/env python3
"""把 installer/CCST安装.command 打成 installer/CCST-mac.zip（里面的文件带可执行权限）。

为什么要打包：浏览器下载的 .command 文件没有「可执行」权限，双击会报权限不够；
zip 里的权限位在 macOS 解压时会保留，解压出来的 .command 双击就能运行。
改了 .command 之后运行一次：python3 scripts/build-installer-zip.py（test/installer.test.js 会检查两者一致）。
"""
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent / "installer"
src = root / "CCST安装.command"
info = zipfile.ZipInfo(src.name, date_time=(2020, 1, 1, 0, 0, 0))  # 固定时间，重复打包结果一样
info.external_attr = (0o100755 << 16)
info.compress_type = zipfile.ZIP_DEFLATED
with zipfile.ZipFile(root / "CCST-mac.zip", "w") as z:
    z.writestr(info, src.read_bytes())
print("wrote", root / "CCST-mac.zip")
