# 配当トラッカー（haitou）コードレビュー

作成日: 2026-04-19
対象: `C:\Users\Shiho\Claude\projects\haitou\`
公開URL: https://neo0027.github.io/haitou/

---

## 1. 基本情報

### 技術スタック
- **言語/フレームワーク**: 単一 `index.html` 内にインラインで書かれた React 18.2.0（ビルドステップなし、JSX 不使用）
  - `React.createElement` を `h` にエイリアスして、DSL 風に記述
  - Hooks を短縮名（`uS`=useState, `uE`=useEffect, `uC`=useCallback, `uR`=useRef）で利用
- **UI**: プレーン CSS + インラインスタイル（`S` オブジェクトに集約）
- **データ層**: Firebase Realtime Database（REST API 直叩き。Firebase SDK は未使用）
- **スクレイピング**: Yahoo!ファイナンス（`finance.yahoo.co.jp`）を 4 つの公開 CORS プロキシ経由で取得
- **フォント**: Google Fonts（Noto Sans JP）
- **ビルド/バンドラ**: なし。`<script>` タグで CDN から React 本体を読み込むだけ

### ディレクトリ構成（2階層まで）
```
haitou/
├── .git/
├── database.rules.json      # Firebase RTDB のセキュリティルール
├── firebase.json            # Firebase 設定（rules ファイルの指定のみ）
├── index.html               # 本体（React + CSS + ロジック全部入り・939行・58KB）
└── index.html.bak_20260416  # バックアップ（2026-04-16付け）
```

### 依存関係一覧
- **`package.json` は存在しない**（Node プロジェクトではない）
- HTML 内で CDN 参照している外部リソース:
  - `react@18.2.0` (production.min.js, cdnjs)
  - `react-dom@18.2.0` (production.min.js, cdnjs)
  - Google Fonts: Noto Sans JP (300/400/500/600/700)
- 外部 API / プロキシ:
  - `haitou-ac44d-default-rtdb.asia-southeast1.firebasedatabase.app`（自前 Firebase RTDB）
  - `api.allorigins.win`
  - `corsproxy.io`
  - `api.codetabs.com`
  - `cors-proxy.htmldriven.com`

---

## 2. データ取得まわり

### データソース
配当データは **複数ソースを組み合わせて** 取得・管理している:

1. **初期データ（ハードコード）** — [index.html:78-114](index.html:78)
   `INIT` 配列に 68 銘柄が `{t,n,a,d}`（コード/銘柄名/口座別株数/1株配当）形式で直書き。初回起動時 or リセット時に使われる。
2. **Firebase Realtime Database** — パス `/data` に `{stocks:[...], lastUpdated}` を保存/取得
3. **Yahoo!ファイナンスのスクレイピング** — 1株配当・株価・決算月を取得
4. **手入力** — 追加/編集モーダルで直接編集可能

### 取得頻度とキャッシュ
- **起動時オートアップデート**: 株価が空 or `lastUpdated` から 6 時間以上経過していれば自動で Yahoo 取得を実行 — [index.html:309-345](index.html:309)
- **手動一括更新**: 「更新」タブの「🔄 一括更新」ボタンで全銘柄を再取得
- **単銘柄ルックアップ**: 追加モーダルでコード入力時、300ms デバウンス後にフェッチ
- **キャッシュ**:
  - `localStorage` に TTL 24時間のスクレイピング結果キャッシュ（key: `haitou_stock_cache_v1`） — [index.html:465-481](index.html:465)
  - Firebase へのフォールバックとして `localStorage.div-fb` にも全データをミラー

### 主要関数とコード抜粋

**CORS プロキシ経由フェッチ** — [index.html:146-173](index.html:146)
```javascript
// 1プロキシで fetch → HTML文字列を返す / 失敗時 reject
async function tryProxy(px,url,timeoutMs){
  const resp=await fetch(px(url),{signal:AbortSignal.timeout(timeoutMs)});
  if(!resp.ok)throw new Error("http "+resp.status);
  const txt=await resp.text();
  if(!txt||txt.length<100)throw new Error("empty");
  // allorigins returns JSON with .contents, htmldriven returns JSON with .body
  try{
    const j=JSON.parse(txt);
    if(j&&typeof j.contents==="string"&&j.contents.length>100)return j.contents;
    if(j&&typeof j.body==="string"&&j.body.length>100)return j.body;
  }catch(e){}
  if(txt.includes("<")&&txt.includes("</"))return txt;
  throw new Error("invalid html");
}

// 4プロキシ並列レース → 最速で返ったもの採用。段階的タイムアウト（6s→12s）
async function proxyFetch(url){
  try{ return await Promise.any(PROXIES.map(px=>tryProxy(px,url,6000))); }
  catch(e){/* 全滅時のみ Stage 2 へ */}
  try{ return await Promise.any(PROXIES.map(px=>tryProxy(px,url,12000))); }
  catch(e){return null}
}
```

**Yahoo 本体 + 配当ページ並列取得＆抽出** — [index.html:378-461](index.html:378)
```javascript
const fetchStockFull=async(ticker)=>{
  let name=null,div=null,price=null,months=null;
  const [html,html2]=await Promise.all([
    proxyFetch("https://finance.yahoo.co.jp/quote/"+ticker+".T").catch(()=>null),
    proxyFetch("https://finance.yahoo.co.jp/quote/"+ticker+".T/dividend").catch(()=>null)
  ]);
  // name: title → h1 → og:title の順にフォールバック
  // price: __PRELOADED_STATE__.priceBoard.price → class="price" → 「現在値」周辺 → 前日比前の数値 → JSON-LD
  // div: 「1株当たり配当金（会社予想）」「予想年間配当」など複数正規表現で抽出
  // months: 「YYYY年MM月期」から決算月を推定し、期末(M+3)/中間(M-3)の2回に変換
  ...
};
```

**Firebase I/O** — [index.html:60-63](index.html:60)
```javascript
const FB_URL="https://haitou-ac44d-default-rtdb.asia-southeast1.firebasedatabase.app";
const fbGet=async(p)=>{const r=await fetch(FB_URL+"/"+p+".json");return r.ok?r.json():null};
const fbSet=async(p,d)=>{await fetch(FB_URL+"/"+p+".json",{method:"PUT",body:JSON.stringify(d)})};
```

**一括更新のバッチ処理**（並列度3・1秒間隔） — [index.html:588-619](index.html:588)
```javascript
const updateDiv=async()=>{
  setUpdating(true);setUpLog([]);setSplits([]);
  const up=[...stocks];const cc=3;
  for(let i=0;i<up.length;i+=cc){
    const batch=up.slice(i,i+cc);
    const results=await Promise.all(batch.map(s=>fetchStockFull(s.t).catch(...)));
    // ... 差分集計 + 株式分割検出 ...
    if(i+cc<up.length)await new Promise(r=>setTimeout(r,1000));
  }
  ...
};
```

---

## 3. 画面構成

### 主要コンポーネント
すべて `App` 単一コンポーネント内に展開。サブコンポーネントは汎用モーダルのみ。

| 名称 | 役割 |
|------|------|
| `App` | 唯一の主コンポーネント。状態・ロジック・描画すべてを内包 |
| `Modal` | 汎用モーダルコンテナ（追加/編集・削除確認・Confirmダイアログで再利用） |

### タブ（ルーティング）
React Router は未使用。`tab` ステートで3画面を切り替える疑似ルーティング:

| タブ | キー | 内容 |
|------|------|------|
| ダッシュボード | `dashboard` | サマリーカード（予想年間配当・保有銘柄・口座別）/月別配当カレンダー（タップで銘柄明細）/口座別ドーナツチャート（自前SVG）/配当TOP10バーチャート/口座別バー |
| 銘柄 | `stocks` | 口座フィルタ・検索・ソート対応。モバイル＝カード、デスクトップ＝テーブル表示。追加/編集/削除 |
| 更新 | `update` | クラウド同期（プル）/Yahoo 一括更新/株式分割検出の確認UI/更新結果ログ/支払月クリア・初期データリセット |

### モーダル
- 銘柄追加/編集モーダル（コード入力で自動ルックアップ・月ピッカー付き）
- 削除確認モーダル
- 汎用 Confirm ダイアログ（支払月クリア・初期データリセット用）
- Toast 通知（2.5秒で自動消滅）

### レスポンシブ
`@media(max-width:768px / 480px / 360px)` で複数段階のブレークポイント。`winW<480` を JS 側でも判定し、`stocks` タブでテーブル↔カードを切り替え。

---

## 4. パフォーマンス観点で気になる点

### 再レンダリングまわり
- **`App` が肥大化**: 状態が約20個あり、どれか1つ変わるたびに全計算（`totDiv`/`accT`/`filt`/`sorted`/`top10`/`monthlyDiv`/`donutData` など）が走る。`useMemo` は一切未使用 — [index.html:628-665](index.html:628)
- **インラインスタイル多用**: `S` 定数はモジュールスコープだが、レンダリングで合成しているスタイル（`{...S.cd, borderLeft:...}` など）は毎回新オブジェクトになり、子DOMの diff コストになる
- **`window.resize` で即 setState**: スロットリング/デバウンスなしで `winW` を更新 — [index.html:233-235](index.html:233)。リサイズ連打時に全体再描画が連発する
- **キーが不安定な箇所**: `upLog.map((l,i)=>h("tr",{key:i}))` でインデックスをkeyにしている — [index.html:874](index.html:874)

### ループ・計算
- ソート処理は `filt` を `[...filt].sort()` でコピー＋毎回比較関数を生成 — [index.html:634-642](index.html:634)。68銘柄なら軽微だが、メモ化すれば無駄ゼロにできる
- 月次集計 `monthlyDiv`/`monthlyCnt` も同様にメモ化余地あり — [index.html:649-656](index.html:649)
- N+1 的な問題は現状なし（データ量が少ないため）

### ネットワーク
- **一括更新のコスト**: 68銘柄 × 2ページ × 4プロキシ並列レース = 最悪 **544 リクエスト/更新** が発生しうる（Promise.any が最初の成功を待つ間、他プロキシも走っている）
- バッチサイズ=3、間隔 1000ms（オート時は 800ms）で律儀に節制しているが、オートアップデートが起動のたびに 6 時間ルールで走る点は注意
- **公開 CORS プロキシ依存**: `allorigins.win` など個人運用のリレーに乗せているため、信頼性・速度・継続性に外部リスクあり
- `Promise.all` → `for...of` のシーケンシャルループ構造は妥当。ただし Stage1 / Stage2 の 2段階タイムアウトで最大 18 秒待ってしまう銘柄が発生しうる

### バンドル/アセット
- **ビルド不要だが**、本体 HTML が 58KB（React 本体は CDN から別途 ~130KB gzipped）。React をローカルに取り込めば初回レンダリングは速くなるが、CDN キャッシュのほうが現実的
- **画像ゼロ**: アイコンは SVG を `data:` URI で埋め込み済み（`apple-touch-icon`）。最適化済みと言える
- **フォント**: Noto Sans JP を weight 5段階（300/400/500/600/700）読み込んでおり重め。実際に使っているのは概ね 400/600/700。`display=swap` は指定済み

### その他
- `splitHandled` は `useRef` の `Set` で多重反映を防いでいる — [index.html:570-581](index.html:570)。良い実装
- Firebase RTDB が配列を object に変換する件を `normM` / `Object.values` で吸収している点も堅実 — [index.html:121-126](index.html:121)

---

## 5. デプロイ状況

### ホスティング
- **GitHub Pages** で公開: https://neo0027.github.io/haitou/
- リポジトリ: https://github.com/Neo0027/haitou.git
- Firebase プロジェクト: `haitou-ac44d`（Realtime Database、asia-southeast1 リージョン）

### モバイル対応 / PWA
- **PWA 化は未実施**（`manifest.json`・Service Worker なし）
- ただし iOS ホーム画面向けの準備は入っている:
  - `apple-mobile-web-app-capable`
  - `apple-mobile-web-app-status-bar-style=black-translucent`
  - `apple-mobile-web-app-title=配当トラッカー`
  - `apple-touch-icon`（SVG data URI）
  - `theme-color=#0a0c12`
  - `viewport-fit=cover` ＋ `env(safe-area-inset-*)` でノッチ対応
- レスポンシブ CSS（768/480/360px ブレークポイント）＋ JS による動的テーブル↔カード切替でモバイル最適化済み

### ローカル実行
- ローカルではファイル単体をブラウザで開くだけで動作可能（ビルド不要）。ただし外部プロキシ・Firebase を使うためオフライン動作は不可

---

## 補足: 要確認事項（修正は行っていません）

### [重要] Firebase ルールと CLAUDE.md の方針不一致
`database.rules.json` の現状:
```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```

一方、本体アプリは **Firebase Auth を一切使わず REST で `PUT`/`GET` を叩いている**（`fbGet`/`fbSet`）。ルール通りなら **Firebase への読み書きは全て拒否されるはず**です。

`CLAUDE.md` の「過去の失敗と教訓」にもこの組み合わせで壊れた旨が明記されています:

> haitouのFirebase DBルールを `auth != null` に変更 → アプリが壊れた
> haitouはURL共有型で認証なし。`database.rules.json` に `auth != null` を**絶対に設定しない**

現実にはアプリが動いている（公開URLで稼働中の様子）ため、**Firebase コンソール側のルールはこのファイルと異なり、公開ルールのままになっている可能性が高い**です。つまりリポジトリの `database.rules.json` がドリフトしている状態。
デプロイで `firebase deploy --only database` を実行するとアプリが即座に壊れるので、要注意です。

→ **対応提案（実行はしていません）**: コンソール側の現状ルールを確認のうえ、このファイルを公開ルール（`"true"` など URL 共有前提）に戻す。

### その他の軽微な気づき
- `index.html.bak_20260416` が残置（2026-04-16 バックアップ）。運用が落ち着いたら `output/review/` への退避を検討
- `lookingUp` のリセット漏れが一部ある（キャッシュヒット時は`true`にせず即`false`に落とす実装で問題なし — [index.html:492-515](index.html:492)）
- 公開 CORS プロキシが止まると全機能停止するため、長期運用するなら自前プロキシ（Cloudflare Workers 等）の検討余地あり
