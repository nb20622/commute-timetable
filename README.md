# 帰宅時刻表

Android Chrome と GitHub Pages を対象にした、素のHTML/CSS/JavaScript製の
平日帰宅ルート専用PWAです。西三荘または守口市から新深江までの成立ルートを、
同梱CSVから計算します。

## ローカル起動

Service Worker、ES module、CSVの取得にはHTTP配信が必要です。`file://` では
確認できません。リポジトリ直下で静的HTTPサーバーを起動し、
`http://localhost:8000/commute-timetable/` を開きます。

```sh
python3 -m http.server 8000
```

Service WorkerはlocalhostまたはHTTPSでのみ動作します。SWを変更した際は、
Chrome DevToolsのApplication画面で登録状態とCache Storageも確認してください。

## テスト

外部依存は不要です。

```sh
node --test tests/
node --check commute-timetable/service-worker.js
```

## オフラインと更新

初回表示時に、画面、JavaScript、manifest、アイコン、4本のCSVをService Workerが
プリキャッシュします。初回表示が完了した後は、通信を切断してもキャッシュ済みの
時刻表を利用できます。

フッタの「データを更新」はService Workerの更新確認後、全対象ファイルを
ネットワークから再取得します。全取得が成功した場合だけキャッシュを更新して
ページを再読み込みします。失敗時は旧キャッシュを残し、画面にエラーを表示します。

## ダイヤとバージョンの更新

1. 更新元の `時刻表/` に本番CSV 4ファイルを配置する。
2. 各CSVを `commute-timetable/data/` へ内容を変えずコピーする。
3. `diff` で更新元と配置先が一致することを確認する。
4. `commute-timetable/version.js` の `CSV_DATE` と `APP_VERSION` を更新する。
5. `commute-timetable/service-worker.js` 冒頭の `APP_VERSION` を同じ値にする。
6. テストと手動確認を実施してからデプロイする。

`APP_VERSION` を変更すると、新しいService Workerの有効化時に旧版キャッシュが
削除されます。

## PWAとホーム画面追加

HTTPSで公開後、Android Chromeでページを開き、ブラウザメニューの
「ホーム画面に追加」またはインストール案内から追加します。ホーム画面から起動すると
manifestの `display: standalone` により単独アプリ風に表示されます。

## GitHub Pages

1. リポジトリをGitHubへpushする。
2. GitHub Pagesの公開元を、`commute-timetable/` が配信されるブランチに設定する。
3. 公開URLの `/commute-timetable/` を開く。
4. HTTPS配信、manifest、Service Worker登録、アイコン取得を確認する。

必要に応じてGitHub Actionsで `commute-timetable/` のみをPages artifactとして
配置できます。アプリ内の参照は相対パスのため、リポジトリ名配下でも動作します。

## 手動確認チェックリスト

- [ ] 西三荘／守口市タブを切り替え、再読み込み後も選択が復元される。
- [ ] 現在時刻モードと時刻指定モードを切り替え、指定した `HH:mm` / `24:xx` が復元される。
- [ ] 最寄り1件と次の候補最大3件に、発着時刻と所要時間が表示される。
- [ ] 成立候補が0件の時刻で「本日の運行は終了しました」と表示される。
- [ ] 一方の出発区間CSVを不正にしても、もう一方のタブは通常表示される。
- [ ] 詳細は同時に1件だけ開き、現在時刻モードだけカウントダウンが表示される。
- [ ] 「このルートを使う」で乗車中表示になり、再読み込み後も復元される。
- [ ] 乗車中ルートが到着後5分を過ぎると自動終了し、手動終了もできる。
- [ ] 初回表示後にDevToolsでOfflineへ切り替えても、画面とCSVが読み込める。
- [ ] 「データを更新」で更新後に再読み込みされ、最新データが表示される。
- [ ] オフライン中の更新失敗でエラーが表示され、旧データで利用を継続できる。
- [ ] Android Chromeからホーム画面へ追加し、standalone表示で起動できる。
