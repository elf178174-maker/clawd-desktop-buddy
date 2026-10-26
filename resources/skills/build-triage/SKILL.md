---
name: build-triage
description: Investigates failing builds, tests and Claude Code errors, finds the cause and proposes a fix.
version: 1.0.0
author: Clawd
task_types: [debug, build, error, claude-code]
tools: [claude_code_sessions, claude_code_transcript, project_status, read_file, search_files, run_command]
permissions: [context, files_read, shell]
---
1. Find the failure: claude_code_sessions and claude_code_transcript for Claude Code work, otherwise ask where the build output is or read the error on screen (read_window_text).
2. Read the first real error, not the last line: compilers and test runners print the cause first and the summary last.
3. Locate the code involved with search_files / read_file and project_status (what changed recently is the usual suspect).
4. Explain in plain language: what failed, why, and the smallest fix. Show the exact lines to change.
5. Only run commands (run_command) to reproduce or verify, and say what you are running and why. Never push, reset or delete anything.
6. Do not edit files unless the user asks you to apply the fix.
