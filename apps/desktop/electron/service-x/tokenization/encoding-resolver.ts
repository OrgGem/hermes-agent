import type { OpenAiEncoding } from './tokenizer-contract'

export interface EncodingResolution {
  encoding?: OpenAiEncoding
  exact: boolean
  reason: string
}

function modelSlug(model: string): string {
  const normalized = model.trim().toLowerCase()
  const parts = normalized.split('/')

  return parts[parts.length - 1] ?? normalized
}

/**
 * Resolve only models whose OpenAI BPE family is known. Unknown provider
 * models are intentionally not silently counted as OpenAI tokens.
 */
export function resolveOpenAiEncoding(model: string): EncodingResolution {
  const slug = modelSlug(model)

  if (
    /^(gpt-3\.5|gpt-4(?:$|[-.]|\d)|text-(?:embedding|ada)|code-|davinci|curie|babbage|ada)/.test(slug) &&
    !/^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o[134](?:-|$))/.test(slug)
  ) {
    return { encoding: 'cl100k_base', exact: true, reason: 'known cl100k_base model family' }
  }

  if (/^(gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o[134](?:-|$)|chatgpt-4o)/.test(slug)) {
    return { encoding: 'o200k_base', exact: true, reason: 'known o200k_base model family' }
  }

  return { exact: false, reason: 'model is not mapped to an OpenAI tokenizer family' }
}
