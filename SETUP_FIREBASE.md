# Kikitori Reader を全端末で同期する — セットアップ手順

このアプリは、**Firebase**（Googleの無料クラウド）を使って
「どの端末からでも同じ本棚・読書位置・設定にアクセスできる」ようになりました。

やることは、**自分専用の Firebase を 1つ作って、設定を `config.js` に貼り付けるだけ**です。
無料枠で十分収まります（個人利用では料金はかかりません）。

所要時間：約10分。1回だけの作業です。

---

## ステップ 1 — Firebase プロジェクトを作る

1. パソコンのブラウザで https://console.firebase.google.com/ を開く
2. Googleアカウント（`kazuhm5@gmail.com` など）でログイン
3. 「**プロジェクトを追加**」をクリック
4. プロジェクト名を入力（例：`kikitori-reader`）→「続行」
5. Googleアナリティクスは **オフのままでOK**（「このプロジェクトでGoogleアナリティクスを有効にする」のチェックを外す）→「プロジェクトを作成」
6. 完成したら「続行」

---

## ステップ 2 — ログイン機能（Authentication）を有効化

1. 左メニューの「**構築 → Authentication**」を開く
2. 「**始める**」をクリック
3. 「**メール/パスワード**」を選ぶ
4. 一番上の「**メール/パスワード**」のスイッチを **オン** にして「保存」
   （その下の「メールリンク」はオフのままでOK）

---

## ステップ 3 — データベース（Firestore）を作る

1. 左メニューの「**構築 → Firestore Database**」を開く
2. 「**データベースの作成**」をクリック
3. ロケーションは「**asia-northeast1（東京）**」を選ぶ → 次へ
4. モードは「**本番環境モード**」を選んで「作成」
   （ルールは後でこの手順で正しく設定します）

### セキュリティルールを設定する（重要）

作成後、上部の「**ルール**」タブを開き、中身を**すべて消して**下記を貼り付け、「**公開**」をクリック：

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 本人だけが自分のデータを読み書きできる
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

これで「ログインした本人以外は、あなたのデータに一切アクセスできない」状態になります。

---

## ステップ 4 — アプリ用の設定値を取得

1. 左上の「**プロジェクトの概要**」の歯車アイコン →「**プロジェクトの設定**」を開く
2. 下にスクロールして「**マイアプリ**」セクションへ
3. **`</>`（ウェブ）** のアイコンをクリック
4. アプリのニックネーム（例：`kikitori-web`）を入力 →「**アプリを登録**」
   （「Firebase Hosting」のチェックは不要）
5. 画面に表示される `firebaseConfig = { ... }` の中身をメモ（コピー）

こんな形の値です：

```js
const firebaseConfig = {
  apiKey: "AIzaSy..................",
  authDomain: "kikitori-reader.firebaseapp.com",
  projectId: "kikitori-reader",
  storageBucket: "kikitori-reader.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456"
};
```

---

## ステップ 5 — `config.js` に貼り付ける

リポジトリ内の **`config.js`** を開き、各項目の `""` の中に、ステップ4の値を入れます：

```js
window.FIREBASE_CONFIG = {
  apiKey:            "AIzaSy..................",
  authDomain:        "kikitori-reader.firebaseapp.com",
  projectId:         "kikitori-reader",
  storageBucket:     "kikitori-reader.appspot.com",
  messagingSenderId: "1234567890",
  appId:             "1:1234567890:web:abcdef123456"
};
```

保存したら、GitHubに `config.js` を更新としてコミット＆プッシュ。
GitHub Pages なら数十秒〜数分で反映されます。

> **メモ**：この設定値は「秘密鍵」ではなく、ウェブアプリに埋め込む前提の公開値です。
> 実際の保護はステップ3のセキュリティルール（本人のみ許可）が担います。

---

## ステップ 6 — 公開ドメインを許可リストに追加

1. Firebaseコンソール →「**Authentication → 設定（Settings）→ 承認済みドメイン**」
2. あなたの公開URLのドメインを追加：**`kh8081.github.io`**
   （`localhost` は最初から入っています）

---

## 使い方（完成後）

1. どの端末でも https://kh8081.github.io/kikitori_reader/ を開くと **ログイン画面**が出ます
2. 初回は「新規登録」でメールアドレスとパスワード（6文字以上）を作成
3. 2台目以降は同じメール・パスワードで「ログイン」するだけ
4. A端末で本を追加 → B端末の本棚に自動で現れます
5. 読んでいる位置も自動同期（右上に「同期済み」と表示されます）

- **既存の本の移行**：これまでその端末に貯めていた本は、初回ログイン時に自動でクラウドへ引っ越します（クラウドが空のときのみ）。
- **Firebase未設定のまま**でも、アプリは従来どおり「その端末だけに保存するモード」で動きます。

---

## よくあるトラブル

| 症状 | 対処 |
|---|---|
| ログイン画面が出ず従来のまま | `config.js` の `apiKey` / `projectId` / `appId` が空のまま。値を入れて再読込。 |
| 「オフライン」表示のまま同期されない | ステップ6で公開ドメインを承認済みドメインに追加したか確認。 |
| ログインで「権限がありません」系エラー | ステップ3のセキュリティルールを貼って「公開」したか確認。 |
| 本が同期されない | 両端末で**同じメールアドレス**でログインしているか確認。 |
