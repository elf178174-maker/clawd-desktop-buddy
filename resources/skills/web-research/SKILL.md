---
name: web-research
description: Researches a topic on the web, reads several sources and writes a sourced summary that separates what sources say from conclusions.
version: 1.0.0
author: Clawd
task_types: [research, compare, fact-check, summarize]
tools: [web_search, fetch_page, update_plan]
permissions: [web]
---
1. Call update_plan with the questions you need to answer.
2. web_search with 2-3 different phrasings. Prefer primary sources (official sites, papers, documentation) and recent material for current topics.
3. Read at least three relevant sources with fetch_page. Skip pages that are thin, duplicated or clearly promotional.
4. Write the answer:
   - Start with a 2-3 sentence direct answer.
   - Then the key points, each attributed: "According to <source>, ...".
   - Mark disagreements between sources and anything you could not verify.
   - End with "Sources" listing every URL you used.
5. Your own conclusions go in a separate, clearly labelled paragraph.
