# claude-gpt-image-bridge

Give [Claude Code](https://docs.claude.com/en/docs/claude-code) image generation by bridging to OpenAI's `gpt-image-2` model through the [`codex` CLI](https://github.com/openai/codex). Uses your ChatGPT subscription — **no API key required, no per-image billing.**

Works with any design skill (like the [`image-taste-frontend`](https://github.com/Leonxlnx/taste-skill) skill from [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)) or on its own whenever Claude needs to produce a picture.

## What it is

Claude Code doesn't ship with an image generation tool. This skill adds a thin bash wrapper that shells out to `codex exec`, which calls `gpt-image-2` using your existing ChatGPT authentication and copies the PNG where you asked. Claude then reads the PNG back into context.

```
Claude Code ──Bash──▶ gpt-image-2 wrapper ──codex exec──▶ gpt-image-2 (OpenAI)
                                                                 │
             Read PNG ◀───────────── /tmp/out.png ◀──────── copied from
                                                     ~/.codex/generated_images/
```

## Prerequisites

- [Claude Code](https://docs.claude.com/en/docs/claude-code)
- [`codex` CLI](https://github.com/openai/codex) installed (`brew install codex` on macOS)
- A ChatGPT subscription (Plus / Pro / Team) logged in via `codex login`
- macOS or Linux (wrapper is bash; Windows users can run it under WSL)

Verify:

```bash
codex login status   # should say: Logged in using ChatGPT
codex features list | grep image_generation    # should be: stable true
```

## Install

```bash
git clone https://github.com/oakplank/claude-gpt-image-bridge.git
cd claude-gpt-image-bridge
./install.sh
```

The installer copies the skill into `~/.claude/skills/gpt-image-bridge/` and makes the wrapper executable. Claude Code picks up skills in that directory automatically — no further config needed.

## Usage

Once installed, Claude will invoke the wrapper on its own whenever you ask it for an image. You can also call the wrapper directly:

```bash
~/.claude/skills/gpt-image-bridge/bin/gpt-image-2 \
  "a photorealistic hummingbird hovering in front of a red desert canyon at golden hour, shallow depth of field, magazine quality" \
  /tmp/hummingbird.png
```

Optional flags:

- `--size WxH` — request a specific aspect ratio (e.g. `--size 1792x1024`). If omitted, the model picks its own dimensions.

On success the wrapper prints the absolute output path. On failure it prints the tail of the codex log to stderr.

## Why go through codex instead of calling the API directly?

| | Through codex | Direct OpenAI API |
| --- | --- | --- |
| Auth | Your ChatGPT subscription | Requires API key |
| Cost | Uses ChatGPT message quota | Per-image billing |
| Speed | Slower (codex reasons before calling the image tool) | Faster |
| Prompt quality | codex refines your prompt with gpt-5.4 before generating | Passed verbatim |

If you already pay for ChatGPT, the codex route is free at the margin. If you'd rather pay per image for speed, call the [Images API](https://platform.openai.com/docs/api-reference/images) directly — this bridge is for the subscription route.

## Pair with a design skill

This bridge is just the tool — it gives Claude the ability to call `gpt-image-2`, not the taste to know what a good image looks like. For art-directed frontend work, stack it under a design-taste skill:

- [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) by [@lexnlin](https://x.com/lexnlin) — high-agency frontend, anti-slop. The `image-taste-frontend` skill inside it is the one this bridge was originally built to feed.
- Any other skill that follows an "image first, then code" workflow

Install one alongside `gpt-image-bridge` and it'll automatically use the wrapper for its image-generation steps:

```bash
npx skills add https://github.com/Leonxlnx/taste-skill --skill image-taste-frontend -a claude-code
```

## Caveats

- **Latency**: calls go through codex's reasoning loop before the image tool fires. Latency depends on your codex `reasoning_effort` config.
- **Quota**: ChatGPT subscriptions have message limits. Heavy automated use can hit rate caps.
- **Terms of service**: using `codex` programmatically to drive image generation is within the spirit of the tool (codex is an official OpenAI product), but consumer-subscription automation is ultimately gated by OpenAI's terms. Use at your own risk.
- **macOS / Linux only** for now — the wrapper is bash.

## License

MIT — see [LICENSE](./LICENSE).
