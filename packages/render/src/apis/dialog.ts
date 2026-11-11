/**
 * dialog api — 系统对话框（main 的 `dialog:*` 通道）。
 *
 * 与同目录其它文件不一样的地方只有**通道**：它们每个对应 main 的一个 service，走
 * `invokeService(service, method)`；这一个走 preload 单独暴露的 `dialog:selectDirectory`
 * （不是服务端协议，是 Electron 自己的事）。放在 `apis/` 是因为它俩是同一件事的另一半：
 * **把一次 IPC 调用送出去，并把失败翻成一句人话**。
 *
 * 以前这段是「新建工作空间的对话框」里各写一份（侧栏一处、引导页一处），两处都是
 * `const dir = await window.electronAPI.selectDirectory()` —— 没有 try/catch。选择框打不开
 * （主进程 `showOpenDialog` 出错）时那个 rejection 没人接：界面上什么都不发生，用户只会
 * 以为按钮坏了，于是再点一次、再点一次。所以错误在这里就收口。
 */

import { ElMessage } from "element-plus";

/**
 * 弹系统目录选择框。拿到目录返回它的路径，**用户取消**或**选择框打不开**都返回 `null`。
 *
 * 两种 `null` 在调用点要做的事完全一样（什么都不改），但语义不同，所以：
 *   - 取消是用户自己的动作，不需要解释，也不该弹任何提示；
 *   - 打不开是故障，说一句（不说是最坏的选择）。
 */
export async function pickDirectory(): Promise<string | null> {
  try {
    // 取消时 main 回 `null`（`dialog:selectDirectory` 的约定），照原样传出去
    return await window.electronAPI.selectDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ElMessage.error(`打开目录选择框失败：${reason}`);
    return null;
  }
}
