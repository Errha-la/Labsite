/* story-data.js — 首頁 3D 故事的唯一文案來源（中英雙語）
 *
 * 維護說明
 *   · 首頁所有幕的標題、說明、技術標籤與對話都在這裡，index.html 不再內嵌任何一份。
 *   · acts 為有編號、有導覽、有文字欄的六幕；transition 為無編號、無文字欄的滿版過場。
 *   · 用 <script> 同步載入（而非 fetch JSON），首屏渲染時資料已就緒，不會閃爍或位移。
 *   · 對話與示意畫面中的數值皆為示意。
 */
window.STORY_DATA = {
  acts: [
    {
      num: '01', code: 'DETECT',
      zh: '智慧檢測', en: 'Smart Inspection',
      descZh: '一顆晶片只要有細小的裂痕，就可能讓整個產品失效，而人眼盯久了會疲勞。產線因此在每一顆晶片上方架設工業相機，把影像交給神經網路分析。它像訓練有素的檢查員，看過大量瑕疵樣本，只需看一眼，就能標出裂痕、缺角、刮傷、污染的位置，並給出每個判斷的信心分數。',
      descEn: 'One tiny crack can make a chip fail, and human eyes tire over long shifts. So an industrial camera sits above every chip and passes each image to a neural network. Trained on many defect examples, it locates cracks, chipped corners, scratches and contamination in a single glance and reports a confidence score for each.',
      techZh: ['工業相機與環形補光', '電腦視覺', '卷積神經網路（CNN）', 'YOLO 物件偵測'],
      techEn: ['Industrial camera and ring light', 'Computer vision', 'Convolutional neural network (CNN)', 'YOLO object detection']
    },
    {
      num: '02', code: 'TRANSPORT',
      zh: '最佳化運送', en: 'Optimized Transport',
      descZh: '瑕疵品要送去分析，路線怎麼走最省時？多台搬運車同時工作時，誰先出發、走哪條路、會不會塞車？這類問題屬於作業研究（Operations Research, OR）：把「要做的事」變成數學模型，找出全局最佳的安排，而不是各走各的。',
      descEn: 'Which route gets defective parts to analysis fastest? With several vehicles, who leaves first, which way do they go, and how do they avoid jams? These are Operations Research (OR) problems: turn the job into a mathematical model and find the best plan for the whole system.',
      techZh: ['路徑規劃（最短路徑、A*）', '車輛途程問題（VRP）', '排程最佳化（混整數規劃）'],
      techEn: ['Path planning (shortest path, A*)', 'Vehicle routing problem (VRP)', 'Scheduling optimization (mixed-integer programming)']
    },
    {
      num: '03', code: 'RCA',
      zh: '根因分析', en: 'Root Cause Analysis',
      stepsZh: [
        '檢測系統常出現誤檢（好的被當成壞的）與漏檢（壞的被放過）。',
        '新手拿到結果，不知道如何解讀、該怎麼處理。',
        '現有視覺模型多半只會畫框，框完就結束。',
        '於是我們用 YOLO 找出瑕疵，Multi-Agent 分工推理，Structured RAG 從結構化的 SOP 與歷史案例中檢索，補上「為什麼會這樣、下一步怎麼做」。'
      ],
      stepsEn: [
        'Inspection often suffers false alarms (good parts flagged) and misses (bad parts passed).',
        'Newcomers struggle to interpret results or decide what to do.',
        'Most vision models only draw boxes and stop there.',
        'So we combine YOLO for detection, Multi-Agent reasoning, and Structured RAG over structured SOPs and past cases to fill the gap: why it happened and what to do next.'
      ],
      techZh: ['YOLO', 'Multi-Agent', 'Structured RAG（把規範與案例整理成結構化資料再檢索，比整篇文件搜尋更精確、可追溯）'],
      techEn: ['YOLO', 'Multi-Agent', 'Structured RAG']
    },
    {
      num: '04', code: 'DECIDE',
      zh: '模擬與調參', en: 'Simulate & Tune',
      descZh: '直接在真實產線試新參數，萬一更糟就是真的報廢。所以我們先做一份數位孿生：一個和真實產線同步更新的虛擬複本。AI 在複本裡先試跑，確認有效，工程師核准後才套用到實際機台。',
      descEn: 'Testing new parameters directly on the real line risks real scrap. A digital twin, a virtual copy kept in sync with the real line, lets AI try changes safely first. Only approved changes reach the machines.',
      techZh: ['數位孿生', '製程模擬', '人機協作（Human-in-the-loop）'],
      techEn: ['Digital twin', 'Process simulation', 'Human-in-the-loop']
    },
    {
      num: '05', code: 'ACT & LEARN',
      zh: '執行與學習', en: 'Act & Learn',
      descZh: '新參數上線後，系統持續監看品質。這次的原因與對策會寫回知識庫，下次遇到類似瑕疵就能更快處理，產線因此越用越聰明。',
      descEn: 'Once live, the system keeps watching quality. The cause and fix are written back to the knowledge base, so the next similar defect is handled faster.',
      techZh: ['統計製程管制（SPC）', '知識庫回寫', '持續學習'],
      techEn: ['Statistical process control (SPC)', 'Knowledge write-back', 'Continual learning']
    },
    {
      num: '06', code: 'CLOSED LOOP',
      zh: '閉環智慧製造', en: 'Closed-Loop Manufacturing',
      descZh: '從檢測、分析、決策到學習，AI 負責快速計算，人負責判斷與把關，兩者形成一個持續改善的閉環。',
      descEn: 'From detection to learning, AI handles fast computation and people handle judgment and oversight, forming a loop of continuous improvement.',
      techZh: ['閉環控制', '人機協作', '持續改善'],
      techEn: ['Closed-loop control', 'Human–AI collaboration', 'Continuous improvement']
    }
  ],

  /* 無編號、無文字欄、不進導覽；畫面滿版 */
  transition: {
    id: 'sort-pick', code: 'SORT & PICK',
    zh: '分流與取出', en: 'Sort & Pick',
    card: false, nav: false
  },

  /* 浮動對話框：中英同時呈現（模型只需一版） */
  dialogue: [
    { act: '03', who: 'worker', zh: '這批 X 的邊緣毛邊變多了，你怎麼看？', en: 'More burrs on the X parts. What do you think?' },
    { act: '03', who: 'ai',     zh: '對照 SOP 4.2 與近期切削資料，進給速度偏高。', en: 'Per SOP 4.2 and recent cutting data, the feed rate looks too high.' },
    { act: '04', who: 'ai',     zh: '模擬顯示降低進給速度可提升良率。', en: 'Simulation shows a lower feed rate raises yield.' },
    { act: '04', who: 'worker', zh: '核准，我們調整吧。', en: 'Approved. Let’s apply it.' }
  ]
};
