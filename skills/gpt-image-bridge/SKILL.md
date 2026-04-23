---
name: gpt-image-bridge
description: Give Claude Code image generation by bridging to OpenAI's gpt-image-2 model through the codex CLI. Whenever the user asks for an image, a mockup, a visual reference, a diagram, a design, or any other kind of picture, use the bundled wrapper script to generate it.
---

# gpt-image-bridge

Claude Code has no native image generation tool. This skill bridges that gap by shelling out to the `codex` CLI, which calls OpenAI's `gpt-image-2` model under the hood. Codex is authenticated via the user's ChatGPT subscription, so no API key is required.

## When to use

Invoke the wrapper any time the user wants an image produced. Examples:

- "Generate a hero image for..."
- "Make me a mockup of..."
- "I need an avatar / logo / illustration / diagram of..."
- "Show me what X would look like"
- A design-taste skill (e.g. `image-taste-frontend` from [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)) is driving an image-first workflow and needs an image generated

Do **not** invoke it for:

- Small programmatic PNGs (1px dots, solid-color placeholders, charts) — write those directly with a few lines of Python.
- Editing an existing image pixel-by-pixel.

## How to call it

```bash
~/.claude/skills/gpt-image-bridge/bin/gpt-image-2 "<prompt>" <absolute-output-path.png> [--size WxH]
```

- **Prompt** should be dense and art-directed: composition, lighting, camera/lens, mood, style reference. Terse prompts produce generic output.
- **Output path** must be absolute. `/tmp/` works for throwaways; a project-local `design/` directory for kept assets.
- **Size is optional** — if omitted, the model chooses its own dimensions. Only pass `--size` when the user specifies one or the layout requires a particular aspect ratio.
- Calls can take a while (codex reasons before calling the image tool; exact latency depends on the user's codex `reasoning_effort` config). Set the `Bash` tool timeout generously — **at least 240000 ms** is safe.
- The wrapper prints the absolute output path to stdout on success, or a tail of the codex log to stderr on failure.

After the wrapper returns, `Read` the PNG back into context so you can analyze it before coding or responding.

## Under the hood

The wrapper runs:

```
codex exec --skip-git-repo-check -s workspace-write "<augmented prompt>"
```

with explicit instructions to use the `image_generation` tool (not fabricate a PNG in Python — codex will try that if you let it). Codex writes the PNG to `~/.codex/generated_images/<session-id>/ig_*.png` and the wrapper copies it to the requested path.

## Prerequisites (user-side)

- `codex` CLI installed (`brew install codex` on macOS)
- `codex login status` reports "Logged in using ChatGPT" (ChatGPT Plus/Pro/Team subscription)
- `image_generation` feature enabled — on by default (`codex features list | grep image_generation`)

If the wrapper errors with "codex CLI not found", tell the user to run `brew install codex && codex login`.

## Cost

- **No OpenAI API spend.** Calls consume the user's ChatGPT message quota, not billed credits.
- Still rate-limited by the ChatGPT plan, so don't burn quota on throwaways.
