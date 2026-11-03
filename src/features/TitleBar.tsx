// 应用菜单与会话标题。窗口控制由系统标题栏提供，不再显示没有功能的仿窗口按钮。

import type { MenuItem, OpenSession } from "../lib/ui-model";

export interface TitleBarProps {
  /** 菜单树（每次渲染重新生成：里面的 enabled/文案跟着 state 走） */
  buildMenus: () => { key: string; label: string; items: MenuItem[] }[];
  /** 当前展开着哪一级菜单（null = 全收起） */
  openMenu: string | null;
  setOpenMenu: (v: string | null) => void;
  /** 有可用更新时，「帮助」旁边亮一个小红点 */
  updateOffer: { version: string } | null;
  activeSession: OpenSession | null;
}

export function TitleBar(props: TitleBarProps) {
  const {
  buildMenus, openMenu, setOpenMenu, updateOffer, activeSession,
  } = props;
  return (
    <div className="titlebar">
      <div className="menus">
        {buildMenus().map((menu) => (
          <div key={menu.key} className="menu">
            <span
              className={"menu-label" + (openMenu === menu.key ? " open" : "")}
              onClick={() => setOpenMenu(openMenu === menu.key ? null : menu.key)}
            >
              {menu.label}
              {menu.key === "help" && updateOffer && <span className="menu-dot" />}
            </span>
            {openMenu === menu.key && (
              <div className="menu-drop">
                {menu.items.map((item, i) =>
                  item.sep ? (
                    <div key={"sep" + i} className="menu-sep" />
                  ) : (
                    <button
                      key={item.label}
                      type="button"
                      className="menu-item"
                      onClick={() => {
                        setOpenMenu(null);
                        item.action?.();
                      }}
                    >
                      {item.label}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="title">
        ZeeAI Term{activeSession ? " — " + activeSession.title : ""}
      </div>
    </div>

  );
}

