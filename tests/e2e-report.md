# Data Wizard — end-to-end test report

**38/38 passed** · 147s total · 2026-07-14T08:35:57.966Z

| # | Test | Result | Detail | ms |
|---|------|--------|--------|----|
| A01 | route: "help" | ✅ | → {"intent":"help"} | 2064 |
| A02 | route: "what can you do?" | ✅ | → {"intent":"help"} | 957 |
| A03 | route: "where I am?" | ✅ | → {"intent":"context"} | 1141 |
| A04 | route: "¿dónde estoy trabajando?" | ✅ | → {"intent":"context"} | 1505 |
| A05 | route: "USE CATALOG Finance!!!" | ✅ | → {"intent":"use_catalog","name":"Finance"} | 918 |
| A06 | route: "switch me over to the sales schema please" | ✅ | → {"intent":"use_schema","name":"sales"} | 1254 |
| A07 | route: "generate 20 fake vendors with contact emails" | ✅ | → {"intent":"generate_data","description":"20 fake vendors with contact emails","source":"synthetic"} | 1100 |
| A08 | route: "create a table of the top 10 countries by population" | ✅ | → {"intent":"generate_data","description":"top 10 countries by population","source":"real"} | 1585 |
| A09 | route: "let's crate a dashboard" | ✅ | → {"intent":"dashboard"} | 1026 |
| A10 | route: "I want to draw a dashboard" | ✅ | → {"intent":"draw_dashboard"} | 1185 |
| A11 | route: "let me sketch a table for you" | ✅ | → {"intent":"draw_table"} | 1262 |
| A12 | route: "how many signups per country?" | ✅ | → {"intent":"query"} | 1060 |
| A13 | route: "delete all the inactive users" | ✅ | → {"intent":"query"} | 1113 |
| A14 | route edge: gibberish falls back safely | ✅ | → query | 1068 |
| B01 | read query plans without confirmation | ✅ | SELECT country_code, COUNT(*) AS signup_count FROM hackathon_signups GROUP BY country_code ORDER BY signup_count DESC LIMIT 100 | 21988 |
| B02 | read query executes and returns rows | ✅ | 3 rows, first: {"country_code":"US","signup_count":"6"} | 2929 |
| B03 | listing: "list the tables" → SHOW, executable | ✅ | 10 tables | 4913 |
| B04 | DDL: create schema plans as CREATE (not executed) | ✅ | CREATE SCHEMA IF NOT EXISTS qa_e2e_scratch · needsConfirmation=false | 2896 |
| B05 | destructive: DROP requires confirmation (not executed) | ✅ | DROP TABLE hackathon_signups_bronze | 2216 |
| B06 | guard: stacked statements rejected | ✅ | Refusing 2 statements at once; send one | 0 |
| B07 | guard edge: destructive keyword inside a string literal is READ | ✅ | read, not destructive | 0 |
| B08 | degenerate SQL detector catches empty IN-lists | ✅ | contains empty string literals (e.g. IN ('', '')) | 0 |
| B09 | unanswerable question fails gracefully | ✅ | The schema contains no information about unicorns or their weight. | 3083 |
| C01 | synthetic data: 5 fake employees | ✅ | 5 rows · cols: name,salary | 1615 |
| C02 | real data via Perplexity: cited figures | ✅ | 5 rows · 12 citations | 2375 |
| C03 | CSV edge: quoted comma inside a value | ✅ | parsed correctly | 0 |
| D01 | vague request anchors NO table (bot must ask) | ✅ | asks the user, as designed | 2825 |
| D02 | fuzzy table reference resolves via model | ✅ | → hackathon_signups | 2014 |
| D03 | bar spec for a named table | ✅ | bar: country_code × COUNT(signup_id) | 3153 |
| D04 | pie spec for share-per-category | ✅ | pie: Country × Nominal_GDP_USD_Trillions_ | 2701 |
| D05 | treemap → model speaks raw VizQL | ✅ | vizql mark=Square, encodings: size,color,label,label | 4512 |
| D06 | edge: nonsense column request stays schema-valid | ✅ | coped: Country×Nominal_GDP_USD_Trillions_ | 3063 |
| D07 | FULL BUILD: bar chart published to Tableau + PNG | ✅ | workbook 4196872d… · PNG 19802 bytes | 9250 |
| D08 | FULL BUILD: pie with legend/labels published + PNG | ✅ | PNG 55793 bytes (labels+legend present) | 5872 |
| E01 | scanned PDF → typed table (OpenAI vision) | ✅ | 6 cols × 7 rows via openai | 22251 |
| E02 | whiteboard table sketch → Databricks table | ✅ | dbdemos.data_wizard.qa_e2e_fruit · 3 rows · cols: Fruit,Qty,Price | 9310 |
| E03 | whiteboard pie sketch + hint → published dashboard | ✅ | read as "a pie chart of GDP by country from countries_gdp…" → pie from countries_gdp | 20452 |
| F01 | TTS → STT round-trip preserves the question | ✅ | spoke 15508B of audio, heard back: "How many signups per country?" | 853 |

## Manual-only cases (need a live Slack client)

- M01 Voice note in Slack → transcription + table + spoken clip (verified by hand 2026-07-13)
- M02 CSV drop → Card + Data Table preview → Load modal (placeholder→form on cold warehouse)
- M03 Destructive confirm/cancel buttons; SQL never runs before the click
- M04 "draw a dashboard" → whiteboard link button → chart posts back to the channel
- M05 Dashboard table-picker select → chart built from the chosen table
- M06 Bot's own uploads (mp3/PNG) do not re-trigger file_shared
