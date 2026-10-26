# Labsite 聯絡表單 API 安裝與驗收

本文件說明如何把 backend/contact-api 安裝到實驗室 Linux 伺服器。服務只接收聯絡表單並寄出純文字郵件，不會將表單寫入資料庫。部署前須先取得 API 網域、TLS 憑證和實驗室核准的 SMTP 寄件帳號；本文件不含真實密碼。

## 部署前準備

- 使用 systemd 的 Linux 主機，以及實驗室核准來源提供的 Node.js 24.21.0。
- API 網域，例如 contact-api.example.edu，DNS 指向該主機。
- HTTPS 憑證及 Nginx，或實驗室核准的等效反向代理。
- SMTP relay 主機、連接埠和已授權的實驗室寄件地址。
- 由實驗室管理者確認收件信箱。目前網站隱私說明列出 zaira4edu@gmail.com；更換時要同步修改中英文說明。
- 防火牆只開放 HTTPS。Node API 綁定 127.0.0.1:8080，不得直接暴露到公網。

網站目前由 GitHub Pages 發佈於 https://errha-la.github.io/Labsite/。瀏覽器送出的 Origin 是 https://errha-la.github.io。設定 CONTACT_ALLOWED_ORIGIN 時只填 origin，不要加 /Labsite/ 路徑或結尾斜線。

## 安裝 API

以下命令以 Ubuntu/Debian、systemd、Nginx 為例。請先把 contact-api.example.edu 和 /usr/bin/node 換成實驗室實際設定。

1. 安裝 Git、Nginx，以及實驗室核准來源提供的 Node.js 24.21.0。確認 node --version 輸出 v24.21.0，並記下 command -v node 的絕對路徑。
2. 建立不允許登入的服務帳號，再部署程式碼：

   ~~~sh
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin labsite-contact
   sudo git clone --depth 1 --branch main https://github.com/Errha-la/Labsite.git /opt/labsite-contact-api
   cd /opt/labsite-contact-api/backend/contact-api
   sudo npm ci --omit=dev --ignore-scripts
   ~~~

3. 建立 root 可編輯、服務帳號可讀的環境檔：

   ~~~sh
   sudo install -o root -g labsite-contact -m 0640 /dev/null /etc/labsite-contact-api.env
   sudoedit /etc/labsite-contact-api.env
   ~~~

   填入下列設定。SMTP 密碼只放在此伺服器檔案或實驗室核准的 secrets manager，不要放進 Git、網站建置變數或命令列。編輯完成後再次執行 sudo chown root:labsite-contact /etc/labsite-contact-api.env 和 sudo chmod 0640 /etc/labsite-contact-api.env，確認服務帳號可讀而其他使用者不可讀。

   ~~~dotenv
   NODE_ENV=production
   CONTACT_MAIL_MODE=smtp
   CONTACT_BIND_HOST=127.0.0.1
   CONTACT_API_PORT=8080
   CONTACT_ALLOWED_ORIGIN=https://errha-la.github.io
   CONTACT_TO=zaira4edu@gmail.com
   MAIL_FROM=labsite-contact@example.edu
   CONTACT_MAX_PER_MINUTE=10
   CONTACT_MAX_IN_FLIGHT=2
   SMTP_HOST=smtp.example.edu
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=labsite-contact
   SMTP_PASS=由管理者安全填入
   ~~~

   SMTP 使用 587 時，程式要求 STARTTLS；使用 465 時改成 SMTP_SECURE=true。SMTP_USER 和 SMTP_PASS 必須同時設定或同時留空。

4. 建立 /etc/systemd/system/labsite-contact-api.service：

   ~~~ini
   [Unit]
   Description=Labsite Contact API
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=labsite-contact
   Group=labsite-contact
   WorkingDirectory=/opt/labsite-contact-api/backend/contact-api
   EnvironmentFile=/etc/labsite-contact-api.env
   ExecStart=/usr/bin/node server.js
   Restart=on-failure
   RestartSec=5
   NoNewPrivileges=true
   PrivateTmp=true
   ProtectSystem=strict
   ProtectHome=true
   UMask=0077

   [Install]
   WantedBy=multi-user.target
   ~~~

   若 command -v node 不是 /usr/bin/node，請更新 ExecStart。載入並啟動：

   ~~~sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now labsite-contact-api
   sudo systemctl status labsite-contact-api --no-pager
   ~~~

5. 在 /etc/nginx/conf.d/labsite-contact-api.conf 設定 API 網域的 HTTPS virtual host。確認此目錄由 Nginx 的 http 區塊載入。憑證路徑需換成實際值；只代理 /contact，其他路徑回覆 404：

   ~~~nginx
   limit_req_zone $binary_remote_addr zone=labsite_contact:10m rate=10r/m;

   server {
       listen 80;
       server_name contact-api.example.edu;
       return 301 https://$host$request_uri;
   }

   server {
       listen 443 ssl;
       server_name contact-api.example.edu;

       ssl_certificate     /etc/letsencrypt/live/contact-api.example.edu/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/contact-api.example.edu/privkey.pem;
       client_max_body_size 8k;

       location = /contact {
           limit_req zone=labsite_contact burst=3 nodelay;
           limit_req_status 429;
           proxy_pass http://127.0.0.1:8080;
           proxy_http_version 1.1;
           proxy_connect_timeout 5s;
           proxy_read_timeout 15s;
           proxy_send_timeout 15s;
       }

       location / {
           return 404;
       }
   }
   ~~~

   範例值應依實驗室預期流量調整。在 Nginx 或實驗室 WAF 啟用依來源 IP 的限制，並確認 request body 不會寫入記錄。程式內每分鐘 10 封上限是整個 API process 共用，不是每位訪客各 10 封。數字算式題提供基本垃圾訊息阻力，不是可靠的機器人辨識；Origin 可由非瀏覽器客戶端偽造，仍須保留反向代理的 IP 限制與整體寄信上限。挑戰題狀態存在單一 Node process 記憶體；若要跑多個 API process，需先改用可原子消耗的共享儲存。確認外部無法連線到 8080，再執行 nginx -t 和 sudo systemctl reload nginx。

6. 在 GitHub 的 Errha-la/Labsite repository 開啟 **Settings → Secrets and variables → Actions → Variables**，新增 VITE_CONTACT_API_URL，值為實際 HTTPS API URL，例如 https://contact-api.example.edu/contact。這是公開端點網址，不是密碼；SMTP 密碼不可放進這個變數。

   Pages workflow 會把這個變數提供給 Vite 建置。未設定時，表單不會送出，網站仍保留公開 email 聯絡方式。設定後，重新執行 main 的 Pages workflow。

## 驗收流程

先在 staging 環境完成安裝，並把 SMTP 指向測試信箱或 mail sink。不可用真實訪客資料做驗收。

1. **服務與網路**
   - systemctl is-active labsite-contact-api 回報 active。
   - 確認 Node 只監聽 127.0.0.1:8080，外部網路無法連線到 8080。
   - https://contact-api.example.edu/contact 使用受信任 TLS 憑證；未配置的 / 路徑回覆 404。
2. **CORS 預檢**

   ~~~sh
   curl -i -X OPTIONS https://contact-api.example.edu/contact \
     -H "Origin: https://errha-la.github.io" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: content-type"
   ~~~

   預期 HTTP 204，並包含 Access-Control-Allow-Origin: https://errha-la.github.io。API 也會允許 GET /contact 載入數字題。
3. **正常表單**

   先取得限時、一次性的算式題：

   ~~~sh
   curl -i https://contact-api.example.edu/contact \
     -H "Origin: https://errha-la.github.io"
   ~~~

   預期 HTTP 200、Cache-Control: no-store，以及 challengeId、question、expiresAt。答案不會出現在回應中。解題後將題目答案和 challengeId 填入表單請求：

   ~~~sh
   curl -i https://contact-api.example.edu/contact \
     -H "Origin: https://errha-la.github.io" \
     -H "Content-Type: application/json" \
     --data-binary '{"name":"驗收測試","email":"qa@example.org","reason":"professor","message":"Labsite 聯絡表單驗收","consent":true,"challengeId":"替換為題目回傳值","captchaAnswer":"替換為算式答案"}'
   ~~~

   `reason` 僅接受 `professor`、`industry` 或 `other`，且 `consent` 必須為 `true`。提交前將 qa@example.org 換成實驗室可收信的測試信箱。預期 HTTP 202。確認郵件包含來由和同意紀錄，且測試信只送到固定的 CONTACT_TO；寄件人是核准的 MAIL_FROM，訪客信箱只出現在 Reply-To，回覆可正常寄到測試信箱。
4. **拒絕條件**
   - 改用 Origin: https://untrusted.example，預期 403。
   - 重複使用已送出的 challengeId、提交錯誤答案，或使用過期題目，預期 400；`GET /contact?anything=1` 預期 400。
   - 提交未勾選同意或不在允許清單的來由，預期 400；使用其他未配置路徑預期 404，非 JSON body 預期 415。
   - 送出超過 8 KiB 的 request body，預期 413；在 staging 送超過設定上限的有效請求，預期 429。速率限制測試使用 mail sink，避免大量寄信。
   - 在 staging 停止 SMTP relay 後提交一次，預期回覆一般錯誤，不包含 SMTP 主機錯誤或訪客資料。
5. **網站端到端**
   - GitHub Pages Actions 完成 build/deploy；確認輸出的 index.html 已包含實際 VITE_CONTACT_API_URL，沒有 %VITE_CONTACT_API_URL% 或 SMTP 密碼。
   - 以 HTTPS 開啟網站，確認中英文表單欄位、來由標籤、同意勾選框、數字題、必填驗證、送出中、成功和失敗狀態皆可讀。
   - 勾選同意並答對數字題後，以測試信箱送出一封；確認瀏覽器只向 HTTPS API 發送資料、API 回覆成功、固定收件信箱收到含來由和同意紀錄的郵件，且郵件回覆會寄回測試信箱。
6. **隱私與運作**
   - 檢查 API、Nginx 和 SMTP relay 記錄沒有表單內容或訪客 email。確認伺服器不保存表單 body，收件信箱存取受限。
   - 由信箱管理者確認聯絡信件會在 180 天內刪除，並指定定期檢查責任人。

## 更新與回復

更新 API 時先記錄目前執行的 commit SHA，再於維護時段以已審查的 main commit 更新 /opt/labsite-contact-api，執行 npm ci --omit=dev --ignore-scripts，然後執行 sudo systemctl restart labsite-contact-api。若驗收失敗，回復到記錄的上一個 SHA，安裝該版本 lockfile 指定的依賴並重啟服務；確認 API 再次通過驗收第 1–3 項後結束回復。

## 圖片搜尋索引

Pages API 目前的網址是 https://errha-la.github.io/Labsite/。robots.txt 必須位於主機網域根目錄；放在此專案只會成為 /Labsite/robots.txt，不能設定 errha-la.github.io 的 robots 規則。因此本次在已發佈 HTML 頁面使用 noimageindex，要求支援此指令的搜尋引擎不要索引該頁面中的圖片，同時讓一般頁面內容仍可搜尋。若要控制直接圖片 URL、所有搜尋引擎或加快移除既有搜尋結果，需在網域根目錄設定圖片路徑的 robots 規則或圖片回應標頭，並使用各搜尋引擎的移除工具；搜尋結果仍要等爬蟲重新處理。

