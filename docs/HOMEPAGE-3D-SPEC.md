# 首頁 3D 場景改版規格

狀態：草案，待使用者審閱。尚未開始實作。

## 1. 目標
以「AI Agent 閉環智慧製造」故事取代首頁現有的 U 形產線 3D 區塊。訪客以捲動方式，看完一顆瑕疵晶片從檢測、運送、根因分析、模擬調參到學習回饋的完整閉環。

## 2. 範圍
- 只更換首頁 3D 區塊，其餘頁面與整站視覺（灰底、`#5980a6` 強調色）不變。
- 參考圖只取版面結構：桌機左文右圖，手機圖上文下。
- 3D 場景採 Factory IO 風格配色（藍、橘、綠、平塗）。
- 舊 U 形產線資料與預覽工具移至 `archive/`。

## 3. 場景結構
共六幕加一段過場。導覽列只列有編號的六幕。

| 編號 | 代碼 | 標題 | 文字欄 |
|---|---|---|---|
| 01 | DETECT | 智慧檢測 | 有 |
| 過場 | SORT & PICK | 分流與取出 | 無，畫面滿版，不在導覽列 |
| 02 | TRANSPORT | 最佳化運送 | 有 |
| 03 | RCA | 根因分析 | 有 |
| 04 | DECIDE | 模擬與調參 | 有 |
| 05 | ACT & LEARN | 執行與學習 | 有 |
| 06 | CLOSED LOOP | 閉環智慧製造 | 有 |

### 各幕畫面
1. **DETECT**：晶片沿輸送帶進入工業相機視野。良品頭頂浮出綠色 O；瑕疵品浮出紅色 X 與紅框及信心分數。
2. **SORT & PICK（過場）**：良品隨傳送帶離開視野；機械手臂夾取瑕疵品裝箱。
3. **TRANSPORT**：AGV 載箱，前方浮出多條候選路線，逐一淡出，只留最佳路線，AGV 沿其前進到分析站。
4. **RCA**：工人與代表 AI 的機器人在分析站討論，浮動對話框中英同時呈現，並附瑕疵影像與感測曲線縮圖。
5. **DECIDE**：兩人轉身走向控制室；控制室旁浮出半透明縮小產線（數位孿生），模擬跑完變綠後，工程師按下核准。
6. **ACT & LEARN**：鏡頭推進控制室螢幕，螢幕內是同一條產線，連續 N 件 O、燈號皆綠，並有案例卷宗寫入知識庫的小動畫。
7. **CLOSED LOOP**：鏡頭從螢幕拉遠，工人與機器人拍手、跳舞。

## 4. 文字欄內容（雙語）

### 01 · DETECT
- 中：一顆晶片只要有細小的裂痕，就可能讓整個產品失效，而人眼盯久了會疲勞。產線因此在每一顆晶片上方架設工業相機，把影像交給神經網路分析。它像訓練有素的檢查員，看過大量瑕疵樣本，只需看一眼，就能標出裂痕、缺角、刮傷、污染的位置，並給出每個判斷的信心分數。
- 技術：工業相機與環形補光、電腦視覺、卷積神經網路（CNN）、YOLO 物件偵測
- EN: One tiny crack can make a chip fail, and human eyes tire over long shifts. So an industrial camera sits above every chip and passes each image to a neural network. Trained on many defect examples, it locates cracks, chipped corners, scratches and contamination in a single glance and reports a confidence score for each.
- Tech: industrial camera and ring light, computer vision, convolutional neural network (CNN), YOLO object detection

### 02 · TRANSPORT
- 中：瑕疵品要送去分析，路線怎麼走最省時？多台搬運車同時工作時，誰先出發、走哪條路、會不會塞車？這類問題屬於作業研究（Operations Research, OR）：把「要做的事」變成數學模型，找出全局最佳的安排，而不是各走各的。
- 技術：路徑規劃（最短路徑、A*）、車輛途程問題（VRP）、排程最佳化（混整數規劃）
- EN: Which route gets defective parts to analysis fastest? With several vehicles, who leaves first, which way do they go, and how do they avoid jams? These are Operations Research (OR) problems: turn the job into a mathematical model and find the best plan for the whole system.
- Tech: path planning (shortest path, A*), vehicle routing problem (VRP), scheduling optimization (mixed-integer programming)

### 03 · RCA
- 中：
  1. 檢測系統常出現誤檢（好的被當成壞的）與漏檢（壞的被放過）。
  2. 新手拿到結果，不知道如何解讀、該怎麼處理。
  3. 現有視覺模型多半只會畫框，框完就結束。
  4. 於是我們用 YOLO 找出瑕疵，Multi-Agent 分工推理，Structured RAG 從結構化的 SOP 與歷史案例中檢索，補上「為什麼會這樣、下一步怎麼做」。
- 技術：YOLO、Multi-Agent、Structured RAG（把規範與案例整理成結構化資料再檢索，比整篇文件搜尋更精確、可追溯）
- EN:
  1. Inspection often suffers false alarms (good parts flagged) and misses (bad parts passed).
  2. Newcomers struggle to interpret results or decide what to do.
  3. Most vision models only draw boxes and stop there.
  4. So we combine YOLO for detection, Multi-Agent reasoning, and Structured RAG over structured SOPs and past cases to fill the gap: why it happened and what to do next.
- Tech: YOLO, Multi-Agent, Structured RAG

### 04 · DECIDE
- 中：直接在真實產線試新參數，萬一更糟就是真的報廢。所以我們先做一份數位孿生：一個和真實產線同步更新的虛擬複本。AI 在複本裡先試跑，確認有效，工程師核准後才套用到實際機台。
- 技術：數位孿生、製程模擬、人機協作（Human-in-the-loop）
- EN: Testing new parameters directly on the real line risks real scrap. A digital twin, a virtual copy kept in sync with the real line, lets AI try changes safely first. Only approved changes reach the machines.
- Tech: digital twin, process simulation, human-in-the-loop

### 05 · ACT & LEARN
- 中：新參數上線後，系統持續監看品質。這次的原因與對策會寫回知識庫，下次遇到類似瑕疵就能更快處理，產線因此越用越聰明。
- 技術：統計製程管制（SPC）、知識庫回寫、持續學習
- EN: Once live, the system keeps watching quality. The cause and fix are written back to the knowledge base, so the next similar defect is handled faster.
- Tech: statistical process control (SPC), knowledge write-back, continual learning

### 06 · CLOSED LOOP
- 中：從檢測、分析、決策到學習，AI 負責快速計算，人負責判斷與把關，兩者形成一個持續改善的閉環。
- EN: From detection to learning, AI handles fast computation and people handle judgment and oversight, forming a loop of continuous improvement.

### 對話框（中英同時呈現）
- 工人：這批 X 的邊緣毛邊變多了，你怎麼看？ / More burrs on the X parts. What do you think?
- AI：對照 SOP 4.2 與近期切削資料，進給速度偏高。 / Per SOP 4.2 and recent cutting data, the feed rate looks too high.
- AI：模擬顯示降低進給速度可提升良率。 / Simulation shows a lower feed rate raises yield.
- 工人：核准，我們調整吧。 / Approved. Let's apply it.

> 對話與畫面中的數值皆為示意，不放具體統計數字，頁面上需標註「示意」。

## 5. 3D 設計

### 工件：晶片
| 狀態 | 造型 |
|---|---|
| 良品 | 黑色封裝本體、銀色接腳、頂面亮色標記點 |
| 裂痕 | 本體中間明顯裂縫，兩半略錯開，像被掰成兩半 |
| 缺角 | 一個角被切掉，露出淺色斷面 |

瑕疵刻意比真實情況明顯，讓觀眾一眼看出。

### 設備與角色
- 輸送帶、工業相機（環形補光）、機械手臂、收納箱、AGV、分析站、控制室（螢幕牆）。
- 工人與機器人以簡化幾何組成（膠囊、方塊），跳舞用關節正弦擺動。
- 材質分槽、每個 mesh 具名，沿用 `line-model.js` 的慣例（`beveledBox`、`screenModule`、D 常數）。

### 特殊效果
- **OR 視覺化**：AGV 前方數條半透明路線，逐條淡出，最佳者加粗發光。
- **數位孿生**：控制室旁的半透明縮小產線，模擬完成後變綠。
- **螢幕中的螢幕**：低解析度（約 256px、約 15 fps）第二鏡頭渲染到貼圖，低階手機改用預先做好的循環畫面。

## 6. 版面與響應式
- 桌機：左側約三分之一為文字欄（圈起來的編號、標籤、大標題、說明、技術標籤），右側為 3D 畫面。
- 手機：畫面在上、文字在下；畫面採直向取景，每一幕各自設定鏡頭構圖。
- 過場（SORT & PICK）：文字欄退場，畫面滿版，四周留薄方格紙邊；桌機為橫向寬幅、手機為直向滿版。
- **畫布尺寸固定為全寬**，文字欄以浮層滑入滑出，鏡頭以 `setViewOffset` 保持主體置中，避免版面位移（CLS）與緩衝區重新配置。
- 導覽：01 至 06 編號導覽，可跳至任一幕；不放「Watch the demo」按鈕。
- 語言：文字欄維持中英切換；對話框中英同時顯示。

## 7. 技術要求
- **捲動驅動且可倒捲**：所有動畫皆為進度 p 的純函式，不累積狀態。
- **可重現**：瑕疵序列使用固定亂數種子，同一個 p 永遠得到同一張畫面。
- 鏡頭改為關鍵影格加樣條曲線，取代原本沿 U 形工站錨點移動的邏輯。
- 對話框用畫布貼圖 Sprite，沿用現有 `signboard` 的 `draw()` 寫法。
- 文字集中於單一資料檔 `story-data.js`（以 script 同步載入，首屏無需 fetch），取代原本 `STATIONS` 陣列與 `line-stations.json` 兩份來源。
- 保留 `low`／`high` 兩級細節，並尊重 `prefers-reduced-motion`。

## 8. 驗收標準
1. **通過 Google PageSpeed Insights：手機與桌機報告的 Performance、Accessibility、Best Practices、SEO 四項皆 90 分以上**。
   - three.js 與場景延遲載入。
   - LCP 元素為輕量靜態畫面，而非 WebGL 畫布。
   - 預留畫布尺寸，CLS 接近 0。
   - 載入階段不阻塞主執行緒。
2. 六幕捲動順暢，鏡頭停在每幕時文字可讀，倒捲畫面一致。
3. 桌機與手機各截圖比對，含滿版過場。
4. 無 console error，`dispose()` 不洩漏資源。
5. 低細節模式與 `prefers-reduced-motion` 皆可正常運作。

## 9. 檔案異動
| 檔案 | 動作 |
|---|---|
| `assets/js/line-model.js` | 重寫為新場景（保留慣例） |
| `assets/data/story-data.js` | 六幕雙語文案，唯一來源（取代 `line-stations.json`） |
| `index.html` | 移除內嵌 `STATIONS`；鏡頭、捲動與版面改寫 |
| `tools/production-line-3d.html` | 改為新場景預覽工具 |
| 舊產線資料與舊預覽 | 移至 `archive/` |
| `README.md`、`docs/GITHUB-PAGES.md` | 更新說明 |

## 10. 階段規劃
1. **階段 0**：合併資料來源，只讀單一 JSON。
2. **階段 1**：寫入雙語文案與導覽（模型仍為舊的）。
3. **階段 2**：晶片、輸送帶、相機、手臂、O／X 標籤，完成 01 與過場。
4. **階段 3**：AGV 與 OR 路線視覺化，完成 02。
5. **階段 4**：角色、對話框、分析站與控制室，完成 03 至 04（含數位孿生）。
6. **階段 5**：螢幕中的螢幕、學習動畫、拉遠與跳舞，完成 05 與 06。
7. **階段 6**：響應式構圖、效能調校，通過 PageSpeed Insights 驗收，更新文件。

## 11. 暫定假設（可再調整）
- 螢幕中的螢幕採低解析度即時渲染，低階手機用循環畫面。
- 手機版每一幕有各自的直向鏡頭構圖，畫面固定在上方、文字在下方切換。
- 角色造型採簡化低多邊形，不追求擬真。
