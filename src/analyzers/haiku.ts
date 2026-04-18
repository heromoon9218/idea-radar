// Haiku で raw_signals を個人開発アイデア候補に構造化する。
// - signals を chunk (40件) に分割し、各 chunk で submit_candidates を parse
// - 同じ痛みを指すシグナルは 1 候補にマージ (LLM 判定、chunk 内)
// - chunk 間の重複は後段で title+category の exact match で軽く dedup
// - 無効な source_signal_ids (入力にない UUID) は除外

import { callParsed } from '../lib/anthropic.js';
import {
  HaikuOutputSchema,
  type HaikuIdeaCandidate,
  type HaikuSignalInput,
} from '../types.js';

export const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
export const HAIKU_CHUNK_SIZE = 40;
// 候補は 1 chunk あたり最大 10 件程度を想定。余裕を持って 4096 token。
const HAIKU_MAX_TOKENS = 4096;

const HAIKU_SYSTEM = `あなたは個人開発者向けのアイデア発掘アシスタントです。
与えられたシグナル（ブログ・技術投稿・Ask HN など）から、
エンジニアの「痛み」「不満」「ニーズ」を抽出し、個人開発で実現可能なアイデアに変換します。

判断基準:
- 個人開発者が 1〜3 ヶ月で MVP を出せる規模であること
- 「自分も使いたい」と思える具体性があること
- category は dev-tool / productivity / saas / ai / other のいずれか
- 痛みが明確でないシグナル (単なるニュース紹介、リリースノート告知、自慢話) は候補から除外してよい
- 複数のシグナルが同じ痛みを指すなら 1 つにマージし、source_signal_ids に全ての UUID を含める
- raw_score (1-5) は「個人開発候補としての筋の良さ」の粗評価。5 = 今すぐ作りたい、1 = 痛みが弱い
- 候補が 0 件のときは candidates: [] を返す
- pain_summary / idea_description は日本語で 1〜3 文に収める

HN 固有の hn_story_type ヒント (HN シグナルのみに付与される):
- "ask"    = Ask HN。具体的な質問・相談で痛みが露出している確率が高い。最優先で精読する
- "show"   = Show HN。自作プロダクト発表。模倣元/隣接ドメインへの移植ネタとして価値が高い
- "launch" = Launch HN (YC バッチのローンチ告知)。需要検証が済んだ事例として筋が良い
- "tell"   = Tell HN。知見共有。中程度
- "normal" = 通常投稿。ニュース紹介や自慢話が多くノイズ比が高いので、痛みが明確な場合以外は除外寄り
- ask / show / launch は raw_score を +1 してよい (上限 5)。ただし痛みが弱い・単なる告知のみの場合は上乗せしない`;

function buildUserPrompt(signals: HaikuSignalInput[]): string {
  return [
    `以下 ${signals.length} 件のシグナルから個人開発アイデア候補を抽出してください。`,
    `各シグナルの id は UUID です。source_signal_ids にはそのまま入力の UUID を使ってください。`,
    '',
    JSON.stringify(signals, null, 2),
  ].join('\n');
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// chunk 間の素朴な重複排除: title (normalized) + category が完全一致したら
// source_signal_ids をマージし、raw_score は大きい方を採用。
function mergeDuplicates(
  candidates: HaikuIdeaCandidate[],
): HaikuIdeaCandidate[] {
  const byKey = new Map<string, HaikuIdeaCandidate>();
  for (const c of candidates) {
    const key = `${c.category}|${c.title.trim().toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, c);
      continue;
    }
    const mergedIds = new Set([...existing.source_signal_ids, ...c.source_signal_ids]);
    byKey.set(key, {
      ...existing,
      raw_score: Math.max(existing.raw_score, c.raw_score),
      source_signal_ids: Array.from(mergedIds),
    });
  }
  return Array.from(byKey.values());
}

export async function extractIdeas(
  signals: HaikuSignalInput[],
): Promise<HaikuIdeaCandidate[]> {
  if (signals.length === 0) return [];

  const validIds = new Set(signals.map((s) => s.id));
  const chunks = chunk(signals, HAIKU_CHUNK_SIZE);

  console.log(
    `[haiku] signals=${signals.length} chunks=${chunks.length} size=${HAIKU_CHUNK_SIZE}`,
  );

  const perChunk = await Promise.all(
    chunks.map(async (part, idx) => {
      try {
        const parsed = await callParsed({
          model: HAIKU_MODEL,
          system: HAIKU_SYSTEM,
          user: buildUserPrompt(part),
          schema: HaikuOutputSchema,
          maxTokens: HAIKU_MAX_TOKENS,
          logPrefix: `[haiku chunk=${idx + 1}/${chunks.length}]`,
        });
        return parsed.candidates;
      } catch (err) {
        console.warn(
          `[haiku] chunk ${idx + 1}/${chunks.length} failed, skipping:`,
          err instanceof Error ? err.message : err,
        );
        return [];
      }
    }),
  );

  // 無効な signal_id を除外しつつフラット化
  const flattened: HaikuIdeaCandidate[] = [];
  for (const cs of perChunk) {
    for (const c of cs) {
      const filtered = c.source_signal_ids.filter((id) => validIds.has(id));
      if (filtered.length === 0) {
        console.warn(`[haiku] drop candidate (no valid source ids): ${c.title}`);
        continue;
      }
      flattened.push({ ...c, source_signal_ids: filtered });
    }
  }

  const deduped = mergeDuplicates(flattened);
  console.log(
    `[haiku] candidates=${flattened.length} after_dedup=${deduped.length}`,
  );
  return deduped;
}
