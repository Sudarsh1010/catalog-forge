/**
 * Translation locales (spec user story 15: German and French, generated
 * ahead of time). The source locale is the sheet's cleaned English-side
 * content; targets are fixed so the translate Stage's Batch plan
 * (product-batch × locale) is deterministic from day one.
 */
export const SOURCE_LOCALE = "en"

export const TARGET_LOCALES = ["de", "fr"] as const

export type TargetLocale = (typeof TARGET_LOCALES)[number]
