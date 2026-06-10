# 帰宅時刻表 PWA 実装計画（Claude Code 設計 / 実装は Codex 担当）

本書は `SPEC.md` を実装に落とすための設計・計画書。Claude Code が設計・計画・レビューを担当し、
実装は Codex に委譲する前提で、Codex に渡す指示単位（小さく分割）まで定義する。

---

## 1. 目的
- `SPEC.md` 記載の「帰宅時刻表」を、**フレームワークなしの静的 PWA**（HTML/CSS/JS のみ）として実装する。
- 固定ルート（西三荘/守口市 → 関目 →[徒歩4分]→ 関目成育 → 今里 →[乗換4分]→ 新深江）の
  成立ルート検索・カウントダウン・乗車中ルート保持・オフライン対応を実現する。
- GitHub Pages で相対パス配信できる構成にする。

## 2. 現状の把握
- リポジトリ内訳: `SPEC.md`（要件）/ `PLAN.md`（本書）/ `時刻表/`（本番CSV 4ファイル・格納済み）/ `.claude/`。git 未初期化。`commute-timetable/` 配下の実装ファイル・アイコンは未作成。
- **本番の平日ダイヤCSVは `時刻表/` に格納済み**（サンプルではなく実データ）。ファイル名は SPEC §5.1 と一致。フォーマットは `dep,arr` 2列・`HH:mm`/`24:xx`・終電 24:xx 含む（検証済み・異常行なし）。
  → 初期版はこの実データを `commute-timetable/data/` へ**そのままコピーして同梱**する（サンプルCSVは作らない）。`時刻表/` は更新元として残す。
- データ実測（終電）: nishisanso 23:50→24:00 / moriguchishi 23:53→24:00 / sekime_seiiku→imazato 24:04→24:13 / imazato→shinfukae 24:10→24:12。終電付近は乗換不成立の便があり、終電後表示（§12）と境界テストに使える。
- Node v22 / npx 利用可（テスト実行用途のみ。配信物には依存を持ち込まない）。実装は `codex` CLI 0.137.0 に委譲。

## 3. 変更対象ファイル（新規作成）
```
commute-timetable/
  index.html
  style.css
  app.js                 … 中核ロジック + DOM 描画（純粋関数は export してテスト可能にする）
  manifest.json
  service-worker.js
  version.js             … APP_VERSION / CSV_DATE 定数（更新時に手で書き換える1ファイル）
  icons/
    icon-192.png         … プレースホルダ（単色）
    icon-512.png         … プレースホルダ（単色）
  data/                  … 時刻表/ の本番CSV4ファイルをそのままコピー（内容改変禁止）
    keihan_nishisanso_to_sekime_weekday.csv
    keihan_moriguchishi_to_sekime_weekday.csv
    metro_sekime_seiiku_to_imazato_weekday.csv
    metro_imazato_to_shinfukae_weekday.csv
tests/
  logic.test.mjs         … node --test 用（SPEC §20 の観点を網羅）
README.md                … 起動方法・データ更新方法・デプロイ手順
```
- `SPEC.md` のファイル構成を尊重。追加は `version.js`（更新運用を1ファイルに集約）/ `tests/`（テスト観点を満たすため）/ `README.md` のみ。

## 4. アーキテクチャ上の設計判断（Claude Code 決定事項）
1. **app.js は単一ファイルのまま、純粋ロジックを `export`** し、DOM 初期化は
   `document.addEventListener('DOMContentLoaded', ...)` の中だけで行う。
   → Node からの `import` 時は `document` が無く DOM 初期化が走らないため、純粋関数を単体テストできる。
   → SPEC のファイル構成（app.js に集約）を崩さずテスト可能性を確保する妥協点。
   → `index.html` 側は `<script type="module" src="app.js">` で読み込む。
2. **時刻は「0:00 からの分数」を内部表現**にする（SPEC §9.1）。表示は元の `HH:mm`/`24:xx` 文字列を保持して使う。
3. **ルート生成は first 列車ごとの貪欲最早到着**で 1 候補を作り、その後に並び替え・支配除去・重複統合を行う（§8 準拠）。
4. **エラーは区間（CSV）単位で部分停止**（§15.3）。読み込めた区間だけで可能な範囲で動作継続。
5. **バージョン/CSV 更新日は `version.js` の定数**に集約。Service Worker のキャッシュ名にも `APP_VERSION` を使い、
   更新時のキャッシュ無効化を確実にする。

## 5. ルート計算アルゴリズム（中核・要レビュー）
区間定義（RouteCandidate のキーは SPEC §17.2 準拠）:
- `first` : origin → 関目        … `keihan_{origin}_to_sekime_weekday.csv`
- `second`: 関目成育 → 今里      … `metro_sekime_seiiku_to_imazato_weekday.csv`
- `third` : 今里 → 新深江        … `metro_imazato_to_shinfukae_weekday.csv`

成立条件（§7.2、4分ちょうど成立 = `<=`）:
- `first.arrMin + 4 <= second.depMin`
- `second.arrMin + 4 <= third.depMin`

生成手順（基準時刻 `baseMin`）:
1. `first.depMin >= baseMin` の各 first について:
   - `second.depMin >= first.arrMin + 4` を満たす **最早 second** を選ぶ。
   - その `second.arrMin + 4 <= third.depMin` を満たす **最早 third** を選ぶ。
   - 3 区間すべて取れたものだけを候補化（途中までは捨てる §7.3）。
   - `totalMinutes = third.arrMin - first.depMin`。
2. 並び替え・整理（§8.2）:
   - (a) `first.depMin` 昇順、(b) 同 dep は `third.arrMin` 昇順。
   - (c) **同一到着時刻は最も遅い出発のみ残す**（早い出発で同着 = 待つだけ損なので除外する支配フィルタ）。
   - (d) 同一 dep・同一 arr は 1 件に統合。
3. 表示: 先頭=最寄り1件、続く3件=次の候補（§8.3）。0件なら「本日の運行は終了しました」（§12）。

## 6. 画面・状態（要点のみ。詳細は SPEC §10–11, §16）
- 出発駅タブ（西三荘/守口市）: `selectedOrigin` を localStorage 保存・復元（§10.2）。
- モード: `current`（カウントダウン+「このルートを使う」あり）/ `manual`（指定時刻、カウントダウンと固定ボタンなし）。`mode`/`manualTime` を保存。
- 詳細表示: 同時 1 件のみ。`detailOpenRouteId` で管理。乗車中ルート保持とは別管理（§10.4）。
- 乗車中ルート（§11）: `activeRideRoute` を保存。出発超過・再読込・再起動でも復元。
  新深江到着 +5 分以内は「到着済み」、+5 分経過で通常復帰。現在時刻に応じて主表示を段階切替（§11.5）。
- カウントダウンは 1 秒間隔の `setInterval` で更新（秒表示はカウントダウンのみ §9.3）。
- 24:xx 表記は「当日扱い」。現在時刻が深夜帯（0:00〜終電）の場合は `現在分 + 1440` で 24:xx と比較する変換を入れる。

## 7. オフライン / 更新（§13–14）
- Service Worker: install 時に全静的ファイル + 4 CSV をプリキャッシュ。fetch は cache-first。
- 「データを更新」ボタン: SW へ `skipWaiting` 指示 → 全 CSV/静的ファイルを再取得しキャッシュ更新 → 失敗時は旧キャッシュ継続 + 画面にエラー表示（アプリは止めない §14.3）。
- キャッシュ名は `commute-timetable-${APP_VERSION}`。activate 時に旧バージョンキャッシュを削除。

## 8. エラー表示（§15）
- 検出対象: CSV 取得失敗 / ファイル不存在 / 時刻形式不正 / dep|arr 欠落 / 区間データ不足 / 空データ / 乗換計算不能。
- 表示: ファイル名・行番号・不正値・期待形式を提示（§15.2 形式）。該当区間を使うモードのみ停止。

## 9. 影響範囲
- 全て新規作成。既存挙動の破壊リスクなし（既存コードが無い）。
- 運用面: 本番ダイヤ投入時は `data/*.csv` 差し替え + `version.js` 更新 + 再デプロイ、の手順を README に明記。

## 10. リスクと対策
- **24:xx と現在時刻の比較ミス**（深夜帯の境界）→ テストで 23:59/24:00/24:10 を検証。
- **支配フィルタ（§8.2-3）の解釈ぶれ** → 「同一到着は最遅出発のみ」を明文化しテスト固定。
- **乗車中ルートの状態遷移**（出発前/各区間発車後/到着後5分）→ 時刻境界のテストを用意。
- **アイコン PNG** → 初期はプレースホルダ単色 PNG。本番アイコンは後で差し替え（README 明記）。
- **module 読み込み + file://** → GitHub Pages(http) 前提。ローカル確認は `npx serve` 等の簡易サーバ手順を README に記載（file:// だと SW/module/fetch が制限されるため）。

## 11. テスト方針（SPEC §20 準拠）
- `tests/logic.test.mjs` を `node --test tests/` で実行。app.js の export 関数を対象。
  - 時刻変換: 18:42→1122 / 24:10→1450 / 18-42 不正 / 25:00 不正 / 18:42:00 不正。
  - 乗換判定: 4分成立 / 3分不成立 / 関目乗換不成立で除外 / 今里乗換不成立で除外。
  - 候補生成: dep 昇順 / 同 dep は早着優先 / 同着は遅発のみ / 同一 dep・arr 統合 / 0件で終電後メッセージ用フラグ。
  - 乗車中状態: 出発前/区間発車後/到着後5分以内/5分経過 の判定関数。
- UI/SW は手動確認チェックリストを README に記載（自動化は初期版スコープ外）。

## 12. Codex へ渡す実装単位（小さく分割・順に委譲）
> 委譲バッチ: 実務上は **Batch1 = Unit1+Unit2（基盤+中核ロジック+テスト）/ Batch2 = Unit3+Unit4（UI+状態+乗車中）/ Batch3 = Unit5（PWA/SW/更新+README）** の3回に分けて `/codex:rescue` する。各バッチ後に Claude Code がレビューし、問題があれば `--resume` で修正依頼。
- **Unit 1 — 雛形 + データ**: `commute-timetable/` 作成、`時刻表/*.csv` 4ファイルを `data/` へコピー（**内容改変禁止**）、manifest.json、プレースホルダ icon(192/512)、version.js（APP_VERSION/CSV_DATE）、空雛形(index.html/style.css/app.js/service-worker.js)、README 雛形。動作確認: ファイルが揃い `data/` のCSVが元と一致。
- **Unit 2 — 中核ロジック（最重要）**: app.js に CSV パース・時刻検証/変換・ルート生成/並び替え/支配除去/重複統合・乗車中状態判定を **export 付き純粋関数**で実装。`tests/logic.test.mjs` を作成し `node --test` で全通過。DOM はまだ触らない。
- **Unit 3 — トップ描画 + タブ + モード**: index.html/style.css/app.js の DOM 部。出発駅タブ、現在/時刻指定モード、最寄り1件+次3件、所要時間、終電後表示、エラー表示。
- **Unit 4 — 詳細表示 + 乗車中ルート + localStorage**: 詳細展開（同時1件）、カウントダウン（1秒更新）、乗車中ルート固定/復元/自動終了/手動終了。
- **Unit 5 — PWA/オフライン/更新**: manifest 確定、service-worker.js（プリキャッシュ/cache-first/更新/旧キャッシュ削除）、データ更新ボタン、CSV更新日・アプリ版表示。
- 各 Unit 後に Claude Code がレビュー → 問題あれば次 Unit 前に修正依頼。

## 13. 完了条件
- 上記 Unit 1〜5 完了、`node --test` 全通過、README の手動確認チェックリストを満たす。
- 不要なリファクタ・計画外の大変更が無いこと。`data/` のCSVは `時刻表/` の本番データと一致（サンプル不使用・内容改変なし）。
- 残課題は本番アイコン画像の差し替え・CSV_DATE/APP_VERSION の実値設定など運用項目のみ。
</content>
</invoke>
