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
    throw new Error("Choose a Markdown or plain-text file (.md, .mdx, .markdown, .txt).")
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) throw new Error("Use a local file path.")
  if (target.startsWith("~/")) target = path.join(os.homedir(), target.slice(2))
  const session = await client.session.get({ sessionID }, { signal })
  const directory = session.location?.directory
  if (!path.isAbsolute(target) && !directory) throw new Error("Can't determine the current session's working directory.")
  const filePath = path.isAbsolute(target) ? path.normalize(target) : path.resolve(directory, target)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) throw new Error("The target is not a file.")
    if (info.size > maxDocumentBytes) throw new Error("The file is larger than 2 MiB. Choose a smaller document.")
    const bytes = await readFile(filePath, { signal })
    if (bytes.length > maxDocumentBytes) throw new Error("The file is larger than 2 MiB.")
    if (bytes.includes(0)) throw new Error("The file contains binary content.")
    let text
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new Error("Use a UTF-8 text file.")
    }
    return {
      text, filePath,
      sourceHash: createHash("sha256").update(bytes).digest("hex"),
      snapshot: path.join("source", path.basename(filePath)),
    }
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error(`Can't read document "${filePath}": ${error.code === "ENOENT" ? "file not found." : error.message}`)
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
    if (cursor && seen.has(cursor)) throw new Error("Session history returned a repeated page cursor.")
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
    throw new Error("Run /annotate in the full OpenCode terminal interface.")
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
    if (active) return notice("An annotation is already in progress.")
    // Capture before the first await: changing tabs must never redirect a review.
    const route = context.ui.router.current()
    if (route.type !== "session") return notice("Open a session first.")
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
      if (!source) return notice("This session has no completed assistant reply yet.")

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
      const retainedArchive = archived ? `\n${archived} archived ${archived === 1 ? "note was" : "notes were"} kept in ${directory}.` : ""
      // Upstream 0.9.4 emits this sentinel rather than empty stdout.
      if (!feedback || feedback === "No annotations.") {
        keepDraft = archived > 0
        return notice(archived ? `No annotations to send.${retainedArchive}` : "No annotations. Returned to the session.", archived ? "warning" : "info")
      }
      if (!feedback.startsWith("# Annotations on ")) throw new Error("Can't recognize the TUI annotation export format.")
      const subject = source.filePath
        ? `Here are my annotations on the document ${JSON.stringify(source.filePath)}. Please apply the feedback to that file.\nThe annotations are based on a snapshot taken when the document was opened (SHA-256: ${source.sourceHash}). Re-read the file and check the quoted text before editing.`
        : `Here are my annotations on your reply ${source.id}. Please address the feedback.`
      const text = `${subject}\n\n${feedback}`
      const feedbackPath = path.join(directory, "feedback.md")
      await writeFile(feedbackPath, text, { mode: 0o600 })
      const count = (feedback.match(/^## Annotation /gm) ?? []).length
      const confirmed = await context.ui.dialog.confirm({
        title: "Send annotations?",
        message: `${source.filePath ? `Document: ${source.filePath}\n` : ""}Send ${count} ${count === 1 ? "annotation" : "annotations"} to "${title}" and let the assistant continue?`,
        label: { confirm: "Send and continue", cancel: "Cancel" },
      })
      if (controller.signal.aborted) return
      if (confirmed !== true) {
        keepDraft = archived > 0
        return notice(`Sending cancelled.${retainedArchive}`)
      }
      await context.client.session.prompt({
        sessionID, id: promptID, text, delivery: "queue", resume: true,
      })
      keepDraft = archived > 0
      notice(`Sent ${count} ${count === 1 ? "annotation" : "annotations"}.${retainedArchive}`, "success")
    } catch (error) {
      if (!disposed) {
        const detail = error?.code === "ENOENT"
          ? "Can't find plannotator-tui. Check that it is installed and on PATH."
          : error instanceof Error ? error.message : String(error)
        const recovery = keepDraft && directory
          ? `\nThe draft was kept in ${directory}. If it was exported, the feedback is in feedback.md.`
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
