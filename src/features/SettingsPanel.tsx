// 设置对话框：左边分类、右边内容。
//
// 为什么这么拆：面板本身只负责"壳"（分类导航 + 关闭 + 把内容摆进 modal-body），
// 每个分类的正文是 SettingsTabs 里的小组件 —— 分类多、每类独立改，
// 挤在一个函数里迟早又变成第二个 App。
// 分类内容与顺序**完全照搬原来的条件渲染**（同一 tab 分两段的不合并：外观/终端各出现两处，
// 合并会改变 DOM 顺序，fe-smoke 就是按顺序找元素的）。

import { SETTINGS_TABS } from "../lib/app-consts";
import { SettingsAppTab, SettingsLogTab, SettingsLookFontTab, SettingsLookThemeTab, SettingsNotifyTab, SettingsTermHabitTab, SettingsTermShellTab, SettingsUpdateTab } from "./SettingsTabs";
import type { AppSettings } from "../types";

export interface SettingsPanelProps {
  /** 整份设置（App 里的 state，这里只读） */
  settings: AppSettings;
  /** 当前选中的分类（"look" / "log" / "term" / "app" / "notify" / "update"） */
  settingsTab: string;
  setSettingsTab: (key: string) => void;
  setShowSettings: (open: boolean) => void;
  /** 改一项设置：内部走"合并最新值 + 落盘"，不能在这里改成 setSettings */
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  /** 字号要立刻生效（还会顺带防抖落盘），不能只改 state */
  applyFontSize: (px: number) => void;
  pickLogDir: () => Promise<void>;
  openLogDir: () => Promise<void>;
  notify: (text: string) => void;
  setShowTermTheme: (open: boolean) => void;
  currentTermSchemeName: () => string;
  /** 「关于更新」那一段（版本号 / 一键升级 / 忽略此版本）留在 App 里，这里只负责摆位置 */
  renderUpdateSection: () => JSX.Element;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const {
  settings, settingsTab, setSettingsTab, setShowSettings, updateSettings, applyFontSize,
  pickLogDir, openLogDir, notify, setShowTermTheme, currentTermSchemeName, renderUpdateSection,
  } = props;
  return (
    <div className="modal-backdrop">
      {/* 点外面**不关**：设置要反复对照着改，误点一下全没了很难受；只认右上角 ✕ / 完成 */}
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          设置
          <button
            type="button"
            className="mini-x"
            style={{ float: "right", opacity: 1 }}
            title="关闭设置"
            onClick={() => setShowSettings(false)}
          >
            ✕
          </button>
        </div>
        <div className="settings-split">
          {/* 左边：分类。点一下右边就只显示这一类（像微信设置那样） */}
          <div className="settings-nav">
            {SETTINGS_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={"settings-nav-item" + (settingsTab === t.key ? " active" : "")}
                onClick={() => setSettingsTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="modal-body">
            {settingsTab === "look" && (
              <SettingsLookFontTab settings={settings} updateSettings={updateSettings} applyFontSize={applyFontSize} />
            )}
            {settingsTab === "log" && (
              <SettingsLogTab settings={settings} updateSettings={updateSettings} pickLogDir={pickLogDir} openLogDir={openLogDir} notify={notify} />
            )}
            {settingsTab === "term" && (
              <SettingsTermShellTab settings={settings} updateSettings={updateSettings} />
            )}
            {settingsTab === "look" && (
              <SettingsLookThemeTab settings={settings} updateSettings={updateSettings} setShowTermTheme={setShowTermTheme} currentTermSchemeName={currentTermSchemeName} />
            )}
            {settingsTab === "app" && (
              <SettingsAppTab settings={settings} updateSettings={updateSettings} />
            )}
            {settingsTab === "notify" && (
              <SettingsNotifyTab settings={settings} updateSettings={updateSettings} />
            )}
            {settingsTab === "term" && (
              <SettingsTermHabitTab settings={settings} updateSettings={updateSettings} />
            )}
            {settingsTab === "update" && <SettingsUpdateTab renderUpdateSection={renderUpdateSection} />}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn primary" onClick={() => setShowSettings(false)}>
            完成
          </button>
        </div>
      </div>
    </div>

  );
}
