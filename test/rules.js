// 規則單元測試（不需要網路）：計分、將軍、將死、重複局面
const assert = require('assert'), R = require('../public/rules.js');
const P = (side, type, x, y) => ({id: `${side}-${type}-${x}${y}`, side, type, x, y, fresh: false});
const G0 = ps => ({pieces: ps, hist: [], turn: 'w', over: false, pending: [], phase: null, uid: 0, seen: {}});
const mv = (G, side, id, x, y) => R.play(G, side, {t:'move', pid:id, x, y}, 0);

// 1. 計分：OTL、謎都算 3 分
{ const G = G0([P('w','king',4,8), P('w','otl',0,8), P('w','godness',1,8), P('w','dong',2,8), P('w','tea',3,8), P('w','t',5,8)]);
  assert.equal(R.pts(G,'w'), 0 + 3 + 3 + 10 + 7 + 2); console.log('✔ OTL、謎之美少女各算 3 分，龍算 2 分'); }

// 2. 被將軍：必須解除；王不能走進被攻擊的格子
{ const G = G0([P('w','king',4,8), P('b','king',8,0), P('b','kid',4,3), P('w','kid',0,5)]);
  assert.equal(R.check(G,'w'), true);
  const r = mv(G,'w','w-kid-05',0,6); assert.equal(r.ok, false); assert.match(r.error, /將軍|危險/);
  const km = R.moves(G,'w-king-48').map(m => m.x+','+m.y);
  assert.ok(km.includes('3,8') && km.includes('5,8') && !km.includes('4,7'), km.join(' '));   // 可橫移；沿著被攻擊的直線不行
  assert.ok(mv(G,'w','w-king-48',3,8).ok);
  console.log('✔ 被將軍時，沒解除的走法被拒絕；王不能走進被攻擊的格子'); }

// 3. 不能讓王送死：擋路的棋子不能離開（被牽制）
{ const G = G0([P('w','king',4,8), P('w','kid',4,6), P('b','king',8,0), P('b','kid',4,2)]);
  assert.equal(R.check(G,'w'), false);
  const ms = R.moves(G,'w-kid-46').map(m => m.x+','+m.y);
  assert.ok(ms.every(m => m.startsWith('4,')), '被牽制的棋子只能沿著直線移動：' + ms.join(' '));
  assert.equal(mv(G,'w','w-kid-46',3,6).ok, false);
  console.log('✔ 被牽制的棋子不能離開，避免王送死'); }

// 4. 將死：白王在角落、沒有其他棋子，被兩隻孩封住
{ const G = G0([P('w','king',0,8), P('b','king',8,0), P('b','kid',0,4), P('b','kid',1,0)]); G.turn = 'b';
  assert.ok(mv(G,'b','b-kid-10',1,4).ok);
  assert.equal(G.over, 'b'); assert.equal(G.result.reason, 'checkmate'); assert.equal(G.result.loser, 'w');
  console.log('✔ 將死：無路可走且被將軍，對方獲勝'); }

// 5. 無路可走但沒被將軍（逼和）：依分數判定
{ const G = G0([P('w','king',0,8), P('b','king',8,0), P('b','kid',1,4), P('b','shoe',4,7)]); G.turn = 'b';
  assert.equal(R.check(G,'w'), false);
  assert.ok(mv(G,'b','b-shoe-47',2,7).ok);
  assert.equal(R.check(G,'w'), false); assert.equal(G.result.reason, 'stalemate');
  assert.deepEqual(G.result.total, {w:10, b:21}); assert.equal(G.over, 'b');
  console.log('✔ 無路可走但沒被將軍：依分數判定（白 10 分、黑 21 分）'); }

// 6. 同一局面重複三次：禁止（第三次出現的那一步不能走）
{ const G = G0([P('w','king',4,8), P('b','king',4,0), P('w','kid',0,5), P('b','kid',8,3)]);
  const seq = [['w','w-kid-05',0,6],['b','b-kid-83',8,2],['w','w-kid-05',0,5],['b','b-kid-83',8,3]]; let n = 0, r;
  for (; n < 16; n++) { const [s,id,x,y] = seq[n%4]; r = mv(G,s,id,x,y); if (!r.ok) break; }
  assert.equal(n, 8); assert.match(r.error, /重複三次/); assert.equal(G.over, false);
  assert.ok(!R.moves(G,'w-kid-05').some(m => m.x===0 && m.y===5), '高亮的合法走法也不含這一步');
  assert.ok(mv(G,'w','w-kid-05',0,4).ok); console.log('✔ 同一局面第三次出現的那一步被禁止（第 9 手），換別的走法可以'); }

// 7. 剛復活的咚：可以移動，但不能吃棋也不能斬擊
{ const mk = fresh => { const d = P('w','dong',4,7); d.fresh = fresh; return G0([P('w','king',0,8), P('b','king',8,0), d, P('b','shoe',4,5), P('b','t',3,7)]); };
  const F = mk(true), ms = R.moves(F,'w-dong-47').map(m => m.x+','+m.y);
  assert.ok(ms.includes('4,6') && !ms.includes('3,7'), ms.join(' '));   // 能走空格、不能吃 (3,7)
  assert.ok(mv(F,'w','w-dong-47',4,6).ok); assert.equal(F.phase, null); assert.equal(F.turn, 'b');   // 沒有斬擊提示
  const N = mk(false); assert.ok(mv(N,'w','w-dong-47',4,6).ok); assert.equal(N.phase.kind, 'slash');   // 一般的咚會問斬擊
  console.log('✔ 剛復活的咚：可移動、不能吃棋、不能斬擊'); }

// 8. 殘局（雙方都只剩 7 顆以下）每手 3 秒
{ const G = G0([P('w','king',0,8), P('b','king',8,0)]); G.clock = R.clockInit(0, {graceMs:0});
  assert.equal(R.clockView(G,0).limit, 3000);
  const F = R.create(); F.clock = R.clockInit(0, {graceMs:0}); assert.equal(R.clockView(F,0).limit, 8000);
  const H = G0([...['king','kid','kid','iron','iron','shoe','shoe'].map((ty,i) => P('w',ty,i,8)), P('b','king',8,0), P('b','kid',8,1)]); H.clock = R.clockInit(0, {graceMs:0});
  assert.equal(R.clockView(H,0).limit, 3000); H.pieces.push(P('w','tea',7,7)); assert.equal(R.clockView(H,0).limit, 8000);   // 一方 8 顆就回到 8 秒
  console.log('✔ 雙方都只剩 7 顆以下時，每手縮為 3 秒；有一方超過 7 顆就維持 8 秒'); }

// 9. 投降
{ const G = G0([P('w','king',4,8), P('b','king',4,0)]);
  assert.ok(R.play(G,'b',{t:'resign'},0).ok); assert.equal(G.over, 'w'); assert.equal(G.result.reason, 'resign'); assert.equal(G.result.loser, 'b');
  assert.equal(R.play(G,'w',{t:'resign'},0).ok, false); console.log('✔ 投降：任何時候都可以，對方獲勝'); }

console.log('\n規則測試全部通過');
