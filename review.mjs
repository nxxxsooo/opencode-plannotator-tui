import { spawn, execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const documentExtensions = new Set([".md", ".mdx", ".markdown", ".txt"])
const maxDocumentBytes = 2 * 1024 * 1024

async function documentSource(input, client, sessionID, signal) {
  let target = input.trim()
  if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1)
  }
  if (!target || !documentExtensions.has(path.extname(target).toLowerCase())) {
    throw new Error("请指定一个 Markdown 或纯文本文件（.md、.mdx、.markdown、.txt）。")
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) throw new Error("请指定本地文件路径。")
  if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2))
  const session = await client.session.get({ sessionID }, { signal })
  const directory = session.location?.directory
  if (!path.isAbsolute(target) && !directory) throw new Error("无法确定当前会话的工作目录。")
  const filePath = path.isAbsolute(target) ? path.normalize(target) : path.resolve(directory, target)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error("目标不是文件。")
    if (info.size > maxDocumentBytes) throw new Error("文件超过 2 MiB，请先选取较小的文档。")
    const bytes = await readFile(filePath, { signal })
    if (bytes.length > maxDocumentBytes) throw new Error("文件超过 2 MiB。")
    if (bytes.includes(0)) throw new Error("文件包含二进制内容。")
    let text
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new Error("请使用 UTF-8 编码的文本文件。")
    }
    return {
      text, filePath,
      sourceHash: createHash("sha256").update(bytes).digest("hex"),
      snapshot: path.join("source", path.basename(filePath)),
    }
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`无法读取文档「${filePath}」：${error.code === "ENOENT" ? "文件不存在。" : error.message}`)
  }
}

export function selectReply(messages) {
  const newest = [...messages].sort((a, b) =>
    b.time.created - a.time.created || b.id.localeCompare(a.id),
  )
  for (const message of newest) {
    if (message.type !== "assistant" || message.time.completed === undefined || message.error) continue
    if (["tool-calls", "error", "content-filter"].includes(message.finish)) continue
    const text = message.content.filter(part => part.type === "text").map(part => part.text).join("\n\n")
    if (text.trim()) return { id: message.id, text }
  }
}

async function latestReply(client, sessionID, signal) {
  const seen = new Set()
  let cursor
  do {
    signal.throwIfAborted()
    const page = await client.message.list({
      sessionID, type: "assistant", limit: 50,
      ...(cursor ? { cursor } : { order: "desc" }),
    }, { signal })
    const reply = selectReply(page.data)
    if (reply) return reply
    cursor = page.cursor?.next
    if (cursor && seen.has(cursor)) throw new Error("读取会话历史时收到重复分页游标。")
    seen.add(cursor)
  } while (cursor)
}

async function archivedNotes(data) {
  let count = 0
  for (const name of await readdir(data, { recursive: true })) {
    if (path.basename(name) !== "annotations.json") continue
    const record = JSON.parse(await readFile(path.join(data, name), "utf8"))
    count += record.archived?.length ?? 0
  }
  return count
}

async function interactive({ binary, file, cwd, env, signal }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("请在 OpenCode 完整终端界面中运行 /annotate。")
  }
  await new Promise((resolve, reject) => {
    const child = spawn(binary, [file], { cwd, env, stdio: "inherit", signal })
    child.once("error", reject)
    child.once("close", (code, termination) => {
      if (code === 0) resolve()
      else reject(new Error(`plannotator-tui exited: ${termination ?? code}`))
    })
  })
}

export function createReviewCommand(context, options = {}) {
  const binary = options.binary ?? context.options.binary ?? "plannotator-tui"
  const runInteractive = options.interactive ?? interactive
  let active
  let disposed = false
  const notice = (message, variant = "info") => context.ui.toast.show({
    title: "Annotate", message, variant, duration: variant === "error" ? 15000 : 5000,
  })

  async function run(input = "") {
    if (disposed) return
    if (active) return notice("已有批注正在进行。")
    // Capture before the first await: changing tabs must never redirect a review.
    const route = context.ui.router.current()
    if (route.type !== "session") return notice("请先打开一个会话。")
    const sessionID = route.sessionID
    const title = context.data.session.get(sessionID)?.title ?? sessionID
    const controller = new AbortController()
    active = controller
    let directory
    let keepDraft = false
    try {
      // The UI cache contains only a recent page; a long tool run can push the last
      // completed reply out of it. Read the session-scoped history, newest first.
      const target = input.trim()
      const source = target
        ? await documentSource(target, context.client, sessionID, controller.signal)
        : await latestReply(context.client, sessionID, controller.signal)
      if (controller.signal.aborted) return
      if (!source) return notice("当前会话还没有已完成的助手回复。")

      directory = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "opencode-annotate-"))
      keepDraft = true
      const snapshot = source.snapshot ?? "last-reply.md"
      const file = path.join(directory, snapshot)
      const data = path.join(directory, "data")
      const promptID = `msg_${randomUUID().replaceAll("-", "")}`
      await mkdir(data, { mode: 0o700 })
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, source.text, { mode: 0o600 })
      await writeFile(path.join(directory, "review.json"), JSON.stringify({
        sessionID, messageID: source.id, filePath: source.filePath,
        sourceHash: source.sourceHash, snapshot, promptID, title,
      }, null, 2), { mode: 0o600 })

      // Use a fresh store per invocation, and disable any inherited pane delivery.
      // The OpenCode confirmation is the sole authority for sending feedback.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith("HERDR_") && !key.startsWith("PLANNOTATOR_TUI_"),
      ))
      Object.assign(env, {
        PLANNOTATOR_DATA_DIR: data,
        PLANNOTATOR_FEEDBACK_HISTORY: "0",
        PLANNOTATOR_TUI_THEME: context.themeMode === "light" ? "light" : "dark",
      })
      context.ui.dialog.clear()
      context.renderer.suspend()
      try {
        context.renderer.currentRenderBuffer.clear()
        await runInteractive({ binary, file, cwd: directory, env, signal: controller.signal })
      } finally {
        context.renderer.currentRenderBuffer.clear()
        context.renderer.resume()
        context.renderer.requestRender()
      }
      if (controller.signal.aborted) return
      const { stdout } = await execute(binary, ["--export", file], {
        cwd: directory, env, signal: controller.signal, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
      })
      const feedback = stdout.trim()
      const archived = await archivedNotes(data)
      const retainedArchive = archived ? `\n${archived} 条归档批注保留在 ${directory}。` : ""
      // Upstream 0.9.4 emits this sentinel rather than empty stdout.
      if (!feedback || feedback === "No annotations.") {
        keepDraft = archived > 0
        return notice(archived ? `没有待发送的批注。${retainedArchive}` : "没有批注，已返回会话。", archived ? "warning" : "info")
      }
      if (!feedback.startsWith("# Annotations on ")) throw new Error("无法识别 TUI 的批注导出格式。")
      const subject = source.filePath
        ? `以下是我对文档 ${JSON.stringify(source.filePath)} 的批注，请按反馈处理该文件。\n批注基于打开时的文档快照（SHA-256：${source.sourceHash}）；修改前请重新读取原文件并核对引用。`
        : `以下是我对你回复 ${source.id} 的批注，请按反馈处理。`
      const text = `${subject}\n\n${feedback}`
      const feedbackPath = path.join(directory, "feedback.md")
      await writeFile(feedbackPath, text, { mode: 0o600 })
      const count = (feedback.match(/^## Annotation /gm) ?? []).length
      const confirmed = await context.ui.dialog.confirm({
        title: "发送批注？",
        message: `${source.filePath ? `文档：${source.filePath}\n` : ""}将 ${count} 条批注发送到「${title}」，并让助手继续处理？`,
        label: { confirm: "发送并继续", cancel: "取消" },
      })
      if (controller.signal.aborted) return
      if (confirmed !== true) {
        keepDraft = archived > 0
        return notice(`已取消发送。${retainedArchive}`)
      }
      await context.client.session.prompt({
        sessionID, id: promptID, text, delivery: "queue", resume: true,
      })
      keepDraft = archived > 0
      notice(`已发送 ${count} 条批注。${retainedArchive}`, "success")
    } catch (error) {
      if (!disposed) {
        const detail = error?.code === "ENOENT"
          ? "找不到 plannotator-tui；请检查安装和 PATH。"
          : error instanceof Error ? error.message : String(error)
        const recovery = keepDraft && directory
          ? `\n草稿保留在 ${directory}；若已导出，反馈文件为 feedback.md。`
          : ""
        notice(`${detail}${recovery}`, "error")
      }
    } finally {
      if (directory && !keepDraft) {
        await rm(directory, { recursive: true, force: true }).catch(() => {})
      }
      active = undefined
    }
  }

  return {
    run,
    dispose() {
      disposed = true
      active?.abort()
    },
  }
}
