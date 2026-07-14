# Data Wizard — end-to-end test report

**38/38 passed** · 140s total · 2026-07-14T08:23:23.918Z

| # | Test | Result | Detail | ms |
|---|------|--------|--------|----|
| A01 | route: "help" | ✅ | → {"intent":"help"} | 2498 |
| A02 | route: "what can you do?" | ✅ | → {"intent":"help"} | 842 |
| A03 | route: "where I am?" | ✅ | → {"intent":"context"} | 2253 |
| A04 | route: "¿dónde estoy trabajando?" | ✅ | → {"intent":"context"} | 1137 |
| A05 | route: "USE CATALOG Finance!!!" | ✅ | → {"intent":"use_catalog","name":"Finance"} | 1129 |
| A06 | route: "switch me over to the sales schema please" | ✅ | → {"intent":"use_schema","name":"sales"} | 1063 |
| A07 | route: "generate 20 fake vendors with contact emails" | ✅ | → {"intent":"generate_data","description":"20 fake vendors with contact emails","source":"synthetic"} | 1251 |
| A08 | route: "create a table of the top 10 countries by population" | ✅ | → {"intent":"generate_data","description":"top 10 countries by population","source":"real"} | 1348 |
| A09 | route: "let's crate a dashboard" | ✅ | → {"intent":"dashboard","description":"Create a dashboard"} | 2427 |
| A10 | route: "I want to draw a dashboard" | ✅ | → {"intent":"draw_dashboard"} | 1393 |
| A11 | route: "let me sketch a table for you" | ✅ | → {"intent":"draw_table"} | 1337 |
| A12 | route: "how many signups per country?" | ✅ | → {"intent":"query"} | 1188 |
| A13 | route: "delete all the inactive users" | ✅ | → {"intent":"query"} | 1367 |
| A14 | route edge: gibberish falls back safely | ✅ | → query | 932 |
| B01 | read query plans without confirmation | ✅ | SELECT `country_code`, COUNT(*) AS `signup_count` FROM `hackathon_signups` GROUP BY `country_code` ORDER BY `signup_count` DESC LIMIT 100 | 21036 |
| B02 | read query executes and returns rows | ✅ | 3 rows, first: {"country_code":"US","signup_count":"6"} | 7613 |
| B03 | listing: "list the tables" → SHOW, executable | ✅ | 10 tables | 3858 |
| B04 | DDL: create schema plans as CREATE (not executed) | ✅ | CREATE SCHEMA IF NOT EXISTS qa_e2e_scratch · needsConfirmation=false | 2347 |
| B05 | destructive: DROP requires confirmation (not executed) | ✅ | DROP TABLE hackathon_signups_bronze | 2665 |
| B06 | guard: stacked statements rejected | ✅ | Refusing 2 statements at once; send one | 1 |
| B07 | guard edge: destructive keyword inside a string literal is READ | ✅ | read, not destructive | 0 |
| B08 | degenerate SQL detector catches empty IN-lists | ✅ | contains empty string literals (e.g. IN ('', '')) | 0 |
| B09 | unanswerable question fails gracefully | ✅ | The schema contains no data about unicorn weights. | 3398 |
| C01 | synthetic data: 5 fake employees | ✅ | 5 rows · cols: name,salary | 1585 |
| C02 | real data via Perplexity: cited figures | ✅ | 5 rows · 12 citations | 2346 |
| C03 | CSV edge: quoted comma inside a value | ✅ | parsed correctly | 1 |
| D01 | vague request anchors NO table (bot must ask) | ✅ | asks the user, as designed | 1152 |
| D02 | fuzzy table reference resolves via model | ✅ | → hackathon_signups | 1851 |
| D03 | bar spec for a named table | ✅ | bar: country_code × COUNT(signup_id) | 3359 |
| D04 | pie spec for share-per-category | ✅ | pie: Country × Nominal_GDP_USD_Trillions_ | 2921 |
| D05 | treemap → model speaks raw VizQL | ✅ | vizql mark=Square, encodings: size,color,label | 2944 |
| D06 | edge: nonsense column request stays schema-valid | ✅ | coped: Country×Nominal_GDP_USD_Trillions_ | 3068 |
| D07 | FULL BUILD: bar chart published to Tableau + PNG | ✅ | workbook 4196872d… · PNG 19802 bytes | 5212 |
| D08 | FULL BUILD: pie with legend/labels published + PNG | ✅ | PNG 55793 bytes (labels+legend present) | 4546 |
| E01 | scanned PDF → typed table (OpenAI vision) | ✅ | 6 cols × 7 rows via openai | 19562 |
| E02 | whiteboard table sketch → Databricks table | ✅ | dbdemos.data_wizard.qa_e2e_fruit · 3 rows · cols: Fruit,Qty,Price | 9558 |
| E03 | whiteboard pie sketch + hint → published dashboard | ✅ | read as "a pie chart of GDP by country from countries_gdp…" → pie from countries_gdp | 19377 |
| F01 | TTS → STT round-trip preserves the question | ✅ | spoke 15090B of audio, heard back: "How many signups per country?" | 941 |

## Manual-only cases (need a live Slack client)

- M01 Voice note in Slack → transcription + table + spoken clip (verified by hand 2026-07-13)
- M02 CSV drop → Card + Data Table preview → Load modal (placeholder→form on cold warehouse)
- M03 Destructive confirm/cancel buttons; SQL never runs before the click
- M04 "draw a dashboard" → whiteboard link button → chart posts back to the channel
- M05 Dashboard table-picker select → chart built from the chosen table
- M06 Bot's own uploads (mp3/PNG) do not re-trigger file_shared
