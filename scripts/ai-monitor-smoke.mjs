// Production monitor scenarios. Run with: node scripts/ai-monitor-smoke.mjs
// Uses the built frontend, a disposable headless browser and synthetic IPC only.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function runAiMonitorSmoke({ send, evaluate, reload, check, shot, sleep }) {
  console.log("\n--- Production AI monitor: raw terminal protocol and scoped herdr events ---");
  const monitorScript = await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__ZEEAI_TEST_AI_PANEL__ = false;
    Object.assign(window.__ZEEAI_SCENARIO__, {
      restoreHerdr: false, herdrHistory: false, openSshFail: false,
      herdrProbeFail: false, herdrProbePending: false, herdrNotInstalled: false,
      settingsPatch: { theme: "dark", restoreWorkspace: true, autoReconnect: false,
        aiMonitorEnabled: true, aiNotifyNeedsYou: true, aiNotifyComplete: true,
        aiNotifyTaskbar: true, aiNotifyNeedsYouBadge: true, aiNotifyFinishedBadge: true }
    });
    const monitorProfile = window.__ZEEAI_MOCK__.profiles.find((p) => p.ssh);
    window.__ZEEAI_SESSION__ = { version: 1, savedAt: Date.now(), activeIndex: 0, sessions: [
      { kind: "remote", title: "monitor-native", profileId: monitorProfile.id, user: "alice", tmuxMode: "none" },
      { kind: "remote", title: "monitor-tmux", profileId: monitorProfile.id, user: "alice", tmuxMode: "name", tmuxName: "monitor-tmux" },
      { kind: "remote", title: "monitor-herdr-control", profileId: monitorProfile.id, user: "alice", tmuxMode: "name", herdrPane: "wMON:p1", herdrMode: "control" },
      { kind: "remote", title: "monitor-herdr-observe", profileId: monitorProfile.id, user: "alice", tmuxMode: "name", herdrPane: "wMON:p2", herdrMode: "observe" },
      { kind: "zsh", shell: "zsh", title: "monitor-local" }
    ] };
    document.hasFocus = () => false;
  ` });
  await reload();
  await sleep(600);
  const ids = await evaluate(`(() => {
    const opens = window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "open_ssh").map((c) => c.args);
    return {
      native: opens.find((a) => !String(a.backend).startsWith("herdr") && a.tmuxName !== "monitor-tmux")?.id,
      tmux: opens.find((a) => a.tmuxName === "monitor-tmux")?.id,
      control: opens.find((a) => a.backend === "herdr-control")?.id,
      observe: opens.find((a) => a.backend === "herdr-pane")?.id,
      local: window.__ZEEAI_CALLARGS__.find((c) => c.cmd === "open_local")?.args.id,
    };
  })()`);
  check("AI 监控：恢复合成 SSH、tmux、herdr 控制/只读和本地会话", Object.values(ids).filter(Boolean).length === 5, JSON.stringify(ids));
  if (!ids.native || !ids.tmux || !ids.control || !ids.observe) throw new Error("AI monitor synthetic sessions did not restore");

  // open_ssh's mock returns metadata only. Deliver the same Channel state event
  // as the real SSH backend; a returned SessionInfo alone is not a connection.
  await evaluate(`(() => {
    Object.values(${JSON.stringify(ids)}).filter(Boolean).forEach((id) =>
      window.__ZEEAI_TERM_EVENT__(id, {type:'state', state:'connected'}));
    window.__ZEEAI_TERM_DATA__(${JSON.stringify(ids.native)}, ${JSON.stringify("\x1b]7501;state=working:app=codex\x07")});
  })()`);
  await sleep(180);

  const q = JSON.stringify;
  const ESC = "\x1b", BEL = "\x07", ST = ESC + "\\";
  const osc = (body, end = ST) => `${ESC}]7501;${body}${end}`;
  const b64 = (text) => Buffer.from(text).toString("base64");
  const feed = async (id, text) => { await evaluate(`window.__ZEEAI_TERM_DATA__(${q(id)}, ${q(text)})`); await sleep(90); };
  const emit = async (payload) => { await evaluate(`window.__ZEEAI_EMIT__("zeeai://ai-monitor-herdr", ${q({ sessionIds: [], atMs: Date.now(), agents: [], error: null, ...payload })})`); await sleep(120); };
  const countWrites = () => evaluate(`window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "session_write").length`);
  const writesSince = (mark) => evaluate(`window.__ZEEAI_CALLARGS__.filter((c) => c.cmd === "session_write").slice(${mark}).map((c) => ({id:c.args.id, text: new TextDecoder().decode(Uint8Array.from(atob(c.args.dataB64 || ""), (x) => x.charCodeAt(0)))}))`);
  const readScope = () => evaluate(`window.__ZEEAI_MONITOR_SCOPE__`);
  const badge = () => evaluate(`document.querySelector('.activitybar .act[title*="AI"] .act-badge')?.textContent || ""`);
  const notices = () => evaluate(`window.__ZEEAI_CALLARGS__.filter((c) => c.cmd.includes("request_user_attention")).length`);
  const panelOpen = async (open = true) => {
    await evaluate(`(() => { if (!!document.querySelector('.ai-monitor') !== ${open}) document.querySelector('.activitybar .act[title*="AI"]')?.click(); })()`);
    await sleep(130);
  };
  const card = (id) => evaluate(`(() => {
    const e = document.querySelector('.ai-monitor-card[data-session-id="${id}"]');
    return e ? { text:e.textContent, state:e.querySelector('.ai-monitor-state')?.textContent, classes:e.className,
      count:document.querySelectorAll('.ai-monitor-card[data-session-id="${id}"]').length,
      section:e.closest('section')?.getAttribute('aria-label'), fold:e.closest('details')?.querySelector('summary')?.textContent,
      progress:e.querySelector('progress')?.value, scripts:e.querySelectorAll('script').length } : null;
  })()`);
  const state = async (id, expected) => (await card(id))?.state === expected;

  await panelOpen();
  const panel = await evaluate(`(() => { const e=document.querySelector('.ai-monitor'); return { native:!!e, old:!!document.querySelector('.ai-task'), text:e?.textContent, width:e?.getBoundingClientRect().width }; })()`);
  check("AI 监控：星号打开生产面板、说明来源，legacy 看板未挂载", panel.native && !panel.old && panel.text.includes("状态来自 CLI 或 herdr") && panel.width > 250, JSON.stringify(panel));
  const scope = await readScope();
  check("AI 监控：后端只观察当前两个 herdr 窗格", scope?.enabled && scope.sessionIds.length === 2 && [ids.control, ids.observe].every((id) => scope.sessionIds.includes(id)), JSON.stringify(scope));
  check("AI 监控：connected 与首帧状态同批到达时不会丢失状态", await state(ids.native, "正在运行"));
  await feed(ids.native, osc("state=clear"));
  check("AI 监控：tmux 未报告时提示协议限制、没有猜成运行或完成", await state(ids.tmux, "状态待确认") && (await card(ids.tmux)).text.includes("tmux 的协议支持取决于版本"));

  const viewport = await evaluate(`({width:innerWidth,height:innerHeight})`);
  await evaluate(`document.querySelector('.session-tab[data-tab-id="${ids.observe}"]')?.click()`);
  await sleep(250);
  const resizeMark = await evaluate(`window.__ZEEAI_CALLARGS__.length`);
  await send("Emulation.setDeviceMetricsOverride", { width: viewport.width - 120, height: viewport.height - 80, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const resizeCalls = await evaluate(`window.__ZEEAI_CALLARGS__.slice(${resizeMark}).map((c)=>({cmd:c.cmd,args:c.args}))`);
  const resizeIndex = resizeCalls.findIndex((c) => c.cmd === "herdr_pane_resize" && c.args.id === ids.observe);
  check("AI 监控：观察流 resize 完成后重新提交当前 scope", resizeIndex >= 0 && resizeCalls.slice(resizeIndex + 1).some((c) => c.cmd === "ai_monitor_sessions_set" && c.args.sessionIds.includes(ids.observe)), JSON.stringify(resizeCalls.map((c) => c.cmd)));
  await send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.querySelector('.session-tab[data-tab-id="${ids.native}"]')?.click()`);
  await sleep(200);

  let mark = await countWrites();
  await feed(ids.native, `${ESC}]7501;?`);
  check("AI 监控：分片查询未结束前不回写", await countWrites() === mark);
  await feed(ids.native, BEL + `${ESC}[c`);
  let writes = await writesSince(mark);
  check("AI 监控：BEL 查询原样终止回包，先于 xterm DA1 回复", writes[0]?.id === ids.native && writes[0]?.text === osc("?", BEL), JSON.stringify(writes));
  mark = await countWrites();
  await feed(ids.native, osc("?", ST));
  writes = await writesSince(mark);
  check("AI 监控：ST 查询回包使用 ST 终止符", writes.length === 1 && writes[0].text === osc("?", ST), JSON.stringify(writes));
  mark = await countWrites();
  await feed(ids.control, osc("?", BEL));
  await feed(ids.observe, osc("?", ST));
  if (ids.local) await feed(ids.local, osc("?", BEL) + osc("state=working:app=codex"));
  check("AI 监控：herdr 控制/只读与本地会话不回写能力查询", await countWrites() === mark);

  const message = "正在分析 🚀 <script>window.BAD=true</script>";
  await feed(ids.native, osc(`state=working:app=codex:progress=42:msg=${b64(message)}`));
  let current = await card(ids.native);
  check("AI 监控：原始 PTY 状态进入运行区，显示进度与纯文本消息", current?.state === "正在运行" && current.section === "运行中" && current.progress === 42 && current.text.includes(message) && current.scripts === 0, JSON.stringify(current));
  await emit({ sessionIds: [ids.native, "not-open"], agents: [{ paneId: "wMON:p1", kind: "claude", status: "blocked" }] });
  check("AI 监控：herdr 快照不能覆盖普通 SSH 的原生状态或创建外部会话", await state(ids.native, "正在运行") && await evaluate(`document.querySelectorAll('.ai-monitor-card').length`) === 4);
  await feed(ids.tmux, `${ESC}Ptmux;${osc("state=working:app=claude-code").replaceAll(ESC, ESC + ESC)}${ST}`);
  check("AI 监控：有效 tmux passthrough 能更新已打开会话", await state(ids.tmux, "正在运行"));

  await panelOpen(false);
  const childBlocked = osc(`state=blocked:app=codex:id=agent/2:kind=permission:msg=${b64("Approve deploy?")}`);
  await feed(ids.native, childBlocked);
  const noticeCount = await notices();
  await feed(ids.native, childBlocked);
  check("AI 监控：重复 blocked 不叠加徽标或通知", await badge() === "1" && await notices() === noticeCount, `badge=${await badge()} attention=${noticeCount}→${await notices()}`);
  await panelOpen();
  current = await card(ids.native);
  check("AI 监控：子任务 blocked 优先于运行中的根、每会话只有一张卡", current?.state === "等待批准" && current.section === "需要你" && current.count === 1 && current.text.includes("Approve deploy?"), JSON.stringify(current));
  check("AI 监控：打开面板仍保留 blocked 徽标", await badge() === "1");
  await feed(ids.native, osc("state=blocked:app=codex:id=agent/2:kind=question"));
  check("AI 监控：需要回答有明确状态", await state(ids.native, "等待回答"));
  await feed(ids.native, osc("state=blocked:app=codex:id=agent/2:kind=auth"));
  check("AI 监控：需要登录有明确状态", await state(ids.native, "等待登录"));
  await feed(ids.native, osc("state=clear:id=agent/2"));
  check("AI 监控：清除 child 后回到根的运行状态并消除待处理徽标", await state(ids.native, "正在运行") && await badge() === "");
  await feed(ids.native, osc("state=error:app=codex"));
  check("AI 监控：错误进入需要你区，没有映射为完成", await state(ids.native, "运行出错") && (await card(ids.native))?.section === "需要你");
  await feed(ids.native, osc("state=clear"));
  await feed(ids.tmux, osc("state=clear"));

  await panelOpen(false);
  await feed(ids.native, osc("state=working:app=claude-code"));
  await feed(ids.native, "ordinary terminal output: done, 100%, approve?\r\n");
  check("AI 监控：面板收起时仍观察，不根据普通输出猜测完成", await badge() === "");
  await feed(ids.native, osc("state=done:app=claude-code"));
  check("AI 监控：本轮 working→done 产生一次未读徽标", await badge() === "1");
  await feed(ids.native, osc("state=done:app=claude-code"));
  check("AI 监控：重复完成没有重复未读", await badge() === "1");
  await panelOpen();
  current = await card(ids.native);
  check("AI 监控：打开清完成未读，完成卡仍留在最近完成折叠区", await badge() === "" && current?.state === "本轮已完成" && current.fold.includes("最近完成"), JSON.stringify(current));
  await evaluate(`(() => { const card=document.querySelector('.ai-monitor-card[data-session-id="${ids.native}"]'); if(card?.closest('details')) card.closest('details').open=true; })()`);
  await shot("monitor-native-done.png");
  await feed(ids.native, `${ESC}]133;A${BEL}`);
  check("AI 监控：新 shell prompt 不抹去已完成状态", await state(ids.native, "本轮已完成"));
  await feed(ids.native, `${ESC}c`);
  check("AI 监控：完整终端复位清除记录", await state(ids.native, "状态待确认"));

  await emit({ sessionIds: [ids.control, ids.observe], agents: [
    { paneId: "wMON:p1", kind: "codex", status: "working" },
    { paneId: "wMON:p2", kind: "claude", status: "blocked" },
    { paneId: "wOTHER:p1", kind: "codex", status: "blocked" },
  ] });
  check("AI 监控：herdr 快照按已打开 pane 匹配，控制与只读各一张卡", await state(ids.control, "正在运行") && await state(ids.observe, "等待你处理") && (await card(ids.observe)).text.includes("只读观察") && await evaluate(`document.querySelectorAll('.ai-monitor-card').length`) === 4);
  await shot("monitor-active-dark.png");
  await emit({ sessionIds: [ids.observe], agents: [], error: "mock: herdr temporarily unavailable" });
  check("AI 监控：herdr 读取失败降为待确认，不假完成", await state(ids.observe, "状态待确认") && (await card(ids.observe)).text.includes("temporarily unavailable"));
  await emit({ sessionIds: [ids.observe], agents: [{ paneId: "wMON:p2", kind: "claude", status: "working" }] });
  check("AI 监控：下一次 herdr 有效快照恢复实时状态", await state(ids.observe, "正在运行"));
  await emit({ sessionIds: [ids.observe], agents: [{ paneId: "wMON:p2", kind: "other-agent", status: "blocked" }] });
  check("AI 监控：未知 agent 不冒充 Claude/Codex", await state(ids.observe, "状态待确认"));

  await evaluate(`document.querySelector('.ai-monitor .ai-head button[aria-expanded]')?.click()`);
  await sleep(100);
  check("AI 监控：面板设置说明收起继续、关会话停止，提供四个开关", await evaluate(`(() => {const e=document.querySelector('.ai-monitor-options'); return e?.querySelectorAll('input[type=checkbox]').length===4 && e.textContent.includes('收起面板会继续观察') && e.textContent.includes('关闭会话');})()`));
  await evaluate(`document.querySelector('.ai-monitor-options input')?.click()`);
  await sleep(150);
  let paused = await readScope();
  check("AI 监控：暂停立即提交空 scope，面板保留启用入口", paused?.enabled === false && paused.sessionIds.length === 0 && await evaluate(`document.querySelector('.ai-monitor')?.textContent.includes('启用观察')`), JSON.stringify(paused));
  await feed(ids.native, osc("state=blocked:app=codex:kind=permission"));
  check("AI 监控：暂停期间不积累状态和徽标", await badge() === "" && await evaluate(`document.querySelectorAll('.ai-monitor-card').length`) === 0);
  await evaluate(`[...document.querySelectorAll('.ai-monitor button')].find((e)=>e.textContent==='启用观察')?.click()`);
  await sleep(160);
  check("AI 监控：恢复只提交当前 herdr scope，旧报告不重放", (await readScope())?.enabled && (await readScope()).sessionIds.length === 2 && await state(ids.native, "状态待确认"));

  await feed(ids.native, osc("state=working:app=codex"));
  await panelOpen(false);
  const beforeDisconnectNotices = await notices();
  await evaluate(`window.__ZEEAI_TERM_EVENT__(${q(ids.native)}, {type:'state', state:'closed'})`);
  await sleep(180);
  check("AI 监控：断线不产生完成未读或完成提醒", await badge() === "" && await notices() === beforeDisconnectNotices);
  await panelOpen();
  check("AI 监控：断线卡显示状态待确认和连接已断开", await state(ids.native, "状态待确认") && (await card(ids.native)).text.includes("连接已断开"));
  await evaluate(`document.querySelector('.session-tab[data-tab-id="${ids.observe}"] .tab-x:last-child')?.click()`);
  await sleep(180);
  const closedScope = await readScope();
  check("AI 监控：关闭只读窗格即从后台观察 scope 移除", closedScope?.sessionIds.length === 1 && closedScope.sessionIds[0] === ids.control && !(await card(ids.observe)), JSON.stringify(closedScope));
  await emit({ sessionIds: [ids.observe, "external-session"], agents: [{ paneId: "wMON:p2", kind: "claude", status: "blocked" }] });
  check("AI 监控：已关闭/外部窗格的旧事件不能重建卡片或徽标", !(await card(ids.observe)) && await badge() === "");
  await shot("monitor-scoped-dark.png");

  const forbidden = await evaluate(`window.__ZEEAI_CALLARGS__.filter((c)=>[
    'ai_probe','ai_source_probe','ai_tasks_remote','ai_tasks_local','ai_instances',
    'ai_session_snapshot','ai_task_artifacts','ai_timeline_list',
    'herdr_agents','herdr_server_status','herdr_workspace_scan'
  ].includes(c.cmd)).map((c)=>c.cmd)`);
  check("AI 监控：整个生产路径没有调用本机扫描、全服务器探测或旧看板刷新", forbidden.length === 0, JSON.stringify(forbidden));

  const lightScript = await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__ZEEAI_SCENARIO__.settingsPatch.theme='light';` });
  await reload();
  await panelOpen();
  check("AI 监控：浅色主题也打开正常监控面板和当前会话", await evaluate(`document.querySelector('.app')?.classList.contains('light') && !!document.querySelector('.ai-monitor') && document.querySelectorAll('.ai-monitor-card').length===4`));
  await evaluate(`(() => {
    const opens=window.__ZEEAI_CALLARGS__.filter((c)=>c.cmd==='open_ssh').map((c)=>c.args);
    opens.forEach((a)=>window.__ZEEAI_TERM_EVENT__(a.id,{type:'state',state:'connected'}));
    const native=opens.find((a)=>!String(a.backend).startsWith('herdr') && a.tmuxName!=='monitor-tmux');
    window.__ZEEAI_TERM_DATA__(native.id, ${q(osc("state=working:app=codex:progress=65"))});
    window.__ZEEAI_EMIT__('zeeai://ai-monitor-herdr', {sessionIds:opens.filter((a)=>String(a.backend).startsWith('herdr')).map((a)=>a.id),atMs:Date.now(),agents:[
      {paneId:'wMON:p1',kind:'claude',status:'working'},
      {paneId:'wMON:p2',kind:'claude',status:'blocked'}
    ],error:null});
  })()`);
  await sleep(200);
  check("AI 监控：浅色主题正常显示运行、等待处理、进度与只读标记", await evaluate(`(() => {
    const panel=document.querySelector('.ai-monitor'); return panel.querySelectorAll('.ai-monitor-card.working').length===2 && panel.querySelectorAll('.ai-monitor-card.blocked').length===1 && panel.querySelector('progress')?.value===65 && panel.textContent.includes('只读观察');
  })()`));
  const writesBeforeFocus = await countWrites();
  await evaluate(`document.querySelector('.ai-monitor-card.blocked button')?.click()`);
  await sleep(200);
  check("AI 监控：切到终端会聚焦输入，已激活会话也能再次聚焦且不代发按键", await evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea')`) && await countWrites() === writesBeforeFocus);
  check("AI 监控：状态栏悬停说明具体待处理会话", await evaluate(`document.querySelector('.ai-need-chip')?.title.includes('monitor-herdr-observe')`));
  await shot("monitor-light.png");
  // The full smoke suite continues with its own legacy scenarios after this.
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: lightScript.identifier });
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: monitorScript.identifier });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fe-smoke.mjs", import.meta.url))], {
    env: { ...process.env, ZEEAI_FE_TEST_MONITOR_ONLY: "1" }, stdio: "inherit",
  });
  child.on("error", (error) => { console.error(error); process.exit(1); });
  child.on("exit", (code) => process.exit(code ?? 1));
}
