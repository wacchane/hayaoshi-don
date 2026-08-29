# 早押しドン

ルーム番号を知っている人だけで早押し対決ができる PWA。
最初に押した人の画面だけパトランプが光る。

公開先: <https://wacchane.github.io/hayaoshi-don/>

## 構成

| パス | 役割 |
| --- | --- |
| `docs/` | 公開されるサイト本体（GitHub Pages の配信元） |
| `docs/index.html` | 画面（白背景・パトランプ・早押しボタン） |
| `docs/app.js` | ルーム管理と早押し判定、回答音の合成 |
| `docs/mqtt-mini.js` | MQTT 3.1.1 over WebSocket の最小クライアント（依存なし） |
| `docs/sw.js` | Service Worker。アプリシェルを cache-first で配る |
| `docs/manifest.webmanifest` | PWA マニフェスト |
| `index.html` | Claude Artifact 版（同じ画面を Artifact ランタイムの room capability で動かすもの） |

## 遊び方

1. ホストが「ルームを作る」を押す。6桁のルーム番号が出る。
2. ほかの人はその番号を入れて「参加する」。
3. 出題したら、いちばん早く赤いボタンを押した人の画面だけパトランプが光る。
4. ホストがパトランプをタップすると次の問題へ進む。

スペースキーと Enter でも早押しできる。

## 通信のしくみ

サーバーを持たず、公開 MQTT ブローカーの WebSocket を経由する。
ルームごとに2つのトピックを使う。

```
hayaoshi-don/v1/<room>/state   retained。ホストだけが書く。round / open / winner。
hayaoshi-don/v1/<room>/buzz    各自の早押し。
```

`state` を retained にしてあるので、後から参加した人にもブローカーが現在の状況を
そのまま配ってくれる。ルーム番号が実在するかの判定にも同じ仕組みを使っている。

「最初の1人」の判定はホスト1台に集約している。実際の早押し機と同じで、判定の
基準点をひとつにすれば端末ごとの時計のズレに左右されない。ホストがブラウザを
閉じると retained を空にしてルームを畳む。

## 注意

ブローカーは誰でも使える公開サーバーなので、通信内容は原理的に第三者からも
読める。ルーム番号を6桁にしているのはそのためで、機密性のある用途には向かない。
自前のサーバーに移す場合は `docs/app.js` の `BROKERS` と `docs/mqtt-mini.js`
を差し替えれば済む。

## ローカルで動かす

```
python -m http.server 8765 --directory docs
```

`http://localhost:8765/` を開く。Service Worker が効くので、変更が反映されない
ときは DevTools の Application から Unregister するか、URL にクエリを付ける。
