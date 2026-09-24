//! 密码存放：交给 **Windows 凭据管理器**（Credential Manager）。
//!
//! 为什么单独做一个模块：
//! - 密码绝对不能写进 profiles.json（明文躺在磁盘上）；
//! - 系统 ssh.exe 不接受"从命令行喂密码"，所以「只能用密码登录」的服务器
//!   里，终端可以自己弹提示，但**一次性命令和 SFTP 就没法认证**。
//!   把密码存进凭据管理器后，这些操作就能用 russh 带密码连上去。
//!
//! keyring 在 Windows 上就是调用 CredRead/CredWrite，凭据会出现在
//! 「控制面板 → 凭据管理器 → Windows 凭据」里，用户可以自己删。

const SERVICE: &str = "ZeeAI-Terminal";

fn entry(profile_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, profile_id).map_err(|e| format!("访问凭据管理器失败: {e}"))
}

/// 存/更新密码
pub fn set_password(profile_id: &str, password: &str) -> Result<(), String> {
    if password.is_empty() {
        return delete_password(profile_id);
    }
    entry(profile_id)?
        .set_password(password)
        .map_err(|e| format!("写入凭据失败: {e}"))
}

/// 取密码；没存过就返回 None（不算错误）
pub fn get_password(profile_id: &str) -> Option<String> {
    match entry(profile_id).and_then(|e| {
        e.get_password()
            .map_err(|err| format!("读取凭据失败: {err}"))
    }) {
        Ok(pw) if !pw.is_empty() => Some(pw),
        _ => None,
    }
}

/// 有没有存过密码
pub fn has_password(profile_id: &str) -> bool {
    get_password(profile_id).is_some()
}

/// 删除密码
pub fn delete_password(profile_id: &str) -> Result<(), String> {
    match entry(profile_id)?.delete_credential() {
        Ok(()) => Ok(()),
        // 本来就没有，也算成功
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除凭据失败: {e}")),
    }
}
