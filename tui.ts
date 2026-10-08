import { Plugin } from "@opencode/plugin/tui"
import { createReviewCommand } from "./review.mjs"

export default Plugin.define({
  id: "opencode-plannotator-tui",
  setup(context) {
    const review = createReviewCommand(context)
    // 2.0.22's keymap.layer needs the mounted provider; newer hosts also allow setup().
    const unmount = context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "opencode-plannotator-tui.annotate",
            title: "Annotate reply or document (TUI)",
            description: "Annotate the last reply or a file; press q, then confirm to send",
            group: "Plannotator",
            palette: true,
            slash: { name: "annotate", aliases: ["annotate-last"], arguments: true },
            run: review.run,
          }],
        }))
        return null
      },
    })
    return () => {
      review.dispose()
      unmount()
    }
  },
})
