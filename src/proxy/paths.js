// ──────────────────────────────────────────────
// Where things live, in one place
// ──────────────────────────────────────────────
//
// The repository root (package.json, manifest.json, data/) is two levels up
// from src/proxy/. Every module that needs a path on disk asks here instead of
// counting '..' itself, so moving a file never silently points it elsewhere.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 审: 仓库根目录，status / plugin / shared-proxy / diag-report 都靠它定位 package.json、manifest.json；没了各处要自己数 '..'。
/** Repository root: package.json, manifest.json, data/. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 审: 运行时数据目录（统计、缓存、上下文固定文件），turn-capture / sdk-version / usage-stats 读写。
// 审: CLAUDE_SUBSCRIPTION_DATA_DIR 改数据目录（排查或自建部署用），保留。
/** Runtime data (stats, caches, debug dumps). Local only, never committed. */
export const DATA_DIR = process.env.CLAUDE_SUBSCRIPTION_DATA_DIR
    ? resolve(process.env.CLAUDE_SUBSCRIPTION_DATA_DIR) // Docker: a mounted volume outside the image
    : join(ROOT, 'data');
