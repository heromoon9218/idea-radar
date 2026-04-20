-- raw_signals.source の enum に note / reddit を追加。
-- 軽量ドメイン (クリエイター / 副業 / 個人 EC / 個人投資家 / 小規模コミュニティ主催) の痛みを
-- 日本語 (note) と英語 (reddit) の両面から拾うため。
-- ALTER TYPE ... ADD VALUE は冪等ではないので IF NOT EXISTS を付ける。
alter type source_type add value if not exists 'note';
alter type source_type add value if not exists 'reddit';
