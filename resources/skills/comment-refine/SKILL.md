---
name: comment-refine
description: Refines the user's comment or reply (Reddit, forums, YouTube, GitHub, social media) in the context of the post they are replying to.
version: 1.0.0
author: Clawd
task_types: [reddit, comment, reply, refine, rewrite]
tools: [browser_get_page, browser_get_draft, get_selected_text, memory_search]
permissions: [browser, context]
---
Use this when the user wants help with a comment or reply they are writing.

1. Read the thread: browser_get_page (scroll=false is enough for the post and visible comments). Note the subreddit or site, the post's topic, its tone, and what the user is replying to if it is clear.
2. Get the user's draft: it may already be in your context; otherwise browser_get_draft, then get_selected_text. If neither has text, ask the user to click into their comment box or paste their draft.
3. memory_search for the user's writing preferences.
4. Refine the draft:
   - Keep the user's opinion, claims, personality and language. Do not add facts, arguments or links they did not make.
   - Make it clear and easy to read: fix grammar, spelling, capitalisation ("i" -> "I", proper nouns like Go, Rust, Windows) and punctuation; split run-on sentences; tighten wordy phrases; keep paragraphs short.
   - Match the place: casual and natural for Reddit (no corporate tone, no hashtags, no emoji unless they used some), constructive for GitHub, and fitting the subreddit's norms.
   - If the draft could come across as rude or could be misread, soften it while keeping the point.
   - Respond to the actual post: if the draft misreads the post, point it out briefly after the comment.
   - Keep the writer's hedges and voice words ("I think", "honestly", "imo", "lol"): they are part of how they talk. Every one of them in the draft must still be in your version (you may move it, e.g. "...start with honestly" -> "Honestly, ... start with").

Example
Draft: honestly i dont get why people hate on python its fine for most stuff and the libraries are insane lol
<result>
Honestly, I don't get why people hate on Python. It's fine for most stuff, and the libraries are insane, lol.
</result>

5. Put ONLY the refined comment inside <result></result>. If something important needs saying (a misread, a factual doubt, a thread you could not read), add one short note after </result>.
