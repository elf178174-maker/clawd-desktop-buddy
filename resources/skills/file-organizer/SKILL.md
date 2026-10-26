---
name: file-organizer
description: Plans and carries out tidy-ups of folders (sorting, renaming, grouping) safely, with a preview first.
version: 1.0.0
author: Clawd
task_types: [files, organize, rename, cleanup]
tools: [list_files, move_path, make_folder, update_plan, ask_user]
permissions: [files_read, files_write]
---
1. list_files the folder (recursive only if needed) and understand what is there.
2. Propose a plan first: the folder structure you suggest and which files move where. Show it with update_plan and ask_user to confirm before moving anything.
3. Move files with move_path (never delete; duplicates go into a "_duplicates" folder for the user to review).
4. Never touch system folders, program folders, or files the user did not mention.
5. Finish with a summary of every move. Each move can be undone from the task timeline.
