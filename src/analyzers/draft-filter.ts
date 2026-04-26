// drafter 3 役割 (aggregator / combinator / gap_finder) が LLM 出力を受けた後の共通後処理。
// fermi_estimate / distribution_hypothesis が欠落しているアイデアは後段で必須扱いなので、
// ここで warn + filter out する。
// 併せて source_signal_ids を bundle 側の ID で上書きし、LLM が勝手に ID を削った場合を防ぐ。

import type { DraftCandidate, HaikuIdeaCandidate } from '../types.js';

export interface FinalizeDraftArgs {
  candidates: DraftCandidate[];
  overrideSignalIds: string[];
  logPrefix: string;
}

export function finalizeDraftCandidates({
  candidates,
  overrideSignalIds,
  logPrefix,
}: FinalizeDraftArgs): HaikuIdeaCandidate[] {
  const out: HaikuIdeaCandidate[] = [];
  let missingFermi = 0;
  let missingDist = 0;
  for (const c of candidates) {
    if (!c.fermi_estimate) {
      missingFermi++;
      console.warn(
        `${logPrefix} drop candidate without fermi_estimate: title="${c.title.slice(0, 40)}"`,
      );
      continue;
    }
    if (!c.distribution_hypothesis) {
      missingDist++;
      console.warn(
        `${logPrefix} drop candidate without distribution_hypothesis: title="${c.title.slice(0, 40)}"`,
      );
      continue;
    }
    out.push({
      ...c,
      fermi_estimate: c.fermi_estimate,
      distribution_hypothesis: c.distribution_hypothesis,
      source_signal_ids: overrideSignalIds,
    });
  }
  if (missingFermi > 0) {
    console.warn(
      `${logPrefix} fermi_estimate_missing=${missingFermi}/${candidates.length}`,
    );
  }
  if (missingDist > 0) {
    console.warn(
      `${logPrefix} distribution_hypothesis_missing=${missingDist}/${candidates.length}`,
    );
  }
  return out;
}
