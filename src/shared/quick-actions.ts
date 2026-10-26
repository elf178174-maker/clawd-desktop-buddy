// Context-aware quick actions for the side-buddy panel, and one-tap tweaks for writing results.

import type { SummonContext } from './api'

export interface QuickAction {
  id: string
  label: string
  prompt: string
  primary?: boolean
  /** Skill whose instructions are pre-loaded for this action. */
  skill?: string
  /** The result rewrites the draft or the selection (only then can it replace it). */
  applyTo?: 'draft' | 'selection'
}

const REDDIT_THREAD = /^https?:\/\/([a-z]+\.)?reddit\.com\/r\/[^/]+\/comments\//i

export function siteOf(url?: string): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

export function quickActionsFor(ctx: SummonContext | null): QuickAction[] {
  const out: QuickAction[] = []
  const url = ctx?.url
  if (url && REDDIT_THREAD.test(url)) {
    if (ctx?.draft) out.push({ id: 'refine-comment', label: 'Refine my comment', prompt: 'Refine my comment for this thread: fix grammar, capitalisation, punctuation and spelling, split run-on sentences, and make it clear and natural, while keeping my opinion, voice and tone.', primary: true, skill: 'comment-refine', applyTo: 'draft' })
    out.push({ id: 'sum-thread', label: 'Summarize the thread', prompt: 'Summarize this Reddit thread: what the post says or asks, the main points and disagreements in the comments, and the most useful answers.', primary: !ctx?.draft })
    if (!ctx?.draft) out.push({ id: 'help-reply', label: 'Help me reply', prompt: 'Help me write a good reply to this post. Ask me what I want to say if it is not clear.', skill: 'comment-refine', applyTo: 'draft' })
  } else if (url) {
    if (ctx?.draft) out.push({ id: 'refine-draft', label: "Refine what I'm writing", prompt: 'Refine what I am writing in the text box on this page, in the context of the page: fix grammar, capitalisation and spelling, make it clear and natural, keep my voice.', primary: true, skill: 'comment-refine', applyTo: 'draft' })
    out.push({ id: 'sum-page', label: 'Summarize this page', prompt: 'Summarize this entire web page.', primary: !ctx?.draft })
    out.push({ id: 'takeaways', label: 'Key takeaways', prompt: 'What are the key takeaways of this page for me? Be brief.' })
  }
  if (ctx?.selection) {
    out.push(
      { id: 'refine', label: 'Refine', prompt: 'Refine the selected text: clearer and more natural, correct grammar, capitalisation and spelling, same meaning and voice.', primary: !out.some((a) => a.primary), skill: 'writing-polish', applyTo: 'selection' },
      { id: 'shorten', label: 'Shorten', prompt: 'Shorten the selected text without losing any point.', skill: 'writing-polish', applyTo: 'selection' },
      { id: 'grammar', label: 'Fix grammar', prompt: 'Fix grammar, capitalisation, punctuation and spelling in the selected text. Change nothing else.', skill: 'writing-polish', applyTo: 'selection' },
      { id: 'explain', label: 'Explain', prompt: 'Explain the selected text in simple terms.' },
    )
  }
  if (!out.length) {
    if (ctx?.title && /error|exception|failed|warning|crash/i.test(ctx.title)) out.push({ id: 'explain-error', label: 'Explain this error', prompt: 'Explain the error on my screen and how to fix it.', primary: true })
    out.push({ id: 'screen', label: "What's on my screen?", prompt: 'Briefly tell me what I am looking at in the active window.' })
  }
  return out.slice(0, 4)
}

export const TWEAKS: QuickAction[] = [
  { id: 'shorter', label: 'Shorter', prompt: 'Make it shorter.' },
  { id: 'casual', label: 'More casual', prompt: 'Make it more casual and natural.' },
  { id: 'formal', label: 'More formal', prompt: 'Make it more formal.' },
  { id: 'friendlier', label: 'Friendlier', prompt: 'Make it friendlier without losing the point.' },
]

/** Whether a typed request asks for a piece of writing the user may want to tweak (not "reply with just the number"). */
export function isWritingTask(request: string): boolean {
  return /\b(refine|rewrite|reword|shorten|polish|proofread|fix (the |my )?grammar|translate|(write|draft|compose) (a|an|me|my|the|some)\b|reply to|make (it|this) (shorter|longer|more|less|friendlier|clearer|simpler))/i.test(request)
}
