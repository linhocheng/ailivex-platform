# 品牌素材庫 × 智慧制圖 — 功能規劃文件

> 版本：v1.0 · 2026-06-22

---

## 一、我們在解決什麼問題？

目前 ailiveX 的角色可以幫你寫故事腳本、然後每一頁自動生圖。  
但問題是：**生出來的圖跟品牌沒有關係。**

每一張圖的樣式都是 AI 自己決定的，沒有你的 Logo、沒有你的品牌色、也沒有你的產品出現在裡面。

這個功能要解決的就是這件事：
> **讓 AI 生圖的時候，知道你是誰、賣什麼、長什麼樣子。**

---

## 二、做出來會長什麼樣子？

### 後台（管理員操作）

**品牌素材庫** — 一個新的後台頁面，可以上傳：

| 素材類型 | 說明 | 可以有幾個 |
|---|---|---|
| 全版 Layout | 整體版面參考圖（含 Logo 位置、色系、排版感覺） | 多個版本（例如：日常版、節慶版、新品版） |
| 產品圖 | 產品照片，可加標籤方便搜尋 | 不限張數 |

### 故事板（使用者操作）

產圖前，多兩個選項：

1. **全版設定**：選擇要套哪一個 Layout 版本。選了之後，每一頁生圖都會參考這個版面的品牌感覺。
2. **頁面補圖**：某一頁的卡片如果剛好要展示產品，可以從資料庫選一張產品圖，或臨時上傳一張，AI 生圖時就會把那個產品帶進去。

### AI 生圖邏輯（幕後自動）

```
每張圖 = 全版 Layout 參考（品牌感覺）
        + 這頁的內容描述（腳本文字）
        + 產品圖（選填，這頁有用到產品才加）
```

---

## 三、技術架構（給開發者看）

### 資料結構（Firestore）

新增兩個 collection：

**`brand_layouts`**
```
{
  id: string
  characterId: string       // 綁定角色（每個角色有自己的 layouts）
  name: string              // 版本名稱（例如「日常版」）
  imageUrl: string          // GCS 上的參考圖 URL
  description: string       // 簡短說明
  isDefault: boolean        // 是否為該角色的預設版本
  createdAt: Timestamp
}
```
查詢：`where('characterId', '==', characterId)`

**`brand_products`**
```
{
  id: string
  characterId: string       // 綁定角色
  name: string              // 產品名稱
  imageUrl: string          // GCS 上的產品圖 URL（一圖一 doc，方便單張刪除）
  tags: string[]            // 標籤（方便搜尋）
  createdAt: Timestamp
}
```
查詢：`where('characterId', '==', characterId)`

GCS 路徑：
- Layout：`brand-assets/{characterId}/layouts/{docId}.{ext}`
- 產品圖：`brand-assets/{characterId}/products/{docId}.{ext}`

刪除時：同步刪 Firestore doc + GCS 實體。

**TaskDoc 新增欄位**
```
{
  brandLayoutId?: string    // story_draft 層：套用哪個 Layout（整份故事板共用）
  productImageUrl?: string  // card（image_generation）層：這張卡片指定的產品圖 URL
}
```

後台入口：`/admin/characters/[id]` 新增「品牌素材」分頁，不設獨立路由。

### 目前的制圖流程 vs 改動後

```
【現在】
卡片文字 prompt → media-worker → gpt-image-2 → 圖

【改動後】
卡片文字 prompt
  + 全版 Layout 參考圖（imageUrl）     ← 新增
  + 產品圖（imageUrl，選填）           ← 新增
  → media-worker（支援 referenceImageUrls）
  → gpt-image-2 edit 模式 / fal.ai img2img
  → 圖
```

---

## 四、施工清單

### Phase 1 — 資料結構（1 天）

- [ ] `src/lib/collections.ts` 新增 `BrandLayoutDoc`、`BrandProductDoc` 型別
- [ ] `TaskDoc` 新增 `brandLayoutId`、`productImageUrl` 欄位

### Phase 2 — 後台：品牌素材庫管理（2–3 天）

入口：`/admin/characters/[id]` 新增「品牌素材」Tab（不建獨立路由）

- [ ] **API routes**
  - [ ] `GET/POST /api/admin/characters/[id]/brand-layouts` — 列出 / 新增
  - [ ] `DELETE /api/admin/characters/[id]/brand-layouts/[layoutId]` — 刪除（含 GCS）
  - [ ] `PATCH /api/admin/characters/[id]/brand-layouts/[layoutId]` — 設預設
  - [ ] `GET/POST /api/admin/characters/[id]/brand-products` — 列出 / 新增
  - [ ] `DELETE /api/admin/characters/[id]/brand-products/[productId]` — 刪除（含 GCS）
- [ ] **後台 UI（品牌素材 Tab）**
  - [ ] Layout 列表：縮圖 + 名稱 + 預設標記 + 刪除按鈕
  - [ ] 上傳 Layout：圖片 + 名稱 + 描述 → GCS `brand-assets/{characterId}/layouts/{id}.{ext}`
  - [ ] 設定預設 Layout
  - [ ] 產品圖列表：縮圖 grid + 名稱 + tag + 刪除按鈕
  - [ ] 上傳產品圖：圖片 + 名稱 + tags → GCS `brand-assets/{characterId}/products/{id}.{ext}`

### Phase 3 — 故事板 UI：選素材（2 天）✅ 2026-06-22

- [x] 故事板設定區塊新增「全版設定」下拉選單（選 Layout 版本）
- [x] 每張卡片新增「產品圖」按鈕
  - [x] 「從資料庫選」→ 顯示產品圖列表（底部滑出 picker）
  - [x] 「上傳產品圖」→ 臨時上傳，僅此次使用（GCS temp 路徑）
- [x] 儲存選擇到 `TaskDoc`（`brandLayoutId`、`productImageUrl`）
- [x] 新增 user-accessible API routes（`/api/brands/[characterId]/layouts|products|upload`）

### Phase 4 — media-worker：支援參考圖（1–2 天）

- [ ] `src/providers/types.ts` 的 `ImageInput` 新增 `referenceImageUrls?: string[]`
- [ ] `openai-image.ts` 切換為 gpt-image-2 **edit 模式**（支援參考圖）
  - 或：新增 fal.ai FLUX + IP-Adapter provider（品質更好但需測試）
- [ ] `worker.ts` 處理 `referenceImageUrls` 並傳給 provider

### Phase 5 — 制圖 Route 整合（1 天）

- [ ] `generate-images/route.ts` 的 `dispatchCard` 函數：
  - [ ] 讀 `brandLayoutId` → 查 `brand_layouts` → 取 `imageUrl`
  - [ ] 讀 `productImageUrl`（卡片層級）
  - [ ] 組裝 `referenceImageUrls: [layoutUrl, productUrl].filter(Boolean)` 傳給 media-worker

### Phase 6 — 測試（1 天）

- [ ] 本機驗證：有 Layout 無產品圖 → 生圖品牌感覺一致
- [ ] 本機驗證：有 Layout + 有產品圖 → 產品出現在畫面中
- [ ] 驗證：無設定時流程不受影響（向下相容）
- [ ] 部署 media-worker → Vercel → 端到端跑過

---

## 五、未來可以擴充的方向

- 角色可以預設綁定某個 Layout（選了角色自動帶品牌）
- 對話中 AI 自動辨識提到的產品名稱，自動帶入對應產品圖
- Layout 版本支援「節慶」「季節」等時段自動切換

---

## 六、不在這次範圍內

- Logo 精準疊圖（程式合成圖層）— 這是另一套技術路徑，改版再做
- 產品圖訓練 LoRA / Fine-tune — 需要 GPU 資源，另案評估
