# 網站設計規範

實驗室官網（`index.html`）的視覺與元件規範。樣式 token 與元件規則集中於 `assets/design/styles.css`；本檔記錄實際採用的設計取捨。首頁 3D 故事內容見 [docs/HOMEPAGE-3D-SPEC.md](../../docs/HOMEPAGE-3D-SPEC.md)。

## 1. 原則
- **以教授頁為色彩基準**：全站色彩對齊教授頁（`.cv-page`）——墨藍文字、青綠主色、金色點綴。
- **卡片一律柔和圓角**：淺色細邊框、白底、輕陰影；不再使用藍圖式角標（`+`）方框。
- **靜態優先、效能優先**：首屏靜態海報先出，3D 於互動後載入；須通過 PageSpeed Insights。
- **中英雙語**：所有文案以 `.l-zh` / `.l-en` 成對書寫；根節點預設 `data-lang="zh"`，切換時同步更新 `lang`。
- 尊重 `prefers-reduced-motion`，動畫可降級。

## 2. 色彩
Token 定義於 `assets/design/styles.css` 的 `:root`。元件請用變數，不要重複定義品牌色或寫死色碼。

| 角色 | Token | 值 |
|---|---|---|
| 文字 / 墨藍 | `--color-text`、`--color-accent-900` | `#1f2d3d` |
| 主色（青綠） | `--color-accent`、`--color-accent-600` | `#0b7f97` |
| 主色深 / 連結 hover | `--color-accent-700` / `-800` | `#096a7e` / `#075263` |
| 主色淡底 | `--color-accent-100` / `-200` / `-300` | `#e7f4f7` / `#c9e6ed` / `#9fd0db` |
| 金色點綴 | `--color-accent-2`、`--color-gold` | `#f2c230` |
| 頁面背景 | `--color-bg` | `#f2f2f3` |
| 卡片底 | — | `#fff` |
| 邊框 | `--card-line` | 墨藍 16% 混白 |
| 分隔線 | `--color-divider` | 墨 16% 透明 |
| 中性 | `--color-neutral-100…900` | 沿用設計系統 |

用法：金色只作分隔強調（如教授頁區塊上緣 3px 線）與「主題」類標籤，不作大面積填色。研究成果標籤分類色：研究領域 `#075263`、研究方法 `#0b7f97`、主題 `#f2c230`、技術 中性灰。

**例外**：首頁 3D 場景內部維持 Factory IO 風格（藍、橘、綠平塗），不隨網站主色變動。

## 3. 字體
- 標題：Barlow Condensed（`--font-heading`）＋ Noto Sans TC。
- 內文：Barlow ＋ Noto Sans TC。
- 小標籤（kicker）：11px、字距 `.16em`、大寫、主色深。
- 頁面大標 44px；區塊標題 26–32px；卡片標題 17–23px；內文 14–16px，行高 1.7 以上。

## 4. 卡片（全站：首頁精選論文、關於我們、團隊、研究成果、聯絡我們、教授頁）
以 `class="blueprint soft-card"` 實作（定義於 `assets/design/styles.css`）：
- 研究成果頁的篩選列、關係圖與側欄同樣使用此樣式。
- 白底 `#fff`；`1px solid var(--card-line)`；圓角 16px（教授頁大卡 18px、論文小卡 10px）。
- 陰影 `--card-shadow`：`0 8px 24px rgba(29,45,61,.08)`。
- 不使用 `.corner` 角標元素；卡片以柔和圓角與細邊框呈現。
- 核心技術卡：左上青綠編號方塊；標題＋英文副標（青綠）；`CORE TECHNIQUES` 小標＋「—」項目符號；底部 `↻ 翻面看應用`。背面為墨藍底（`--color-accent-900`）、同圓角。
- 團隊卡：照片框保留方形細邊，標籤為外框樣式 `tag-outline`。
- 卡片內容區塊用 `1px` 分隔線（`--color-divider`）。

## 5. 元件
- **導覽列**：Logo 靠左、選單靠右，貼齊視窗兩側（左右內距 28px，不受 1320px 內容寬限制）；sticky、`rgba(242,242,243,.94)` 毛玻璃；連結為膠囊形，當前頁以淡青底＋青綠字標示（焦點環向內縮，不會被切到）。手機（≤760px）改為漢堡選單，觸控目標 ≥44px。
- **標籤（團隊、研究成果、教授頁一律相同）**：膠囊形 `cv-tag`——白底、主色 1px 外框、主色文字、圓角 999px。
- **論文資訊膠囊**（`.pub-meta`）：`pill-date` 灰底年份、`pill-type` 淡青底類型（Journal／Conference）。不顯示 SCI／影響因子。
- **視圖切換**（`.radio-inputs`，Uiverse 版型）：淡青底容器，選中項為白底青綠粗體。
- **下拉選單**：`.input` 白底、膠囊圓角；彈出層在支援 `appearance:base-select` 的瀏覽器（Chrome 135+）為白底圓角面板，選項膠囊形、選中為青綠底，其餘瀏覽器維持原生樣式。
- **按鈕**：`.btn`、語言切換、分頁數字一律膠囊圓角；3D 幕次導覽鈕圓角 12px。
- **連結**：連結主色深，hover 更深；全站焦點環使用 `2px solid var(--color-accent-800)` 並留出 3px 間距。
- **教授頁 CV**：左側欄淡青底（主色 6%）＋右側內文；區塊標題間以金色 3px 上緣線分隔。
- **3D 導覽跳幕**：各幕落在最能代表該幕的時刻（01 幕中點、02 幕內 37% 可行路線、03 幕內 70% 對話框、04 幕內 69%、06 幕內 66%，05 落在幕頭）；設定在 `story-timeline.js` 的 `JUMP_LOCAL`。3D 區不顯示「ACT xx · n%」進度標籤。
- **進場動畫**：`data-reveal` 卡片捲動進入時淡入上移，同一列由左到右依序（每張延遲 90ms）。團隊頁不再有火柴人動畫。

## 6. 版面與響應式
- 內容最大寬 1320px，左右內距 28px（手機 16px）。
- 研究成果頁論文網格採等高列（不再使用 masonry），「查看論文」固定在卡片底部。
- 成員網格 `repeat(auto-fill,minmax(286px,1fr))`；論文網格 `minmax(330px,1fr)`；核心技術 4 欄（≤1120px 兩欄、≤760px 單欄）。
- 斷點：1120px、1000px（教授頁單欄）、760px（手機）、420px。

## 7. 動態與效能
- 首屏 `#boot` 靜態海報，App 掛載後淡出；React／Three.js 已本地化於 `assets/vendor/`。
- 網頁字型（Barlow、Noto Sans TC）使用非同步 stylesheet preload 與 `display=swap`；Logo 用 WebP；教授照片 `loading="lazy"`（`<x-dc>` 內的 img 即使隱藏也會被瀏覽器抓取）。
- PageSpeed 驗收（Lighthouse 11，2026-09-20）：手機 99／100／100／100，桌機 100／100／100／100。
- 3D 於使用者互動後才載入；分頁隱藏或離開視窗時暫停迴圈。
- 減少動態偏好：動畫縮至近乎 0 時長。

## 8. 修改守則
1. 顏色、陰影先改 `:root` token，再改元件。
2. 新卡片沿用 `blueprint soft-card`，勿自行加邊框樣式。
3. 新增文案務必中英成對。
4. 動 3D 或首屏後重測 PageSpeed。
