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

## Experimental execution strategies

The default `baseline` strategy keeps the original settle-and-observe behavior. Two opt-in strategies reduce repeated work:

```sh
npm run qa -- --app com.example.app --strategy single-capture "Your task"
npm run qa -- --app com.example.app --strategy form-plan \
  'Fill Name with "Ada" and Email with "ada@example.com", save, and verify the confirmation.'
```

- `single-capture` skips the extra settle operation for press/fill/scroll. The next iteration still captures a full screen with fresh references. Loading screens can require additional decisions and waits.
- `form-plan` also asks Jev to map independent form fields to supplied values in one request. Additional fills require a fresh full snapshot, the same identifiable form, a unique enabled target, and a new reference. A rejected plan returns to an ordinary model decision. Submit, navigation, and QA verdicts always require a model decision.

Every planned fill consumes a step and honors cancellation and `--min-confidence`. Reports mark these steps with `source: "plan"` and `planOriginStep`; they do not count as additional model calls. A plan cannot bypass `--max-steps`.

These strategies are experimental. The form guard checks known modal/keyboard roles; it cannot detect every overlay or dependency between fields. Where iOS omits visibility/hittability metadata, it requires complete viewport geometry and retains agent-device's native interaction guards. Geometry is not proof of general visibility. Use baseline for flows whose dynamic behavior has not been validated. Benchmarks cover a small native iOS fixture, not Android or production apps.

The same controls are available from JavaScript:

```js
import { AgentDevice, FormPlanModel, JevDeviceAgent } from './src/index.mjs';

const agent = new JevDeviceAgent({
  model: new FormPlanModel(),
  device: new AgentDevice({ app: 'com.example.app', settle: false }),
  formPlans: true,
});
```

Run `npm test` and `npm run check` before submitting changes; neither requires credentials or a device.

To reproduce the controlled iOS benchmark, build the fixture with `npm run benchmark:build`, install `artifacts/fixture/JevBench.app` on a dedicated booted simulator, then run:

```sh
npm run benchmark -- --udid YOUR_SIMULATOR_UDID --model jev-1.13.0 --rounds 10 --output artifacts/benchmark
npm run benchmark:analyze -- artifacts/benchmark/results.json
npm run benchmark:export -- artifacts/benchmark/results.json artifacts/public-results.json
```

This runs 10 rounds of three tasks for each strategy, checks each outcome independently, and records source hashes. The primary timer excludes app setup and final screenshot/cleanup; full trial time is recorded separately. Use `--record --rounds 1 --output artifacts/demo` for separate demonstration videos, which must not be pooled with unrecorded timing samples. Live runs require Xcode and your own TypeSafe API key. Never commit `.env` or unsanitized artifacts; the export command excludes personal paths, device IDs, and raw screen data.

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

