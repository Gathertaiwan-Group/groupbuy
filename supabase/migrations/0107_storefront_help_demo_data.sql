-- 說明中心／公告示範資料：結構數量對齊原站擷取頁（spec/html/fe-help-home-jranv、fe-help-menu-4411、fe-news-list）。
-- 內容一律為中性示範文字（不抄原站標題／內文），只對齊：選單節點數與層級、文章總數（分頁 27 頁）、標籤數（8）、公告筆數（20）與每則公告內文的 HTML 骨架。
-- 只動 groupbuy schema 的平台租戶（groupbuyforms，說明中心團購 34565／選單 964002）資料；保留既有 id／網址（4411、964111、966001–966014 等）。
-- 冪等：既有列以 update 設定固定值；新增列使用保留區段（節點 964301–964399、文章 965101–965499、公告 966101–966199）＋ on conflict (id) do update。
-- 注意：scripts/seed-demo.mjs 重跑會把 964120–964130 改回 4411 的子節點並 cascade 刪除本檔的子節點（本檔不會因 ledger 再跑），需要時手動重跑本檔 SQL。
do $$
declare
  t bigint;
  s text;
  cur bigint;
  mx bigint;
begin
  select tenant_id into t from groupbuy.web_menus where id = 964002 and group_buy_id = 34565;
  if t is null or not exists (select 1 from groupbuy.web_menu_nodes where id = 4411 and tenant_id = t) then
    raise notice '0107: 找不到說明中心示範選單（964002／4411），略過';
    return;
  end if;

  -- 第一層節點（既有節點改為第一層並重排順序；新增 5 個中性名稱節點）
  update groupbuy.web_menu_nodes set parent_id = null, seq = 0, updated_at = now() where id = 964111 and tenant_id = t and web_menu_id = 964002;
  update groupbuy.web_menu_nodes set parent_id = null, seq = 1, updated_at = now() where id = 4411 and tenant_id = t and web_menu_id = 964002;
  update groupbuy.web_menu_nodes set parent_id = null, seq = 2, updated_at = now() where id = 964120 and tenant_id = t and web_menu_id = 964002;
  update groupbuy.web_menu_nodes set parent_id = null, seq = 3, updated_at = now() where id = 964121 and tenant_id = t and web_menu_id = 964002;
  update groupbuy.web_menu_nodes set parent_id = null, seq = 4, updated_at = now() where id = 964122 and tenant_id = t and web_menu_id = 964002;
  update groupbuy.web_menu_nodes set parent_id = null, seq = 5, updated_at = now() where id = 964123 and tenant_id = t and web_menu_id = 964002;
  update groupbuy.web_menu_nodes set parent_id = null, seq = 6, updated_at = now() where id = 964124 and tenant_id = t and web_menu_id = 964002;
  update groupbuy.web_menu_nodes set parent_id = null, seq = 7, updated_at = now() where id = 964125 and tenant_id = t and web_menu_id = 964002;
  update groupbuy.web_menu_nodes set parent_id = null, seq = 8, updated_at = now() where id = 964126 and tenant_id = t and web_menu_id = 964002;
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964301, t, 964002, null, '教學分類 A', null, 9)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = null, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  update groupbuy.web_menu_nodes set parent_id = null, seq = 10, updated_at = now() where id = 964127 and tenant_id = t and web_menu_id = 964002;
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964302, t, 964002, null, '教學分類 B', null, 11)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = null, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964303, t, 964002, null, '教學分類 C', null, 12)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = null, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  update groupbuy.web_menu_nodes set parent_id = null, seq = 13, updated_at = now() where id = 964128 and tenant_id = t and web_menu_id = 964002;
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964304, t, 964002, null, '教學分類 D', null, 14)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = null, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  update groupbuy.web_menu_nodes set parent_id = null, seq = 15, updated_at = now() where id = 964129 and tenant_id = t and web_menu_id = 964002;
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964305, t, 964002, null, '教學分類 E', null, 16)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = null, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  update groupbuy.web_menu_nodes set parent_id = null, seq = 17, updated_at = now() where id = 964130 and tenant_id = t and web_menu_id = 964002;
  -- 第二層節點（30 個）
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964311, t, 964002, 964120, '教學子分類 02-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964312, t, 964002, 964120, '教學子分類 02-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964313, t, 964002, 964120, '教學子分類 02-3', null, 3)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964314, t, 964002, 964121, '教學子分類 03-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964315, t, 964002, 964121, '教學子分類 03-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964316, t, 964002, 964121, '教學子分類 03-3', null, 3)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964317, t, 964002, 964122, '教學子分類 04-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964318, t, 964002, 964122, '教學子分類 04-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964319, t, 964002, 964122, '教學子分類 04-3', null, 3)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964320, t, 964002, 964123, '教學子分類 05-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964321, t, 964002, 964123, '教學子分類 05-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964322, t, 964002, 964123, '教學子分類 05-3', null, 3)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964323, t, 964002, 964123, '教學子分類 05-4', null, 4)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964324, t, 964002, 964124, '教學子分類 06-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964325, t, 964002, 964124, '教學子分類 06-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964326, t, 964002, 964125, '教學子分類 07-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964327, t, 964002, 964125, '教學子分類 07-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964328, t, 964002, 964126, '教學子分類 08-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964329, t, 964002, 964126, '教學子分類 08-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964330, t, 964002, 964302, '教學子分類 11-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964331, t, 964002, 964302, '教學子分類 11-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964332, t, 964002, 964302, '教學子分類 11-3', null, 3)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964333, t, 964002, 964302, '教學子分類 11-4', null, 4)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964334, t, 964002, 964302, '教學子分類 11-5', null, 5)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964335, t, 964002, 964302, '教學子分類 11-6', null, 6)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964336, t, 964002, 964302, '教學子分類 11-7', null, 7)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964337, t, 964002, 964128, '教學子分類 13-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964338, t, 964002, 964128, '教學子分類 13-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964339, t, 964002, 964129, '教學子分類 15-1', null, 1)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  insert into groupbuy.web_menu_nodes (id, tenant_id, web_menu_id, parent_id, title, url, seq) values (964340, t, 964002, 964129, '教學子分類 15-2', null, 2)
    on conflict (id) do update set tenant_id = excluded.tenant_id, web_menu_id = excluded.web_menu_id, parent_id = excluded.parent_id, title = excluded.title, url = null, seq = excluded.seq, updated_at = now();
  -- 文章（252 篇，全部掛「所有教學」4411，日期早於既有 13 篇）
  insert into groupbuy.posts (id, tenant_id, group_buy_id, web_menu_node_id, title, summary, body, tags, is_published, date_published) values
    (965101, t, 34565, 4411, '示範教學文章 014', '這是示範用的說明摘要（文章 014），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 014）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-06-01 10:00:00+08'),
    (965102, t, 34565, 4411, '示範教學文章 015', '這是示範用的說明摘要（文章 015），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 015）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-05-31 10:00:00+08'),
    (965103, t, 34565, 4411, '示範教學文章 016', '這是示範用的說明摘要（文章 016），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 016）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-05-30 10:00:00+08'),
    (965104, t, 34565, 4411, '示範教學文章 017', '這是示範用的說明摘要（文章 017），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 017）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-05-29 10:00:00+08'),
    (965105, t, 34565, 4411, '示範教學文章 018', '這是示範用的說明摘要（文章 018），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 018）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-05-28 10:00:00+08'),
    (965106, t, 34565, 4411, '示範教學文章 019', '這是示範用的說明摘要（文章 019），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 019）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-05-27 10:00:00+08'),
    (965107, t, 34565, 4411, '示範教學文章 020', '這是示範用的說明摘要（文章 020），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 020）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-05-26 10:00:00+08'),
    (965108, t, 34565, 4411, '示範教學文章 021', '這是示範用的說明摘要（文章 021），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 021）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-05-25 10:00:00+08'),
    (965109, t, 34565, 4411, '示範教學文章 022', '這是示範用的說明摘要（文章 022），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 022）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-05-24 10:00:00+08'),
    (965110, t, 34565, 4411, '示範教學文章 023', '這是示範用的說明摘要（文章 023），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 023）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2025-05-23 10:00:00+08'),
    (965111, t, 34565, 4411, '示範教學文章 024', '這是示範用的說明摘要（文章 024），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 024）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-05-22 10:00:00+08'),
    (965112, t, 34565, 4411, '示範教學文章 025', '這是示範用的說明摘要（文章 025），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 025）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-05-21 10:00:00+08'),
    (965113, t, 34565, 4411, '示範教學文章 026', '這是示範用的說明摘要（文章 026），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 026）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2025-05-20 10:00:00+08'),
    (965114, t, 34565, 4411, '示範教學文章 027', '這是示範用的說明摘要（文章 027），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 027）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-05-19 10:00:00+08'),
    (965115, t, 34565, 4411, '示範教學文章 028', '這是示範用的說明摘要（文章 028），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 028）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-05-18 10:00:00+08'),
    (965116, t, 34565, 4411, '示範教學文章 029', '這是示範用的說明摘要（文章 029），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 029）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2025-05-17 10:00:00+08'),
    (965117, t, 34565, 4411, '示範教學文章 030', '這是示範用的說明摘要（文章 030），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 030）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-05-16 10:00:00+08'),
    (965118, t, 34565, 4411, '示範教學文章 031', '這是示範用的說明摘要（文章 031），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 031）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-05-15 10:00:00+08'),
    (965119, t, 34565, 4411, '示範教學文章 032', '這是示範用的說明摘要（文章 032），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 032）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2025-05-14 10:00:00+08'),
    (965120, t, 34565, 4411, '示範教學文章 033', '這是示範用的說明摘要（文章 033），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 033）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-05-13 10:00:00+08'),
    (965121, t, 34565, 4411, '示範教學文章 034', '這是示範用的說明摘要（文章 034），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 034）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-05-12 10:00:00+08'),
    (965122, t, 34565, 4411, '示範教學文章 035', '這是示範用的說明摘要（文章 035），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 035）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2025-05-11 10:00:00+08'),
    (965123, t, 34565, 4411, '示範教學文章 036', '這是示範用的說明摘要（文章 036），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 036）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-05-10 10:00:00+08'),
    (965124, t, 34565, 4411, '示範教學文章 037', '這是示範用的說明摘要（文章 037），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 037）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-05-09 10:00:00+08'),
    (965125, t, 34565, 4411, '示範教學文章 038', '這是示範用的說明摘要（文章 038），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 038）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2025-05-08 10:00:00+08'),
    (965126, t, 34565, 4411, '示範教學文章 039', '這是示範用的說明摘要（文章 039），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 039）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-05-07 10:00:00+08'),
    (965127, t, 34565, 4411, '示範教學文章 040', '這是示範用的說明摘要（文章 040），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 040）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-05-06 10:00:00+08'),
    (965128, t, 34565, 4411, '示範教學文章 041', '這是示範用的說明摘要（文章 041），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 041）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2025-05-05 10:00:00+08'),
    (965129, t, 34565, 4411, '示範教學文章 042', '這是示範用的說明摘要（文章 042），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 042）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-05-04 10:00:00+08'),
    (965130, t, 34565, 4411, '示範教學文章 043', '這是示範用的說明摘要（文章 043），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 043）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-05-03 10:00:00+08'),
    (965131, t, 34565, 4411, '示範教學文章 044', '這是示範用的說明摘要（文章 044），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 044）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2025-05-02 10:00:00+08'),
    (965132, t, 34565, 4411, '示範教學文章 045', '這是示範用的說明摘要（文章 045），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 045）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-05-01 10:00:00+08'),
    (965133, t, 34565, 4411, '示範教學文章 046', '這是示範用的說明摘要（文章 046），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 046）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-04-30 10:00:00+08'),
    (965134, t, 34565, 4411, '示範教學文章 047', '這是示範用的說明摘要（文章 047），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 047）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2025-04-29 10:00:00+08'),
    (965135, t, 34565, 4411, '示範教學文章 048', '這是示範用的說明摘要（文章 048），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 048）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-04-28 10:00:00+08'),
    (965136, t, 34565, 4411, '示範教學文章 049', '這是示範用的說明摘要（文章 049），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 049）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-04-27 10:00:00+08'),
    (965137, t, 34565, 4411, '示範教學文章 050', '這是示範用的說明摘要（文章 050），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 050）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2025-04-26 10:00:00+08'),
    (965138, t, 34565, 4411, '示範教學文章 051', '這是示範用的說明摘要（文章 051），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 051）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-04-25 10:00:00+08'),
    (965139, t, 34565, 4411, '示範教學文章 052', '這是示範用的說明摘要（文章 052），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 052）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-04-24 10:00:00+08'),
    (965140, t, 34565, 4411, '示範教學文章 053', '這是示範用的說明摘要（文章 053），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 053）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2025-04-23 10:00:00+08'),
    (965141, t, 34565, 4411, '示範教學文章 054', '這是示範用的說明摘要（文章 054），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 054）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-04-22 10:00:00+08'),
    (965142, t, 34565, 4411, '示範教學文章 055', '這是示範用的說明摘要（文章 055），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 055）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-04-21 10:00:00+08'),
    (965143, t, 34565, 4411, '示範教學文章 056', '這是示範用的說明摘要（文章 056），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 056）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2025-04-20 10:00:00+08'),
    (965144, t, 34565, 4411, '示範教學文章 057', '這是示範用的說明摘要（文章 057），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 057）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-04-19 10:00:00+08'),
    (965145, t, 34565, 4411, '示範教學文章 058', '這是示範用的說明摘要（文章 058），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 058）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-04-18 10:00:00+08'),
    (965146, t, 34565, 4411, '示範教學文章 059', '這是示範用的說明摘要（文章 059），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 059）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2025-04-17 10:00:00+08'),
    (965147, t, 34565, 4411, '示範教學文章 060', '這是示範用的說明摘要（文章 060），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 060）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-04-16 10:00:00+08'),
    (965148, t, 34565, 4411, '示範教學文章 061', '這是示範用的說明摘要（文章 061），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 061）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-04-15 10:00:00+08'),
    (965149, t, 34565, 4411, '示範教學文章 062', '這是示範用的說明摘要（文章 062），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 062）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2025-04-14 10:00:00+08'),
    (965150, t, 34565, 4411, '示範教學文章 063', '這是示範用的說明摘要（文章 063），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 063）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-04-13 10:00:00+08'),
    (965151, t, 34565, 4411, '示範教學文章 064', '這是示範用的說明摘要（文章 064），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 064）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-04-12 10:00:00+08'),
    (965152, t, 34565, 4411, '示範教學文章 065', '這是示範用的說明摘要（文章 065），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 065）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2025-04-11 10:00:00+08'),
    (965153, t, 34565, 4411, '示範教學文章 066', '這是示範用的說明摘要（文章 066），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 066）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-04-10 10:00:00+08'),
    (965154, t, 34565, 4411, '示範教學文章 067', '這是示範用的說明摘要（文章 067），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 067）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-04-09 10:00:00+08'),
    (965155, t, 34565, 4411, '示範教學文章 068', '這是示範用的說明摘要（文章 068），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 068）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2025-04-08 10:00:00+08'),
    (965156, t, 34565, 4411, '示範教學文章 069', '這是示範用的說明摘要（文章 069），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 069）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-04-07 10:00:00+08'),
    (965157, t, 34565, 4411, '示範教學文章 070', '這是示範用的說明摘要（文章 070），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 070）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-04-06 10:00:00+08'),
    (965158, t, 34565, 4411, '示範教學文章 071', '這是示範用的說明摘要（文章 071），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 071）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2025-04-05 10:00:00+08'),
    (965159, t, 34565, 4411, '示範教學文章 072', '這是示範用的說明摘要（文章 072），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 072）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-04-04 10:00:00+08'),
    (965160, t, 34565, 4411, '示範教學文章 073', '這是示範用的說明摘要（文章 073），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 073）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-04-03 10:00:00+08'),
    (965161, t, 34565, 4411, '示範教學文章 074', '這是示範用的說明摘要（文章 074），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 074）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2025-04-02 10:00:00+08'),
    (965162, t, 34565, 4411, '示範教學文章 075', '這是示範用的說明摘要（文章 075），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 075）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-04-01 10:00:00+08'),
    (965163, t, 34565, 4411, '示範教學文章 076', '這是示範用的說明摘要（文章 076），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 076）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-03-31 10:00:00+08'),
    (965164, t, 34565, 4411, '示範教學文章 077', '這是示範用的說明摘要（文章 077），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 077）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2025-03-30 10:00:00+08'),
    (965165, t, 34565, 4411, '示範教學文章 078', '這是示範用的說明摘要（文章 078），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 078）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-03-29 10:00:00+08'),
    (965166, t, 34565, 4411, '示範教學文章 079', '這是示範用的說明摘要（文章 079），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 079）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-03-28 10:00:00+08'),
    (965167, t, 34565, 4411, '示範教學文章 080', '這是示範用的說明摘要（文章 080），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 080）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2025-03-27 10:00:00+08'),
    (965168, t, 34565, 4411, '示範教學文章 081', '這是示範用的說明摘要（文章 081），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 081）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-03-26 10:00:00+08'),
    (965169, t, 34565, 4411, '示範教學文章 082', '這是示範用的說明摘要（文章 082），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 082）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-03-25 10:00:00+08'),
    (965170, t, 34565, 4411, '示範教學文章 083', '這是示範用的說明摘要（文章 083），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 083）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2025-03-24 10:00:00+08'),
    (965171, t, 34565, 4411, '示範教學文章 084', '這是示範用的說明摘要（文章 084），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 084）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-03-23 10:00:00+08'),
    (965172, t, 34565, 4411, '示範教學文章 085', '這是示範用的說明摘要（文章 085），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 085）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-03-22 10:00:00+08'),
    (965173, t, 34565, 4411, '示範教學文章 086', '這是示範用的說明摘要（文章 086），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 086）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2025-03-21 10:00:00+08'),
    (965174, t, 34565, 4411, '示範教學文章 087', '這是示範用的說明摘要（文章 087），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 087）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-03-20 10:00:00+08'),
    (965175, t, 34565, 4411, '示範教學文章 088', '這是示範用的說明摘要（文章 088），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 088）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-03-19 10:00:00+08'),
    (965176, t, 34565, 4411, '示範教學文章 089', '這是示範用的說明摘要（文章 089），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 089）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2025-03-18 10:00:00+08'),
    (965177, t, 34565, 4411, '示範教學文章 090', '這是示範用的說明摘要（文章 090），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 090）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-03-17 10:00:00+08'),
    (965178, t, 34565, 4411, '示範教學文章 091', '這是示範用的說明摘要（文章 091），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 091）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-03-16 10:00:00+08'),
    (965179, t, 34565, 4411, '示範教學文章 092', '這是示範用的說明摘要（文章 092），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 092）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2025-03-15 10:00:00+08'),
    (965180, t, 34565, 4411, '示範教學文章 093', '這是示範用的說明摘要（文章 093），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 093）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-03-14 10:00:00+08'),
    (965181, t, 34565, 4411, '示範教學文章 094', '這是示範用的說明摘要（文章 094），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 094）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-03-13 10:00:00+08'),
    (965182, t, 34565, 4411, '示範教學文章 095', '這是示範用的說明摘要（文章 095），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 095）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2025-03-12 10:00:00+08'),
    (965183, t, 34565, 4411, '示範教學文章 096', '這是示範用的說明摘要（文章 096），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 096）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-03-11 10:00:00+08'),
    (965184, t, 34565, 4411, '示範教學文章 097', '這是示範用的說明摘要（文章 097），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 097）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-03-10 10:00:00+08'),
    (965185, t, 34565, 4411, '示範教學文章 098', '這是示範用的說明摘要（文章 098），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 098）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2025-03-09 10:00:00+08'),
    (965186, t, 34565, 4411, '示範教學文章 099', '這是示範用的說明摘要（文章 099），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 099）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-03-08 10:00:00+08'),
    (965187, t, 34565, 4411, '示範教學文章 100', '這是示範用的說明摘要（文章 100），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 100）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-03-07 10:00:00+08'),
    (965188, t, 34565, 4411, '示範教學文章 101', '這是示範用的說明摘要（文章 101），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 101）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2025-03-06 10:00:00+08'),
    (965189, t, 34565, 4411, '示範教學文章 102', '這是示範用的說明摘要（文章 102），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 102）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-03-05 10:00:00+08'),
    (965190, t, 34565, 4411, '示範教學文章 103', '這是示範用的說明摘要（文章 103），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 103）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-03-04 10:00:00+08'),
    (965191, t, 34565, 4411, '示範教學文章 104', '這是示範用的說明摘要（文章 104），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 104）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2025-03-03 10:00:00+08'),
    (965192, t, 34565, 4411, '示範教學文章 105', '這是示範用的說明摘要（文章 105），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 105）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-03-02 10:00:00+08'),
    (965193, t, 34565, 4411, '示範教學文章 106', '這是示範用的說明摘要（文章 106），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 106）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-03-01 10:00:00+08'),
    (965194, t, 34565, 4411, '示範教學文章 107', '這是示範用的說明摘要（文章 107），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 107）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2025-02-28 10:00:00+08'),
    (965195, t, 34565, 4411, '示範教學文章 108', '這是示範用的說明摘要（文章 108），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 108）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-02-27 10:00:00+08'),
    (965196, t, 34565, 4411, '示範教學文章 109', '這是示範用的說明摘要（文章 109），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 109）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-02-26 10:00:00+08'),
    (965197, t, 34565, 4411, '示範教學文章 110', '這是示範用的說明摘要（文章 110），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 110）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2025-02-25 10:00:00+08'),
    (965198, t, 34565, 4411, '示範教學文章 111', '這是示範用的說明摘要（文章 111），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 111）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-02-24 10:00:00+08'),
    (965199, t, 34565, 4411, '示範教學文章 112', '這是示範用的說明摘要（文章 112），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 112）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-02-23 10:00:00+08'),
    (965200, t, 34565, 4411, '示範教學文章 113', '這是示範用的說明摘要（文章 113），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 113）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2025-02-22 10:00:00+08'),
    (965201, t, 34565, 4411, '示範教學文章 114', '這是示範用的說明摘要（文章 114），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 114）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-02-21 10:00:00+08'),
    (965202, t, 34565, 4411, '示範教學文章 115', '這是示範用的說明摘要（文章 115），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 115）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-02-20 10:00:00+08'),
    (965203, t, 34565, 4411, '示範教學文章 116', '這是示範用的說明摘要（文章 116），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 116）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2025-02-19 10:00:00+08'),
    (965204, t, 34565, 4411, '示範教學文章 117', '這是示範用的說明摘要（文章 117），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 117）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-02-18 10:00:00+08'),
    (965205, t, 34565, 4411, '示範教學文章 118', '這是示範用的說明摘要（文章 118），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 118）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-02-17 10:00:00+08'),
    (965206, t, 34565, 4411, '示範教學文章 119', '這是示範用的說明摘要（文章 119），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 119）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2025-02-16 10:00:00+08'),
    (965207, t, 34565, 4411, '示範教學文章 120', '這是示範用的說明摘要（文章 120），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 120）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-02-15 10:00:00+08'),
    (965208, t, 34565, 4411, '示範教學文章 121', '這是示範用的說明摘要（文章 121），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 121）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-02-14 10:00:00+08'),
    (965209, t, 34565, 4411, '示範教學文章 122', '這是示範用的說明摘要（文章 122），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 122）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2025-02-13 10:00:00+08'),
    (965210, t, 34565, 4411, '示範教學文章 123', '這是示範用的說明摘要（文章 123），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 123）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-02-12 10:00:00+08'),
    (965211, t, 34565, 4411, '示範教學文章 124', '這是示範用的說明摘要（文章 124），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 124）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-02-11 10:00:00+08'),
    (965212, t, 34565, 4411, '示範教學文章 125', '這是示範用的說明摘要（文章 125），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 125）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2025-02-10 10:00:00+08'),
    (965213, t, 34565, 4411, '示範教學文章 126', '這是示範用的說明摘要（文章 126），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 126）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-02-09 10:00:00+08'),
    (965214, t, 34565, 4411, '示範教學文章 127', '這是示範用的說明摘要（文章 127），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 127）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-02-08 10:00:00+08'),
    (965215, t, 34565, 4411, '示範教學文章 128', '這是示範用的說明摘要（文章 128），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 128）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2025-02-07 10:00:00+08'),
    (965216, t, 34565, 4411, '示範教學文章 129', '這是示範用的說明摘要（文章 129），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 129）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-02-06 10:00:00+08'),
    (965217, t, 34565, 4411, '示範教學文章 130', '這是示範用的說明摘要（文章 130），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 130）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-02-05 10:00:00+08'),
    (965218, t, 34565, 4411, '示範教學文章 131', '這是示範用的說明摘要（文章 131），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 131）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2025-02-04 10:00:00+08'),
    (965219, t, 34565, 4411, '示範教學文章 132', '這是示範用的說明摘要（文章 132），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 132）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-02-03 10:00:00+08'),
    (965220, t, 34565, 4411, '示範教學文章 133', '這是示範用的說明摘要（文章 133），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 133）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-02-02 10:00:00+08'),
    (965221, t, 34565, 4411, '示範教學文章 134', '這是示範用的說明摘要（文章 134），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 134）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2025-02-01 10:00:00+08'),
    (965222, t, 34565, 4411, '示範教學文章 135', '這是示範用的說明摘要（文章 135），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 135）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-01-31 10:00:00+08'),
    (965223, t, 34565, 4411, '示範教學文章 136', '這是示範用的說明摘要（文章 136），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 136）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-01-30 10:00:00+08'),
    (965224, t, 34565, 4411, '示範教學文章 137', '這是示範用的說明摘要（文章 137），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 137）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2025-01-29 10:00:00+08'),
    (965225, t, 34565, 4411, '示範教學文章 138', '這是示範用的說明摘要（文章 138），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 138）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-01-28 10:00:00+08'),
    (965226, t, 34565, 4411, '示範教學文章 139', '這是示範用的說明摘要（文章 139），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 139）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-01-27 10:00:00+08'),
    (965227, t, 34565, 4411, '示範教學文章 140', '這是示範用的說明摘要（文章 140），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 140）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2025-01-26 10:00:00+08'),
    (965228, t, 34565, 4411, '示範教學文章 141', '這是示範用的說明摘要（文章 141），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 141）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-01-25 10:00:00+08'),
    (965229, t, 34565, 4411, '示範教學文章 142', '這是示範用的說明摘要（文章 142），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 142）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-01-24 10:00:00+08'),
    (965230, t, 34565, 4411, '示範教學文章 143', '這是示範用的說明摘要（文章 143），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 143）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2025-01-23 10:00:00+08'),
    (965231, t, 34565, 4411, '示範教學文章 144', '這是示範用的說明摘要（文章 144），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 144）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-01-22 10:00:00+08'),
    (965232, t, 34565, 4411, '示範教學文章 145', '這是示範用的說明摘要（文章 145），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 145）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-01-21 10:00:00+08'),
    (965233, t, 34565, 4411, '示範教學文章 146', '這是示範用的說明摘要（文章 146），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 146）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2025-01-20 10:00:00+08'),
    (965234, t, 34565, 4411, '示範教學文章 147', '這是示範用的說明摘要（文章 147），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 147）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-01-19 10:00:00+08'),
    (965235, t, 34565, 4411, '示範教學文章 148', '這是示範用的說明摘要（文章 148），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 148）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-01-18 10:00:00+08'),
    (965236, t, 34565, 4411, '示範教學文章 149', '這是示範用的說明摘要（文章 149），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 149）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2025-01-17 10:00:00+08'),
    (965237, t, 34565, 4411, '示範教學文章 150', '這是示範用的說明摘要（文章 150），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 150）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2025-01-16 10:00:00+08'),
    (965238, t, 34565, 4411, '示範教學文章 151', '這是示範用的說明摘要（文章 151），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 151）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-01-15 10:00:00+08'),
    (965239, t, 34565, 4411, '示範教學文章 152', '這是示範用的說明摘要（文章 152），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 152）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2025-01-14 10:00:00+08'),
    (965240, t, 34565, 4411, '示範教學文章 153', '這是示範用的說明摘要（文章 153），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 153）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2025-01-13 10:00:00+08'),
    (965241, t, 34565, 4411, '示範教學文章 154', '這是示範用的說明摘要（文章 154），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 154）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-01-12 10:00:00+08'),
    (965242, t, 34565, 4411, '示範教學文章 155', '這是示範用的說明摘要（文章 155），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 155）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2025-01-11 10:00:00+08'),
    (965243, t, 34565, 4411, '示範教學文章 156', '這是示範用的說明摘要（文章 156），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 156）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2025-01-10 10:00:00+08'),
    (965244, t, 34565, 4411, '示範教學文章 157', '這是示範用的說明摘要（文章 157），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 157）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-01-09 10:00:00+08'),
    (965245, t, 34565, 4411, '示範教學文章 158', '這是示範用的說明摘要（文章 158），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 158）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2025-01-08 10:00:00+08'),
    (965246, t, 34565, 4411, '示範教學文章 159', '這是示範用的說明摘要（文章 159），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 159）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2025-01-07 10:00:00+08'),
    (965247, t, 34565, 4411, '示範教學文章 160', '這是示範用的說明摘要（文章 160），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 160）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2025-01-06 10:00:00+08'),
    (965248, t, 34565, 4411, '示範教學文章 161', '這是示範用的說明摘要（文章 161），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 161）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2025-01-05 10:00:00+08'),
    (965249, t, 34565, 4411, '示範教學文章 162', '這是示範用的說明摘要（文章 162），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 162）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2025-01-04 10:00:00+08'),
    (965250, t, 34565, 4411, '示範教學文章 163', '這是示範用的說明摘要（文章 163），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 163）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2025-01-03 10:00:00+08'),
    (965251, t, 34565, 4411, '示範教學文章 164', '這是示範用的說明摘要（文章 164），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 164）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2025-01-02 10:00:00+08'),
    (965252, t, 34565, 4411, '示範教學文章 165', '這是示範用的說明摘要（文章 165），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 165）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2025-01-01 10:00:00+08'),
    (965253, t, 34565, 4411, '示範教學文章 166', '這是示範用的說明摘要（文章 166），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 166）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2024-12-31 10:00:00+08'),
    (965254, t, 34565, 4411, '示範教學文章 167', '這是示範用的說明摘要（文章 167），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 167）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2024-12-30 10:00:00+08'),
    (965255, t, 34565, 4411, '示範教學文章 168', '這是示範用的說明摘要（文章 168），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 168）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2024-12-29 10:00:00+08'),
    (965256, t, 34565, 4411, '示範教學文章 169', '這是示範用的說明摘要（文章 169），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 169）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2024-12-28 10:00:00+08'),
    (965257, t, 34565, 4411, '示範教學文章 170', '這是示範用的說明摘要（文章 170），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 170）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2024-12-27 10:00:00+08'),
    (965258, t, 34565, 4411, '示範教學文章 171', '這是示範用的說明摘要（文章 171），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 171）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2024-12-26 10:00:00+08'),
    (965259, t, 34565, 4411, '示範教學文章 172', '這是示範用的說明摘要（文章 172），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 172）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2024-12-25 10:00:00+08'),
    (965260, t, 34565, 4411, '示範教學文章 173', '這是示範用的說明摘要（文章 173），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 173）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2024-12-24 10:00:00+08'),
    (965261, t, 34565, 4411, '示範教學文章 174', '這是示範用的說明摘要（文章 174），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 174）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2024-12-23 10:00:00+08'),
    (965262, t, 34565, 4411, '示範教學文章 175', '這是示範用的說明摘要（文章 175），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 175）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2024-12-22 10:00:00+08'),
    (965263, t, 34565, 4411, '示範教學文章 176', '這是示範用的說明摘要（文章 176），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 176）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2024-12-21 10:00:00+08'),
    (965264, t, 34565, 4411, '示範教學文章 177', '這是示範用的說明摘要（文章 177），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 177）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2024-12-20 10:00:00+08'),
    (965265, t, 34565, 4411, '示範教學文章 178', '這是示範用的說明摘要（文章 178），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 178）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2024-12-19 10:00:00+08'),
    (965266, t, 34565, 4411, '示範教學文章 179', '這是示範用的說明摘要（文章 179），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 179）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2024-12-18 10:00:00+08'),
    (965267, t, 34565, 4411, '示範教學文章 180', '這是示範用的說明摘要（文章 180），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 180）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2024-12-17 10:00:00+08'),
    (965268, t, 34565, 4411, '示範教學文章 181', '這是示範用的說明摘要（文章 181），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 181）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2024-12-16 10:00:00+08'),
    (965269, t, 34565, 4411, '示範教學文章 182', '這是示範用的說明摘要（文章 182），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 182）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2024-12-15 10:00:00+08'),
    (965270, t, 34565, 4411, '示範教學文章 183', '這是示範用的說明摘要（文章 183），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 183）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2024-12-14 10:00:00+08'),
    (965271, t, 34565, 4411, '示範教學文章 184', '這是示範用的說明摘要（文章 184），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 184）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2024-12-13 10:00:00+08'),
    (965272, t, 34565, 4411, '示範教學文章 185', '這是示範用的說明摘要（文章 185），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 185）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2024-12-12 10:00:00+08'),
    (965273, t, 34565, 4411, '示範教學文章 186', '這是示範用的說明摘要（文章 186），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 186）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2024-12-11 10:00:00+08'),
    (965274, t, 34565, 4411, '示範教學文章 187', '這是示範用的說明摘要（文章 187），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 187）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2024-12-10 10:00:00+08'),
    (965275, t, 34565, 4411, '示範教學文章 188', '這是示範用的說明摘要（文章 188），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 188）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2024-12-09 10:00:00+08'),
    (965276, t, 34565, 4411, '示範教學文章 189', '這是示範用的說明摘要（文章 189），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 189）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2024-12-08 10:00:00+08'),
    (965277, t, 34565, 4411, '示範教學文章 190', '這是示範用的說明摘要（文章 190），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 190）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2024-12-07 10:00:00+08'),
    (965278, t, 34565, 4411, '示範教學文章 191', '這是示範用的說明摘要（文章 191），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 191）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2024-12-06 10:00:00+08'),
    (965279, t, 34565, 4411, '示範教學文章 192', '這是示範用的說明摘要（文章 192），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 192）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2024-12-05 10:00:00+08'),
    (965280, t, 34565, 4411, '示範教學文章 193', '這是示範用的說明摘要（文章 193），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 193）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2024-12-04 10:00:00+08'),
    (965281, t, 34565, 4411, '示範教學文章 194', '這是示範用的說明摘要（文章 194），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 194）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2024-12-03 10:00:00+08'),
    (965282, t, 34565, 4411, '示範教學文章 195', '這是示範用的說明摘要（文章 195），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 195）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2024-12-02 10:00:00+08'),
    (965283, t, 34565, 4411, '示範教學文章 196', '這是示範用的說明摘要（文章 196），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 196）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2024-12-01 10:00:00+08'),
    (965284, t, 34565, 4411, '示範教學文章 197', '這是示範用的說明摘要（文章 197），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 197）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2024-11-30 10:00:00+08'),
    (965285, t, 34565, 4411, '示範教學文章 198', '這是示範用的說明摘要（文章 198），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 198）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2024-11-29 10:00:00+08'),
    (965286, t, 34565, 4411, '示範教學文章 199', '這是示範用的說明摘要（文章 199），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 199）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2024-11-28 10:00:00+08'),
    (965287, t, 34565, 4411, '示範教學文章 200', '這是示範用的說明摘要（文章 200），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 200）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2024-11-27 10:00:00+08'),
    (965288, t, 34565, 4411, '示範教學文章 201', '這是示範用的說明摘要（文章 201），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 201）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2024-11-26 10:00:00+08'),
    (965289, t, 34565, 4411, '示範教學文章 202', '這是示範用的說明摘要（文章 202），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 202）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2024-11-25 10:00:00+08'),
    (965290, t, 34565, 4411, '示範教學文章 203', '這是示範用的說明摘要（文章 203），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 203）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2024-11-24 10:00:00+08'),
    (965291, t, 34565, 4411, '示範教學文章 204', '這是示範用的說明摘要（文章 204），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 204）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2024-11-23 10:00:00+08'),
    (965292, t, 34565, 4411, '示範教學文章 205', '這是示範用的說明摘要（文章 205），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 205）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2024-11-22 10:00:00+08'),
    (965293, t, 34565, 4411, '示範教學文章 206', '這是示範用的說明摘要（文章 206），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 206）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2024-11-21 10:00:00+08'),
    (965294, t, 34565, 4411, '示範教學文章 207', '這是示範用的說明摘要（文章 207），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 207）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2024-11-20 10:00:00+08'),
    (965295, t, 34565, 4411, '示範教學文章 208', '這是示範用的說明摘要（文章 208），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 208）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2024-11-19 10:00:00+08'),
    (965296, t, 34565, 4411, '示範教學文章 209', '這是示範用的說明摘要（文章 209），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 209）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2024-11-18 10:00:00+08'),
    (965297, t, 34565, 4411, '示範教學文章 210', '這是示範用的說明摘要（文章 210），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 210）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2024-11-17 10:00:00+08'),
    (965298, t, 34565, 4411, '示範教學文章 211', '這是示範用的說明摘要（文章 211），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 211）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2024-11-16 10:00:00+08'),
    (965299, t, 34565, 4411, '示範教學文章 212', '這是示範用的說明摘要（文章 212），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 212）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2024-11-15 10:00:00+08'),
    (965300, t, 34565, 4411, '示範教學文章 213', '這是示範用的說明摘要（文章 213），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 213）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2024-11-14 10:00:00+08'),
    (965301, t, 34565, 4411, '示範教學文章 214', '這是示範用的說明摘要（文章 214），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 214）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2024-11-13 10:00:00+08'),
    (965302, t, 34565, 4411, '示範教學文章 215', '這是示範用的說明摘要（文章 215），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 215）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2024-11-12 10:00:00+08'),
    (965303, t, 34565, 4411, '示範教學文章 216', '這是示範用的說明摘要（文章 216），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 216）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2024-11-11 10:00:00+08'),
    (965304, t, 34565, 4411, '示範教學文章 217', '這是示範用的說明摘要（文章 217），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 217）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2024-11-10 10:00:00+08'),
    (965305, t, 34565, 4411, '示範教學文章 218', '這是示範用的說明摘要（文章 218），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 218）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2024-11-09 10:00:00+08'),
    (965306, t, 34565, 4411, '示範教學文章 219', '這是示範用的說明摘要（文章 219），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 219）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2024-11-08 10:00:00+08'),
    (965307, t, 34565, 4411, '示範教學文章 220', '這是示範用的說明摘要（文章 220），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 220）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2024-11-07 10:00:00+08'),
    (965308, t, 34565, 4411, '示範教學文章 221', '這是示範用的說明摘要（文章 221），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 221）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2024-11-06 10:00:00+08'),
    (965309, t, 34565, 4411, '示範教學文章 222', '這是示範用的說明摘要（文章 222），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 222）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2024-11-05 10:00:00+08'),
    (965310, t, 34565, 4411, '示範教學文章 223', '這是示範用的說明摘要（文章 223），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 223）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2024-11-04 10:00:00+08'),
    (965311, t, 34565, 4411, '示範教學文章 224', '這是示範用的說明摘要（文章 224），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 224）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2024-11-03 10:00:00+08'),
    (965312, t, 34565, 4411, '示範教學文章 225', '這是示範用的說明摘要（文章 225），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 225）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2024-11-02 10:00:00+08'),
    (965313, t, 34565, 4411, '示範教學文章 226', '這是示範用的說明摘要（文章 226），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 226）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2024-11-01 10:00:00+08'),
    (965314, t, 34565, 4411, '示範教學文章 227', '這是示範用的說明摘要（文章 227），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 227）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2024-10-31 10:00:00+08'),
    (965315, t, 34565, 4411, '示範教學文章 228', '這是示範用的說明摘要（文章 228），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 228）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2024-10-30 10:00:00+08'),
    (965316, t, 34565, 4411, '示範教學文章 229', '這是示範用的說明摘要（文章 229），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 229）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2024-10-29 10:00:00+08'),
    (965317, t, 34565, 4411, '示範教學文章 230', '這是示範用的說明摘要（文章 230），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 230）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2024-10-28 10:00:00+08'),
    (965318, t, 34565, 4411, '示範教學文章 231', '這是示範用的說明摘要（文章 231），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 231）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2024-10-27 10:00:00+08'),
    (965319, t, 34565, 4411, '示範教學文章 232', '這是示範用的說明摘要（文章 232），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 232）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2024-10-26 10:00:00+08'),
    (965320, t, 34565, 4411, '示範教學文章 233', '這是示範用的說明摘要（文章 233），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 233）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2024-10-25 10:00:00+08'),
    (965321, t, 34565, 4411, '示範教學文章 234', '這是示範用的說明摘要（文章 234），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 234）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2024-10-24 10:00:00+08'),
    (965322, t, 34565, 4411, '示範教學文章 235', '這是示範用的說明摘要（文章 235），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 235）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2024-10-23 10:00:00+08'),
    (965323, t, 34565, 4411, '示範教學文章 236', '這是示範用的說明摘要（文章 236），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 236）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2024-10-22 10:00:00+08'),
    (965324, t, 34565, 4411, '示範教學文章 237', '這是示範用的說明摘要（文章 237），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 237）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2024-10-21 10:00:00+08'),
    (965325, t, 34565, 4411, '示範教學文章 238', '這是示範用的說明摘要（文章 238），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 238）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2024-10-20 10:00:00+08'),
    (965326, t, 34565, 4411, '示範教學文章 239', '這是示範用的說明摘要（文章 239），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 239）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2024-10-19 10:00:00+08'),
    (965327, t, 34565, 4411, '示範教學文章 240', '這是示範用的說明摘要（文章 240），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 240）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2024-10-18 10:00:00+08'),
    (965328, t, 34565, 4411, '示範教學文章 241', '這是示範用的說明摘要（文章 241），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 241）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2024-10-17 10:00:00+08'),
    (965329, t, 34565, 4411, '示範教學文章 242', '這是示範用的說明摘要（文章 242），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 242）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E,示範標籤H', true, timestamptz '2024-10-16 10:00:00+08'),
    (965330, t, 34565, 4411, '示範教學文章 243', '這是示範用的說明摘要（文章 243），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 243）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2024-10-15 10:00:00+08'),
    (965331, t, 34565, 4411, '示範教學文章 244', '這是示範用的說明摘要（文章 244），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 244）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2024-10-14 10:00:00+08'),
    (965332, t, 34565, 4411, '示範教學文章 245', '這是示範用的說明摘要（文章 245），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 245）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H,示範標籤C', true, timestamptz '2024-10-13 10:00:00+08'),
    (965333, t, 34565, 4411, '示範教學文章 246', '這是示範用的說明摘要（文章 246），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 246）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2024-10-12 10:00:00+08'),
    (965334, t, 34565, 4411, '示範教學文章 247', '這是示範用的說明摘要（文章 247），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 247）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2024-10-11 10:00:00+08'),
    (965335, t, 34565, 4411, '示範教學文章 248', '這是示範用的說明摘要（文章 248），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 248）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C,示範標籤F', true, timestamptz '2024-10-10 10:00:00+08'),
    (965336, t, 34565, 4411, '示範教學文章 249', '這是示範用的說明摘要（文章 249），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 249）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2024-10-09 10:00:00+08'),
    (965337, t, 34565, 4411, '示範教學文章 250', '這是示範用的說明摘要（文章 250），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 250）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2024-10-08 10:00:00+08'),
    (965338, t, 34565, 4411, '示範教學文章 251', '這是示範用的說明摘要（文章 251），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 251）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F,示範標籤A', true, timestamptz '2024-10-07 10:00:00+08'),
    (965339, t, 34565, 4411, '示範教學文章 252', '這是示範用的說明摘要（文章 252），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 252）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G', true, timestamptz '2024-10-06 10:00:00+08'),
    (965340, t, 34565, 4411, '示範教學文章 253', '這是示範用的說明摘要（文章 253），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 253）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2024-10-05 10:00:00+08'),
    (965341, t, 34565, 4411, '示範教學文章 254', '這是示範用的說明摘要（文章 254），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 254）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A,示範標籤D', true, timestamptz '2024-10-04 10:00:00+08'),
    (965342, t, 34565, 4411, '示範教學文章 255', '這是示範用的說明摘要（文章 255），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 255）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B', true, timestamptz '2024-10-03 10:00:00+08'),
    (965343, t, 34565, 4411, '示範教學文章 256', '這是示範用的說明摘要（文章 256），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 256）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2024-10-02 10:00:00+08'),
    (965344, t, 34565, 4411, '示範教學文章 257', '這是示範用的說明摘要（文章 257），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 257）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D,示範標籤G', true, timestamptz '2024-10-01 10:00:00+08'),
    (965345, t, 34565, 4411, '示範教學文章 258', '這是示範用的說明摘要（文章 258），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 258）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤E', true, timestamptz '2024-09-30 10:00:00+08'),
    (965346, t, 34565, 4411, '示範教學文章 259', '這是示範用的說明摘要（文章 259），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 259）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤F', true, timestamptz '2024-09-29 10:00:00+08'),
    (965347, t, 34565, 4411, '示範教學文章 260', '這是示範用的說明摘要（文章 260），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 260）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤G,示範標籤B', true, timestamptz '2024-09-28 10:00:00+08'),
    (965348, t, 34565, 4411, '示範教學文章 261', '這是示範用的說明摘要（文章 261），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 261）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤H', true, timestamptz '2024-09-27 10:00:00+08'),
    (965349, t, 34565, 4411, '示範教學文章 262', '這是示範用的說明摘要（文章 262），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 262）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤A', true, timestamptz '2024-09-26 10:00:00+08'),
    (965350, t, 34565, 4411, '示範教學文章 263', '這是示範用的說明摘要（文章 263），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 263）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤B,示範標籤E', true, timestamptz '2024-09-25 10:00:00+08'),
    (965351, t, 34565, 4411, '示範教學文章 264', '這是示範用的說明摘要（文章 264），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 264）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤C', true, timestamptz '2024-09-24 10:00:00+08'),
    (965352, t, 34565, 4411, '示範教學文章 265', '這是示範用的說明摘要（文章 265），內容僅供版面展示。', '<p>這是示範用的說明內容（文章 265）。</p><p>此段文字為中性示範資料，不代表實際操作說明。</p>', '示範標籤D', true, timestamptz '2024-09-23 10:00:00+08')
    on conflict (id) do update set tenant_id = excluded.tenant_id, group_buy_id = excluded.group_buy_id, web_menu_node_id = excluded.web_menu_node_id, title = excluded.title, summary = excluded.summary, body = excluded.body, tags = excluded.tags, is_published = true, date_published = excluded.date_published, updated_at = now();
  -- 公告內文（既有 14 則：只換內文為中性示範文字，骨架對齊原站）
  update groupbuy.news set body = '<p>這是示範公告 01 的說明文字第 1 段。</p><p>這是示範公告 01 的說明文字第 2 段。</p><p>這是示範公告 01 的說明文字第 3 段。</p><p>這是示範公告 01 的說明文字第 4 段。</p><p>這是示範公告 01 的說明文字第 5 段。</p><ol><li>這是示範公告 01 的說明文字第 6 段。</li><li>這是示範公告 01 的說明文字第 7 段。</li></ol><p>這是示範公告 01 的說明文字第 8 段。</p><p>這是示範公告 01 的說明文字第 9 段。<span>這是示範公告 01 的說明文字第 10 段。</span></p><p>這是示範公告 01 的說明文字第 11 段。</p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure>', updated_at = now() where id = 966001 and tenant_id = t;
  update groupbuy.news set body = '<p>這是示範公告 02 的說明文字第 1 段。<br>這是示範公告 02 的說明文字第 2 段。</p><p>這是示範公告 02 的說明文字第 3 段。<a href="#"><strong>這是示範公告 02 的說明文字第 4 段。</strong></a></p>', updated_at = now() where id = 966002 and tenant_id = t;
  update groupbuy.news set body = '<p><strong>這是示範公告 03 的說明文字第 1 段。</strong></p><p>這是示範公告 03 的說明文字第 2 段。</p><p>這是示範公告 03 的說明文字第 3 段。<strong>這是示範公告 03 的說明文字第 4 段。</strong>這是示範公告 03 的說明文字第 5 段。<span>這是示範公告 03 的說明文字第 6 段。<strong>這是示範公告 03 的說明文字第 7 段。</strong>這是示範公告 03 的說明文字第 8 段。</span>這是示範公告 03 的說明文字第 9 段。</p><p>這是示範公告 03 的說明文字第 10 段。</p><p>這是示範公告 03 的說明文字第 11 段。</p>', updated_at = now() where id = 966003 and tenant_id = t;
  update groupbuy.news set body = '<p>這是示範公告 04 的說明文字第 1 段。</p><p>這是示範公告 04 的說明文字第 2 段。<br><br>這是示範公告 04 的說明文字第 3 段。<br>這是示範公告 04 的說明文字第 4 段。<br>這是示範公告 04 的說明文字第 5 段。<br>這是示範公告 04 的說明文字第 6 段。<br>這是示範公告 04 的說明文字第 7 段。</p><p>這是示範公告 04 的說明文字第 8 段。<mark class="marker-yellow">這是示範公告 04 的說明文字第 9 段。</mark>這是示範公告 04 的說明文字第 10 段。<br>這是示範公告 04 的說明文字第 11 段。<mark class="marker-yellow">這是示範公告 04 的說明文字第 12 段。</mark>這是示範公告 04 的說明文字第 13 段。<br>這是示範公告 04 的說明文字第 14 段。<mark class="marker-yellow">這是示範公告 04 的說明文字第 15 段。</mark>這是示範公告 04 的說明文字第 16 段。<br>這是示範公告 04 的說明文字第 17 段。</p><p>這是示範公告 04 的說明文字第 18 段。</p><p>這是示範公告 04 的說明文字第 19 段。<br> </p><p><br>這是示範公告 04 的說明文字第 20 段。<a href="#"><span>這是示範公告 04 的說明文字第 21 段。</span></a></p>', updated_at = now() where id = 966004 and tenant_id = t;
  update groupbuy.news set body = '<p>這是示範公告 05 的說明文字第 1 段。</p><p>這是示範公告 05 的說明文字第 2 段。<a href="#"><span>這是示範公告 05 的說明文字第 3 段。</span></a></p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure>', updated_at = now() where id = 966005 and tenant_id = t;
  update groupbuy.news set body = '<p>這是示範公告 06 的說明文字第 1 段。<span>這是示範公告 06 的說明文字第 2 段。</span>這是示範公告 06 的說明文字第 3 段。</p><p>這是示範公告 06 的說明文字第 4 段。<a href="#">這是示範公告 06 的說明文字第 5 段。</a></p><p>這是示範公告 06 的說明文字第 6 段。<br><span>這是示範公告 06 的說明文字第 7 段。</span>這是示範公告 06 的說明文字第 8 段。</p><p><span><strong>這是示範公告 06 的說明文字第 9 段。</strong></span></p>', updated_at = now() where id = 966006 and tenant_id = t;
  update groupbuy.news set body = '<p>這是示範公告 07 的說明文字第 1 段。</p><p><span>這是示範公告 07 的說明文字第 2 段。</span></p><p>這是示範公告 07 的說明文字第 3 段。</p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><p> </p><p><span>這是示範公告 07 的說明文字第 4 段。</span><br>這是示範公告 07 的說明文字第 5 段。</p><p>這是示範公告 07 的說明文字第 6 段。<br>這是示範公告 07 的說明文字第 7 段。</p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><p><br><br><br> </p>', updated_at = now() where id = 966007 and tenant_id = t;
  update groupbuy.news set body = '<p><span>這是示範公告 08 的說明文字第 1 段。</span></p><p><span>這是示範公告 08 的說明文字第 2 段。</span></p><p>這是示範公告 08 的說明文字第 3 段。<br>這是示範公告 08 的說明文字第 4 段。<br>這是示範公告 08 的說明文字第 5 段。<br>這是示範公告 08 的說明文字第 6 段。<br>這是示範公告 08 的說明文字第 7 段。<br>這是示範公告 08 的說明文字第 8 段。</p><p> </p><p> </p><p>這是示範公告 08 的說明文字第 9 段。</p><p><span><strong>這是示範公告 08 的說明文字第 10 段。</strong></span><span><strong>這是示範公告 08 的說明文字第 11 段。</strong></span><span><strong>這是示範公告 08 的說明文字第 12 段。</strong></span><span><strong>這是示範公告 08 的說明文字第 13 段。</strong></span><span><strong>這是示範公告 08 的說明文字第 14 段。</strong></span><span><strong>這是示範公告 08 的說明文字第 15 段。</strong></span></p><p><span>這是示範公告 08 的說明文字第 16 段。</span><span>這是示範公告 08 的說明文字第 17 段。</span><span>這是示範公告 08 的說明文字第 18 段。</span><br><span>這是示範公告 08 的說明文字第 19 段。</span></p><p><span>這是示範公告 08 的說明文字第 20 段。</span><br><span>這是示範公告 08 的說明文字第 21 段。</span><br><span>這是示範公告 08 的說明文字第 22 段。</span><br><span>這是示範公告 08 的說明文字第 23 段。</span><br><span>這是示範公告 08 的說明文字第 24 段。</span><br><span>這是示範公告 08 的說明文字第 25 段。</span></p><p><span>這是示範公告 08 的說明文字第 26 段。</span><span>這是示範公告 08 的說明文字第 27 段。</span><br><span>這是示範公告 08 的說明文字第 28 段。</span><br><span>這是示範公告 08 的說明文字第 29 段。</span><span>這是示範公告 08 的說明文字第 30 段。</span><span>這是示範公告 08 的說明文字第 31 段。</span><span>這是示範公告 08 的說明文字第 32 段。</span><span>這是示範公告 08 的說明文字第 33 段。</span><span>這是示範公告 08 的說明文字第 34 段。</span><br><br><span>這是示範公告 08 的說明文字第 35 段。</span><a href="#"><span>這是示範公告 08 的說明文字第 36 段。</span></a><span>這是示範公告 08 的說明文字第 37 段。</span></p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><p> </p><p> </p>', updated_at = now() where id = 966008 and tenant_id = t;
  update groupbuy.news set body = '<p><span>這是示範公告 09 的說明文字第 1 段。</span></p><p><span><strong>這是示範公告 09 的說明文字第 2 段。</strong></span><br><span>這是示範公告 09 的說明文字第 3 段。</span><br><span>這是示範公告 09 的說明文字第 4 段。</span></p><p><span><strong>這是示範公告 09 的說明文字第 5 段。</strong></span><br><span>這是示範公告 09 的說明文字第 6 段。</span><br><span>這是示範公告 09 的說明文字第 7 段。</span></p><p>這是示範公告 09 的說明文字第 8 段。<span>這是示範公告 09 的說明文字第 9 段。</span> <a href="#"><span><strong>這是示範公告 09 的說明文字第 10 段。</strong></span></a></p>', updated_at = now() where id = 966009 and tenant_id = t;
  update groupbuy.news set body = '<p>這是示範公告 10 的說明文字第 1 段。</p><p><mark class="marker-green">這是示範公告 10 的說明文字第 2 段。</mark></p><p>這是示範公告 10 的說明文字第 3 段。</p><p>這是示範公告 10 的說明文字第 4 段。<br>這是示範公告 10 的說明文字第 5 段。<span>這是示範公告 10 的說明文字第 6 段。</span></p><p><mark class="marker-green">這是示範公告 10 的說明文字第 7 段。</mark></p><p>這是示範公告 10 的說明文字第 8 段。</p><p>這是示範公告 10 的說明文字第 9 段。<br><span>這是示範公告 10 的說明文字第 10 段。</span><br><span>這是示範公告 10 的說明文字第 11 段。</span><br><span>這是示範公告 10 的說明文字第 12 段。</span><br><span>這是示範公告 10 的說明文字第 13 段。</span><br><span>這是示範公告 10 的說明文字第 14 段。</span><br><span>這是示範公告 10 的說明文字第 15 段。</span><br><span>這是示範公告 10 的說明文字第 16 段。</span><br><span>這是示範公告 10 的說明文字第 17 段。</span><br><span>這是示範公告 10 的說明文字第 18 段。</span></p><p><span>這是示範公告 10 的說明文字第 19 段。</span><span>這是示範公告 10 的說明文字第 20 段。</span><br><span>這是示範公告 10 的說明文字第 21 段。</span></p><p><span>這是示範公告 10 的說明文字第 22 段。</span><br> </p><p>這是示範公告 10 的說明文字第 23 段。</p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><p> </p><p><span><mark class="marker-yellow">這是示範公告 10 的說明文字第 24 段。</mark></span></p><p><span>這是示範公告 10 的說明文字第 25 段。</span><span>這是示範公告 10 的說明文字第 26 段。</span><br><span>這是示範公告 10 的說明文字第 27 段。</span><br><span>這是示範公告 10 的說明文字第 28 段。</span></p><p><span>這是示範公告 10 的說明文字第 29 段。</span><br><span>這是示範公告 10 的說明文字第 30 段。</span><br><span>這是示範公告 10 的說明文字第 31 段。</span><br><span>這是示範公告 10 的說明文字第 32 段。</span></p><p><span>這是示範公告 10 的說明文字第 33 段。</span><br><span>這是示範公告 10 的說明文字第 34 段。</span><br><span>這是示範公告 10 的說明文字第 35 段。</span><br><span>這是示範公告 10 的說明文字第 36 段。</span><br><span>這是示範公告 10 的說明文字第 37 段。</span><br><span>這是示範公告 10 的說明文字第 38 段。</span><br><span>這是示範公告 10 的說明文字第 39 段。</span><br><br><span>這是示範公告 10 的說明文字第 40 段。</span><br><span>這是示範公告 10 的說明文字第 41 段。</span><br><span>這是示範公告 10 的說明文字第 42 段。</span>這是示範公告 10 的說明文字第 43 段。<br><span>這是示範公告 10 的說明文字第 44 段。</span><br><span>這是示範公告 10 的說明文字第 45 段。</span>這是示範公告 10 的說明文字第 46 段。</p>', updated_at = now() where id = 966010 and tenant_id = t;
  update groupbuy.news set body = '<p>這是示範公告 11 的說明文字第 1 段。<br>這是示範公告 11 的說明文字第 2 段。</p><p>這是示範公告 11 的說明文字第 3 段。</p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure>', updated_at = now() where id = 966011 and tenant_id = t;
  update groupbuy.news set body = '<p>這是示範公告 12 的說明文字第 1 段。<mark class="marker-yellow">這是示範公告 12 的說明文字第 2 段。</mark><span><mark class="marker-yellow">這是示範公告 12 的說明文字第 3 段。</mark></span><mark class="marker-yellow">這是示範公告 12 的說明文字第 4 段。</mark>這是示範公告 12 的說明文字第 5 段。<span>這是示範公告 12 的說明文字第 6 段。</span>這是示範公告 12 的說明文字第 7 段。<span>這是示範公告 12 的說明文字第 8 段。</span>這是示範公告 12 的說明文字第 9 段。</p><p>這是示範公告 12 的說明文字第 10 段。</p><p>這是示範公告 12 的說明文字第 11 段。</p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure>', updated_at = now() where id = 966012 and tenant_id = t;
  update groupbuy.news set body = '<p>這是示範公告 13 的說明文字第 1 段。</p><p>這是示範公告 13 的說明文字第 2 段。</p>', updated_at = now() where id = 966013 and tenant_id = t;
  update groupbuy.news set body = '<figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure>', updated_at = now() where id = 966014 and tenant_id = t;
  insert into groupbuy.news (id, tenant_id, group_buy_id, title, body, is_pinned, date_published) values (966101, t, 34565, '示範公告 15：功能更新說明', '<figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure>', false, timestamptz '2023-04-17 10:00:00+08')
    on conflict (id) do update set tenant_id = excluded.tenant_id, group_buy_id = excluded.group_buy_id, title = excluded.title, body = excluded.body, is_pinned = false, date_published = excluded.date_published, updated_at = now();
  insert into groupbuy.news (id, tenant_id, group_buy_id, title, body, is_pinned, date_published) values (966102, t, 34565, '示範公告 16：功能更新說明', '<p><span>這是示範公告 16 的說明文字第 1 段。</span></p><p><span>這是示範公告 16 的說明文字第 2 段。</span></p><p><span>這是示範公告 16 的說明文字第 3 段。</span></p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><p> </p><p><mark class="marker-yellow">這是示範公告 16 的說明文字第 4 段。</mark></p><p><span>這是示範公告 16 的說明文字第 5 段。</span></p><p><span>這是示範公告 16 的說明文字第 6 段。</span></p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><p><mark class="marker-yellow">這是示範公告 16 的說明文字第 7 段。</mark></p><p><span>這是示範公告 16 的說明文字第 8 段。</span></p>', false, timestamptz '2023-04-12 10:00:00+08')
    on conflict (id) do update set tenant_id = excluded.tenant_id, group_buy_id = excluded.group_buy_id, title = excluded.title, body = excluded.body, is_pinned = false, date_published = excluded.date_published, updated_at = now();
  insert into groupbuy.news (id, tenant_id, group_buy_id, title, body, is_pinned, date_published) values (966103, t, 34565, '示範公告 17：功能更新說明', '<figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure>', false, timestamptz '2023-03-25 10:00:00+08')
    on conflict (id) do update set tenant_id = excluded.tenant_id, group_buy_id = excluded.group_buy_id, title = excluded.title, body = excluded.body, is_pinned = false, date_published = excluded.date_published, updated_at = now();
  insert into groupbuy.news (id, tenant_id, group_buy_id, title, body, is_pinned, date_published) values (966104, t, 34565, '示範公告 18：功能更新說明', '<p><span><strong>這是示範公告 18 的說明文字第 1 段。</strong></span></p><p><span>這是示範公告 18 的說明文字第 2 段。</span></p><p><span><strong>這是示範公告 18 的說明文字第 3 段。</strong></span></p><p><span>這是示範公告 18 的說明文字第 4 段。</span></p><p><span>這是示範公告 18 的說明文字第 5 段。</span></p><p><span><strong>這是示範公告 18 的說明文字第 6 段。</strong></span></p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><p> </p><p><span><strong>這是示範公告 18 的說明文字第 7 段。</strong></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 8 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 9 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 10 段。</span></span></p><p> </p><p><span><span class="text-small">這是示範公告 18 的說明文字第 11 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 12 段。</span></span></p><p> </p><p><span><span class="text-small">這是示範公告 18 的說明文字第 13 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 14 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 15 段。</span></span></p><p> </p><p><span><span class="text-small">這是示範公告 18 的說明文字第 16 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 17 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 18 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 19 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 20 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 21 段。</span></span></p><p><span><span class="text-small">這是示範公告 18 的說明文字第 22 段。</span></span></p><p> </p><p><span><span class="text-small">這是示範公告 18 的說明文字第 23 段。</span></span></p>', false, timestamptz '2023-03-17 10:00:00+08')
    on conflict (id) do update set tenant_id = excluded.tenant_id, group_buy_id = excluded.group_buy_id, title = excluded.title, body = excluded.body, is_pinned = false, date_published = excluded.date_published, updated_at = now();
  insert into groupbuy.news (id, tenant_id, group_buy_id, title, body, is_pinned, date_published) values (966105, t, 34565, '示範公告 19：功能更新說明', '<p>這是示範公告 19 的說明文字第 1 段。<span>這是示範公告 19 的說明文字第 2 段。</span>這是示範公告 19 的說明文字第 3 段。</p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure><p> </p>', false, timestamptz '2023-02-21 10:00:00+08')
    on conflict (id) do update set tenant_id = excluded.tenant_id, group_buy_id = excluded.group_buy_id, title = excluded.title, body = excluded.body, is_pinned = false, date_published = excluded.date_published, updated_at = now();
  insert into groupbuy.news (id, tenant_id, group_buy_id, title, body, is_pinned, date_published) values (966106, t, 34565, '示範公告 20：功能更新說明', '<p><span class="text-small"><mark class="marker-yellow">這是示範公告 20 的說明文字第 1 段。</mark></span></p><p><span><span class="text-small">這是示範公告 20 的說明文字第 2 段。</span></span></p><p><span><span class="text-small">這是示範公告 20 的說明文字第 3 段。</span></span></p><p><span><span class="text-small">這是示範公告 20 的說明文字第 4 段。</span></span></p><figure class="image"><img class="lazyload" data-src="/upload/images/unsort/logo.png" alt="示範圖片"></figure></div>', false, timestamptz '2022-12-23 10:00:00+08')
    on conflict (id) do update set tenant_id = excluded.tenant_id, group_buy_id = excluded.group_buy_id, title = excluded.title, body = excluded.body, is_pinned = false, date_published = excluded.date_published, updated_at = now();
  -- identity 序號推到 max(id) 之後，避免之後新建的資料撞到保留區段
  foreach s in array array['web_menu_nodes', 'posts', 'news'] loop
    execute format('select last_value from %s', pg_get_serial_sequence('groupbuy.' || s, 'id')) into cur;
    execute format('select coalesce(max(id), 0) from groupbuy.%I', s) into mx;
    if mx > cur then
      perform setval(pg_get_serial_sequence('groupbuy.' || s, 'id'), mx);
    end if;
  end loop;
end
$$;

notify pgrst, 'reload schema';
