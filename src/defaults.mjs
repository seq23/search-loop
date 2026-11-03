// Leaf module (no imports) so config, cap and distinct can share defaults without an import cycle.
export const CAP_DEFAULTS = { max_live_pages: null, start_pages: 20, min_pages: 10, grow_share: 0.1, max_per_day: 10 };
export const DISTINCT_DEFAULTS = { jaccard: 0.6, containment_min_words: 3, same_answer: 0.5, sitemap_files: null };
