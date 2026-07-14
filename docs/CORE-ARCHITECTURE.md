# Core architecture — read this before touching the dashboard code

The purpose of Data Wizard is that **AI does the intelligent work; code is only plumbing.**
This is not a nice-to-have. It is the product. The moment you replace an AI decision with a
hand-written rule, you have broken the app's reason to exist.

Nowhere is this more important than the dashboard flow, which is **two AI agents**:

## 1. The VizQL expert agent — designs the visualization

`viz-builder/spec.js → describeToSpec()`

It is an **expert in VizQL** (Tableau's Visual Query Language). Given a request — typed, spoken, or
a hand-drawn sketch read by vision — it decides, because it is the expert:

- the chart type (bar, line, area, pie, scatter, treemap via raw VizQL, …)
- which fields go on which shelves and encodings
- the aggregation, the grouping, cumulative vs per-period, how a date is handled
- the title and the story the chart should tell

These are **its** decisions. Not the code's.

## 2. The reviewer / self-heal agent — guarantees correctness before Slack

`viz-builder/spec.js → healChart()` (invoked from `viz-builder/deploy.js buildAndDeploy`)

Before a chart is ever posted to Slack, this agent **looks at the rendered image**, is told the
underlying data, and judges whether the view is actually correct and meaningful. If it is broken —
a flat line that should vary, a single point, a blank or unreadable plot, the wrong chart for the
data — it **regenerates a corrected chart itself** (back through the VizQL expert) and rebuilds.
A correct chart is recognized as good and left alone.

## The anti-pattern that caused days of circular debugging

Do **NOT** "fix" a chart problem by adding deterministic branches that make visualization decisions:

- ❌ hand-coded `DATE_TRUNC` / cumulative running-total / per-period rules
- ❌ `isDateChart` detection, chart-type maps, "skip the critic for X" branches
- ❌ any `if (chartType === …) …` that decides how to represent data

Every one of those fights the two agents, is brittle, and re-breaks through a different path. When a
chart is wrong, the fix is to **strengthen the agents** — the expert's prompt or the reviewer's
judgment — never to out-think them in code.

## What code IS allowed to do (plumbing only)

- publish the `.twbx` to Tableau, render the PNG, package the zip
- the SQL safety classifier (`guard.js`) — a safety gate, not a visualization decision
- work around genuine Tableau *infrastructure* limitations (e.g. the embedded-CSV date-truncation
  quirk) — but keep it minimal, and let the **reviewer agent** remain the real guarantee of
  correctness, not the workaround.

If you are about to write code that decides what a chart should look like: stop. That's the AI's job.
