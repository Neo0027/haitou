# 配当トラッカー（haitou）現状調査レポート

**調査日**: 2026-05-02
**対象**: `C:\Users\Shiho\Claude\projects\haitou\index.html`（1098行）
**判定**: コード読み取りのみ（修正なし）

---

## 1. パフォーマンス改善の実装状況

### 1-1. Cloudflare Workers プロキシ → **未実装**

`PROXIES` 配列（行71-76）に `*.workers.dev` のURLは**含まれていません**。

```js
71: const PROXIES=[
72:   u=>"https://api.allorigins.win/get?url="+encodeURIComponent(u),
73:   u=>"https://corsproxy.io/?url="+encodeURIComponent(u),
74:   u=>"https://api.codetabs.com/v1/proxy?quest="+encodeURIComponent(u),
75:   u=>"https://cors-proxy.htmldriven.com/?url="+encodeURIComponent(u)
76: ];
```

`proxyFetch` / `proxyFetchFast` は「記憶した最速プロキシ単独 → 残りを並列レース」の Stage A/B/C 戦略はあるものの、Workers が優先される仕組みは存在せず。Workers を最先頭に置く準備段階の構造もなし。

---

### 1-2. useMemo 導入 → **実装済み（全項目）**

| 項目 | 行 | 判定 |
|---|---|---|
| `totDiv` | 772 | 済 |
| `accT` | 774 | 済 |
| `filt` | 779 | 済 |
| `sorted` | 794 | 済 |
| `top10` | 795 | 済 |
| `monthlyDiv` / `monthlyCnt` | 801（`monthlyData`内で生成し811-813で展開） | 済 |
| `donutData` | 823 | 済 |

```js
772: const totDiv=uM(()=>stocks.reduce((s,st)=>s+adv(st),0),[stocks]);
773: const totSh=uM(()=>stocks.reduce((s,st)=>s+tsh(st),0),[stocks]);
774: const accT=uM(()=>{
775:   const t={};AK.forEach(k=>{t[k]=0});
776:   stocks.forEach(st=>Object.entries(st.a).forEach(([k,v])=>{t[k]=(t[k]||0)+v*st.d}));
777:   return t;
778: },[stocks]);
779: const filt=uM(()=>{
780:   const filt0=fAcc==="all"?stocks:stocks.filter(s=>s.a[fAcc]);
781:   if(!searchQ)return filt0;
782:   const q=searchQ.toLowerCase();
783:   return filt0.filter(s=>s.t.toLowerCase().includes(q)||s.n.toLowerCase().includes(q));
784: },[stocks,fAcc,searchQ]);
```

```js
794: const sorted=uM(()=>[...filt].sort(sortCmp),[filt,sortCmp]);
795: const top10=uM(()=>[...stocks].sort((a,b)=>adv(b)-adv(a)).slice(0,10),[stocks]);

801: const monthlyData=uM(()=>{
802:   const div=Array(12).fill(0),cnt=Array(12).fill(0);
...
810: },[stocks]);
811: const monthlyDiv=monthlyData.div;
812: const monthlyCnt=monthlyData.cnt;

823: const donutData=uM(()=>AK.map(k=>({k,v:accT[k],c:AC[k]})).filter(d=>d.v>0),[accT]);
```

`sortCmp`（行785）は `useCallback` 化されており、`sorted` の依存配列に正しく入っています。

---

### 1-3. React.memo 化 → **未実装**

銘柄行は独立コンポーネント化されておらず、`App` 内のインライン `h()` 呼び出しで生成されています。よって `React.memo` ラップも比較関数も存在しません。

```js
949:           ...sorted.map(st=>
950:             h("div",{key:st.t,style:{background:"#11131c",border:"1px solid #1a1d28",borderRadius:7,padding:"10px 12px"}},
951:               h("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}},
...
```

```js
976:             h("tbody",null,...sorted.map(st=>
977:               h("tr",{key:st.t},
978:                 h("td",{style:{...S.td,textAlign:"right"}},h("span",{style:S.tk},st.t)),
...
```

行ごとのスタイル合成は `SA[k]`（行284-298）でモジュール初期化時に事前合成されており、レンダリングコストは抑えられているものの、`stocks` 1件変更で全行が再レンダリングされる構造のままです。

---

### 1-4. resize デバウンス → **実装済み**

`window.resize` は 150ms の `setTimeout` デバウンスで `winW` を更新します（rAF ではなく setTimeout）。

```js
309:   const[winW,setWinW]=uS(window.innerWidth);
310:   // resize は 150ms デバウンス（連打時の再レンダリングを抑制）
311:   uE(()=>{
312:     let tmr=null;
313:     const handler=()=>{
314:       if(tmr)clearTimeout(tmr);
315:       tmr=setTimeout(()=>{tmr=null;setWinW(window.innerWidth)},150);
316:     };
317:     window.addEventListener("resize",handler);
318:     return()=>{if(tmr)clearTimeout(tmr);window.removeEventListener("resize",handler)};
319:   },[]);
```

更新頻度: 連続するresize中はsetState呼ばれず、最後のresizeから150ms静止して初めて1回 `setWinW`。

---

### 1-5. 起動時ノンブロッキング化 → **実装済み**

3点すべて満たしています。

**(a) localStorage を同期的に即反映（Phase 1）**:
```js
358:   uE(()=>{
359:     // ── Phase 1: 同期的に localStorage を反映 ──
360:     try{
361:       const d=JSON.parse(localStorage.getItem("div-fb"));
362:       let stocksArr=d?.stocks;
363:       if(stocksArr&&Array.isArray(stocksArr)&&stocksArr.length){
...
372:         dataLoaded.current=true; // 既存データで操作可能
373:       }
374:     }catch(e){}
```

**(b) Firebase プルは requestIdleCallback で後追い（Phase 2）**:
```js
405:     };
406:     const schedule=window.requestIdleCallback?(cb)=>window.requestIdleCallback(cb,{timeout:500}):(cb)=>setTimeout(cb,0);
407:     schedule(runFbSync);
408:   },[]);
```

**(c) Yahoo 自動更新も requestIdleCallback で後追い**:
```js
446:       setAutoUpdating(false);setAutoUpProg("");
447:     };
448:     const schedule=window.requestIdleCallback?(cb)=>window.requestIdleCallback(cb,{timeout:1500}):(cb)=>setTimeout(cb,0);
449:     schedule(runAutoUpdate);
450:     return()=>{cancelled=true};
```

ローディング中もUI操作可能：`dataLoaded.current` フラグで段階管理しており、Phase 1 完了時点で全UIが操作可能（モーダル開閉・ソート・タブ切替などはすべて `stocks` ローカルstateに対する操作）。

---

## 2. 既存（フェーズ1以前）の状態

### `proxyFetchFast` 関数 → **存在する**（行190-204）

Stage A をスキップして全プロキシ並列レースから始める。5sでダメなら10sで再挑戦。

```js
190: async function proxyFetchFast(url,timeoutMs){
191:   const t=timeoutMs||5000;
192:   try{
193:     const winner=await Promise.any(PROXIES.map((px,i)=>tryProxy(px,url,t).then(html=>({html,i}))));
194:     writeBestProxy(winner.i); // 勝ったプロキシは以後の Stage A でも使う
195:     return winner.html;
196:   }catch(e){
197:     // 5秒で全部失敗したら 10秒で再挑戦（遅いプロキシに最後のチャンス）
198:     try{
199:       const winner=await Promise.any(PROXIES.map((px,i)=>tryProxy(px,url,t*2).then(html=>({html,i}))));
200:       writeBestProxy(winner.i);
201:       return winner.html;
202:     }catch(e2){return null}
203:   }
204: }
```

### `fetchStockForLookup` 関数 → **存在する**（行570-604）

配当ページ1枚のみ取得。`proxyFetchFast(...,5000)` を呼び出し。

```js
570:   const fetchStockForLookup=async(ticker)=>{
571:     let name=null,div=null,months=null;
572:     const html=await proxyFetchFast("https://finance.yahoo.co.jp/quote/"+ticker+".T/dividend",5000);
573:     if(!html)return{name,div,months};
```

### ルックアップのデバウンス → **150ms**

```js
661:   const handleTickerChange=(val)=>{
662:     setForm(prev=>({...prev,t:val}));setLookupErr("");
663:     if(lookupTmr.current)clearTimeout(lookupTmr.current);
664:     if(val.length>=4){
665:       lookupTmr.current=setTimeout(()=>lookupTicker(val),150);
666:     }
667:   };
```

加えて、`lookupSeq` で逐次採番＋古いリクエストを無視する race condition 対策あり（行637, 649, 657-658）。

---

## 3. 未実装の改善ポイント

| 項目 | 判定 | 備考 |
|---|---|---|
| エラーバウンダリ | **未** | `componentDidCatch` / `getDerivedStateFromError` 共になし。クラスコンポーネントは `App` のみ functional |
| kabutan / みんかぶ フォールバック | **未** | スクレイピング先は `finance.yahoo.co.jp` のみ（行487-488, 572） |
| PWA化（manifest.json / Service Worker） | **未** | `manifest.json` ファイル無し、`navigator.serviceWorker` の登録コード無し。`apple-touch-icon` と `theme-color` は行9-11にあるがPWA化はされていない |
| CSV エクスポート/インポート | **未** | `Blob` / `URL.createObjectURL` / `text/csv` などの記述なし |
| 税引後配当表示（20.315%） | **未** | `20.315` / `0.20315` / `0.79685` などの記述なし。`fmt()` も税引前のみ（行116） |
| 年間目標トラッキング | **未** | 目標額の入力UI・進捗バー類なし |
| 権利落ち日リマインド | **未** | `m`（支払月）はあるが、権利確定日・権利落ち日の概念が無い |
| 配当履歴グラフ | **未** | 月別カレンダー（行870-877）は「予定」の表示。実績の時系列保存・グラフ描画ロジックなし |

---

## 4. Firebase ルール

`C:\Users\Shiho\Claude\projects\haitou\database.rules.json` の現在の中身：

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

`"auth != null"` は**含まれていません**。CLAUDE.md の方針通り「URL共有型・認証なし」で運用されています。

---

## 5. ファイル状況

- **index.html**: 1098行（66,785バイト、最終更新 2026-04-20 09:42）
- **直近のバックアップ**: `index.html.bak_20260416`（57,317バイト、2026-04-16 15:50）が**1個だけ**存在
- 同階層の他ファイル: `firebase.json`, `database.rules.json`, `review.md`

---

## サマリー

**実装済み（フェーズ1完了済み）**:
- useMemo 全7項目
- resize デバウンス（150ms）
- 起動時ノンブロッキング化（localStorage同期反映 + Firebase/Yahoo を requestIdleCallback で後追い）
- proxyFetchFast / fetchStockForLookup（ルックアップ高速化）
- 記憶型ベストプロキシ（Stage A/B/C）

**未実装（次フェーズ候補）**:
- Cloudflare Workers プロキシ ←最優先候補
- 銘柄行の React.memo 化
- エラーバウンダリ
- kabutan / みんかぶ フォールバック
- PWA化、CSV、税引後表示、年間目標、権利落ち日、配当履歴グラフ
