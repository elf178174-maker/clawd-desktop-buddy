---
name: writing-polish
description: Rewrites, shortens, translates or polishes text (comments, emails, posts, documents) while keeping the author's meaning and voice.
version: 1.0.0
author: Clawd
task_types: [rewrite, edit, translate, grammar, tone, summarize]
tools: [get_selected_text, memory_search, clipboard_write]
permissions: [context, clipboard]
---
Use this for any request to improve or transform a piece of writing.

1. Get the text: the user's selection (get_selected_text) or the text they pasted. If there is none, ask for it.
2. Check memory_search for the user's writing preferences (tone, spelling variant, sign-offs) and apply them.
3. Keep the meaning, facts, names, links and formatting. Change only what the request asks for:
   - "clearer": shorter sentences, plain words, one idea per sentence.
   - "more professional": neutral tone, no slang, no exaggeration; keep it warm.
   - "shorten": cut repetition and filler first, never drop a point the author made.
   - "fix grammar": only correct errors; do not restyle.
   - translations: natural target-language phrasing, same register.
   - several items (e.g. a list of comments): handle each one separately and keep their order.
4. Put the finished text inside <result></result> (no preface, no quotes around it), so it can be copied or put back in place directly. If you made a judgment call, add one short note after </result>.
