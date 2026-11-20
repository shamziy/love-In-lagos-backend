import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const DB="/tmp/lil_test.db"; for(const f of [DB,DB+"-wal",DB+"-shm"]) try{fs.unlinkSync(f)}catch{}
let pass=0,fail=0; const ok=(n,c,x="")=>{c?pass++:fail++;console.log((c?"PASS ":"FAIL ")+n+(c?"":" "+JSON.stringify(x)))};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function start(file,port){const p=spawn("node",[file],{env:{...process.env,PORT:port,DB_PATH:DB,DEMO:"false",JWT_SECRET:"a-test-secret-that-is-long-enough-123456"},stdio:["ignore","pipe","pipe"]});let err="";p.stderr.on("data",d=>err+=d);for(let i=0;i<50;i++){await sleep(150);try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok)return {p,err:()=>err}}catch{}}throw new Error("server did not start: "+err)}
const call=(port,tk)=>async(m,path,b)=>{const r=await fetch(`http://127.0.0.1:${port}/api${path}`,{method:m,headers:{"content-type":"application/json",...(tk?{authorization:"Bearer "+tk}:{})},body:b?JSON.stringify(b):undefined});let j=null;try{j=await r.json()}catch{}return [r.status,j]};

// ---------- PART 1: ORIGINAL server, old schema ----------
let S=await start("./server.mjs.orig",3911), c0=call(3911);
let [,a]=await c0("POST","/signup",{username:"adaeze",email:"a@x.com",password:"password123"});
let [,b]=await c0("POST","/signup",{username:"tunde",email:"t@x.com",password:"password123"});
const A0=call(3911,a.token);
let r=await A0("POST","/amebo",{text:"My old single gist from before the update",cat:"lag",anon:true}); ok("old server: posted 1 gist",r[0]===201,r);
r=await A0("POST","/amebo",{text:"A second one should be refused by old server",cat:"lag"}); ok("old server: 2nd refused (old rule)",r[0]===409);
S.p.kill(); await sleep(400);
// two users become matches (rows inserted directly), so the games test can run
const d=new DatabaseSync(DB); const cols=d.prepare("PRAGMA table_info(requests)").all().map(x=>x.name);
const ins={from_id:a.user.id,to_id:b.user.id,status:"accepted",pct:60,created:Date.now(),auto:0,why:"[]"}; const use=Object.keys(ins).filter(k=>cols.includes(k));
d.prepare(`INSERT INTO requests(${use.join(",")}) VALUES(${use.map(()=>"?").join(",")})`).run(...use.map(k=>ins[k]));
d.prepare("UPDATE users SET xp=20000 WHERE id=?").run(a.user.id);
const oldSql=d.prepare("SELECT sql FROM sqlite_master WHERE name='amebo_posted'").get().sql; d.close();
ok("old table really has the one-per-day key",/PRIMARY KEY\s*\(\s*user_id\s*,\s*day\s*\)/i.test(oldSql));

// ---------- PART 2: PATCHED server on the SAME database ----------
S=await start("./server.mjs",3912); const cA=call(3912,a.token),cB=call(3912,b.token);
const d2=new DatabaseSync(DB); const newSql=d2.prepare("SELECT sql FROM sqlite_master WHERE name='amebo_posted'").get().sql; const rows=d2.prepare("SELECT COUNT(*) n FROM amebo_posted").get().n; const old=d2.prepare("SELECT name FROM sqlite_master WHERE name='amebo_posted_old'").get(); d2.close();
ok("migrated: key is now per gist",!/PRIMARY KEY\s*\(\s*user_id\s*,\s*day\s*\)/i.test(newSql),newSql);
ok("migration kept the existing record",rows===1,rows); ok("no leftover temp table",!old);
r=await cA("GET","/amebo"); ok("old gist still live, 2 left",r[1].mineAll.length===1&&r[1].postsLeft===2&&r[1].max===3&&r[1].canPost===true&&r[1].mine.text.startsWith("My old single"),r[1]);
r=await cA("POST","/amebo",{text:"Second gist of the day, allowed now",cat:"rnd",anon:false}); ok("2nd gist allowed",r[0]===201,r); const g2=r[1]?.id;
r=await cA("POST","/amebo",{text:"Third gist of the day, the last one",cat:"con"}); ok("3rd gist allowed",r[0]===201,r); const g3=r[1]?.id;
r=await cA("POST","/amebo",{text:"Fourth gist should be refused today",cat:"rnd"}); ok("4th refused with new message",r[0]===409&&/3 gists/.test(r[1].error),r);
r=await cA("GET","/amebo"); ok("status: 3 gists, none left, newest first",r[1].mineAll.length===3&&r[1].postsLeft===0&&r[1].canPost===false&&r[1].mineAll[0].id===g3,r[1]);
await cA("DELETE","/amebo/"+g2); await cA("DELETE","/amebo/"+g3);
r=await cA("GET","/amebo"); ok("deleting does not give slots back",r[1].mineAll.length===1&&r[1].canPost===false&&r[1].postsLeft===0,r[1]);
r=await cA("POST","/amebo",{text:"Fourth after deleting two of them",cat:"rnd"}); ok("still refused after deleting",r[0]===409);
r=await cB("GET","/amebo/next"); ok("another user can still read gists",r[0]===200);
// shop
r=await cA("GET","/shop"); const prices=r[1].items.map(i=>i.price); ok("every outfit >= 1000 XP",Math.min(...prices)>=1000,prices); console.log("   prices",prices.join(","));
r=await cB("POST","/shop/buy",{id:"ot1"}); ok("broke user cannot buy a 1000 XP item",r[0]===400&&/Not enough/.test(r[1].error),r);
r=await cA("POST","/shop/buy",{id:"hat3"}); ok("user with 20000 XP buys the Crown (5000)",r[0]===200&&r[1].bal===15000,r[1]?.bal);
// gifts
let sent=0; for(let i=0;i<10;i++){r=await cA("POST","/gift",{to:b.user.id,amount:1000}); if(r[0]===200)sent++}
ok("gifted 10,000 XP in one day (10 x 1000)",sent===10,sent);
r=await cA("POST","/gift",{to:b.user.id,amount:10}); ok("next gift refused: daily limit 10,000",r[0]===400&&/10,000/.test(r[1].error),r);
r=await cA("POST","/gift",{to:b.user.id,amount:7}); ok("odd amount still refused",r[0]===400);
// games
r=await cA("POST","/games/invite",{userId:b.user.id}); ok("invite works",r[0]===201,r); const gid=r[1]?.id;
r=await cB("POST",`/games/${gid}/respond`,{accept:true}); ok("accepted",r[0]===200);
r=await cA("GET","/games/with/"+b.user.id); const gm=r[1]; ok("game playing, A asks first, 20 questions drawn",gm.status==="playing"&&gm.cur.yourTurnToAsk,gm);
const q1=gm.cur.q; r=await cA("POST",`/games/${gid}/swap`,{}); ok("swap ok",r[0]===200,r);
r=await cA("GET","/games/with/"+b.user.id); ok("question changed, still question 1, still my turn",r[1].cur.q!==q1&&r[1].i===0&&r[1].cur.yourTurnToAsk,[q1,r[1].cur]);
r=await cB("POST",`/games/${gid}/swap`,{}); ok("the other player cannot swap",r[0]===403,r);
// many swaps stay inside 0..699, new questions (>=500) appear
const seen=new Set(); for(let i=0;i<150;i++){await cA("POST",`/games/${gid}/swap`,{}); const g=(await cA("GET","/games/with/"+b.user.id))[1]; seen.add(g.cur.q)}
ok("all swapped ids within 0..699",[...seen].every(q=>q>=0&&q<700),[...seen].filter(q=>q>=700)); ok("new questions (500-699) are served",[...seen].some(q=>q>=500),[...seen].length);
const d3=new DatabaseSync(DB); const qs=JSON.parse(d3.prepare("SELECT qs FROM games WHERE id=?").get(gid).qs); d3.close(); ok("game still has 20 distinct questions",qs.length===20&&new Set(qs).size===20,qs);
r=await cA("POST",`/games/${gid}/ask`,{}); ok("ask works",r[0]===200);
r=await cA("POST",`/games/${gid}/swap`,{}); ok("cannot swap after asking",r[0]===403,r);
r=await cB("POST",`/games/${gid}/answer`,{text:"my answer"}); ok("answer works, moves to question 2",r[0]===200);
r=await cA("GET","/games/with/"+b.user.id); ok("history keeps question 1 after swaps",r[1].i===1&&r[1].history.length===1&&r[1].history[0].answer==="my answer",r[1]);
// profile autosave style partial updates still work
r=await cA("PUT","/me",{bio:"autosaved bio"}); ok("partial PUT /me (bio only)",r[0]===200&&r[1].bio==="autosaved bio",r);
r=await cA("PUT","/me",{area:"Lekki"}); ok("partial PUT /me (area only) keeps bio",r[0]===200&&r[1].area==="Lekki"&&r[1].bio==="autosaved bio",r[1]);
r=await cA("PUT","/me",{username:"tunde"}); ok("taken username gives 409 message",r[0]===409,r);
console.log("server stderr:",S.err()||"(none)"); S.p.kill();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
