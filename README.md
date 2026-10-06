# Jev + agent-device QA agent

Give the agent a task. It reads the app through agent-device, asks Jev to choose an action, performs it, and repeats with a fresh snapshot. Each run saves a report, decision trace, snapshots, and, when supported, a device recording.

This is a local proof of concept built with the TypeSafe and agent-device SDKs.

## Setup

Use Node.js 24 or newer. For live runs, you also need an iOS simulator/device with Xcode or an Android emulator/device with ADB, and an installed test app.

```bash
npm ci
cp .env.example .env
```

Set `TYPESAFE_API_KEY` in `.env`, or supply it in your shell environment. `.env` and run artifacts are ignored by Git.

Check your device setup with `npx agent-device devices`. See the [agent-device setup guide](https://oss.callstack.com/agent-device/docs/agent-setup) for platform prerequisites.

## Run a task

Pass the app ID, platform, and task. Describe the expected outcome in the task itself:

```bash
npm run qa -- \
  --app com.apple.Preferences \
  --platform ios \
  "Open Accessibility, then Display & Text Size. Scroll to Smart Invert and verify that its switch is visible. Do not change any settings."
```

This example uses Settings on an English-language iOS simulator. For your app, replace the app ID and task:

```bash
npm run qa -- \
  --app com.example.shop \
  --platform android \
  "Add a Canvas backpack to the cart, increase its quantity to two, and open checkout. Verify that the summary shows the backpack and a quantity of two. Stop before placing an order."
```

Jev chooses actions until it selects `qa_pass`, `qa_fail`, or `incomplete`. That choice sets the final status. No separate assertion file is needed. The harness selects a simulator or emulator automatically, preferring one already booted. Use `--udid` on iOS or `--serial` on Android to override the selection. `npm run qa -- --help` lists the optional controls.

Each decision receives the current snapshot, the previous snapshot, and the action executed between them. Earlier snapshots stay in the saved artifacts instead of accumulating in the model context.

For text entry, put exact values in double quotes inside the task. The harness makes those strings available as fill choices:

```bash
npm run qa -- --app com.example.shop --platform ios \
  'Search for "Canvas backpack" and verify that its product page opens.'
```

## Use Clef instead of Jev

Cloudflare's Clef decision models (`clef` and `clef-flash` on Workers AI) take the same choice question. Set `CLOUDFLARE_ACCOUNT_ID` and a Workers AI `CLOUDFLARE_API_TOKEN`, then pass `--provider clef`:

```bash
npm run qa -- --provider clef --model clef-flash \
  --app com.apple.Preferences --platform ios \
  "Open Accessibility, then Display & Text Size. Scroll to Smart Invert and verify that its switch is visible. Do not change any settings."
```

`--model` defaults to `clef`. Clef also accepts images: `--vision` sends a screenshot of the current screen with each decision (about 350 extra input tokens for a phone screenshot), for checks that depend on what is drawn rather than what the accessibility tree exposes. Each screenshot is saved as `screen-<step>.png`. Jev does not accept images, so `--vision` requires `--provider clef`.

The cost estimate uses Workers AI's listed input price for the selected Clef model.

## Output

The CLI prints each selected action, then the result, startup time, run duration, token usage, estimated inference cost, and video path. Run details are saved as JSON.

```text
PASSED: Jev found that the task was satisfied.
Actions executed: <count> | QA confidence: <confidence>
Startup: <seconds> s
Duration: <seconds> s
Jev input tokens: <tokens>
Estimated inference cost: $<cost>
Video: artifacts/<run-id>/run.mp4
JSON: artifacts/<run-id>/report.json
```

Startup includes device selection, app launch, runner preparation, and recording setup. Duration starts with the QA loop and includes saving the recording and closing the session.

If the requested state is already visible, the run can pass without any actions. Ask the agent to repeat the navigation from a specific starting screen if you want to exercise the full path.

Exit codes are `0` for pass, `1` for fail, `2` for incomplete, and `3` for an error. Incomplete means the agent couldn't finish or confidently assess the result.

The video, screenshots, snapshots, and decision trace are saved in `artifacts/<run-id>/`. Inference cost uses returned token usage and `JEV_INPUT_USD_PER_MILLION`; it excludes device costs.

## Run limits

- Runs stop after 40 steps or 180 seconds by default. Adjust these with `--max-steps` and `--timeout`.
- Large screens can exceed Jev's 255-choice limit. Use `--scope` to focus on part of the app. The harness also caps each request's state at 80,000 characters.

## References

- [Introducing System One Models & Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)
- [Jev choice questions](https://docs.typesafe.ai/primitives/choice)
- [Confidence](https://docs.typesafe.ai/confidence)
- [agent-device Node.js API](https://oss.callstack.com/agent-device/docs/client-api)
- [agent-device snapshots](https://oss.callstack.com/agent-device/docs/snapshots)

