import { chromium } from 'playwright';
const BASE='http://127.0.0.1:8141';
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium', args:['--no-proxy-server','--proxy-bypass-list=*']});
const page=await (await b.newContext({viewport:{width:1500,height:1050}})).newPage();
page.on('dialog',d=>d.accept());
await page.goto(BASE+'/login');
await page.fill('input[type=email]','test@pjllandservices.com');
await page.fill('input[type=password]','TestPassw0rd123');
await Promise.all([page.waitForNavigation().catch(()=>{}), page.click('button[type=submit]')]);
const projs = await page.evaluate(async()=>(await (await fetch('/api/projects')).json()).projects);
const proj = projs.filter(p=>p.name==='Master plan layer 2 walk').sort((a,b)=>a.id<b.id?1:-1)[0];
await page.goto(`${BASE}/admin/sitebuilder?project=${proj.id}`);
await page.waitForFunction(()=>typeof appReady!=='undefined'&&appReady===true,{timeout:20000});
await page.waitForTimeout(500);
const pid = await page.evaluate(()=>sitePlan.pages[0].id);
await page.evaluate(id=>openMasterPlan(id), pid);
await page.waitForTimeout(300);
console.log(JSON.stringify(await page.evaluate(()=>{
  const r=routingFor(mp.pageId);
  r.poc={x:-40,y:-70}; r.main=[{x:-40,y:20},{x:20,y:20},{x:220,y:40}];
  r.manifolds=[{x:20,y:30},{x:220,y:40}]; mp.laterals=true; mpDraw();
  return {
    zones: LAST_ZONES.map((z,i)=>({i, name:z.name, gpm:+z.gpm.toFixed(2), colour:mpZoneColour(i), parts:z.parts})),
    areas: areas.map((a,i)=>({i, name:a.name, family:a.family, zi:zoneIndexOf(i,0), colour:mpZoneColour(zoneIndexOf(i,0))})),
    runs: mpLateralPlan().runs.map(run=>({zi:run.zi, name:(LAST_ZONES[run.zi]||{}).name, colour:mpZoneColour(run.zi), ft:+run.ft.toFixed(1), nodes:run.nodes})),
    assign: mpManifoldAssign().byManifold
  };
}), null, 1));
await b.close();
