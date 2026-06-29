#!/bin/bash
# ExamAware post-install / post-remove script for .deb
# 注册 / 更新 / 清理 MIME 类型 application/x-examaware-ea2 / application/x-examaware-json

set -e

case "$1" in
  configure)
    # 安装 XML 到 /usr/share/mime/packages 并刷新数据库
    if [ -f /usr/share/mime/packages/examaware.xml ]; then
      if command -v update-mime-database >/dev/null 2>&1; then
        update-mime-database /usr/share/mime || true
      fi
    fi
    # 刷新桌面图标缓存（MIME 关联所依赖）
    if command -v update-desktop-database >/dev/null 2>&1; then
      update-desktop-database -q /usr/share/applications || true
    fi
    ;;
  remove|purge)
    # 清理 MIME：deb 卸载时会自动移除 /usr/share/mime/packages/examaware.xml
    if command -v update-mime-database >/dev/null 2>&1; then
      update-mime-database /usr/share/mime || true
    fi
    ;;
esac

exit 0
