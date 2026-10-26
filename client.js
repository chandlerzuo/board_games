'use strict';
/* 三國風雲　畫面端
 * 依「某位玩家眼中的局面」（engine.viewFor）繪製棋盤與側欄，並處理對話框、懸停說明。
 * 兩種玩法：
 *   單機（以 file:// 開啟）：引擎在本頁執行，localUI 為轉接器，可人機對戰或多人共用一台裝置。
 *   連線（由 server/server.js 提供網頁）：引擎在伺服器執行，本頁只收畫面與題目、送回作答。 */
(() => {
const E = window.SanguoEngine;
const { S, TILES, GROUPS, CITY_TOLL, FIELD_TOLL, BUILD_COST, LEVEL_NAME, DEF_TROOPS, HIRE_COST, RANSOM, SALE_TAX,
  GEN_BASE, SPECIAL_BASE, POKER, SUIT, CARDS, KIND_HELP, PLAYER_COLORS, DIE, fmt, esc, isProp } = E;
const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COMMANDERS = POKER.slice(0, 4); // 四張 A
const cmdName = j => CARDS[j].name;     // 主帥姓名隨主題改變
const tn = E.tn;

/* ---- 主題：地名、人物、棋盤圖與標題一併切換 ---- */
let themeNow = null;
function useTheme(key) {
  if (!E.THEMES[key]) key = 'sanguo';
  if (key === themeNow) return;
  themeNow = key;
  const th = E.applyTheme(key);
  window.setCardTheme?.(key);
  const img = $('#board img'); img.src = th.board; img.alt = th.label + '棋盤';
  document.title = th.label;
  document.querySelectorAll('.themeTitle').forEach(el => { el.textContent = th.label; });
  document.querySelectorAll('.themeSub').forEach(el => { el.textContent = th.sub; });
}
const themeOptions = () => E.THEMES && Object.values(E.THEMES).map(th => `<option value="${th.key}">${th.label}</option>`).join('');

/* ---- 棋盤版面：每一格在原版棋盤掃描圖（2122×3000）上的位置 [x, y, 寬, 高]，順序同 TILES ---- */
const SCAN = { x: 45, y: 255, w: 1900, h: 2630 }; // board.svg 對應掃描圖的裁切範圍
const BOXES = [[1297,290,610,525],[1690,890,210,142],[1312,840,310,175],[1307,1080,210,140],[1592,1050,310,170],[1690,1285,212,142],
  [1312,1240,310,177],[1307,1480,210,140],[1592,1445,310,177],[1692,1688,208,140],[1690,1895,210,140],[1277,1630,385,420],
  [1309,2088,210,137],[1590,2055,307,170],[1690,2293,207,140],[1307,2243,310,175],[1305,2482,210,140],[1587,2452,308,173],
  [1685,2692,209,140],[1307,2640,307,175],[1097,2623,143,205],[893,2620,142,205],[880,2130,405,490],[680,2253,142,204],
  [700,2520,175,305],[488,2623,139,210],[490,2253,173,310],[275,2253,145,202],[288,2520,177,308],[73,2623,145,205],
  [78,2253,180,310],[75,2047,213,143],[372,1895,393,300],[75,1892,213,140],[75,1687,213,140],[348,1700,320,170],
  [455,1492,213,145],[75,1497,323,170],[75,1290,205,142],[348,1300,320,175],[455,1098,213,142],[75,1095,323,175],
  [75,890,213,140],[75,687,213,140],[320,690,320,350],[457,477,211,143],[75,490,315,175],[75,285,217,142],
  [355,285,313,170],[735,285,141,202],[688,553,175,309],[928,660,138,207],[895,285,171,305],[1137,282,137,206],[1137,557,137,190]];
const DECK_BOX = { emergency: [760, 990, 450, 304], general: [734, 1384, 506, 336], strategy: [764, 1814, 452, 300] };
// 橫式棋盤：掃描座標扣除裁切偏移後逆時針轉 90 度（與 tools/make_board_svg.py 相同）
const place = (el, [x, y, w, h]) => {
  const cx = x - SCAN.x, cy = y - SCAN.y;
  const nx = cy, ny = SCAN.w - cx - w; // 轉後畫布寬 SCAN.h、高 SCAN.w
  Object.assign(el.style, { left: nx / SCAN.h * 100 + '%', top: ny / SCAN.w * 100 + '%', width: h / SCAN.h * 100 + '%', height: w / SCAN.w * 100 + '%' });
};
console.assert(BOXES.length === TILES.length, '棋盤應有 55 格');

let VIEW = null; // 目前顯示的局面
const P = id => VIEW.players[id];
const pname = p => `<b style="color:${p.color}">${esc(p.name)}</b>`;
const cimg = (id, cls = '') => `<span class="cw" data-cid="${id}" data-cls="${cls}"></span>`;
// 把引擎輸出的牌位標記換成牌面圖
function hydrate(root) {
  root.querySelectorAll('.cw[data-cid]').forEach(el => { if (!el.firstChild) el.innerHTML = cardSvg(CARDS[+el.dataset.cid], el.dataset.cls || ''); });
}

/* ------------------------------------------------------------------ *
 *  對話框（依序排隊，一次只顯示一個）
 *  onPress(k, bodyEl) 回傳 Promise<是否關閉>
 * ------------------------------------------------------------------ */
let modalChain = Promise.resolve();
let modalCurrent = null;
function showModal(title, body, buttons, onPress, key) {
  const job = modalChain.then(() => new Promise(done => {
    const m = $('#modal');
    m.querySelector('h3').innerHTML = title;
    const b = m.querySelector('.body'); b.innerHTML = body; hydrate(b);
    const bt = m.querySelector('.btns'); bt.innerHTML = '';
    const close = () => { m.hidden = true; modalCurrent = null; done(); };
    modalCurrent = { key, close, body: b };
    buttons.forEach((o, k) => {
      const e = document.createElement('button');
      e.innerHTML = o.label; if (o.cls) e.className = o.cls; e.disabled = !!o.disabled;
      e.onclick = async () => { if (await onPress(k, b)) close(); };
      bt.appendChild(e);
    });
    m.hidden = false;
  }));
  modalChain = job;
  return job;
}
// 單機用：直接以按鈕值回傳（值為函式時讀取對話框內容）
function localModal(title, body, buttons) {
  return new Promise(res => showModal(title, body, buttons, async (k, b) => {
    const o = buttons[k];
    const v = typeof o.value === 'function' ? o.value(b) : o.value;
    if (v === undefined) return false; // 輸入不正確，保持開啟
    res(v); return true;
  }));
}
const okLocal = (title, body) => localModal(title, body, [{ label: '確定', value: true, cls: 'pri' }]);

/* ------------------------------------------------------------------ *
 *  棋盤與側欄
 * ------------------------------------------------------------------ */
function buildBoard() {
  const B = $('#board');
  B.querySelectorAll('.ov, .deck, #center').forEach(e => e.remove());
  for (const [k, box] of Object.entries(DECK_BOX)) {
    if (k === 'general') continue;
    const d = document.createElement('div'); d.className = 'deck'; d.id = 'deck-' + k; place(d, box); B.appendChild(d);
  }
  TILES.forEach((T, i) => {
    const d = document.createElement('div'); d.className = 'ov'; d.id = 'tile' + i;
    place(d, BOXES[i]);
    d.innerHTML = '<div class="toks"></div>';
    d.onclick = () => tileInfo(i);
    B.appendChild(d);
  });
  const c = document.createElement('div'); c.id = 'center'; place(c, DECK_BOX.general);
  c.innerHTML = '<div id="turnInfo"></div><div id="dice"></div><div id="actions"></div><div id="pileN"></div>';
  B.appendChild(c);
}
const castleSvg = lv => `<svg viewBox="0 0 40 ${lv === 2 ? 44 : 30}">${lv === 2
  ? `<path d="M8,16 q12,-12 24,0z" fill="#c62828" stroke="#2a1a10" stroke-width="1.6"/><rect x="11" y="15" width="18" height="7" fill="#f6b93b" stroke="#2a1a10" stroke-width="1.4"/>
     <path d="M3,25 q17,-10 34,0z" fill="#1565c0" stroke="#2a1a10" stroke-width="1.6"/><rect x="6" y="24" width="28" height="8" fill="#f8f1d8" stroke="#2a1a10" stroke-width="1.4"/>
     <path d="M0,34 q20,-8 40,0z" fill="#2e7d32" stroke="#2a1a10" stroke-width="1.6"/><rect x="3" y="33" width="34" height="10" fill="#f8f1d8" stroke="#2a1a10" stroke-width="1.4"/><rect x="17" y="36" width="6" height="7" fill="#c62828"/>`
  : `<path d="M2,13 q18,-12 36,0z" fill="#c62828" stroke="#2a1a10" stroke-width="1.6"/><rect x="5" y="12" width="30" height="16" fill="#f8f1d8" stroke="#2a1a10" stroke-width="1.4"/><rect x="16" y="18" width="8" height="10" fill="#c62828"/>`}</svg>`;
// 位置旗：大面旗幟寫主帥姓氏，白字黑邊以便辨識
const flagSvg = p => `<div class="tok" title="${esc(p.name)}"><svg viewBox="0 0 44 52"><line x1="4" y1="3" x2="4" y2="50" stroke="#3b2a1a" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="4" cy="3.5" r="3" fill="#d9a514" stroke="#3b2a1a" stroke-width="1"/><path d="M5.5,6 h33 q4,10 0,12 q4,2 0,12 h-33z" fill="${p.color}" stroke="#2a1a10" stroke-width="1.6"/>
  <path d="M5.5,6 h33 q4,10 0,12 q4,2 0,12 h-33z" fill="url(#cgSh)"/>
  <text x="21.5" y="26.5" font-size="21" font-weight="900" text-anchor="middle" fill="#fff" stroke="#1a0f08" stroke-width="2.4" paint-order="stroke" font-family="'STKaiti','KaiTi','Kaiti TC',serif">${p.family}</text></svg></div>`;
function flashDeck(k) {
  const d = $('#deck-' + k); if (!d) return;
  d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash');
}
function showDice(r) { const d = $('#dice'); if (d) d.textContent = r.map(x => DIE[x]).join(' '); }
function addLog(html) {
  const d = document.createElement('div'); d.innerHTML = html;
  const L = $('#log'); L.appendChild(d); L.scrollTop = L.scrollHeight;
  $('#msg').innerHTML = html;
}

function renderView(v) {
  VIEW = v;
  useTheme(v.theme);
  if (!$('#tile0')) buildBoard();
  TILES.forEach((T, i) => {
    const d = $('#tile' + i), t = v.tiles[i];
    d.querySelector('.stampwrap')?.remove();
    // 已購買的領地蓋上地主主帥姓氏的印章
    if (isProp(i) && t.owner != null) {
      const o = P(t.owner);
      d.style.setProperty('--oc', o.color);
      d.insertAdjacentHTML('beforeend', `<div class="stampwrap"><div class="stamp">${o.family}</div></div>`);
    }
    // 已建城池以城樓符號表示（小城一層、大城三層）
    d.querySelector('.lvl')?.remove();
    if (isProp(i) && t.level) d.insertAdjacentHTML('beforeend', `<div class="lvl" title="${LEVEL_NAME[t.level]}">${castleSvg(t.level)}</div>`);
    d.querySelector('.toks').innerHTML = v.players.filter(p => p.alive && p.pos === i).map(flagSvg).join('');
    d.classList.toggle('here', v.cur != null && P(v.cur).pos === i);
  });
  $('#pileN').textContent = `在野武將 ${v.pile} 張`;
  const cp = v.cur != null ? P(v.cur) : null;
  $('#turnInfo').innerHTML = cp ? `輪到 <span style="color:${cp.color};background:#fff;border-radius:.5cqw;padding:0 .6cqw;text-shadow:none">${esc(cp.name)}</span>${v.me === cp.id ? '（你）' : ''}` : '';
  $('#players').innerHTML = v.players.map(p => {
    const st = !p.alive ? '<span class="tag">已出局</span>'
      : (p.rest ? `<span class="tag">休息 ${p.rest} 次</span>` : '') + (p.reserveN ? `<span class="tag">錦囊保留卡 ${p.reserveN}</span>` : '');
    let hand;
    if (p.hand) {
      hand = `<div class="hand">${p.hand.map(id => `<span onclick="zoomCard(${id})">${cimg(id)}</span>`).join('')}</div>`
        + (p.reserve?.length ? `<div class="gens">錦囊：${p.reserve.join('、')}</div>` : '');
    } else {
      // 他人手牌不公開：只顯示張數，以及你從公開俘虜中記得的牌
      hand = `<div class="gens">${p.hasCmd ? '' : '（主帥失守）'}手牌 ${p.cardN} 張${p.known.length ? `・你記得：<span class="mini">${p.known.map(id => cimg(id, 'mini')).join(' ')}</span>` : ''}</div>`;
    }
    return `<div class="pl ${p.id === v.cur ? 'cur' : ''} ${p.alive ? '' : 'dead'}" style="border-color:${p.color}">
      <div class="hd"><span><span class="stamp" style="--oc:${p.color};display:inline-flex;width:22px;height:22px;font-size:15px;border-width:2px;outline:none;vertical-align:middle;margin-right:4px">${p.family}</span>${esc(p.name)}${p.ai ? '<span class="tag">電腦</span>' : ''}${v.me === p.id ? '<span class="tag">你</span>' : ''}${st}</span><span>${fmt(p.cash)}</span></div>
      <div>⚔ 兵力 ${p.troops}・🏯 領地 ${p.owned} 處${p.groups.length ? `・同色全收：${p.groups.map(g => GROUPS[g]).join('、')}` : ''}</div>
      ${hand}</div>`;
  }).join('');
  hydrate($('#players'));
}

const SPACE_HELP = {
  start: () => `經過起點可向國庫支領 ${fmt(S.passStart)} 軍費，停留起點時加倍領取。`,
  recruit: () => '可在此自由徵兵，每名士兵一兩，徵兵數量不限。',
  hire: () => `每次以 ${fmt(HIRE_COST)} 取得一名武將，一律從在野武將中抽選，不得自由選取。`,
  emergency: T => `抽取${T.n}卡一張，並依照指示辦理。`,
  strategy: T => `抽取${T.n}卡一張，並依照指示辦理。保留卡可留待日後使用，限用一次。`,
  shop: T => `${T.n}消費 ${fmt(T.fee)}。`,
  rest: T => `繳 ${fmt(T.fee)} 休息一次，其間不得向他人收取過路稅（可進行防禦戰鬥）。`,
  island: () => '重擲一次骰子，向國庫領取擲出點數 ×1000 兩之軍費。',
  cottage: () => '重擲三次骰子，合計 10–12 點免費得武將 1 名，13–15 點 2 名，16–18 點 3 名。',
};
const levelName = i => TILES[i].t === 'field' ? '古戰場' : LEVEL_NAME[VIEW.tiles[i].level];
// 領地懸停資訊：價格、稅金、地主
function tileTipHtml(i) {
  const T = TILES[i], t = VIEW.tiles[i];
  if (!isProp(i)) return `<b>${T.n}</b><div>${SPACE_HELP[T.t]?.(T) ?? ''}</div>`;
  const o = t.owner != null ? P(t.owner) : null;
  const tolls = T.t === 'field' ? FIELD_TOLL.map((v, k) => `${'一二三四五'[k]}座 ${v}`).join('、') : CITY_TOLL[T.p].map((v, k) => `${LEVEL_NAME[k]} ${v}`).join('、');
  return `<b>${T.n}</b>　<small>${GROUPS[T.g]}</small><div>領地價格 ${fmt(T.p)}${T.t === 'city' ? `・建城費用 ${fmt(BUILD_COST)}` : ''}</div>`
    + `<div>稅金：${tolls}${T.t === 'field' ? '（依地主擁有座數）' : ''}</div>`
    + (o ? `<div>地主 ${pname(o)}・${levelName(i)}・目前過路稅 <b>${fmt(t.toll)}</b>${o.rest ? '（休息中）' : ''}</div>` : '<div>空白領地，可購買</div>');
}
function tileInfo(i) {
  if (!VIEW || !$('#modal').hidden) return;
  const T = TILES[i], t = VIEW.tiles[i];
  let body = `<p>${SPACE_HELP[T.t]?.(T) ?? ''}</p>`;
  if (isProp(i)) {
    const tolls = T.t === 'field'
      ? FIELD_TOLL.map((v, k) => `<tr><td>${'一二三四五'[k]}座古戰場</td><td>${fmt(v)}</td></tr>`).join('')
      : `<tr><td>建城費用</td><td>${fmt(BUILD_COST)}</td></tr>` + CITY_TOLL[T.p].map((v, k) => `<tr><td>${LEVEL_NAME[k]}稅金</td><td>${fmt(v)}</td></tr>`).join('');
    body = `<h4 style="margin:0 0 6px">${T.n}　領地所有證</h4><table>
      <tr><td>顏色</td><td>${GROUPS[T.g]}</td></tr><tr><td>領地價格</td><td>${fmt(T.p)}</td></tr>${tolls}
      <tr><td>主權</td><td>${t.owner == null ? '無（國庫所有）' : pname(P(t.owner))}</td></tr>
      <tr><td>現況</td><td>${t.owner == null ? '空白領地' : levelName(i)}</td></tr>
      <tr><td>目前過路稅</td><td>${t.owner == null ? '—' : fmt(t.toll)}</td></tr>
      <tr><td>攻城所需兵力</td><td>${T.t === 'field' ? 1000 : E.SIEGE_NEED[t.level]} 名</td></tr></table>
      <p><small>★凡擁有同色之全部領地者，過路稅金依上表加倍收取。${T.t === 'field' ? '古戰場不得建設城池。' : ''}</small></p>`;
  }
  okLocal(T.n, body);
}
window.zoomCard = id => {
  if ($('#modal').hidden) okLocal(CARDS[id].name, `<div style="text-align:center">${cimg(id, 'big')}</div><div style="margin-top:8px">${cardInfoHtml(CARDS[id], KIND_HELP[CARDS[id].kind] || '')}</div>`);
};
// 滑鼠懸停：牌顯示姓名、數值與說明；格子顯示價格與稅金
document.addEventListener('mouseover', e => {
  const tip = $('#tip');
  const el = e.target.closest?.('[data-cid]');
  const tile = !el && VIEW && e.target.closest?.('.ov');
  if (tile) { tip.innerHTML = tileTipHtml(+tile.id.slice(4)); tip.hidden = false; return; }
  if (!el) { tip.hidden = true; return; }
  const c = CARDS[+el.dataset.cid];
  const owner = VIEW && VIEW.players.find(p => p.commander === c.id);
  tip.innerHTML = cardInfoHtml(c, KIND_HELP[c.kind] || '') + (owner ? `<div class="cmdbadge">★ ${esc(owner.name)}的主帥</div>` : '');
  tip.hidden = false;
});
document.addEventListener('mousemove', e => {
  const tip = $('#tip'); if (tip.hidden) return;
  tip.style.left = Math.min(e.clientX + 16, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(e.clientY + 16, innerHeight - tip.offsetHeight - 8) + 'px';
});

// 回合按鈕：擲骰、使用錦囊、變賣資產（單機多人時另有查看手牌）
function turnButtons(opts, onPick) {
  const a = $('#actions'); a.innerHTML = '';
  const btn = (label, act, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = () => { a.innerHTML = ''; onPick(act); }; a.appendChild(b); };
  btn('🎲 擲骰子', 'roll', 'pri');
  if (opts.reserve) btn('使用錦囊', 'reserve');
  btn('變賣資產', 'sell');
  if (opts.hand) btn('查看手牌', 'hand');
}

function showRules() {
  okLocal('遊戲說明書', `<ol style="padding-left:20px;line-height:1.6">
  <li><b>準備</b>：每位參加者領取軍費 ${fmt(S.startCash)}、兵力 ${S.startTroops} 名，自由選取主帥（四張 A）一名後再抽選三張武將撲克牌。主帥全場公開，各人其餘手牌不公開。棋盤上以寫有主帥姓氏的旗幟代表各人位置，購得的領地蓋上主帥姓氏印章。</li>
  <li><b>開始</b>：依照順序擲骰子前進。經由起點可向國庫支領 ${fmt(S.passStart)} 軍費，停留起點時加倍領取。</li>
  <li><b>空白領地</b>：依定價自由向國庫購買。<b>自軍領地</b>：繳交建城費用 ${fmt(BUILD_COST)} 建設城池，領地可建小城，小城可改建大城。<b>古戰場</b>：規定與領地相同，但不得建設城池，稅金依地主擁有古戰場座數計算。凡擁有同色之全部領地者，過路稅金加倍收取。</li>
  <li><b>他人領地</b>：繳交過路稅，或進行<b>武將單挑</b>（免交過路稅），或進行<b>攻城戰</b>（佔領敵城）。
    <ul><li><b>武將單挑</b>：雙方各派一名武將，以攻方武將攻擊力對抗守方武將防禦力，力量大者為勝，並可俘虜敗方武將；平手則同歸於盡，繳回國庫。守方可自由選擇是否出戰，不論勝負，該次過路稅守方不得收取。</li>
    <li><b>攻城戰</b>：攻領地需 500 兵、攻小城或古戰場需 1000 兵、攻大城需 1500 兵；守方需 ${DEF_TROOPS} 兵。守方兵力不足或不願出戰時，領地棄守。不論勝負，攻方損失所派兵力、守方損失 ${DEF_TROOPS} 兵。勝者擁有領地主權並俘虜敗方武將；平手時武將同歸於盡，領地主權仍為守方所有。</li></ul></li>
  <li><b>出戰一張牌</b>：單挑或攻城時，雙方各出一張牌——一名武將，或以一張特別卡取代武將（限用一次）。武器卡（Q）——雙方出戰之牌同歸於盡，平手；陣式卡（K）——俘虜敵方出戰之武將並獲勝，雙方都用陣式則抵消；霸王卡（鬼牌）——獲勝，並將敵方所出之牌、攻城損失之士兵及領地占為己有，雙方同時使用則平手。</li>
  <li><b>主帥</b>：被敵人俘虜或同歸於盡時，需以 ${fmt(RANSOM)} 向敵軍或國庫贖回；無軍費贖回時即為失敗，該主帥成為一般武將。</li>
  <li><b>${tn('recruit')}</b>每名士兵一兩・<b>${tn('hire')}</b>每次 ${fmt(HIRE_COST)} 抽一名在野武將・<b>${tn('shop')}</b>依標示消費・<b>${TILES.filter(T => T.t === 'rest').map(T => T.n).join('／')}</b>繳 500／800 兩休息一次，其間不得收取過路稅・<b>${tn('island')}</b>重擲骰子，領取點數 ×1000 兩・<b>${tn('cottage')}</b>重擲三次骰子，10–12 點得武將 1 名、13–15 點 2 名、16–18 點 3 名・<b>${tn('emergency')}／${tn('strategy')}</b>抽牌並依指示辦理，錦囊保留卡可留待日後使用。</li>
  <li><b>記憶</b>：玩家看不到別人的牌，只會記得公開被俘虜或被奪走的牌；但對方一出牌，這些記憶就失效。</li>
  <li><b>賣出</b>：軍費不足時，可隨時賣出武將、特別卡、士兵（每 500 名換 500 兩）或領地（地價加建城費）給國庫，每次賣出需繳 ${fmt(SALE_TAX)} 交易稅。</li>
  <li><b>勝利</b>：其他所有對手全部失敗；或佔有同色全部之領地（含古戰場）任一種；或佔有領地總數達 ${S.winTerr} 處。</li></ol>
  <p><small>自訂規則（原版未載明）：武將賣價 ${fmt(GEN_BASE)}、特別卡賣價 ${fmt(SPECIAL_BASE)}；其他債務無力支付時亦視為破產；賣出僅限賣給國庫，暫不支援玩家間拍賣。</small></p>`);
}
const showGame = () => { $('#setup').hidden = true; $('#lobby').hidden = true; $('#game').hidden = false; };

/* ------------------------------------------------------------------ *
 *  單機版：引擎在本頁執行
 * ------------------------------------------------------------------ */
function startOffline(seats, opts) {
  const G = () => E.state();
  // 畫面視角：只有一位人類時為其本人；全電腦為旁觀；多位人類共用裝置時不顯示手牌
  const viewerId = () => { const hs = G().players.filter(p => !p.ai); return hs.length === 1 ? hs[0].id : hs.length ? null : 'all'; };
  let lastViewer = null;
  const ui = {
    sleep, log: addLog, dice: showDice, flash: flashDeck,
    render: () => renderView(E.viewFor(viewerId())),
    ask: (p, title, body, buttons) => localModal(title, body, buttons),
    handoff: async p => {
      if (G().players.filter(q => !q.ai && q.alive).length > 1 && lastViewer !== p.id) {
        await okLocal('請交換玩家', `<p style="font-size:18px">請把裝置交給 ${pname(p)}，其他人請迴避！</p>`);
      }
      lastViewer = p.id;
    },
    turn: (p, o) => new Promise(res => turnButtons({ ...o, hand: viewerId() !== p.id }, res)),
    gameOver: (w, html) => { ui.render(); localModal(w ? '🏆 勝利' : '遊戲結束', html, [{ label: '再戰一局', cls: 'pri', value: true }]).then(() => location.reload()); },
  };
  showGame();
  E.newGame(seats, opts, ui);
  ui.render();
  E.gameLoop();
}
function setupRows() {
  const n = +$('#nPlayers').value, rows = $('#playerRows'), prev = [...rows.children].map(r => ({ ai: r.querySelector('.ty').value, cmd: r.querySelector('.cm').value }));
  rows.innerHTML = '';
  for (let k = 0; k < n; k++) {
    const v = prev[k] || { ai: k ? 'ai' : 'human', cmd: String(k) };
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = `<span class="swatch" style="background:${PLAYER_COLORS[k]}"></span>
      第 ${k + 1} 位 <select class="ty"><option value="human">人類</option><option value="ai">電腦</option></select>
      選擇主帥 <select class="cm">${COMMANDERS.map((c, j) => `<option value="${j}">${cmdName(j)}（${SUIT[c[0][0]]}A）</option>`).join('')}</select>`;
    r.querySelector('.ty').value = v.ai; r.querySelector('.cm').value = v.cmd;
    rows.appendChild(r);
  }
}
function offlineStartClicked() {
  const seats = [...$('#playerRows').children].map(r => ({ ai: r.querySelector('.ty').value === 'ai', cmd: +r.querySelector('.cm').value }));
  if (new Set(seats.map(r => r.cmd)).size !== seats.length) { $('#setupErr').textContent = '每位參加者須選擇不同的主帥。'; return; }
  startOffline(seats, { aiDelay: +$('#optSpeed').value, theme: $('#optTheme').value });
}

/* ------------------------------------------------------------------ *
 *  連線版：伺服器執行引擎；本頁收畫面與題目並送回作答
 * ------------------------------------------------------------------ */
// 座位代碼存在分頁（sessionStorage）：同一瀏覽器開多個分頁即可扮演不同玩家，重新整理仍保留座位
const ON = { token: sessionStorage.getItem('sanguo-token') || '', es: null, lobby: null, you: null, shown: new Set() };
const api = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ON.token, ...body }) })
  .then(r => r.json());
// 讀取對話框中所有輸入欄位，送給伺服器判讀
const formInputs = b => [...b.querySelectorAll('input')].map(i => ({ id: i.id || undefined, name: i.name || undefined, type: i.type, value: i.value, checked: i.checked, k: i.dataset.k }));
function connect() {
  ON.es?.close();
  const es = ON.es = new EventSource('/api/events?token=' + encodeURIComponent(ON.token));
  es.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'lobby') { ON.lobby = m.lobby; ON.you = m.you; if (!m.lobby.started) renderLobby(); }
    else if (m.type === 'reset') { $('#log').innerHTML = ''; VIEW = null; $('#game').hidden = true; renderLobby(); }
    else if (m.type === 'view') { showGame(); renderView(m.view); }
    else if (m.type === 'log') addLog(m.html);
    else if (m.type === 'dice') showDice(m.r);
    else if (m.type === 'flash') flashDeck(m.k);
    else if (m.type === 'turn') turnButtons(m.opts, act => api('/api/answer', { id: m.id, btn: act }));
    else if (m.type === 'ask') {
      if (ON.shown.has(m.id)) return; // 重新連線時伺服器會補送未答的題目
      ON.shown.add(m.id);
      showModal(m.title, m.body, m.buttons, async (k, b) => {
        const r = await api('/api/answer', { id: m.id, btn: k, inputs: formInputs(b) });
        if (r.errors) { for (const [id, t] of Object.entries(r.errors)) { const el = b.querySelector('#' + id); if (el) el.textContent = t; } return false; }
        return !!r.ok;
      }, m.id);
    } else if (m.type === 'over') {
      const seated = ON.you?.seat != null;
      showModal(m.title, m.html, [{ label: seated ? '回到大廳開新局' : '確定', cls: 'pri' }],
        async () => { if (seated) await api('/api/lobby', { op: 'reset' }); return true; });
    }
  };
  es.onerror = () => { $('#netStatus').textContent = '連線中斷，重新連線中……'; };
  es.onopen = () => { $('#netStatus').textContent = ''; };
}
function renderLobby() {
  $('#setup').hidden = true; $('#lobby').hidden = false;
  const L = ON.lobby, you = ON.you || {};
  useTheme(L.theme);
  $('#onTheme').value = L.theme; $('#lobbyThemeName').textContent = E.THEMES[L.theme]?.label || '';
  const used = L.seats.filter(s => s.state !== 'open').map(s => s.cmd);
  $('#seatRows').innerHTML = L.seats.map((s, k) => {
    const sw = `<span class="swatch" style="background:${PLAYER_COLORS[k]}"></span> 第 ${k + 1} 位`;
    if (s.state === 'open') {
      const free = COMMANDERS.map((c, j) => j).filter(j => !used.includes(j));
      return `<div class="row">${sw}　<i>空位</i>
        ${you.seat == null && free.length ? `<select id="pick${k}">${free.map(j => `<option value="${j}">${cmdName(j)}</option>`).join('')}</select><button data-join="${k}" class="pri">以此主帥加入</button>` : ''}
        ${you.host && free.length ? `<button data-ai="${k}">設為電腦</button>` : ''}</div>`;
    }
    const who = s.state === 'ai' ? '電腦' : (s.mine ? '你' : '玩家') + (s.host ? '（房主）' : '') + (s.online ? '' : '（離線）');
    return `<div class="row">${sw}　<b>${cmdName(s.cmd)}</b>　${who}
      ${(you.host && s.state === 'ai') || s.mine ? `<button data-open="${k}">${s.mine ? '離開座位' : '移除'}</button>` : ''}</div>`;
  }).join('');
  const nSeated = L.seats.filter(s => s.state !== 'open').length;
  $('#lobbyHost').hidden = !you.host;
  $('#lobbyWait').textContent = you.host ? (nSeated < 2 ? '至少需要 2 位（可把空位設為電腦）。' : '')
    : you.seat == null ? '選一個空位與主帥加入。第一位加入者為房主，由房主開始遊戲。' : '等待房主開始遊戲……';
  $('#lobbyStart').disabled = nSeated < 2;
  $('#onSpeed').value = String(L.speed);
  $('#seatRows').querySelectorAll('[data-join]').forEach(b => b.onclick = async () => {
    const k = +b.dataset.join, r = await api('/api/join', { seat: k, cmd: +$('#pick' + k).value });
    if (r.token) { ON.token = r.token; sessionStorage.setItem('sanguo-token', r.token); connect(); } else alert(r.error || '無法加入');
  });
  $('#seatRows').querySelectorAll('[data-ai]').forEach(b => b.onclick = () => {
    const free = COMMANDERS.map((c, j) => j).filter(j => !used.includes(j));
    api('/api/lobby', { op: 'ai', seat: +b.dataset.ai, cmd: free[0] });
  });
  $('#seatRows').querySelectorAll('[data-open]').forEach(b => b.onclick = async () => {
    const k = +b.dataset.open, mine = L.seats[k].mine;
    await api('/api/lobby', { op: 'open', seat: k });
    if (mine) { ON.token = ''; sessionStorage.removeItem('sanguo-token'); connect(); }
  });
}
function startOnline() {
  $('#setup').hidden = true; $('#lobby').hidden = false;
  $('#onTheme').innerHTML = themeOptions();
  $('#onTheme').onchange = () => api('/api/lobby', { op: 'theme', theme: $('#onTheme').value });
  $('#lobbyStart').onclick = () => api('/api/lobby', { op: 'start', speed: +$('#onSpeed').value, theme: $('#onTheme').value });
  connect();
}

/* ---- 啟動 ---- */
$('#rulesBtn0').onclick = showRules;
$('#rulesBtn').onclick = showRules;
$('#rulesBtn1').onclick = showRules;
if (location.protocol === 'http:' || location.protocol === 'https:') startOnline();
else {
  const qs = new URLSearchParams(location.search);
  $('#optTheme').innerHTML = themeOptions();
  $('#optTheme').value = E.THEMES[qs.get('theme')] ? qs.get('theme') : 'sanguo';
  useTheme($('#optTheme').value);
  $('#optTheme').onchange = () => { useTheme($('#optTheme').value); setupRows(); };
  $('#nPlayers').onchange = setupRows;
  $('#startBtn').onclick = offlineStartClicked;
  setupRows();
  // 示範模式：index.html?demo 直接由四位電腦對戰（可加 &theme=shuihu）
  if (qs.has('demo')) startOffline([0, 1, 2, 3].map(k => ({ ai: true, cmd: k })), { aiDelay: 450, theme: $('#optTheme').value });
}
})();
