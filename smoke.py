"""Headless real OpenCode + plannotator-tui round trip; no model call or visible window."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time


PLUGIN = Path(__file__).resolve().parent
ENTRYPOINT = Path(os.environ.get("ANNOTATE_TUI_ENTRY", str(PLUGIN / "tui.ts"))).resolve().as_uri()
TMP = Path(os.environ.get("TMPDIR", tempfile.gettempdir())) / "opencode"
TMP.mkdir(exist_ok=True)
root = Path(tempfile.mkdtemp(prefix="annotate-last-smoke-", dir=TMP)).resolve()
socket = f"annotate-last-smoke-{os.getpid()}"
session = None


def api(method, route, data=None):
    args = ["opencode", "api", method, route]
    if data is not None:
        args += ["--data", json.dumps(data)]
    result = subprocess.run(args, capture_output=True, text=True, check=True, timeout=30)
    return json.loads(result.stdout) if result.stdout.strip() else None


def tmux(*args, check=True):
    return subprocess.run(["tmux", "-L", socket, "-f", "/dev/null", *args],
                          capture_output=True, text=True, check=check, timeout=15).stdout


def screen():
    return tmux("capture-pane", "-p", "-t", "check:0.0")


def wait(text, label, seconds=30):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        output = screen()
        if text in output:
            (root / f"{label}.txt").write_text(output)
            return output
        time.sleep(0.1)
    (root / f"{label}-failed.txt").write_text(output)
    raise AssertionError(f"Did not see {text!r}; capture: {root / (label + '-failed.txt')}")


def literal(text):
    tmux("send-keys", "-t", "check:0.0", "-l", text)


def keys(*items):
    tmux("send-keys", "-t", "check:0.0", *items)


def open_review(label, command="/annotate-last", filename="last-reply.md"):
    # The trailing space leaves slash completion and submits the optional argument slot.
    literal(command + " ")
    keys("Enter")
    wait(filename + " · 0 annotations", label)


def annotate(note, label):
    keys("c")
    wait("comment", f"{label}-compose")
    literal(note)
    keys("Enter")
    wait(note, label)


try:
    # Keep selection deterministic; exercise the real plugin, renderer, binary, confirmation,
    # client SDK and API. resume:false is the only submission change, to avoid an LLM run.
    fixture = root / "fixture"
    fixture.mkdir()
    (fixture / "package.json").write_text(json.dumps({
        "name": "annotate-last-smoke", "type": "module", "exports": {"./tui": "./tui.ts"},
    }))
    (fixture / "tui.ts").write_text(f'''import plugin from {json.dumps(ENTRYPOINT)}
export default {{
  ...plugin,
  id: "test.annotate-last",
  setup(ctx) {{
    return plugin.setup({{
      ...ctx,
      client: {{ ...ctx.client,
        message: {{ async list() {{ return {{ data: [{{
          id: "msg_smoke_fixture", type: "assistant", agent: "build",
          model: {{ providerID: "fixture", id: "fixture" }},
          time: {{ created: 1, completed: 2 }}, finish: "stop",
          content: [{{ type: "text", text: "# Terminal review fixture\\n\\nAlpha paragraph.\\n" }}],
        }}], cursor: {{}} }} }} }},
        session: {{ ...ctx.client.session,
        prompt: (input) => ctx.client.session.prompt({{ ...input, resume: false }}),
      }} }},
    }})
  }},
}}
''')
    session = api("post", "/api/session", {
        "title": "Annotate-last isolated smoke test", "location": {"directory": str(root)},
    })["data"]["id"]
    inline = json.dumps({
        "plugins": [str(fixture)], "animations": False,
        "theme": {"name": "dracula", "mode": "dark"},
        "debug": {"devtools": False}, "tabs": {"mode": "off"},
    })
    command = shlex.join(["env", f"OPENCODE_CLI_CONFIG_CONTENT={inline}",
                          "opencode", "--session", session, str(root)])
    tmux("new-session", "-d", "-s", "check", "-x", "140", "-y", "42", "-c", str(root), command)
    wait("Annotate-last isolated smoke test", "host-ready", 60)

    open_review("review-open")
    annotate("SMOKE exact-session feedback", "note-created")
    keys("q")
    wait("发送批注", "confirmation")
    keys("Enter")
    wait("已发送 1 条批注", "sent")
    inbox = api("get", f"/api/session/{session}/inbox")
    (root / "inbox.json").write_text(json.dumps(inbox, ensure_ascii=False, indent=2))
    encoded = json.dumps(inbox, ensure_ascii=False)
    assert "SMOKE exact-session feedback" in encoded, encoded
    assert "msg_smoke_fixture" in encoded, encoded

    open_review("empty-open", "/annotate")
    keys("q")
    wait("没有批注", "empty-return")
    after_empty = api("get", f"/api/session/{session}/inbox")
    assert after_empty == inbox, "Empty review changed the inbox"

    open_review("cancel-open")
    annotate("SMOKE must not be sent", "cancel-note")
    keys("q")
    wait("发送批注", "cancel-confirmation")
    keys("Escape")
    wait("已取消发送", "cancel-return")
    after_cancel = api("get", f"/api/session/{session}/inbox")
    assert after_cancel == inbox, "Cancelled review changed the inbox"

    document = root / "文档 sample.md"
    content = "# Document review fixture\n\nAlpha paragraph.\n"
    document.write_text(content)
    open_review("document-open", '/annotate "文档 sample.md"', document.name)
    annotate("SMOKE document feedback", "document-note")
    keys("q")
    wait("文档：", "document-confirmation")
    keys("Enter")
    wait("已发送 1 条批注", "document-sent")
    document_inbox = api("get", f"/api/session/{session}/inbox")
    encoded = json.dumps(document_inbox, ensure_ascii=False)
    assert "SMOKE document feedback" in encoded, encoded
    assert str(document) in encoded, encoded
    assert document.read_text() == content, "Review modified the original document"

    open_review("document-alias", '/annotate-last "文档 sample.md"', document.name)
    keys("q")
    wait("没有批注", "document-alias-return")
    assert api("get", f"/api/session/{session}/inbox") == document_inbox

    print(json.dumps({"passed": ["real TUI launch", "create annotation", "terminal restore",
                                  "confirmed API delivery", "empty review", "cancelled review",
                                  "document path arguments", "document API delivery", "document alias"],
                      "evidence": str(root)}, ensure_ascii=False))
finally:
    tmux("kill-server", check=False)
    if session:
        api("delete", f"/api/session/{session}")
