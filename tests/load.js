// Usage: ADMIN_USERNAME=... ADMIN_PASSWORD=... node tests/load.js [baseUrl] [players]
const {io}=require('socket.io-client'),A={username:process.env.ADMIN_USERNAME,password:process.env.ADMIN_PASSWORD},base=process.argv[2]||'http://localhost:3000',N=+process.argv[3]||60;
const once=(s,e)=>new Promise(r=>s.once(e,r)),post=async(p,b)=>(await fetch(base+'/api'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();
(async()=>{const run=Date.now().toString(36),{token}=await post('/auth/login',{login:A.username,password:A.password});
 const admin=io(base,{auth:{token}});await once(admin,'connect');admin.emit('join_admin',{code:'DEMO01'});await once(admin,'state');
 const players=await Promise.all(Array.from({length:N},async(_,i)=>{const u='Load '+run+' '+i;await post('/auth/register',{username:u,password:'Passw0rd!',confirm_password:'Passw0rd!'});
  const t=(await post('/auth/login',{login:u,password:'Passw0rd!'})).token,p=io(base,{auth:{token:t},forceNew:true});await once(p,'connect');p.emit('join_player',{code:'DEMO01'});await once(p,'state');return p}));
 console.log(N,'players joined');const pubs=players.map(p=>once(p,'quiz:question_started'));admin.emit('admin:start_question');const qs=await Promise.all(pubs);
 const t0=Date.now();let got=0;const done=new Promise(res=>admin.on('quiz:response_received',a=>{got=a.received;if(got>=N)res()}));
 players.forEach((p,i)=>setTimeout(()=>p.emit('participant:submit_answer',{pos:1+Math.floor(Math.random()*qs[i].options.length),sid:run+i}),Math.random()*2000));
 await Promise.race([done,new Promise(r=>setTimeout(r,15000))]);console.log(`${got}/${N} answers received in ${Date.now()-t0}ms`);process.exit(got>=N?0:1)})();
