// 重いドメイン (個人開発で月 5 万円達成が構造的に困難なドメイン) の early filter。
//
// 個人開発で月 5 万円を狙う設計上、以下の領域は構造的に勝ち目が薄い:
// - 士業 (税理士・弁護士・会計士・司法書士・社労士): 商談サイクルが長く、既存ベンダー (freee, MoneyForward 等) が固い
// - 医療・介護: 規制が重く (薬機法 / SaMD / HIPAA 相当)、保険点数の壁、個人開発で運用しきれない
// - 飲食店・宿泊経営: 既存 POS / 予約システムベンダーが寡占、現場 IT リテラシーが低い
// - 中小製造・建設・リフォーム: 個人 SaaS が届かない (代理店 / 直営業ネットワーク必須)
// - エンタープライズ SaaS / SAP / Salesforce 連携: 営業組織必須、調達プロセスが長期
//
// このファイルではタイトル + 本文に対する正規表現マッチで heavy_domain=true を判定し、
// collect 時に metadata.heavy_domain として全 signal に付与する。
// Haiku プロンプトで「heavy_domain=true の signal は集約バンドル / 結合 pain 側から除外し、
// gap_candidates の other に分類する」指示を加え、起草段階に到達する候補から重いドメインを薄める。
//
// 完全 skip ではなく **タグ付け方式** を採用する理由:
//   1. 誤検知 (例: "freelancing で受けた医療系案件" のような freelancing pain) を救済できる
//   2. raw_signals 自体は保持するので、後で集計したり方針転換したい時に遡れる
//   3. heavy_domain でも「個人で痛みを感じた経験談」(他 SE サイトに紛れた重いドメイン質問等)
//      は gap_candidate other 経由で稀に拾われる余地を残せる

// 単語境界マッチに頼らず substring マッチで運用する (日本語は \b が機能しないため)。
// 偽陽性は許容範囲: "税" だけでマッチさせると "増税" "節税" 等の家計系で誤爆するので、
// 必ず複合語キーワード (税理士 / 税務署 / 確定申告) で絞り込む。
const HEAVY_DOMAIN_KEYWORDS_JA: readonly string[] = [
  // 士業 (個人事業主側のペインは freelancing で拾うので、ここでは「業界そのもの」を指す語のみ)
  '税理士事務所',
  '弁護士事務所',
  '会計事務所',
  '司法書士事務所',
  '行政書士事務所',
  '社労士事務所',
  // 医療・介護
  '医療機関',
  '医療現場',
  '病院経営',
  'クリニック経営',
  '介護施設',
  '介護事業',
  '老人ホーム',
  'デイサービス',
  '訪問介護',
  '電子カルテ',
  '医薬品',
  '薬機法',
  // 飲食店・宿泊
  '飲食店経営',
  '居酒屋経営',
  'レストラン経営',
  'ホテル経営',
  '旅館経営',
  '民泊経営',
  '飲食店向け',
  // 中小製造・建設
  '町工場',
  '中小製造業',
  '建設業者',
  '建設会社',
  '工務店',
  'リフォーム業',
  '土木業',
  '建設DX',
  '製造業DX',
  // エンプラ
  'エンタープライズ向け',
  'SAP導入',
  'Salesforce導入',
  'ERP導入',
  '基幹システム',
];

const HEAVY_DOMAIN_KEYWORDS_EN: readonly string[] = [
  // 士業
  'tax accountant firm',
  'law firm',
  'accounting firm',
  'CPA firm',
  // 医療・介護
  'electronic health record',
  'EHR system',
  'EMR system',
  'hospital management',
  'clinic management',
  'medical device',
  'SaMD',
  'HIPAA compliance',
  // 飲食・宿泊
  'restaurant POS',
  'hotel management system',
  'PMS for hotels',
  // 製造・建設
  'construction management',
  'manufacturing ERP',
  'plant maintenance',
  // エンプラ
  'enterprise SaaS',
  'enterprise software',
  'SAP integration',
  'Salesforce integration',
];

// substring を OR 連結。HEAVY_DOMAIN_KEYWORDS_JA は日本語のため \b が効かず、
// substring 一致で十分。EN は単語境界 \b で囲んで誤爆を防ぐ。
const HEAVY_DOMAIN_RE_JA = new RegExp(
  HEAVY_DOMAIN_KEYWORDS_JA.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
);
const HEAVY_DOMAIN_RE_EN = new RegExp(
  '\\b(' +
    HEAVY_DOMAIN_KEYWORDS_EN.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    ')\\b',
  'i',
);

// title + content (両方をスペースで結合) に対してマッチ判定。
// content が長い場合は先頭 2000 chars だけ見れば十分 (重いドメインは冒頭に書かれる)。
export function detectHeavyDomain(title: string, content: string | null): boolean {
  const haystack = `${title} ${(content ?? '').slice(0, 2000)}`;
  return HEAVY_DOMAIN_RE_JA.test(haystack) || HEAVY_DOMAIN_RE_EN.test(haystack);
}
