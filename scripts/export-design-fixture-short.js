/* PJL — the paste-into-chat short form of scripts/export-design-fixture.js.
   Same allowlist, same two guards (refuses on anything that looks personal,
   refuses on an empty ceiling or spacing factor), less reporting. Short
   enough to copy out of a message rather than opening a file.

   With the project open in the System Builder: F12 -> Console -> paste ->
   Enter. Downloads pjl-design-fixture.json. Saves and changes nothing.

   If an area name trips the check, type  PJL_R=1  then paste again.

   The field list below IS the rule. If the long version's AREA_KEYS ever
   changes, change it here too — or delete this file and go back to the
   long one, rather than letting the two drift.                          */
(()=>{const s=serializeState(),
K="aid name mode L W sqft avgW family head rotorNoz mpNoz sprayBody spraySeries stripNoz stripBody dripProduct overagePct dripRowIn dripDir valveGroup shapeKind layout poly arc circle manualHeads trees planRef".split(" "),
p=(o,k)=>Object.fromEntries(k.filter(x=>o&&o[x]!==undefined).map(x=>[x,o[x]])),
R=window.PJL_R===1,
d={version:s.version,inputs:p(s.inputs,["availGPM","psi","supply","ceiling","spacingFactor"]),
waterSupply:s.waterSupply,bomOverrides:s.bomOverrides,valveGroupModes:s.valveGroupModes,
areas:s.areas.map((a,i)=>{const o=p(a,K);if(R)o.name="Area "+(i+1);return o}),routing:s.routing},
t=JSON.stringify(d,null,2);
if(/[\w.%+-]+@[\w.-]+\.\w{2,}|\d{3}[-. ]\d{3}[-. ]\d{4}|\b[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d\b|\b[QI]-\d{4}-\d{4}\b/.test(t))
return console.error("STOPPED, nothing downloaded - an area name looks personal. Type  PJL_R=1  then paste this again.");
if(!d.inputs.ceiling||!d.inputs.spacingFactor)
return console.error("STOPPED - the GPM ceiling or spacing factor box is empty. Fill it in and paste again.");
const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([t],{type:"application/json"}));
a.download="pjl-design-fixture.json";a.click();
console.log("OK - downloaded pjl-design-fixture.json:",d.areas.length,"areas, ceiling",d.inputs.ceiling,", spacing",d.inputs.spacingFactor);})()
