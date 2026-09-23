import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  ConnectionProfile,
  SessionEvent,
  SessionInfo,
  TmuxSession,
} from "./types";

export async function listProfiles(): Promise<ConnectionProfile[]> {
  return invoke<ConnectionProfile[]>("list_profiles");
}

export async function saveProfile(profile: ConnectionProfile): Promise<void> {
  return invoke("save_profile", { profile });
}

export async function deleteProfile(id: string): Promise<void> {
  return invoke("delete_profile", { id });
}

/** 打开本地终端（powershell / cmd / wsl）。id 由前端生成，便于事件在终端挂载前就能正确路由。 */
export async function openLocal(
  id: string,
  shell: string,
  onEvent: (e: SessionEvent) => void,
  distro?: string,
): Promise<SessionInfo> {
  const ch = new Channel<SessionEvent>();
  ch.onmessage = onEvent;
  return invoke<SessionInfo>("open_local", {
    id,
    shell,
    distro: distro ?? null,
    onEvent: ch,
  });
}

/** 打开 SSH 会话（可选 tmux） */
export async function openSsh(
  id: string,
  profileId: string,
  onEvent: (e: SessionEvent) => void,
  tmuxSession?: string,
): Promise<SessionInfo> {
  const ch = new Channel<SessionEvent>();
  ch.onmessage = onEvent;
  return invoke<SessionInfo>("open_ssh", {
    id,
    profileId,
    tmuxSession: tmuxSession ?? null,
    onEvent: ch,
  });
}

/** 列出服务器上的 tmux 会话 */
export async function tmuxList(profileId: string): Promise<TmuxSession[]> {
  return invoke<TmuxSession[]>("tmux_list", { profileId });
}

/** 结束服务器上的某个 tmux 会话 */
export async function tmuxKill(profileId: string, name: string): Promise<void> {
  return invoke("tmux_kill", { profileId, name });
}

export async function sessionWrite(id: string, dataB64: string): Promise<void> {
  return invoke("session_write", { id, dataB64 });
}

export async function sessionResize(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("session_resize", { id, cols, rows });
}

export async function sessionClose(id: string): Promise<void> {
  return invoke("session_close", { id });
}
