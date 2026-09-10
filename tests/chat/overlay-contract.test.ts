import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

test("modal overlays: 业务弹窗统一使用 ModalShell", () => {
  for (const path of [
    "app/components/settings/SettingsPanel.tsx",
    "app/components/ui/ConfirmDialog.tsx",
    "app/components/ui/AlertDialog.tsx",
    "app/components/knowledge/KnowledgeView.tsx",
    "app/components/chat/Composer.tsx",
  ]) {
    assert.match(read(path), /ModalShell/, `${path} 未使用 ModalShell`);
  }

  const appSources = [
    read("app/components/settings/SettingsPanel.tsx"),
    read("app/components/ui/ConfirmDialog.tsx"),
    read("app/components/ui/AlertDialog.tsx"),
    read("app/components/knowledge/KnowledgeView.tsx"),
    read("app/components/chat/Composer.tsx"),
  ].join("\n");
  assert.doesNotMatch(
    appSources,
    /className="(?:modal-backdrop|knowledge-import-backdrop|composer-params-help-backdrop)/,
  );
});

test("overlay layers: 使用层级 token，modal 高于 sticky topbar", () => {
  const css = read("app/globals.css");
  assert.match(css, /--z-sticky:\s*20/);
  assert.match(css, /--z-modal:\s*100/);
  assert.match(css, /--z-flyout:\s*110/);
  assert.match(css, /--z-alert:\s*120/);
  assert.match(css, /\.topbar\s*\{[^}]*z-index:\s*var\(--z-sticky\)/s);
  assert.match(
    css,
    /\.overlay-backdrop--modal\s*\{[^}]*z-index:\s*var\(--z-modal\)/s,
  );
  assert.match(
    css,
    /\.knowledge-jobs-popover\s*\{[^}]*z-index:\s*var\(--z-flyout\)/s,
  );
});

test("处理中心下拉：Portal 到 overlay-root，避免被 modal 挡住", () => {
  const source = read("app/components/knowledge/KnowledgeJobsPanel.tsx");
  assert.match(source, /createPortal/);
  assert.match(source, /overlay-root/);
});

test("处理队列弹窗：进行中/最近完成用 tab，只留一块滚动区", () => {
  const source = read("app/components/knowledge/KnowledgeJobsPanel.tsx");
  const css = read("app/globals.css");
  assert.match(source, /role="tablist"/);
  assert.match(source, /knowledge-jobs-tab-recent/);
  assert.match(source, /id="knowledge-jobs-panel-body"/);
  assert.match(
    css,
    /\.knowledge-jobs-popover\s*\{[^}]*overflow:\s*hidden/s,
  );
  assert.match(
    css,
    /\.knowledge-jobs-body\s*\{[^}]*overflow:\s*auto/s,
  );
  assert.doesNotMatch(
    css,
    /\.knowledge-jobs-list\s*\{[^}]*max-height:\s*240px/s,
  );
});
