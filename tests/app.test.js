process.env.DATABASE_URL=process.env.TEST_DATABASE_URL||process.env.DATABASE_URL;process.env.JWT_SECRET='test-secret';process.env.ADMIN_USERNAME='Admin';process.env.ADMIN_PASSWORD='TestAdmin123!';process.env.UPLOAD_DIR=require('path').join(require('os').tmpdir(),'ca-up-'+process.pid);
const test=require('node:test'),assert=require('node:assert'),fs=require('fs'),path=require('path'),jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs'),{server,io,db}=require('../server'),{io:cio}=require('socket.io-client');
let base,adminTok;const socks=[];
const once=(s,e)=>new Promise(r=>s.once(e,r));
const api=async(p,m='GET',b,t,raw)=>{const r=await fetch(base+'/api'+p,{method:m,headers:{...(raw?{}:{'Content-Type':'application/json'}),...(t?{Authorization:'Bearer '+t}:{}),...(raw?.type?{'Content-Type':raw.type}:{})},body:raw?raw.body:b&&JSON.stringify(b)});return{status:r.status,body:await r.json().catch(()=>({}))}};
const PW='Passw0rd!';
const reg=async n=>{const r=await api('/auth/register','POST',{username:n,password:PW,confirm_password:PW});assert.equal(r.status,201,JSON.stringify(r.body));return(await api('/auth/login','POST',{login:n,password:PW})).body.token};
const addAdmin=n=>{db.prepare("INSERT INTO users(name,email,password_hash,role,username,username_normalized) VALUES(?,?,?,'ADMIN',?,?)").run(n,n+'@a.io',bcrypt.hashSync(PW,4),n,n);return api('/auth/login','POST',{login:n,password:PW}).then(r=>r.body.token)};
const conn=async(token)=>{const s=cio(base,{forceNew:true,auth:{token}});socks.push(s);await once(s,'connect');return s};
const ev=async(token,e,pl)=>{const s=await conn(token),st=once(s,'state'),er=once(s,'error_msg');s.emit(e,pl);return{s,r:await Promise.race([st,er.then(m=>({err:m}))])}};
const err=(s,e,pl,evn='submit_error')=>{const p=once(s,evn);s.emit(e,pl);return p};
const mkQuiz=async(cfg,n=2,tok=adminTok)=>{const c=(await api('/quizzes','POST',{title:'X',...cfg},tok)).body;await api(`/quizzes/${c.id}/import`,'POST',{text:Array.from({length:n},(_,i)=>`Tech | Question number ${i+1}? | Right${i} | Wrong A | Wrong B | Wrong C`).join('\n')},tok);return{id:c.id,code:c.join_code,dcode:c.display_code}};
const pos=(q,t)=>q.options.find(o=>o.text===t).id,sid=()=>Math.random().toString(36).slice(2);
const ack=(s,e,pl)=>new Promise(r=>s.emit(e,pl,r));
const start=async(a,players)=>{const ps=players.map(p=>once(p,'quiz:question_started')),sp=once(a,'quiz:question_started');a.emit('admin:start_question');return{staff:await sp,qs:await Promise.all(ps)}};
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
test.before(async()=>{if(!process.env.DATABASE_URL)throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database before running tests');await new Promise(r=>server.listen(0,r));base='http://localhost:'+server.address().port;adminTok=(await api('/auth/login','POST',{login:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD})).body.token});
test.after(()=>{socks.forEach(s=>s.close());io.close();fs.rmSync(process.env.UPLOAD_DIR,{recursive:true,force:true})});

test('auth: register validation, uniqueness/normalization, role ignored, login, tampered JWT, logout revokes',async()=>{
 assert.ok(adminTok);const r=await api('/auth/register','POST',{username:'Madhu',password:PW,confirm_password:PW,role:'ADMIN'});assert.equal(r.status,201);assert.equal(r.body.user.role,'USER');
 assert.equal(db.prepare("SELECT role FROM users WHERE username='Madhu'").get().role,'USER');assert.notEqual(r.body.user.password_hash,'x');assert.ok(db.prepare("SELECT password_hash h FROM users WHERE username='Madhu'").get().h.startsWith('$2'));
 for(const n of ['madhu','MADHU','  Madhu ','mad hu'.replace(' ','')])assert.equal((await api('/auth/register','POST',{username:n,password:PW,confirm_password:PW})).status,409,n);
 assert.equal(db.prepare("SELECT email FROM users WHERE username='Madhu'").get().email,null);
 for(const bad of [{username:' '},{username:'ab'},{username:'ok name',password:'short1'},{username:'ok name',password:'nodigitshere'},{username:'ok name',confirm_password:'Different1x'}])assert.equal((await api('/auth/register','POST',{password:PW,confirm_password:PW,...bad})).status,422);
 assert.equal((await api('/auth/register','POST',{username:"x'; DROP TABLE users;--",password:PW,confirm_password:PW})).status,422);
 assert.equal((await api('/auth/login','POST',{login:'madhu',password:'wrong'})).status,401);
 const t=await reg('Tamper One');const forged=jwt.sign({id:1,role:'ADMIN',tv:0},'not-the-secret',{issuer:'challengearena'});
 assert.equal((await api('/quizzes','GET',null,forged)).status,401);assert.equal((await api('/quizzes','GET',null,t)).status,403);
 const none=t.split('.');none[1]=Buffer.from(JSON.stringify({id:1,role:'ADMIN',tv:0})).toString('base64url');assert.equal((await api('/quizzes','GET',null,none.join('.'))).status,401);
 assert.equal((await api('/auth/logout','POST',null,t)).status,200);assert.equal((await api('/me','GET',null,t)).status,401)});

test('role matrix + IDOR on admin API',async()=>{
 const u=await reg('Plain User'),a2=await addAdmin('admin2'),q=await mkQuiz({allowed_team_sizes:[1]});
 for(const [m,p,b] of [['GET','/quizzes'],['POST','/quizzes',{title:'t'}],['GET','/quizzes/'+q.id],['DELETE','/quizzes/'+q.id,{confirm:q.code}],['POST',`/quizzes/${q.id}/restart`],['POST',`/quizzes/${q.id}/questions`,{}],['GET',`/quizzes/${q.id}/responses`],['GET',`/quizzes/${q.id}/qr`],['POST',`/quizzes/${q.id}/reorder`,{ids:[]}],['PUT',`/quizzes/${q.id}/settings`,{}]]){
  assert.equal((await api(p,m,b,u)).status,403,m+p);assert.equal((await api(p,m,b)).status,401,m+p);if(p.includes('/quizzes/'))assert.equal((await api(p,m,b,a2)).status,404,'other admin '+m+p)}
 assert.equal((await api('/quizzes','POST',{title:'bad',role:'ADMIN',created_by:1,allowed_team_sizes:[9]},adminTok)).status,422);
 const qid=db.prepare('SELECT id FROM questions WHERE quiz_id=?').get(q.id).id;
 assert.equal((await api('/questions/'+qid,'DELETE',null,a2)).status,404);assert.equal((await api('/questions/'+qid,'DELETE',null,u)).status,403);assert.equal((await api('/quizzes/abc','GET',null,adminTok)).status,404);
 assert.equal((await api('/quizzes','GET',null,a2)).body.length,0)});

test('team name vs username collision (normalized)',async()=>{
 const{code}=await mkQuiz({allowed_team_sizes:[2,3]});const t=await reg('Captain One'),t2=await reg('Captain Two'),t3=await reg('Captain Three');
 assert.equal((await ev(t,'create_team',{code,team:'captain two'})).r.err,'That name is already taken');
 const a=await ev(t,'create_team',{code,team:'Team  Rocket'});assert.equal(a.r.team.name,'Team Rocket');
 assert.equal((await ev(t2,'create_team',{code,team:' TEAM ROCKET '})).r.err,'Team name already taken');
 assert.equal((await api('/auth/register','POST',{username:'team rocket',email:'tr@x.io',password:PW,confirm_password:PW})).status,409)});

test('lifecycle, privacy, shuffle, speed bonus, idempotent answers, reconnect lock',async()=>{
 const{code,id}=await mkQuiz({allowed_team_sizes:[1],display_mode:'big_only'},2);const a=await ev(adminTok,'join_admin',{code}),toks=[];for(let i=0;i<10;i++)toks.push(await reg('Player '+i));
 const ps=[];for(const t of toks)ps.push((await ev(t,'join_player',{code})).s);
 assert.equal(await err(ps[0],'participant:submit_answer',{pos:1,sid:sid()}),'Question is not active');
 const {staff,qs:qq}=await start(a.s,ps);assert.ok(staff.text.includes('Question number'));
 qq.forEach(q=>{assert.equal(q.text,undefined);assert.equal(q.image_url,undefined);assert.ok(!JSON.stringify(q).includes('Question number'));assert.ok(q.options.every(o=>Object.keys(o).sort().join()==='id,text'))});
 assert.ok(new Set(qq.map(q=>q.options.map(o=>o.text).join())).size>1);assert.ok(new Set(qq.map(q=>q.options.findIndex(o=>o.text==='Right0'))).size>1);
 const s0=sid(),r0=await ack(ps[0],'participant:submit_answer',{pos:pos(qq[0],'Right0'),sid:s0,participantId:999,score:99999,response_time:0.01});
 assert.deepEqual([r0.ok,r0.correct],[true,undefined]);const sc=db.prepare('SELECT score,response_time FROM responses WHERE participant_id=(SELECT id FROM participants WHERE user_id=?)').get(jwt.decode(toks[0]).id);
 assert.ok(sc.score>=10&&sc.score<=15&&sc.response_time>=0,'server-side score and time'); // marks 10 + bonus up to 5
 const dup=await ack(ps[0],'participant:submit_answer',{pos:pos(qq[0],'Right0'),sid:s0});assert.equal(dup.ok,true);assert.equal(dup.duplicate,true); // idempotent retry
 const other=await ack(ps[0],'participant:submit_answer',{pos:pos(qq[0],'Wrong A'),sid:sid()});assert.deepEqual([other.ok,other.error],[false,'Already answered']);
 const w=await ack(ps[1],'participant:submit_answer',{pos:pos(qq[1],'Wrong A'),sid:sid()});assert.deepEqual([w.ok,w.correct,Object.keys(w).sort().join()],[true,undefined,'ok,pos']);
 assert.equal(db.prepare('SELECT COUNT(*) c FROM responses r JOIN participants p ON p.id=r.participant_id WHERE p.quiz_id=?').get(id).c,2);
 const re=await ev(toks[0],'join_player',{code});assert.equal(re.r.mine.correct,undefined);assert.equal(typeof re.r.mine.pos,'number');assert.equal(re.r.answered,true); // reconnect keeps the lock
 assert.equal((await ack(re.s,'participant:submit_answer',{pos:1,sid:sid()})).error,'Already answered');
 assert.ok(db.prepare("SELECT 1 FROM pg_indexes WHERE indexname='uq_resp_sub'").get());
 const f0=once(ps[0],'quiz:question_finished'),f1=once(ps[1],'quiz:question_finished');a.s.emit('admin:finish_question');const [fr0,fr1]=await Promise.all([f0,f1]);assert.equal(fr0.mine.correct,true);assert.equal(fr1.mine.correct,false); // right/wrong revealed only now
 assert.equal((await ack(ps[2],'participant:submit_answer',{pos:1,sid:sid()})).error,'Question is not active');
 const bd=(await ev(adminTok,'join_admin',{code})).r.board;assert.ok(bd[0].score>=10&&bd[0].answered===1)});

test('socket authorization: anonymous, USER and DISPLAY cannot run admin events; admins cannot play',async()=>{
 const{code,id,dcode}=await mkQuiz({allowed_team_sizes:[1]});const u=await reg('Sock User'),adm=await ev(adminTok,'join_admin',{code});
 const anon=await conn(null);for(const e of ['admin:start_question','admin:finish_question','admin:finish_quiz'])assert.equal(await err(anon,e,undefined,'admin:error'),'Unauthorized');
 assert.equal((await ev(null,'join_admin',{code})).r.err,'Forbidden');assert.equal((await ev(u,'join_admin',{code})).r.err,'Forbidden');
 assert.equal((await ev(await addAdmin('admin3'),'join_admin',{code})).r.err,'Forbidden'); // another admin: not the owner
 assert.equal((await ev(adminTok,'join_player',{code})).r.err,'Sign in with a participant account to play');
 const usr=await ev(u,'join_player',{code});assert.equal(await err(usr.s,'admin:start_question',undefined,'admin:error'),'Unauthorized');usr.s.emit('admin:finish_quiz');
 const d=await conn(null),dc=once(d,'display:connected');d.emit('display:connect',{displayCode:dcode});await dc;assert.equal(await err(d,'admin:start_question',undefined,'admin:error'),'Unauthorized');
 const bad=await conn(null);assert.equal(await err(bad,'display:connect',{displayCode:'NOPE1'},'display:error'),'Invalid display code');
 assert.equal(db.prepare('SELECT current_index c,status s FROM quizzes WHERE id=?').get(id).c,-1);
 const dq=once(d,'quiz:question_started');adm.s.emit('admin:start_question');const q=await dq;assert.ok(q.text);assert.equal(await err(d,'participant:submit_answer',{pos:1,sid:sid()}),'Not joined')});

test('teams: caps, leader-only finalize with idempotency, forged identifiers, one score per team',async()=>{
 const{code,id}=await mkQuiz({allowed_team_sizes:[2,3]},1),T=[];for(const n of ['Lead A','Mem A1','Mem A2','Mem A3','Lead B','Mem B1'])T.push(await reg(n));
 const adm=await ev(adminTok,'join_admin',{code}),L=await ev(T[0],'create_team',{code,team:'Alpha Squad'}),tc=db.prepare('SELECT team_code c FROM teams WHERE quiz_id=?').get(id).c;
 assert.equal(L.r.team.eligible,false);const A1=await ev(T[1],'join_team',{code,teamCode:tc.toLowerCase()}),A2=await ev(T[2],'join_team',{code,teamCode:tc});assert.equal(A2.r.team.eligible,true);
 assert.equal((await ev(T[3],'join_team',{code,teamCode:tc})).r.err,'Team is full');assert.equal((await ev(T[1],'join_team',{code,teamCode:'ZZZZZ'})).r.err,'Invalid team code');
 assert.equal((await ev(T[3],'join_team',{code,team:'Alpha Squad',teamId:1})).r.err,'Invalid join'); // team name / id is not a credential
 const B=await ev(T[4],'create_team',{code,team:'Beta'});assert.equal((await ev(T[0],'join_team',{code,teamCode:db.prepare("SELECT team_code c FROM teams WHERE team_name='Beta'").get().c})).r.err,'You are already in another team');
 const bm=await ev(T[5],'join_team',{code,teamCode:db.prepare("SELECT team_code c FROM teams WHERE team_name='Beta'").get().c});
 const {qs:[ql,qa,q2,qb]}=await start(adm.s,[L.s,A1.s,A2.s,B.s]);assert.deepEqual(ql.options,qa.options);assert.equal(ql.text,undefined);
 assert.equal(await err(A1.s,'team:finalize',{sid:sid()}),'Only the team leader can finalize');
 assert.equal(await err(bm.s,'team:finalize',{sid:sid()}),'Only the team leader can finalize'); // member of another team
 const sel=async(x,p)=>{const e=once(L.s,'team:answer_updated');x.s.emit('team:select_answer',{pos:p});return e};await sel(A1,pos(ql,'Wrong A'));await sel(L,pos(ql,'Right0'));
 const s1=sid(),rs=[L.s,A1.s,A2.s].map(x=>once(x,'participant:answer_result')),f1=await ack(L.s,'team:finalize',{sid:s1,teamId:99,score:999});(await Promise.all(rs)).forEach(r=>assert.equal(r.correct,undefined));
 assert.equal((await ack(L.s,'team:finalize',{sid:s1})).duplicate,true);assert.equal((await ack(L.s,'team:finalize',{sid:sid()})).error,'Already answered');assert.equal(await err(A1.s,'team:select_answer',{pos:1}),'Answer already finalized');
 assert.equal(await err(L.s,'participant:submit_answer',{pos:1,sid:sid()}),'Use your team controls');
 assert.equal(db.prepare('SELECT COUNT(*) c FROM responses r JOIN questions q ON q.id=r.question_id WHERE q.quiz_id=?').get(id).c,1);
 assert.equal(db.prepare('SELECT COUNT(*) c FROM teams WHERE quiz_id=?').get(id).c,2)});

test('images: validated by content, hidden from participants in big-screen-only, removed on delete',async()=>{
 const{code,id,dcode}=await mkQuiz({allowed_team_sizes:[1],display_mode:'big_only'},1),qid=db.prepare('SELECT id FROM questions WHERE quiz_id=?').get(id).id,post=(b,type,t=adminTok)=>api(`/questions/${qid}/image`,'POST',null,t,{body:b,type});
 assert.equal((await post(Buffer.from('MZ\x90\0 not an image'),'image/png')).status,422);assert.equal((await post(PNG,'image/jpeg')).status,422);assert.ok((await post(PNG,'text/html')).status>=400);
 assert.equal((await post(PNG,'image/png',await reg('Img User'))).status,403);const ok=await post(PNG,'image/png');assert.equal(ok.status,200);assert.match(ok.body.image_url,/^\/uploads\/questions\/[0-9a-f-]{36}\.png$/);
 const file=path.join(process.env.UPLOAD_DIR,'questions',path.basename(ok.body.image_url));assert.ok(fs.existsSync(file));const res=await fetch(base+ok.body.image_url);assert.equal(res.headers.get('x-content-type-options'),'nosniff');
 const a=await ev(adminTok,'join_admin',{code}),p=await ev(await reg('Img Player'),'join_player',{code}),d=await conn(null);d.emit('display:connect',{displayCode:dcode});await once(d,'state');
 const dq=once(d,'quiz:question_started'),pq=once(p.s,'quiz:question_started');a.s.emit('admin:start_question');assert.equal((await dq).image_url,ok.body.image_url);assert.equal(JSON.stringify(await pq).includes('uploads'),false);
 assert.equal((await api('/quizzes/'+id,'DELETE',{confirm:'WRONG'},adminTok)).status,422);assert.equal((await api('/quizzes/'+id,'DELETE',{confirm:code},adminTok)).status,200);assert.ok(!fs.existsSync(file),'image removed with quiz')});

test('restart resets progress; delete leaves no orphans',async()=>{
 const{code,id}=await mkQuiz({allowed_team_sizes:[1]},2),u=await reg('Rst User'),a=await ev(adminTok,'join_admin',{code}),p=await ev(u,'join_player',{code});
 const {qs:[q]}=await start(a.s,[p.s]);assert.equal((await ack(p.s,'participant:submit_answer',{pos:pos(q,'Right0'),sid:sid()})).ok,true);a.s.emit('admin:finish_question');await once(p.s,'quiz:question_finished');
 assert.equal((await api(`/quizzes/${id}/restart`,'POST',null,adminTok)).status,200);const z=db.prepare('SELECT * FROM quizzes WHERE id=?').get(id);assert.deepEqual([z.current_index,z.question_status,z.status],[-1,'ready','draft']);
 assert.equal(db.prepare('SELECT COUNT(*) c FROM responses r JOIN questions q ON q.id=r.question_id WHERE q.quiz_id=?').get(id).c,0);
 assert.equal(db.prepare('SELECT COUNT(*) c FROM participants WHERE quiz_id=?').get(id).c,1);const b2=(await ev(adminTok,'join_admin',{code})).r;assert.equal(b2.board[0].score,0);assert.equal(b2.qstatus,'ready');
 const {staff}=await start(a.s,[p.s]);assert.equal(staff.index,0);
 assert.equal((await api('/quizzes/'+id,'DELETE',{confirm:code},adminTok)).status,200);
 for(const sql of ['questions WHERE quiz_id','participants WHERE quiz_id','teams WHERE quiz_id'])assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${sql} NOT IN (SELECT id FROM quizzes)`).get().c,0,sql);
 for(const sql of ['options','shuffles','responses'])assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${sql} WHERE question_id NOT IN (SELECT id FROM questions)`).get().c,0,sql);
 assert.equal(db.prepare('SELECT COUNT(*) c FROM team_members WHERE team_id NOT IN (SELECT id FROM teams)').get().c,0);
 assert.equal(db.prepare('SELECT 1 FROM quizzes WHERE id=?').get(id),undefined)});

test('quiz management: reorder, edit, import, settings lock',async()=>{
 const{id}=await mkQuiz({allowed_team_sizes:[1,2]},3),g=async()=>(await api('/quizzes/'+id,'GET',null,adminTok)).body,ids=(await g()).questions.map(q=>q.id);
 assert.equal((await api(`/quizzes/${id}/reorder`,'POST',{ids:[...ids].reverse()},adminTok)).status,200);assert.deepEqual((await g()).questions.map(q=>q.id),[...ids].reverse());assert.equal((await api(`/quizzes/${id}/reorder`,'POST',{ids:[ids[0]]},adminTok)).status,422);
 assert.equal((await api('/questions/'+ids[0],'PUT',{question_text:'Edited?',options:['a','b'],correct:1,marks:7,category:'Cat'},adminTok)).status,200);assert.equal((await api('/questions/'+ids[0],'PUT',{question_text:'',options:['a'],correct:0},adminTok)).status,422);
 assert.equal((await api(`/quizzes/${id}/settings`,'PUT',{allowed_team_sizes:[2,3],display_mode:'full'},adminTok)).status,200);
 const demo=(await api('/quizzes','GET',null,adminTok)).body.find(q=>q.join_code==='DEMO01');assert.equal(demo.allowed_team_sizes,'1');assert.ok(demo.display_code);
 const code=(await g()).join_code,a=await ev(adminTok,'join_admin',{code});a.s.emit('admin:start_question');await once(a.s,'quiz:question_started');assert.equal((await api(`/quizzes/${id}/settings`,'PUT',{allowed_team_sizes:[1]},adminTok)).status,409)});

test('registration: no email needed, always USER, cannot register ADMIN',async()=>{
 const r=await api('/auth/register','POST',{username:'NoMail User',password:PW,confirm_password:PW,role:'ADMIN',isAdmin:true});assert.equal(r.status,201);assert.equal(r.body.user.role,'USER');
 assert.deepEqual(db.prepare("SELECT role,email FROM users WHERE username='NoMail User'").get(),{role:'USER',email:null});
 const l=await api('/auth/login','POST',{login:'nomail user',password:PW});assert.equal(l.status,200);assert.equal(l.body.user.role,'USER');assert.equal((await api('/quizzes','GET',null,l.body.token)).status,403);
 assert.equal((await api('/auth/register','POST',{username:'Admin',password:PW,confirm_password:PW})).status,409)});

test('display: own shuffle (positions only), stable per question, no answer key, reconnect',async()=>{
 let differs=false,first;
 for(let k=0;k<8;k++){const{code,dcode}=await mkQuiz({allowed_team_sizes:[1]},1),a=await ev(adminTok,'join_admin',{code}),d=await conn(null);d.emit('display:connect',{displayCode:dcode});await once(d,'state');
  const dq=once(d,'quiz:question_started');a.s.emit('admin:start_question');const q=await dq,qid=db.prepare('SELECT id FROM questions WHERE quiz_id=(SELECT id FROM quizzes WHERE join_code=?)').get(code).id;
  const canon=db.prepare('SELECT option_text t FROM options WHERE question_id=? ORDER BY id').all(qid).map(o=>o.t),shown=q.options.map(o=>o.text);
  assert.deepEqual([...shown].sort(),[...canon].sort());assert.deepEqual(q.options.map(o=>o.id),[1,2,3,4]);assert.ok(!/correct|is_correct|answerKey/i.test(JSON.stringify(q)));
  if(shown.join()!==canon.join())differs=true;if(k===0)first={code,dcode,shown}}
 assert.ok(differs,'display order is shuffled');
 const d2=await conn(null),st=once(d2,'state');d2.emit('display:connect',{displayCode:first.dcode});const s=await st;
 assert.deepEqual(s.question.options.map(o=>o.text),first.shown);assert.ok(!/correct|is_correct/i.test(JSON.stringify(s)))}); // reconnect: same order, no key

test('team privacy: no teammate or leader can see individual selections (socket, reconnect, REST)',async()=>{
 const{code,id}=await mkQuiz({allowed_team_sizes:[2,3]},1),T=[];for(const n of ['Priv L','Priv A','Priv B'])T.push(await reg(n));
 const adm=await ev(adminTok,'join_admin',{code}),L=await ev(T[0],'create_team',{code,team:'Privacy Crew'}),tc=db.prepare('SELECT team_code c FROM teams WHERE quiz_id=?').get(id).c;
 const A=await ev(T[1],'join_team',{code,teamCode:tc}),B=await ev(T[2],'join_team',{code,teamCode:tc}),seen={L:[],A:[],B:[]};
 [['L',L],['A',A],['B',B]].forEach(([k,x])=>x.s.onAny((e,p)=>seen[k].push([e,JSON.stringify(p)])));
 const {qs:[ql]}=await start(adm.s,[L.s,A.s,B.s]);
 const mine=once(A.s,'team:my_selection'),upd=once(L.s,'team:answer_updated');A.s.emit('team:select_answer',{pos:pos(ql,'Wrong A')});
 assert.equal((await mine).pos,pos(ql,'Wrong A'));const u=await upd;assert.ok(u.members.every(m=>Object.keys(m).sort().join()==='leader,name'));assert.equal(u.locked,1);
 assert.equal(await err(A.s,'team:select_answer',{pos:1}),'Selection already locked');
 for(const k of ['L','B'])assert.ok(!seen[k].some(([e,p])=>e==='team:my_selection'||/"sel"|"selected"|mySel/.test(p)),k+' received a teammate selection');
 const Lr=await ev(T[0],'join_player',{code}),Ar=await ev(T[1],'join_player',{code}),Br=await ev(T[2],'join_player',{code});
 assert.equal(Lr.r.mySel,null);assert.equal(Br.r.mySel,null);assert.equal(Ar.r.mySel,pos(ql,'Wrong A'));
 assert.ok(!/"sel"|selected/.test(JSON.stringify([Lr.r,Br.r])));assert.ok(Lr.r.team.members.every(m=>Object.keys(m).sort().join()==='leader,name'));
 for(const tk of T)assert.equal((await api(`/quizzes/${id}/responses`,'GET',null,tk)).status,403); // REST: participants cannot read responses
 assert.equal(await err(L.s,'team:finalize',{sid:sid()}),'Select an answer first');
 L.s.emit('team:select_answer',{pos:pos(ql,'Right0')});await once(L.s,'team:my_selection');
 const fin=once(B.s,'participant:answer_result');assert.equal((await ack(L.s,'team:finalize',{sid:sid()})).ok,true);assert.equal((await fin).correct,undefined);
 assert.equal(db.prepare('SELECT COUNT(*) c FROM responses r JOIN questions q ON q.id=r.question_id WHERE q.quiz_id=?').get(id).c,1); // only the final team answer is stored
 assert.equal(db.prepare('SELECT participant_id p FROM responses r JOIN questions q ON q.id=r.question_id WHERE q.quiz_id=?').get(id).p,null)});

test('themes: both defined, reduced motion, responsive/display CSS, no email field; server is theme-agnostic',()=>{
 const h=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8'),sv=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 for(const re of [/\[data-theme=tech\]/,/\[data-theme=spatial\]/,/prefers-reduced-motion:reduce/,/localStorage\.theme/,/\.big \.opts/,/@media\(min-width:700px\)/,/focus-visible/,/Incorrect/,/Correct/,/BRAND/,/\.ltr/,/\.pill/,/main\.auth/,/\.lb tr\.r1/])assert.match(h,re);
 assert.ok(!/type=email|placeholder=Email/i.test(h));assert.ok(!/button\.sec\{background:#/.test(h),'colours must come from theme tokens');assert.ok(!/theme/i.test(sv),'theme must never reach the server')});

test('admin credentials: environment-configured login works, old defaults are gone',async()=>{
 const A={username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD};assert.equal((await api('/auth/login','POST',{login:A.username,password:A.password})).status,200);
 assert.equal((await api('/auth/login','POST',{login:A.username.toUpperCase(),password:A.password})).status,200); // normalized username
 for(const c of [{login:'admin@quiz.com',password:'admin123'},{login:'admin',password:'admin123'},{login:A.username,password:'admin123'}])assert.equal((await api('/auth/login','POST',c)).status,401);
 assert.deepEqual(db.prepare('SELECT role,email FROM users WHERE username_normalized=?').get(A.username.toLowerCase()),{role:'ADMIN',email:null})});
