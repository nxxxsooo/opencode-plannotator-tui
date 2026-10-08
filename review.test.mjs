import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { test } from "node:test"

const moduleURL = new URL("./review.mjs", import.meta.url)
const load = () => import(moduleURL)

function reply(id, text, extra = {}) {
  return {
    id, type: "assistant", time: { created: 100, completed: 101 },
    agent: "build", model: { providerID: "fixture", id: "fixture" },
    finish: "stop", content: [{ type: "text", text }], ...extra,
  }
}

test("latest reply excludes streaming text, tool commentary, errors, and reasoning", async () => {
  const { selectReply } = await load()
  const messages = [
    reply("msg_old", "Older", { time: { created: 1, completed: 2 } }),
    reply("msg_final", "First", { content: [
      { type: "reasoning", text: "Private reasoning" },
      { type: "text", text: "First" }, { type: "text", text: "第二段" },
    ] }),
    reply("msg_tools", "Working…", { time: { created: 200, completed: 201 }, finish: "tool-calls" }),
    reply("msg_error", "Broken", { time: { created: 300, completed: 301 }, finish: "error", error: {} }),
    reply("msg_live", "Not finished", { time: { created: 400 } }),
  ]
  assert.deepEqual(selectReply(messages), { id: "msg_final", text: "First\n\n第二段" })
  assert.equal(selectReply([messages.at(-1)]), undefined)
})

function context({ confirm = true, sendError, changeRoute, paginated, sessionDir } = {}) {
  let route = { type: "session", sessionID: "ses_original" }
  const sent = [], transitions = [], notices = []
  let confirmationCount = 0
  let pages = 0
  const ctx = {
    options: {}, themeMode: "dark", location: { directory: "/wrong-client-directory" },
    renderer: {
      suspend() { transitions.push("suspend") },
      resume() { transitions.push("resume") },
      requestRender() { transitions.push("render") },
      currentRenderBuffer: { clear() {} },
    },
    data: { session: {
      get: () => ({ title: "Original session" }),
      message: {
        async sync(id) {
          assert.equal(id, "ses_original")
          if (changeRoute) route = { type: "session", sessionID: "ses_other" }
        },
        list(id) {
          assert.equal(id, "ses_original")
          return [reply("msg_final", "# Review fixture\n\nAlpha paragraph.\n")]
        },
      },
    } },
    client: { message: { async list(input) {
      assert.equal(input.sessionID, "ses_original")
      assert.equal(input.type, "assistant")
      if (changeRoute) route = { type: "session", sessionID: "ses_other" }
      pages++
      if (paginated && pages === 1) {
        assert.equal(input.order, "desc")
        return { data: [reply("msg_tools", "Working", { finish: "tool-calls" })], cursor: { next: "older-page" } }
      }
      if (paginated) {
        assert.equal(input.cursor, "older-page")
        assert.equal(input.order, undefined)
      }
      return { data: [reply("msg_final", "# Review fixture\n\nAlpha paragraph.\n")], cursor: {} }
    } }, session: {
      async get(input) {
        assert.equal(input.sessionID, "ses_original")
        if (changeRoute) route = { type: "session", sessionID: "ses_other" }
        return { id: "ses_original", title: "Original session", location: { directory: sessionDir } }
      },
      async prompt(input) {
      if (sendError) throw new Error("Delivery failed")
      sent.push(input)
      return { id: input.id, sessionID: input.sessionID, type: "user" }
    } } },
    ui: {
      router: { current: () => route },
      toast: { show: notice => notices.push(notice) },
      dialog: {
        clear() {},
        async confirm() {
          confirmationCount++
          assert.deepEqual(transitions, ["suspend", "resume", "render"])
          return confirm
        },
      },
    },
  }
  return { ctx, sent, transitions, notices, confirmations: () => confirmationCount, pages: () => pages }
}

async function harness(t, options = {}) {
  const { createReviewCommand } = await load()
  const root = await mkdtemp(path.join(os.tmpdir(), "annotate-last-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const state = context(options)
  let invocation
  const command = createReviewCommand(state.ctx, {
    tempRoot: root,
    interactive: async input => {
      invocation = input
      assert.deepEqual(state.transitions, ["suspend"])
      assert.equal(await readFile(input.file, "utf8"), options.expectedText ?? "# Review fixture\n\nAlpha paragraph.\n")
      if (options.failTerminal) throw new Error("Terminal child failed")
      if (!options.empty) {
        // Use the installed upstream binary, including its real JSON store and export contract.
        execFileSync(input.binary, ["--annotate", input.file, "Alpha paragraph.", "请补充具体例子。", "comment"], {
          env: input.env, cwd: input.cwd,
        })
        if (options.archived) {
          const data = input.env.PLANNOTATOR_DATA_DIR
          const name = (await readdir(data, { recursive: true })).find(name => name.endsWith("annotations.json"))
          const file = path.join(data, name)
          const record = JSON.parse(await readFile(file, "utf8"))
          // Upstream 0.9.4's E → F moves whole records from annotations to archived.
          record.archived = record.annotations
          record.annotations = []
          await writeFile(file, JSON.stringify(record))
        }
      }
    },
  })
  t.after(command.dispose)
  return { ...state, command, root, invocation: () => invocation }
}

test("real TUI annotations go only to the captured session even after tab changes", async t => {
  const h = await harness(t, { changeRoute: true })
  await h.command.run()
  assert.equal(h.sent.length, 1)
  const sent = h.sent[0]
  assert.equal(sent.sessionID, "ses_original")
  assert.match(sent.id, /^msg_/)
  assert.match(sent.text, /msg_final/)
  assert.match(sent.text, /Alpha paragraph\./)
  assert.match(sent.text, /请补充具体例子。/)
  assert.equal(sent.delivery, "queue")
  assert.equal(sent.resume, true)
  assert.equal(h.confirmations(), 1)
  assert.deepEqual(await readdir(h.root), [])
})

for (const [name, options] of [
  ["an empty review", { empty: true }],
  ["a cancelled confirmation", { confirm: false }],
]) {
  test(`${name} restores the terminal without submitting feedback`, async t => {
    const h = await harness(t, options)
    await h.command.run()
    assert.deepEqual(h.sent, [])
    assert.deepEqual(h.transitions, ["suspend", "resume", "render"])
    assert.equal(h.confirmations(), options.empty ? 0 : 1)
    assert.deepEqual(await readdir(h.root), [])
  })
}

test("a crashed child still restores OpenCode and submits nothing", async t => {
  const h = await harness(t, { failTerminal: true })
  await h.command.run()
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.transitions, ["suspend", "resume", "render"])
  assert.ok(h.notices.some(n => n.variant === "error"))
})

test("failed delivery preserves feedback and source with the original session identity", async t => {
  const h = await harness(t, { sendError: true })
  await h.command.run()
  const retained = await readdir(h.root)
  assert.equal(retained.length, 1)
  const feedback = await readFile(path.join(h.root, retained[0], "feedback.md"), "utf8")
  assert.match(feedback, /请补充具体例子。/)
  const metadata = JSON.parse(await readFile(path.join(h.root, retained[0], "review.json"), "utf8"))
  assert.equal(metadata.sessionID, "ses_original")
  assert.equal(metadata.messageID, "msg_final")
  assert.ok(h.notices.some(n => n.variant === "error" && n.message.includes("feedback.md")))
})

test("last completed reply is found beyond the newest page of tool messages", async t => {
  const h = await harness(t, { paginated: true })
  await h.command.run()
  assert.equal(h.pages(), 2)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].text, /msg_final/)
})

test("archived-only notes are preserved when upstream exports No annotations", async t => {
  const h = await harness(t, { archived: true })
  await h.command.run()
  assert.deepEqual(h.sent, [])
  const dirs = await readdir(h.root)
  assert.equal(dirs.length, 1)
  const data = path.join(h.root, dirs[0], "data")
  const name = (await readdir(data, { recursive: true })).find(name => name.endsWith("annotations.json"))
  const record = JSON.parse(await readFile(path.join(data, name), "utf8"))
  assert.equal(record.archived[0].body, "请补充具体例子。")
  assert.ok(h.notices.some(n => n.message.includes("archived") && n.message.includes(h.root)))
})

async function documentFolder(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "annotate-document-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test("a quoted relative document uses the captured session directory and returns its source path", async t => {
  const sessionDir = await documentFolder(t)
  const file = path.join(sessionDir, "设计 方案.md")
  const text = "# Document fixture\n\nAlpha paragraph.\n"
  await writeFile(file, text)
  const h = await harness(t, { sessionDir, expectedText: text, changeRoute: true })
  await h.command.run('"设计 方案.md"')
  assert.equal(h.pages(), 0, "Document reviews must not require an assistant reply")
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].sessionID, "ses_original")
  assert.ok(h.sent[0].text.includes(file))
  assert.match(h.sent[0].text, /# Annotations on 设计 方案\.md/)
  assert.match(h.sent[0].text, /snapshot/)
  assert.doesNotMatch(h.sent[0].text, /msg_final/)
  assert.equal(await readFile(file, "utf8"), text)
  assert.deepEqual(await readdir(h.root), [])
})

test("absolute document paths keep recovery snapshots separate from exported feedback.md", async t => {
  const sessionDir = await documentFolder(t)
  const file = path.join(sessionDir, "feedback.md")
  const text = "# Document fixture\n\nAlpha paragraph.\n"
  await writeFile(file, text)
  const h = await harness(t, { sessionDir, expectedText: text, sendError: true })
  await h.command.run(file)
  const [retained] = await readdir(h.root)
  const draft = path.join(h.root, retained)
  assert.equal(await readFile(path.join(draft, "source", "feedback.md"), "utf8"), text)
  assert.match(await readFile(path.join(draft, "feedback.md"), "utf8"), /请补充具体例子。/)
  const metadata = JSON.parse(await readFile(path.join(draft, "review.json"), "utf8"))
  assert.equal(metadata.filePath, file)
  assert.equal(metadata.messageID, undefined)
  assert.equal(metadata.snapshot, "source/feedback.md")
  assert.match(metadata.sourceHash, /^[a-f0-9]{64}$/)
  assert.equal(await readFile(file, "utf8"), text)
})

for (const invalid of ["missing.md", "directory.md", "binary.txt", "large.txt"]) {
  test(`${invalid} fails before taking over the terminal or submitting a prompt`, async t => {
    const sessionDir = await documentFolder(t)
    const file = path.join(sessionDir, invalid)
    if (invalid === "directory.md") await mkdir(file)
    if (invalid === "binary.txt") await writeFile(file, Buffer.from([0, 255, 0, 1]))
    if (invalid === "large.txt") await writeFile(file, "x".repeat(2 * 1024 * 1024 + 1))
    const h = await harness(t, { sessionDir })
    await h.command.run(invalid)
    assert.deepEqual(h.transitions, [])
    assert.deepEqual(h.sent, [])
    assert.equal(h.pages(), 0)
    const error = h.notices.find(n => n.variant === "error")
    assert.ok(error, "A document error must be visible")
    assert.doesNotMatch(error.message, /Can't find plannotator-tui/)
    assert.deepEqual(await readdir(h.root), [])
  })
}
